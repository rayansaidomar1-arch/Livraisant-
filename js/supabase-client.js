/* ═══════════════════════════════════════════════════════════════════
   Livraisanté — Supabase client adapter
   Replace localStorage auth + data with Supabase.
   Falls back gracefully to localStorage for offline/demo mode.
═══════════════════════════════════════════════════════════════════ */

// ── Configuration ────────────────────────────────────────────────
// Valeurs lues depuis js/config.js (window.LIVR_CONFIG)
// Pour la migration Clever Cloud : mettre à jour config.js uniquement
// Lire exclusivement depuis config.js — ne jamais dupliquer les clés ici
const SUPABASE_URL  = window.LIVR_CONFIG?.supabase_url;
const SUPABASE_ANON = window.LIVR_CONFIG?.supabase_anon;

// ── Init ─────────────────────────────────────────────────────────
let _sb = null;
function getSB(){
  if(_sb) return _sb;
  if(typeof window.supabase === 'undefined') return null; // SDK not loaded
  if(SUPABASE_URL.includes('YOUR_PROJECT')) return null;   // Not configured yet
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth:{
      autoRefreshToken: true,
      persistSession: true,    // JWT stored in localStorage (base64, NOT encrypted — ne pas stocker de secrets dans le JWT)
      detectSessionInUrl: true  // nécessaire pour les liens de réinitialisation de mot de passe
    }
  });
  return _sb;
}

const SB_READY = !!getSB();

// ── Auth ─────────────────────────────────────────────────────────

/** Sign in with email + password. Returns { user, profile, error } */
async function sbSignIn(email, password){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error) return { error: error.message };
  const { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
  return { user: data.user, profile, error: null };
}

/** Register a new user. Returns { user, error } */
async function sbSignUp(email, password, meta = {}){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: meta }  // prenom, nom, role passed as user_metadata
  });
  if(error) return { error: error.message };
  return { user: data.user, error: null };
}

/** Sign out current user */
async function sbSignOut(){
  const sb = getSB(); if(!sb) return;
  await sb.auth.signOut();
}

