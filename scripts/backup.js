'use strict';
// Sauvegarde : base (copie cohérente), logo et PDF, dans backups/. Copie hors du serveur si BACKUP_REMOTE est réglé.
//   npm run backup              sauvegarde
//   npm run backup -- --verifier   restaure la dernière sauvegarde sur une copie, la vérifie, puis supprime la copie
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../src/env');

const dir = path.join(config.root, 'backups');
fs.mkdirSync(dir, { recursive: true });
const KEEP = 14;

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
}

function backup() {
  const dbFile = path.join(config.dataDir, 'crm.db');
  if (!fs.existsSync(dbFile)) throw new Error(`Base introuvable : ${dbFile}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sauvegarde-'));
  try {
    const db = new DatabaseSync(dbFile);
    db.exec(`VACUUM INTO '${path.join(tmp, 'crm.db').replace(/'/g, "''")}'`);
    db.close();
    for (const sub of ['uploads', 'pdf']) {
      const src = path.join(config.dataDir, sub);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, sub), { recursive: true });
    }
    const out = path.join(dir, `crm-${stamp()}.tar.gz`);
    execFileSync('tar', ['-czf', out, '-C', tmp, '.']);
    fs.chmodSync(out, 0o600);
    console.log(`Sauvegarde : ${out}`);
    if (config.backupRemote) {
      execFileSync('rsync', ['-a', out, config.backupRemote.replace(/\/?$/, '/')], { stdio: 'inherit' });
      console.log(`Copiée hors du serveur : ${config.backupRemote}`);
    }
    // Ne garde que les dernières
    const all = fs.readdirSync(dir).filter((f) => /^crm-\d{8}-\d{4}\.tar\.gz$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, f));
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function verify() {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).sort();
  if (!all.length) throw new Error('Aucune sauvegarde à vérifier.');
  const last = path.join(dir, all[all.length - 1]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-verif-'));
  try {
    execFileSync('tar', ['-xzf', last, '-C', tmp]);
    const db = new DatabaseSync(path.join(tmp, 'crm.db'), { readOnly: true });
    const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const n = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const ageH = Math.round((Date.now() - fs.statSync(last).mtimeMs) / 3600e3);
    console.log(`Sauvegarde ${path.basename(last)} (il y a ${ageH} h) : intégrité ${ok} · ${n('contacts')} contacts, ${n('deals')} demandes, ${n('quotes')} devis, ${n('payments')} paiements.`);
    db.close();
    if (ok !== 'ok') process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('Copie de vérification supprimée.');
  }
}

try {
  if (process.argv.includes('--verifier')) verify();
  else backup();
} catch (e) {
  console.error('Sauvegarde en échec :', e.message);
  process.exit(1);
}
