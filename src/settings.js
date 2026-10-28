'use strict';
// Paramètres de l'entreprise, enregistrés dans la base (jamais dans le code).
// Les valeurs par défaut sont neutres : chaque entreprise règle les siennes dans l'assistant de démarrage.
const db = require('./db');
const { config } = require('./env');

// Le parcours d'un devis B2B. « Perdu » reste à part (masqué du tableau par défaut).
const STAGES = [
  { key: 'nouvelle', label: 'Demande' },
  { key: 'devis_envoye', label: 'Devis envoyé' },
  { key: 'relance_email', label: 'Relance email' },
  { key: 'relance_tel', label: 'Relance téléphonique' },
  { key: 'signe', label: 'Signé' },
  { key: 'acompte', label: 'Acompte payé' },
  { key: 'realise', label: 'Réalisé' },
  { key: 'paye', label: 'Soldé' },
  { key: 'perdu', label: 'Perdu' },
];
// Avant la signature (pour savoir si une étape « avance »)
const BEFORE_SIGN = ['nouvelle', 'devis_envoye', 'relance_email', 'relance_tel'];

// Une seule équipe : tout le monde a tous les droits (les rôles avancés sont un bonus, hors module)
const AREAS = ['accueil', 'demandes', 'messages', 'contacts', 'devis', 'paiements', 'relances', 'catalogue', 'agenda', 'equipe', 'parametres'];
const ROLES = { gerant: { label: 'Équipe', access: AREAS } };

// Les mails. Les mails automatiques (envoi du devis, relances, M+3, M+12) se règlent dans l'écran Mails auto.
const MAIL_TEMPLATES = {
  devis: { label: 'Envoi du devis', subject: 'Votre devis {{numero}} · {{etablissement}}', body: "Bonjour {{prenom}},\n\nMerci pour votre demande. Voici votre devis {{numero}}, d'un montant de {{montant}}. Vous pouvez le consulter, le valider et régler l'acompte en ligne, en deux minutes :\n{{lien}}\n\nDécouvrez notre plaquette : collez ici le lien de partage de votre plaquette (Google Drive)\n\nLe devis est valable jusqu'au {{validite}}. Une question ? Répondez à ce mail ou appelez-moi au {{telephone}}.\n\nÀ bientôt,\n{{contact}}\n{{etablissement}}" },
  relance_devis: { label: 'Relance signature 1', subject: 'Votre devis {{numero}} : on vous garde le créneau ?', body: "Bonjour {{prenom}},\n\nJe reviens vers vous au sujet de votre devis {{numero}} ({{montant}}). Nous avons besoin d'un peu de visibilité sur notre planning : sans validation de votre part, votre créneau du {{date}} va être relâché.\n\nVous pouvez valider le devis en ligne ici :\n{{lien}}\n\n{{contact}}\n{{etablissement}}" },
  relance_devis_2: { label: 'Relance signature 2', subject: 'Votre devis {{numero}} expire dans 2 jours', body: "Bonjour {{prenom}},\n\nVotre devis {{numero}} expire le {{validite}}. Pour garder votre date, il suffit de le valider maintenant :\n{{lien}}\n\nPassé ce délai, le devis ne sera plus valable.\n\n{{contact}}\n{{etablissement}}" },
  relance_acompte: { label: 'Relance acompte 1', subject: 'Votre réservation du {{date}} n’est pas encore confirmée', body: "Bonjour {{prenom}},\n\nMerci d'avoir validé votre devis {{numero}}. Votre réservation ne sera définitive qu'à réception de l'acompte de {{acompte}}. Sans paiement, je devrai libérer la date pour d'autres clients.\n\nRégler l'acompte :\n{{lien}}\n\n{{contact}}\n{{etablissement}}" },
  relance_acompte_2: { label: 'Relance acompte 2', subject: 'Il vous reste 24 h pour confirmer votre réservation', body: "Bonjour {{prenom}},\n\nIl vous reste 24 h pour régler l'acompte de {{acompte}} et confirmer votre réservation du {{date}}.\n\nUn souci avec le paiement ? Appelez-moi au {{telephone}} : on le fait ensemble, en deux minutes.\n{{lien}}\n\n{{contact}}\n{{etablissement}}" },
  merci: { label: 'M+3 : merci', subject: 'Merci encore, {{prenom}}', body: "Bonjour {{prenom}},\n\nIl y a trois mois, vous étiez chez nous avec votre équipe. Merci encore pour votre confiance !\n\nPour vous remercier, vos salariés et leur famille bénéficient de 10 % de réduction chez nous, avec le code MERCI10. N'hésitez pas à faire passer le message.\n\nÀ bientôt,\n{{contact}}\n{{etablissement}}" },
  un_an: { label: 'M+12 : il y a un an', subject: 'Il y a un an, vous étiez chez nous', body: "Bonjour {{prenom}},\n\nL'an dernier, le {{date}}, vous êtes venus chez nous avec vos collègues. Et si on remettait ça cette année ?\n\nPour votre retour, nous vous offrons 10 % de réduction sur votre prochain événement. Répondez simplement à ce mail ou appelez-moi au {{telephone}}.\n\nÀ bientôt,\n{{contact}}\n{{etablissement}}" },
  // Mails de service (non désactivables)
  confirmation: { label: 'Devis validé (au client)', subject: 'Votre devis {{numero}} est validé', body: "Bonjour {{prenom}},\n\nMerci, votre devis {{numero}} est validé. Vous le trouverez en pièce jointe.\n\nPour confirmer votre réservation, il reste l'acompte de {{acompte}} à régler :\n{{lien}}\n\n{{contact}}\n{{etablissement}}" },
  recu: { label: 'Reçu de paiement', subject: 'Paiement reçu : {{montant}}', body: 'Bonjour {{prenom}},\n\nNous avons bien reçu votre paiement de {{montant}} ({{libelle}}). Merci !\n\n{{contact}}\n{{etablissement}}' },
  lien_paiement: { label: 'Lien de paiement', subject: 'Votre lien de paiement', body: 'Bonjour {{prenom}},\n\nVoici le lien pour régler {{libelle}}, soit {{montant}} :\n{{lien}}\n\n{{contact}}\n{{etablissement}}' },
  signe_equipe: { label: "Devis validé (pour l'équipe)", subject: 'Devis {{numero}} validé par {{client}}', body: "Le devis {{numero}} ({{montant}}) vient d'être validé par {{client}}. Le PDF signé est en pièce jointe.\n\nOuvrir la fiche : {{lien}}" },
  alerte_equipe: { label: "Nouvelle demande (pour l'équipe)", subject: 'Nouvelle demande : {{titre}}', body: "Une nouvelle demande vient d'arriver ({{source}}).\n\n{{resume}}\n\nOuvrir la fiche : {{lien}}" },
  accuse_reception: { label: 'Accusé de réception', subject: 'Nous avons bien reçu votre demande', body: 'Bonjour {{prenom}},\n\nMerci pour votre demande. Nous revenons vers vous très vite.\n\n{{contact}}\n{{etablissement}}' },
  relance_manuelle: { label: 'Relance manuelle', subject: '{{etablissement}} : votre devis', body: 'Bonjour {{prenom}},\n\n{{message}}\n\n{{contact}}\n{{etablissement}}' },
};
// Les mails automatiques de l'écran Mails auto, dans l'ordre du parcours
const AUTO_MAILS = ['devis', 'relance_devis', 'relance_devis_2', 'relance_acompte', 'relance_acompte_2', 'merci', 'un_an'];

