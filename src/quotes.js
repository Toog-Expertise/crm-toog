'use strict';
// Devis : création préremplie, numérotation continue, PDF à la charte, envoi, lien en ligne sans compte.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const mail = require('./mail');
const pricing = require('./pricing');
const deals = require('./deals');
const { config } = require('./env');
const { PDF, A4, wrap, textWidth } = require('./pdf');
const { sha256, randomToken, money, dateShort, dateEvent, dateTime, fullName, HttpError } = require('./util');

const pdfDir = () => { const d = path.join(config.dataDir, 'pdf'); fs.mkdirSync(d, { recursive: true }); return d; };

function getQuote(id) {
  const q = db.get('SELECT * FROM quotes WHERE id = ?', Number(id));
  if (!q) throw new HttpError(404, 'Devis introuvable.');
  return q;
}

function defaultObject(deal) {
  const data = pricing.safeJson(deal.data);
  const p = data.product_id ? db.get('SELECT name FROM products WHERE id = ?', Number(data.product_id)) : null;
  let obj = p ? p.name : settings.dealTypeLabel(deal.type).replace(/\s*\(.*\)$/, '');
  if (deal.type === 'anniversaire' && data.prenom_enfant) obj = `anniversaire de ${data.prenom_enfant}${data.age ? `, ${String(data.age).replace(/\s*ans?$/i, '')} ans` : ''}`;
  else if (deal.people) obj += ` · ${deal.people} ${deal.type === 'anniversaire' ? 'enfants' : 'personnes'}`;
  if (deal.event_at) obj += ` · ${dateEvent(deal.event_at)}`;
  return obj.charAt(0).toUpperCase() + obj.slice(1);
}

// Numérotation continue ; elle peut reprendre où l'ancien outil s'est arrêté (Paramètres › Devis › numéro de départ)
function nextNumber() {
  const qs = settings.get('quotes');
  const prefix = qs.number_prefix || 'D';
  let n = db.nextCounter('quote');
  const start = Math.max(1, Number(qs.number_start) || 1);
  if (n < start) { db.run("UPDATE counters SET value = ? WHERE name = 'quote'", start); n = start; }
  return `${prefix}-${new Date(settings.now()).getFullYear()}-${String(n).padStart(4, '0')}`;
}

// Crée le devis d'une demande, prérempli à partir de ce que le client a rempli
// deposit : { pct } ou { fixed } (centimes) ; payMethods : tiroirs proposés sur ce devis (null = tous ceux activés)
function createQuote(dealId, user = null, lines = null, { deposit = null, payMethods = null } = {}) {
  const deal = deals.getDeal(dealId);
  const qs = settings.get('quotes');
  const l = lines || pricing.suggestLines(deal);
  const t = deposit ? pricing.totals(l, deposit.pct, deposit.fixed) : qs.deposit_mode === 'fixe' ? pricing.totals(l, 0, qs.deposit_fixed_cents) : pricing.totals(l, pricing.depositPctFor(l));
  const now = settings.now();
  const id = db.insert('quotes', {
    number: nextNumber(), deal_id: deal.id, status: 'draft', object: defaultObject(deal),
    lines: JSON.stringify(t.lines), total_ht: t.total_ht, total_vat: t.total_vat, total_ttc: t.total_ttc,
    deposit_pct: t.deposit_pct, deposit_cents: t.deposit_cents, deposit_mode: t.deposit_mode, deposit_fixed_cents: t.deposit_fixed_cents,
    pay_methods: payMethods ? JSON.stringify(payMethods) : null, conditions: qs.conditions || '',
    issued_at: now, valid_until: now + (qs.validity_days || 30) * 86400e3,
    view_token: randomToken(24), created_by: user?.id || null, created_at: now, updated_at: now,
  });
  const q = getQuote(id);
  activity.log({ deal_id: deal.id, user_id: user?.id, kind: 'quote', text: `Devis ${q.number} créé · ${money(q.total_ttc)}${user ? ` (${user.name})` : ''}` });
  if (user) deals.claim(deal.id, user);
  return q;
}

