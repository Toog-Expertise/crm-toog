'use strict';
// RGPD : exporter, supprimer les données d'un contact ; purge après N années sans activité.
// Un contact qui a payé est anonymisé (les montants restent pour la comptabilité), sinon supprimé.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const { config } = require('./env');
const { HttpError } = require('./util');

function exportContact(id) {
  const contact = db.get('SELECT * FROM contacts WHERE id = ?', Number(id));
  if (!contact) throw new HttpError(404, 'Contact introuvable.');
  const dealsList = db.all('SELECT * FROM deals WHERE contact_id = ?', contact.id);
  const ids = dealsList.map((d) => d.id);
  const inIds = (table) => (ids.length ? db.all(`SELECT * FROM ${table} WHERE deal_id IN (${ids.map(() => '?').join(',')})`, ...ids) : []);
  const strip = (q) => { const { sign_token, view_token, sign_code_hash, ...rest } = q; return rest; };
  return {
    exporte_le: new Date().toISOString(),
    contact,
    entreprise: contact.company_id ? db.get('SELECT * FROM companies WHERE id = ?', contact.company_id) : null,
    demandes: dealsList.map((d) => ({ ...d, data: JSON.parse(d.data || '{}') })),
    devis: inIds('quotes').map(strip),
    paiements: inIds('payments').map(({ pay_token, ...p }) => p),
    mails: db.all('SELECT to_addr, template, subject, status, created_at FROM emails WHERE contact_id = ?', contact.id),
    historique: db.all('SELECT kind, text, created_at FROM activities WHERE contact_id = ? ORDER BY created_at', contact.id),
  };
}

function eraseContact(id, user = null) {
  const c = db.get('SELECT * FROM contacts WHERE id = ?', Number(id));
  if (!c) throw new HttpError(404, 'Contact introuvable.');
  const dealIds = db.all('SELECT id FROM deals WHERE contact_id = ?', c.id).map((d) => d.id);
  const paid = dealIds.length && db.get(`SELECT 1 FROM payments WHERE deal_id IN (${dealIds.map(() => '?').join(',')}) AND status IN ('paid', 'partially_refunded', 'refunded') LIMIT 1`, ...dealIds);
  db.tx(() => {
    for (const dId of dealIds) {
      // Les PDF de devis contiennent des données personnelles
      for (const q of db.all('SELECT number FROM quotes WHERE deal_id = ?', dId)) {
        for (const f of [`${q.number}.pdf`, `${q.number}-signe.pdf`]) fs.rmSync(path.join(config.dataDir, 'pdf', f), { force: true });
      }
    }
    if (paid) {
      db.run("UPDATE contacts SET first_name = 'Contact', last_name = 'supprimé', email = NULL, phone = NULL, phone_norm = NULL, consent_at = NULL WHERE id = ?", c.id);
      for (const dId of dealIds) {
        db.run("UPDATE deals SET data = '{}', message = NULL WHERE id = ?", dId);
        db.run("UPDATE quotes SET object = 'anonymisé', signer_name = 'anonymisé', signer_email = NULL, signer_ip = NULL, signer_ua = NULL, sign_token = NULL, view_token = NULL WHERE deal_id = ?", dId);
        db.run("UPDATE deals SET title = ? WHERE id = ?", 'Demande anonymisée', dId);
        db.run("UPDATE events SET title = 'Réservation anonymisée', notes = NULL WHERE deal_id = ?", dId);
        db.run("DELETE FROM activities WHERE deal_id = ? AND kind IN ('note', 'mail', 'sign')", dId);
        db.run("UPDATE reminders SET status = 'cancelled' WHERE deal_id = ? AND status IN ('scheduled', 'paused')", dId);
      }
      db.run('UPDATE emails SET to_addr = ? WHERE contact_id = ?', 'anonymisé', c.id);
      for (const dId of dealIds) db.run("UPDATE emails SET subject = 'anonymisé' WHERE deal_id = ?", dId);
    } else {
      for (const dId of dealIds) { db.run('DELETE FROM emails WHERE deal_id = ?', dId); db.run('DELETE FROM deals WHERE id = ?', dId); }
      db.run('DELETE FROM emails WHERE contact_id = ?', c.id);
      db.run('DELETE FROM activities WHERE contact_id = ?', c.id);
      db.run('DELETE FROM contacts WHERE id = ?', c.id);
    }
  });
  activity.log({ user_id: user?.id, kind: 'system', text: `RGPD : contact n°${c.id} ${paid ? 'anonymisé' : 'supprimé'}${user ? ` par ${user.name}` : ' (purge automatique)'}` });
  return { mode: paid ? 'anonymisé' : 'supprimé' };
}

function staleContacts() {
  const years = settings.get('rgpd').retention_years || 3;
  // Vraie date (jamais l'horloge de test) : une purge est définitive
  const limit = Date.now() - years * 365.25 * 86400e3;
  return db.all("SELECT id, first_name, last_name, last_activity_at FROM contacts WHERE last_activity_at < ? AND NOT (first_name = 'Contact' AND last_name = 'supprimé')", limit);
}

function purge() {
  const list = staleContacts();
  for (const c of list) eraseContact(c.id);
  return list.length;
}

function start() {
  const run = () => { try { const n = purge(); if (n) console.log(`RGPD : ${n} contact(s) purgé(s).`); } catch (e) { console.error('Purge RGPD :', e.message); } };
  setInterval(run, 24 * 3600e3).unref();
  setTimeout(run, 60e3).unref();
}

module.exports = { exportContact, eraseContact, staleContacts, purge, start };