// B2B uniquement : chaque demande vient d'une entreprise, d'un CSE ou d'une association
const DEAL_TYPES = [
  { key: 'entreprise', label: 'Entreprise (séminaire, team building)', people_label: 'Nombre de personnes', fields: [{ key: 'societe', label: 'Entreprise', type: 'text', required: true, company: true }, { key: 'poste', label: 'Votre poste', type: 'text' }] },
  { key: 'cse', label: 'CSE / comité d’entreprise', people_label: 'Nombre de personnes', fields: [{ key: 'societe', label: 'Entreprise du CSE', type: 'text', required: true, company: true }, { key: 'poste', label: 'Votre poste', type: 'text' }] },
  { key: 'association', label: 'Association, école, club', people_label: 'Nombre de personnes', fields: [{ key: 'societe', label: 'Nom de la structure', type: 'text', required: true, company: true }, { key: 'poste', label: 'Votre fonction', type: 'text' }] },
];

const DEFAULTS = {
  // Tout ce qui figure sur les devis : identité, mentions légales, contact affiché sur la page de validation
  company: { name: 'Mon entreprise', legal_name: '', legal_form: '', capital: '', address: '', phone: '', email: '', website: '', siret: '', rcs: '', vat_number: '', tagline: '', contact_name: '', contact_phone: '', presentation: '', highlights: '' },
  colors: { primary: '#5B4BDB', secondary: '#B03FBF', accent: '#4ADE80', background: '#0F0F17', card: '#1C1B2B', text: '#E6E4F0' },
  fonts: { title: 'Lexend Deca', text: 'DM Sans', title_uppercase: true },
  logo: '',
  access: { allowed_domain: '', google: false },
  quotes: {
    deposit_mode: 'pct', deposit_pct: 30, deposit_fixed_cents: 0, default_vat: 20, validity_days: 30, number_prefix: 'D',
    number_start: 1,         // la numérotation peut reprendre où l'ancienne s'est arrêtée (ex. 232)
    conditions: "Prix TTC. Taux de TVA à faire valider par le comptable. Acompte et modalités d'annulation : à définir.",
    legal_mentions: '',
  },
  // Mails automatiques (écran Mails auto) : actif ou non, et quand
  reminders: {
    sign1: { enabled: true, days: 3 },             // relance signature 1 : J+3 après l'envoi du devis
    sign2: { enabled: true, days_before: 2 },      // relance signature 2 : 2 jours avant la fin de validité
    dep1: { enabled: true, days: 3 },              // relance acompte 1 : J+3 après la signature
    dep2: { enabled: true, due_days: 7 },          // l'acompte est attendu sous 7 jours ; relance 2 la veille
    m3: { enabled: true, months: 3 },              // merci : 3 mois après le paiement total
    m12: { enabled: true, months: 12 },            // il y a un an : 12 mois après l'événement
    devis: { enabled: true },
    window: { start: 9, end: 19, sunday: false },
  },
  // Les tiroirs de paiement : virement classique (RIB), Stripe (carte et virement suivi), Pennylane (module à part)
  payments: { rib: true, stripe: false, stripe_transfer: true, pennylane: false, holder: '', iban: '', bic: '', transfer_note: 'Merci d’indiquer le numéro du devis en référence du virement.' },
  mails: {},                 // modèles modifiés ; sinon MAIL_TEMPLATES
  deal_types: DEAL_TYPES,
  integrations: { site_url: '', calendar_id: '', event_duration_min: 120, sirene: false },   // sirene : option « recherche d'entreprise »
  rgpd: { retention_years: 3 },
  setup_done: false,
  demo: false,
  clock_offset_ms: 0,
};

