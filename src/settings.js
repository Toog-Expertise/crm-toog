'use strict';
// Paramètres de l'entreprise, enregistrés dans la base (jamais dans le code).
// Les valeurs par défaut sont neutres : chaque entreprise règle les siennes dans l'assistant de démarrage.
const db = require('./db');
const { config } = require('./env');

const STAGES = [
  { key: 'nouvelle', label: 'Nouvelle demande' },
  { key: 'a_rappeler', label: 'À rappeler' },
  { key: 'devis_envoye', label: 'Devis envoyé' },
  { key: 'signature', label: 'Signature demandée' },
  { key: 'signe', label: 'Signé' },
  { key: 'acompte', label: 'Acompte payé' },
  { key: 'paye', label: 'Payé' },
  { key: 'perdu', label: 'Perdu' },
];

const ROLES = {
  gerant: { label: 'Gérant', access: ['accueil', 'demandes', 'messages', 'contacts', 'devis', 'paiements', 'relances', 'catalogue', 'agenda', 'equipe', 'parametres'] },
  accueil: { label: 'Accueil', access: ['accueil', 'demandes', 'messages', 'contacts', 'devis', 'paiements', 'relances', 'catalogue', 'agenda'] },
  animation: { label: 'Animation', access: ['agenda'] },
};

const MAIL_TEMPLATES = {
  alerte_equipe: { label: "Alerte à l'équipe", subject: 'Nouvelle demande : {{titre}}', body: "Une nouvelle demande vient d'arriver ({{source}}).\n\n{{resume}}\n\nOuvrir la fiche : {{lien}}" },
  alerte_sans_reponse: { label: 'Alerte demande sans réponse', subject: 'Sans réponse : {{titre}}', body: "La demande « {{titre}} » de {{client}} attend une réponse depuis {{delai}}.\n\nOuvrir la fiche : {{lien}}" },
  accuse_reception: { label: 'Accusé de réception', subject: 'Nous avons bien reçu votre demande', body: 'Bonjour {{prenom}},\n\nMerci pour votre demande. Nous revenons vers vous très vite.\n\nÀ bientôt,\n{{entreprise}}' },
  devis: { label: 'Devis', subject: 'Votre devis {{numero}}', body: "Bonjour {{prenom}},\n\nVoici votre devis {{numero}}, d'un montant de {{montant}}. Vous le trouverez en pièce jointe, et vous pouvez le consulter et le signer en ligne :\n{{lien}}\n\nIl est valable jusqu'au {{validite}}.\n\nÀ bientôt,\n{{entreprise}}" },
  demande_signature: { label: 'Demande de signature', subject: 'Votre devis {{numero}} à signer', body: "Bonjour {{prenom}},\n\nVotre devis {{numero}} ({{montant}}) est prêt à être signé en ligne. Un code vous sera envoyé par mail pour confirmer votre signature :\n{{lien}}\n\nCe lien est valable 30 jours.\n\n{{entreprise}}" },
  code_signature: { label: 'Code de signature', subject: 'Votre code de signature : {{code}}', body: 'Bonjour {{prenom}},\n\nVotre code pour signer le devis {{numero}} : {{code}}\n\nIl est valable 10 minutes. Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce mail.\n\n{{entreprise}}' },
  confirmation: { label: 'Confirmation de signature', subject: 'Votre devis {{numero}} est signé', body: "Bonjour {{prenom}},\n\nMerci, votre devis {{numero}} est signé. Vous trouverez le devis signé en pièce jointe.\n\nPour bloquer la date, il reste l'acompte de {{montant}} à régler :\n{{lien}}\n\nÀ bientôt,\n{{entreprise}}" },
  lien_paiement: { label: 'Lien de paiement', subject: 'Votre lien de paiement', body: 'Bonjour {{prenom}},\n\nVoici le lien pour régler {{libelle}}, soit {{montant}} :\n{{lien}}\n\nPaiement sécurisé par Stripe.\n\n{{entreprise}}' },
  recu: { label: 'Reçu de paiement', subject: 'Paiement reçu : {{montant}}', body: 'Bonjour {{prenom}},\n\nNous avons bien reçu votre paiement de {{montant}} ({{libelle}}). Merci !\n\nÀ bientôt,\n{{entreprise}}' },
  invitation: { label: "Invitation d'équipe", subject: 'Votre accès au CRM {{entreprise}}', body: 'Bonjour,\n\n{{invite_par}} vous donne accès au CRM de {{entreprise}}. Connectez-vous avec votre adresse {{email}} :\n{{lien}}' },
  code_connexion: { label: 'Code de connexion', subject: 'Votre code de connexion : {{code}}', body: 'Bonjour,\n\nVotre code pour vous connecter au CRM : {{code}}\n\nOu cliquez sur ce lien :\n\n{{lien}}\n\nIl est valable 10 minutes. Si vous n\'avez rien demandé, ignorez ce mail.' },
  signe_equipe: { label: "Devis signé (pour l'équipe)", subject: 'Devis {{numero}} signé par {{client}}', body: 'Le devis {{numero}} ({{montant}}) vient d\'être signé par {{client}}. Le PDF signé est en pièce jointe.\n\nOuvrir la fiche : {{lien}}' },
  relance_devis: { label: 'Relance devis non signé', subject: 'Votre devis {{numero}}', body: 'Bonjour {{prenom}},\n\nAvez-vous pu consulter votre devis {{numero}} ? Vous pouvez le signer en ligne :\n{{lien}}\n\nNous restons à votre disposition pour toute question.\n\n{{entreprise}}' },
  relance_acompte: { label: 'Rappel acompte', subject: 'Votre réservation du {{date}}', body: "Bonjour {{prenom}},\n\nPour confirmer votre réservation du {{date}}, il reste l'acompte de {{montant}} à régler :\n{{lien}}\n\n{{entreprise}}" },
  avis: { label: 'Merci et avis Google', subject: 'Merci de votre venue', body: "Bonjour {{prenom}},\n\nMerci d'être venus ! Si vous avez passé un bon moment, votre avis nous aiderait beaucoup :\n{{lien}}\n\nÀ bientôt,\n{{entreprise}}" },
  relance_manuelle: { label: 'Relance manuelle', subject: '{{entreprise}} : votre demande', body: 'Bonjour {{prenom}},\n\n{{message}}\n\n{{entreprise}}' },
};

