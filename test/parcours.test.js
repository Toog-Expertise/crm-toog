'use strict';
// Parcours complet par HTTP, sur une base TEST jetable : connexion, rôles, demandes du site, devis automatique,
// signature, paiement (webhook Stripe signé), relances, MCP, RGPD, statuts Resend.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3998;
const RESEND_SECRET = 'whsec_' + Buffer.from('secret-resend-de-test').toString('base64');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'crm-parcours-')), NODE_ENV: 'test', PORT: String(PORT),
  APP_URL: `http://127.0.0.1:${PORT}`, ALLOWED_DOMAIN: 'exemple.fr', ADMIN_EMAIL: 'gerant@exemple.fr',
  STRIPE_WEBHOOK_SECRET: 'whsec_stripe_de_test', RESEND_WEBHOOK_SECRET: RESEND_SECRET, SITE_API_KEY: 'cle-site-de-test',
  SESSION_SECRET: 'x'.repeat(40), STRIPE_SECRET_KEY: '', RESEND_API_KEY: '', TURNSTILE_SECRET_KEY: '', GOOGLE_CLIENT_ID: '',
});
const { server } = require('../server');
const mail = require('../src/mail');
const db = require('../src/db');
const settings = require('../src/settings');

const base = `http://127.0.0.1:${PORT}`;
const jar = {};
async function call(method, url, body, { who = 'gerant', headers = {} } = {}) {
  const r = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set && set.includes('crm_session=')) jar[who] = set.split(';')[0];
  const type = r.headers.get('content-type') || '';
  return { status: r.status, data: type.includes('json') ? await r.json() : await r.text(), headers: r.headers };
}
const lastMail = (to, template) => [...mail.outbox].reverse().find((m) => m.to === to && (!template || m.template === template));
const codeOf = (m) => m.text.match(/\b(\d{6})\b/)[1];

async function login(email, who) {
  const r = await call('POST', '/auth/code/request', { email }, { who });
  if (r.status !== 200) return r;
  return call('POST', '/auth/code/verify', { email, code: codeOf(lastMail(email, 'code_connexion')) }, { who });
}
const old = () => Date.now() - 10000;

test.before(() => new Promise((ok) => server.listen(PORT, '127.0.0.1', ok)));
test.after(() => { server.close(); });

let productId, optionId, autoSign;