let cache = null;

function load() {
  cache = {};
  for (const r of db.all('SELECT key, value FROM settings')) {
    try { cache[r.key] = JSON.parse(r.value); } catch { /* valeur ignorée */ }
  }
  return cache;
}

function get(key) {
  if (!cache) load();
  const d = DEFAULTS[key];
  const v = cache[key];
  if (v === undefined) {
    if (key === 'access') return { ...d, allowed_domain: config.allowedDomain };
    return structuredClone(d);
  }
  if (d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v)) return deepMerge(structuredClone(d), v);
  return v;
}

function set(key, value) {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  if (!cache) load();
  cache[key] = value;
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) a[k] = deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

function allowedDomain() {
  return (get('access').allowed_domain || config.allowedDomain || '').toLowerCase().replace(/^@/, '');
}

function mailTemplate(key) {
  const custom = get('mails')[key] || {};
  const base = MAIL_TEMPLATES[key];
  return { ...base, ...custom };
}

// L'horloge du CRM : décalable par l'administrateur pour tester les relances.
function now() {
  return Date.now() + (Number(get('clock_offset_ms')) || 0);
}

// --- Couleurs : contraste WCAG ---
function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(rgb) {
  const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const la = luminance(hexToRgb(a)), lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Propose la couleur la plus proche qui respecte le contraste demandé (contre une ou plusieurs couleurs),
// en éclaircissant sur fond sombre ou en assombrissant sur fond clair.
function nearestContrast(color, against, min) {
  const list = [].concat(against);
  const rgb = hexToRgb(color);
  const lighter = luminance(hexToRgb(list[0])) < 0.5;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = rgb.map((v) => Math.round(lighter ? v + (255 - v) * t : v * (1 - t)));
    const hex = '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (list.every((a) => contrast(hex, a) >= min)) return hex;
  }
  return lighter ? '#FFFFFF' : '#000000';
}

// Vérifie un jeu de couleurs. Renvoie la liste des problèmes, avec une proposition pour chacun.
function checkColors(c) {
  const issues = [];
  for (const k of ['primary', 'secondary', 'accent', 'background', 'card', 'text']) {
    if (!hexToRgb(c[k])) issues.push({ key: k, message: `Couleur « ${k} » invalide (format #RRGGBB).` });
  }
  if (issues.length) return issues;
  const pairs = [
    ['text', 'background', 4.5, 'le texte sur le fond'],
    ['text', 'card', 4.5, 'le texte sur les cartes'],
    ['accent', 'card', 3, "l'accent sur les cartes"],
  ];
  for (const [fg, bg, min, label] of pairs) {
    const r = contrast(c[fg], c[bg]);
    // La proposition respecte toutes les règles de cette couleur à la fois
    const against = pairs.filter((p) => p[0] === fg && p[2] === min).map((p) => c[p[1]]);
    if (r < min) issues.push({ key: fg, message: `Contraste insuffisant pour ${label} (${r.toFixed(1)} : 1, minimum ${min} : 1).`, suggestion: nearestContrast(c[fg], against, min) });
  }
  // Texte blanc sur le bouton principal
  const rb = contrast('#FFFFFF', c.primary);
  if (rb < 3) issues.push({ key: 'primary', message: `Le texte blanc est peu lisible sur la couleur principale (${rb.toFixed(1)} : 1, minimum 3 : 1).`, suggestion: nearestContrast(c.primary, '#FFFFFF', 3) });
  return issues;
}

module.exports = {
  STAGES, BEFORE_SIGN, ROLES, AREAS, MAIL_TEMPLATES, AUTO_MAILS, DEFAULTS,
  get, set, load, allowedDomain, mailTemplate, now,
  hexToRgb, contrast, checkColors, nearestContrast,
  stageLabel: (k) => (STAGES.find((s) => s.key === k) || { label: k }).label,
  dealTypes: () => get('deal_types'),
  dealTypeLabel: (k) => ((get('deal_types').find((t) => t.key === k)) || { label: k }).label,
};
