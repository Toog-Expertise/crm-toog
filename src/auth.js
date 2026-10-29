'use strict';
// Connexion par adresse mail et mot de passe. Le gérant crée les comptes de l'équipe et choisit leur mot de passe ;
// tout le monde a tous les droits. Google reste possible en option (Paramètres › Accès), désactivée par défaut.
// Toutes les vérifications se font côté serveur.
const crypto = require('node:crypto');
const db = require('./db');
const settings = require('./settings');
const rate = require('./ratelimit');
const { config } = require('./env');
const { sha256, randomToken, safeEqual, normEmail, isEmail, HttpError, failuresBlocked, recordFailure } = require('./util');
const { parseCookies, setCookie, redirect, json, clientIp } = require('./http');

const COOKIE = 'crm_session';
const SESSION_DAYS = 30;
const secure = () => config.appUrl.startsWith('https://');

// Mots de passe : scrypt avec un sel propre à chaque compte
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return safeEqual(h.toString('hex'), hash);
}
function validPassword(pw) {
  if (String(pw || '').length < 8) throw new HttpError(400, 'Le mot de passe doit faire au moins 8 caractères.');
  if (String(pw).length > 200) throw new HttpError(400, 'Mot de passe trop long.');
  return String(pw);
}

// Connexion Google (option) : seulement pour un compte déjà créé par le gérant
function admitGoogle(emailRaw, req) {
  const email = normEmail(emailRaw);
  const user = db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user) throw new HttpError(403, `${email} : pas de compte à cette adresse. Demandez au gérant de vous ajouter dans Équipe.`);
  if (!user.active) throw new HttpError(403, `${email} : ce compte est désactivé.`);
  db.update('users', user.id, { last_login_at: settings.now(), last_login_method: 'Google', last_login_ip: clientIp(req) });
  return db.get('SELECT * FROM users WHERE id = ?', user.id);
}
const googleEnabled = () => Boolean(config.google.clientId && settings.get('access').google);

function startSession(res, user, req) {
  const token = randomToken(32);
  const now = Date.now();
  db.insert('sessions', { id: sha256(token), user_id: user.id, created_at: now, expires_at: now + SESSION_DAYS * 86400e3, ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
  setCookie(res, COOKIE, token, { secure: secure(), maxAge: SESSION_DAYS * 86400 });
}

// Jeton personnel (Paramètres › Intégrations) : utilisable par Claude (MCP) et par l'API, avec les droits de la personne
function userFromToken(req, pathToken) {
  const h = req.headers.authorization || '';
  const token = pathToken || (h.startsWith('Bearer ') ? h.slice(7).trim() : '');
  if (!token) return null;
  const row = db.get('SELECT * FROM api_tokens WHERE token_hash = ?', sha256(token));
  if (!row) return null;
  const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', row.user_id);
  if (user) db.update('api_tokens', row.id, { last_used_at: Date.now() });
  return user;
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return (req.url || '').startsWith('/api/') ? userFromToken(req) : null;
  const s = db.get('SELECT * FROM sessions WHERE id = ?', sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  const u = db.get('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  return u || null;
}

// Une seule équipe : chaque compte actif a tous les droits
function can(user) {
  return Boolean(user && user.active);
}

// Middlewares
function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Connexion requise.');
}
const requireArea = (area) => (req) => {
  requireUser(req);
  if (!can(req.user, area)) throw new HttpError(403, 'Accès refusé.');
};

function register(router) {
  // --- Google ---
  router.get('/auth/google', (req, res) => {
    if (!googleEnabled()) return redirect(res, '/login?erreur=' + encodeURIComponent("La connexion Google n'est pas activée : utilisez votre mot de passe."));
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
      const user = admitGoogle(claims.email, req);
      startSession(res, user, req);
      redirect(res, '/');
    } catch (e) {
      fail(e.status ? e.message : 'Connexion Google impossible pour le moment.');
      if (!e.status) console.error(e);
    }
  });

  // --- Mot de passe ---
  router.post('/auth/login', (req, res) => {
    const email = normEmail(req.body.email);
    if (!isEmail(email) || !req.body.password) throw new HttpError(400, 'Adresse et mot de passe, s’il vous plaît.');
    if (!rate.hit('login-ip:' + clientIp(req), 20, 600e3)) throw new HttpError(429, 'Trop d’essais. Réessayez dans quelques minutes.');
    if (failuresBlocked(db, 'login:' + email)) throw new HttpError(429, 'Trop de mots de passe faux pour cette adresse aujourd’hui : demandez au gérant de le changer.');
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    // Même réponse que l'adresse existe ou non
    if (!user || !user.password_hash || !checkPassword(req.body.password, user.password_hash)) {
      recordFailure(db, 'login:' + email);
      throw new HttpError(400, 'Adresse ou mot de passe incorrect.');
    }
    if (!user.active) throw new HttpError(403, 'Ce compte est désactivé. Demandez au gérant de le réactiver.');
    db.update('users', user.id, { last_login_at: settings.now(), last_login_method: 'mot de passe', last_login_ip: clientIp(req) });
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

// Ferme toutes les sessions d'un compte (mot de passe changé, compte désactivé)
function closeSessions(userId, exceptReq = null) {
  const keep = exceptReq ? parseCookies(exceptReq)[COOKIE] : null;
  if (keep) db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, sha256(keep));
  else db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

module.exports = { userFromToken, register, currentUser, requireUser, requireArea, can, hashPassword, checkPassword, validPassword, closeSessions, googleEnabled, COOKIE };
