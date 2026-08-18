// Supabase Edge Function — verify-rpps
// Deploy: supabase functions deploy verify-rpps
// Required env vars:
//   SUPABASE_URL        — auto-injecté par Supabase
//   SUPABASE_ANON_KEY    — auto-injecté par Supabase (ou fourni manuellement)
//   SERVICE_ROLE_KEY    — nécessaire pour écrire rpps_verified/rpps_status (RLS fermée)
//
// ── Correctif audit 2026-08-05 (Important #6) ────────────────────────────────
// L'ancienne vérification RPPS (checkRPPSPharma()/verifyRPPS() dans index.html)
// appelait les API de l'Annuaire Santé national DIRECTEMENT DEPUIS LE NAVIGATEUR
// — ce qui échoue quasi systématiquement en pratique (CORS / clé d'accès
// manquante sur gateway.api.esante.gouv.fr). En cas d'échec, le code retombait
// sur un "autoApproved:true" ne vérifiant plus que le FORMAT du numéro (11
// chiffres, préfixe 10) et posait `dataset.rppsStatus='verified'` — un simple
// attribut DOM, également modifiable directement depuis les DevTools. Pire :
// le statut "vérifié" était ensuite écrit tel quel par le CLIENT via
// `sb.from('profiles').update({rpps_verified:...})`, un appel authentifié que
// n'importe quel utilisateur connecté pouvait rejouer à la main avec
// `rpps_verified:true` sans même passer par le formulaire.
//
// Cette fonction fait la vraie vérification côté serveur (pas de CORS) et,
// lorsqu'elle est appelée avec un jeton d'authentification (après l'inscription,
// cf. completeRegistration() dans index.html), écrit elle-même le résultat via
// service_role — jamais confié au client. Les triggers
// prevent_rpps_self_verification / prevent_pro_rpps_self_verification
// (migration 20260805000001) empêchent en plus toute écriture directe de
// rpps_verified/rpps_status hors service_role, y compris par un appel REST
// manuel qui contournerait entièrement le formulaire.
//
// POST { rpps, role: 'pharmacien'|'professionnel_sante' }
//   - Sans Authorization : simple consultation (retour immédiat, aucune écriture) —
//     utilisé par le bouton "Vérifier" AVANT la création du compte.
//   - Avec Authorization : en plus de la vérification, écrit rpps/rpps_verified/
//     rpps_status sur la ligne du user authentifié (profiles ou health_professionals).
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://www.livraisante.fr',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RPPS_RE = /^\d{11}$/;

async function lookupRpps(rpps: string): Promise<{ found: boolean; nom?: string; prenom?: string; profession?: string }> {
  try {
    const url = `https://gateway.api.esante.gouv.fr/fhir/v1/Practitioner?identifier=http%3A%2F%2Fesante.gouv.fr%2Fnos%2Frpps%7C${rpps}&_format=json`;
    const res = await fetch(url, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (data.total > 0) {
        const entry = data.entry?.[0]?.resource;
        return {
          found: true,
          nom: (entry?.name?.[0]?.family || '').toUpperCase(),
          prenom: entry?.name?.[0]?.given?.[0] || '',
          profession: entry?.qualification?.[0]?.code?.coding?.[0]?.display || '',
        };
      }
      return { found: false };
    }
  } catch (_e) { /* essai annuaire public ci-dessous */ }
  try {
    const res2 = await fetch(`https://annuaire.sante.fr/api/ps?rpps=${rpps}`, { signal: AbortSignal.timeout(6000) });
    if (res2.ok) {
      const data2 = await res2.json();
      const entry2 = data2?.[0] || data2?.results?.[0] || null;
      if (entry2) {
        return {
          found: true,
          nom: (entry2.nom || entry2.lastName || '').toUpperCase(),
          prenom: entry2.prenom || entry2.firstName || '',
          profession: entry2.profession || entry2.specialite || '',
        };
      }
    }
  } catch (_e2) { /* indisponible — traité comme non trouvé, jamais auto-approuvé */ }
  return { found: false };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

  try {
    const { rpps, role } = await req.json();
    const rppsStr = String(rpps || '').trim();

    if (!RPPS_RE.test(rppsStr)) {
      return new Response(JSON.stringify({ verified: false, error: 'Le numéro RPPS doit contenir exactement 11 chiffres.' }), { status: 400, headers: corsHeaders });
    }
    if (!['pharmacien', 'professionnel_sante'].includes(role)) {
      return new Response(JSON.stringify({ verified: false, error: 'Rôle invalide' }), { status: 400, headers: corsHeaders });
    }
    if (role === 'pharmacien' && !rppsStr.startsWith('10')) {
      return new Response(JSON.stringify({ verified: false, error: "Le RPPS d'un pharmacien titulaire commence par 10." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Rate-limiting par IP — cette fonction est appelable sans authentification
    // (consultation avant inscription) et relaie des appels vers des API
    // externes ; on borne l'abus. Fail-open en cas de souci infra (protection
    // en profondeur, pas la barrière principale).
    try {
      const { data: allowed, error: rlErr } = await admin.rpc('check_rate_limit', {
        p_bucket: `verify-rpps:${ip}`, p_max_hits: 20, p_window_seconds: 3600,
      });
      if (!rlErr && allowed === false) {
        return new Response(JSON.stringify({ verified: false, error: 'Trop de tentatives, réessayez plus tard.' }), { status: 429, headers: corsHeaders });
      }
    } catch (_e) { /* fail-open volontaire */ }

    const result = await lookupRpps(rppsStr);
    const status = result.found ? 'verified' : 'pending';

    // Appel authentifié (après création du compte) : on écrit le résultat
    // côté serveur avec service_role — jamais confié à ce que le client
    // prétend avoir obtenu. Sans jeton (avant inscription), on ne fait que
    // consulter : aucune ligne n'existe encore à mettre à jour.
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const anonClient = createClient(supabaseUrl, anonKey);
      const { data: { user } } = await anonClient.auth.getUser(authHeader.replace('Bearer ', ''));
      if (user) {
        if (role === 'pharmacien') {
          await admin.from('profiles').update({ rpps: rppsStr, rpps_verified: result.found, rpps_status: status }).eq('id', user.id);
        } else {
          await admin.from('health_professionals').update({ rpps_verified: result.found, rpps_status: status }).eq('user_id', user.id);
        }
      }
    }

    return new Response(JSON.stringify({
      verified: result.found,
      nom: result.nom || '',
      prenom: result.prenom || '',
      profession: result.profession || '',
      msg: result.found
        ? `✓ Vérifié dans l'Annuaire Santé national${(result.prenom || result.nom) ? ' : ' + [result.prenom, result.nom].filter(Boolean).join(' ') : ''}`
        : "RPPS non trouvé dans l'Annuaire Santé national — votre compte sera examiné manuellement par notre équipe avant activation complète.",
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ verified: false, error: err.message }), { status: 500, headers: corsHeaders });
  }
});
