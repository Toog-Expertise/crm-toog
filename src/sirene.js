'use strict';
// Fiche entreprise remplie depuis la base Sirene de l'INSEE, par l'API publique « Recherche d'entreprises »
// (recherche-entreprises.api.gouv.fr) : gratuite, sans clé, à partir du nom, du SIREN ou du SIRET.
const { HttpError } = require('./util');

const URL_API = 'https://recherche-entreprises.api.gouv.fr/search';
const cache = new Map();

function pick(r) {
  const s = r.siege || {};
  return {
    name: r.nom_raison_sociale || r.nom_complet || '',
    siren: r.siren || '',
    siret: s.siret || '',
    address: s.adresse || [s.numero_voie, s.type_voie, s.libelle_voie, s.code_postal, s.libelle_commune].filter(Boolean).join(' '),
    city: s.libelle_commune || '',
    naf: r.activite_principale || s.activite_principale || '',
    active: (r.etat_administratif || s.etat_administratif) !== 'F',
  };
}

async function search(q) {
  const query = String(q || '').trim().replace(/\s+/g, ' ');
  const digits = query.replace(/\s/g, '');
  if (query.length < 3) return [];
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - 600e3) return hit.list;
  const url = `${URL_API}?q=${encodeURIComponent(/^\d{9,14}$/.test(digits) ? digits : query)}&per_page=6&page=1`;
  let r;
  try {
    r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  } catch {
    throw new HttpError(502, 'La base Sirene ne répond pas : réessayez dans un instant.');
  }
  if (r.status === 429) throw new HttpError(429, 'Trop de recherches Sirene : patientez quelques secondes.');
  if (!r.ok) throw new HttpError(502, 'La base Sirene ne répond pas : réessayez dans un instant.');
  const d = await r.json().catch(() => ({}));
  const list = (d.results || []).map(pick);
  cache.set(key, { at: Date.now(), list });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return list;
}

module.exports = { search, pick };
