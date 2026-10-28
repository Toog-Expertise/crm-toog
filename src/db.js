'use strict';
// Base SQLite intégrée à Node (node:sqlite) et migrations numérotées.
// Une migration ajoutée ici s'applique toute seule au démarrage (et via update.sh).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./env');

const MIGRATIONS = [
  // 1 : schéma initial
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'accueil',          -- gerant | accueil | animation
    active INTEGER NOT NULL DEFAULT 1,
    invited_by INTEGER,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    last_login_method TEXT,
    last_login_ip TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                           -- empreinte SHA-256 du jeton du cookie
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT, ua TEXT
  );
  CREATE TABLE login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    siret TEXT, address TEXT, phone TEXT, email TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    email TEXT, phone TEXT, phone_norm TEXT,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    source TEXT, consent_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );
  CREATE INDEX contacts_email ON contacts(email);
  CREATE INDEX contacts_phone ON contacts(phone_norm);

  CREATE TABLE deals (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    type TEXT NOT NULL DEFAULT 'autre',
    title TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'nouvelle',
    source TEXT NOT NULL DEFAULT 'crm',            -- site | devis_auto | telephone | accueil | salon | crm | import | api
    source_page TEXT,
    event_at INTEGER,                              -- date et heure de la venue
    people INTEGER,
    data TEXT NOT NULL DEFAULT '{}',               -- champs du formulaire propres au type
    message TEXT,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    lost_reason TEXT,
    reminders_paused INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX deals_stage ON deals(stage);

  CREATE TABLE activities (
    id INTEGER PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,                            -- note | stage | mail | quote | payment | sign | reminder | system | call
    text TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activities_deal ON activities(deal_id, created_at);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_at INTEGER,
    done_at INTEGER,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pricing TEXT NOT NULL DEFAULT 'per_person',    -- per_person | flat | quote (sur devis)
    is_option INTEGER NOT NULL DEFAULT 0,          -- option ajoutée à une prestation
    price_cents INTEGER,                           -- prix TTC ; NULL = sur devis
    vat_rate REAL NOT NULL DEFAULT 20,
    min_people INTEGER, max_people INTEGER,
    deal_types TEXT NOT NULL DEFAULT '',           -- types de demande concernés, séparés par des virgules
    public INTEGER NOT NULL DEFAULT 0,             -- proposé dans le devis automatique
    example INTEGER NOT NULL DEFAULT 0,            -- PRIX D'EXEMPLE
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    number TEXT UNIQUE,
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft',          -- draft | sent | signed | cancelled
    object TEXT NOT NULL DEFAULT '',
    lines TEXT NOT NULL DEFAULT '[]',
    total_ht INTEGER NOT NULL DEFAULT 0,
    total_vat INTEGER NOT NULL DEFAULT 0,
    total_ttc INTEGER NOT NULL DEFAULT 0,
    deposit_pct REAL NOT NULL DEFAULT 30,
    deposit_cents INTEGER NOT NULL DEFAULT 0,
    conditions TEXT NOT NULL DEFAULT '',
    issued_at INTEGER, valid_until INTEGER,
    view_token TEXT UNIQUE,                        -- lien en ligne, sans compte
    sign_token TEXT UNIQUE,                        -- lien secret de signature
    sign_expires_at INTEGER,
    sign_code_hash TEXT, sign_code_expires_at INTEGER, sign_code_attempts INTEGER NOT NULL DEFAULT 0,
    sign_code_validated_at INTEGER,
    signed_at INTEGER, signer_name TEXT, signer_email TEXT, signer_ip TEXT, signer_ua TEXT,
    quote_sha256 TEXT, signed_pdf_sha256 TEXT,
    sent_at INTEGER, viewed_at INTEGER,
    created_by INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX quotes_deal ON quotes(deal_id);

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,                            -- deposit | balance | free | test
    label TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL,
    refunded_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',        -- pending | paid | failed | refunded | partially_refunded | cancelled
    pay_token TEXT UNIQUE,
    stripe_session_id TEXT, stripe_payment_intent TEXT,
    livemode INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at INTEGER NOT NULL, sent_at INTEGER, paid_at INTEGER, refunded_at INTEGER
  );
  CREATE INDEX payments_pi ON payments(stripe_payment_intent);

  CREATE TABLE emails (
    id INTEGER PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    to_addr TEXT NOT NULL,
    template TEXT NOT NULL,
    subject TEXT NOT NULL,
    provider_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',          -- queued | sent | delivered | opened | clicked | bounced | complained | failed | simulated
    error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX emails_provider ON emails(provider_id);

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
    rule TEXT NOT NULL,                            -- quote_unsigned | deposit_unpaid | after_visit | no_answer | manual
    step INTEGER NOT NULL DEFAULT 1,
    channel TEXT NOT NULL DEFAULT 'mail',          -- mail | call | alert
    label TEXT NOT NULL,
    template TEXT,
    message TEXT,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',      -- scheduled | sent | paused | cancelled | error
    sent_at INTEGER, error TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_due ON reminders(status, due_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    people INTEGER,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',      -- confirmed | cancelled
    gcal_id TEXT, gcal_synced_at INTEGER, gcal_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT 'Claude',
    created_at INTEGER NOT NULL, last_used_at INTEGER
  );

  CREATE TABLE pending_actions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,                            -- send_quote | send_reminder | refund | delete_deal
    label TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',        -- pending | done | refused | error
    result TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER, decided_by INTEGER
  );

  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `,
  // 2 : échecs de code (connexion, signature), comptés dans la base pour résister aux redémarrages
  `
  CREATE TABLE code_failures (key TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX code_failures_key ON code_failures(key, at);
  `,
];

let db;

function open(file) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(file || path.join(config.dataDir, 'crm.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Petites aides
const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Insertion à partir d'un objet
function insert(table, obj) {
  const keys = Object.keys(obj);
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => obj[k]));
  return Number(r.lastInsertRowid);
}

function update(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => obj[k]), id);
}

function nextCounter(name) {
  run('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', name);
  return get('SELECT value FROM counters WHERE name = ?', name).value;
}

module.exports = {
  open, get, all, run, tx, insert, update, nextCounter,
  get db() { return db; },
  schemaVersion: () => MIGRATIONS.length,
};
