'use strict';
// Mails automatiques (écran Mails auto), pour les devis B2B : relance signature 1 (J+3) et 2 (2 jours avant l'expiration),
// relance acompte 1 (J+2 après la signature) et 2 (la veille de l'échéance), merci à M+3 après le paiement total,
// « il y a un an » à M+12 après l'événement. Tout s'arrête dès que le client signe, paie ou répond.
// Envois de 9 h à 19 h, jamais le dimanche (réglable). Les étapes suivent : Relance email, Relance téléphonique.
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

// Même jour, n mois plus tard, à 10 h (heure de Paris)
function atMonth(from, months) {
  const p = parisParts(from);
  const d = new Date(Date.UTC(p.year, p.month - 1 + months, p.day));
  return nextSlot(parisToTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 10, 0));
}
const delayLabel = (months) => (months === 12 ? 'un an' : months % 12 === 0 ? `${months / 12} ans` : `${months} mois`);

function schedule({ deal_id, quote_id = null, rule, step = 1, channel = 'mail', label, template = null, message = null, due_at, created_by = null }) {
  return db.insert('reminders', { deal_id, quote_id, rule, step, channel, label, template, message, due_at, status: 'scheduled', created_by, created_at: settings.now() });
}

function cancel(dealId, rules, reason) {
  const q = `UPDATE reminders SET status = 'cancelled', error = ? WHERE deal_id = ? AND status IN ('scheduled', 'paused') AND rule IN (${rules.map(() => '?').join(',')})`;
  const r = db.run(q, reason, dealId, ...rules);
  return Number(r.changes);
}

const R = () => settings.get('reminders');

// Plus d'alerte « demande sans réponse » : le tableau des devis suffit (B2B)
function onNewDeal() {}

function onQuoteSent(q) {
  cancel(q.deal_id, ['quote_unsigned'], 'devis renvoyé');
  const deal = db.get('SELECT * FROM deals WHERE id = ?', q.deal_id);
  if (deal.reminders_paused) return;
  const r = R(), from = settings.now();
  if (r.sign1?.enabled) schedule({ deal_id: q.deal_id, quote_id: q.id, rule: 'quote_unsigned', step: 1, template: 'relance_devis', label: 'Relance signature 1', due_at: atDay(from, r.sign1.days) });
  if (r.sign2?.enabled && q.valid_until) {
    const due = nextSlot(Math.max(from + 3600e3, q.valid_until - (r.sign2.days_before || 2) * DAY));
    if (due < q.valid_until) schedule({ deal_id: q.deal_id, quote_id: q.id, rule: 'quote_unsigned', step: 2, template: 'relance_devis_2', label: 'Relance signature 2 (le devis expire)', due_at: due });
  }
}

function onStage(dealId, stage) {
  if (['signe', 'acompte', 'realise', 'paye', 'perdu'].includes(stage)) {
    const n = cancel(dealId, ['quote_unsigned'], stage === 'perdu' ? 'demande perdue' : 'devis signé');
    if (n) activity.log({ deal_id: dealId, kind: 'reminder', text: `Relances de signature arrêtées (${stage === 'perdu' ? 'demande perdue' : 'devis validé'})` });
  }
  if (['acompte', 'realise', 'paye', 'perdu'].includes(stage)) cancel(dealId, ['deposit_unpaid'], stage === 'perdu' ? 'demande perdue' : 'acompte payé');
  if (stage === 'perdu') cancel(dealId, ['thanks', 'one_year', 'manual'], 'demande perdue');
  if (stage === 'signe') {
    const r = R();
    const q = db.get("SELECT * FROM quotes WHERE deal_id = ? AND status = 'signed' ORDER BY signed_at DESC LIMIT 1", dealId);
    const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
    if (q && q.deposit_cents > 0 && !deal.reminders_paused && !db.get("SELECT 1 FROM reminders WHERE deal_id = ? AND rule = 'deposit_unpaid' AND status IN ('scheduled', 'paused')", dealId)) {
      const from = settings.now();
      if (r.dep1?.enabled) schedule({ deal_id: dealId, quote_id: q.id, rule: 'deposit_unpaid', step: 1, template: 'relance_acompte', label: 'Relance acompte 1', due_at: atDay(from, r.dep1.days) });
      if (r.dep2?.enabled) schedule({ deal_id: dealId, quote_id: q.id, rule: 'deposit_unpaid', step: 2, template: 'relance_acompte_2', label: 'Relance acompte 2 (24 h)', due_at: atDay(from, Math.max(1, (r.dep2.due_days || 7) - 1)) });
    }
  }
  // Fidélité : merci à M+3 du paiement total, « il y a un an » à M+12 de l'événement
  if (stage === 'paye') scheduleLoyalty(dealId);
}

