'use strict';
// Règles de prix du catalogue. Les prix sont TTC, en centimes. Le serveur recalcule toujours.
const db = require('./db');
const settings = require('./settings');
const { HttpError } = require('./util');

const round = (n) => Math.round(n);

// Totaux d'un devis à partir de ses lignes
// depositFixed : un acompte en euros (centimes) au lieu d'un pourcentage
function totals(lines, depositPct, depositFixed = null) {
  let ttc = 0, ht = 0;
  const out = lines.map((l) => {
    const qty = Math.max(0, Number(l.qty) || 0);
    const unit = Math.max(0, round(Number(l.unit_cents) || 0));
    const vat = Math.max(0, Number(l.vat_rate ?? settings.get('quotes').default_vat) || 0);
    const lineTtc = round(qty * unit);
    const lineHt = round(lineTtc / (1 + vat / 100));
    ttc += lineTtc; ht += lineHt;
    return { product_id: l.product_id || null, label: String(l.label || '').slice(0, 300), description: String(l.description || '').slice(0, 500), qty, unit_cents: unit, vat_rate: vat, total_cents: lineTtc };
  });
  const pct = Math.min(100, Math.max(0, Number(depositPct) || 0));
  if (depositFixed !== null && depositFixed !== undefined) {
    const fixed = Math.min(ttc, Math.max(0, round(Number(depositFixed) || 0)));
    return { lines: out, total_ttc: ttc, total_ht: ht, total_vat: ttc - ht, deposit_mode: 'fixe', deposit_pct: ttc ? Math.round((fixed / ttc) * 1000) / 10 : 0, deposit_fixed_cents: fixed, deposit_cents: fixed };
  }
  return { lines: out, total_ttc: ttc, total_ht: ht, total_vat: ttc - ht, deposit_mode: 'pct', deposit_pct: pct, deposit_fixed_cents: null, deposit_cents: round(ttc * pct / 100) };
}

const typesOf = (p) => String(p.deal_types || '').split(',').map((s) => s.trim()).filter(Boolean);
const matchesType = (p, type) => !typesOf(p).length || typesOf(p).includes(type);

function lineFor(p, people) {
  const qty = p.pricing === 'per_person' ? Math.max(Number(people) || 1, p.min_people || 0) : 1;
  return { product_id: p.id, label: p.name, description: p.description, qty, unit_cents: p.price_cents ?? 0, vat_rate: p.vat_rate };
}

// Acompte du devis : celui de la première prestation qui a le sien (catalogue), sinon celui des paramètres
function depositPctFor(lines) {
  for (const l of lines || []) {
    if (!l.product_id) continue;
    const p = db.get('SELECT deposit_pct FROM products WHERE id = ?', Number(l.product_id));
    if (p && p.deposit_pct !== null && p.deposit_pct !== undefined) return p.deposit_pct;
  }
  return settings.get('quotes').deposit_pct;
}

// Lignes proposées pour une demande : l'activité choisie, sinon la première prestation du catalogue qui correspond au type
function suggestLines(deal) {
  const products = db.all("SELECT * FROM products WHERE active = 1 AND is_option = 0 AND pricing != 'quote' AND price_cents IS NOT NULL ORDER BY sort, id");
  const data = safeJson(deal.data);
  const lines = [];
  const p = products.find((x) => data.product_id && x.id === Number(data.product_id)) || products.find((x) => typesOf(x).includes(deal.type)) || null;
  if (p) lines.push(lineFor(p, deal.people));
  // Options cochées dans le formulaire
  for (const oid of [].concat(data.options || [])) {
    const o = db.get('SELECT * FROM products WHERE id = ? AND active = 1 AND is_option = 1', Number(oid));
    if (o && o.price_cents !== null) lines.push(lineFor(o, deal.people));
  }
  return lines;
}

// Catalogue public pour le devis automatique (aucune donnée interne)
function publicCatalog() {
  const rows = db.all("SELECT * FROM products WHERE active = 1 AND public = 1 AND pricing != 'quote' AND price_cents IS NOT NULL ORDER BY sort, id");
  const pick = (p) => ({ id: p.id, name: p.name, description: p.description, pricing: p.pricing, price_cents: p.price_cents, min_people: p.min_people, max_people: p.max_people, types: typesOf(p), example: Boolean(p.example) });
  return {
    activities: rows.filter((p) => !p.is_option).map(pick),
    options: rows.filter((p) => p.is_option).map(pick),
    deposit_pct: settings.get('quotes').deposit_pct,
  };
}

// Calcul du devis automatique, côté serveur, à partir du seul catalogue
function autoQuote({ product_id, people, options = [] }) {
  const p = db.get("SELECT * FROM products WHERE id = ? AND active = 1 AND public = 1 AND is_option = 0 AND pricing != 'quote' AND price_cents IS NOT NULL", Number(product_id));
  if (!p) throw new HttpError(400, 'Activité indisponible.');
  const n = Math.floor(Number(people));
  if (!Number.isFinite(n) || n < 1 || n > 1000) throw new HttpError(400, 'Nombre de personnes invalide.');
  if (p.max_people && n > p.max_people) throw new HttpError(400, `Au-delà de ${p.max_people} personnes, contactez-nous pour un devis sur mesure.`);
  const lines = [lineFor(p, n)];
  const notes = [];
  if (p.pricing === 'per_person' && p.min_people && n < p.min_people) notes.push(`Minimum ${p.min_people} personnes facturées.`);
  for (const oid of [...new Set([].concat(options).map(Number))]) {
    const o = db.get("SELECT * FROM products WHERE id = ? AND active = 1 AND public = 1 AND is_option = 1 AND price_cents IS NOT NULL", oid);
    if (!o) throw new HttpError(400, 'Option indisponible.');
    if (!(!typesOf(o).length || typesOf(o).some((t) => typesOf(p).includes(t)))) throw new HttpError(400, 'Option non compatible avec cette activité.');
    lines.push(lineFor(o, n));
  }
  return { product: p, people: n, notes, ...totals(lines, depositPctFor(lines)) };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

module.exports = { totals, suggestLines, publicCatalog, autoQuote, matchesType, safeJson, depositPctFor };