/** Get current session. Returns { session, user } or null */
async function sbGetSession(){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

/** Get current user profile from DB */
async function sbGetProfile(userId){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
  return data;
}

// ── Pharmacy ─────────────────────────────────────────────────────

async function sbGetPharmacy(userId){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.from('pharmacies').select('*').eq('user_id', userId).single();
  return data;
}

async function sbUpsertPharmacy(userId, pharmacyData){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('pharmacies').upsert({ user_id: userId, ...pharmacyData });
  return { error: error?.message || null };
}

// Table Supabase `pharmacies` (colonnes snake_case) <-> objet JS
// `livraisante_pharmacy` utilisé partout dans index.html (camelCase :
// priorityMode, priorityLabs, planName, signupTs, ...). Comme pour les
// commandes, ces deux fonctions sont le seul point de traduction — les
// réglages sans colonne dédiée (busyPattern, googleHours, googlePlaceId,
// customAdvice, promoCode, pricing) sont rangés dans la colonne fourre-tout
// `extra_settings` (jsonb) pour éviter de multiplier les migrations. `pricing`
// (mode éco/standard/premium + overrides par catégorie) est lu par l'Edge
// Function `create-payment-intent` pour calculer le montant réellement
// facturé (correctif audit 2026-08-05, Important #4 — ce réglage était
// auparavant purement cosmétique, stocké seulement en localStorage).
function pharmacyRowToJs(row){
  if(!row) return null;
  const extra = row.extra_settings || {};
  return {
    id: row.id,
    userId: row.user_id,
    nom: row.nom,
    adresse: row.adresse,
    ville: row.ville,
    cp: row.cp,
    tel: row.tel,
    email: row.email,
    finess: row.finess,
    rpps: row.rpps,
    ordreNum: row.ordre_num,
    siret: row.siret,
    rcs: row.rcs,
    iban: row.iban,
    plan: row.plan,
    period: row.period,
    planName: row.plan_name,
    priorityMode: row.priority_mode,
    priorityLabs: row.priority_labs || [],
    active_labs: row.active_labs || [], // conservé en snake_case : lu tel quel à la restauration de session
    catalogMode: row.catalog_mode,
    activeSubstances: row.active_substances || [],
    signupTs: row.signup_ts ? new Date(row.signup_ts).getTime() : null,
    lat: row.lat,
    lon: row.lon,
    horaires: row.horaires,
    busyPattern: extra.busyPattern || null,
    googleHours: extra.googleHours || null,
    googlePlaceId: extra.googlePlaceId || null,
    customAdvice: extra.customAdvice || [],
    promoCode: extra.promoCode || null,
    pricing: extra.pricing || { mode:'std', overrides:{} },
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null
  };
}

function pharmacyJsToRow(ph){
  return {
    nom: ph.nom ?? null,
    adresse: ph.adresse ?? null,
    ville: ph.ville ?? null,
    cp: ph.cp ?? null,
    tel: ph.tel ?? null,
    email: ph.email ?? null,
    finess: ph.finess ?? null,
    rpps: ph.rpps ?? null,
    ordre_num: ph.ordreNum ?? null,
    siret: ph.siret ?? null,
    rcs: ph.rcs ?? null,
    iban: ph.iban ?? null,
    priority_mode: ph.priorityMode ?? null,
    priority_labs: ph.priorityLabs || [],
    active_labs: ph.active_labs || [],
    catalog_mode: ph.catalogMode ?? null,
    active_substances: ph.activeSubstances || [],
    lat: ph.lat ?? null,
    lon: ph.lon ?? null,
    horaires: ph.horaires ?? null,
    extra_settings: {
      busyPattern: ph.busyPattern || null,
      googleHours: ph.googleHours || null,
      googlePlaceId: ph.googlePlaceId || null,
      customAdvice: ph.customAdvice || [],
      promoCode: ph.promoCode || null,
      pricing: ph.pricing || { mode:'std', overrides:{} }
    }
    // NB : plan / period / plan_name volontairement exclus du payload —
    // verrouillés côté DB (trigger lock_pharmacy_plan_fields, migration
    // 20260721000001) pour tout appelant qui n'est pas service_role.
  };
}

// ── Orders ───────────────────────────────────────────────────────
// Table Supabase `orders` (colonnes snake_case) <-> objet JS utilisé par
// index.html (ORDERS[id] = {id,code,createdAt,kind,patient:{...},items,
// status,driver,totalEur,codeValidated,substitution,arrival}). Ces deux
// fonctions sont le seul point de traduction entre les deux formats —
// index.html ne doit jamais construire une ligne `orders` à la main.

function orderRowToJs(row){
  if(!row) return null;
  return {
    id: row.id,
    code: row.code,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    kind: row.kind,
    deliveryMode: row.delivery_mode,
    patientId: row.patient_id,
    pharmacyId: row.pharmacy_id,
    patient: {
      name: row.patient_name,
      addr: row.patient_address,
      pos: row.patient_pos || null,
      donation: row.payment?.donation || null,
      email: row.payment?.email || ''
    },
    items: row.items || [],
    status: row.status,
    driver: !!row.driver_id,
    driverId: row.driver_id || null,
    totalEur: (row.pricing && row.pricing.totalEur != null) ? row.pricing.totalEur : null,
    deliveryFeeEur: (row.pricing && row.pricing.deliveryFeeEur != null) ? row.pricing.deliveryFeeEur : null,
    pricing: row.pricing || null,
    codeValidated: !!row.code_validated,
    substitution: row.substitution || null,
    arrival: row.arrival || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null
  };
}

function orderJsToInsertRow(o){
  return {
    id: o.id,
    patient_id: o.patientId,
    pharmacy_id: o.pharmacyId,
    status: o.status || 'nouvelle',
    items: o.items || [],
    delivery_mode: o.deliveryMode || 'livraison',
    patient_name: o.patient?.name || null,
    patient_address: o.patient?.addr || null,
    patient_pos: o.patient?.pos || null,
    code: o.code || null,
    kind: o.kind || 'santé',
    // NB : `orders` n'a pas de colonnes `total_price`/`delivery_fee` dédiées — tout
    // passe par ce JSONB `pricing` (voir migration du 2026-07-22 documentant le bug
    // inverse : du code lisait des colonnes plates inexistantes et cassait les requêtes).
    pricing: { totalEur: (o.totalEur != null ? o.totalEur : null), deliveryFeeEur: (o.deliveryFeeEur != null ? o.deliveryFeeEur : null) },
    payment: { email: o.patient?.email || '', donation: o.patient?.donation || null }
  };
}

/** Liste des pharmacies partenaires visibles publiquement (vue pharmacies_public) */
async function sbGetPublicPharmacies(){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('pharmacies_public').select('*').order('nom', { ascending: true });
  return data || [];
}

/** Crée une commande — retourne { order (format JS), error } */
async function sbInsertOrderFull(orderJs){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const row = orderJsToInsertRow(orderJs);
  const { data, error } = await sb.from('orders').insert(row).select().single();
  if(error) return { error: error.message };
  return { order: orderRowToJs(data), error: null };
}

/** Commandes d'un patient (suivi "mes commandes") */
async function sbGetPatientOrders(patientId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('orders').select('*').eq('patient_id', patientId).order('created_at', { ascending: false });
  return (data || []).map(orderRowToJs);
}

/** Commandes d'une pharmacie (dashboard pharmacien) */
async function sbGetOrdersForPharmacy(pharmacyId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('orders').select('*').eq('pharmacy_id', pharmacyId).order('created_at', { ascending: false });
  return (data || []).map(orderRowToJs);
}

/** Commandes disponibles pour un livreur — vue à colonnes limitées
 *  (id, pharmacy_id, status, created_at) tant que la commande n'est pas
 *  prise en charge : la RLS `orders` interdit à un livreur de lire le détail
 *  santé (médicaments, adresse patient) avant claim. */
async function sbGetAvailableOrdersForDriver(){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('orders_driver_available').select('*').order('created_at', { ascending: false });
  return data || [];
}

/** Commandes déjà prises en charge par ce livreur */
async function sbGetMyDriverOrders(driverId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('orders').select('*').eq('driver_id', driverId).order('created_at', { ascending: false });
  return (data || []).map(orderRowToJs);
}

/** Prise en charge atomique d'une commande disponible par un livreur.
 *  Un seul UPDATE fixe driver_id ET status ensemble (exigé par la policy
 *  RLS `orders_driver_claim` : WITH CHECK driver_id=auth.uid()). Si un autre
 *  livreur a déjà pris la commande entre-temps, driver_id IS NULL ne matche
 *  plus rien et .single() renvoie une erreur "no rows". */
async function sbClaimOrder(orderId, driverId){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.from('orders')
    .update({ driver_id: driverId, status: 'en_livraison' })
    .eq('id', orderId)
    .is('driver_id', null)
    .in('status', ['validee','prete'])
    .select().single();
  if(error) return { error: error.message };
  return { order: orderRowToJs(data), error: null };
}

/** Met à jour des colonnes arbitraires d'une commande (statut, code_validated,
 *  substitution, arrival...). `patch` utilise déjà les noms de colonnes DB. */
async function sbUpdateOrderFields(orderId, patch){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.from('orders').update(patch).eq('id', orderId).select().single();
  if(error) return { error: error.message };
  return { order: orderRowToJs(data), error: null };
}

/** Legacy — conservé pour compat (non utilisé par index.html à ce jour) */
async function sbGetOrders(pharmacyId){ return sbGetOrdersForPharmacy(pharmacyId); }
async function sbInsertOrder(order){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('orders').insert(order);
  return { error: error?.message || null };
}
async function sbUpdateOrderStatus(orderId, status, extra = {}){
  return sbUpdateOrderFields(orderId, { status, ...extra });
}

/** Real-time — écoute générique par colonne (pharmacy_id / patient_id / driver_id) */
function sbSubscribeOrdersByColumn(column, value, callback){
  const sb = getSB(); if(!sb) return null;
  return sb.channel('orders_'+column+'_'+value)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'orders',
      filter: `${column}=eq.${value}`
    }, payload => callback(payload))
    .subscribe();
}

