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
const PW = 'mot-de-passe-TEST';
const login = (email, who, password = PW) => call('POST', '/auth/login', { email, password }, { who });
const old = () => Date.now() - 10000;

test.before(() => new Promise((ok) => server.listen(PORT, '127.0.0.1', ok)));
test.after(() => { server.close(); });

let productId, optionId, autoSign;

test('connexion : mail et mot de passe, compte créé par le gérant', async () => {
  // Le premier compte : node scripts/admin.js (ici directement)
  const auth = require('../src/auth');
  db.insert('users', { email: 'gerant@exemple.fr', first_name: 'Gérant', last_name: 'TEST', name: 'Gérant TEST', role: 'gerant', password_hash: auth.hashPassword(PW), created_at: Date.now() });
  assert.equal((await login('inconnu@exemple.fr', 'x')).status, 400);
  const wrong = await login('gerant@exemple.fr', 'x', 'mauvais-mot-de-passe');
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /incorrect/);
  assert.equal((await login('gerant@exemple.fr', 'gerant')).status, 200);
  const me = await call('GET', '/api/me');
  assert.equal(me.data.user.email, 'gerant@exemple.fr');
  assert.ok(me.data.access.includes('parametres'));
  assert.equal((await call('POST', '/auth/code/request', { email: 'gerant@exemple.fr' }, { who: 'x' })).status, 404);
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

test('équipe : le gérant crée un salarié et choisit son mot de passe ; tout le monde a tous les droits', async () => {
  assert.equal((await call('POST', '/api/users', { first_name: 'Accueil', last_name: 'TEST', email: 'accueil@exemple.fr', password: 'court' })).status, 400);
  const inv = await call('POST', '/api/users', { first_name: 'Accueil', last_name: 'TEST', email: 'accueil@exemple.fr', password: PW });
  assert.equal(inv.status, 201);
  assert.equal((await call('POST', '/api/users', { first_name: 'X', email: 'accueil@exemple.fr', password: PW })).status, 409);
  assert.equal((await login('accueil@exemple.fr', 'accueil')).status, 200);
  assert.equal((await call('GET', '/api/settings', undefined, { who: 'accueil' })).status, 200);
  // Mot de passe oublié : le gérant le change ; l'ancien ne marche plus
  assert.equal((await call('PUT', `/api/users/${inv.data.id}`, { password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { who: 'accueil' })).status, 401);
  assert.equal((await login('accueil@exemple.fr', 'accueil')).status, 400);
  assert.equal((await login('accueil@exemple.fr', 'accueil', 'nouveau-mot-de-passe')).status, 200);
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
  await call('POST', '/api/public/demande', { type: 'entreprise', name: 'Paul TEST', email: 'PAUL.test@exemple.fr', consent: true, ts: old(), data: { societe: 'Société Exemple TEST' } }, { who: 'site' });
  assert.equal(db.get("SELECT COUNT(*) n FROM contacts WHERE email = 'paul.test@exemple.fr'").n, 1);
});

test('API du site : clé obligatoire', async () => {
  assert.equal((await call('POST', '/api/public/demandes', { name: 'X', email: 'x@exemple.fr' }, { who: 'site' })).status, 401);
  const ok = await call('POST', '/api/public/demandes', { type: 'entreprise', name: 'Api TEST', email: 'api.test@exemple.fr', data: { societe: 'Api TEST SAS' } }, { who: 'site', headers: { 'X-Api-Key': 'cle-site-de-test' } });
  assert.equal(ok.status, 201);
});

test('devis automatique : le serveur recalcule le prix', async () => {
  const r = await call('POST', '/api/public/devis-auto', { product_id: productId, people: 10, options: [optionId], total: 1, price_cents: 1, event_at: '2026-11-22T15:00', company: 'Entreprise Auto TEST', first_name: 'Famille', last_name: 'TEST', role: 'office manager', email: 'famille.test@exemple.fr', consent: true, ts: old() }, { who: 'site' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total_cents, 10 * 5000 + 10 * 300);
  assert.match(r.data.deposit, /159,00/);
  autoSign = r.data.sign_url;
  const q = db.get('SELECT * FROM quotes ORDER BY id DESC LIMIT 1');
  const deal = db.get('SELECT * FROM deals WHERE id = ?', q.deal_id);
  assert.equal(deal.source, 'devis_auto');
  assert.equal(deal.stage, 'devis_envoye');
  assert.equal(deal.type, 'entreprise');
  assert.ok(db.get('SELECT 1 FROM companies WHERE id = ? AND name = ?', deal.company_id, 'Entreprise Auto TEST'));
  assert.ok(q.quote_sha256);
  const m = lastMail('famille.test@exemple.fr', 'devis');
  assert.equal(m.attachments, 1);
  assert.ok(m.text.includes(autoSign));
  const pdf = await fetch(base + autoSign + '/pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});

test('validation : une page, « bon pour accord » écrit, preuve SHA-256, lien fermé', async () => {
  const page = await call('GET', autoSign, undefined, { who: 'client' });
  assert.equal(page.status, 200);
  assert.match(page.data, /Je valide le devis/);
  assert.match(page.data, /Je paie l'acompte/);
  const base0 = { first_name: 'Famille', last_name: 'TEST' };
  assert.doesNotMatch(page.data, /name="company"|name="role"/);
  assert.equal((await call('POST', autoSign + '/sign', { ...base0, agreement: 'ok' }, { who: 'client' })).status, 400);
  assert.equal((await call('POST', autoSign + '/sign', { first_name: 'Famille', agreement: 'Bon pour accord' }, { who: 'client' })).status, 400);
  const ok = await call('POST', autoSign + '/sign', { ...base0, agreement: 'bon pour accord' }, { who: 'client' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const q = db.get('SELECT * FROM quotes ORDER BY id DESC LIMIT 1');
  assert.equal(q.status, 'signed');
  assert.equal(q.signer_company, 'Entreprise Auto TEST');
  const pdf = Buffer.from(await (await fetch(base + autoSign + '/pdf')).arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), q.signed_pdf_sha256);
  assert.match(pdf.toString('latin1'), /\/Count 2/); // devis + page de preuve
  assert.equal(db.get('SELECT stage FROM deals WHERE id = ?', q.deal_id).stage, 'signe');
  assert.ok(lastMail('famille.test@exemple.fr', 'confirmation'));
  assert.ok(lastMail('gerant@exemple.fr', 'signe_equipe'));
  assert.equal((await call('POST', autoSign + '/sign', base0, { who: 'client' })).status, 409);
  assert.match((await call('GET', autoSign, undefined, { who: 'client' })).data, /Validé le/);
  // Plus de relance de signature ; les relances d'acompte sont prévues
  assert.equal(db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND rule = 'quote_unsigned' AND status = 'scheduled'", q.deal_id).n, 0);
  assert.deepEqual(db.all("SELECT template FROM reminders WHERE deal_id = ? AND rule = 'deposit_unpaid' ORDER BY step", q.deal_id).map((r) => r.template), ['relance_acompte', 'relance_acompte_2']);
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
  assert.deepEqual(sched.map((r) => r.template), ['relance_devis', 'relance_devis_2']);
  const before = mail.outbox.filter((m) => m.template === 'relance_devis').length;
  // Avance jusqu'à J+4 (la relance de J+3 peut tomber un dimanche ou le soir : elle est alors recalée)
  await call('POST', '/api/clock', { days: 4 });
  await call('POST', '/api/clock', { days: 1 });
  assert.ok(mail.outbox.filter((m) => m.template === 'relance_devis').length > before, 'la relance J+3 est partie');
  assert.equal(db.get('SELECT stage FROM deals WHERE id = ?', deal.id).stage, 'relance_email');
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
  const ch = await rpc('tools/call', { name: 'chiffres', arguments: { periode: 'mois' } });
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
  const del = await call('DELETE', `/api/contacts/${c.id}`);
  assert.equal(del.data.mode, 'anonymisé');
  assert.equal(db.get('SELECT email FROM contacts WHERE id = ?', c.id).email, null);
});

test('mots de passe faux : blocage après 20 échecs en 24 h', async () => {
  for (let i = 0; i < 20; i++) db.run('INSERT INTO code_failures (key, at) VALUES (?, ?)', 'login:accueil@exemple.fr', Date.now());
  const r = await login('accueil@exemple.fr', 'x', 'nouveau-mot-de-passe');
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
  assert.ok(before === 0 || db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND status = 'scheduled' AND rule IN ('quote_unsigned', 'deposit_unpaid')", d.id).n === 0);
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
  assert.equal((await call('GET', '/api/settings', undefined, { who: 'outil', headers: { Authorization: `Bearer ${tok}` } })).status, 200);
  assert.equal((await call('GET', '/api/deals', undefined, { who: 'outil', headers: { Authorization: 'Bearer faux' } })).status, 401);
});

test('1.3 : nouveau devis manuel, acompte fixe, sans lien de paiement, post-it, appel', async () => {
  const r = await call('POST', '/api/quotes/manual', { company: 'Manuel TEST SAS', first_name: 'Léa', last_name: 'TEST', role: 'RH', email: 'lea.test@exemple.fr', type: 'entreprise', people: 20, lines: [{ product_id: productId, qty: 20 }], deposit_mode: 'fixe', deposit_value: '200', payment_link: false, postit: 'Veut une salle privée' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const q = db.get('SELECT * FROM quotes WHERE id = ?', r.data.id);
  assert.equal(q.total_ttc, 20 * 5000);
  assert.equal(q.deposit_mode, 'fixe');
  assert.equal(q.deposit_cents, 20000);
  assert.equal(q.pay_methods, '[]');
  assert.equal(db.get('SELECT postit FROM deals WHERE id = ?', r.data.deal_id).postit, 'Veut une salle privée');
  assert.equal((await call('PUT', `/api/deals/${r.data.deal_id}/postit`, { text: 'Salle privée, budget 2 000 €' })).status, 200);
  await call('POST', `/api/quotes/${q.id}/send`, {});
  const page = (await call('GET', `/s/${db.get('SELECT sign_token FROM quotes WHERE id = ?', q.id).sign_token}`, undefined, { who: 'client' })).data;
  assert.doesNotMatch(page, /Payer l'acompte</);
  // Un appel avant la signature : étape « Relance téléphonique », colonne « Relances »
  assert.equal((await call('POST', `/api/deals/${r.data.deal_id}/calls`, { outcome: 'message', note: 'rappeler jeudi' })).status, 201);
  assert.equal(db.get('SELECT stage FROM deals WHERE id = ?', r.data.deal_id).stage, 'relance_tel');
  const row = (await call('GET', '/api/deals')).data.deals.find((x) => x.id === r.data.deal_id);
  assert.equal(row.followup.calls, 1);
  assert.equal(row.postit, 'Salle privée, budget 2 000 €');
  // Numérotation qui reprend à 232
  await call('PUT', '/api/settings/quotes', { value: { ...settings.get('quotes'), number_start: 232 } });
  const r2 = await call('POST', '/api/quotes/manual', { company: 'Manuel TEST SAS', first_name: 'Léa', last_name: 'TEST', email: 'lea.test@exemple.fr', type: 'entreprise', lines: [{ product_id: productId, qty: 10 }] });
  assert.match(db.get('SELECT number FROM quotes WHERE id = ?', r2.data.id).number, /-0232$/);
});

test('1.3 : tiroir RIB, IBAN vérifié, « Acompte payé » à la main, M+3 et M+12, KPI', async () => {
  assert.equal((await call('PUT', '/api/settings/payments', { value: { rib: true, iban: 'FR76 3000 6000 0112 3456 7890 188' } })).status, 400);
  assert.equal((await call('PUT', '/api/settings/payments', { value: { rib: true, stripe: false, holder: 'Exemple TEST', iban: 'FR76 3000 6000 0112 3456 7890 189', bic: 'AGRIFRPP' } })).status, 200);
  const r = await call('POST', '/api/quotes/manual', { company: 'Rib TEST SAS', first_name: 'Max', last_name: 'TEST', email: 'max.test@exemple.fr', type: 'entreprise', event_at: '2026-12-10T18:00', lines: [{ product_id: productId, qty: 12 }] });
  const q = db.get('SELECT * FROM quotes WHERE id = ?', r.data.id);
  await call('POST', `/api/quotes/${q.id}/send`, {});
  const token = db.get('SELECT sign_token FROM quotes WHERE id = ?', q.id).sign_token;
  await call('POST', `/s/${token}/sign`, { first_name: 'Max', last_name: 'TEST', agreement: 'Bon pour accord' }, { who: 'client' });
  const page = (await call('GET', `/s/${token}`, undefined, { who: 'client' })).data;
  assert.match(page, /FR76 3000 6000 0112 3456 7890 189/);
  assert.match(page, new RegExp(q.number));
  // Le gérant a vu le virement sur sa banque : il passe le devis en « Acompte payé »
  assert.equal((await call('POST', `/api/deals/${r.data.deal_id}/stage`, { stage: 'acompte' })).status, 200);
  const p = db.get("SELECT * FROM payments WHERE quote_id = ? AND kind = 'deposit'", q.id);
  assert.equal(p.status, 'paid');
  assert.equal(p.method, 'virement');
  assert.ok(lastMail('max.test@exemple.fr', 'recu'));
  assert.equal(db.get("SELECT COUNT(*) n FROM reminders WHERE deal_id = ? AND rule = 'deposit_unpaid' AND status = 'scheduled'", r.data.deal_id).n, 0);
  // Réalisé puis Soldé : M+3 et M+12 prévus
  await call('POST', `/api/deals/${r.data.deal_id}/stage`, { stage: 'realise' });
  await call('POST', `/api/deals/${r.data.deal_id}/stage`, { stage: 'paye' });
  assert.deepEqual(db.all("SELECT template FROM reminders WHERE deal_id = ? AND rule IN ('thanks', 'one_year') ORDER BY due_at", r.data.deal_id).map((x) => x.template), ['merci', 'un_an']);
  const m3 = db.get("SELECT * FROM reminders WHERE deal_id = ? AND rule = 'thanks'", r.data.deal_id);
  await call('POST', `/api/reminders/${m3.id}/send`, {});
  assert.match(lastMail('max.test@exemple.fr', 'merci').text, /10 %/);
  // Accueil : 3 chiffres sur la période
  const dash = (await call('GET', '/api/dashboard?periode=semaine')).data;
  assert.ok(dash.deals >= 1 && dash.signed >= 1 && dash.rate >= 0);
  assert.equal(dash.pipeline, undefined);
  const csv = await call('GET', '/api/payments/export.csv');
  assert.match(csv.data, /virement/);
  await call('PUT', '/api/settings/payments', { value: { rib: false, stripe: false } });
});

test('1.3 : la plaquette vient du mail d’envoi du devis', async () => {
  const sign = require('../src/sign');
  assert.equal(sign.brochureUrl(), '');
  const t = settings.mailTemplate('devis');
  await call('PUT', '/api/settings/mails', { value: { devis: { subject: t.subject, body: t.body.replace('collez ici le lien de partage de votre plaquette (Google Drive)', 'https://drive.google.com/file/d/exemple/view') } } });
  assert.equal(sign.brochureUrl(), 'https://drive.google.com/file/d/exemple/view');
});
