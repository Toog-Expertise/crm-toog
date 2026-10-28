'use strict';
// Relances automatiques : devis non signé, acompte non payé, après la venue, demande sans réponse.
// Elles s'arrêtent dès que le client signe, paie ou répond. Envois de 9 h à 19 h, jamais le dimanche (réglable).
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const mail = require('./mail');
const { config } = require('./env');
const { parisParts, parisToTs, money, fullName, dateEvent, HttpError } = require('./util');

const DAY = 86400e3;

// Prochain créneau d'envoi autorisé à partir de ts
function nextSlot(ts) {
  const w = settings.get('reminders').window;
  for (let i = 0; i < 10; i++) {
    const p = parisParts(ts);
    const nextDay = () => { const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1)); return parisToTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), w.start, 0); };
    if (p.weekday === 0 && !w.sunday) { ts = nextDay(); continue; }
    if (p.hour < w.start) { ts = parisToTs(p.year, p.month, p.day, w.start, 0); continue; }
    if (p.hour >= w.end) { ts = nextDay(); continue; }
    return ts;
  }
  return ts;
}

// À J+n : même heure que l'événement de départ, recalée dans la fenêtre d'envoi
const atDay = (from, days) => nextSlot(from + days * DAY);

function schedule({ deal_id, quote_id = null, rule, step = 1, channel = 'mail', label, template = null, message = null, due_at, created_by = null }) {
  return db.insert('reminders', { deal_id, quote_id, rule, step, channel, label, template, message, due_at, status: 'scheduled', created_by, created_at: settings.now() });
}

function cancel(dealId, rules, reason) {
  const q = `UPDATE reminders SET status = 'cancelled', error = ? WHERE deal_id = ? AND status IN ('scheduled', 'paused') AND rule IN (${rules.map(() => '?').join(',')})`;
  const r = db.run(q, reason, dealId, ...rules);
  return Number(r.changes);
}

function onNewDeal(dealId) {
  const r = settings.get('reminders').no_answer;
  if (!r.enabled) return;
  schedule({ deal_id: dealId, rule: 'no_answer', channel: 'alert', label: 'Demande sans réponse', due_at: settings.now() + r.hours * 3600e3 });
}

function onQuoteSent(q) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', q.deal_id);
  cancel(q.deal_id, ['quote_unsigned', 'no_answer'], 'devis envoyé');
  const r = settings.get('reminders').quote_unsigned;
  if (!r.enabled || deal.reminders_paused) return;
  const from = settings.now();
  r.mail_days.forEach((d, i) => schedule({ deal_id: q.deal_id, quote_id: q.id, rule: 'quote_unsigned', step: i + 1, channel: 'mail', template: 'relance_devis', label: `Devis non signé · ${i === 0 ? '1re' : `${i + 1}e`} relance`, due_at: atDay(from, d) }));
  if (r.call_day) schedule({ deal_id: q.deal_id, quote_id: q.id, rule: 'quote_unsigned', step: r.mail_days.length + 1, channel: 'call', label: 'Devis non signé · à rappeler', due_at: atDay(from, r.call_day) });
}

function onStage(dealId, stage) {
  if (stage !== 'nouvelle') cancel(dealId, ['no_answer'], 'demande traitée');
  if (['signe', 'acompte', 'paye', 'perdu'].includes(stage)) {
    const n = cancel(dealId, ['quote_unsigned'], stage === 'perdu' ? 'demande perdue' : 'devis signé');
    if (n) activity.log({ deal_id: dealId, kind: 'reminder', text: `Relances du devis arrêtées (${stage === 'perdu' ? 'demande perdue' : 'devis signé'})` });
  }
  if (['acompte', 'paye', 'perdu'].includes(stage)) cancel(dealId, ['deposit_unpaid'], stage === 'perdu' ? 'demande perdue' : 'acompte payé');
  if (stage === 'perdu') cancel(dealId, ['after_visit', 'manual'], 'demande perdue');
  if (stage === 'signe') {
    const r = settings.get('reminders').deposit_unpaid;
    const q = db.get("SELECT * FROM quotes WHERE deal_id = ? AND status = 'signed' ORDER BY signed_at DESC LIMIT 1", dealId);
    if (r.enabled && q && q.deposit_cents > 0) {
      const from = settings.now();
      r.days.forEach((d, i) => schedule({ deal_id: dealId, quote_id: q.id, rule: 'deposit_unpaid', step: i + 1, template: 'relance_acompte', label: 'Acompte non payé · rappel', due_at: atDay(from, d) }));
    }
  }
}

