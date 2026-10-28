'use strict';
// Données d'exemple, toutes marquées TEST, pour essayer le CRM ou le montrer en formation.
//   npm run demo                 ajoute les données (base sans demande seulement)
//   npm run demo -- --supprimer  retire toutes les données TEST (avant la vraie mise en service)
const db = require('../src/db');
const settings = require('../src/settings');

db.open();
settings.load();
const deals = require('../src/deals');
const quotes = require('../src/quotes');
const activity = require('../src/activity');

const now = Date.now();
const day = 86400e3;
const at = (days, hour = 14) => { const d = new Date(now + days * day); d.setHours(hour, 0, 0, 0); return d.getTime(); };

if (process.argv.includes('--supprimer')) {
  const ids = db.all("SELECT c.id FROM contacts c WHERE c.last_name LIKE '%TEST%' OR c.first_name LIKE '%TEST%' OR c.email LIKE '%@exemple.fr' OR c.email LIKE '%@example.com'").map((r) => r.id);
  db.tx(() => {
    for (const id of ids) {
      for (const d of db.all('SELECT id FROM deals WHERE contact_id = ?', id)) db.run('DELETE FROM deals WHERE id = ?', d.id);
      db.run('DELETE FROM emails WHERE contact_id = ?', id);
      db.run('DELETE FROM activities WHERE contact_id = ?', id);
      db.run('DELETE FROM contacts WHERE id = ?', id);
    }
    db.run("DELETE FROM companies WHERE name LIKE '%TEST%' OR name LIKE '%Exemple%'");
    db.run('DELETE FROM products WHERE example = 1');
    db.run("DELETE FROM payments WHERE kind = 'test' OR deal_id IS NULL AND label LIKE '%test%'");
    db.run('DELETE FROM events WHERE deal_id IS NULL AND title LIKE \'%TEST%\'');
    db.run("DELETE FROM messages WHERE from_addr LIKE '%@exemple.fr' OR from_addr LIKE '%@exemple.org' OR to_addr LIKE '%@exemple.fr' OR from_name LIKE '%TEST%'");
  });
  settings.set('demo', false);
  console.log(`${ids.length} contact(s) TEST supprimé(s), avec leurs demandes, devis et paiements. Prix d'exemple retirés.`);
  process.exit(0);
}

if (db.get('SELECT COUNT(*) n FROM deals').n > 0 && !process.argv.includes('--forcer')) {
  console.error('La base contient déjà des demandes : rien n’est ajouté (option --forcer pour passer outre).');
  process.exit(1);
}

// Catalogue B2B : uniquement des PRIX D'EXEMPLE (à remplacer par les vrais dans le CRM)
const t = now;
const product = (p) => db.insert('products', { description: '', vat_rate: 20, deal_types: '', public: 0, example: 1, active: 1, sort: 0, is_option: 0, created_at: t, updated_at: t, ...p });
if (!db.get('SELECT 1 FROM products WHERE example = 1 LIMIT 1')) {
  product({ name: 'Team building bowling · 2 parties', description: 'Prix d’exemple : 50 € TTC par personne', pricing: 'per_person', price_cents: 5000, min_people: 8, max_people: 80, public: 1, sort: 1 });
  product({ name: 'Séminaire · salle et laser game', description: 'Prix d’exemple : salle privée, laser game, pause', pricing: 'per_person', price_cents: 6500, min_people: 10, max_people: 60, public: 1, sort: 2 });
  product({ name: 'Option apéritif dînatoire', description: 'Par personne', pricing: 'per_person', price_cents: 1800, is_option: 1, public: 1, sort: 3 });
  if (!db.get("SELECT 1 FROM products WHERE name = 'Privatisation de salle'")) product({ name: 'Privatisation de salle', description: 'Sur devis', pricing: 'quote', price_cents: null, sort: 4, example: 0 });
}
const bowling = db.get("SELECT id FROM products WHERE name LIKE 'Team building%' LIMIT 1")?.id;
const seminaire = db.get("SELECT id FROM products WHERE name LIKE 'Séminaire%' LIMIT 1")?.id;

const mk = (input, stage, extra = {}) => {
  const r = deals.createDeal({ consent: true, ...input });
  db.update('deals', r.id, { created_at: extra.created || now - 2 * day, postit: extra.postit || null, ...(extra.deal || {}) });
  if (stage !== 'nouvelle') deals.setStage(r.id, stage);
  return r.id;
};
const reminders = require('../src/reminders');
const util = require('../src/util');
const send = (dealId, daysAgo) => {
  const q = quotes.createQuote(dealId, null);
  db.update('quotes', q.id, { status: 'sent', sent_at: now - daysAgo * day, sign_token: util.randomToken(32), sign_expires_at: now + (30 - daysAgo) * day, valid_until: now + (30 - daysAgo) * day });
  quotes.freeze(quotes.getQuote(q.id));
  deals.setStage(dealId, 'devis_envoye');
  reminders.onQuoteSent(quotes.getQuote(q.id));
  activity.log({ deal_id: dealId, kind: 'quote', text: `Devis ${q.number} envoyé (données d'exemple)` });
  return quotes.getQuote(q.id);
};