/** Real-time order subscription for pharmacy dashboard (legacy alias) */
function sbSubscribeOrders(pharmacyId, callback){
  return sbSubscribeOrdersByColumn('pharmacy_id', pharmacyId, callback);
}

function sbUnsubscribeChannel(channel){
  const sb = getSB(); if(!sb || !channel) return;
  sb.removeChannel(channel);
}

// ── Driver ───────────────────────────────────────────────────────

async function sbGetDriver(userId){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.from('drivers').select('*').eq('user_id', userId).single();
  return data;
}

async function sbUpsertDriver(userId, driverData){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('drivers').upsert({ user_id: userId, ...driverData });
  return { error: error?.message || null };
}

// ── Settlements ──────────────────────────────────────────────────

async function sbGetSettlements(pharmacyId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('settlements').select('*').eq('pharmacy_id', pharmacyId).order('settled_at', { ascending: false });
  return data || [];
}

// ── Événements d'usage (stats serveur : consultations / abandons) ────────
// Best-effort : ne doit jamais bloquer le parcours utilisateur si Supabase
// est indisponible ou si l'insertion échoue (voir table app_events, migration
// 20260722000000_blocking_and_important_fixes.sql).
async function sbLogEvent(userId, kind, payload){
  const sb = getSB(); if(!sb) return;
  try{ await sb.from('app_events').insert({ user_id: userId || null, kind, payload: payload || {} }); }catch(e){}
}

// ── Codes promo (validation/consommation atomique côté serveur) ──────────
// Passe par la fonction SECURITY DEFINER redeem_promo_code() plutôt que par
// une lecture directe de la table : évite d'exposer la liste complète des
// codes (et leurs compteurs d'utilisation) à n'importe quel compte connecté.
async function sbRedeemPromoCode(code, role){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.rpc('redeem_promo_code', { p_code: code, p_role: role });
  if(error) return { error: error.message };
  return data; // { promo:{...} } ou { error:'...' }
}

// ── Clubs ────────────────────────────────────────────────────────
async function sbGetClub(userId){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.from('clubs').select('*').eq('user_id', userId).single();
  return data;
}
async function sbUpsertClub(userId, clubData){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('clubs').upsert({ user_id: userId, ...clubData });
  return { error: error?.message || null };
}
async function sbGetClubMembers(clubId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('club_members').select('*, profiles(prenom,nom,email)').eq('club_id', clubId);
  return data || [];
}
async function sbGetClubHealthPros(clubId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('health_professionals').select('*, profiles(prenom,nom,email)').eq('club_id', clubId);
  return data || [];
}
async function sbValidateHealthPro(proId, validated){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('health_professionals').update({ validated_by_club: validated, rejected: !validated }).eq('id', proId);
  return { error: error?.message || null };
}

// ── Health Professionals ─────────────────────────────────────────
async function sbGetHealthPro(userId){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.from('health_professionals').select('*, clubs(nom,ville)').eq('user_id', userId).single();
  return data;
}
async function sbUpsertHealthPro(userId, proData){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('health_professionals').upsert({ user_id: userId, ...proData });
  return { error: error?.message || null };
}
async function sbGetProsForMember(clubId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('health_professionals').select('*, profiles(prenom,nom)').eq('club_id', clubId).eq('validated_by_club', true);
  return data || [];
}

