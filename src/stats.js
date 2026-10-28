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
    items.push({ text: `Répondre à ${fullName(d) || d.title}`, tag: 'demande', deal_id: d.id });
  }
  for (const p of db.all("SELECT p.*, c.first_name, c.last_name FROM payments p JOIN deals d ON d.id = p.deal_id LEFT JOIN contacts c ON c.id = d.contact_id WHERE p.status = 'pending' AND p.kind = 'deposit' AND d.stage IN ('signe') LIMIT 4")) {
    items.push({ text: `Acompte ${fullName(p)}`, tag: 'en attente', deal_id: p.deal_id });
  }
  for (const e of db.all("SELECT * FROM events WHERE status = 'confirmed' AND start_at BETWEEN ? AND ? ORDER BY start_at LIMIT 4", now, now + 3 * 86400e3)) {
    items.push({ text: `Préparer l'accueil : ${e.title}`, tag: new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'Europe/Paris' }).format(e.start_at), deal_id: e.deal_id });
  }
  return items.slice(0, 10);
}

async function dashboard(period = 'mois', user = null) {
  const { from, to, label } = range(period);
  const count = (sql, ...p) => db.get(sql, ...p).n;
  const dealsN = count('SELECT COUNT(*) n FROM deals WHERE created_at BETWEEN ? AND ?', from, to);
  const sent = count('SELECT COUNT(*) n FROM quotes WHERE sent_at BETWEEN ? AND ?', from, to);
  const signed = count('SELECT COUNT(*) n FROM quotes WHERE signed_at BETWEEN ? AND ?', from, to);
  const signedAmount = db.get('SELECT COALESCE(SUM(total_ttc), 0) s FROM quotes WHERE signed_at BETWEEN ? AND ?', from, to).s;
  const cashed = db.get("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) s FROM payments WHERE status IN ('paid', 'partially_refunded', 'refunded') AND paid_at BETWEEN ? AND ?", from, to).s;
  const ga = await analytics.overview(from, to);

  // Demandes par semaine (8 semaines) : affichées si Analytics n'est pas branché
  const weeks = [];
  const monday = range('semaine').from;
  for (let i = 7; i >= 0; i--) {
    const a = monday - i * 7 * 86400e3, b = a + 7 * 86400e3;
    weeks.push({ week: `S${isoWeek(a + 86400e3)}`, deals: count('SELECT COUNT(*) n FROM deals WHERE created_at BETWEEN ? AND ?', a, b - 1) });
  }
  const visits = ga.enabled && !ga.error ? ga.visits : null;
  return {
    period, label,
    kpis: { visits, deals: dealsN, sent, signed, rate: sent ? Math.round((signed / sent) * 100) : 0, signed_amount: signedAmount, cashed },
    funnel: [
      { label: 'Visites du site', value: visits },
      { label: 'Demandes reçues', value: dealsN },
      { label: 'Devis envoyés', value: sent },
      { label: 'Devis signés', value: signed },
    ],
    analytics: { enabled: ga.enabled, error: ga.error || null, weeks: ga.weeks || [], sources: ga.sources || [] },
    deals_by_week: weeks,
    todo: todo(user),
    pending_actions: db.all("SELECT id, label, created_at FROM pending_actions WHERE status = 'pending' ORDER BY id DESC LIMIT 10"),
    upcoming: db.all("SELECT e.id, e.title, e.start_at, e.deal_id FROM events e WHERE e.status = 'confirmed' AND e.start_at > ? ORDER BY e.start_at LIMIT 5", settings.now()).map((e) => ({ ...e, when: dateEvent(e.start_at) })),
  };
}

module.exports = { dashboard, range };