const d1 = mk({ type: 'entreprise', first_name: 'Claire', last_name: 'TEST', email: 'claire.test@exemple.fr', phone: '06 00 00 00 01', people: 25, event_at: at(18, 18), data: { societe: 'Agence Exemple TEST', poste: 'office manager' }, product_id: bowling, source: 'site', source_page: '/entreprise/' }, 'nouvelle', { created: now - 3 * 3600e3, postit: 'Afterwork de fin d’année, veut finir par un apéro' });
const d2 = mk({ type: 'entreprise', first_name: 'Paul', last_name: 'TEST', email: 'contact@societe-exemple.fr', phone: '06 00 00 00 02', people: 40, event_at: at(30, 18), data: { societe: 'Société Exemple TEST', poste: 'DRH' }, product_id: seminaire, source: 'site' }, 'nouvelle', { postit: 'Séminaire annuel, salle privée le matin' });
const d3 = mk({ type: 'cse', first_name: 'Julie', last_name: 'TEST', email: 'julie.test@exemple.fr', people: 30, event_at: at(25, 15), data: { societe: 'CSE Industrie TEST', poste: 'secrétaire du CSE' }, product_id: bowling, source: 'telephone' }, 'nouvelle');
const d4 = mk({ type: 'entreprise', first_name: 'Martin', last_name: 'TEST', email: 'martin.test@exemple.fr', phone: '06 00 00 00 04', people: 12, event_at: at(12), data: { societe: 'Cabinet Exemple TEST', poste: 'associé' }, product_id: bowling, source: 'accueil' }, 'nouvelle');
const d5 = mk({ type: 'association', first_name: 'Inès', last_name: 'TEST', email: 'ecole.test@exemple.fr', people: 25, event_at: at(40, 10), data: { societe: 'École Exemple TEST', poste: 'directrice' }, product_id: bowling, source: 'salon' }, 'nouvelle');

// Devis envoyés : un en attente, un relancé par mail, un relancé par téléphone
const q4 = send(d4, 1);
const q3 = send(d3, 5);
deals.setStage(d3, 'relance_email');
db.run("UPDATE reminders SET status = 'sent', sent_at = ? WHERE deal_id = ? AND rule = 'quote_unsigned' AND step = 1", now - day, d3);
const q5 = send(d5, 6);
reminders.logCall(d5, { outcome: 'message', note: "Message laissé à l'accueil de l'école, rappeler jeudi (données d'exemple)" });

// Une entreprise qui a validé son devis et payé son acompte par virement (tiroir RIB)
const q2 = quotes.createQuote(d2, null);
db.update('quotes', q2.id, { status: 'signed', sent_at: now - 7 * day, signed_at: now - 5 * day, signer_name: 'Paul TEST', signer_first_name: 'Paul', signer_last_name: 'TEST', signer_company: 'Société Exemple TEST', signer_role: 'DRH', signer_agreement: 'Bon pour accord', sign_token: util.randomToken(32), sign_expires_at: now + 20 * day });
deals.setStage(d2, 'signe');
const dep2 = require('../src/payments').depositFor(quotes.getQuote(q2.id));

// Un mail reçu, pour l'écran Messages (« Pour aller plus loin »)
const inbox = require('../src/inbox');
inbox.receive({ email_id: 'demo-1', from: 'Julie TEST <julie.test@exemple.fr>', to: ['reponses@exemple.fr'], subject: 'Re: Votre devis', text: "Bonjour,\n\nC'est bon pour nous, on serait 30. Peut-on avoir une salle à part pour le pot ?\n\nMerci,\nJulie" });

settings.set('demo', true);
(dep2 ? require('../src/payments').markReceived(dep2.id, { method: 'virement', paid_at: now - 3 * day }) : Promise.resolve()).then(() => {
  console.log(`Données TEST ajoutées : 5 demandes B2B, 4 devis (${q4.number}, ${q3.number}, ${q5.number} envoyés, ${q2.number} validé, acompte reçu par virement), catalogue de prix d'exemple.`);
  console.log('Pour tout retirer avant la vraie mise en service : npm run demo -- --supprimer');
});
void d1;
