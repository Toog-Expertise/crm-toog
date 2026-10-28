'use strict';
// Serveur MCP (HTTP, JSON-RPC) protégé par un jeton personnel par utilisateur.
// Adresse pour Claude : https://crm…/mcp/<jeton>  (ou en-tête Authorization: Bearer <jeton>).
// Lecture libre selon le rôle ; les actions sensibles créent une demande à confirmer dans le CRM.
const db = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const quotes = require('./quotes');
const reminders = require('./reminders');
const stats = require('./stats');
const { config } = require('./env');
const { sha256, money, dateTime, fullName, HttpError } = require('./util');
const { json, send } = require('./http');

const PROTOCOL = '2025-06-18';

const TOOLS = [
  { name: 'lister_demandes', area: 'demandes', description: 'Liste les demandes (opportunités) du CRM, filtrables par étape et par recherche.', inputSchema: { type: 'object', properties: { etape: { type: 'string', description: 'nouvelle, a_rappeler, devis_envoye, signature, signe, acompte, paye, perdu' }, recherche: { type: 'string' }, limite: { type: 'integer', default: 30 } } } },
  { name: 'voir_demande', area: 'demandes', description: "Détail d'une demande : contact, champs, devis, paiements, relances et historique.", inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'lister_devis', area: 'devis', description: 'Liste les devis, filtrables par statut (draft, sent, signed, cancelled) et par période.', inputSchema: { type: 'object', properties: { statut: { type: 'string' }, depuis: { type: 'string', description: 'date AAAA-MM-JJ' } } } },
  { name: 'lister_paiements', area: 'paiements', description: 'Liste les paiements (pending, paid, refunded…).', inputSchema: { type: 'object', properties: { statut: { type: 'string' } } } },
  { name: 'lister_messages', area: 'messages', description: 'Liste les conversations avec les clients (mails reçus) : à traiter par défaut, avec le dernier message et la demande liée.', inputSchema: { type: 'object', properties: { filtre: { type: 'string', enum: ['a_traiter', 'traites', 'tous'], default: 'a_traiter' } } } },
  { name: 'chiffres', area: 'accueil', description: 'Chiffres du tableau de bord : demandes reçues, devis envoyés et signés, taux de signature, chiffre d’affaires signé (cette semaine ou ce mois-ci).', inputSchema: { type: 'object', properties: { periode: { type: 'string', enum: ['semaine', 'mois'], default: 'semaine' } } } },
  { name: 'preparer_devis', area: 'devis', description: "Prépare un devis en brouillon pour une demande (lignes du catalogue proposées automatiquement si non fournies). Le devis n'est pas envoyé.", inputSchema: { type: 'object', properties: { demande_id: { type: 'integer' }, lignes: { type: 'array', items: { type: 'object', properties: { libelle: { type: 'string' }, quantite: { type: 'number' }, prix_unitaire_ttc_centimes: { type: 'integer' }, tva: { type: 'number' } } } } }, required: ['demande_id'] } },
  { name: 'preparer_relance', area: 'relances', description: 'Prépare une relance manuelle par mail pour une demande, à une date donnée. Elle reste en pause : une personne la réactive dans le CRM pour qu’elle parte.', inputSchema: { type: 'object', properties: { demande_id: { type: 'integer' }, message: { type: 'string' }, date: { type: 'string', description: 'AAAA-MM-JJTHH:MM (heure de Paris)' } }, required: ['demande_id', 'message'] } },
  { name: 'demander_action', area: 'demandes', description: 'Demande une action sensible (envoyer un devis, rembourser, supprimer une demande). Elle devra être confirmée par une personne dans le CRM (tableau de bord › À confirmer).', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['envoyer_devis', 'rembourser', 'supprimer_demande'] }, devis_id: { type: 'integer' }, paiement_id: { type: 'integer' }, demande_id: { type: 'integer' }, montant_centimes: { type: 'integer' } }, required: ['action'] } },
];

