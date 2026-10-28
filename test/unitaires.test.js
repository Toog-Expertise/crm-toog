'use strict';
// Tests des briques sans serveur : prix, PDF, PNG, CSV, créneaux d'envoi, contraste.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-unit-'));
process.env.NODE_ENV = 'test';
const db = require('../src/db');
db.open();
const settings = require('../src/settings');
const pricing = require('../src/pricing');
const { PDF, loadImage, wrap } = require('../src/pdf');
const { parseCsv } = require('../src/importer');
const reminders = require('../src/reminders');
const util = require('../src/util');

test('totaux : HT, TVA, TTC et acompte', () => {
  const t = pricing.totals([{ label: 'A', qty: 12, unit_cents: 1700, vat_rate: 20 }, { label: 'B', qty: 1, unit_cents: 1000, vat_rate: 10 }], 30);
  assert.equal(t.total_ttc, 21400);
  assert.equal(t.total_ht, 17000 + 909);
  assert.equal(t.total_vat, 21400 - 17909);
  assert.equal(t.deposit_cents, 6420);
});

test('devis automatique : minimum de personnes, maximum et options', () => {
  const now = Date.now();
  const id = db.insert('products', { name: 'Partie', pricing: 'per_person', price_cents: 5000, vat_rate: 20, min_people: 4, max_people: 60, public: 1, deal_types: 'autre', created_at: now, updated_at: now });
  const opt = db.insert('products', { name: 'Boissons', pricing: 'per_person', price_cents: 300, vat_rate: 20, is_option: 1, public: 1, created_at: now, updated_at: now });
  const r = pricing.autoQuote({ product_id: id, people: 10, options: [opt] });
  assert.equal(r.total_ttc, 10 * 5000 + 10 * 300);
  const small = pricing.autoQuote({ product_id: id, people: 2 });
  assert.equal(small.total_ttc, 4 * 5000);
  assert.match(small.notes[0], /Minimum 4/);
  assert.throws(() => pricing.autoQuote({ product_id: id, people: 61 }), /60 personnes/);
});

test('PDF valide, multi-pages, avec accents et euro', () => {
  const pdf = new PDF();
  pdf.text(50, 50, 'Été : 1 204,00 € « devis »', { size: 12 });
  pdf.addPage();
  pdf.paragraph(50, 50, 'Une très longue ligne '.repeat(40), 400);
  const buf = pdf.output();
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(buf.toString('latin1'), /\/Count 2/);
  assert.ok(buf.toString('latin1').trimEnd().endsWith('%%EOF'));
  assert.ok(wrap('mot '.repeat(100), 100, 10).length > 5);
});

test('lecture PNG (RVB + transparence)', () => {
  // PNG 2x1 : un pixel rouge opaque, un pixel transparent
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 0]);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const img = loadImage(png);
  assert.equal(img.w, 2);
  assert.deepEqual([...img.rgb.subarray(0, 3)], [255, 0, 0]);
  assert.equal(img.alpha[1], 0);
});

test('CSV : point-virgule, guillemets, lignes vides', () => {
  const rows = parseCsv('﻿Nom;Mail\n"Dupont; fils";a@b.fr\n\n"Le ""Grand""";c@d.fr\n');
  assert.deepEqual(rows, [['Nom', 'Mail'], ['Dupont; fils', 'a@b.fr'], ['Le "Grand"', 'c@d.fr']]);
});

test('relances : jamais le dimanche, de 9 h à 19 h (heure de Paris)', () => {
  const sat20h = util.parisToTs(2026, 11, 14, 20, 0); // samedi 14 novembre 2026, 20 h
  const slot = reminders.nextSlot(sat20h);
  const p = util.parisParts(slot);
  assert.equal(p.weekday, 1); // lundi
  assert.equal(p.hour, 9);
  const tue7h = util.parisToTs(2026, 11, 17, 7, 30);
  assert.equal(util.parisParts(reminders.nextSlot(tue7h)).hour, 9);
  const wed15h = util.parisToTs(2026, 11, 18, 15, 0);
  assert.equal(reminders.nextSlot(wed15h), wed15h);
});

test('couleurs : contraste refusé et proposition lisible', () => {
  const bad = { primary: '#7B2CBF', secondary: '#C724A8', accent: '#6EDC3F', background: '#0D0A1A', card: '#1E1838', text: '#3A3550' };
  const issues = settings.checkColors(bad);
  assert.ok(issues.length >= 1);
  const fixed = { ...bad, text: issues[0].suggestion };
  assert.equal(settings.checkColors(fixed).length, 0);
  assert.equal(settings.checkColors(settings.DEFAULTS.colors).length, 0);
});

test('écrans : aucun fichier JavaScript en erreur de syntaxe', () => {
  const { execFileSync } = require('node:child_process');
  const dir = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(dir, f)]);
});

test('IBAN : clé de contrôle ; Sirene : fiche lue', () => {
  const payments = require('../src/payments');
  assert.equal(payments.validIban('FR76 3000 6000 0112 3456 7890 189'), true);
  assert.equal(payments.validIban('FR76 3000 6000 0112 3456 7890 188'), false);
  const s = require('../src/sirene').pick({ siren: '306138900', nom_raison_sociale: 'EXEMPLE', siege: { siret: '30613890000000', adresse: '1 RUE TEST 59000 LILLE', libelle_commune: 'LILLE', etat_administratif: 'A' }, activite_principale: '70.10Z' });
  assert.deepEqual([s.name, s.siret, s.city, s.naf, s.active], ['EXEMPLE', '30613890000000', 'LILLE', '70.10Z', true]);
});
