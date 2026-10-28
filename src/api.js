'use strict';
// API interne du CRM (écrans connectés). Chaque route vérifie le rôle côté serveur.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const auth = require('./auth');
const mail = require('./mail');
const deals = require('./deals');
const quotes = require('./quotes');
const pricing = require('./pricing');
const payments = require('./payments');
const reminders = require('./reminders');
const calendar = require('./calendar');
const analytics = require('./analytics');
const importer = require('./importer');
const rgpd = require('./rgpd');
const stats = require('./stats');
const inbox = require('./inbox');
const google = require('./google');
const sirene = require('./sirene');
const { config } = require('./env');
const { json, send, PDF_CSP } = require('./http');
const { sha256, randomToken, money, fullName, normEmail, normPhone, isEmail, HttpError, parseLocalDateTime } = require('./util');

const area = auth.requireArea;
const admin = area('parametres');
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const cents = (euros) => (euros === '' || euros === null || euros === undefined ? null : Math.round(Number(String(euros).replace(',', '.')) * 100));

function userName(id) { return id ? db.get('SELECT name FROM users WHERE id = ?', id)?.name || '' : ''; }

function dealRow(d, follow = {}) {
  const q = db.get("SELECT * FROM quotes WHERE deal_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1", d.id);
  const paid = q ? db.get("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) s FROM payments WHERE quote_id = ? AND status IN ('paid', 'partially_refunded')", q.id).s : 0;
  const lastPaid = q ? db.get("SELECT method FROM payments WHERE quote_id = ? AND status IN ('paid', 'partially_refunded') ORDER BY paid_at DESC LIMIT 1", q.id) : null;
  return {
    followup: follow[d.id] || null, postit: d.postit || null, asso: d.type === 'association',
    quote_detail: q ? { number: q.number, sent_at: q.sent_at, signed_at: q.signed_at, viewed_at: q.viewed_at, deposit: q.deposit_cents, paid, ht: q.total_ht,
      methods: payments.quoteMethods(q), paid_method: lastPaid?.method || null, link: q.sign_token && q.status !== 'draft' ? `${config.appUrl}/s/${q.sign_token}` : null } : null,
    id: d.id, title: d.title, type: d.type, stage: d.stage, source: d.source, event_at: d.event_at, people: d.people,
    contact: fullName(d), company: d.company_name || null, assigned_to: d.assigned_to, assigned_name: d.assigned_name || null,
    quote: q ? { id: q.id, number: q.number, status: q.status, total: q.total_ttc } : null, created_at: d.created_at, updated_at: d.updated_at,
  };
}