function scheduleLoyalty(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  const r = R();
  const now = settings.now();
  if (r.m3?.enabled && !db.get("SELECT 1 FROM reminders WHERE deal_id = ? AND rule = 'thanks'", dealId)) schedule({ deal_id: dealId, rule: 'thanks', template: 'merci', label: `Merci · M+${r.m3.months}`, due_at: atMonth(now, r.m3.months) });
  if (r.m12?.enabled && !db.get("SELECT 1 FROM reminders WHERE deal_id = ? AND rule = 'one_year'", dealId)) schedule({ deal_id: dealId, rule: 'one_year', template: 'un_an', label: `Il y a un an · M+${r.m12.months}`, due_at: atMonth(deal.event_at || now, r.m12.months) });
}

// Un paiement est arrivé : l'étape a déjà suivi (payments.js) ; les relances d'acompte s'arrêtent
function onPaid(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  if (['acompte', 'realise', 'paye'].includes(deal.stage)) cancel(dealId, ['deposit_unpaid', 'quote_unsigned'], 'paiement reçu');
}

// Tout est remboursé : pas de mail de fidélité
function onRefund(dealId) {
  const kept = db.get("SELECT 1 FROM payments WHERE deal_id = ? AND status IN ('paid', 'partially_refunded')", dealId);
  if (!kept) cancel(dealId, ['thanks', 'one_year'], 'remboursé');
}

// La date de l'événement a changé : « il y a un an » suit
function onEventChanged(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  const f = R().m12;
  if (!deal?.event_at || !f) return;
  db.run("UPDATE reminders SET due_at = ? WHERE deal_id = ? AND rule = 'one_year' AND status IN ('scheduled', 'paused')", atMonth(deal.event_at, f.months), dealId);
}

// Le client a répondu : toutes les relances automatiques de la demande s'arrêtent
function onClientReplied(dealId, user) {
  const n = cancel(dealId, ['quote_unsigned', 'deposit_unpaid'], 'le client a répondu');
  activity.log({ deal_id: dealId, user_id: user?.id, kind: 'reminder', text: `Le client a répondu : ${n} relance(s) arrêtée(s)${user ? ` (${user.name})` : ''}` });
}

