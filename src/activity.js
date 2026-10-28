'use strict';
// Historique : chaque action est datée et signée du nom de la personne (ou « système », « client »).
const db = require('./db');
const settings = require('./settings');

function log({ deal_id = null, contact_id = null, user_id = null, kind = 'system', text, meta = null }) {
  if (deal_id && !contact_id) contact_id = db.get('SELECT contact_id FROM deals WHERE id = ?', deal_id)?.contact_id ?? null;
  const now = settings.now();
  db.insert('activities', { deal_id, contact_id, user_id, kind, text, meta: meta ? JSON.stringify(meta) : null, created_at: now });
  if (contact_id) db.run('UPDATE contacts SET last_activity_at = ? WHERE id = ?', now, contact_id);
  if (deal_id) db.run('UPDATE deals SET updated_at = ? WHERE id = ?', now, deal_id);
}

module.exports = { log };