const DEAL_TYPES = [
  { key: 'anniversaire', label: 'Anniversaire', people_label: "Nombre d'enfants", fields: [{ key: 'age', label: "Âge de l'enfant", type: 'text' }, { key: 'prenom_enfant', label: "Prénom de l'enfant", type: 'text' }] },
  { key: 'evjf-evg', label: 'EVJF / EVG', people_label: 'Nombre de personnes', fields: [{ key: 'prenom_star', label: 'Prénom de la future mariée ou du futur marié', type: 'text' }] },
  { key: 'entreprise', label: 'Entreprise', people_label: 'Nombre de personnes', fields: [{ key: 'societe', label: 'Société', type: 'text', required: true, company: true }, { key: 'budget', label: 'Budget par personne', type: 'text' }] },
  { key: 'association', label: 'Association', people_label: 'Nombre de personnes', fields: [{ key: 'societe', label: 'Association ou école', type: 'text', required: true, company: true }] },
  { key: 'autre', label: 'Autre', people_label: 'Nombre de personnes', fields: [] },
];

const DEFAULTS = {
  company: { name: 'Mon entreprise', legal_name: '', address: '', phone: '', email: '', website: '', siret: '', vat_number: '', tagline: '' },
  colors: { primary: '#5B4BDB', secondary: '#B03FBF', accent: '#4ADE80', background: '#0F0F17', card: '#1C1B2B', text: '#E6E4F0' },
  fonts: { title: 'Lexend Deca', text: 'DM Sans', title_uppercase: true },
  logo: '',
  access: { allowed_domain: '' },
  quotes: {
    deposit_pct: 30, default_vat: 20, validity_days: 30, number_prefix: 'D',
    conditions: "Prix TTC. Taux de TVA à faire valider par le comptable. Acompte et modalités d'annulation : à définir.",
    legal_mentions: '',
  },
  reminders: {
    quote_unsigned: { enabled: true, mail_days: [3, 7], call_day: 14 },
    deposit_unpaid: { enabled: true, days: [2] },
    after_visit: { enabled: true, days: 1, review_url: '' },
    no_answer: { enabled: true, hours: 24 },
    window: { start: 9, end: 19, sunday: false },
  },
  mails: {},                 // modèles modifiés ; sinon MAIL_TEMPLATES
  deal_types: DEAL_TYPES,
  integrations: { site_url: '', calendar_id: '', event_duration_min: 120 },
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
  STAGES, ROLES, MAIL_TEMPLATES, DEFAULTS,
  get, set, load, allowedDomain, mailTemplate, now,
  hexToRgb, contrast, checkColors, nearestContrast,
  stageLabel: (k) => (STAGES.find((s) => s.key === k) || { label: k }).label,
  dealTypes: () => get('deal_types'),
  dealTypeLabel: (k) => ((get('deal_types').find((t) => t.key === k)) || { label: k }).label,
};
