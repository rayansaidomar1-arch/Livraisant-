// Envoi d'emails transactionnels via Resend — remplace supabase/functions/send-email
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

// Instanciation paresseuse : le SDK Resend lève une exception dès le
// constructeur si la clé est absente, ce qui ferait planter tout le
// process au démarrage (require de ce module) si RESEND_API_KEY n'est pas
// encore configurée côté Clever Cloud. On ne construit le client qu'au
// premier envoi réel.
let resend = null;
function getClient() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY absente des variables d\'environnement');
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Cache des templates HTML chargés depuis /templates
const templateCache = new Map();

function loadTemplate(key) {
  if (templateCache.has(key)) return templateCache.get(key);
  const filePath = path.join(__dirname, '..', '..', 'templates', `${key}.html`);
  const html = fs.readFileSync(filePath, 'utf8');
  templateCache.set(key, html);
  return html;
}

function renderTemplate(key, vars = {}) {
  let html = loadTemplate(key);
  for (const [k, v] of Object.entries(vars)) {
    html = html.split(`{{${k}}}`).join(String(v));
  }
  return html;
}

/**
 * @param {{to:string, subject:string, templateKey?:string, vars?:object, html?:string}} opts
 */
async function sendEmail({ to, subject, templateKey, vars = {}, html }) {
  const body = html || renderTemplate(templateKey, vars);
  const from = process.env.EMAIL_FROM || 'Livraisanté <administratif@livraisante.fr>';
  const { data, error } = await getClient().emails.send({ from, to, subject, html: body });
  if (error) throw new Error(typeof error === 'string' ? error : error.message || 'Échec envoi email');
  return data;
}

module.exports = { sendEmail, renderTemplate };
