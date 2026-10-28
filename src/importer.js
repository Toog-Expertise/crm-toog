'use strict';
// Import de contacts : CSV (virgule ou point-virgule) ou Excel .xlsx (première feuille), avec aperçu avant import.
const zlib = require('node:zlib');
const db = require('./db');
const deals = require('./deals');
const settings = require('./settings');
const activity = require('./activity');
const { normEmail, normPhone, isEmail, HttpError } = require('./util');

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.includes('\t') ? '\t' : ',');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// --- Lecture minimale d'un .xlsx (zip + XML) ---
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(400, 'Fichier Excel illisible.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lstart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(lstart, lstart + csize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');

function parseXlsx(buf) {
  const files = unzip(buf);
  const shared = files['xl/sharedStrings.xml'] ? [...files['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, ''))) : [];
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))[0];
  if (!sheetName) throw new HttpError(400, 'Aucune feuille dans ce fichier Excel.');
  const rows = [];
  for (const rm of files[sheetName]().matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
      const col = ref.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = (attrs.match(/t="(\w+)"/) || [])[1];
      let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (t === 's') v = shared[Number(v)];
      else if (t === 'inlineStr') v = xmlText((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
      else if (v !== undefined) v = xmlText(v);
      row[col >= 0 ? col : row.length] = v ?? '';
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

const FIELDS = {
  first_name: ['prénom', 'prenom', 'first name', 'firstname'],
  last_name: ['nom', 'last name', 'lastname', 'nom de famille'],
  name: ['nom complet', 'name', 'client', 'contact'],
  email: ['mail', 'email', 'e-mail', 'adresse mail', 'courriel'],
  phone: ['téléphone', 'telephone', 'tél', 'tel', 'portable', 'mobile', 'phone'],
  company: ['entreprise', 'société', 'societe', 'company', 'organisation', 'association'],
};

function guessMapping(header) {
  const map = {};
  header.forEach((h, i) => {
    const k = String(h).trim().toLowerCase();
    for (const [field, names] of Object.entries(FIELDS)) if (!(field in map) && names.includes(k)) map[field] = i;
  });
  return map;
}

function readFile(filename, base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'Fichier vide.');
  const rows = /\.xlsx$/i.test(filename) ? parseXlsx(buf) : parseCsv(buf.toString('utf8'));
  if (rows.length < 2) throw new HttpError(400, 'Le fichier doit contenir une ligne de titres et au moins un contact.');
  return rows;
}

function toContact(row, map) {
  const v = (f) => (map[f] !== undefined && map[f] !== null && map[f] !== '' ? String(row[map[f]] ?? '').trim() : '');
  const c = { first_name: v('first_name'), last_name: v('last_name'), email: v('email'), phone: v('phone'), company: v('company') };
  if (!c.first_name && !c.last_name && v('name')) Object.assign(c, deals.splitName(v('name')));
  return c;
}

// Aperçu : ce qui sera créé, complété ou ignoré
function preview(filename, base64, mapping) {
  const rows = readFile(filename, base64);
  const header = rows[0].map(String);
  const map = mapping || guessMapping(header);
  const seen = new Set();
  const items = rows.slice(1, 2001).map((r) => {
    const c = toContact(r, map);
    const key = normEmail(c.email) || normPhone(c.phone);
    let action = 'créer';
    if (!c.email && !c.phone) action = 'ignorer (ni mail ni téléphone)';
    else if (c.email && !isEmail(c.email)) action = 'ignorer (mail invalide)';
    else if (seen.has(key)) action = 'ignorer (doublon dans le fichier)';
    else if (deals.findContact(c)) action = 'compléter (déjà dans le CRM)';
    if (key) seen.add(key);
    return { ...c, action };
  });
  const count = (a) => items.filter((i) => i.action.startsWith(a)).length;
  return { header, mapping: map, total: items.length, create: count('créer'), update: count('compléter'), skip: count('ignorer'), items: items.slice(0, 50), truncated: rows.length > 2001 };
}

function commit(filename, base64, mapping, user) {
  const p = preview(filename, base64, mapping);
  const rows = readFile(filename, base64).slice(1, 2001);
  let created = 0, updated = 0;
  db.tx(() => {
    for (const r of rows) {
      const c = toContact(r, p.mapping);
      if ((!c.email && !c.phone) || (c.email && !isEmail(c.email))) continue;
      const res = deals.upsertContact({ ...c, source: 'import' });
      res.created ? created++ : updated++;
    }
  });
  activity.log({ user_id: user.id, kind: 'system', text: `Import de ${filename} : ${created} contact(s) créé(s), ${updated} complété(s) (${user.name})` });
  return { created, updated, skipped: p.total - created - updated };
}

module.exports = { parseCsv, parseXlsx, preview, commit, guessMapping };
