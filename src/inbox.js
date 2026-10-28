'use strict';
// Messagerie : les mails reçus des clients (Resend, réception) et les réponses envoyées depuis le CRM,
// rangés par conversation : une demande, sinon un contact, sinon une adresse inconnue.
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const mail = require('./mail');
const deals = require('./deals');
const { config } = require('./env');
const { normEmail, fullName, HttpError } = require('./util');

// « Prénom Nom <adresse@x.fr> » -> { name, email }
function parseAddress(s) {
  const str = String(s || '').trim();
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: normEmail(m[2]) } : { name: '', email: normEmail(str) };
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Retire l'historique cité (« Le … a écrit : », lignes en >) pour ne garder que la réponse
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*(Le .{3,120}a écrit\s*:|On .{3,120}wrote\s*:|-----\s*(Original Message|Message d'origine)|De\s*:\s.+@|From\s*:\s.+@)/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim() || String(text || '').trim();
}

async function fetchReceived(id) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${config.resend.key}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend : ${d.message || r.status}`);
  return d;
}

// Trouve la demande : adresse de réponse « +123 », sinon le contact et sa dernière demande en cours
function locate(addresses, fromEmail) {
  for (const a of addresses) {
    const m = String(a).match(/\+(\d+)@/);
    if (m) {
      const d = db.get('SELECT * FROM deals WHERE id = ?', Number(m[1]));
      if (d) return { deal: d, contact: d.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', d.contact_id) : null };
    }
  }
  const contact = deals.findContact({ email: fromEmail });
  if (!contact) return { deal: null, contact: null };
  const deal = db.get("SELECT * FROM deals WHERE contact_id = ? AND stage != 'perdu' ORDER BY updated_at DESC LIMIT 1", contact.id);
  return { deal: deal || null, contact };
}

const threadOf = (deal, contact, email) => (deal ? `d${deal.id}` : contact ? `c${contact.id}` : `e${email}`);

// Webhook « email.received » : enregistre le mail, l'accroche à la bonne demande, arrête les relances
async function receive(data) {
  if (!data.email_id || db.get('SELECT 1 FROM messages WHERE provider_id = ?', data.email_id)) return;
  let full = data;
  if (config.resend.key) full = { ...data, ...(await fetchReceived(data.email_id)) };
  const from = parseAddress(full.headers?.from || full.from);
  if (!from.email) return;
  const addresses = [].concat(full.to || [], full.received_for || [], full.cc || []);
  const { deal, contact } = locate(addresses, from.email);
  const text = full.text || htmlToText(full.html);
  const now = settings.now();
  const id = db.insert('messages', {
    thread: threadOf(deal, contact, from.email), direction: 'in', deal_id: deal?.id || null, contact_id: contact?.id || null,
    from_addr: from.email, from_name: from.name || fullName(contact) || '', to_addr: addresses[0] || '',
    subject: String(full.subject || '(sans objet)').slice(0, 300), body: stripQuoted(text).slice(0, 20000), full_body: String(text).slice(0, 100000),
    provider_id: data.email_id, message_id: full.message_id || null,
    attachments: JSON.stringify((full.attachments || []).map((a) => ({ id: a.id, filename: a.filename, size: a.size }))),
    created_at: now,
  });
  if (deal) {
    activity.log({ deal_id: deal.id, contact_id: contact?.id, kind: 'mail', text: `Mail reçu de ${from.name || from.email} : « ${String(full.subject || '').slice(0, 120)} »` });
    // Le client a répondu : les relances automatiques s'arrêtent
    require('./reminders').onClientReplied(deal.id, null);
  }
  return id;
}

// Les conversations, la plus récente en premier
function threads(filter = 'a_traiter') {
  const rows = db.all(`SELECT m.thread, MAX(m.created_at) last_at,
      SUM(CASE WHEN m.direction = 'in' AND m.read_at IS NULL THEN 1 ELSE 0 END) unread,
      SUM(CASE WHEN m.direction = 'in' AND m.done_at IS NULL THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN m.direction = 'in' THEN 1 ELSE 0 END) received
    FROM messages m GROUP BY m.thread
    HAVING received > 0 ${filter === 'a_traiter' ? 'AND open > 0' : filter === 'traites' ? 'AND open = 0' : ''}
    ORDER BY last_at DESC LIMIT 200`);
  return rows.map((t) => {
    const last = db.get('SELECT * FROM messages WHERE thread = ? ORDER BY created_at DESC, id DESC LIMIT 1', t.thread);
    const lastIn = db.get("SELECT * FROM messages WHERE thread = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1", t.thread);
    const deal = last.deal_id ? db.get('SELECT id, title, stage FROM deals WHERE id = ?', last.deal_id) : null;
    return {
      thread: t.thread, last_at: t.last_at, unread: t.unread, open: t.open,
      name: lastIn?.from_name || lastIn?.from_addr || '', email: lastIn?.from_addr,
      subject: last.subject, preview: String(last.body).slice(0, 140), last_direction: last.direction,
      deal,
    };
  });
}

function thread(key, user) {
  const list = db.all('SELECT m.*, u.name user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.thread = ? ORDER BY m.created_at, m.id', key);
  if (!list.length) throw new HttpError(404, 'Conversation introuvable.');
  db.run("UPDATE messages SET read_at = ? WHERE thread = ? AND direction = 'in' AND read_at IS NULL", settings.now(), key);
  const dealId = [...list].reverse().find((m) => m.deal_id)?.deal_id;
  const contactId = [...list].reverse().find((m) => m.contact_id)?.contact_id;
  const lastIn = [...list].reverse().find((m) => m.direction === 'in');
  void user;
  return {
    thread: key, messages: list.map((m) => ({ ...m, attachments: JSON.parse(m.attachments || '[]') })),
    deal: dealId ? db.get('SELECT id, title, stage, type FROM deals WHERE id = ?', dealId) : null,
    contact: contactId ? db.get('SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ?', contactId) : null,
    reply_to: lastIn?.from_addr || null, done: !list.some((m) => m.direction === 'in' && !m.done_at),
  };
}

// Répondre (ou écrire) depuis le CRM
async function reply(key, { text, subject }, user) {
  const body = String(text || '').trim();
  if (!body) throw new HttpError(400, 'Écrivez votre réponse.');
  const t = thread(key, user);
  const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in');
  const to = lastIn?.from_addr || t.contact?.email;
  if (!to) throw new HttpError(400, "Pas d'adresse pour répondre.");
  const base = lastIn?.subject || t.messages[t.messages.length - 1].subject || 'Votre demande';
  const subj = String(subject || (/^re\s*:/i.test(base) ? base : `Re : ${base}`)).slice(0, 300);
  const headers = lastIn?.message_id ? { 'In-Reply-To': lastIn.message_id, References: lastIn.message_id } : undefined;
  const r = await mail.send({
    to, subject: subj, text: body, headers, deal_id: t.deal?.id || null, contact_id: t.contact?.id || null, user_id: user.id,
  });
  // Sans contact (adresse inconnue), le message n'est pas encore dans la conversation : on l'ajoute
  if (!t.contact) {
    db.insert('messages', { thread: key, direction: 'out', from_addr: config.resend.from || null, to_addr: to, subject: subj, body, user_id: user.id, read_at: settings.now(), done_at: settings.now(), created_at: settings.now() });
  }
  // Répondre = traité
  db.run("UPDATE messages SET done_at = ? WHERE thread = ? AND direction = 'in' AND done_at IS NULL", settings.now(), key);
  if (t.deal) deals.claim(t.deal.id, user);
  return { status: r.status, error: r.error };
}

function setDone(key, done) {
  db.run(`UPDATE messages SET done_at = ? WHERE thread = ? AND direction = 'in'`, done ? settings.now() : null, key);
}

// Un expéditeur inconnu devient une demande (et sa conversation la suit)
function toDeal(key, user) {
  const t = thread(key, user);
  if (t.deal) return t.deal.id;
  const first = t.messages.find((m) => m.direction === 'in');
  const r = deals.createDeal({ name: first.from_name || first.from_addr.split('@')[0], email: first.from_addr, message: first.body.slice(0, 2000), source: 'crm', title: first.subject.slice(0, 120), lenient: true }, user);
  db.run('UPDATE messages SET thread = ?, deal_id = ?, contact_id = ? WHERE thread = ?', `d${r.id}`, r.id, r.contact_id, key);
  return r.id;
}

async function attachmentUrl(messageId, attId) {
  const m = db.get('SELECT provider_id FROM messages WHERE id = ?', Number(messageId));
  if (!m?.provider_id || !config.resend.key) throw new HttpError(404, 'Pièce jointe indisponible.');
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(m.provider_id)}/attachments/${encodeURIComponent(attId)}`, { headers: { Authorization: `Bearer ${config.resend.key}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.download_url) throw new HttpError(502, 'Resend ne donne pas cette pièce jointe.');
  return d.download_url;
}

const unread = () => db.get("SELECT COUNT(DISTINCT thread) n FROM messages WHERE direction = 'in' AND done_at IS NULL").n;

module.exports = { receive, threads, thread, reply, setDone, toDeal, attachmentUrl, unread, stripQuoted, parseAddress, htmlToText, enabled: () => Boolean(config.resend.inbound) };