test('connexion : domaine refusé, gérant accepté, invité obligatoire', async () => {
  const refused = await call('POST', '/auth/code/request', { email: 'contact@gmail.com' }, { who: 'x' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /n'appartient pas à l'entreprise/);
  const notInvited = await call('POST', '/auth/code/request', { email: 'inconnu@exemple.fr' }, { who: 'x' });
  assert.equal(notInvited.status, 403);
  const ok = await login('gerant@exemple.fr', 'gerant');
  assert.equal(ok.status, 200);
  const me = await call('GET', '/api/me');
  assert.equal(me.data.user.role, 'gerant');
  const wrong = await call('POST', '/auth/code/verify', { email: 'gerant@exemple.fr', code: '000000' }, { who: 'x' });
  assert.equal(wrong.status, 400);
});

test('protection : autre origine refusée, pages sans session redirigées', async () => {
  const r = await call('PUT', '/api/settings/company', { value: {} }, { headers: { Origin: 'https://pirate.example' } });
  assert.equal(r.status, 403);
  const anon = await call('GET', '/', undefined, { who: 'personne' });
  assert.equal(anon.status, 302);
  const h = (await call('GET', '/login', undefined, { who: 'personne' })).headers;
  assert.match(h.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
});

test('paramètres : couleurs illisibles refusées, catalogue créé', async () => {
  const bad = await call('PUT', '/api/settings/colors', { value: { ...settings.DEFAULTS.colors, text: '#222222' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.issues[0].suggestion);
  const good = await call('PUT', '/api/settings/colors', { value: { ...settings.DEFAULTS.colors, primary: '#7B2CBF' } });
  assert.equal(good.status, 200);
  assert.match((await call('GET', '/theme.css')).data, /--primary:#7B2CBF/);
  productId = (await call('POST', '/api/products', { name: 'Partie TEST', pricing: 'per_person', price: '50', vat_rate: 20, min_people: 4, public: true, example: true, deal_types: ['entreprise', 'autre'] })).data.id;
  optionId = (await call('POST', '/api/products', { name: 'Boissons TEST', pricing: 'per_person', price: '3,00', vat_rate: 20, is_option: true, public: true })).data.id;
  await call('POST', '/api/products', { name: 'Formule anniversaire TEST', pricing: 'per_person', price: '15', vat_rate: 20, deal_types: ['anniversaire'] });
  assert.ok(productId && optionId);
});

test('équipe : invitation, rôle accueil, accès limité', async () => {
  const inv = await call('POST', '/api/users', { email: 'accueil@exemple.fr', role: 'accueil', name: 'Accueil TEST' });
  assert.equal(inv.status, 201);
  assert.ok(lastMail('accueil@exemple.fr', 'invitation'));
  const outsider = await call('POST', '/api/users', { email: 'quelquun@gmail.com', role: 'accueil' });
  assert.equal(outsider.status, 400);
  assert.equal((await login('accueil@exemple.fr', 'accueil')).status, 200);
  assert.equal((await call('GET', '/api/settings', undefined, { who: 'accueil' })).status, 403);
  assert.equal((await call('GET', '/api/deals', undefined, { who: 'accueil' })).status, 200);
});

test('formulaire du site : demande, alerte, accusé ; robot ignoré', async () => {
  const before = db.get('SELECT COUNT(*) n FROM deals').n;
  const bot = await call('POST', '/api/public/demande', { type: 'entreprise', name: 'Robot', email: 'bot@exemple.fr', consent: true, website: 'http://spam', ts: old() }, { who: 'site' });
  assert.equal(bot.status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM deals').n, before);
  const missing = await call('POST', '/api/public/demande', { type: 'entreprise', name: 'Paul TEST', email: 'paul.test@exemple.fr', consent: true, ts: old(), data: {} }, { who: 'site' });
  assert.equal(missing.status, 400); // « Société » obligatoire
  const r = await call('POST', '/api/public/demande', { type: 'entreprise', name: 'Paul TEST', email: 'paul.test@exemple.fr', phone: '06 00 00 00 02', people: 25, event_at: '2026-12-04T18:00', consent: true, ts: old(), page: '/entreprise/', data: { societe: 'Société Exemple TEST', budget: '30 €' } }, { who: 'site' });
  assert.equal(r.status, 200);
  const d = db.get('SELECT * FROM deals ORDER BY id DESC LIMIT 1');
  assert.equal(d.source, 'site');
  assert.equal(d.people, 25);
  assert.ok(db.get('SELECT 1 FROM companies WHERE name = ?', 'Société Exemple TEST'));
  assert.ok(lastMail('paul.test@exemple.fr', 'accuse_reception'));
  assert.ok(lastMail('gerant@exemple.fr', 'alerte_equipe'));
  // Même mail : pas de doublon de contact
  await call('POST', '/api/public/demande', { type: 'autre', name: 'Paul TEST', email: 'PAUL.test@exemple.fr', consent: true, ts: old() }, { who: 'site' });
  assert.equal(db.get("SELECT COUNT(*) n FROM contacts WHERE email = 'paul.test@exemple.fr'").n, 1);
});

test('API du site : clé obligatoire', async () => {
  assert.equal((await call('POST', '/api/public/demandes', { name: 'X', email: 'x@exemple.fr' }, { who: 'site' })).status, 401);
  const ok = await call('POST', '/api/public/demandes', { type: 'autre', name: 'Api TEST', email: 'api.test@exemple.fr' }, { who: 'site', headers: { 'X-Api-Key': 'cle-site-de-test' } });
  assert.equal(ok.status, 201);
});

test('devis automatique : le serveur recalcule le prix', async () => {
  const r = await call('POST', '/api/public/devis-auto', { product_id: productId, people: 10, options: [optionId], total: 1, price_cents: 1, event_at: '2026-11-22T15:00', name: 'Famille TEST', email: 'famille.test@exemple.fr', consent: true, ts: old() }, { who: 'site' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total_cents, 10 * 5000 + 10 * 300);
  assert.match(r.data.deposit, /159,00/);
  autoSign = r.data.sign_url;
  const q = db.get('SELECT * FROM quotes ORDER BY id DESC LIMIT 1');
  const deal = db.get('SELECT * FROM deals WHERE id = ?', q.deal_id);
  assert.equal(deal.source, 'devis_auto');
  assert.equal(deal.stage, 'devis_envoye');
  assert.ok(q.quote_sha256);
  const m = lastMail('famille.test@exemple.fr', 'devis');
  assert.equal(m.attachments, 1);
  assert.ok(m.text.includes(autoSign));
  const pdf = await fetch(base + autoSign + '/pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});

test('signature : code par mail, preuve SHA-256, lien fermé', async () => {
  const page = await call('GET', autoSign, undefined, { who: 'client' });
  assert.equal(page.status, 200);
  assert.match(page.data, /Votre devis<br>à signer/);
  const noCode = await call('POST', autoSign + '/sign', { name: 'Famille TEST', accept: true, code: '123456', signature: 'data:image/png;base64,AAAA' }, { who: 'client' });
  assert.equal(noCode.status, 400);
  assert.equal((await call('POST', autoSign + '/code', {}, { who: 'client' })).status, 200);
  const code = codeOf(lastMail('famille.test@exemple.fr', 'code_signature'));
  // Une signature PNG minimale (1x1)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const bad = await call('POST', autoSign + '/sign', { name: 'Famille TEST', accept: true, code: '000000', signature: `data:image/png;base64,${png}` }, { who: 'client' });
  assert.equal(bad.status, 400);
  const ok = await call('POST', autoSign + '/sign', { name: 'Famille TEST', accept: true, code, signature: `data:image/png;base64,${png}` }, { who: 'client' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const q = db.get('SELECT * FROM quotes ORDER BY id DESC LIMIT 1');
  assert.equal(q.status, 'signed');
  const pdf = Buffer.from(await (await fetch(base + autoSign + '/pdf')).arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), q.signed_pdf_sha256);
  assert.match(pdf.toString('latin1'), /\/Count 2/); // devis + page de preuve
  assert.equal(db.get('SELECT stage FROM deals WHERE id = ?', q.deal_id).stage, 'signe');
  assert.ok(lastMail('famille.test@exemple.fr', 'confirmation'));
  assert.ok(lastMail('gerant@exemple.fr', 'signe_equipe'));
  assert.equal((await call('POST', autoSign + '/sign', { name: 'X' }, { who: 'client' })).status, 409);
  assert.match((await call('GET', autoSign, undefined, { who: 'client' })).data, /déjà signé/);
  // Plus de relance « devis non signé » active
  assert.equal(db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND rule = 'quote_unsigned' AND status = 'scheduled'", q.deal_id).n, 0);
});

const stripeSig = (payload, secret = 'whsec_stripe_de_test') => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
};

test('paiement : webhook Stripe signé, acompte payé, agenda, reçu', async () => {
  const p = db.get("SELECT * FROM payments WHERE kind = 'deposit' ORDER BY id DESC LIMIT 1");
  assert.equal(p.amount_cents, 15900);
  assert.equal(p.status, 'pending');
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', livemode: false, metadata: { payment_id: String(p.id) } } } });
  const forged = await call('POST', '/api/stripe/webhook', ev, { who: 'stripe', headers: { 'Stripe-Signature': stripeSig(ev, 'whsec_faux') } });
  assert.equal(forged.status, 400);
  assert.equal(db.get('SELECT status FROM payments WHERE id = ?', p.id).status, 'pending');
  const ok = await call('POST', '/api/stripe/webhook', ev, { who: 'stripe', headers: { 'Stripe-Signature': stripeSig(ev) } });
  assert.equal(ok.status, 200);
  assert.equal(db.get('SELECT status FROM payments WHERE id = ?', p.id).status, 'paid');
  assert.equal(db.get('SELECT stage FROM deals WHERE id = ?', p.deal_id).stage, 'acompte');
  assert.ok(db.get("SELECT 1 FROM events WHERE deal_id = ? AND status = 'confirmed'", p.deal_id));
  assert.ok(lastMail('famille.test@exemple.fr', 'recu'));
  // Rejoué : sans effet
  await call('POST', '/api/stripe/webhook', ev, { who: 'stripe', headers: { 'Stripe-Signature': stripeSig(ev) } });
  assert.equal(db.get("SELECT COUNT(*) n FROM payments WHERE status = 'paid'").n, 1);
  // Une deuxième session payée pour le même lien : notée à part, à rembourser
  const dup = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_2', payment_status: 'paid', amount_total: 15900, payment_intent: 'pi_test_2', livemode: false, metadata: { payment_id: String(p.id) } } } });
  await call('POST', '/api/stripe/webhook', dup, { who: 'stripe', headers: { 'Stripe-Signature': stripeSig(dup) } });
  const twice = db.get("SELECT * FROM payments WHERE stripe_session_id = 'cs_test_2'");
  assert.match(twice.label, /en double/);
  db.run('DELETE FROM payments WHERE id = ?', twice.id);
  // Solde demandé : le reste à payer
  const bal = await call('POST', '/api/payments', { kind: 'balance', deal_id: p.deal_id });
  assert.equal(bal.status, 201);
  assert.equal(db.get('SELECT amount_cents FROM payments WHERE id = ?', bal.data.id).amount_cents, 53000 - 15900);
  // Remboursement signalé par Stripe
  const rf = JSON.stringify({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_test_1', amount_refunded: 15900 } } });
  await call('POST', '/api/stripe/webhook', rf, { who: 'stripe', headers: { 'Stripe-Signature': stripeSig(rf) } });
  assert.equal(db.get('SELECT status FROM payments WHERE id = ?', p.id).status, 'refunded');
});

test('relances : J+3 après l’envoi, horloge de test, arrêt à la signature', async () => {
  const deal = db.get("SELECT * FROM deals WHERE type = 'entreprise' ORDER BY id LIMIT 1");
  const q = (await call('POST', `/api/deals/${deal.id}/quotes`)).data;
  assert.ok(q.total_ttc > 0); // ligne du catalogue proposée : 25 × 50 €
  assert.equal(q.total_ttc, 25 * 5000);
  const sent = await call('POST', `/api/quotes/${q.id}/send`, { mode: 'devis' });
  assert.equal(sent.status, 200);
  const sched = db.all("SELECT * FROM reminders WHERE quote_id = ? AND status = 'scheduled' ORDER BY due_at", q.id);
  assert.equal(sched.length, 3);
  assert.equal((await call('POST', '/api/clock', { days: 3 }, { who: 'accueil' })).status, 403);
  const before = mail.outbox.filter((m) => m.template === 'relance_devis').length;
  // Avance jusqu'à J+4 (la relance de J+3 peut tomber un dimanche ou le soir : elle est alors recalée)
  await call('POST', '/api/clock', { days: 4 });
  await call('POST', '/api/clock', { days: 1 });
  assert.ok(mail.outbox.filter((m) => m.template === 'relance_devis').length > before, 'la relance J+3 est partie');
  // Reporter puis couper
  const next = db.get("SELECT * FROM reminders WHERE quote_id = ? AND status = 'scheduled' ORDER BY due_at LIMIT 1", q.id);
  assert.equal((await call('POST', `/api/reminders/${next.id}/postpone`, { until: '2027-01-05T10:00' })).status, 200);
  await call('POST', `/api/deals/${deal.id}/reminders/cut`);
  assert.equal(db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND status = 'scheduled'", deal.id).n, 0);
  await call('POST', '/api/clock', { reset: true });
});

test('MCP : jeton personnel, outils et chiffres ; actions sensibles à confirmer', async () => {
  const tok = await call('POST', '/api/tokens', { label: 'Claude' });
  const url = new URL(tok.data.url).pathname;
  const rpc = (method, params, id = 1) => call('POST', url, { jsonrpc: '2.0', id, method, params }, { who: 'mcp' });
  assert.equal((await call('POST', '/mcp/faux', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { who: 'mcp' })).status, 401);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.data.result.capabilities.tools !== undefined, true);
  assert.equal((await call('POST', url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { who: 'mcp' })).status, 202);
  const list = await rpc('tools/list');
  assert.ok(list.data.result.tools.some((t) => t.name === 'chiffres'));
  const ch = await rpc('tools/call', { name: 'chiffres', arguments: { periode: 'annee' } });
  const out = JSON.parse(ch.data.result.content[0].text);
  assert.ok(out.devis_signes >= 1);
  const deal = db.get('SELECT id FROM deals ORDER BY id LIMIT 1');
  await rpc('tools/call', { name: 'preparer_relance', arguments: { demande_id: deal.id, message: 'Bonjour TEST' } });
  assert.equal(db.get("SELECT status FROM reminders WHERE rule = 'manual' ORDER BY id DESC LIMIT 1").status, 'paused');
  const act = await rpc('tools/call', { name: 'demander_action', arguments: { action: 'rembourser', paiement_id: 1 } });
  assert.match(act.data.result.content[0].text, /à confirmer/);
  assert.equal((await call('GET', '/api/pending')).data.length, 1);
});

test('statuts Resend : webhook signé (format Svix)', async () => {
  const e = db.get('SELECT * FROM emails ORDER BY id DESC LIMIT 1');
  db.update('emails', e.id, { provider_id: 'em_test_1', status: 'sent' });
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_test_1' } });
  const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from(RESEND_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  assert.equal((await call('POST', '/api/resend/webhook', body, { who: 'resend', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,faux' } })).status, 400);
  assert.equal((await call('POST', '/api/resend/webhook', body, { who: 'resend', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } })).status, 200);
  assert.equal(db.get('SELECT status FROM emails WHERE id = ?', e.id).status, 'delivered');
});

test('import CSV : aperçu, doublons, création', async () => {
  const csv = 'Prénom;Nom;Mail;Téléphone\nCamille;TEST;camille.test@exemple.fr;0600000011\nCamille;TEST;camille.test@exemple.fr;\nSans;Contact;;\nPaul;TEST;paul.test@exemple.fr;\n';
  const content = Buffer.from(csv).toString('base64');
  const p = await call('POST', '/api/import/preview', { filename: 'contacts.csv', content });
  assert.equal(p.data.create, 1);
  assert.equal(p.data.update, 1);
  assert.equal(p.data.skip, 2);
  const c = await call('POST', '/api/import/commit', { filename: 'contacts.csv', content });
  assert.equal(c.data.created, 1);
});

test('RGPD : export puis suppression (anonymisation si paiement)', async () => {
  const c = db.get("SELECT * FROM contacts WHERE email = 'famille.test@exemple.fr'");
  const ex = await call('GET', `/api/contacts/${c.id}/export`);
  assert.equal(ex.status, 200);
  assert.ok(!JSON.stringify(ex.data).includes('sign_token'));
  assert.equal((await call('DELETE', `/api/contacts/${c.id}`, undefined, { who: 'accueil' })).status, 403);
  const del = await call('DELETE', `/api/contacts/${c.id}`);
  assert.equal(del.data.mode, 'anonymisé');
  assert.equal(db.get('SELECT email FROM contacts WHERE id = ?', c.id).email, null);
});

test('codes faux : blocage après 20 échecs en 24 h', async () => {
  for (let i = 0; i < 20; i++) db.run('INSERT INTO code_failures (key, at) VALUES (?, ?)', 'login:accueil@exemple.fr', Date.now());
  const r = await call('POST', '/auth/code/request', { email: 'accueil@exemple.fr' }, { who: 'x' });
  assert.equal(r.status, 429);
});

test('paiement au montant réel encaissé par Stripe', async () => {
  const d = db.get('SELECT id FROM deals ORDER BY id LIMIT 1');
  const created = await call('POST', '/api/payments', { kind: 'free', deal_id: d.id, amount: '20' });
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_9', payment_status: 'paid', amount_total: 2500, payment_intent: 'pi_test_9', livemode: false, metadata: { payment_id: String(created.data.id) } } } });
  await call('POST', '/api/stripe/webhook', ev, { who: 'stripe', headers: { 'Stripe-Signature': stripeSig(ev) } });
  assert.equal(db.get('SELECT amount_cents FROM payments WHERE id = ?', created.data.id).amount_cents, 2500);
});

const svix = (body) => {
  const id = 'msg_' + Math.random().toString(36).slice(2), ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from(RESEND_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
};

test('messages : mail reçu rangé dans la demande, relances arrêtées, réponse', async () => {
  const d = db.get("SELECT * FROM deals WHERE type = 'entreprise' ORDER BY id LIMIT 1");
  await call('POST', `/api/deals/${d.id}/reminders/resume`);
  const before = db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND status = 'scheduled'", d.id).n;
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'in_1', from: 'Paul TEST <paul.test@exemple.fr>', to: [`reponses+${d.id}@exemple.fr`], subject: 'Re: Votre devis', text: 'Bonjour,\nOn valide, merci !\n\nLe 28 oct. 2026, Bowling a écrit :\n> Voici votre devis' } });
  assert.equal((await call('POST', '/api/resend/webhook', body, { who: 'resend', headers: svix(body) })).status, 200);
  const m = db.get("SELECT * FROM messages WHERE provider_id = 'in_1'");
  assert.equal(m.thread, `d${d.id}`);
  assert.equal(m.body, 'Bonjour,\nOn valide, merci !');
  assert.ok(before === 0 || db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND status = 'scheduled' AND rule IN ('quote_unsigned', 'deposit_unpaid', 'no_answer')", d.id).n === 0);
  const list = await call('GET', '/api/messages');
  assert.ok(list.data.threads.some((t) => t.thread === `d${d.id}` && t.unread === 1));
  assert.equal((await call('GET', '/api/messages', undefined, { who: 'accueil' })).status, 200);
  const r = await call('POST', `/api/messages/thread/d${d.id}/reply`, { text: 'Parfait, à bientôt.' });
  assert.equal(r.status, 200);
  const sent = lastMail('paul.test@exemple.fr', 'message');
  assert.match(sent.subject, /^Re: Votre devis|^Re : /);
  assert.ok(!(await call('GET', '/api/messages')).data.threads.some((t) => t.thread === `d${d.id}`), 'traité après réponse');
  // Rejoué : pas de doublon
  await call('POST', '/api/resend/webhook', body, { who: 'resend', headers: svix(body) });
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE provider_id = 'in_1'").n, 1);
});

test('messages : expéditeur inconnu transformé en demande', async () => {
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'in_2', from: 'Inconnu TEST <inconnu.test@exemple.org>', to: ['reponses@exemple.fr'], subject: 'Une question', text: 'Ouvert le dimanche ?' } });
  await call('POST', '/api/resend/webhook', body, { who: 'resend', headers: svix(body) });
  const r = await call('POST', `/api/messages/thread/${encodeURIComponent('einconnu.test@exemple.org')}/deal`, {});
  assert.equal(r.status, 201);
  assert.equal(db.get("SELECT thread FROM messages WHERE provider_id = 'in_2'").thread, `d${r.data.id}`);
});

test('API : jeton personnel en Bearer, avec les droits de la personne', async () => {
  const tok = (await call('POST', '/api/tokens', { label: 'Outil TEST' }, { who: 'accueil' })).data.token;
  assert.equal((await call('GET', '/api/deals', undefined, { who: 'outil', headers: { Authorization: `Bearer ${tok}` } })).status, 200);
  assert.equal((await call('GET', '/api/settings', undefined, { who: 'outil', headers: { Authorization: `Bearer ${tok}` } })).status, 403);
  assert.equal((await call('GET', '/api/deals', undefined, { who: 'outil', headers: { Authorization: 'Bearer faux' } })).status, 401);
});
