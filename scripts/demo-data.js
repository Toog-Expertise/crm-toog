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
  });
  settings.set('demo', false);
  console.log(`${ids.length} contact(s) TEST supprimé(s), avec leurs demandes, devis et paiements. Prix d'exemple retirés.`);
  process.exit(0);
}

if (db.get('SELECT COUNT(*) n FROM deals').n > 0 && !process.argv.includes('--forcer')) {
  console.error('La base contient déjà des demandes : rien n’est ajouté (option --forcer pour passer outre).');
  process.exit(1);
}

// Catalogue : uniquement des PRIX D'EXEMPLE (à remplacer par les vrais dans le CRM)
const t = now;
const product = (p) => db.insert('products', { description: '', vat_rate: 20, deal_types: '', public: 0, example: 1, active: 1, sort: 0, is_option: 0, created_at: t, updated_at: t, ...p });
if (!db.get('SELECT 1 FROM products LIMIT 1')) {
  product({ name: 'Partie · 2 parties', description: 'Prix d’exemple : 50 € par personne', pricing: 'per_person', price_cents: 5000, min_people: 4, max_people: 60, deal_types: 'entreprise,evjf-evg,association,autre', public: 1, sort: 1 });
  product({ name: 'Formule anniversaire enfant', description: '2 activités, goûter et boissons, cadeau surprise', pricing: 'per_person', price_cents: 1500, min_people: 4, max_people: 20, deal_types: 'anniversaire', public: 1, sort: 2 });
  product({ name: 'Option boissons', description: 'Une boisson par personne', pricing: 'per_person', price_cents: 300, is_option: 1, public: 1, sort: 3 });
  product({ name: 'Privatisation de salle', description: 'Sur devis', pricing: 'quote', price_cents: null, deal_types: 'entreprise', sort: 4, example: 0 });
}

const mk = (input, stage, extra = {}) => {
  const r = deals.createDeal({ consent: true, ...input });
  db.update('deals', r.id, { created_at: extra.created || now - 2 * day, ...(extra.deal || {}) });
  if (stage !== 'nouvelle') deals.setStage(r.id, stage);
  return r.id;
};

const d1 = mk({ type: 'anniversaire', name: 'Claire TEST', email: 'famille.test@exemple.fr', phone: '06 00 00 00 01', people: 12, event_at: at(18), data: { age: '8 ans', prenom_enfant: 'Léo' }, source: 'site', source_page: '/anniversaire/' }, 'nouvelle', { created: now - 3 * 3600e3 });
const d2 = mk({ type: 'entreprise', name: 'Paul TEST', email: 'contact@societe-exemple.fr', phone: '06 00 00 00 02', people: 40, event_at: at(30, 18), data: { societe: 'Société Exemple TEST', budget: '30 à 50 €' }, source: 'site', source_page: '/entreprise/' }, 'nouvelle');
const d3 = mk({ type: 'evjf-evg', name: 'Julie TEST', email: 'julie.test@exemple.fr', people: 9, event_at: at(25, 15), data: { prenom_star: 'Marie' }, source: 'telephone' }, 'a_rappeler');
const d4 = mk({ type: 'anniversaire', name: 'Martin TEST', email: 'martin.test@exemple.fr', phone: '06 00 00 00 04', people: 10, event_at: at(12), data: { age: '7 ans', prenom_enfant: 'Emma' }, source: 'accueil' }, 'nouvelle');
const d5 = mk({ type: 'association', name: 'École TEST', email: 'ecole.test@exemple.fr', people: 25, event_at: at(40, 10), data: { societe: 'École Exemple TEST' }, source: 'salon' }, 'nouvelle');

// Un devis envoyé (sans mail réel : envoi direct en base)
const q = quotes.createQuote(d4, null);
db.update('quotes', q.id, { status: 'sent', sent_at: now - day, sign_token: require('../src/util').randomToken(32), sign_expires_at: now + 29 * day });
quotes.freeze(quotes.getQuote(q.id));
deals.setStage(d4, 'devis_envoye');
require('../src/reminders').onQuoteSent(quotes.getQuote(q.id));
activity.log({ deal_id: d4, kind: 'quote', text: `Devis ${q.number} envoyé (données d'exemple)` });

// Deux mails reçus, pour voir l'écran Messages
const inbox = require('../src/inbox');
inbox.receive({ email_id: 'demo-1', from: 'Julie TEST <julie.test@exemple.fr>', to: ['reponses@exemple.fr'], subject: 'Re: Votre demande EVJF', text: "Bonjour,\n\nC'est bon pour nous, on serait 9. Est-ce qu'on peut avoir une salle à part pour le gâteau ?\n\nMerci,\nJulie\n\nLe 26 oct. 2026 à 10:12, Bowling a écrit :\n> Bonjour Julie…" });
inbox.receive({ email_id: 'demo-2', from: 'Marc TEST <marc.test@exemple.fr>', to: ['reponses@exemple.fr'], subject: 'Privatisation pour 30 personnes', text: 'Bonjour,\n\nNous cherchons un lieu pour un pot de départ un vendredi soir, 30 personnes. Avez-vous des disponibilités en décembre ?\n\nMarc' });

settings.set('demo', true);
console.log(`Données TEST ajoutées : 5 demandes, 1 devis envoyé (${q.number}), catalogue de prix d'exemple.`);
console.log('Pour tout retirer avant la vraie mise en service : npm run demo -- --supprimer');
void d1; void d2; void d3; void d5;