// Modifier un devis envoyé le repasse en brouillon : il faudra le renvoyer (le client signe ce qu'il a reçu).
function updateQuote(id, input, user) {
  const q = getQuote(id);
  if (q.status === 'signed') throw new HttpError(409, 'Ce devis est signé : il ne peut plus être modifié. Créez un nouveau devis.');
  const mode = input.deposit_mode === 'fixe' || (input.deposit_mode === undefined && q.deposit_mode === 'fixe') ? 'fixe' : 'pct';
  const lines = Array.isArray(input.lines) ? input.lines : JSON.parse(q.lines);
  const t = mode === 'fixe' ? pricing.totals(lines, 0, input.deposit_fixed_cents ?? q.deposit_fixed_cents) : pricing.totals(lines, input.deposit_pct ?? q.deposit_pct);
  const upd = {
    object: String(input.object ?? q.object).slice(0, 300), conditions: String(input.conditions ?? q.conditions).slice(0, 4000),
    lines: JSON.stringify(t.lines), total_ht: t.total_ht, total_vat: t.total_vat, total_ttc: t.total_ttc,
    deposit_pct: t.deposit_pct, deposit_cents: t.deposit_cents, deposit_mode: t.deposit_mode, deposit_fixed_cents: t.deposit_fixed_cents, updated_at: settings.now(),
  };
  if (Array.isArray(input.pay_methods)) upd.pay_methods = JSON.stringify(input.pay_methods.filter((k) => ['rib', 'stripe'].includes(k)));
  if (input.valid_until) upd.valid_until = Number(input.valid_until);
  if (q.status === 'sent') {
    Object.assign(upd, { status: 'draft', sign_token: null, sign_expires_at: null, sign_code_hash: null, sign_code_validated_at: null });
    activity.log({ deal_id: q.deal_id, user_id: user?.id, kind: 'quote', text: `Devis ${q.number} modifié après envoi : repassé en brouillon, à renvoyer (${user?.name || 'système'})` });
  }
  db.update('quotes', q.id, upd);
  return getQuote(q.id);
}

