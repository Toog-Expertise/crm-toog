'use strict';
// Chiffres du tableau de bord : Analytics (visites) + CRM (demandes, devis) + Stripe (encaissé).
const db = require('./db');
const settings = require('./settings');
const analytics = require('./analytics');
const { parisParts, parisToTs, startOfParisDay, fullName, dateEvent } = require('./util');

function range(period) {
  const now = settings.now();
  const p = parisParts(now);
  if (period === 'annee') return { from: parisToTs(p.year, 1, 1), to: now, label: `année ${p.year}` };
  if (period === 'mois') return { from: parisToTs(p.year, p.month, 1), to: now, label: new Intl.DateTimeFormat('fr-FR', { month: 'long', timeZone: 'Europe/Paris' }).format(now) };
  const day = startOfParisDay(now);
  const back = (p.weekday + 6) % 7; // lundi = 0
  return { from: parisToTs(...ymdOf(day - back * 86400e3), 0, 0), to: now, label: 'cette semaine' };
}
function ymdOf(ts) { const p = parisParts(ts + 12 * 3600e3); return [p.year, p.month, p.day]; }

function isoWeek(ts) {
  const p = parisParts(ts);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y) / 86400e3 + 1) / 7);
}

function todo(user) {
  const now = settings.now();
  const endToday = startOfParisDay(now) + 86400e3;
  const items = [];
  for (const t of db.all('SELECT t.*, d.title dtitle FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id WHERE t.done_at IS NULL AND (t.due_at IS NULL OR t.due_at < ?) ORDER BY t.due_at LIMIT 8', endToday)) {
    items.push({ text: t.title, tag: t.due_at && t.due_at < startOfParisDay(now) ? 'en retard' : 'tâche', deal_id: t.deal_id, task_id: t.id });
  }
  for (const d of db.all("SELECT d.*, c.first_name, c.last_name, c.email FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.stage = 'nouvelle' ORDER BY d.created_at LIMIT 6")) {
    items.push({ text: `Faire le devis de ${fullName(d) || d.title}`, tag: 'demande', deal_id: d.id });
  }
  for (const p of db.all("SELECT p.*, c.first_name, c.last_name FROM payments p JOIN deals d ON d.id = p.deal_id LEFT JOIN contacts c ON c.id = d.contact_id WHERE p.status = 'pending' AND p.kind = 'deposit' AND d.stage IN ('signe') LIMIT 4")) {
    items.push({ text: `Vérifier l'acompte de ${fullName(p)}`, tag: 'signé', deal_id: p.deal_id });
  }
  for (const e of db.all("SELECT * FROM events WHERE status = 'confirmed' AND start_at BETWEEN ? AND ? ORDER BY start_at LIMIT 4", now, now + 3 * 86400e3)) {
    items.push({ text: `Préparer l'accueil : ${e.title}`, tag: new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'Europe/Paris' }).format(e.start_at), deal_id: e.deal_id });
  }
  return items.slice(0, 10);
}

// Délai moyen entre l'envoi du devis et le paiement de l'acompte (acomptes payés sur la période).
// Les délais de plus de 30 jours sont exclus : ils faussent la moyenne (dossiers en sommeil, relances oubliées).
const MAX_DELAY_DAYS = 30;
function depositDelay(from, to) {
  const rows = db.all(`SELECT q.id, q.sent_at, MIN(p.paid_at) paid_at FROM quotes q JOIN payments p ON p.quote_id = q.id
    WHERE q.sent_at IS NOT NULL AND p.kind IN ('deposit', 'full', 'balance') AND p.status IN ('paid', 'partially_refunded', 'refunded')
    GROUP BY q.id HAVING MIN(p.paid_at) BETWEEN ? AND ?`, from, to);
  const days = rows.map((r) => (r.paid_at - r.sent_at) / 86400e3).filter((d) => d >= 0);
  const kept = days.filter((d) => d <= MAX_DELAY_DAYS);
  return { days: kept.length ? Math.round((kept.reduce((a, b) => a + b, 0) / kept.length) * 10) / 10 : null, count: kept.length, excluded: days.length - kept.length, max_days: MAX_DELAY_DAYS };
}

