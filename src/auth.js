'use strict';
// Connexion : Google (réservée au domaine autorisé) et, en secours, code à 6 chiffres par mail.
// Toutes les vérifications se font côté serveur.
const db = require('./db');
const settings = require('./settings');
const mail = require('./mail');
const rate = require('./ratelimit');
const { config } = require('./env');
const { sha256, randomToken, randomCode, safeEqual, normEmail, isEmail, HttpError, failuresBlocked, recordFailure } = require('./util');
const { parseCookies, setCookie, redirect, json, clientIp } = require('./http');

const COOKIE = 'crm_session';
const SESSION_DAYS = 30;
const secure = () => config.appUrl.startsWith('https://');

function emailDomain(email) { return String(email).split('@')[1] || ''; }

// Le premier compte devient gérant : l'adresse ADMIN_EMAIL si elle est réglée, sinon le premier compte du domaine.
function canBeFirstAdmin(email, users) {
  if (config.adminEmail) return email === config.adminEmail && !db.get("SELECT 1 FROM users WHERE role = 'gerant' AND active = 1");
  return users === 0;
}

// Décide si une adresse peut entrer. Renvoie l'utilisateur, ou lève une erreur au message clair.
function admit(emailRaw, name, method, req) {
  const email = normEmail(emailRaw);
  if (!isEmail(email)) throw new HttpError(400, 'Adresse invalide.');
  const domain = settings.allowedDomain();
  const users = db.get('SELECT COUNT(*) n FROM users').n;
  let user = db.get('SELECT * FROM users WHERE email = ?', email);

  if (!domain && !(users === 0 && config.adminEmail && email === config.adminEmail)) {
    throw new HttpError(403, "Aucun domaine autorisé n'est réglé : complétez ALLOWED_DOMAIN dans le .env du serveur.");
  }
  // L'adresse du gérant posée à l'installation (ADMIN_EMAIL) entre même hors du domaine
  if (domain && emailDomain(email) !== domain && email !== config.adminEmail) {
    throw new HttpError(403, `${email} : ce compte n'appartient pas à l'entreprise. Accès refusé.`);
  }
  if (user && !user.active) throw new HttpError(403, `${email} : ce compte est désactivé. Demandez au gérant de le réactiver.`);
  if (!user) {
    if (canBeFirstAdmin(email, users)) {
      const id = db.insert('users', { email, name: name || email.split('@')[0], role: 'gerant', created_at: settings.now() });
      user = db.get('SELECT * FROM users WHERE id = ?', id);
    } else {
      throw new HttpError(403, `${email} : vous n'avez pas encore été invité. Demandez au gérant de vous inviter depuis l'écran Équipe.`);
    }
  }
  const upd = { last_login_at: settings.now(), last_login_method: method, last_login_ip: clientIp(req) };
  if (name && (!user.name || user.name === email.split('@')[0])) upd.name = name;
  db.update('users', user.id, upd);
  return db.get('SELECT * FROM users WHERE id = ?', user.id);
}

