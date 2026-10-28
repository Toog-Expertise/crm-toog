'use strict';
const crypto = require('node:crypto');

const TZ = 'Europe/Paris';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 20400 -> « 204,00 € »
function money(cents) {
  if (cents === null || cents === undefined) return 'sur devis';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100).replace(/ | /g, ' ');
}

const fmt = (opts) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, ...opts });
const dateShort = (ts) => (ts ? fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(ts) : '');
const dateLong = (ts) => (ts ? fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ts) : '');
const dateTime = (ts) => (ts ? fmt({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ts).replace(' ', ' à ') : '');
function dateEvent(ts) {
  if (!ts) return '';
  const p = parisParts(ts);
  const d = fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(ts);
  return p.minute ? `${d}, ${p.hour} h ${String(p.minute).padStart(2, '0')}` : `${d}, ${p.hour} h`;
}

// Heure de Paris pour un instant donné
function parisParts(ts) {
  const parts = {};
  for (const p of fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(ts)) parts[p.type] = p.value;
  const wd = { 'lun.': 1, 'mar.': 2, 'mer.': 3, 'jeu.': 4, 'ven.': 5, 'sam.': 6, 'dim.': 0 }[parts.weekday];
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, weekday: wd };
}

// Instant correspondant à une date et heure de Paris
function parisToTs(year, month, day, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const p = parisParts(guess);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = asUtc - guess;
  let ts = guess - offset;
  // Réajuste au changement d'heure
  const p2 = parisParts(ts);
  if (p2.hour !== hour) ts += (hour - p2.hour) * 3600e3;
  return ts;
}

// « 2026-11-15T14:00 » (heure de Paris) -> instant
function parseLocalDateTime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return parisToTs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
}
function toLocalInput(ts) {
  if (!ts) return '';
  const p = parisParts(ts);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

function startOfParisDay(ts) {
  const p = parisParts(ts);
  return parisToTs(p.year, p.month, p.day, 0, 0);
}

function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+33')) d = '0' + d.slice(3);
  else if (d.startsWith('0033')) d = '0' + d.slice(4);
  return d.replace(/\D/g, '') || null;
}

const normEmail = (e) => (String(e || '').trim().toLowerCase() || null);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

function fullName(c) {
  if (!c) return '';
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '';
}

// Remplace {{champ}} par sa valeur
function fill(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
}

// Au plus 20 codes faux par 24 h pour une même clé (adresse ou devis), puis blocage
const FAIL_MAX = 20;
function failuresBlocked(db, key) {
  return db.get('SELECT COUNT(*) n FROM code_failures WHERE key = ? AND at > ?', key, Date.now() - 86400e3).n >= FAIL_MAX;
}
function recordFailure(db, key) {
  db.run('INSERT INTO code_failures (key, at) VALUES (?, ?)', key, Date.now());
  db.run('DELETE FROM code_failures WHERE at < ?', Date.now() - 2 * 86400e3);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

module.exports = {
  failuresBlocked, recordFailure, TZ, sha256, randomToken, randomCode, hmac, safeEqual, escapeHtml, money,
  dateShort, dateLong, dateTime, dateEvent, parisParts, parisToTs, parseLocalDateTime, toLocalInput, startOfParisDay,
  normPhone, normEmail, isEmail, fullName, fill, HttpError,
};
