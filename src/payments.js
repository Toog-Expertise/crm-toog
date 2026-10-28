'use strict';
// Paiements Stripe : Checkout créé côté serveur, montant calculé par le CRM, webhook signé.
const crypto = require('node:crypto');
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const mail = require('./mail');
const deals = require('./deals');
const { config } = require('./env');
const { randomToken, money, safeEqual, fullName, HttpError, dateEvent } = require('./util');

const KIND_LABEL = { deposit: 'acompte', balance: 'solde', free: 'paiement libre', test: 'paiement de test' };

const stripeMode = () => {
  const k = config.stripe.secret;
  if (!k) return null;
  return /_(test)_/.test(k) ? 'test' : 'live';
};

async function stripe(method, pathName, params) {
  if (!config.stripe.secret) throw new HttpError(503, "Stripe n'est pas branché : ajoutez les clés dans le .env du serveur.");
  const body = params ? new URLSearchParams(flatten(params)) : undefined;
  const r = await fetch(`https://api.stripe.com/v1${pathName}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripe.secret}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new HttpError(502, `Stripe : ${data.error?.message || r.status}`);
  return data;
}

// { a: { b: 1 } } -> { 'a[b]': 1 }
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

function getPayment(id) {
  const p = db.get('SELECT * FROM payments WHERE id = ?', Number(id));
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  return p;
}

// Crée un paiement en attente et son lien /p/… (la session Stripe est créée au clic, toujours à jour)
function createPayment({ deal_id = null, quote_id = null, kind, amount_cents, label = '', user = null }) {
  const amount = Math.round(Number(amount_cents));
  if (!Number.isFinite(amount) || amount < 50) throw new HttpError(400, 'Montant invalide (minimum 0,50 €).');
  if (amount > 10000000) throw new HttpError(400, 'Montant trop élevé.');
  // Un seul lien en attente par devis et par type : on le réutilise
  if (quote_id && (kind === 'deposit' || kind === 'balance')) {
    const ex = db.get("SELECT * FROM payments WHERE quote_id = ? AND kind = ? AND status = 'pending'", quote_id, kind);
    if (ex && ex.amount_cents === amount) return ex;
    // Montant changé : l'ancien lien est annulé (s'il est quand même payé, le webhook l'enregistre au montant réel)
    if (ex) db.update('payments', ex.id, { status: 'cancelled' });
  }
  const id = db.insert('payments', {
    deal_id, quote_id, kind, label: label || KIND_LABEL[kind] || kind, amount_cents: amount, status: 'pending',
    pay_token: randomToken(24), created_by: user?.id || null, created_at: settings.now(),
  });
  if (deal_id) activity.log({ deal_id, user_id: user?.id, kind: 'payment', text: `Lien de paiement créé : ${label || KIND_LABEL[kind]} · ${money(amount)}${user ? ` (${user.name})` : ''}` });
  return getPayment(id);
}

const payLink = (p) => `${config.appUrl}/p/${p.pay_token}`;

// Montants restants d'un devis
function quoteBalance(quote) {
  const paid = db.get("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) s FROM payments WHERE quote_id = ? AND status IN ('paid', 'partially_refunded')", quote.id).s;
  return { paid, remaining: Math.max(0, quote.total_ttc - paid) };
}

function depositFor(quote) {
  const { paid } = quoteBalance(quote);
  const due = Math.max(0, quote.deposit_cents - paid);
  if (due < 50) return null;
  return createPayment({ deal_id: quote.deal_id, quote_id: quote.id, kind: 'deposit', amount_cents: due, label: `acompte ${String(quote.deposit_pct).replace('.', ',')} % · devis ${quote.number}` });
}

async function sendPaymentLink(p, user = null) {
  const deal = p.deal_id ? deals.getDeal(p.deal_id) : null;
  const c = deal ? deals.contactOf(deal) : null;
  if (!c?.email) throw new HttpError(400, "Le contact n'a pas d'adresse mail.");
  const r = await mail.send({ to: c.email, template: 'lien_paiement', deal_id: deal.id, contact_id: c.id, user_id: user?.id, vars: { prenom: c.first_name, libelle: p.label, montant: money(p.amount_cents), lien: payLink(p) } });
  db.update('payments', p.id, { sent_at: settings.now() });
  return r;
}

// Au clic sur /p/… : session Stripe Checkout avec le montant enregistré dans le CRM
async function checkoutUrl(token) {
  const p = db.get('SELECT * FROM payments WHERE pay_token = ?', token);
  if (!p) throw new HttpError(404, 'Lien de paiement introuvable.');
  if (p.status === 'paid' || p.status === 'partially_refunded') return { done: true, payment: p };
  if (p.status !== 'pending' && p.status !== 'failed') throw new HttpError(410, "Ce lien de paiement n'est plus valable.");
  const deal = p.deal_id ? db.get('SELECT * FROM deals WHERE id = ?', p.deal_id) : null;
  const c = deal ? deals.contactOf(deal) : null;
  const company = settings.get('company');
  const quote = p.quote_id ? db.get('SELECT number FROM quotes WHERE id = ?', p.quote_id) : null;
  const name = `${company.name} · ${p.label}`.slice(0, 250);
  // Une session encore ouverte est réutilisée : jamais deux paiements possibles pour le même lien
  if (p.stripe_session_id) {
    const old = await stripe('GET', `/checkout/sessions/${encodeURIComponent(p.stripe_session_id)}`).catch(() => null);
    if (old?.status === 'open' && old.amount_total === p.amount_cents) return { url: old.url, payment: p };
    if (old?.status === 'complete') return { done: true, payment: p };
    if (old?.status === 'open') await stripe('POST', `/checkout/sessions/${encodeURIComponent(old.id)}/expire`).catch(() => null);
  }
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    line_items: { 0: { quantity: 1, price_data: { currency: 'eur', unit_amount: p.amount_cents, product_data: { name, description: quote ? `Devis ${quote.number}` : undefined } } } },
    customer_email: c?.email || undefined,
    client_reference_id: String(p.id),
    metadata: { payment_id: p.id, crm: 'crm-toog' },
    payment_intent_data: { metadata: { payment_id: p.id, crm: 'crm-toog' }, description: name },
    success_url: `${config.appUrl}/p/${p.pay_token}?merci=1`,
    cancel_url: `${config.appUrl}/p/${p.pay_token}?annule=1`,
    locale: 'fr',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  db.update('payments', p.id, { stripe_session_id: session.id, livemode: session.livemode ? 1 : 0 });
  return { url: session.url, payment: p };
}

// Vérification de la signature Stripe (en-tête Stripe-Signature) sur le corps brut
function verifyWebhook(header, raw) {
  const secret = config.stripe.webhookSecret;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return String(header).split(',').filter((kv) => kv.startsWith('v1=')).some((kv) => safeEqual(kv.slice(3), expected));
}

// Enregistre ce que Stripe a réellement encaissé (montant de la session), même sur un lien annulé entre-temps
async function markPaid(p, { session_id, amount, payment_intent, livemode }) {
  const paidAmount = Number.isFinite(amount) ? amount : p.amount_cents;
  if (['paid', 'partially_refunded', 'refunded'].includes(p.status)) {
    if (!session_id || p.stripe_session_id === session_id || p.stripe_payment_intent === payment_intent) return; // webhook rejoué
    // Une deuxième session payée pour le même lien : l'argent est noté, à rembourser
    const id = db.insert('payments', { deal_id: p.deal_id, quote_id: p.quote_id, kind: p.kind, label: `${p.label} · en double, à rembourser`, amount_cents: paidAmount, status: 'paid', stripe_session_id: session_id, stripe_payment_intent: payment_intent, livemode: livemode ? 1 : 0, created_at: settings.now(), paid_at: settings.now() });
    if (p.deal_id) activity.log({ deal_id: p.deal_id, kind: 'payment', text: `Attention : paiement en double reçu (${money(paidAmount)}), paiement n°${id} à rembourser` });
    return;
  }
  db.update('payments', p.id, { status: 'paid', paid_at: settings.now(), amount_cents: paidAmount, stripe_session_id: session_id || p.stripe_session_id, stripe_payment_intent: payment_intent || p.stripe_payment_intent, livemode: livemode ? 1 : 0 });
  const wasCancelled = p.status === 'cancelled';
  const gap = paidAmount !== p.amount_cents;
  p = getPayment(p.id);
  if (!p.deal_id) return;
  const deal = deals.getDeal(p.deal_id);
  const c = deals.contactOf(deal);
  activity.log({ deal_id: deal.id, kind: 'payment', text: `Paiement reçu (Stripe) : ${p.label} · ${money(p.amount_cents)}${gap || wasCancelled ? ' · attention : lien annulé ou montant différent du CRM, à vérifier' : ''}` });
  if (c?.email) await mail.send({ to: c.email, template: 'recu', deal_id: deal.id, contact_id: c.id, vars: { prenom: c.first_name, montant: money(p.amount_cents), libelle: p.label } });
  // Étapes : acompte payé, puis payé quand tout est réglé
  const quote = p.quote_id ? db.get('SELECT * FROM quotes WHERE id = ?', p.quote_id) : null;
  if (quote) {
    const { remaining } = quoteBalance(quote);
    if (remaining <= 0) deals.setStage(deal.id, 'paye');
    else if (['nouvelle', 'a_rappeler', 'devis_envoye', 'signature', 'signe'].includes(deal.stage)) deals.setStage(deal.id, 'acompte');
  }
  require('./reminders').onPaid(deal.id);
  require('./calendar').onDepositPaid(deal.id).catch((e) => console.error('Agenda :', e.message));
}

async function handleWebhook(event) {
  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const pid = Number(obj.metadata?.payment_id || obj.client_reference_id);
    const p = pid ? db.get('SELECT * FROM payments WHERE id = ?', pid) : null;
    if (!p) return;
    if (obj.payment_status === 'paid') await markPaid(p, { session_id: obj.id, amount: Number(obj.amount_total), payment_intent: obj.payment_intent, livemode: obj.livemode });
    else db.update('payments', p.id, { stripe_payment_intent: obj.payment_intent });
  } else if (event.type === 'payment_intent.payment_failed' || event.type === 'checkout.session.async_payment_failed') {
    const pid = Number(obj.metadata?.payment_id);
    const p = pid ? db.get('SELECT * FROM payments WHERE id = ?', pid) : null;
    if (!p || p.status === 'paid') return;
    db.update('payments', p.id, { status: 'failed' });
    if (p.deal_id) activity.log({ deal_id: p.deal_id, kind: 'payment', text: `Paiement en échec : ${p.label} · ${obj.last_payment_error?.message || 'refusé'}` });
  } else if (event.type === 'charge.refunded') {
    const p = obj.payment_intent ? db.get('SELECT * FROM payments WHERE stripe_payment_intent = ?', obj.payment_intent) : null;
    if (!p) return;
    const refunded = obj.amount_refunded || 0;
    if (refunded === p.refunded_cents) return;
    db.update('payments', p.id, { refunded_cents: refunded, status: refunded >= p.amount_cents ? 'refunded' : 'partially_refunded', refunded_at: settings.now() });
    if (p.deal_id) activity.log({ deal_id: p.deal_id, kind: 'payment', text: `Remboursement confirmé par Stripe : ${money(refunded)} sur ${money(p.amount_cents)}` });
    if (p.deal_id) require('./reminders').onRefund(p.deal_id);
  }
}

async function refund(id, amountCents, user) {
  const p = getPayment(id);
  if (!['paid', 'partially_refunded'].includes(p.status) || !p.stripe_payment_intent) throw new HttpError(400, 'Seul un paiement encaissé par Stripe peut être remboursé.');
  const max = p.amount_cents - p.refunded_cents;
  const amount = amountCents ? Math.round(Number(amountCents)) : max;
  if (!(amount > 0 && amount <= max)) throw new HttpError(400, `Montant à rembourser invalide (maximum ${money(max)}).`);
  await stripe('POST', '/refunds', { payment_intent: p.stripe_payment_intent, amount, metadata: { payment_id: p.id } });
  const refunded = getPayment(p.id).refunded_cents + amount; // relu après l'appel (le webhook corrige de toute façon)
  db.update('payments', p.id, { refunded_cents: refunded, status: refunded >= p.amount_cents ? 'refunded' : 'partially_refunded', refunded_at: settings.now() });
  if (p.deal_id) activity.log({ deal_id: p.deal_id, user_id: user?.id, kind: 'payment', text: `Remboursement de ${money(amount)} (${p.label}) par ${user?.name || 'système'}` });
  if (p.deal_id) require('./reminders').onRefund(p.deal_id);
  return getPayment(p.id);
}

// État de Stripe pour les paramètres (jamais les clés)
async function status() {
  const mode = stripeMode();
  if (!mode) return { connected: false, label: 'non branché' };
  try {
    const acct = await stripe('GET', '/balance');
    return { connected: true, mode, label: mode === 'test' ? 'mode test' : 'mode réel', webhook: Boolean(config.stripe.webhookSecret), livemode: acct.livemode };
  } catch (e) {
    return { connected: false, mode, label: 'clé refusée', error: e.message };
  }
}

module.exports = { createPayment, depositFor, sendPaymentLink, checkoutUrl, verifyWebhook, handleWebhook, refund, status, stripeMode, payLink, quoteBalance, getPayment, KIND_LABEL, markPaid, flatten };