const userFromToken = (req, pathToken) => auth.userFromToken(req, pathToken);

const out = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });

function dealSummary(d) {
  const c = d.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', d.contact_id) : null;
  const q = db.get("SELECT number, status, total_ttc FROM quotes WHERE deal_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1", d.id);
  return { id: d.id, titre: d.title, type: settings.dealTypeLabel(d.type), etape: settings.stageLabel(d.stage), client: fullName(c), mail: c?.email, telephone: c?.phone, date_venue: d.event_at ? dateTime(d.event_at) : null, personnes: d.people, source: d.source, devis: q ? `${q.number} · ${money(q.total_ttc)} · ${q.status}` : null, lien: `${config.appUrl}/#/demandes/${d.id}` };
}

async function callTool(name, args, user) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new HttpError(400, `Outil inconnu : ${name}`);
  if (!auth.can(user, tool.area)) throw new HttpError(403, "Votre rôle ne donne pas accès à cette partie du CRM.");
  switch (name) {
    case 'lister_demandes': {
      const where = [], p = [];
      if (args.etape) { where.push('d.stage = ?'); p.push(args.etape); }
      if (args.recherche) { where.push("(d.title LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)"); p.push(...Array(4).fill(`%${args.recherche}%`)); }
      const rows = db.all(`SELECT d.* FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC LIMIT ?`, ...p, Math.min(100, Math.max(1, Number(args.limite) || 30)));
      return out(rows.map(dealSummary));
    }
    case 'voir_demande': {
      const d = db.get('SELECT * FROM deals WHERE id = ?', Number(args.id));
      if (!d) throw new HttpError(404, 'Demande introuvable.');
      return out({
        ...dealSummary(d), champs: JSON.parse(d.data || '{}'), message: d.message,
        devis: db.all('SELECT id, number, status, total_ttc, deposit_cents, sent_at, signed_at FROM quotes WHERE deal_id = ?', d.id).map((q) => ({ ...q, total: money(q.total_ttc), acompte: money(q.deposit_cents) })),
        paiements: db.all('SELECT id, label, amount_cents, status, paid_at FROM payments WHERE deal_id = ?', d.id).map((x) => ({ ...x, montant: money(x.amount_cents) })),
        relances: db.all("SELECT id, label, status, due_at FROM reminders WHERE deal_id = ? AND status IN ('scheduled', 'paused')", d.id).map((r) => ({ ...r, prevue: dateTime(r.due_at) })),
        historique: db.all('SELECT text, created_at FROM activities WHERE deal_id = ? ORDER BY created_at DESC LIMIT 30', d.id).map((a) => `${dateTime(a.created_at)} · ${a.text}`),
      });
    }
    case 'lister_devis': {
      const where = [], p = [];
      if (args.statut) { where.push('status = ?'); p.push(args.statut); }
      if (args.depuis) { where.push('created_at >= ?'); p.push(Date.parse(args.depuis) || 0); }
      return out(db.all(`SELECT id, number, deal_id, status, total_ttc, deposit_cents, sent_at, signed_at FROM quotes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`, ...p)
        .map((q) => ({ ...q, total: money(q.total_ttc), envoye: dateTime(q.sent_at), signe: dateTime(q.signed_at) })));
    }
    case 'lister_paiements': {
      const rows = db.all(`SELECT id, deal_id, label, kind, amount_cents, refunded_cents, status, created_at, paid_at FROM payments ${args.statut ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 100`, ...(args.statut ? [args.statut] : []));
      return out(rows.map((x) => ({ ...x, montant: money(x.amount_cents), paye_le: dateTime(x.paid_at) })));
    }
    case 'lister_messages': {
      return out(require('./inbox').threads(args.filtre || 'a_traiter').map((t) => ({ client: t.name, mail: t.email, objet: t.subject, dernier_message: t.preview, recu: dateTime(t.last_at), non_lus: t.unread, demande: t.deal ? `${t.deal.title} (n°${t.deal.id})` : 'expéditeur inconnu', lien: `${config.appUrl}/#/messages/${encodeURIComponent(t.thread)}` })));
    }
    case 'chiffres': {
      const s = stats.kpis(args.periode === 'mois' || args.periode === 'annee' ? 'mois' : 'semaine');
      void user;
      return out({ periode: s.label, demandes: s.deals, devis_envoyes: s.sent, devis_signes: s.signed, taux_signature: `${s.rate} %`, chiffre_affaires_signe: money(s.signed_amount) });
    }
    case 'preparer_devis': {
      const lines = Array.isArray(args.lignes) && args.lignes.length ? args.lignes.map((l) => ({ label: l.libelle, qty: l.quantite, unit_cents: l.prix_unitaire_ttc_centimes, vat_rate: l.tva })) : null;
      const q = quotes.createQuote(Number(args.demande_id), user, lines);
      return out({ devis: q.number, statut: 'brouillon (non envoyé)', total: money(q.total_ttc), acompte: money(q.deposit_cents), a_verifier: `${config.appUrl}/#/devis/${q.id}` });
    }
    case 'preparer_relance': {
      const ts = args.date ? require('./util').parseLocalDateTime(args.date) : null;
      const r = reminders.manual(Number(args.demande_id), { message: args.message, due_at: ts, paused: true }, user);
      return out({ relance: r.id, prevue: dateTime(r.due_at), statut: 'en pause : à réactiver dans le CRM (écran Relances › En pause) pour qu’elle parte' });
    }
    case 'demander_action': {
      const kinds = { envoyer_devis: ['send_quote', `Envoyer le devis n°${args.devis_id}`], rembourser: ['refund', `Rembourser le paiement n°${args.paiement_id}${args.montant_centimes ? ` (${money(args.montant_centimes)})` : ''}`], supprimer_demande: ['delete_deal', `Supprimer la demande n°${args.demande_id}`] };
      const k = kinds[args.action];
      if (!k) throw new HttpError(400, 'Action inconnue.');
      const id = db.insert('pending_actions', { user_id: user.id, kind: k[0], label: k[1], payload: JSON.stringify(args), status: 'pending', created_at: Date.now() });
      return out({ demande: id, statut: 'à confirmer dans le CRM', ou: `${config.appUrl}/#/` });
    }
  }
  return out('');
}