function register(router) {
  // --- Moi et la configuration de l'écran ---
  router.get('/api/me', auth.requireUser, (req, res) => {
    const u = req.user;
    json(res, {
      user: { id: u.id, email: u.email, name: u.name, first_name: u.first_name, last_name: u.last_name },
      access: settings.AREAS,
      company: { name: settings.get('company').name }, logo: Boolean(settings.get('logo')),
      stages: settings.STAGES, roles: Object.entries(settings.ROLES).map(([k, v]) => ({ key: k, label: v.label })),
      deal_types: settings.dealTypes(), setup_done: Boolean(settings.get('setup_done')), demo: Boolean(settings.get('demo')),
      clock_offset_ms: Number(settings.get('clock_offset_ms')) || 0, now: settings.now(),
      stripe_mode: payments.stripeMode(), version: config.version, pay_methods: (({ rib, stripe }) => ({ rib, stripe }))(payments.methods()),
      deposit: (({ deposit_mode, deposit_pct, deposit_fixed_cents }) => ({ deposit_mode, deposit_pct, deposit_fixed_cents }))(settings.get('quotes')),
      sirene: Boolean(settings.get('integrations').sirene),
      users: db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name'),
      pending_actions: db.get("SELECT COUNT(*) n FROM pending_actions WHERE status = 'pending'").n,
      unread_messages: inbox.unread(), inbox_enabled: inbox.enabled(),
    });
  });

  router.get('/api/dashboard', area('accueil'), async (req, res) => {
    const p = ['semaine', 'mois'].includes(req.query.get('periode')) ? req.query.get('periode') : 'mois';
    json(res, await stats.dashboard(p, req.user));
  });

  // L'accueil en direct : rechargé toutes les 30 secondes par l'écran
  router.get('/api/dashboard/live', area('accueil'), (req, res) => json(res, { ...stats.live(), pipeline: stats.pipeline() }));

  // Fiche entreprise depuis la base Sirene (nom, SIREN ou SIRET)
  router.get('/api/sirene', area('demandes'), async (req, res) => json(res, await sirene.search(req.query.get('q'))));

  router.get('/api/search', area('demandes'), (req, res) => {
    const q = `%${(req.query.get('q') || '').trim()}%`;
    if (q.length < 4) return json(res, { deals: [], contacts: [] });
    json(res, {
      deals: db.all('SELECT d.id, d.title, d.stage, c.first_name, c.last_name FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.title LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? ORDER BY d.updated_at DESC LIMIT 10', q, q, q, q).map((d) => ({ id: d.id, title: d.title, stage: d.stage, contact: fullName(d) })),
      contacts: db.all('SELECT id, first_name, last_name, email, phone FROM contacts WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 10', q, q, q, q),
    });
  });

  // --- Demandes ---
  // Export des devis (CSV, point-virgule) : la liste telle qu'affichée
  router.get('/api/deals/export.csv', area('devis'), (req, res) => {
    const rows = db.all(`SELECT d.*, c.first_name, c.last_name, c.email, co.name company_name FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id ORDER BY d.created_at DESC`);
    const cell = (v) => { const t = String(v ?? ''); return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const eur = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
    const day = (ts) => (ts ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }).format(ts) : '');
    const out = [['Réf.', 'Client', 'Contact', 'Mail', 'Demande', 'Date de l’événement', 'Étape', 'Montant HT (€)', 'Montant TTC (€)', 'Acompte (€)', 'Encaissé (€)', 'Envoyé le', 'Signé le', 'Post-it']];
    for (const d of rows) {
      const r = dealRow(d);
      const q = r.quote_detail;
      out.push([q?.number || '', d.company_name || '', fullName(d), d.email || '', d.title, day(d.event_at), settings.stageLabel(d.stage), eur(q?.ht), eur(r.quote?.total), eur(q?.deposit), eur(q?.paid), day(q?.sent_at), day(q?.signed_at), d.postit || '']);
    }
    send(res, 200, '\ufeff' + out.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n', 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="devis.csv"', 'Cache-Control': 'no-store' });
  });

  router.get('/api/deals', area('demandes'), (req, res) => {
    const where = [], p = [];
    for (const [param, col] of [['source', 'd.source'], ['type', 'd.type'], ['stage', 'd.stage'], ['assigned', 'd.assigned_to']]) {
      const v = req.query.get(param);
      if (v) { where.push(`${col} = ?`); p.push(v); }
    }
    const q = (req.query.get('q') || '').trim();
    if (q) { where.push('(d.title LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR co.name LIKE ?)'); p.push(...Array(5).fill(`%${q}%`)); }
    if (req.query.get('contact')) { where.push('d.contact_id = ?'); p.push(Number(req.query.get('contact'))); }
    if (req.query.get('company')) { where.push('d.company_id = ?'); p.push(Number(req.query.get('company'))); }
    const rows = db.all(`SELECT d.*, c.first_name, c.last_name, c.email, co.name company_name, u.name assigned_name FROM deals d
      LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN users u ON u.id = d.assigned_to
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC LIMIT 500`, ...p);
    const follow = reminders.followup(rows.map((r) => r.id));
    const period = ['semaine', 'mois'].includes(req.query.get('periode')) ? req.query.get('periode') : 'mois';
    json(res, { deals: rows.map((r) => dealRow(r, follow)), kpis: stats.kpis(period) });
  });

  router.post('/api/deals', area('demandes'), (req, res) => {
    const b = req.body;
    const { stage, ...rest } = b; // l'étape suit le parcours, jamais imposée à la création
    void stage;
    const r = deals.createDeal({ ...rest, title: b.title ? String(b.title) : undefined, source: ['telephone', 'accueil', 'salon', 'crm', 'site'].includes(b.source) ? b.source : 'crm', assigned_to: num(b.assigned_to) || req.user.id }, req.user);
    json(res, { id: r.id }, 201);
  });

  router.get('/api/deals/:id', area('demandes'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    const c = deals.contactOf(d);
    json(res, {
      deal: { ...d, data: pricing.safeJson(d.data), assigned_name: userName(d.assigned_to) },
      contact: c, company: d.company_id ? db.get('SELECT * FROM companies WHERE id = ?', d.company_id) : null,
      product: pricing.safeJson(d.data).product_id ? db.get('SELECT id, name FROM products WHERE id = ?', Number(pricing.safeJson(d.data).product_id)) : null,
      activities: db.all('SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.deal_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200', d.id),
      tasks: db.all('SELECT t.*, u.name assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.deal_id = ? ORDER BY t.done_at IS NOT NULL, t.due_at', d.id),
      quotes: db.all('SELECT id, number, status, total_ttc, deposit_cents, sent_at, signed_at, viewed_at, sign_token FROM quotes WHERE deal_id = ? ORDER BY id DESC', d.id)
        .map(({ sign_token, ...q }) => ({ ...q, sign_url: sign_token && q.status !== 'draft' ? `${config.appUrl}/s/${sign_token}` : null })),
      payments: db.all('SELECT id, kind, label, amount_cents, refunded_cents, status, method, created_at, paid_at, pay_token FROM payments WHERE deal_id = ? ORDER BY id DESC', d.id)
        .map(({ pay_token, ...p }) => ({ ...p, link: p.status === 'pending' ? `${config.appUrl}/p/${pay_token}` : null })),
      reminders: db.all("SELECT * FROM reminders WHERE deal_id = ? AND status IN ('scheduled', 'paused', 'error') ORDER BY due_at", d.id),
      // Suivi des relances : mails (automatiques et manuels) et appels, faits et prévus
      followup: db.all("SELECT r.id, r.rule, r.channel, r.label, r.message, r.status, r.due_at, r.sent_at, r.error, u.name user_name FROM reminders r LEFT JOIN users u ON u.id = r.created_by WHERE r.deal_id = ? AND r.rule IN ('quote_unsigned', 'deposit_unpaid', 'manual', 'call_log', 'thanks', 'one_year') AND r.status != 'cancelled' ORDER BY COALESCE(r.sent_at, r.due_at)", d.id),
      pay_methods_quote: null,
      emails: db.all('SELECT id, to_addr, template, subject, status, error, created_at, updated_at FROM emails WHERE deal_id = ? ORDER BY id DESC', d.id),
      events: db.all("SELECT * FROM events WHERE deal_id = ? AND status = 'confirmed'", d.id),
    });
  });

  router.put('/api/deals/:id', area('demandes'), async (req, res) => {
    const d = deals.getDeal(req.params.id);
    const b = req.body, upd = {}, changes = [];
    if (b.title !== undefined) upd.title = String(b.title).slice(0, 200);
    if (b.type !== undefined && settings.dealTypes().some((t) => t.key === b.type)) upd.type = b.type;
    if (b.people !== undefined) upd.people = num(b.people);
    if (b.event_at !== undefined) upd.event_at = typeof b.event_at === 'number' ? b.event_at : parseLocalDateTime(b.event_at);
    if (b.message !== undefined) upd.message = String(b.message).slice(0, 5000);
    if (b.data !== undefined && typeof b.data === 'object') upd.data = JSON.stringify(b.data);
    if (b.lost_reason !== undefined) upd.lost_reason = String(b.lost_reason).slice(0, 300);
    if (b.assigned_to !== undefined && num(b.assigned_to) !== d.assigned_to) {
      upd.assigned_to = num(b.assigned_to);
      changes.push(`attribuée à ${userName(upd.assigned_to) || 'personne'}`);
    }
    upd.updated_at = settings.now();
    db.update('deals', d.id, upd);
    if (Object.keys(upd).length > 1) activity.log({ deal_id: d.id, user_id: req.user.id, kind: 'system', text: `Demande modifiée${changes.length ? ` : ${changes.join(', ')}` : ''} (${req.user.name})` });
    calendar.onDealChanged(d.id).catch(() => {});
    if (upd.event_at !== undefined && upd.event_at !== d.event_at) reminders.onEventChanged(d.id);
    json(res, { ok: true });
  });

  router.delete('/api/deals/:id', area('parametres'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    db.run('DELETE FROM deals WHERE id = ?', d.id);
    activity.log({ user_id: req.user.id, kind: 'system', text: `Demande « ${d.title} » supprimée (${req.user.name})` });
    json(res, { ok: true });
  });

  router.post('/api/deals/:id/stage', area('demandes'), async (req, res) => {
    // Tiroir RIB : passer à « Acompte payé » enregistre l'acompte reçu par virement (après vérification de la banque)
    if (req.body.stage === 'acompte') {
      const q = db.get("SELECT * FROM quotes WHERE deal_id = ? AND status = 'signed' ORDER BY signed_at DESC LIMIT 1", Number(req.params.id));
      const dep = q && q.deposit_cents > 0 ? payments.depositFor(q) : null;
      if (dep) await payments.markReceived(dep.id, { method: 'virement' }, req.user);
    }
    const d = deals.setStage(req.params.id, req.body.stage, req.user, req.body.note || '');
    if (req.body.stage === 'perdu' && req.body.note) db.update('deals', d.id, { lost_reason: String(req.body.note).slice(0, 300) });
    deals.claim(d.id, req.user);
    calendar.onDealChanged(d.id).catch(() => {});
    json(res, { ok: true, stage: d.stage });
  });

  // Post-it : la demande du client en deux mots, visible dans la liste et le Kanban
  router.put('/api/deals/:id/postit', area('demandes'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    db.update('deals', d.id, { postit: String(req.body.text || '').trim().slice(0, 500) || null, updated_at: settings.now() });
    json(res, { ok: true });
  });

  // Nouveau devis manuel : le client, les activités du catalogue, l'acompte (fixe ou %), avec ou sans lien de paiement
  router.post('/api/quotes/manual', area('devis'), (req, res) => {
    const b = req.body;
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => {
      const p = l.product_id ? db.get('SELECT * FROM products WHERE id = ?', Number(l.product_id)) : null;
      return { product_id: p?.id || null, label: String(l.label || p?.name || '').slice(0, 300), description: p?.description || '', qty: Number(l.qty) || 1, unit_cents: l.unit_cents ?? cents(l.unit) ?? p?.price_cents ?? 0, vat_rate: l.vat_rate ?? p?.vat_rate ?? settings.get('quotes').default_vat };
    }).filter((l) => l.label);
    if (!lines.length) throw new HttpError(400, 'Ajoutez au moins une activité.');
    const r = deals.createDeal({ type: b.type, first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, company: b.company, data: { societe: b.company, poste: b.role }, people: b.people, event_at: b.event_at, message: b.postit, source: ['telephone', 'accueil', 'salon', 'crm', 'site'].includes(b.source) ? b.source : 'crm', company_siret: b.company_siret, company_address: b.company_address, company_naf: b.company_naf, assigned_to: req.user.id }, req.user);
    if (b.postit) db.update('deals', r.id, { postit: String(b.postit).slice(0, 500) });
    const deposit = b.deposit_mode === 'fixe' ? { fixed: cents(b.deposit_value) || 0 } : { pct: Number(String(b.deposit_value ?? settings.get('quotes').deposit_pct).replace(',', '.')) || 0 };
    const methods = b.payment_link === false ? [] : Array.isArray(b.pay_methods) ? b.pay_methods.filter((k) => ['rib', 'stripe'].includes(k)) : null;
    const q = quotes.createQuote(r.id, req.user, lines, { deposit, payMethods: methods });
    json(res, { id: q.id, deal_id: r.id }, 201);
  });

  router.post('/api/deals/:id/note', area('demandes'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    const text = String(req.body.text || '').trim();
    if (!text) throw new HttpError(400, 'Note vide.');
    activity.log({ deal_id: d.id, user_id: req.user.id, kind: req.body.kind === 'call' ? 'call' : 'note', text: `${req.body.kind === 'call' ? 'Appel' : 'Note'} de ${req.user.name} : ${text.slice(0, 3000)}` });
    deals.claim(d.id, req.user);
    json(res, { ok: true });
  });

  // Relance téléphonique notée à la main
  router.post('/api/deals/:id/calls', area('demandes'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    json(res, reminders.logCall(d.id, { outcome: req.body.outcome, note: req.body.note, replied: req.body.replied === true }, req.user), 201);
  });

  router.post('/api/deals/:id/replied', area('demandes'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    reminders.onClientReplied(d.id, req.user);
    json(res, { ok: true });
  });

  router.post('/api/deals/:id/tasks', area('demandes'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    const title = String(req.body.title || '').trim();
    if (!title) throw new HttpError(400, 'Titre de la tâche manquant.');
    db.insert('tasks', { deal_id: d.id, title: title.slice(0, 200), due_at: parseLocalDateTime(req.body.due_at), assigned_to: num(req.body.assigned_to) || d.assigned_to || req.user.id, created_by: req.user.id, created_at: settings.now() });
    activity.log({ deal_id: d.id, user_id: req.user.id, kind: 'system', text: `Tâche ajoutée : ${title} (${req.user.name})` });
    json(res, { ok: true }, 201);
  });

  router.put('/api/tasks/:id', area('demandes'), (req, res) => {
    const t = db.get('SELECT * FROM tasks WHERE id = ?', Number(req.params.id));
    if (!t) throw new HttpError(404, 'Tâche introuvable.');
    const done = Boolean(req.body.done);
    db.update('tasks', t.id, { done_at: done ? settings.now() : null });
    if (t.deal_id && done) activity.log({ deal_id: t.deal_id, user_id: req.user.id, kind: 'system', text: `Tâche faite : ${t.title} (${req.user.name})` });
    json(res, { ok: true });
  });

  router.post('/api/deals/:id/reminders', area('relances'), (req, res) => {
    const d = deals.getDeal(req.params.id);
    json(res, reminders.manual(d.id, { message: req.body.message, channel: req.body.channel, due_at: parseLocalDateTime(req.body.due_at) }, req.user), 201);
  });
  router.post('/api/deals/:id/reminders/cut', area('relances'), (req, res) => { reminders.cut(deals.getDeal(req.params.id).id, req.user); json(res, { ok: true }); });
  router.post('/api/deals/:id/reminders/resume', area('relances'), (req, res) => { reminders.resume(deals.getDeal(req.params.id).id, req.user); json(res, { ok: true }); });

  // --- Messages (mails reçus et réponses) ---
  router.get('/api/messages', area('messages'), (req, res) => {
    const f = ['a_traiter', 'traites', 'tous'].includes(req.query.get('filtre')) ? req.query.get('filtre') : 'a_traiter';
    json(res, { threads: inbox.threads(f), counts: { a_traiter: inbox.threads('a_traiter').length }, enabled: inbox.enabled() });
  });
  router.get('/api/messages/thread/:key', area('messages'), (req, res) => json(res, inbox.thread(req.params.key, req.user)));
  router.post('/api/messages/thread/:key/reply', area('messages'), async (req, res) => json(res, await inbox.reply(req.params.key, req.body, req.user)));
  router.post('/api/messages/thread/:key/done', area('messages'), (req, res) => { inbox.setDone(req.params.key, req.body.done !== false); json(res, { ok: true }); });
  router.post('/api/messages/thread/:key/deal', area('messages'), (req, res) => json(res, { id: inbox.toDeal(req.params.key, req.user) }, 201));
  router.get('/api/messages/:id/attachments/:att', area('messages'), async (req, res) => {
    res.writeHead(302, { Location: await inbox.attachmentUrl(req.params.id, req.params.att) });
    res.end();
  });
  // Écrire au client depuis sa demande
  router.post('/api/deals/:id/message', area('messages'), async (req, res) => {
    const d = deals.getDeal(req.params.id);
    const c = deals.contactOf(d);
    if (!c?.email) throw new HttpError(400, "Le contact n'a pas d'adresse mail.");
    const text = String(req.body.text || '').trim();
    if (!text) throw new HttpError(400, 'Écrivez le message.');
    const r = await mail.send({ to: c.email, subject: String(req.body.subject || d.title).slice(0, 300), text, deal_id: d.id, contact_id: c.id, user_id: req.user.id });
    json(res, r, 201);
  });

  // --- Contacts et entreprises ---
  router.get('/api/contacts', area('contacts'), (req, res) => {
    const q = `%${(req.query.get('q') || '').trim()}%`;
    json(res, db.all(`SELECT c.*, co.name company_name, (SELECT COUNT(*) FROM deals d WHERE d.contact_id = c.id) deals
      FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR co.name LIKE ?
      ORDER BY c.last_activity_at DESC LIMIT 300`, q, q, q, q, q));
  });

  router.post('/api/contacts', area('contacts'), (req, res) => {
    const b = req.body;
    if (!b.email && !b.phone) throw new HttpError(400, 'Un mail ou un téléphone est nécessaire.');
    if (b.email && !isEmail(b.email)) throw new HttpError(400, 'Adresse mail invalide.');
    const r = deals.upsertContact({ first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, company: b.company, source: 'crm' });
    activity.log({ contact_id: r.id, user_id: req.user.id, kind: 'system', text: `Contact ${r.created ? 'créé' : 'complété (déjà existant)'} par ${req.user.name}` });
    json(res, { id: r.id, created: r.created }, 201);
  });

  router.get('/api/contacts/:id', area('contacts'), (req, res) => {
    const c = db.get('SELECT * FROM contacts WHERE id = ?', Number(req.params.id));
    if (!c) throw new HttpError(404, 'Contact introuvable.');
    json(res, {
      contact: c, company: c.company_id ? db.get('SELECT * FROM companies WHERE id = ?', c.company_id) : null,
      deals: db.all('SELECT d.*, c.first_name, c.last_name FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.contact_id = ? ORDER BY d.created_at DESC', c.id).map(dealRow),
      activities: db.all('SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.contact_id = ? ORDER BY a.created_at DESC LIMIT 100', c.id),
    });
  });

  router.put('/api/contacts/:id', area('contacts'), (req, res) => {
    const c = db.get('SELECT * FROM contacts WHERE id = ?', Number(req.params.id));
    if (!c) throw new HttpError(404, 'Contact introuvable.');
    const b = req.body, upd = { updated_at: settings.now() };
    for (const k of ['first_name', 'last_name']) if (b[k] !== undefined) upd[k] = String(b[k]).slice(0, 100);
    if (b.email !== undefined) {
      const e = normEmail(b.email);
      if (e && !isEmail(e)) throw new HttpError(400, 'Adresse mail invalide.');
      const dup = e && db.get('SELECT id FROM contacts WHERE email = ? AND id != ?', e, c.id);
      if (dup) throw new HttpError(409, `Cette adresse appartient déjà au contact n°${dup.id} : fusionnez les deux fiches.`);
      upd.email = e;
    }
    if (b.phone !== undefined) {
      const p = normPhone(b.phone);
      const dup = p && db.get('SELECT id FROM contacts WHERE phone_norm = ? AND id != ?', p, c.id);
      if (dup) throw new HttpError(409, `Ce téléphone appartient déjà au contact n°${dup.id} : fusionnez les deux fiches.`);
      upd.phone = String(b.phone).trim() || null; upd.phone_norm = p;
    }
    if (b.company !== undefined) upd.company_id = deals.upsertCompany(b.company);
    db.update('contacts', c.id, upd);
    activity.log({ contact_id: c.id, user_id: req.user.id, kind: 'system', text: `Fiche contact modifiée (${req.user.name})` });
    json(res, { ok: true });
  });

  // Fusion de doublons : tout ce qui est rattaché à « remove » passe sur « keep »
  router.post('/api/contacts/merge', area('contacts'), (req, res) => {
    const keep = db.get('SELECT * FROM contacts WHERE id = ?', Number(req.body.keep));
    const rm = db.get('SELECT * FROM contacts WHERE id = ?', Number(req.body.remove));
    if (!keep || !rm || keep.id === rm.id) throw new HttpError(400, 'Choisissez deux contacts différents.');
    db.tx(() => {
      for (const t of ['deals', 'activities', 'emails']) db.run(`UPDATE ${t} SET contact_id = ? WHERE contact_id = ?`, keep.id, rm.id);
      const upd = {};
      for (const k of ['first_name', 'last_name', 'email', 'phone', 'phone_norm', 'company_id', 'consent_at']) if (!keep[k] && rm[k]) upd[k] = rm[k];
      db.run('DELETE FROM contacts WHERE id = ?', rm.id);
      if (Object.keys(upd).length) db.update('contacts', keep.id, upd);
    });
    activity.log({ contact_id: keep.id, user_id: req.user.id, kind: 'system', text: `Fiche fusionnée avec le contact n°${rm.id} (règle : même mail ou même téléphone) par ${req.user.name}` });
    json(res, { ok: true });
  });

  router.get('/api/contacts/:id/export', area('contacts'), (req, res) => {
    const data = rgpd.exportContact(req.params.id);
    send(res, 200, JSON.stringify(data, null, 2), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="contact-${data.contact.id}.json"` });
  });
  router.delete('/api/contacts/:id', area('parametres'), (req, res) => json(res, rgpd.eraseContact(req.params.id, req.user)));

  router.get('/api/companies', area('contacts'), (req, res) => {
    const q = `%${(req.query.get('q') || '').trim()}%`;
    json(res, db.all('SELECT co.*, (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id) contacts, (SELECT COUNT(*) FROM deals d WHERE d.company_id = co.id) deals FROM companies co WHERE co.name LIKE ? ORDER BY co.name LIMIT 300', q));
  });
  router.get('/api/companies/:id', area('contacts'), (req, res) => {
    const co = db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
    if (!co) throw new HttpError(404, 'Entreprise introuvable.');
    json(res, {
      company: co, contacts: db.all('SELECT * FROM contacts WHERE company_id = ?', co.id),
      deals: db.all('SELECT d.*, c.first_name, c.last_name FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.company_id = ? ORDER BY d.created_at DESC', co.id).map(dealRow),
    });
  });
  router.put('/api/companies/:id', area('contacts'), (req, res) => {
    const co = db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
    if (!co) throw new HttpError(404, 'Entreprise introuvable.');
    const upd = { updated_at: settings.now() };
    for (const k of ['name', 'siret', 'address', 'phone', 'email', 'naf']) if (req.body[k] !== undefined) upd[k] = String(req.body[k]).slice(0, 300);
    if (upd.siret) upd.siret = upd.siret.replace(/\s/g, '');
    if (upd.siret && !/^\d{14}$/.test(upd.siret)) throw new HttpError(400, 'Le SIRET compte 14 chiffres.');
    db.update('companies', co.id, upd);
    json(res, { ok: true });
  });

  router.post('/api/import/preview', area('contacts'), (req, res) => json(res, importer.preview(req.body.filename || '', req.body.content, req.body.mapping)));
  router.post('/api/import/commit', area('contacts'), (req, res) => json(res, importer.commit(req.body.filename || '', req.body.content, req.body.mapping, req.user)));

  // --- Catalogue ---
  router.get('/api/products', area('catalogue'), (req, res) => json(res, db.all('SELECT * FROM products ORDER BY active DESC, is_option, sort, id')));
  const productInput = (b) => {
    const pricingRule = ['per_person', 'flat', 'quote'].includes(b.pricing) ? b.pricing : 'per_person';
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'Nom de la prestation manquant.');
    const price = pricingRule === 'quote' ? null : cents(b.price);
    if (pricingRule !== 'quote' && (price === null || price < 0 || Number.isNaN(price))) throw new HttpError(400, 'Prix invalide (ou choisissez « sur devis »).');
    return {
      name: name.slice(0, 200), description: String(b.description || '').slice(0, 500), pricing: pricingRule, is_option: b.is_option ? 1 : 0,
      price_cents: price, vat_rate: Number(String(b.vat_rate ?? settings.get('quotes').default_vat).replace(',', '.')) || 0,
      min_people: num(b.min_people), max_people: num(b.max_people),
      deposit_pct: b.deposit_pct === '' || b.deposit_pct === undefined || b.deposit_pct === null ? null : Math.min(100, Math.max(0, Number(String(b.deposit_pct).replace(',', '.')) || 0)),
      deal_types: [].concat(b.deal_types || []).join(','), public: b.public ? 1 : 0, example: b.example ? 1 : 0,
      active: b.active === false ? 0 : 1, sort: num(b.sort) || 0, updated_at: settings.now(),
    };
  };
  router.post('/api/products', area('parametres'), (req, res) => json(res, { id: db.insert('products', { ...productInput(req.body), created_at: settings.now() }) }, 201));
  router.put('/api/products/:id', area('parametres'), (req, res) => {
    if (!db.get('SELECT 1 FROM products WHERE id = ?', Number(req.params.id))) throw new HttpError(404, 'Prestation introuvable.');
    db.update('products', Number(req.params.id), productInput(req.body));
    json(res, { ok: true });
  });

  // --- Devis ---
  router.post('/api/deals/:id/quotes', area('devis'), (req, res) => json(res, quotes.createQuote(req.params.id, req.user), 201));
  router.get('/api/quotes', area('devis'), (req, res) => {
    const st = req.query.get('status');
    const rows = db.all(`SELECT q.id, q.number, q.status, q.total_ttc, q.deposit_cents, q.sent_at, q.signed_at, q.viewed_at, q.created_at, q.deal_id, d.title, c.first_name, c.last_name
      FROM quotes q JOIN deals d ON d.id = q.deal_id LEFT JOIN contacts c ON c.id = d.contact_id ${st ? 'WHERE q.status = ?' : ''} ORDER BY q.id DESC LIMIT 300`, ...(st ? [st] : []));
    // Colonne « Relances » : mails partis, appels notés, prochaine relance
    const follow = reminders.followup(rows.map((q) => q.deal_id));
    json(res, rows.map((q) => ({ ...q, contact: fullName(q), followup: follow[q.deal_id] || null })));
  });
  router.get('/api/quotes/:id', area('devis'), (req, res) => {
    const q = quotes.getQuote(req.params.id);
    const d = deals.getDeal(q.deal_id);
    const { sign_code_hash, ...rest } = q;
    json(res, {
      quote: { ...rest, lines: JSON.parse(q.lines), sign_url: q.sign_token && q.status !== 'draft' ? `${config.appUrl}/s/${q.sign_token}` : null },
      deal: { ...d, data: pricing.safeJson(d.data) }, contact: deals.contactOf(d),
      products: db.all('SELECT * FROM products WHERE active = 1 ORDER BY is_option, sort, id'),
      balance: payments.quoteBalance(q),
      pay_methods: payments.quoteMethods(q),
    });
  });
  router.put('/api/quotes/:id', area('devis'), (req, res) => {
    const lines = Array.isArray(req.body.lines) ? req.body.lines.map((l) => ({ ...l, unit_cents: l.unit_cents ?? cents(l.unit) })) : undefined;
    json(res, quotes.updateQuote(req.params.id, { ...req.body, lines }, req.user));
  });
  router.get('/api/quotes/:id/pdf', area('devis'), (req, res) => {
    const q = quotes.getQuote(req.params.id);
    send(res, 200, quotes.pdfFor(q), 'application/pdf', { 'Content-Disposition': `inline; filename="Devis ${q.number}.pdf"`, 'Cache-Control': 'no-store', 'Content-Security-Policy': PDF_CSP });
  });
  router.post('/api/quotes/:id/send', area('devis'), async (req, res) => {
    const r = await quotes.sendQuote(req.params.id, req.user, req.body.mode === 'demande_signature' ? 'demande_signature' : 'devis');
    json(res, { ok: true, mail: r.mail.status, link: r.link });
  });
  router.post('/api/quotes/:id/cancel', area('devis'), (req, res) => {
    const q = quotes.getQuote(req.params.id);
    if (q.status === 'signed') throw new HttpError(409, 'Un devis signé ne peut pas être annulé ici.');
    db.update('quotes', q.id, { status: 'cancelled', sign_token: null, updated_at: settings.now() });
    db.run("UPDATE reminders SET status = 'cancelled', error = 'devis annulé' WHERE quote_id = ? AND status IN ('scheduled', 'paused')", q.id);
    activity.log({ deal_id: q.deal_id, user_id: req.user.id, kind: 'quote', text: `Devis ${q.number} annulé (${req.user.name})` });
    json(res, { ok: true });
  });

  // --- Paiements ---
  router.get('/api/payments', area('paiements'), (req, res) => {
    const st = req.query.get('status');
    const month = stats.range('mois').from;
    const rows = db.all(`SELECT p.*, d.title, c.first_name, c.last_name, co.name company_name, q.number quote_number FROM payments p
      LEFT JOIN deals d ON d.id = p.deal_id LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN quotes q ON q.id = p.quote_id
      ${st ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 300`, ...(st ? [st] : []));
    json(res, {
      payments: rows.map(({ pay_token, ...p }) => ({ ...p, client: p.company_name || fullName(p) || p.title || '—', link: ['pending', 'failed'].includes(p.status) ? `${config.appUrl}/p/${pay_token}` : null })),
      kpis: {
        cashed_month: db.get("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) s FROM payments WHERE status IN ('paid', 'partially_refunded', 'refunded') AND paid_at >= ?", month).s,
        pending_deposits: db.get("SELECT COALESCE(SUM(amount_cents), 0) s FROM payments WHERE status = 'pending' AND kind = 'deposit'").s,
        count_paid: db.get("SELECT COUNT(*) n FROM payments WHERE status IN ('paid', 'partially_refunded', 'refunded')").n,
      },
      stripe_mode: payments.stripeMode(), deposit_pct: settings.get('quotes').deposit_pct,
      methods: { card: payments.methods().card, transfer: payments.methods().transfer, webhook: Boolean(config.stripe.webhookSecret) },
    });
  });

  // Export comptable (CSV, séparateur point-virgule, lisible par Excel et importable dans Pennylane ou un tableur)
  router.get('/api/payments/export.csv', area('paiements'), (req, res) => {
    send(res, 200, payments.exportCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="paiements.csv"', 'Cache-Control': 'no-store' });
  });

  // Virement reçu, espèces, chèque : noté à la main
  router.post('/api/payments/:id/received', area('paiements'), async (req, res) => {
    json(res, await payments.markReceived(req.params.id, { method: req.body.method, amount_cents: cents(req.body.amount), paid_at: parseLocalDateTime(req.body.paid_at) }, req.user));
  });

  router.post('/api/payments', area('paiements'), async (req, res) => {
    const b = req.body;
    const d = b.deal_id ? deals.getDeal(b.deal_id) : null;
    let p;
    if (b.kind === 'balance') {
      const q = db.get("SELECT * FROM quotes WHERE deal_id = ? AND status = 'signed' ORDER BY signed_at DESC LIMIT 1", d?.id);
      if (!q) throw new HttpError(400, "Le solde se demande sur un devis signé.");
      const { remaining } = payments.quoteBalance(q);
      if (remaining < 50) throw new HttpError(400, 'Il ne reste rien à payer sur ce devis.');
      // Le solde remplace un acompte resté en attente
      db.run("UPDATE payments SET status = 'cancelled' WHERE quote_id = ? AND kind = 'deposit' AND status = 'pending'", q.id);
      p = payments.createPayment({ deal_id: d.id, quote_id: q.id, kind: 'balance', amount_cents: remaining, label: `solde · devis ${q.number}`, user: req.user });
    } else if (b.kind === 'deposit') {
      const q = db.get("SELECT * FROM quotes WHERE deal_id = ? AND status IN ('sent', 'signed') ORDER BY id DESC LIMIT 1", d?.id);
      if (!q) throw new HttpError(400, 'Aucun devis envoyé pour cette demande.');
      p = payments.depositFor(q);
      if (!p) throw new HttpError(400, "L'acompte est déjà réglé.");
    } else {
      p = payments.createPayment({ deal_id: d?.id || null, kind: 'free', amount_cents: cents(b.amount), label: String(b.label || 'paiement libre').slice(0, 120), user: req.user });
    }
    if (b.send && d) await payments.sendPaymentLink(p, req.user);
    json(res, { id: p.id, link: payments.payLink(p) }, 201);
  });

  router.post('/api/payments/test', area('parametres'), (req, res) => {
    if (payments.stripeMode() !== 'test') throw new HttpError(400, 'Le bouton « Tester » ne fonctionne qu’en mode test.');
    const p = payments.createPayment({ kind: 'test', amount_cents: 100, label: 'test du branchement Stripe', user: req.user });
    json(res, { link: payments.payLink(p) });
  });
  router.post('/api/payments/:id/send', area('paiements'), async (req, res) => json(res, await payments.sendPaymentLink(payments.getPayment(req.params.id), req.user)));
  router.post('/api/payments/:id/refund', area('paiements'), async (req, res) => {
    if (req.body.confirm !== true) throw new HttpError(400, 'Confirmation requise.');
    json(res, await payments.refund(req.params.id, cents(req.body.amount), req.user));
  });

  // --- Relances ---
  router.get('/api/reminders', area('relances'), (req, res) => {
    const tab = req.query.get('tab') || 'a_venir';
    const st = { a_venir: "r.status IN ('scheduled', 'error')", envoyees: "r.status = 'sent'", pause: "r.status = 'paused'" }[tab] || "r.status = 'scheduled'";
    const rows = db.all(`SELECT r.*, d.title, d.stage, c.first_name, c.last_name, co.name company_name, q.number quote_number, q.total_ttc FROM reminders r
      JOIN deals d ON d.id = r.deal_id LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN quotes q ON q.id = r.quote_id
      WHERE ${st} ORDER BY ${tab === 'envoyees' ? 'r.sent_at DESC' : 'r.due_at'} LIMIT 300`);
    const counts = Object.fromEntries(db.all("SELECT status, COUNT(*) n FROM reminders GROUP BY status").map((r) => [r.status, r.n]));
    json(res, {
      reminders: rows.map((r) => ({ ...r, client: r.company_name || fullName(r) || r.title })),
      counts: { a_venir: (counts.scheduled || 0) + (counts.error || 0), envoyees: counts.sent || 0, pause: counts.paused || 0 },
      rules: settings.get('reminders'), now: settings.now(), clock_offset_ms: Number(settings.get('clock_offset_ms')) || 0,
    });
  });
  router.post('/api/reminders/:id/send', area('relances'), async (req, res) => json(res, await reminders.sendNow(req.params.id, req.user)));
  router.post('/api/reminders/:id/postpone', area('relances'), (req, res) => json(res, reminders.postpone(req.params.id, parseLocalDateTime(req.body.until), req.user)));

  // Horloge de test (administrateur) : avance le temps du CRM pour voir partir les relances
  router.post('/api/clock', admin, async (req, res) => {
    // En production, seulement en mode démonstration : avancer le temps envoie de vraies relances
    if (!req.body.reset && config.production && !settings.get('demo')) throw new HttpError(403, "L'horloge de test ne fonctionne qu'avec les données d'exemple (Paramètres › Intégrations › badge « Données d'exemple »).");
    const days = Number(req.body.days);
    const offset = req.body.reset ? 0 : (Number(settings.get('clock_offset_ms')) || 0) + days * 86400e3;
    if (!req.body.reset && !(days > 0 && days <= 60)) throw new HttpError(400, 'Avancez de 1 à 60 jours.');
    if (offset > 365 * 86400e3) throw new HttpError(400, "L'horloge de test ne peut pas avancer de plus d'un an : remettez-la à l'heure.");
    settings.set('clock_offset_ms', offset);
    activity.log({ user_id: req.user.id, kind: 'system', text: req.body.reset ? `Horloge de test remise à l'heure (${req.user.name})` : `Horloge de test avancée de ${days} jour(s) (${req.user.name})` });
    await reminders.tick();
    json(res, { clock_offset_ms: offset, now: settings.now() });
  });

  // --- Agenda ---
  router.get('/api/events', area('agenda'), (req, res) => {
    const from = Number(req.query.get('from')) || settings.now() - 7 * 86400e3;
    const to = Number(req.query.get('to')) || from + 42 * 86400e3;
    json(res, {
      events: db.all("SELECT e.*, d.stage, d.type FROM events e LEFT JOIN deals d ON d.id = e.deal_id WHERE e.status = 'confirmed' AND e.start_at < ? AND e.end_at > ? ORDER BY e.start_at", to, from),
      google: { enabled: calendar.enabled() },
    });
  });
  router.post('/api/events', area('agenda'), async (req, res) => {
    const start = parseLocalDateTime(req.body.start_at);
    if (!start || !String(req.body.title || '').trim()) throw new HttpError(400, 'Titre et date nécessaires.');
    const now = settings.now();
    const dur = (Number(req.body.duration_min) || settings.get('integrations').event_duration_min || 120) * 60e3;
    const id = db.insert('events', { deal_id: num(req.body.deal_id), title: String(req.body.title).slice(0, 200), start_at: start, end_at: start + dur, people: num(req.body.people), notes: String(req.body.notes || '').slice(0, 1000), status: 'confirmed', created_at: now, updated_at: now });
    if (calendar.enabled()) await calendar.sync(id).catch((e) => console.error('Agenda :', e.message));
    json(res, { id }, 201);
  });
  router.put('/api/events/:id', area('agenda'), async (req, res) => {
    const e = db.get('SELECT * FROM events WHERE id = ?', Number(req.params.id));
    if (!e) throw new HttpError(404, 'Événement introuvable.');
    const upd = { updated_at: settings.now() };
    if (req.body.cancel) upd.status = 'cancelled';
    if (req.body.title) upd.title = String(req.body.title).slice(0, 200);
    if (req.body.start_at) { const s = parseLocalDateTime(req.body.start_at); upd.start_at = s; upd.end_at = s + (e.end_at - e.start_at); }
    db.update('events', e.id, upd);
    if (calendar.enabled()) await calendar.sync(e.id).catch((err) => console.error('Agenda :', err.message));
    json(res, { ok: true });
  });
  router.post('/api/events/:id/sync', area('agenda'), async (req, res) => {
    await calendar.sync(Number(req.params.id));
    json(res, { ok: true });
  });

  // --- Équipe : prénom, nom, mail, mot de passe choisi par le gérant ; tout le monde a tous les droits ---
  router.get('/api/users', area('equipe'), (req, res) => json(res, db.all('SELECT id, email, name, first_name, last_name, active, created_at, last_login_at, last_login_method, password_hash IS NOT NULL has_password FROM users ORDER BY active DESC, name')));
  router.post('/api/users', area('equipe'), (req, res) => {
    const email = normEmail(req.body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Adresse mail invalide.');
    const first = String(req.body.first_name || '').trim().slice(0, 60), last = String(req.body.last_name || '').trim().slice(0, 60);
    if (!first) throw new HttpError(400, 'Indiquez le prénom.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'Cette adresse a déjà un compte.');
    const pw = auth.validPassword(req.body.password);
    const id = db.insert('users', { email, first_name: first, last_name: last, name: `${first} ${last}`.trim(), role: 'gerant', password_hash: auth.hashPassword(pw), invited_by: req.user.id, created_at: settings.now() });
    activity.log({ user_id: req.user.id, kind: 'system', text: `Compte créé pour ${first} ${last} (${email}) par ${req.user.name}` });
    json(res, { id }, 201);
  });
  router.put('/api/users/:id', area('equipe'), (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) throw new HttpError(404, 'Compte introuvable.');
    const upd = {};
    if (req.body.active !== undefined) upd.active = req.body.active ? 1 : 0;
    if (req.body.first_name !== undefined) upd.first_name = String(req.body.first_name).trim().slice(0, 60);
    if (req.body.last_name !== undefined) upd.last_name = String(req.body.last_name).trim().slice(0, 60);
    if (upd.first_name !== undefined || upd.last_name !== undefined) upd.name = `${upd.first_name ?? u.first_name} ${upd.last_name ?? u.last_name}`.trim() || u.name;
    if (req.body.email !== undefined) {
      const e = normEmail(req.body.email);
      if (!isEmail(e)) throw new HttpError(400, 'Adresse mail invalide.');
      if (e !== u.email && db.get('SELECT 1 FROM users WHERE email = ?', e)) throw new HttpError(409, 'Cette adresse a déjà un compte.');
      upd.email = e;
    }
    if (req.body.password) upd.password_hash = auth.hashPassword(auth.validPassword(req.body.password));
    if (upd.active === 0 && !db.get('SELECT 1 FROM users WHERE active = 1 AND id != ?', u.id)) throw new HttpError(400, 'Il faut garder au moins un compte actif.');
    db.update('users', u.id, upd);
    if (upd.active === 0 || (upd.password_hash && u.id !== req.user.id)) auth.closeSessions(u.id);
    else if (upd.password_hash) auth.closeSessions(u.id, req);
    activity.log({ user_id: req.user.id, kind: 'system', text: `Compte ${u.email} modifié${upd.active === 0 ? ' (désactivé)' : upd.active === 1 ? ' (réactivé)' : ''}${upd.password_hash ? ' · mot de passe changé' : ''} par ${req.user.name}` });
    json(res, { ok: true });
  });

  // --- Paramètres ---
  const EDITABLE = ['company', 'colors', 'fonts', 'access', 'quotes', 'reminders', 'mails', 'deal_types', 'integrations', 'rgpd', 'demo', 'payments'];
  router.get('/api/settings', admin, (req, res) => {
    const out = {};
    for (const k of EDITABLE) out[k] = settings.get(k);
    out.logo = settings.get('logo');
    out.mail_templates = Object.fromEntries(Object.keys(settings.MAIL_TEMPLATES).map((k) => [k, settings.mailTemplate(k)]));
    out.app_url = config.appUrl;
    out.service_account = google.email();
    out.site_api = Boolean(config.siteApiKey);
    out.stripe_mode = payments.stripeMode();
    out.stripe_webhook = Boolean(config.stripe.webhookSecret);
    out.contact_photo = Boolean(settings.get('contact_photo'));
    out.google_ready = Boolean(config.google.clientId);
    json(res, out);
  });
  router.put('/api/settings/:key', admin, (req, res) => {
    const key = req.params.key;
    if (!EDITABLE.includes(key)) throw new HttpError(400, 'Paramètre inconnu.');
    let v = req.body.value;
    if (key === 'colors') {
      const issues = settings.checkColors(v || {});
      if (issues.some((i) => !i.suggestion)) return json(res, { ok: false, issues }, 422); // format invalide : jamais forcé
      if (issues.length && !req.body.force) return json(res, { ok: false, issues }, 422);
      v = Object.fromEntries(['primary', 'secondary', 'accent', 'background', 'card', 'text'].map((k) => [k, v[k]]));
      v = Object.fromEntries(Object.entries(v).map(([k, c]) => [k, String(c).toUpperCase()]));
    }
    if (key === 'quotes') {
      v = { ...v, number_prefix: String(v.number_prefix || 'D').replace(/[^A-Za-z0-9-]/g, '').slice(0, 10) || 'D', number_start: Math.max(1, Math.min(999999, parseInt(v.number_start, 10) || 1)),
        deposit_mode: v.deposit_mode === 'fixe' ? 'fixe' : 'pct', deposit_pct: Math.min(100, Math.max(0, Number(v.deposit_pct) || 0)), deposit_fixed_cents: Math.max(0, Math.round(Number(v.deposit_fixed_cents) || 0)) };
      delete v.brochure_url;
    }
    if (key === 'payments') {
      v = { rib: Boolean(v.rib), stripe: Boolean(v.stripe), stripe_transfer: v.stripe_transfer !== false, pennylane: false, holder: String(v.holder || '').trim().slice(0, 120), iban: String(v.iban || '').replace(/\s/g, '').toUpperCase().slice(0, 34), bic: String(v.bic || '').replace(/\s/g, '').toUpperCase().slice(0, 11), transfer_note: String(v.transfer_note || '').slice(0, 300) };
      if (v.iban && !payments.validIban(v.iban)) throw new HttpError(400, 'IBAN invalide : vérifiez les chiffres (clé de contrôle incorrecte).');
      if (v.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.bic)) throw new HttpError(400, 'BIC invalide (8 ou 11 caractères).');
      if (v.rib && !v.iban) throw new HttpError(400, "Renseignez l'IBAN pour proposer le virement classique.");
    }

    if (key === 'access') v = { ...v, allowed_domain: String(v.allowed_domain || '').trim().toLowerCase().replace(/^@/, ''), google: Boolean(v.google) };
    if (key === 'access' && v.allowed_domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v.allowed_domain)) throw new HttpError(400, 'Domaine invalide (ex. mon-entreprise.fr).');
    if (key === 'mails') v = Object.fromEntries(Object.entries(v || {}).filter(([k]) => settings.MAIL_TEMPLATES[k]).map(([k, t]) => [k, { subject: String(t.subject || '').slice(0, 200), body: String(t.body || '').slice(0, 5000) }]));
    if (key === 'deal_types' && (!Array.isArray(v) || !v.length || v.some((t) => !t.key || !t.label))) throw new HttpError(400, 'Chaque type a besoin d’une clé et d’un nom.');
    settings.set(key, v);
    activity.log({ user_id: req.user.id, kind: 'system', text: `Paramètres « ${key} » modifiés par ${req.user.name}` });
    json(res, { ok: true });
  });
  router.post('/api/settings/colors/check', admin, (req, res) => json(res, { issues: settings.checkColors(req.body || {}) }));
  // La photo du contact, affichée sur la page de validation du devis
  router.post('/api/settings/photo', admin, (req, res) => {
    const buf = Buffer.from(String(req.body.content || ''), 'base64');
    const isPng = buf.slice(0, 4).toString('hex') === '89504e47', isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) throw new HttpError(400, 'La photo doit être une image PNG ou JPEG.');
    if (buf.length > 2e6) throw new HttpError(400, 'Photo trop lourde (2 Mo maximum).');
    const dir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `contact-${Date.now()}.${isPng ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(dir, name), buf);
    const old = settings.get('contact_photo');
    if (old) fs.rmSync(path.join(dir, path.basename(old)), { force: true });
    settings.set('contact_photo', name);
    json(res, { ok: true });
  });
  router.post('/api/settings/logo', admin, (req, res) => {
    const buf = Buffer.from(String(req.body.content || ''), 'base64');
    const isPng = buf.slice(0, 4).toString('hex') === '89504e47', isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) throw new HttpError(400, 'Le logo doit être une image PNG ou JPEG.');
    if (buf.length > 2e6) throw new HttpError(400, 'Logo trop lourd (2 Mo maximum).');
    const dir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `logo-${Date.now()}.${isPng ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(dir, name), buf);
    const old = settings.get('logo');
    settings.set('logo', name);
    if (old && old !== name) fs.rmSync(path.join(dir, path.basename(old)), { force: true });
    json(res, { ok: true, logo: name });
  });

  // État des intégrations : jamais les clés elles-mêmes
  router.get('/api/integrations', admin, async (req, res) => {
    const [stripe, ga, cal] = await Promise.all([payments.status(), analytics.status(), require('./calendar').status()]);
    json(res, {
      google: { ok: Boolean(config.google.clientId && config.google.clientSecret), label: config.google.clientId ? 'active' : 'non branchée (code par mail seulement)' },
      stripe: { ok: stripe.connected, label: stripe.label + (stripe.connected && !stripe.webhook ? ' · webhook à créer' : ''), mode: stripe.mode, error: stripe.error },
      resend: { ok: mail.enabled() && Boolean(config.resend.webhookSecret), label: mail.enabled() ? (config.resend.webhookSecret ? 'branché, statuts reçus' : 'branché · webhook à créer') : 'non branché (mails simulés)' },
      inbox: { ok: Boolean(config.resend.inbound), label: config.resend.inbound ? `réception sur ${config.resend.inbound}` : 'réception non branchée (MAIL_INBOUND)' },
      analytics: ga, calendar: cal,
      turnstile: { ok: Boolean(config.turnstile.siteKey && config.turnstile.secret), label: config.turnstile.secret ? 'actif' : 'non branché (case invisible et limite par minute seulement)' },
      site: { ok: Boolean(settings.get('integrations').site_url), label: settings.get('integrations').site_url || 'adresse du site à renseigner' },
      urls: {
        google_redirect: `${config.appUrl}/auth/google/callback`, stripe_webhook: `${config.appUrl}/api/stripe/webhook`,
        resend_webhook: `${config.appUrl}/api/resend/webhook`, embed: `${config.appUrl}/embed.js`, mcp: `${config.appUrl}/mcp/<votre-jeton>`,
      },
      service_account: google.email(),
    });
  });

  // Assistant de démarrage : nom, logo, couleurs, domaine, prix
  router.post('/api/setup/done', admin, (req, res) => {
    settings.set('setup_done', true);
    activity.log({ user_id: req.user.id, kind: 'system', text: `Assistant de démarrage terminé par ${req.user.name}` });
    json(res, { ok: true });
  });

  // --- Jetons MCP (un par personne) ---
  router.get('/api/tokens', auth.requireUser, (req, res) => json(res, db.all('SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ?', req.user.id)));
  router.post('/api/tokens', auth.requireUser, (req, res) => {
    const token = 'crm_' + randomToken(32);
    db.insert('api_tokens', { user_id: req.user.id, token_hash: sha256(token), label: String(req.body.label || 'Claude').slice(0, 60), created_at: Date.now() });
    activity.log({ user_id: req.user.id, kind: 'system', text: `Jeton MCP créé par ${req.user.name}` });
    json(res, { token, url: `${config.appUrl}/mcp/${token}` }, 201);
  });
  router.delete('/api/tokens/:id', auth.requireUser, (req, res) => {
    db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    json(res, { ok: true });
  });

  // --- Actions demandées depuis Claude (MCP), à confirmer ---
  router.get('/api/pending', area('demandes'), (req, res) => json(res, db.all("SELECT p.*, u.name user_name FROM pending_actions p LEFT JOIN users u ON u.id = p.user_id WHERE p.status = 'pending' ORDER BY p.id DESC")));
  router.post('/api/pending/:id/:decision', area('demandes'), async (req, res) => {
    const a = db.get("SELECT * FROM pending_actions WHERE id = ? AND status = 'pending'", Number(req.params.id));
    if (!a) throw new HttpError(404, 'Action introuvable ou déjà traitée.');
    if (req.params.decision === 'refuser') {
      db.update('pending_actions', a.id, { status: 'refused', decided_at: Date.now(), decided_by: req.user.id });
      return json(res, { ok: true });
    }
    if (req.params.decision !== 'confirmer') throw new HttpError(400, 'Décision inconnue.');
    const p = JSON.parse(a.payload);
    let result;
    try {
      if (a.kind === 'send_quote') { if (!auth.can(req.user, 'devis')) throw new HttpError(403, 'Rôle insuffisant.'); result = (await quotes.sendQuote(p.devis_id, req.user, 'devis')).mail.status; }
      else if (a.kind === 'refund') { if (!auth.can(req.user, 'paiements')) throw new HttpError(403, 'Rôle insuffisant.'); result = (await payments.refund(p.paiement_id, p.montant_centimes, req.user)).status; }
      else if (a.kind === 'delete_deal') { if (!auth.can(req.user, 'parametres')) throw new HttpError(403, 'Seul le gérant peut supprimer.'); const d = deals.getDeal(p.demande_id); db.run('DELETE FROM deals WHERE id = ?', d.id); result = 'supprimée'; }
      db.update('pending_actions', a.id, { status: 'done', result: String(result), decided_at: Date.now(), decided_by: req.user.id });
      json(res, { ok: true, result });
    } catch (e) {
      if (e.status === 403) throw e;
      db.update('pending_actions', a.id, { status: 'error', result: e.message, decided_at: Date.now(), decided_by: req.user.id });
      throw e;
    }
  });

  // --- RGPD ---
  router.get('/api/rgpd/stale', admin, (req, res) => json(res, rgpd.staleContacts()));
  router.post('/api/rgpd/purge', admin, (req, res) => json(res, { purged: rgpd.purge() }));

  // Les chiffres de chaque mail automatique : envoyés ce mois-ci, ouverts
  router.get('/api/mails/stats', area('relances'), (req, res) => {
    const month = stats.range('mois').from;
    const out = {};
    for (const k of settings.AUTO_MAILS) {
      const r = db.get("SELECT COUNT(*) n, SUM(CASE WHEN status IN ('opened', 'clicked') THEN 1 ELSE 0 END) o FROM emails WHERE template = ? AND created_at >= ?", k, month);
      out[k] = { month: r.n, opened: r.n ? Math.round(((r.o || 0) / r.n) * 100) : null };
    }
    json(res, out);
  });

  // Test d'envoi de mail depuis les paramètres
  router.post('/api/mails/test', admin, async (req, res) => {
    const key = settings.MAIL_TEMPLATES[req.body.template] ? req.body.template : 'devis';
    const r = await mail.send({ to: req.user.email, template: key, vars: { prenom: req.user.name.split(' ')[0], numero: 'D-TEST-0001', montant: money(50000), code: '123456', lien: config.appUrl, titre: 'Demande TEST', client: 'Client TEST', libelle: 'acompte', validite: '—', date: '—', acompte: money(15000), societe: 'Entreprise TEST', resume: 'Exemple de résumé', source: 'test', message: 'Message de test.' } });
    json(res, r);
  });
  router.get('/api/mails/preview/:template', admin, (req, res) => {
    const r = mail.render(req.params.template, { prenom: 'Camille', numero: 'D-2026-0001', montant: money(50000), code: '123456', lien: `${config.appUrl}/s/exemple`, titre: 'Anniversaire · 12 enfants', client: 'Camille TEST', libelle: 'acompte 30 %', validite: '30/11/2026', date: 'jeudi 4 décembre, 18 h', acompte: money(15000), societe: 'Entreprise TEST', resume: 'Contact : Camille TEST', source: 'site', message: 'Votre message.' });
    send(res, 200, r.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" });
  });
}

module.exports = { register };