// ── Appointments ─────────────────────────────────────────────────
async function sbGetAppointments(userId, role){
  const sb = getSB(); if(!sb) return [];
  if(role === 'professionnel_sante'){
    const pro = await sbGetHealthPro(userId);
    if(!pro) return [];
    const { data } = await sb.from('appointments').select('*, profiles(prenom,nom,health_profile)').eq('pro_id', pro.id).order('scheduled_at');
    return data || [];
  }
  const { data } = await sb.from('appointments').select('*, health_professionals(profession, profiles(prenom,nom))').eq('patient_id', userId).order('scheduled_at');
  return data || [];
}
async function sbInsertAppointment(appt){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('appointments').insert(appt);
  return { error: error?.message || null };
}
async function sbUpdateAppointment(apptId, updates){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('appointments').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', apptId);
  return { error: error?.message || null };
}
// Créneaux ouverts (proposés par un pro, pas encore réclamés par un patient)
async function sbGetOpenSlotsForClub(clubId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('appointments').select('*').eq('club_id', clubId).is('patient_id', null).eq('status', 'pending').order('scheduled_at');
  return data || [];
}
async function sbClaimAppointmentSlot(apptId, patientId){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.from('appointments')
    .update({ patient_id: patientId, updated_at: new Date().toISOString() })
    .eq('id', apptId).is('patient_id', null)
    .select();
  if(error) return { error: error.message };
  if(!data || !data.length) return { error: 'slot_already_taken' };
  return { error: null };
}

// ── Google OAuth ─────────────────────────────────────────────────────

/** Sign in with Google OAuth — redirects browser to Google, then back to /connexion */
async function sbSignInWithGoogle() {
  const sb = getSB(); if (!sb) return { error: 'supabase_not_configured' };
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/connexion' }
  });
  if (error) return { error: error.message };
  return { data, error: null };
}

// ── Password Reset ───────────────────────────────────────────────────

/** Envoie un email de réinitialisation de mot de passe */
async function sbResetPassword(email) {
  const sb = getSB(); if (!sb) return { error: 'supabase_not_configured' };
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: 'https://www.livraisante.fr/connexion'  // route dédiée, réduit la fenêtre d'exposition du token
  });
  return { error: error?.message || null };
}

/** Met à jour le mot de passe (appelé après récupération via lien email) */
async function sbUpdatePassword(newPassword) {
  const sb = getSB(); if (!sb) return { error: 'supabase_not_configured' };
  const { error } = await sb.auth.updateUser({ password: newPassword });
  return { error: error?.message || null };
}

// ── Stripe PaymentIntent ─────────────────────────────────────────────
/**
 * Crée un PaymentIntent Stripe via la Supabase Edge Function `create-payment-intent`.
 *
 * NB (2026-07-22) : ne prend plus un montant en paramètre. L'Edge Function
 * recalcule désormais le montant exact côté serveur à partir du panier
 * (items) et du catalogue produit en base (`products`) — le montant n'est
 * plus jamais fourni par le client (voir migration
 * 20260722020000_products_catalog_and_payment_integrity.sql). Retourne le
 * montant réellement facturé (`amountEur`) pour affichage/enregistrement.
 *
 * @param {{items:{lab:string,name:string}[], deliveryMode:string, distanceKm:number|null, donationEnabled:boolean}} cart
 * @param {object} metadata
 */
async function sbCreatePaymentIntent(cart, metadata={}){
  const sb=getSB(); if(!sb) return {error:'supabase_not_configured'};
  try{
    const {data,error}=await sb.functions.invoke('create-payment-intent',{
      body:{
        items:cart?.items||[],
        deliveryMode:cart?.deliveryMode||'livraison',
        distanceKm:(typeof cart?.distanceKm==='number')?cart.distanceKm:null,
        donationEnabled:!!cart?.donationEnabled,
        currency:'eur',
        metadata,
        pharmacyId:cart?.pharmacyId||null,
      }
    });
    if(error) return {error:error.message};
    if(!data?.clientSecret) return {error:data?.error||'unknown_error'};
    return {clientSecret:data.clientSecret,paymentIntentId:data.paymentIntentId||null,amountEur:data.amountEur,deliveryFeeEur:data.deliveryFeeEur,error:null};
  }catch(e){return {error:e.message||'invoke_failed'};}
}

/** Confirme une commande PAYANTE (santé / click-collect / cnc-club) après un paiement
 *  Stripe réussi côté client. N'envoie JAMAIS de montant : seul `paymentIntentId` est
 *  transmis. La Edge Function `confirm-order` relit le montant réel auprès de Stripe
 *  (avec la clé secrète, côté serveur), vérifie que ce paiement appartient bien à
 *  l'utilisateur connecté et n'a pas déjà servi pour une autre commande, puis insère
 *  la commande avec service_role (cf. migration 20260722030000_order_pricing_integrity_and_perf.sql
 *  qui interdit désormais un insert direct côté patient avec un `pricing.totalEur` non nul). */
