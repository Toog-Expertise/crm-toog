'use strict';
// CRM Toog : point d'entrée. Node.js + SQLite intégrés, aucune dépendance.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { config } = require('./src/env');
const db = require('./src/db');
const settings = require('./src/settings');
const { Router, readBody, parseBody, json, html, send, redirect, serveFile, serveStatic, csp } = require('./src/http');
const { HttpError, escapeHtml } = require('./src/util');

db.open();
settings.load();

const auth = require('./src/auth');
const pages = require('./src/pages');
const mail = require('./src/mail');
const payments = require('./src/payments');
const mcp = require('./src/mcp');
const reminders = require('./src/reminders');
const rgpd = require('./src/rgpd');

const router = new Router();
auth.register(router);
require('./src/api').register(router);
require('./src/public').register(router);
require('./src/sign').register(router);

const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Pages ---
router.get('/', (req, res) => {
  if (!req.user) return redirect(res, '/login');
  // ?v= : après une mise à jour, le navigateur recharge les écrans
  html(res, fs.readFileSync(path.join(PUBLIC_DIR, 'app.html'), 'utf8').replace('<!--FONTS-->', pages.fontLinks()).replace(/\/static\/([\w-]+\.(js|css))/g, `/static/$1?v=${config.version}`));
});

router.get('/login', (req, res) => {
  if (req.user) return redirect(res, '/');
  const domain = settings.allowedDomain();
  const err = req.query.get('erreur');
  const google = Boolean(config.google.clientId);
  const company = settings.get('company');
  const body = `<main class="login"><div class="login-card">
    ${settings.get('logo') ? pages.logoTag('login-logo') : ''}
    <h1>${escapeHtml(company.name)}</h1>
    ${err ? `<div class="alert alert-error">✕ ${escapeHtml(err)}</div>` : ''}
    ${google ? `<a class="btn btn-google btn-block" href="/auth/google"><span class="g-logo" aria-hidden="true"></span>Se connecter avec Google</a>` : ''}
    ${domain ? `<p class="accent-text center small">Réservé aux comptes @${escapeHtml(domain)}</p>` : ''}
    <details class="code-login" ${google ? '' : 'open'}>
      <summary>${google ? 'Pas de compte Google ? Recevoir un code par mail' : 'Recevoir un code de connexion par mail'}</summary>
      <form id="code-form" novalidate>
        <label class="field"><span>Votre adresse${domain ? ` @${escapeHtml(domain)}` : ''}</span><input type="email" name="email" autocomplete="email" required></label>
        <div id="code-step" hidden><label class="field"><span>Code reçu par mail</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label></div>
        <p class="error" id="code-error" hidden></p>
        <p class="ok-text" id="code-info" hidden></p>
        <button class="btn btn-ghost btn-block" type="submit" id="code-btn">Recevoir un code</button>
      </form>
    </details>
  </div></main>`;
  html(res, pages.page({ title: 'Connexion', body, scripts: ['/static/login.js'], bodyClass: 'app-bg' }));
});

router.get('/theme.css', (req, res) => send(res, 200, pages.themeCss(), 'text/css; charset=utf-8', { 'Cache-Control': 'no-cache' }));

router.get('/logo', (req, res) => {
  const f = settings.get('logo');
  if (!f || !serveFile(res, path.join(config.dataDir, 'uploads', path.basename(f)), 'public, max-age=3600')) send(res, 404, 'Pas de logo');
});

router.get('/sante', (req, res) => json(res, { ok: true, version: config.version }));

// --- Webhooks (corps brut, signature vérifiée) ---
router.post('/api/stripe/webhook', async (req, res) => {
  if (!payments.verifyWebhook(req.headers['stripe-signature'], req.raw)) return json(res, { error: 'Signature invalide' }, 400);
  await payments.handleWebhook(JSON.parse(req.raw.toString('utf8')));
  json(res, { received: true });
});
router.post('/api/resend/webhook', async (req, res) => {
  if (!mail.verifyWebhook(req.headers, req.raw)) return json(res, { error: 'Signature invalide' }, 400);
  await mail.handleWebhook(JSON.parse(req.raw.toString('utf8')));
  json(res, { received: true });
});

// --- MCP ---
router.post('/mcp', (req, res) => mcp.handle(req, res));
router.get('/mcp', (req, res) => mcp.handle(req, res));
router.post('/mcp/:token', (req, res) => mcp.handle(req, res, req.params.token));
router.get('/mcp/:token', (req, res) => mcp.handle(req, res, req.params.token));

// Routes appelées par les écrans connectés : protégées contre les requêtes d'un autre site
const COOKIE_ROUTES = /^\/(api\/(?!public\/|stripe\/|resend\/)|auth\/(code|logout))/;
const appOrigin = new URL(config.appUrl).origin;

function securityHeaders(res, pathname) {
  res.setHeader('Content-Security-Policy', csp());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', /^\/(s|p|mcp)\//.test(pathname) ? 'no-referrer' : 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.appUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const masked = (p) => p.replace(/^\/(s|p|mcp)\/[^/]+/, '/$1/•••');

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  req.query = url.searchParams;
  securityHeaders(res, pathname);
  res.on('finish', () => {
    if (req.method !== 'HEAD' && !pathname.startsWith('/static/') && pathname !== '/theme.css' && pathname !== '/sante') console.log(`${req.method} ${masked(pathname)} ${res.statusCode} ${Date.now() - t0} ms`);
  });
  try {
    if (pathname.startsWith('/static/') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (serveStatic(res, PUBLIC_DIR, pathname.slice('/static'.length))) return;
      return send(res, 404, 'Introuvable');
    }
    const m = router.match(req.method, pathname);
    if (!m) throw new HttpError(404, 'Page introuvable.');
    req.params = m.params;
    req.raw = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
    if (COOKIE_ROUTES.test(pathname) && req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== appOrigin) throw new HttpError(403, 'Origine refusée.');
      if (req.raw.length && !(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON attendu.');
    }
    req.body = req.raw.length ? parseBody(req, req.raw) : {};
    req.user = auth.currentUser(req);
    for (const h of m.handlers) {
      await h(req, res);
      if (res.writableEnded || res.headersSent) break;
    }
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    const message = status >= 500 && !e.status ? 'Erreur interne. Réessayez ; si cela continue, prévenez le gérant.' : e.message;
    const wantsJson = pathname.startsWith('/api/') || pathname.startsWith('/auth/code') || req.method !== 'GET' || (req.headers.accept || '').includes('application/json');
    if (res.headersSent) return res.end();
    if (wantsJson) json(res, { error: message }, status);
    else if (status === 401) redirect(res, '/login');
    else html(res, pages.message(status === 404 ? 'Page introuvable' : 'Oups', message), status);
  }
});

if (require.main === module) {
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`CRM Toog ${config.version} prêt : ${config.appUrl} (port ${config.port}${config.production ? '' : ', développement'})`);
    if (!config.production && !mail.enabled()) console.log('Resend non branché : les mails (et les codes de connexion) s’affichent ici.');
  });
  reminders.start();
  rgpd.start();
  const stop = () => { server.close(); db.db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, router };
