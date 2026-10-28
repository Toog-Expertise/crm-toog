'use strict';
// Compte de service Google (Analytics Data API et Google Agenda), sans bibliothèque : jeton JWT signé RS256.
const crypto = require('node:crypto');
const { config } = require('./env');

let account = null;
function serviceAccount() {
  if (account !== null) return account;
  const raw = config.serviceAccount;
  if (!raw) return (account = false);
  try {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    account = j.client_email && j.private_key ? j : false;
  } catch {
    console.error('GOOGLE_SERVICE_ACCOUNT_JSON illisible : attendu le JSON de la clé, encodé en base64.');
    account = false;
  }
  return account;
}

const tokens = new Map();

async function accessToken(scope) {
  const sa = serviceAccount();
  if (!sa) throw new Error('Compte de service Google absent du .env.');
  const cached = tokens.get(scope);
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Google : ${data.error_description || data.error || r.status}`);
  tokens.set(scope, { token: data.access_token, exp: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

async function api(method, url, scope, body) {
  const token = await accessToken(scope);
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Google : ${data.error?.message || r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

module.exports = { serviceAccount, accessToken, api, email: () => serviceAccount()?.client_email || null };