// Moyens de paiement proposés, écrits sur le devis
function paymentText(q) {
  const pm = settings.get('payments');
  const methods = require('./payments').quoteMethods(q);
  const ways = [];
  if (methods.includes('stripe')) ways.push(`en ligne avec le lien de paiement sécurisé${pm.stripe_transfer ? ' (carte bancaire ou virement)' : ' (carte bancaire)'}`);
  if (methods.includes('rib')) ways.push(`par virement : ${pm.holder ? `${pm.holder}, ` : ''}IBAN ${formatIban(pm.iban)}${pm.bic ? `, BIC ${pm.bic}` : ''}, référence ${q.number}`);
  return ways.length ? `Règlement de l'acompte ${ways.join(' ; ou ')}.` : '';
}
const formatIban = (iban) => String(iban || '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();

function readLogo() {
  const f = settings.get('logo');
  if (!f) return null;
  const p = path.join(config.dataDir, 'uploads', path.basename(f));
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

// --- Le PDF du devis (fond blanc, à la charte), multi-pages automatiquement ---
function renderPdf(q, { signature = null, proof = null } = {}) {
  const deal = deals.getDeal(q.deal_id);
  const contact = deals.contactOf(deal) || {};
  const company = settings.get('company');
  const colors = settings.get('colors');
  const primary = colors.primary, second = colors.secondary;
  const ink = '#1d1b29', grey = '#6b6880', light = '#f2f0f8';
  const M = 50, W = A4.w - 2 * M, BOTTOM = A4.h - 70;
  const lines = JSON.parse(q.lines);
  const pdf = new PDF();
  let y = M;

  const footer = () => {
    const txt = [company.name, company.tagline, company.website].filter(Boolean).join(' · ');
    pdf.text(M, A4.h - 45, txt, { size: 8.5, color: grey, align: 'center', width: W });
  };
  const ensure = (h) => { if (y + h > BOTTOM) { footer(); pdf.addPage(); y = M; return true; } return false; };

  // En-tête
  const logo = readLogo();
  const drawn = logo ? pdf.image(logo, M, y, 110, 90) : null;
  if (!drawn) pdf.text(M, y + 10, company.name, { size: 18, bold: true, color: primary });
  pdf.text(M, y, 'DEVIS', { size: 34, bold: true, color: primary, align: 'right', width: W });
  pdf.text(M, y + 44, `N° ${q.number}`, { size: 13, bold: true, color: ink, align: 'right', width: W });
  const validDays = Math.round((q.valid_until - q.issued_at) / 86400e3);
  pdf.text(M, y + 64, `Date : ${dateShort(q.issued_at)} · valable ${validDays} jours (jusqu'au ${dateShort(q.valid_until)})`, { size: 9.5, color: grey, align: 'right', width: W });
  y += Math.max(drawn ? drawn.h : 40, 84) + 30;

  // Émetteur et client
  const colW = W / 2 - 10;
  pdf.text(M, y, (company.name || 'Entreprise').toUpperCase(), { size: 8, bold: true, color: primary });
  pdf.text(M + W / 2 + 10, y, 'CLIENT', { size: 8, bold: true, color: primary });
  y += 16;
  const left = [[company.legal_name || '[Raison sociale à compléter]', company.legal_form, company.capital ? `au capital de ${company.capital}` : ''].filter(Boolean).join(', '),
    company.address, company.phone, company.email,
    `SIRET : ${company.siret || '[à compléter]'}${company.rcs ? ` · RCS ${company.rcs}` : ''}`, `TVA intracommunautaire : ${company.vat_number || '[à compléter]'}`].filter(Boolean);
  const comp = deal.company_id ? db.get('SELECT name FROM companies WHERE id = ?', deal.company_id) : null;
  const right = [comp?.name, fullName(contact), contact.email, contact.phone].filter(Boolean);
  let ly = y, ry = y;
  for (const l of left) ly += pdf.paragraph(M, ly, l, colW, { size: 10, leading: 1.45 });
  for (const l of right) ry += pdf.paragraph(M + W / 2 + 10, ry, l, colW, { size: 10, leading: 1.45 });
  y = Math.max(ly, ry) + 22;

  // Objet
  if (q.object) {
    const objLines = wrap(`Objet : ${q.object}`, W - 28, 10.5);
    const h = objLines.length * 15 + 18;
    pdf.rect(M, y, W, h, { fill: light, radius: 6 });
    pdf.text(M + 14, y + 10, 'Objet :', { size: 10.5, bold: true, color: ink });
    const ow = textWidth('Objet : ', 10.5, true);
    pdf.paragraph(M + 14 + ow, y + 10, q.object, W - 28 - ow, { size: 10.5, leading: 1.43 });
    y += h + 20;
  }

  // Tableau des prestations
  const cQty = 40, cUnit = 95, cTot = 85, cLabel = W - cQty - cUnit - cTot;
  const header = () => {
    pdf.rect(M, y, W, 26, { fill: primary });
    const ty = y + 8;
    pdf.text(M + 10, ty, 'Prestation', { size: 10, bold: true, color: '#ffffff' });
    pdf.text(M + cLabel, ty, 'Qté', { size: 10, bold: true, color: '#ffffff', align: 'center', width: cQty });
    pdf.text(M + cLabel + cQty, ty, 'Prix unitaire HT', { size: 10, bold: true, color: '#ffffff', align: 'right', width: cUnit - 6 });
    pdf.text(M + cLabel + cQty + cUnit, ty, 'Total TTC', { size: 10, bold: true, color: '#ffffff', align: 'right', width: cTot - 10 });
    y += 26;
  };
  header();
  for (const l of lines) {
    const lab = wrap(l.label, cLabel - 20, 10);
    const desc = l.description ? wrap(l.description, cLabel - 20, 8.5) : [];
    const h = lab.length * 14 + desc.length * 12 + 18;
    if (ensure(h)) header();
    let ty = y + 9;
    lab.forEach((t) => { pdf.text(M + 10, ty, t, { size: 10, color: ink }); ty += 14; });
    desc.forEach((t) => { pdf.text(M + 10, ty, t, { size: 8.5, color: grey }); ty += 12; });
    pdf.text(M + cLabel, y + 9, String(l.qty), { size: 10, color: ink, align: 'center', width: cQty });
    pdf.text(M + cLabel + cQty, y + 9, money(Math.round(l.unit_cents / (1 + (l.vat_rate || 0) / 100))), { size: 10, color: ink, align: 'right', width: cUnit - 6 });
    pdf.text(M + cLabel + cQty + cUnit, y + 9, money(l.total_cents), { size: 10, color: ink, align: 'right', width: cTot - 10 });
    y += h;
    pdf.line(M, y, M + W, y);
  }
  if (!lines.length) { pdf.text(M + 10, y + 10, 'Aucune ligne.', { size: 10, color: grey }); y += 30; }

  // Totaux (TVA détaillée par taux)
  ensure(120);
  y += 16;
  const byRate = {};
  for (const l of lines) {
    const ht = Math.round(l.total_cents / (1 + l.vat_rate / 100));
    byRate[l.vat_rate] = (byRate[l.vat_rate] || 0) + (l.total_cents - ht);
  }
  const tx = M + W - 230;
  const row = (label, value, opts = {}) => {
    pdf.text(tx, y, label, { size: 10, color: grey, ...opts });
    pdf.text(tx, y, value, { size: 10, color: ink, align: 'right', width: 230, ...opts });
    y += 17;
  };
  row('Total HT', money(q.total_ht));
  for (const [rate, v] of Object.entries(byRate)) row(`TVA ${String(rate).replace('.', ',')} %`, money(v));
  y += 6;
  pdf.text(tx, y + 8, 'Total TTC', { size: 12, bold: true, color: ink });
  pdf.text(tx, y, money(q.total_ttc), { size: 24, bold: true, color: primary, align: 'right', width: 230 });
  y += 36;
  if (q.deposit_cents > 0) row(q.deposit_mode === 'fixe' ? 'Acompte à la validation' : `Acompte de ${String(q.deposit_pct).replace('.', ',')} % à la validation`, money(q.deposit_cents), { bold: true });
  y += 12;

  // Conditions et mentions
  const qs = settings.get('quotes');
  for (const [title, body] of [['CONDITIONS', q.conditions], ['RÈGLEMENT', paymentText(q)], ['MENTIONS', qs.legal_mentions]]) {
    if (!body) continue;
    const h = wrap(body, W, 9.5).length * 13.5 + 24;
    ensure(h);
    pdf.text(M, y, title, { size: 8, bold: true, color: primary });
    y += 14;
    y += pdf.paragraph(M, y, body, W, { size: 9.5, color: '#3a3750', leading: 1.42 }) + 14;
  }

  // Bon pour accord
  ensure(110);
  y += 6;
  pdf.text(M, y, 'Bon pour accord, date, nom et qualité du client', { size: 10, bold: true, color: ink });
  const bx = M + W / 2 + 10, bw = W / 2 - 10, bh = 84;
  if (signature) {
    pdf.rect(bx, y - 4, bw, bh, { stroke: second, lineWidth: 1, radius: 6 });
    pdf.text(bx + 10, y + 10, `« ${signature.agreement || 'Bon pour accord'} »`, { size: 13, bold: true, color: ink });
    pdf.text(bx + 10, y + 32, signature.name, { size: 10, bold: true, color: ink });
    pdf.text(bx + 10, y + 46, [signature.role, signature.company].filter(Boolean).join(' · ').slice(0, 60), { size: 8.5, color: ink });
    pdf.text(bx + 10, y + 62, `Validé en ligne le ${dateTime(signature.at)}`, { size: 8.5, color: grey });
    pdf.text(M, y + 18, 'Bon pour accord.', { size: 10, color: ink });
  } else {
    pdf.rect(bx, y - 4, bw, bh, { stroke: second, lineWidth: 1.2, dash: [4, 3], radius: 6 });
    pdf.text(bx, y + 32, 'Validation en ligne via le lien reçu par mail', { size: 10, bold: true, color: second, align: 'center', width: bw });
  }
  y += bh + 10;
  footer();

  // Page de preuve
  if (proof) {
    pdf.addPage();
    y = M;
    pdf.text(M, y, 'PAGE DE PREUVE', { size: 22, bold: true, color: primary });
    y += 34;
    pdf.paragraph(M, y, `Cette page atteste la signature électronique du devis ${q.number}. Elle est générée par le CRM au moment de la signature.`, W, { size: 10, color: grey });
    y += 36;
    for (const [k, v] of proof) {
      const h = Math.max(1, wrap(String(v), W - 170, 10).length) * 14 + 12;
      pdf.text(M, y, k, { size: 10, bold: true, color: ink });
      pdf.paragraph(M + 170, y, String(v), W - 170, { size: 10, color: ink, leading: 1.4 });
      y += h;
      pdf.line(M, y - 6, M + W, y - 6);
    }
    y += 10;
    pdf.paragraph(M, y, "L'empreinte SHA-256 de ce PDF signé est enregistrée dans le CRM au moment de la signature et communiquée dans le mail de confirmation : elle permet de vérifier que le document n'a pas été modifié.", W, { size: 9, color: grey });
    footer();
  }
  return pdf.output();
}

// Fige la version envoyée du devis : PDF enregistré et son empreinte
function freeze(q) {
  const buf = renderPdf(q);
  const file = path.join(pdfDir(), `${q.number}.pdf`);
  fs.writeFileSync(file, buf);
  db.update('quotes', q.id, { quote_sha256: sha256(buf) });
  return buf;
}

function quoteVars(q, extra = {}) {
  const deal = deals.getDeal(q.deal_id);
  const c = deals.contactOf(deal) || {};
  return {
    prenom: c.first_name || fullName(c) || '', client: fullName(c), numero: q.number, montant: money(q.total_ttc),
    validite: dateShort(q.valid_until), date: deal.event_at ? dateEvent(deal.event_at) : 'prévue', acompte: money(q.deposit_cents),
    societe: deal.company_id ? db.get('SELECT name FROM companies WHERE id = ?', deal.company_id)?.name || '' : '',
    paiement: extra.lien ? paymentLines(q, extra.lien) : '', ...extra,
  };
}

// Le paiement de l'acompte dans le mail du devis, selon ce que le dirigeant a choisi pour ce devis :
// le lien pour payer en ligne (après la validation, sur la même page) et/ou l'IBAN
function paymentLines(q, link) {
  if (!(q.deposit_cents > 0) || q.status === 'signed') return '';
  const ways = require('./payments').quoteMethods(q);
  const pm = settings.get('payments');
  const out = [];
  if (ways.includes('stripe')) out.push(`Payer l'acompte de ${money(q.deposit_cents)} en ligne, juste après la validation (carte bancaire${pm.stripe_transfer ? ' ou virement' : ''}) :`, '', `${link}?payer=1`);
  if (ways.includes('rib') && pm.iban) {
    if (out.length) out.push('');
    out.push(`${ways.includes('stripe') ? 'Ou par virement' : `Régler l'acompte de ${money(q.deposit_cents)} par virement`}, après la validation :`,
      [pm.holder && `Titulaire : ${pm.holder}`, `IBAN : ${formatIban(pm.iban)}`, pm.bic && `BIC : ${pm.bic}`, `Référence : ${q.number}`].filter(Boolean).join(' · '));
  }
  return out.join('\n');
}

function ensureSignToken(q) {
  // Valable 30 jours, sans dépasser la validité du devis
  const expires = Math.min(settings.now() + 30 * 86400e3, q.valid_until || Infinity);
  if (q.sign_token && q.sign_expires_at > settings.now()) return q.sign_token;
  const token = randomToken(32);
  db.update('quotes', q.id, { sign_token: token, sign_expires_at: expires });
  return token;
}

// mode = 'devis' (Envoyer le devis) ou 'demande_signature' (Demander la signature)
// Le devis part avec son lien de validation et de paiement : la signature n'est plus une étape à part
async function sendQuote(id, user = null, mode = 'devis') {
  mode = 'devis';
  let q = getQuote(id);
  if (q.status === 'signed') throw new HttpError(409, 'Ce devis est déjà signé.');
  const deal = deals.getDeal(q.deal_id);
  const c = deals.contactOf(deal);
  if (!c?.email) throw new HttpError(400, "Le contact n'a pas d'adresse mail.");
  if (!JSON.parse(q.lines).length) throw new HttpError(400, 'Le devis est vide.');
  const token = ensureSignToken(q);
  db.update('quotes', q.id, { status: 'sent', sent_at: q.sent_at || settings.now(), updated_at: settings.now() });
  q = getQuote(q.id);
  const pdf = freeze(q);
  const link = `${config.appUrl}/s/${token}`;
  const r = await mail.send({
    to: c.email, template: mode, deal_id: deal.id, contact_id: c.id, user_id: user?.id,
    vars: quoteVars(q, { lien: link }), attachments: [{ filename: `Devis ${q.number}.pdf`, content: pdf }],
  });
  activity.log({ deal_id: deal.id, user_id: user?.id, kind: 'quote', text: `Devis ${q.number} envoyé · ${money(q.total_ttc)}${user ? ` (${user.name})` : ''}` });
  const target = 'devis_envoye';
  const order = settings.STAGES.map((s) => s.key);
  if (order.indexOf(deal.stage) < order.indexOf(target) || deal.stage === 'perdu') deals.setStage(deal.id, target, user);
  require('./reminders').onQuoteSent(q);
  if (user) deals.claim(deal.id, user);
  return { quote: getQuote(q.id), mail: r, link };
}

// Le PDF à montrer : signé, sinon la version figée à l'envoi (celle que le client signe), sinon l'état actuel
function pdfFor(q) {
  const files = q.status === 'signed' ? [`${q.number}-signe.pdf`] : q.status === 'sent' ? [`${q.number}.pdf`] : [];
  for (const name of files) {
    const f = path.join(pdfDir(), name);
    if (fs.existsSync(f)) return fs.readFileSync(f);
  }
  return renderPdf(q);
}

module.exports = { formatIban, paymentText, getQuote, createQuote, updateQuote, renderPdf, freeze, sendQuote, quoteVars, ensureSignToken, pdfFor, pdfDir, defaultObject, readLogo };