async function sbConfirmOrder(payload){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  try{
    const { data, error } = await sb.functions.invoke('confirm-order', { body: payload });
    if(error) return { error: error.message || 'confirm_order_failed' };
    if(!data?.order) return { error: data?.error || 'confirm_order_failed' };
    return { order: orderRowToJs(data.order), error: null };
  }catch(e){
    return { error: e?.message || 'confirm_order_failed' };
  }
}

// ── Web Push ─────────────────────────────────────────────────────

/** Borne une étape dans le temps. Sans cela, certaines promesses de l'API push
 *  ne se règlent JAMAIS — ni succès ni rejet — et l'utilisateur reste devant un
 *  écran muet (constaté le 2026-08-28 : le toast « Demande de permission… »
 *  restait seul, sans suite). Les coupables typiques :
 *   - `navigator.serviceWorker.ready` quand aucun worker n'arrive à s'activer ;
 *   - `pushManager.subscribe()` quand le service de push du navigateur (FCM,
 *     Mozilla autopush, APNs) est injoignable — réseau filtré, VPN, pare-feu.
 *  On ne borne PAS `Notification.requestPermission()` : elle attend légitimement
 *  une action humaine, qui peut prendre le temps qu'elle veut.
 */
function pushStep(promise, ms, step) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout_' + step)), ms); })
  ]);
}

/** Abonne l'utilisateur aux notifications push et sauvegarde dans Supabase.
 *
 *  Deux pièges, tous deux constatés en production le 2026-08-28 (la table
 *  `push_subscriptions` était restée vide alors que l'interface annonçait
 *  « notifications activées ») :
 *
 *  1. `pushManager.subscribe()` ÉCHOUE si le navigateur détient déjà un
 *     abonnement créé avec une AUTRE clé applicative — ce qui est le cas de
 *     tout appareil abonné avant la régénération VAPID du 2026-08-24. Le
 *     service worker n'accepte qu'une seule clé serveur à la fois. Il faut donc
 *     relire l'abonnement existant, comparer sa clé à la nôtre, et le résilier
 *     s'il est dépareillé.
 *  2. L'`upsert` peut être refusé silencieusement par la RLS `push_own`
 *     (`user_id = auth.uid()`) quand la session Supabase a expiré : le client
 *     n'émet alors aucune erreur exploitable, mais rien n'est écrit. On relit
 *     donc la ligne pour EXIGER la preuve qu'elle existe, plutôt que de
 *     déduire le succès de l'absence d'erreur.
 */
async function sbSubscribePush(userId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { error: 'push_not_supported' };
  const vapidKey = window.LIVR_CONFIG?.vapid_public_key;
  if (!vapidKey) return { error: 'vapid_key_missing' };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { error: 'permission_denied' };

    const sb = getSB(); if (!sb) return { error: 'supabase_not_configured' };
    // Sans session valide, la policy `push_own` rejettera l'insertion : autant
    // le dire maintenant, avec un message actionnable.
    const { data: sess } = await pushStep(sb.auth.getSession(), 10000, 'session');
    if (!sess?.session) return { error: 'session_expired' };

    const reg = await pushStep(navigator.serviceWorker.ready, 10000, 'sw');
    const wanted = urlBase64ToUint8Array(vapidKey);

    // ── 1. Purger un abonnement dépareillé ──
    const existing = await pushStep(reg.pushManager.getSubscription(), 10000, 'lecture');
    if (existing) {
      const current = existing.options?.applicationServerKey;
      if (!current || !sameBytes(new Uint8Array(current), wanted)) {
        await pushStep(existing.unsubscribe(), 10000, 'resiliation');
      }
    }

    const doSubscribe = () => pushStep(reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wanted
    }), 25000, 'abonnement');

    let sub;
    try {
      sub = await doSubscribe();
    } catch (e) {
      // Un dépassement de délai n'est pas un conflit de clé : ne pas résilier
      // un abonnement valide sur cette base, et remonter la cause telle quelle.
      if (String(e.message).startsWith('timeout_')) throw e;
      // Filet de sécurité : certains navigateurs n'exposent pas
      // `options.applicationServerKey`, la comparaison ci-dessus est alors
      // impossible et c'est `subscribe()` qui refuse. On résilie et on retente.
      const stale = await pushStep(reg.pushManager.getSubscription(), 10000, 'lecture');
      if (!stale) throw e;
      await pushStep(stale.unsubscribe(), 10000, 'resiliation');
      sub = await doSubscribe();
    }

    const json = sub.toJSON();
    const { error } = await pushStep(sb.from('push_subscriptions').upsert({
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }, { onConflict: 'user_id,endpoint' }), 15000, 'enregistrement');
    if (error) return { error: error.message };

    // ── 2. Vérifier que la ligne est réellement en base ──
    const { data: check, error: checkErr } = await pushStep(sb
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .eq('endpoint', json.endpoint)
      .maybeSingle(), 15000, 'relecture');
    if (checkErr) return { error: checkErr.message };
    if (!check) return { error: 'subscription_not_persisted' };

    return { endpoint: json.endpoint, error: null };
  } catch (e) {
    // Les échecs de l'API push sont des DOMException dont le `message` est
    // souvent vide ou générique ; c'est le `name` qui porte l'information
    // (NotAllowedError, AbortError, NotSupportedError…). Le perdre revient à
    // afficher une erreur vide — on préfixe donc systématiquement.
    return { error: e.name && e.name !== 'Error' ? e.name + (e.message ? ' : ' + e.message : '') : e.message };
  }
}

