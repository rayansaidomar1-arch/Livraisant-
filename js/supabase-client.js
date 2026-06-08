/* ═══════════════════════════════════════════════════════════════════
   Livraisanté — Supabase client adapter
═══════════════════════════════════════════════════════════════════ */

const SUPABASE_URL  = 'https://gsmrgafclxkuqzzhtapi.supabase.co';
const SUPABASE_ANON = 'sb_publishable_lkkWiVC0Zs59wv7WBqGiuQ_XKIarkBc';

let _sb = null;
function getSB(){
  if(_sb) return _sb;
  if(typeof window.supabase === 'undefined') return null;
  if(SUPABASE_URL.includes('YOUR_PROJECT')) return null;
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth:{ autoRefreshToken:true, persistSession:true, detectSessionInUrl:true }
  });
  return _sb;
}

const SB_READY = !!getSB();

async function sbSignIn(email, password){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error) return { error: error.message };
  const { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
  return { user: data.user, profile, error: null };
}

async function sbSignUp(email, password, meta = {}){
  const sb = getSB(); if(!sb) return { error:'supabase_not_configured' };
  const { data, error } = await sb.auth.signUp({ email, password, options:{ data: meta } });
  if(error) return { error: error.message };
  return { user: data.user, error: null };
}

async function sbSignOut(){
  const sb = getSB(); if(!sb) return;
  await sb.auth.signOut();
}

async function sbGetSession(){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

async function sbGetProfile(userId){
  const sb = getSB(); if(!sb) return null;
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
  return data;
}

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

function sbSubscribeOrders(pharmacyId, callback){
  const sb = getSB(); if(!sb) return null;
  return sb.channel('orders_'+pharmacyId)
    .on('postgres_changes', { event:'*', schema:'public', table:'orders', filter:`pharmacy_id=eq.${pharmacyId}` }, payload => callback(payload))
    .subscribe();
}

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

async function sbGetSettlements(pharmacyId){
  const sb = getSB(); if(!sb) return [];
  const { data } = await sb.from('settlements').select('*').eq('pharmacy_id', pharmacyId).order('settled_at', { ascending: false });
  return data || [];
}

window.LS_SB = { SB_READY, getSB, sbSignIn, sbSignUp, sbSignOut, sbGetSession, sbGetProfile,
  sbGetPharmacy, sbUpsertPharmacy, sbGetOrders, sbInsertOrder, sbUpdateOrderStatus,
  sbSubscribeOrders, sbGetDriver, sbUpsertDriver, sbGetSettlements };
