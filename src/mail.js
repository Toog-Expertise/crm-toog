'use strict';
// Envoi des mails par Resend, modèles à la charte, statuts reçus par webhook.
// Sans clé Resend (installation locale), les mails sont « simulés » : notés dans l'historique et affichés dans le terminal.
const crypto = require('node:crypto');
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const { config } = require('./env');
const { escapeHtml, fill, safeEqual } = require('./util');

const STATUS_LABEL = {
  queued: 'en file', sent: 'envoyé', delivered: 'délivré', opened: 'ouvert', clicked: 'cliqué',
  bounced: 'rejeté', complained: 'signalé comme spam', failed: 'échec', simulated: 'simulé (Resend non branché)', delayed: 'retardé',
};

function baseVars() {
  const c = settings.get('company');
  return { entreprise: c.name, telephone: c.phone, site: c.website };
}

function render(key, vars) {
  const tpl = settings.mailTemplate(key);
  if (!tpl) throw new Error(`Modèle de mail inconnu : ${key}`);
  const v = { ...baseVars(), ...vars };
  const subject = fill(tpl.subject, v);
  const text = fill(tpl.body, v);
  return { subject, text, html: layout(text) };
}

// Mise en page : fond clair (lisible dans toutes les messageries), logo, couleur principale.
function layout(text) {
  const colors = settings.get('colors');
  const company = settings.get('company');
  const logo = settings.get('logo') ? `<img src="${escapeHtml(config.appUrl)}/logo" alt="${escapeHtml(company.name)}" style="max-height:56px;max-width:180px;margin-bottom:16px">` : `<div style="font-weight:700;font-size:18px;color:${colors.primary};margin-bottom:16px">${escapeHtml(company.name)}</div>`;
  const blocks = text.split(/\n{2,}/).map((block) => {
    const t = block.trim();
    if (/^https?:\/\/\S+$/.test(t)) {
      return `<p style="margin:24px 0"><a href="${escapeHtml(t)}" style="display:inline-block;background:${colors.primary};color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${escapeHtml(buttonLabel(t))}</a></p>`;
    }
    const inner = escapeHtml(t)
      .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:${colors.primary}">${u}</a>`)
      .replace(/\n/g, '<br>');
    return `<p style="margin:0 0 14px">${inner}</p>`;
  }).join('');
  const footer = [company.name, company.address, company.phone].filter(Boolean).map(escapeHtml).join(' · ');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f3f8;font-family:Arial,Helvetica,sans-serif;color:#1d1b29">
<div style="max-width:560px;margin:0 auto;padding:28px 16px">
<div style="background:#ffffff;border-radius:16px;padding:28px;border-top:6px solid ${colors.primary};font-size:15px;line-height:1.55">${logo}${blocks}</div>
<p style="font-size:12px;color:#77738a;text-align:center;margin-top:16px">${footer}</p>
</div></body></html>`;
}

function buttonLabel(url) {
  if (url.includes('/s/')) return 'Voir et signer le devis';
  if (url.includes('/p/')) return 'Payer en ligne';
  if (url.includes('/d/')) return 'Voir le devis';
  if (url.includes('/login')) return 'Se connecter';
  return 'Ouvrir';
}

const enabled = () => Boolean(config.resend.key && config.resend.from);

// Hors production, les derniers mails simulés restent en mémoire (tests automatiques)
const outbox = [];

// Envoie un mail et le note dans l'historique. Ne lève pas d'erreur : un mail en échec est visible dans la fiche.
async function send({ to, template, vars = {}, deal_id = null, contact_id = null, attachments = [], replyTo, user_id = null, quiet = false }) {
  const { subject, text, html } = render(template, vars);
  const now = settings.now();
  const id = db.insert('emails', { deal_id, contact_id, to_addr: to, template, subject, status: 'queued', created_at: now, updated_at: now });
  let status = 'sent', provider_id = null, error = null;
  if (!enabled()) {
    status = 'simulated';
    if (!config.production) { outbox.push({ to, template, subject, text, attachments: attachments.length }); if (outbox.length > 100) outbox.shift(); }
    // Tant que Resend n'est pas branché, le mail (et donc un code de connexion) s'affiche dans les journaux
    console.log(`\n--- Mail simulé à ${to} ---\nObjet : ${subject}\n${text}\n${attachments.length ? `[${attachments.length} pièce(s) jointe(s)]\n` : ''}---\n`);
  } else {
    try {
      const body = {
        from: config.resend.from, to: [to], subject, html, text,
        reply_to: replyTo || config.resend.replyTo || undefined,
        attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
        tags: [{ name: 'template', value: template }],
      };
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resend.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `crm-${id}` },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `Resend : erreur ${r.status}`);
      provider_id = data.id;
    } catch (e) {
      status = 'failed';
      error = e.message;
      console.error('Mail en échec :', e.message);
    }
  }
  db.update('emails', id, { status, provider_id, error, updated_at: settings.now() });
  if (deal_id && !quiet) {
    activity.log({ deal_id, contact_id, user_id, kind: 'mail', text: `${settings.mailTemplate(template).label} envoyé à ${to} · ${STATUS_LABEL[status]}`, meta: { email_id: id } });
  }
  return { id, status, error };
}

// Vérification de la signature des webhooks Resend (format Svix)
function verifyWebhook(headers, raw) {
  const secret = config.resend.webhookSecret;
  if (!secret) return false;
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = headers['svix-signature'];
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  return sigs.split(' ').some((s) => safeEqual(s.split(',')[1] || '', expected));
}

const EVENT_STATUS = {
  'email.sent': 'sent', 'email.delivered': 'delivered', 'email.opened': 'opened', 'email.clicked': 'clicked',
  'email.bounced': 'bounced', 'email.complained': 'complained', 'email.delivery_delayed': 'delayed', 'email.failed': 'failed',
};
const RANK = { queued: 0, sent: 1, delayed: 1, delivered: 2, opened: 3, clicked: 4, bounced: 5, complained: 5, failed: 5 };

function handleWebhook(event) {
  const status = EVENT_STATUS[event.type];
  const pid = event.data?.email_id;
  if (!status || !pid) return;
  const e = db.get('SELECT * FROM emails WHERE provider_id = ?', pid);
  if (!e) return;
  if ((RANK[status] ?? 0) < (RANK[e.status] ?? 0)) return; // jamais revenir en arrière (ouvert -> délivré)
  db.update('emails', e.id, { status, updated_at: settings.now(), error: status === 'bounced' ? (event.data?.bounce?.message || 'rejeté') : e.error });
  if (e.deal_id && ['delivered', 'opened', 'bounced', 'complained'].includes(status)) {
    activity.log({ deal_id: e.deal_id, kind: 'mail', text: `${settings.mailTemplate(e.template)?.label || e.template} à ${e.to_addr} · ${STATUS_LABEL[status]}` });
  }
}

module.exports = { send, render, layout, verifyWebhook, handleWebhook, enabled, STATUS_LABEL, outbox };