/** Vrai état du push : un abonnement navigateur ET la ligne correspondante en
 *  base. La permission de notification ne prouve rien — elle autorise aussi les
 *  notifications purement locales (`new Notification(...)`), qui ne passent par
 *  aucun serveur. */
async function sbPushStatus(userId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { active: false, reason: 'push_not_supported' };
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { active: false, reason: 'permission_' + (typeof Notification === 'undefined' ? 'denied' : Notification.permission) };
  }
  try {
    // Bornées elles aussi : sinon le bloc « ⏳ Vérification… » du panneau de
    // notifications resterait affiché indéfiniment.
    const reg = await pushStep(navigator.serviceWorker.ready, 10000, 'sw');
    const sub = await pushStep(reg.pushManager.getSubscription(), 10000, 'lecture');
    if (!sub) return { active: false, reason: 'no_browser_subscription' };

    // Clé dépareillée = le serveur ne pourra pas chiffrer pour cet abonnement.
    const vapidKey = window.LIVR_CONFIG?.vapid_public_key;
    const current = sub.options?.applicationServerKey;
    if (vapidKey && current && !sameBytes(new Uint8Array(current), urlBase64ToUint8Array(vapidKey))) {
      return { active: false, reason: 'stale_vapid_key' };
    }

    const sb = getSB(); if (!sb) return { active: false, reason: 'supabase_not_configured' };
    const { data, error } = await sb
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .eq('endpoint', sub.endpoint)
      .maybeSingle();
    if (error) return { active: false, reason: 'db_error' };
    return data ? { active: true, reason: null } : { active: false, reason: 'not_in_database' };
  } catch (e) {
    return { active: false, reason: e.message };
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Vérification d'inscription (code réel envoyé par email, cf. Edge Function
//    `signup-verification` — correctif audit 2026-08-05 Critique #3) ───────

/** Demande l'envoi d'un code de vérification à 6 chiffres par email. */
async function sbSendSignupVerification(email){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  try{
    const { data, error } = await sb.functions.invoke('signup-verification', { body:{ action:'send', email } });
    if(error) return { error: error.message || 'send_failed' };
    if(!data?.sent) return { error: data?.error || 'send_failed' };
    return { sent:true, error:null };
  }catch(e){
    return { error: e?.message || 'send_failed' };
  }
}

/** Vérifie le code à 6 chiffres saisi par l'utilisateur (comparaison serveur, hashée). */
async function sbVerifySignupCode(email, code){
  const sb = getSB(); if(!sb) return { ok:false, error:'supabase_not_configured' };
  try{
    const { data, error } = await sb.functions.invoke('signup-verification', { body:{ action:'verify', email, code } });
    if(error) return { ok:false, error: error.message || 'verify_failed' };
    if(!data?.ok) return { ok:false, error: data?.error || 'Code incorrect.' };
    return { ok:true, error:null };
  }catch(e){
    return { ok:false, error: e?.message || 'verify_failed' };
  }
}

// ── Vérification RPPS (côté serveur, cf. Edge Function `verify-rpps` —
//    correctif audit 2026-08-05 Important #6) ───────────────────────────

/** Vérifie un numéro RPPS auprès de l'Annuaire Santé national (côté serveur, pas de CORS).
 *  Sans session active : simple consultation. Avec session active : écrit aussi
 *  rpps_verified/rpps_status côté serveur (jamais confié au client). */
async function sbVerifyRpps(rpps, role){
  const sb = getSB(); if(!sb) return { verified:false, error:'supabase_not_configured' };
  try{
    const { data, error } = await sb.functions.invoke('verify-rpps', { body:{ rpps, role } });
    if(error) return { verified:false, error: error.message || 'verify_failed' };
    return data || { verified:false, error:'verify_failed' };
  }catch(e){
    return { verified:false, error: e?.message || 'verify_failed' };
  }
}

// ── Parrainage livreur / cagnotte club / messagerie admin (correctif
//    audit 2026-08-05, Important #7) ─────────────────────────────────────
// Avant ce correctif, ces trois fonctionnalités vivaient exclusivement en
// localStorage (jamais synchronisées entre appareils, jamais vues par le
// vrai destinataire). Voir migration 20260805210000_referrals_cagnotte_admin_messages.sql.

/** Enregistre le code de parrainage saisi par un livreur à son inscription
 *  (déclaratif — ne débloque aucun crédit automatique, juste la traçabilité
 *  réelle du lien parrain/filleul). */
async function sbSetDriverReferredBy(code){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data:{ user } } = await sb.auth.getUser();
  if(!user) return { error:'not_authenticated' };
  const { error } = await sb.from('drivers').update({ referred_by_code: code }).eq('user_id', user.id);
  return { error: error?.message || null };
}