// Exécute une relance. Renvoie une raison si elle n'a plus lieu d'être.
async function execute(rem, user = null) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', rem.deal_id);
  const c = deal?.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', deal.contact_id) : null;
  const q = rem.quote_id ? db.get('SELECT * FROM quotes WHERE id = ?', rem.quote_id) : null;
  const obsolete = (why) => { db.update('reminders', rem.id, { status: 'cancelled', error: why }); return { skipped: why }; };
  if (!deal) return obsolete('demande supprimée');
  if (rem.rule === 'quote_unsigned' && (!q || q.status !== 'sent')) return obsolete('devis signé ou modifié');
  if (rem.rule === 'deposit_unpaid' && ['acompte', 'realise', 'paye', 'perdu'].includes(deal.stage)) return obsolete('acompte payé');
  if (['thanks', 'one_year'].includes(rem.rule) && deal.stage === 'perdu') return obsolete('demande perdue');
  // M+3 : pas de merci si un nouveau devis est déjà en cours pour ce client ; M+12 : pas de rappel s'il a signé dans l'année
  const same = deal.company_id ? ['company_id', deal.company_id] : ['contact_id', deal.contact_id];
  if (rem.rule === 'thanks' && db.get(`SELECT 1 FROM deals WHERE ${same[0]} = ? AND id != ? AND stage IN (${settings.BEFORE_SIGN.map(() => '?').join(',')})`, same[1], deal.id, ...settings.BEFORE_SIGN)) return obsolete('un nouveau devis est en cours pour ce client');
  if (rem.rule === 'one_year' && db.get(`SELECT 1 FROM quotes q JOIN deals d ON d.id = q.deal_id WHERE d.${same[0]} = ? AND d.id != ? AND q.signed_at > ?`, same[1], deal.id, settings.now() - 365 * DAY)) return obsolete('un devis a été signé dans les 12 derniers mois');
  const auto = { quote_unsigned: rem.step === 1 ? 'sign1' : 'sign2', deposit_unpaid: rem.step === 1 ? 'dep1' : 'dep2', thanks: 'm3', one_year: 'm12' }[rem.rule];
  if (auto && !user && R()[auto] && !R()[auto].enabled) return obsolete('mail automatique désactivé');

  const by = user ? ` (${user.name})` : '';
  try {
    if (rem.channel === 'call') {
      db.insert('tasks', { deal_id: deal.id, title: `Appeler ${fullName(c) || 'le client'}${q ? ` : devis ${q.number}` : ''}`, due_at: settings.now(), assigned_to: deal.assigned_to, created_by: user?.id || null, created_at: settings.now() });
      if (['devis_envoye', 'relance_email'].includes(deal.stage)) require('./deals').setStage(deal.id, 'relance_tel');
      activity.log({ deal_id: deal.id, user_id: user?.id, kind: 'reminder', text: `Tâche créée : appeler le client${by}` });
    } else {
      if (!c?.email) throw new Error("le contact n'a pas d'adresse mail");
      const vars = { prenom: c.first_name, client: fullName(c), message: rem.message || '', date: deal.event_at ? dateEvent(deal.event_at) : '' };
      if (q) Object.assign(vars, require('./quotes').quoteVars(q));
      if (/^relance_(devis|acompte)/.test(rem.template)) vars.lien = `${config.appUrl}/s/${require('./quotes').ensureSignToken(q)}`;
      if (/^relance_acompte/.test(rem.template)) {
        const p = require('./payments').depositFor(q);
        if (!p) return obsolete('acompte déjà réglé');
        vars.acompte = money(p.amount_cents);
      }
      const r = await mail.send({ to: c.email, template: rem.template || 'relance_manuelle', vars, deal_id: deal.id, contact_id: c.id, user_id: user?.id });
      if (r.status === 'failed') throw new Error(r.error || 'mail en échec');
      // Relance de signature partie : la demande passe en « Relance email »
      if (rem.rule === 'quote_unsigned' && deal.stage === 'devis_envoye') require('./deals').setStage(deal.id, 'relance_email');
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
      if (slot > now) { db.update('reminders', rem.id, { due_at: slot }); continue; }
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

// Appel au client noté à la main (relance téléphonique), visible dans le suivi des relances
const CALL_OUTCOMES = { joint: 'client joint', pas_de_reponse: 'pas de réponse', message: 'message laissé', rappeler: 'à rappeler' };
function logCall(dealId, { outcome, note, replied }, user) {
  const label = CALL_OUTCOMES[outcome] || CALL_OUTCOMES.joint;
  const now = settings.now();
  const id = db.insert('reminders', { deal_id: dealId, rule: 'call_log', step: 1, channel: 'call', label: `Appel · ${label}`, message: String(note || '').slice(0, 2000) || null, due_at: now, status: 'sent', sent_at: now, created_by: user?.id || null, created_at: now });
  activity.log({ deal_id: dealId, user_id: user?.id, kind: 'call', text: `Relance téléphonique : ${label}${note ? ` · ${String(note).slice(0, 200)}` : ''}${user ? ` (${user.name})` : ''}` });
  // L'appel fait : les tâches « Appeler » de la demande sont cochées
  db.run("UPDATE tasks SET done_at = ? WHERE deal_id = ? AND done_at IS NULL AND title LIKE 'Appeler%'", now, dealId);
  // Un appel avant la signature : la demande passe en « Relance téléphonique »
  const d = db.get('SELECT stage FROM deals WHERE id = ?', dealId);
  if (['devis_envoye', 'relance_email'].includes(d.stage)) require('./deals').setStage(dealId, 'relance_tel', user);
  if (replied) onClientReplied(dealId, user);
  return get(id);
}

// Suivi des relances d'une ou plusieurs demandes : mails partis, appels notés, prochaine relance
function followup(dealIds) {
  const out = {};
  const ids = [...new Set(dealIds.map(Number).filter(Boolean))];
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  for (const id of ids) out[id] = { mails: 0, calls: 0, next: null, last: null };
  for (const r of db.all(`SELECT deal_id, channel, rule, status, label, due_at, sent_at FROM reminders WHERE deal_id IN (${marks}) AND rule IN ('quote_unsigned', 'deposit_unpaid', 'manual', 'call_log', 'thanks', 'one_year') ORDER BY due_at`, ...ids)) {
    const f = out[r.deal_id];
    if (r.status === 'sent') {
      if (r.channel === 'mail' && !['thanks', 'one_year'].includes(r.rule)) f.mails++; else if (r.rule === 'call_log') f.calls++;
      if (!f.last || r.sent_at > f.last.at) f.last = { at: r.sent_at, label: r.label };
    } else if (r.status === 'scheduled' && !f.next) f.next = { at: r.due_at, label: r.label, channel: r.channel };
  }
  return out;
}

function start() {
  setInterval(() => tick().catch((e) => console.error('Relances :', e)), 60e3).unref();
  setTimeout(() => tick().catch((e) => console.error('Relances :', e)), 5e3).unref();
}

module.exports = { logCall, followup, CALL_OUTCOMES, atMonth, scheduleLoyalty, onRefund, onEventChanged, nextSlot, onNewDeal, onQuoteSent, onStage, onPaid, onClientReplied, tick, sendNow, postpone, cut, resume, manual, start, execute };