function startSession(res, user, req) {
  const token = randomToken(32);
  const now = Date.now();
  db.insert('sessions', { id: sha256(token), user_id: user.id, created_at: now, expires_at: now + SESSION_DAYS * 86400e3, ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
  setCookie(res, COOKIE, token, { secure: secure(), maxAge: SESSION_DAYS * 86400 });
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE id = ?', sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  const u = db.get('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  return u || null;
}

function can(user, area) {
  return Boolean(user && settings.ROLES[user.role]?.access.includes(area));
}

// Middlewares
function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Connexion requise.');
}
const requireArea = (area) => (req) => {
  requireUser(req);
  if (!can(req.user, area)) throw new HttpError(403, "Votre rôle ne donne pas accès à cette partie.");
};

function register(router) {
  // --- Google ---
  router.get('/auth/google', (req, res) => {
    if (!config.google.clientId) return redirect(res, '/login?erreur=' + encodeURIComponent("La connexion Google n'est pas encore branchée : utilisez le code par mail."));
    const state = randomToken(16);
    setCookie(res, 'crm_oauth_state', state, { secure: secure(), maxAge: 600 });
    const p = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: `${config.appUrl}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    const domain = settings.allowedDomain();
    if (domain) p.set('hd', domain);
    redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  });

  router.get('/auth/google/callback', async (req, res) => {
    const fail = (msg) => redirect(res, '/login?erreur=' + encodeURIComponent(msg));
    const state = parseCookies(req).crm_oauth_state;
    setCookie(res, 'crm_oauth_state', '', { secure: secure(), maxAge: 0 });
    if (req.query.get('error')) return fail('Connexion Google annulée.');
    if (!state || !safeEqual(state, req.query.get('state') || '')) return fail('La connexion a expiré, recommencez.');
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.get('code') || '', client_id: config.google.clientId, client_secret: config.google.clientSecret,
          redirect_uri: `${config.appUrl}/auth/google/callback`, grant_type: 'authorization_code',
        }),
      });
      const tok = await r.json();
      if (!r.ok || !tok.id_token) return fail('Google a refusé la connexion (' + (tok.error || r.status) + ').');
      // Le jeton vient directement de Google en HTTPS : on vérifie ses champs.
      const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
      if (claims.aud !== config.google.clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.exp * 1000 < Date.now()) {
        return fail('Jeton Google invalide.');
      }
      if (!claims.email_verified) return fail(`${claims.email} : adresse non vérifiée par Google. Accès refusé.`);
      const domain = settings.allowedDomain();
      if (domain && claims.hd && claims.hd !== domain) return fail(`${claims.email} : ce compte n'appartient pas à l'entreprise. Accès refusé.`);
      const user = admit(claims.email, claims.name, 'Google', req);
      startSession(res, user, req);
      redirect(res, '/');
    } catch (e) {
      fail(e.status ? e.message : 'Connexion Google impossible pour le moment.');
      if (!e.status) console.error(e);
    }
  });

  // --- Code par mail ---
  router.post('/auth/code/request', async (req, res) => {
    const email = normEmail(req.body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Adresse invalide.');
    if (!rate.hit('code-ip:' + clientIp(req), 8, 600e3) || !rate.hit('code-mail:' + email, 3, 600e3)) throw new HttpError(429, 'Trop de demandes. Réessayez dans quelques minutes.');
    if (failuresBlocked(db, 'login:' + email)) throw new HttpError(429, 'Trop de codes faux pour cette adresse aujourd’hui : réessayez demain, ou connectez-vous avec Google.');
    // Mêmes règles que Google, vérifiées avant l'envoi (sans créer de session)
    const domain = settings.allowedDomain();
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const users = db.get('SELECT COUNT(*) n FROM users').n;
    const firstAdmin = canBeFirstAdmin(email, users);
    if (domain && email.split('@')[1] !== domain && !(config.adminEmail === email)) throw new HttpError(403, `${email} : ce compte n'appartient pas à l'entreprise. Accès refusé.`);
    if (!domain && !(config.adminEmail === email)) throw new HttpError(403, "Aucun domaine autorisé n'est réglé : complétez ALLOWED_DOMAIN dans le .env du serveur.");
    if (user && !user.active) throw new HttpError(403, `${email} : ce compte est désactivé.`);
    if (!user && !firstAdmin) throw new HttpError(403, `${email} : vous n'avez pas encore été invité. Demandez au gérant de vous inviter.`);
    const code = randomCode();
    db.run('INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0',
      email, sha256(config.sessionSecret + code), Date.now() + 600e3);
    const r = await mail.send({ to: email, template: 'code_connexion', vars: { code } });
    if (r.status === 'failed') throw new HttpError(502, "Le mail n'a pas pu partir. Réessayez, ou contactez le gérant.");
    json(res, { ok: true, simulated: r.status === 'simulated' });
  });

  router.post('/auth/code/verify', (req, res) => {
    const email = normEmail(req.body.email);
    const code = String(req.body.code || '').replace(/\D/g, '');
    const row = db.get('SELECT * FROM login_codes WHERE email = ?', email);
    if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'Code expiré : demandez-en un nouveau.');
    if (failuresBlocked(db, 'login:' + email)) throw new HttpError(429, 'Trop de codes faux pour cette adresse aujourd’hui : réessayez demain.');
    if (row.attempts >= 5) throw new HttpError(429, 'Trop d’essais : demandez un nouveau code.');
    db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?', email);
    if (!safeEqual(row.code_hash, sha256(config.sessionSecret + code))) { recordFailure(db, 'login:' + email); throw new HttpError(400, 'Code incorrect.'); }
    db.run('DELETE FROM login_codes WHERE email = ?', email);
    const user = admit(email, null, 'code par mail', req);
    startSession(res, user, req);
    json(res, { ok: true });
  });

  router.post('/auth/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
    setCookie(res, COOKIE, '', { secure: secure(), maxAge: 0 });
    json(res, { ok: true });
  });
}

module.exports = { register, currentUser, requireUser, requireArea, can, admit, COOKIE };
