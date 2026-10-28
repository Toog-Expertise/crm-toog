'use strict';
// Contrôle de sécurité et d'entretien : npm run check
// Vérifie la configuration, les secrets (code et historique git), la base, la dernière sauvegarde et l'activité récente.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { config } = require('../src/env');

const results = [];
const add = (ok, label, detail = '') => results.push({ ok, label, detail });

// Les motifs de clés reconnaissables
const SECRET = /(sk_(live|test)_[0-9a-zA-Z]{10,}|rk_(live|test)_[0-9a-zA-Z]{10,}|whsec_[0-9a-zA-Z+/=]{16,}|re_[0-9a-zA-Z]{8,}_[0-9a-zA-Z]{8,}|GOCSPX-[0-9A-Za-z_-]{10,}|-----BEGIN (RSA )?PRIVATE KEY-----)/;

// 1. Configuration
const envFile = path.join(config.root, '.env');
if (fs.existsSync(envFile)) {
  const mode = fs.statSync(envFile).mode & 0o777;
  add(mode <= 0o600, '.env lisible seulement par son propriétaire', `droits ${mode.toString(8)}${mode > 0o600 ? ' : lancez chmod 600 .env' : ''}`);
} else add(false, '.env présent', 'fichier absent');
add(config.sessionSecret.length >= 32 && config.sessionSecret !== 'dev-secret-a-changer', 'SESSION_SECRET solide');
add(config.appUrl.startsWith('https://'), 'APP_URL en HTTPS', config.appUrl);
add(!config.stripe.secret || Boolean(config.stripe.webhookSecret), 'Webhook Stripe signé', config.stripe.secret ? '' : 'Stripe non branché');
add(!config.resend.key || Boolean(config.resend.webhookSecret), 'Webhook Resend signé', config.resend.key ? '' : 'Resend non branché');
add(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js à jour', process.versions.node);

// 2. Aucune clé dans le code ni dans l'historique git
try {
  const files = execFileSync('git', ['ls-files'], { cwd: config.root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits = files.filter((f) => { try { return SECRET.test(fs.readFileSync(path.join(config.root, f), 'utf8')); } catch { return false; } });
  add(!hits.length, 'Aucune clé dans le code', hits.join(', '));
  add(!files.some((f) => /(^|\/)\.env$/.test(f) || /\.db$/.test(f)), '.env et base hors du dépôt');
  const history = execFileSync('git', ['log', '-p', '--all', '--no-color'], { cwd: config.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  add(!SECRET.test(history), "Aucune clé dans l'historique git");
} catch {
  add(true, 'Dépôt git', 'pas de dépôt git ici : contrôle des fichiers ignoré');
}

// 3. Base et sauvegarde
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(config.dataDir, 'crm.db');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  add(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'Base intègre');
  const since = Date.now() - 7 * 86400e3;
  const q = (sql, ...p) => db.prepare(sql).get(...p).n;
  const bounced = q("SELECT COUNT(*) n FROM emails WHERE status IN ('bounced', 'failed', 'complained') AND created_at > ?", since);
  const failedPay = q("SELECT COUNT(*) n FROM payments WHERE status = 'failed' AND created_at > ?", since);
  const remErr = q("SELECT COUNT(*) n FROM reminders WHERE status = 'error'");
  const noAnswer = q("SELECT COUNT(*) n FROM deals WHERE stage = 'nouvelle' AND created_at < ?", Date.now() - 2 * 86400e3);
  add(bounced === 0, 'Mails rejetés (7 jours)', String(bounced));
  add(failedPay === 0, 'Paiements en échec (7 jours)', String(failedPay));
  add(remErr === 0, 'Relances en erreur', String(remErr));
  add(noAnswer === 0, 'Demandes sans réponse depuis 48 h', String(noAnswer));
  const ips = db.prepare('SELECT DISTINCT ip FROM sessions WHERE created_at > ?').all(since).map((r) => r.ip);
  add(true, 'Connexions (7 jours)', `${ips.length} adresse(s) IP différente(s) : ${ips.slice(0, 6).join(', ')}`);
  db.close();
} catch (e) {
  add(false, 'Base lisible', e.message);
}
const bdir = path.join(config.root, 'backups');
const last = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith('.tar.gz')).sort().pop() : null;
const age = last ? (Date.now() - fs.statSync(path.join(bdir, last)).mtimeMs) / 3600e3 : Infinity;
add(age < 30, 'Sauvegarde de moins de 30 h', last ? `${last} (il y a ${Math.round(age)} h)` : 'aucune sauvegarde');

const ko = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.label}${r.detail ? ` · ${r.detail}` : ''}`);
console.log(`\n${ko.length ? `${ko.length} point(s) à corriger.` : 'Tout est vert.'}`);
process.exitCode = ko.length ? 1 : 0;