async function handle(req, res, pathToken) {
  if (req.method === 'GET') return send(res, 405, 'Méthode non prise en charge', 'text/plain', { Allow: 'POST' });
  const user = userFromToken(req, pathToken);
  if (!user) return json(res, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Jeton MCP invalide.' } }, 401);
  const msgs = Array.isArray(req.body) ? req.body : [req.body];
  const replies = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== '2.0') { replies.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Requête invalide.' } }); continue; }
    if (m.id === undefined) continue; // notification (ex. notifications/initialized)
    try {
      let result;
      if (m.method === 'initialize') {
        result = { protocolVersion: m.params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: `crm-toog (${settings.get('company').name})`, version: config.version }, instructions: 'CRM de l’entreprise : demandes, devis, paiements, relances. Montants en euros TTC. Les actions sensibles doivent être confirmées dans le CRM.' };
      } else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: TOOLS.filter((t) => auth.can(user, t.area)).map(({ area, ...t }) => t) };
      else if (m.method === 'tools/call') {
        try { result = await callTool(m.params?.name, m.params?.arguments || {}, user); } catch (e) { result = { content: [{ type: 'text', text: e.message }], isError: true }; }
      } else { replies.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Méthode inconnue.' } }); continue; }
      replies.push({ jsonrpc: '2.0', id: m.id, result });
    } catch (e) {
      replies.push({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } });
    }
  }
  if (!replies.length) return send(res, 202, '');
  json(res, Array.isArray(req.body) ? replies : replies[0]);
}

module.exports = { handle, TOOLS };
