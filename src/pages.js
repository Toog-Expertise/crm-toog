'use strict';
// Gabarit des pages publiques (formulaire, devis automatique, signature, paiement) et feuille de thème.
const settings = require('./settings');
const { escapeHtml } = require('./util');

const fontHref = (name, weights) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}${weights ? `:wght@${weights}` : ''}&display=swap`;

function fontLinks() {
  const f = settings.get('fonts');
  return [fontHref(f.title), fontHref(f.title, '700'), fontHref(f.text, '400;600;700')]
    .map((h) => `<link rel="stylesheet" href="${escapeHtml(h)}">`).join('\n');
}

// Couleurs et polices réglées dans les paramètres -> variables CSS
function themeCss() {
  const c = settings.get('colors');
  const f = settings.get('fonts');
  const rgb = (hex) => (settings.hexToRgb(hex) || [0, 0, 0]).join(', ');
  return `:root{
  --primary:${c.primary};--secondary:${c.secondary};--accent:${c.accent};
  --bg:${c.background};--card:${c.card};--text:${c.text};
  --primary-rgb:${rgb(c.primary)};--secondary-rgb:${rgb(c.secondary)};--accent-rgb:${rgb(c.accent)};--text-rgb:${rgb(c.text)};--card-rgb:${rgb(c.card)};
  --grad:linear-gradient(90deg, ${c.primary}, ${c.secondary});
  --font-title:'${String(f.title).replace(/'/g, '')}', system-ui, sans-serif;
  --font-text:'${String(f.text).replace(/'/g, '')}', system-ui, sans-serif;
  --title-transform:${f.title_uppercase === false ? 'none' : 'uppercase'};
}`;
}

function page({ title, body, scripts = [], bodyClass = 'public' }) {
  const company = settings.get('company');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · ${escapeHtml(company.name)}</title>
${fontLinks()}
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/static/style.css">
${settings.get('logo') ? '<link rel="icon" href="/logo">' : ''}
</head>
<body class="${bodyClass}">
${body}
${scripts.map((s) => `<script src="${escapeHtml(s)}" defer></script>`).join('\n')}
</body>
</html>`;
}

function logoTag(cls = 'pub-logo') {
  const company = settings.get('company');
  return settings.get('logo')
    ? `<img class="${cls}" src="/logo" alt="${escapeHtml(company.name)}">`
    : `<div class="${cls} pub-logo-text">${escapeHtml(company.name)}</div>`;
}

function message(title, text, { tone = '', extra = '' } = {}) {
  return page({ title, body: `<main class="pub"><div class="pub-card">${logoTag()}<h1>${escapeHtml(title)}</h1><p class="${tone}">${escapeHtml(text)}</p>${extra}</div></main>` });
}

module.exports = { page, themeCss, fontLinks, logoTag, message };
