'use strict';
// Routeur minimal, lecture des requêtes, cookies et fichiers statiques.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');

const MAX_BODY = 12 * 1024 * 1024; // 12 Mo (import de fichiers, logo)

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handlers: r.handlers, params };
      }
    }
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Fichier trop volumineux.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(req, raw) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  if (!raw.length) return {};
  if (type === 'application/json') {
    try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'JSON invalide.'); }
  }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  return {};
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie mal formé : ignoré */ }
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite || 'Lax'}`];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : [prev]), parts.join('; ')]);
}

function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
}
const json = (res, data, status = 200) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
const html = (res, body, status = 200, headers = {}) => send(res, status, body, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
const redirect = (res, to) => send(res, 302, '', 'text/plain', { Location: to });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.json': 'application/json', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

function serveFile(res, file, cache = 'no-cache') {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveStatic(res, root, pathname) {
  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root + path.sep)) return false;
  return serveFile(res, file);
}

// Politique de sécurité du contenu ; frameAncestors : qui peut afficher la page dans un cadre
function csp(frameAncestors = "'none'") {
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

// Les PDF : la visionneuse du navigateur a besoin d'une politique réduite (affichage dans le CRM seulement)
const PDF_CSP = "frame-ancestors 'self'";

function clientIp(req) {
  // Derrière Caddy (même machine), l'adresse réelle est dans X-Forwarded-For
  const fwd = req.headers['x-forwarded-for'];
  const remote = req.socket.remoteAddress || '';
  if (fwd && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return fwd.split(',')[0].trim();
  return remote.replace(/^::ffff:/, '');
}

module.exports = { csp, PDF_CSP, Router, readBody, parseBody, parseCookies, setCookie, send, json, html, redirect, serveFile, serveStatic, clientIp };