// Valeur du pipe : le montant des devis des demandes en cours (ni payées ni perdues), moins ce qui est déjà encaissé
function pipeline() {
  const open = db.all("SELECT d.id, d.stage FROM deals d WHERE d.stage NOT IN ('paye', 'perdu')");
  let amount = 0, quoted = 0;
  const byStage = {};
  for (const d of open) {
    const q = db.get("SELECT id, total_ttc FROM quotes WHERE deal_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1", d.id);
    if (!q) continue;
    const paid = db.get("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) s FROM payments WHERE quote_id = ? AND status IN ('paid', 'partially_refunded')", q.id).s;
    const v = Math.max(0, q.total_ttc - paid);
    amount += v; quoted++;
    byStage[d.stage] = (byStage[d.stage] || 0) + v;
  }
  return { amount, deals: open.length, quoted, unquoted: open.length - quoted, by_stage: byStage };
}

// En direct : les dernières demandes et les derniers devis (l'accueil se rafraîchit tout seul)
function live() {
  return {
    deals: db.all(`SELECT d.id, d.title, d.stage, d.source, d.created_at, c.first_name, c.last_name, co.name company FROM deals d
      LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id ORDER BY d.created_at DESC LIMIT 6`).map((d) => ({ id: d.id, title: d.title, stage: d.stage, source: d.source, at: d.created_at, client: d.company || fullName(d) || '—' })),
    quotes: db.all(`SELECT q.id, q.number, q.status, q.total_ttc, q.deal_id, q.sent_at, q.viewed_at, q.signed_at, q.updated_at, c.first_name, c.last_name, co.name company FROM quotes q
      JOIN deals d ON d.id = q.deal_id LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id
      WHERE q.status != 'cancelled' ORDER BY MAX(COALESCE(q.signed_at, 0), COALESCE(q.viewed_at, 0), COALESCE(q.sent_at, 0), q.updated_at) DESC LIMIT 6`)
      .map((q) => ({ id: q.id, number: q.number, status: q.status, total: q.total_ttc, deal_id: q.deal_id, client: q.company || fullName(q) || '—', viewed: Boolean(q.viewed_at), at: Math.max(q.signed_at || 0, q.viewed_at || 0, q.sent_at || 0, q.updated_at) })),
    at: settings.now(),
  };
}

// Le tableau de bord : 3 chiffres sur la période (cette semaine, du lundi au dimanche, ou ce mois-ci).
// Le délai moyen, la valeur du pipe et les visites restent des idées à montrer (fonctions ci-dessus), pas affichées.
function kpis(period = 'mois') {
  const { from, label } = range(period);
  const to = period === 'semaine' ? from + 7 * 86400e3 - 1 : settings.now();
  const count = (sql, ...p) => db.get(sql, ...p).n;
  const deals = count('SELECT COUNT(*) n FROM deals WHERE created_at BETWEEN ? AND ?', from, to);
  const sent = count('SELECT COUNT(*) n FROM quotes WHERE sent_at BETWEEN ? AND ?', from, to);
  const signed = count('SELECT COUNT(*) n FROM quotes WHERE signed_at BETWEEN ? AND ?', from, to);
  const signedAmount = db.get('SELECT COALESCE(SUM(total_ttc), 0) s FROM quotes WHERE signed_at BETWEEN ? AND ?', from, to).s;
  return { period, label, deals, sent, signed, signed_amount: signedAmount, rate: sent ? Math.round((signed / sent) * 100) : 0 };
}

async function dashboard(period = 'mois', user = null) {
  return {
    ...kpis(period),
    todo: todo(user),
    live: live(),
    pending_actions: db.all("SELECT id, label, created_at FROM pending_actions WHERE status = 'pending' ORDER BY id DESC LIMIT 10"),
    upcoming: db.all("SELECT e.id, e.title, e.start_at, e.deal_id FROM events e WHERE e.status = 'confirmed' AND e.start_at > ? ORDER BY e.start_at LIMIT 5", settings.now()).map((e) => ({ ...e, when: dateEvent(e.start_at) })),
  };
}

module.exports = { dashboard, kpis, range, pipeline, live, depositDelay };