function onPaid(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  if (['acompte', 'paye'].includes(deal.stage)) cancel(dealId, ['deposit_unpaid', 'quote_unsigned'], 'paiement reçu');
  const r = settings.get('reminders').after_visit;
  if (r.enabled && deal.event_at && !db.get("SELECT 1 FROM reminders WHERE deal_id = ? AND rule = 'after_visit'", dealId)) {
    const p = parisParts(deal.event_at);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + r.days));
    const due = nextSlot(parisToTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 10, 0));
    schedule({ deal_id: dealId, rule: 'after_visit', template: 'avis', label: 'Après la venue · avis Google', due_at: due });
  }
}

// Tout est remboursé : pas de « merci de votre venue »
function onRefund(dealId) {
  const kept = db.get("SELECT 1 FROM payments WHERE deal_id = ? AND status IN ('paid', 'partially_refunded')", dealId);
  if (!kept) cancel(dealId, ['after_visit'], 'remboursé');
}

// La date de la venue a changé : la relance « après la venue » suit
function onEventChanged(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  const r = settings.get('reminders').after_visit;
  if (!deal?.event_at) return;
  const p = parisParts(deal.event_at);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + r.days));
  db.run("UPDATE reminders SET due_at = ? WHERE deal_id = ? AND rule = 'after_visit' AND status IN ('scheduled', 'paused')", nextSlot(parisToTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 10, 0)), dealId);
}

// Le client a répondu : toutes les relances automatiques de la demande s'arrêtent
function onClientReplied(dealId, user) {
  const n = cancel(dealId, ['quote_unsigned', 'deposit_unpaid', 'no_answer'], 'le client a répondu');
  activity.log({ deal_id: dealId, user_id: user?.id, kind: 'reminder', text: `Le client a répondu : ${n} relance(s) arrêtée(s)${user ? ` (${user.name})` : ''}` });
}

function teamRecipients(deal) {
  const list = db.all("SELECT email FROM users WHERE active = 1 AND role = 'gerant'").map((u) => u.email);
  if (deal.assigned_to) { const u = db.get('SELECT email FROM users WHERE id = ? AND active = 1', deal.assigned_to); if (u) list.push(u.email); }
  if (config.resend.replyTo) list.push(config.resend.replyTo.replace(/^.*<(.+)>$/, '$1'));
  return [...new Set(list)];
}

// Exécute une relance. Renvoie une raison si elle n'a plus lieu d'être.
async function execute(rem, user = null) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', rem.deal_id);
  const c = deal?.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', deal.contact_id) : null;
  const q = rem.quote_id ? db.get('SELECT * FROM quotes WHERE id = ?', rem.quote_id) : null;
  const obsolete = (why) => { db.update('reminders', rem.id, { status: 'cancelled', error: why }); return { skipped: why }; };
  if (!deal) return obsolete('demande supprimée');
  if (rem.rule === 'quote_unsigned' && (!q || q.status !== 'sent')) return obsolete('devis signé ou modifié');
  if (rem.rule === 'no_answer' && deal.stage !== 'nouvelle') return obsolete('demande traitée');
  if (rem.rule === 'deposit_unpaid' && ['acompte', 'paye', 'perdu'].includes(deal.stage)) return obsolete('acompte payé');

  const by = user ? ` (${user.name})` : '';
  try {
    if (rem.channel === 'call') {
      db.insert('tasks', { deal_id: deal.id, title: `Appeler ${fullName(c) || 'le client'}${q ? ` : devis ${q.number} non signé` : ''}`, due_at: settings.now(), assigned_to: deal.assigned_to, created_by: user?.id || null, created_at: settings.now() });
      if (deal.stage === 'devis_envoye' || deal.stage === 'signature') require('./deals').setStage(deal.id, 'a_rappeler');
      activity.log({ deal_id: deal.id, user_id: user?.id, kind: 'reminder', text: `Tâche créée : appeler le client${by}` });
    } else if (rem.channel === 'alert') {
      const vars = { titre: deal.title, client: fullName(c), delai: `${settings.get('reminders').no_answer.hours} h`, lien: `${config.appUrl}/#/demandes/${deal.id}` };
      for (const to of teamRecipients(deal)) await mail.send({ to, template: 'alerte_sans_reponse', vars, deal_id: deal.id, quiet: true });
      activity.log({ deal_id: deal.id, user_id: user?.id, kind: 'reminder', text: `Alerte à l'équipe : demande sans réponse${by}` });
    } else {
      if (!c?.email) throw new Error("le contact n'a pas d'adresse mail");
      const vars = { prenom: c.first_name, client: fullName(c), message: rem.message || '', date: deal.event_at ? dateEvent(deal.event_at) : '' };
      if (q) Object.assign(vars, require('./quotes').quoteVars(q));
      if (rem.template === 'relance_devis') vars.lien = `${config.appUrl}/s/${require('./quotes').ensureSignToken(q)}`;
      if (rem.template === 'relance_acompte') {
        const p = require('./payments').depositFor(q);
        if (!p) return obsolete('acompte déjà réglé');
        vars.lien = require('./payments').payLink(p);
        vars.montant = money(p.amount_cents);
      }
      if (rem.template === 'avis') {
        vars.lien = settings.get('reminders').after_visit.review_url;
        if (!vars.lien) throw new Error("lien d'avis Google à renseigner dans Paramètres › Mails et relances");
      }
      const r = await mail.send({ to: c.email, template: rem.template || 'relance_manuelle', vars, deal_id: deal.id, contact_id: c.id, user_id: user?.id });
      if (r.status === 'failed') throw new Error(r.error || 'mail en échec');
    }
    db.update('reminders', rem.id, { status: 'sent', sent_at: settings.now(), error: null });
    return { sent: true };
  } catch (e) {
    db.update('reminders', rem.id, { status: 'error', error: e.message });
    activity.log({ deal_id: deal.id, kind: 'reminder', text: `Relance en erreur : ${rem.label} · ${e.message}` });
    return { error: e.message };
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = settings.now();
    const due = db.all("SELECT r.* FROM reminders r JOIN deals d ON d.id = r.deal_id WHERE r.status = 'scheduled' AND r.due_at <= ? AND d.reminders_paused = 0 ORDER BY r.due_at LIMIT 50", now);
    for (const rem of due) {
      const slot = nextSlot(now);
      if (slot > now && rem.channel !== 'alert') { db.update('reminders', rem.id, { due_at: slot }); continue; }
      await execute(rem);
    }
  } finally {
    running = false;
  }
}

