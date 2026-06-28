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

// ── Orders ───────────────────────────────────────────────────────

async function sbGetOrders(pharmacyId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('orders').select('*').eq('pharmacy_id', pharmacyId).order('created_at', { ascending: false });
  return data || [];
}

async function sbInsertOrder(order){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('orders').insert(order);
  return { error: error?.message || null };
}

async function sbUpdateOrderStatus(orderId, status, extra = {}){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { error } = await sb.from('orders').update({ status, ...extra, updated_at: new Date().toISOString() }).eq('id', orderId);
  return { error: error?.message || null };
}

/** Real-time order subscription for pharmacy dashboard */
function sbSubscribeOrders(pharmacyId, callback){
  const sb = getSB(); if(!sb) return null;
  return sb.channel('orders_'+pharmacyId)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'orders',
      filter: `pharmacy_id=eq.${pharmacyId}`
    }, payload => callback(payload))
    .subscribe();
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
/** Crée un PaymentIntent Stripe via la Supabase Edge Function `create-payment-intent` */
async function sbCreatePaymentIntent(amountCents, metadata={}){
  const sb=getSB(); if(!sb) return {error:'supabase_not_configured'};
  try{
    const {data,error}=await sb.functions.invoke('create-payment-intent',{
      body:{amount:amountCents,currency:'eur',metadata}
    });
    if(error) return {error:error.message};
    return {clientSecret:data?.clientSecret||null,error:null};
  }catch(e){return {error:e.message||'invoke_failed'};}
}

// ── Web Push ─────────────────────────────────────────────────────

/** Abonne l'utilisateur aux notifications push et sauvegarde dans Supabase */
async function sbSubscribePush(userId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { error: 'push_not_supported' };
  const vapidKey = window.LIVR_CONFIG?.vapid_public_key;
  if (!vapidKey) return { error: 'vapid_key_missing' };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { error: 'permission_denied' };

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey)
    });

    const json = sub.toJSON();
    const sb = getSB(); if (!sb) return { error: 'supabase_not_configured' };
    const { error } = await sb.from('push_subscriptions').upsert({
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }, { onConflict: 'user_id,endpoint' });

    return { error: error?.message || null };
  } catch (e) {
    return { error: e.message };
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Export (accessible globally) ────────────────────────────────
window.LS_SB = { SB_READY, getSB, sbSignIn, sbSignUp, sbSignOut, sbGetSession, sbGetProfile,
  sbResetPassword, sbUpdatePassword,
  sbGetPharmacy, sbUpsertPharmacy, sbGetOrders, sbInsertOrder, sbUpdateOrderStatus,
  sbSubscribeOrders, sbGetDriver, sbUpsertDriver, sbGetSettlements,
  sbGetClub, sbUpsertClub, sbGetClubMembers, sbGetClubHealthPros, sbValidateHealthPro,
  sbGetHealthPro, sbUpsertHealthPro, sbGetProsForMember,
  sbGetAppointments, sbInsertAppointment, sbUpdateAppointment,
  sbCreatePaymentIntent, sbSubscribePush };
