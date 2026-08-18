// Temps réel WebSocket — remplace supabase.channel(...).on('postgres_changes', ...)
// utilisé par sbSubscribeOrders (dashboard pharmacie / suivi patient en direct).
//
// Protocole minimal :
//   Client → serveur (au moment de la connexion, via query string) : ?token=<JWT>
//   Client → serveur : { "action": "subscribe", "topic": "orders:pharmacy:<id>" }
//   Serveur → client : { "topic": "orders:pharmacy:<id>", "event": "update", "payload": {...} }
//
// Topics utilisés par le frontend :
//   orders:patient:<userId>    — un patient suit ses propres commandes
//   orders:pharmacy:<pharmacyId> — une pharmacie suit les commandes qui lui sont adressées
//   orders:driver               — tous les livreurs actifs suivent les commandes disponibles

const { WebSocketServer } = require('ws');
const { verifyToken } = require('./auth'); // vérification JWT Supabase (JWKS) — async
const { isActiveDriver } = require('./supabaseDb');
const prisma = require('./prisma');

let wss = null;
// Map<topic, Set<ws>>
const subscriptions = new Map();

/**
 * Autorisation par topic (correctif audit sécurité 2026-07-21) — jusqu'ici
 * seul le topic `orders:patient:<id>` était vérifié ; `orders:pharmacy:<id>`
 * et `orders:driver` étaient accessibles à N'IMPORTE QUI (même sans token),
 * exposant en clair les commandes (adresses, médicaments) de n'importe
 * quelle pharmacie et le flux des commandes disponibles pour les livreurs.
 * Chaque abonnement est désormais vérifié contre le rôle applicatif
 * (jamais celui du JWT — mêmes garanties que attachProfile/requireRole).
 */
async function isAuthorizedForTopic(ws, topic) {
  if (topic.startsWith('orders:patient:')) {
    return !!ws.user && topic === `orders:patient:${ws.user.sub}`;
  }
  if (topic.startsWith('orders:pharmacy:')) {
    if (!ws.user) return false;
    const pharmacyId = topic.slice('orders:pharmacy:'.length);
    try {
      const pharmacy = await prisma.pharmacy.findUnique({ where: { userId: ws.user.sub } });
      return !!pharmacy && pharmacy.id === pharmacyId;
    } catch (_) {
      return false;
    }
  }
  if (topic === 'orders:driver') {
    if (!ws.user) return false;
    try { return await isActiveDriver(ws.user.sub); } catch (_) { return false; }
  }
  // Topic inconnu : refusé par défaut (deny-by-default).
  return false;
}

function unsubscribe(ws, topic) {
  const set = subscriptions.get(topic);
  if (!set) return;
  set.delete(ws);
  // Sans cette suppression, `subscriptions` conserve une entrée par topic
  // rencontré depuis le démarrage — soit une clé par patient et par pharmacie,
  // jamais libérée.
  if (!set.size) subscriptions.delete(topic);
}

// Un client mobile qui perd le réseau ne ferme pas proprement sa socket : sans
// ping périodique, le serveur garde la connexion (et son abonnement) pour
// toujours et lui diffuse dans le vide.
const HEARTBEAT_MS = 30000;

function attach(server) {
  wss = new WebSocketServer({ server, path: '/realtime' });

  // `ws` émet 'error' sur la socket (ECONNRESET…). Un 'error' sans écouteur
  // sur un EventEmitter est relancé en exception non capturée : une simple
  // coupure réseau client suffisait à tuer le process.
  wss.on('error', (err) => console.error('WebSocketServer error:', err.message));

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* socket déjà morte */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => console.error('WebSocket client error:', err.message));

    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let user = null;
    if (token) {
      try { user = await verifyToken(token); } catch (_) { /* connexion anonyme refusée aux topics protégés */ }
    }
    ws.user = user;
    ws.topics = new Set();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.action === 'subscribe' && typeof msg.topic === 'string') {
        const allowed = await isAuthorizedForTopic(ws, msg.topic);
        if (!allowed) return; // refuse silencieusement (pas d'oracle d'existence)
        if (!subscriptions.has(msg.topic)) subscriptions.set(msg.topic, new Set());
        subscriptions.get(msg.topic).add(ws);
        ws.topics.add(msg.topic);
      } else if (msg.action === 'unsubscribe' && typeof msg.topic === 'string') {
        unsubscribe(ws, msg.topic);
        ws.topics.delete(msg.topic);
      }
    });

    ws.on('close', () => {
      for (const topic of ws.topics) unsubscribe(ws, topic);
      ws.topics.clear();
    });
  });

  return wss;
}

/**
 * Diffuse un événement à tous les clients abonnés à un topic donné.
 * Appelé depuis les routes REST après une mutation (ex. après update du statut d'une commande).
 */
function broadcast(topic, event, payload) {
  const clients = subscriptions.get(topic);
  if (!clients) return;
  const message = JSON.stringify({ topic, event, payload });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

module.exports = { attach, broadcast };