// Actions de l'écran Relances
function get(id) {
  const r = db.get('SELECT * FROM reminders WHERE id = ?', Number(id));
  if (!r) throw new HttpError(404, 'Relance introuvable.');
  return r;
}
async function sendNow(id, user) {
  const r = get(id);
  if (!['scheduled', 'paused', 'error'].includes(r.status)) throw new HttpError(409, 'Cette relance est déjà partie ou annulée.');
  return execute(r, user);
}
function postpone(id, until, user) {
  const r = get(id);
  if (!['scheduled', 'paused', 'error'].includes(r.status)) throw new HttpError(409, 'Cette relance ne peut plus être reportée.');
  const ts = Number(until) || nextSlot(Math.max(r.due_at, settings.now()) + DAY);
  db.update('reminders', r.id, { due_at: ts, status: 'scheduled', error: null });
  activity.log({ deal_id: r.deal_id, user_id: user?.id, kind: 'reminder', text: `Relance reportée : ${r.label}${user ? ` (${user.name})` : ''}` });
  return get(r.id);
}
// Couper : toutes les relances de la demande passent en pause
function cut(dealId, user) {
  db.run("UPDATE reminders SET status = 'paused' WHERE deal_id = ? AND status = 'scheduled'", dealId);
  db.update('deals', dealId, { reminders_paused: 1 });
  activity.log({ deal_id: dealId, user_id: user?.id, kind: 'reminder', text: `Relances coupées${user ? ` (${user.name})` : ''}` });
}
function resume(dealId, user) {
  const now = settings.now();
  for (const r of db.all("SELECT * FROM reminders WHERE deal_id = ? AND status = 'paused'", dealId)) {
    db.update('reminders', r.id, { status: 'scheduled', due_at: r.due_at < now ? nextSlot(now + 3600e3) : r.due_at });
  }
  db.update('deals', dealId, { reminders_paused: 0 });
  activity.log({ deal_id: dealId, user_id: user?.id, kind: 'reminder', text: `Relances réactivées${user ? ` (${user.name})` : ''}` });
}
// paused : relance préparée depuis Claude (MCP), à réactiver dans le CRM avant de partir
function manual(dealId, { due_at, message, channel = 'mail', paused = false }, user) {
  if (!String(message || '').trim() && channel === 'mail') throw new HttpError(400, 'Écrivez le message de la relance.');
  const id = schedule({ deal_id: dealId, rule: 'manual', channel, template: channel === 'mail' ? 'relance_manuelle' : null, label: channel === 'call' ? 'Relance manuelle · appel' : 'Relance manuelle', message: String(message || '').slice(0, 3000), due_at: Number(due_at) || nextSlot(settings.now() + 3600e3), created_by: user?.id });
  if (paused) db.update('reminders', id, { status: 'paused' });
  activity.log({ deal_id: dealId, user_id: user?.id, kind: 'reminder', text: `Relance manuelle ${paused ? 'préparée depuis Claude, en pause : à réactiver pour l’envoyer' : 'prévue'}${user ? ` (${user.name})` : ''}` });
  return get(id);
}

function start() {
  setInterval(() => tick().catch((e) => console.error('Relances :', e)), 60e3).unref();
  setTimeout(() => tick().catch((e) => console.error('Relances :', e)), 5e3).unref();
}

module.exports = { onRefund, onEventChanged, nextSlot, onNewDeal, onQuoteSent, onStage, onPaid, onClientReplied, tick, sendNow, postpone, cut, resume, manual, start, execute };
