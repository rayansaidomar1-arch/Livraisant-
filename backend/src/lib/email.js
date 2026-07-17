// Envoi d'emails transactionnels via Resend — remplace supabase/functions/send-email
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const resend = new Resend(process.env.RESEND_API_KEY);

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
  const from = process.env.EMAIL_FROM || 'Livraisanté <contact@livraisante.fr>';
  const { data, error } = await resend.emails.send({ from, to, subject, html: body });
  if (error) throw new Error(typeof error === 'string' ? error : error.message || 'Échec envoi email');
  return data;
}

module.exports = { sendEmail, renderTemplate };
