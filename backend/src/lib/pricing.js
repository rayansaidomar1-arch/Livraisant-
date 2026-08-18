// ═══════════════════════════════════════════════════════════════════════
// Tarification — SEULE source de vérité serveur pour le montant d'une
// commande. Aucun prix, aucun total, aucun frais de livraison n'est jamais
// accepté depuis le client : il ne transmet que *ce qu'il commande*
// (couple lab + name, quantité, mode de livraison, distance), le montant
// est recalculé ici.
//
// Le catalogue `products` vit sur Supabase (migration
// 20260722020000_products_catalog_and_payment_integrity.sql) et sert déjà
// de référence à l'Edge Function create-payment-intent. On le relit par la
// connexion Postgres directe plutôt que d'en dupliquer une copie ici :
// deux catalogues divergeraient au premier changement de prix.
//
// Les barèmes ci-dessous reflètent MARGE_PCT / DELIVERY_TIERS /
// FRAIS_LIVRAISON d'index.html. Ils sont affichés au patient avant
// paiement — les garder alignés est une exigence d'information tarifaire,
// pas un simple détail d'implémentation.
// ═══════════════════════════════════════════════════════════════════════
const { pool } = require('./supabaseDb');

const MARGE_PCT = 0.1;
const FRAIS_LIVRAISON_DEFAUT = 3.9; // distance inconnue
const DELIVERY_TIERS = [
  { maxKm: 2, price: 3.0 },
  { maxKm: 4, price: 4.5 },
  { maxKm: 20, price: 6.9 },
  { maxKm: Infinity, price: 9.9 },
];
const DELIVERY_MODES = ['livraison', 'cnc', 'cnc_club'];
const MAX_QTY_PAR_LIGNE = 20;
const MAX_LIGNES = 50;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function deliveryFeeFor(mode, distanceKm) {
  if (mode === 'cnc' || mode === 'cnc_club') return 0; // retrait sur place
  if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0) {
    return FRAIS_LIVRAISON_DEFAUT;
  }
  return DELIVERY_TIERS.find((t) => distanceKm <= t.maxKm).price;
}

/**
 * Recalcule le montant d'un panier depuis le catalogue serveur.
 *
 * Un article introuvable au catalogue est une erreur, pas une ligne à 0 € :
 * l'ignorer silencieusement redonnerait au client le moyen de faire passer
 * des articles gratuits (c'est exactement la faille qu'on ferme ici).
 *
 * @returns {{itemsTotal:number, deliveryFee:number, total:number, lines:Array}}
 * @throws  {Error} `code` = 'panier_vide' | 'article_inconnu' | 'mode_invalide'
 */
async function priceCart({ items, deliveryMode = 'livraison', distanceKm = null }) {
  if (!DELIVERY_MODES.includes(deliveryMode)) {
    throw Object.assign(new Error('Mode de livraison invalide'), { code: 'mode_invalide' });
  }
  const list = Array.isArray(items) ? items : [];
  if (!list.length || list.length > MAX_LIGNES) {
    throw Object.assign(new Error('Panier vide ou trop volumineux'), { code: 'panier_vide' });
  }

  const keys = list.map((it) => ({
    lab: String(it?.lab || ''),
    name: String(it?.name || it?.nom || ''),
    qty: Math.min(MAX_QTY_PAR_LIGNE, Math.max(1, Math.trunc(Number(it?.qty) || 1))),
  }));

  const { rows } = await pool.query(
    'SELECT lab, name, prix FROM products WHERE active = true AND (lab, name) IN (SELECT * FROM unnest($1::text[], $2::text[]))',
    [keys.map((k) => k.lab), keys.map((k) => k.name)]
  );
  const catalogue = new Map(rows.map((r) => [`${r.lab}|${r.name}`, Number(r.prix)]));

  const lines = keys.map((k) => {
    const prix = catalogue.get(`${k.lab}|${k.name}`);
    if (prix === undefined) {
      throw Object.assign(new Error(`Article indisponible : ${k.lab} ${k.name}`), { code: 'article_inconnu' });
    }
    return { ...k, prixUnitaire: prix, ligne: round2(prix * k.qty) };
  });

  const base = lines.reduce((s, l) => s + l.ligne, 0);
  const itemsTotal = round2(base * (1 + MARGE_PCT));
  const deliveryFee = deliveryFeeFor(deliveryMode, distanceKm);

  return { itemsTotal, deliveryFee, total: round2(itemsTotal + deliveryFee), lines };
}

module.exports = { priceCart, deliveryFeeFor, DELIVERY_MODES, MARGE_PCT };