/** Nombre réel de filleuls inscrits / actifs via mon propre code parrain
 *  (RPC SECURITY DEFINER — un livreur ne peut jamais lire le détail des
 *  fiches d'un autre livreur, seulement ce compteur agrégé). */
async function sbGetMyDriverReferralStats(){
  const sb = getSB(); if(!sb) return { totalReferred:0, totalActive:0 };
  const { data, error } = await sb.rpc('my_driver_referral_stats');
  if(error || !data?.[0]) return { totalReferred:0, totalActive:0 };
  return { totalReferred: data[0].total_referred||0, totalActive: data[0].total_active||0 };
}

/** Solde + historique réels de la cagnotte d'un club (créditée côté serveur
 *  par l'Edge Function confirm-order — jamais par le client). */
async function sbGetClubCagnotte(clubId){
  const sb = getSB(); if(!sb) return { balance:0, count:0, entries:[], lastVersement:null };
  const { data:entries } = await sb.from('club_cagnotte_entries')
    .select('*').eq('club_id', clubId).eq('versed', false).order('created_at', { ascending:false });
  const { data:versements } = await sb.from('club_cagnotte_versements')
    .select('*').eq('club_id', clubId).order('created_at', { ascending:false }).limit(1);
  const rows = entries || [];
  const balance = Math.round(rows.reduce((s,e)=>s+parseFloat(e.amount_eur||0),0)*100)/100;
  return { balance, count: rows.length, entries: rows, lastVersement: versements?.[0]||null };
}

/** Verse (marque réglée) le solde courant de la cagnotte d'un club — réservé
 *  admin côté serveur (RPC SECURITY DEFINER, vérifie is_admin() en interne). */
async function sbVerseCagnotte(clubId){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.rpc('verse_club_cagnotte', { p_club_id: clubId });
  if(error) return { error: error.message };
  const row = data?.[0]||{ versed_amount:0, entries_count:0 };
  return { error:null, amount: parseFloat(row.versed_amount)||0, count: row.entries_count||0 };
}

/** Envoie un message admin réel (persisté en base, lisible par les vrais
 *  destinataires ciblés — voir policies RLS admin_messages). Pour la cible
 *  'specific', résout l'email saisi en user_id via `profiles` (lecture
 *  admin déjà autorisée par la policy profiles_admin_read). */
async function sbSendAdminMessage(targetScope, targetEmail, body){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data:{ user } } = await sb.auth.getUser();
  if(!user) return { error:'not_authenticated' };
  let targetUserId=null;
  if(targetScope==='specific'){
    if(!targetEmail) return { error:'email_requis' };
    const { data:profile } = await sb.from('profiles').select('id').eq('email', targetEmail).maybeSingle();
    if(!profile?.id) return { error:'Aucun compte trouvé pour cet email.' };
    targetUserId=profile.id;
  }
  const { error } = await sb.from('admin_messages').insert({
    sender_id: user.id, target_scope: targetScope, target_user_id: targetUserId, body
  });
  return { error: error?.message || null };
}

/** Historique des messages envoyés par l'admin (toutes cibles confondues). */
async function sbGetSentAdminMessages(){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('admin_messages').select('*').order('created_at', { ascending:false }).limit(200);
  return data || [];
}

/** Messages réellement reçus par l'utilisateur connecté (ciblage direct ou
 *  diffusion à son rôle réel — voir policy admin_messages_recipient_read). */
async function sbGetMyAdminMessages(){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('admin_messages').select('*').order('created_at', { ascending:false }).limit(50);
  return data || [];
}

/* ── Double authentification (MFA TOTP) — 2026-08-12 ──────────────────
   L'authentification est entièrement gérée par Supabase Auth : le backend
   Clever Cloud ne fait que *vérifier* les JWT émis par Supabase (JWKS) et
   exigera le niveau `aal2` sur les routes de données de santé. La 2FA se
   pilote donc ici, via l'API MFA native de Supabase.

   Choix produit (validés) : TOTP (application authentificator, pas de coût
   par message et pas de risque de SIM-swap), activation *optionnelle* depuis
   le profil patient — mais une fois activée, elle devient obligatoire pour
   accéder au dossier santé.

   Prérequis manuel : MFA/TOTP doit être activé dans le Dashboard Supabase
   (Authentication → Multi-Factor Authentication). Voir docs/2FA-SETUP.md.
─────────────────────────────────────────────────────────────────────── */

/** Facteurs MFA de l'utilisateur. Retourne { totp:[], all:[], verified:bool, error }.
 *  `totp` ne contient que les facteurs vérifiés ; `all` inclut les enrôlements
 *  inachevés (statut `unverified`), nécessaires au nettoyage avant réenrôlement. */
async function sbMfaListFactors(){
  const sb = getSB(); if(!sb) return { totp:[], all:[], verified:false, error:'supabase_not_configured' };
  const { data, error } = await sb.auth.mfa.listFactors();
  if(error) return { totp:[], all:[], verified:false, error: error.message };
  const totp = data?.totp || [];
  return { totp, all: data?.all || totp, verified: totp.some(f => f.status === 'verified'), error:null };
}

