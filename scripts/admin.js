'use strict';
// Crée le compte du gérant, ou lui redonne l'accès avec un nouveau mot de passe :
//   node scripts/admin.js adresse@entreprise.fr "Prénom Nom" [mot de passe]
// Sans mot de passe, un mot de passe provisoire est créé et affiché une seule fois : à changer dans Mon compte.
const crypto = require('node:crypto');
const db = require('../src/db');
const auth = require('../src/auth');

const [email, name = '', given] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage : npm run admin -- adresse@entreprise.fr "Prénom Nom" [mot de passe]');
  process.exit(1);
}
db.open();
const e = email.toLowerCase();
const [first = e.split('@')[0], ...rest] = name.trim().split(/\s+/).filter(Boolean);
const password = given || crypto.randomBytes(9).toString('base64url');
auth.validPassword(password);
const hash = auth.hashPassword(password);
const u = db.get('SELECT * FROM users WHERE email = ?', e);
if (u) {
  db.update('users', u.id, { active: 1, password_hash: hash });
  auth.closeSessions(u.id);
} else {
  db.insert('users', { email: e, first_name: first, last_name: rest.join(' '), name: [first, ...rest].join(' '), role: 'gerant', password_hash: hash, created_at: Date.now() });
}
console.log(`Compte prêt : ${e}`);
if (!given) console.log(`Mot de passe provisoire : ${password}\n(à changer tout de suite dans le CRM : Mon compte)`);
