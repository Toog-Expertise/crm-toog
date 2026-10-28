'use strict';
// Lecture du fichier .env (sans dépendance). Les variables déjà définies dans l'environnement gardent la priorité.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;

const config = {
  root: ROOT,
  version: require(path.join(ROOT, 'package.json')).version,
  appUrl: env('APP_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/$/, ''),
  port: Number(env('PORT', '3000')),
  production: env('NODE_ENV', 'development') === 'production',
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data')),
  sessionSecret: env('SESSION_SECRET', 'dev-secret-a-changer'),
  adminEmail: env('ADMIN_EMAIL').toLowerCase(),
  allowedDomain: env('ALLOWED_DOMAIN').toLowerCase().replace(/^@/, ''),
  google: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
  serviceAccount: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
  ga4Property: env('GA4_PROPERTY_ID'),
  stripe: { publishable: env('STRIPE_PUBLISHABLE_KEY'), secret: env('STRIPE_SECRET_KEY'), webhookSecret: env('STRIPE_WEBHOOK_SECRET') },
  resend: { key: env('RESEND_API_KEY'), webhookSecret: env('RESEND_WEBHOOK_SECRET'), from: env('MAIL_FROM'), replyTo: env('MAIL_REPLY_TO'), inbound: env('MAIL_INBOUND').toLowerCase() },
  turnstile: { siteKey: env('TURNSTILE_SITE_KEY'), secret: env('TURNSTILE_SECRET_KEY') },
  siteApiKey: env('SITE_API_KEY'),
  backupRemote: env('BACKUP_REMOTE'),
};

if (config.production && config.sessionSecret === 'dev-secret-a-changer') {
  console.error('SESSION_SECRET manquant dans le .env : arrêt.');
  process.exit(1);
}

module.exports = { config, loadEnv };
