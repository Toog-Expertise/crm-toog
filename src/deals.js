'use strict';
// Contacts, entreprises et demandes : création sans doublon, étapes, attribution.
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const { normEmail, normPhone, fullName, HttpError, parseLocalDateTime } = require('./util');

// Règle de dédoublonnage : même mail OU même téléphone = même contact.
function findContact({ email, phone }) {
  const e = normEmail(email), p = normPhone(phone);
  if (e) { const c = db.get('SELECT * FROM contacts WHERE email = ?', e); if (c) return c; }
  if (p) { const c = db.get('SELECT * FROM contacts WHERE phone_norm = ?', p); if (c) return c; }
  return null;
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first_name: parts[0] || '', last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function upsertCompany(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const c = db.get('SELECT id FROM companies WHERE lower(name) = lower(?)', n);
  if (c) return c.id;
  const now = settings.now();
  return db.insert('companies', { name: n.slice(0, 200), created_at: now, updated_at: now });
}

// Crée ou complète un contact. Les champs déjà remplis ne sont jamais écrasés par un champ vide.
function upsertContact(input) {
  const now = settings.now();
  const names = input.name !== undefined && !input.first_name && !input.last_name ? splitName(input.name) : { first_name: input.first_name || '', last_name: input.last_name || '' };
  const email = normEmail(input.email), phone = String(input.phone || '').trim() || null;
  const company_id = input.company_id || (input.company ? upsertCompany(input.company) : null);
  const existing = findContact({ email, phone });
  if (existing) {
    const upd = {};
    if (!existing.first_name && names.first_name) upd.first_name = names.first_name;
    if (!existing.last_name && names.last_name) upd.last_name = names.last_name;
    if (!existing.email && email) upd.email = email;
    if (!existing.phone && phone) { upd.phone = phone; upd.phone_norm = normPhone(phone); }
    if (!existing.company_id && company_id) upd.company_id = company_id;
    if (input.consent && !existing.consent_at) upd.consent_at = now;
    upd.updated_at = now; upd.last_activity_at = now;
    db.update('contacts', existing.id, upd);
    return { id: existing.id, created: false };
  }
  const id = db.insert('contacts', {
    first_name: names.first_name.slice(0, 100), last_name: names.last_name.slice(0, 100), email, phone, phone_norm: normPhone(phone),
    company_id, source: input.source || null, consent_at: input.consent ? now : null,
    created_at: now, updated_at: now, last_activity_at: now,
  });
  return { id, created: true };
}

function dealTitle(type, people) {
  const t = settings.dealTypes().find((x) => x.key === type);
  const typeLabel = t ? t.label : 'Demande';
  const unit = type === 'anniversaire' ? 'enfants' : 'pers.';
  return [typeLabel, people ? `${people} ${unit}` : null].filter(Boolean).join(' · ');
}

const SOURCE_LABEL = { site: 'site', devis_auto: 'devis automatique', telephone: 'téléphone', accueil: 'accueil', salon: 'salon', crm: 'CRM', import: 'import', api: 'API' };

// Crée une demande complète (contact, entreprise, demande) à partir des champs du formulaire
function createDeal(input, user = null) {
  const types = settings.dealTypes();
  const type = types.some((t) => t.key === input.type) ? input.type : 'autre';
  const typeDef = types.find((t) => t.key === type) || { fields: [] };
  const data = {};
  let companyName = input.company || '';
  for (const f of typeDef.fields || []) {
    const v = input.data?.[f.key] ?? input[f.key];
    if (f.required && !input.lenient && !String(v ?? '').trim()) throw new HttpError(400, `Le champ « ${f.label} » est obligatoire.`);
    if (v !== undefined && v !== '') data[f.key] = String(v).slice(0, 500);
    if (f.company && v) companyName = String(v);
  }
  if (input.data?.options) data.options = [].concat(input.data.options).map(Number).filter(Boolean);
  if (!input.email && !input.phone) throw new HttpError(400, 'Un mail ou un téléphone est nécessaire.');
  const people = input.people ? Math.max(0, Math.min(10000, parseInt(input.people, 10) || 0)) || null : null;
  const eventAt = typeof input.event_at === 'number' ? input.event_at : parseLocalDateTime(input.event_at);
  const created = db.tx(() => {
    const company_id = upsertCompany(companyName);
    const contact = upsertContact({ name: input.name, first_name: input.first_name, last_name: input.last_name, email: input.email, phone: input.phone, company_id, consent: input.consent, source: input.source });
    const now = settings.now();
    const id = db.insert('deals', {
      contact_id: contact.id, company_id, type, title: (input.title || dealTitle(type, people)).slice(0, 200),
      stage: input.stage || 'nouvelle', source: input.source || 'crm', source_page: input.source_page || null,
      event_at: eventAt, people, data: JSON.stringify(data), message: String(input.message || '').slice(0, 5000) || null,
      assigned_to: input.assigned_to || null, created_by: user?.id || null, created_at: now, updated_at: now,
    });
    const src = SOURCE_LABEL[input.source] || input.source || 'CRM';
    activity.log({ deal_id: id, contact_id: contact.id, user_id: user?.id || null, kind: 'system', text: user ? `Demande créée par ${user.name} (source : ${src})` : `Demande reçue (source : ${src}${input.source_page ? ` · ${input.source_page}` : ''})` });
    return { id, contact_id: contact.id, contact_created: contact.created };
  });
  if ((input.stage || 'nouvelle') === 'nouvelle') require('./reminders').onNewDeal(created.id);
  return created;
}

function getDeal(id) {
  const d = db.get('SELECT * FROM deals WHERE id = ?', Number(id));
  if (!d) throw new HttpError(404, 'Demande introuvable.');
  return d;
}

// Change d'étape et le note dans l'historique. Les relances suivent (voir reminders.js).
function setStage(dealId, stage, user = null, note = '') {
  if (!settings.STAGES.some((s) => s.key === stage)) throw new HttpError(400, 'Étape inconnue.');
  const d = getDeal(dealId);
  if (d.stage === stage) return d;
  db.update('deals', d.id, { stage, updated_at: settings.now() });
  activity.log({ deal_id: d.id, user_id: user?.id || null, kind: 'stage', text: `Étape : ${settings.stageLabel(d.stage)} → ${settings.stageLabel(stage)}${user ? ` (${user.name})` : ''}${note ? ` · ${note}` : ''}` });
  require('./reminders').onStage(d.id, stage);
  return getDeal(d.id);
}

// Par défaut, la demande est attribuée à la première personne qui la traite
function claim(dealId, user) {
  if (!user) return;
  const d = getDeal(dealId);
  if (!d.assigned_to) {
    db.update('deals', d.id, { assigned_to: user.id });
    activity.log({ deal_id: d.id, user_id: user.id, kind: 'system', text: `Attribuée à ${user.name}` });
  }
}

function contactOf(deal) {
  return deal.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', deal.contact_id) : null;
}

module.exports = { findContact, upsertContact, upsertCompany, createDeal, getDeal, setStage, claim, contactOf, splitName, fullName, SOURCE_LABEL };
