'use strict';
// Visites du site par l'API Data de Google Analytics 4, mises en cache une heure.
const google = require('./google');
const { config } = require('./env');

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const cache = new Map();

const enabled = () => Boolean(config.ga4Property && google.serviceAccount());

function ymd(ts) { return new Date(ts).toISOString().slice(0, 10); }

async function report(body) {
  return google.api('POST', `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(config.ga4Property)}:runReport`, SCOPE, body);
}

// Visites sur la période, 8 dernières semaines, et sources
async function overview(from, to) {
  if (!enabled()) return { enabled: false };
  const key = `${ymd(from)}_${ymd(to)}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  try {
    const weeksFrom = to - 8 * 7 * 86400e3;
    const [total, weeks, sources] = await Promise.all([
      report({ dateRanges: [{ startDate: ymd(from), endDate: ymd(to) }], metrics: [{ name: 'sessions' }] }),
      report({ dateRanges: [{ startDate: ymd(weeksFrom), endDate: ymd(to) }], dimensions: [{ name: 'isoYearIsoWeek' }], metrics: [{ name: 'sessions' }], orderBys: [{ dimension: { dimensionName: 'isoYearIsoWeek' } }] }),
      report({ dateRanges: [{ startDate: ymd(from), endDate: ymd(to) }], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 6 }),
    ]);
    const val = (r) => Number(r.metricValues?.[0]?.value || 0);
    const data = {
      enabled: true,
      visits: total.rows?.length ? val(total.rows[0]) : 0,
      weeks: (weeks.rows || []).map((r) => ({ week: 'S' + String(r.dimensionValues[0].value).slice(4), visits: val(r) })).slice(-8),
      sources: (sources.rows || []).map((r) => ({ source: r.dimensionValues[0].value, visits: val(r) })),
    };
    cache.set(key, { exp: Date.now() + 3600e3, data });
    return data;
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}

async function status() {
  if (!config.ga4Property) return { ok: false, label: 'propriété non renseignée' };
  if (!google.serviceAccount()) return { ok: false, label: 'compte de service absent' };
  try {
    await report({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] });
    return { ok: true, label: 'propriété liée' };
  } catch (e) {
    return { ok: false, label: e.status === 403 ? 'accès refusé (compte de service à ajouter dans Analytics)' : 'erreur', error: e.message };
  }
}

module.exports = { overview, status, enabled };
