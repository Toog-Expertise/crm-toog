'use strict';
// Crée (ou remet) un compte gérant : node scripts/admin.js adresse@entreprise.fr "Prénom Nom"
const { config } = require('../src/env');
const db = require('../src/db');
const settings = require('../src/settings');

const [email, ...nameParts] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage : npm run admin -- adresse@entreprise.fr "Prénom Nom"');
  process.exit(1);
}
db.open();
const e = email.toLowerCase();
const name = nameParts.join(' ') || e.split('@')[0];
const u = db.get('SELECT * FROM users WHERE email = ?', e);
if (u) db.update('users', u.id, { role: 'gerant', active: 1 });
else db.insert('users', { email: e, name, role: 'gerant', created_at: Date.now() });
if (!settings.get('access').allowed_domain) settings.set('access', { allowed_domain: config.allowedDomain || e.split('@')[1] });
console.log(`${e} est gérant (administrateur). Domaine autorisé : @${settings.allowedDomain()}`);