/** Démarre l'enrôlement TOTP. Retourne { factorId, qrCode, secret, uri, error }.
 *  Le facteur reste en statut `unverified` tant qu'un premier code n'a pas été
 *  validé. Un enrôlement abandonné (onglet fermé) laisse donc un facteur
 *  fantôme qui, lui, compte dans la limite MAX_ENROLLED_FACTORS de GoTrue et
 *  bloquerait définitivement toute activation ultérieure : on purge ces
 *  facteurs inachevés avant d'en créer un nouveau. Le nom inclut l'horodatage
 *  complet car GoTrue refuse deux facteurs de même friendlyName. */
async function sbMfaEnroll(){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { all } = await sbMfaListFactors();
  for(const f of (all || [])){
    if(f.status !== 'verified'){
      await sb.auth.mfa.unenroll({ factorId: f.id }).catch(()=>{});
    }
  }
  const { data, error } = await sb.auth.mfa.enroll({
    factorType:'totp',
    friendlyName:`Livraisanté ${new Date().toISOString()}`
  });
  if(error) return { error: error.message };
  return { factorId:data.id, qrCode:data.totp?.qr_code, secret:data.totp?.secret, uri:data.totp?.uri, error:null };
}

/** Vérifie un code TOTP à 6 chiffres pour un facteur donné.
 *  Sert à la fois à finaliser l'enrôlement et à l'élévation `aal1`→`aal2`
 *  à la connexion : dans les deux cas Supabase exige un challenge puis un verify.
 *  En cas de succès la session courante est réémise avec le claim aal2. */
async function sbMfaVerify(factorId, code){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  if(!/^\d{6}$/.test(String(code||'').trim())) return { error:'code_invalide' };
  const { data: ch, error: chErr } = await sb.auth.mfa.challenge({ factorId });
  if(chErr) return { error: chErr.message };
  const { error } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code: String(code).trim() });
  if(error) return { error: error.message };
  return { error:null };
}

/** Désactive la 2FA (suppression du facteur). */
async function sbMfaUnenroll(factorId){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.auth.mfa.unenroll({ factorId });
  if(error) return { error: error.message };
  return { error:null };
}

/** Niveau d'assurance de la session. Retourne { current, next, needsStepUp }.
 *  `needsStepUp` est vrai quand l'utilisateur a une 2FA active mais ne l'a pas
 *  encore présentée sur cette session (aal1 alors que aal2 est atteignable). */
async function sbMfaGetAal(){
  const sb = getSB(); if(!sb) return { current:null, next:null, needsStepUp:false };
  const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if(error) return { current:null, next:null, needsStepUp:false };
  return {
    current: data.currentLevel,
    next: data.nextLevel,
    needsStepUp: data.currentLevel === 'aal1' && data.nextLevel === 'aal2'
  };
}

// ── Export (accessible globally) ────────────────────────────────
window.LS_SB = { SB_READY, getSB, sbSignIn, sbSignUp, sbSignOut, sbGetSession, sbGetProfile,
  sbSignInWithGoogle,
  sbResetPassword, sbUpdatePassword,
  sbGetPharmacy, sbUpsertPharmacy, sbGetOrders, sbInsertOrder, sbUpdateOrderStatus,
  sbSubscribeOrders, sbGetDriver, sbUpsertDriver, sbGetSettlements,
  sbGetClub, sbUpsertClub, sbGetClubMembers, sbGetClubHealthPros, sbValidateHealthPro,
  sbGetHealthPro, sbUpsertHealthPro, sbGetProsForMember,
  sbGetAppointments, sbInsertAppointment, sbUpdateAppointment,
  sbGetOpenSlotsForClub, sbClaimAppointmentSlot,
  sbCreatePaymentIntent, sbSubscribePush, sbPushStatus,
  // Commandes (branchement réel 2026-07-18)
  sbGetPublicPharmacies, sbInsertOrderFull, sbConfirmOrder, sbGetPatientOrders, sbGetOrdersForPharmacy,
  sbGetAvailableOrdersForDriver, sbGetMyDriverOrders, sbClaimOrder, sbUpdateOrderFields,
  sbSubscribeOrdersByColumn, sbUnsubscribeChannel, orderRowToJs,
  // Réglages pharmacie / profil livreur / règlements (branchement réel 2026-07-21)
  pharmacyRowToJs, pharmacyJsToRow,
  // Événements d'usage / codes promo (branchement réel 2026-07-22)
  sbLogEvent, sbRedeemPromoCode,
  // Vérification d'inscription réelle par email (branchement réel 2026-08-05)
  sbSendSignupVerification, sbVerifySignupCode,
  // Vérification RPPS réelle côté serveur (branchement réel 2026-08-05)
  sbVerifyRpps,
  // Parrainage livreur / cagnotte club / messagerie admin (branchement réel 2026-08-05)
  sbSetDriverReferredBy, sbGetMyDriverReferralStats,
  sbGetClubCagnotte, sbVerseCagnotte,
  sbSendAdminMessage, sbGetSentAdminMessages, sbGetMyAdminMessages,
  // Double authentification TOTP (2026-08-12)
  sbMfaListFactors, sbMfaEnroll, sbMfaVerify, sbMfaUnenroll, sbMfaGetAal };
