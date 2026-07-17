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
const { verifyAccessToken } = require('./auth');

let wss = null;
// Map<topic, Set<ws>>
const subscriptions = new Map();

function attach(server) {
  wss = new WebSocketServer({ server, path: '/realtime' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let user = null;
    if (token) {
      try { user = verifyAccessToken(token); } catch (_) { /* connexion anonyme refusée aux topics protégés */ }
    }
    ws.user = user;
    ws.topics = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.action === 'subscribe' && typeof msg.topic === 'string') {
        // Autorisation basique : un patient ne peut s'abonner qu'à ses propres commandes,
        // une pharmacie qu'à orders:pharmacy:<sa propre pharmacyId> (vérifié côté route au moment
        // de la récupération de pharmacyId — ici on vérifie juste la cohérence userId pour le topic patient).
        if (msg.topic.startsWith('orders:patient:') && (!ws.user || msg.topic !== `orders:patient:${ws.user.sub}`)) {
          return; // refuse silencieusement
        }
        if (!subscriptions.has(msg.topic)) subscriptions.set(msg.topic, new Set());
        subscriptions.get(msg.topic).add(ws);
        ws.topics.add(msg.topic);
      } else if (msg.action === 'unsubscribe' && typeof msg.topic === 'string') {
        subscriptions.get(msg.topic)?.delete(ws);
        ws.topics.delete(msg.topic);
      }
    });

    ws.on('close', () => {
      for (const topic of ws.topics) {
        subscriptions.get(topic)?.delete(ws);
      }
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
