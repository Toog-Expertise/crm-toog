'use strict';
// Agenda du CRM et synchronisation avec un agenda Google (compte de service, droit « Modifier les événements »).
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const google = require('./google');
const deals = require('./deals');
const { fullName, dateEvent } = require('./util');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const calendarId = () => settings.get('integrations').calendar_id || '';
const enabled = () => Boolean(calendarId() && google.serviceAccount());

function eventBody(ev) {
  const deal = ev.deal_id ? db.get('SELECT * FROM deals WHERE id = ?', ev.deal_id) : null;
  const c = deal ? deals.contactOf(deal) : null;
  const desc = [
    deal ? settings.dealTypeLabel(deal.type) : null,
    ev.people ? `${ev.people} personnes` : null,
    c ? `Contact : ${fullName(c)}${c.phone ? ` · ${c.phone}` : ''}${c.email ? ` · ${c.email}` : ''}` : null,
    ev.notes || null,
  ].filter(Boolean).join('\n');
  return {
    summary: ev.title, description: desc,
    start: { dateTime: new Date(ev.start_at).toISOString(), timeZone: 'Europe/Paris' },
    end: { dateTime: new Date(ev.end_at).toISOString(), timeZone: 'Europe/Paris' },
  };
}

// Ajoute, modifie ou supprime l'événement Google correspondant
async function sync(eventId) {
  const ev = db.get('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev || !enabled()) return;
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events`;
  try {
    if (ev.status === 'cancelled') {
      if (ev.gcal_id) await google.api('DELETE', `${base}/${encodeURIComponent(ev.gcal_id)}`, SCOPE).catch((e) => { if (e.status !== 404 && e.status !== 410) throw e; });
      db.update('events', ev.id, { gcal_id: null, gcal_synced_at: Date.now(), gcal_error: null });
      return;
    }
    if (ev.gcal_id) {
      await google.api('PATCH', `${base}/${encodeURIComponent(ev.gcal_id)}`, SCOPE, eventBody(ev));
      db.update('events', ev.id, { gcal_synced_at: Date.now(), gcal_error: null });
    } else {
      const r = await google.api('POST', base, SCOPE, eventBody(ev));
      db.update('events', ev.id, { gcal_id: r.id, gcal_synced_at: Date.now(), gcal_error: null });
    }
  } catch (e) {
    db.update('events', ev.id, { gcal_error: e.message });
    throw e;
  }
}

// À l'acompte payé : la réservation entre dans l'agenda
async function onDepositPaid(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  if (!deal || !deal.event_at) return;
  let ev = db.get("SELECT * FROM events WHERE deal_id = ? AND status = 'confirmed'", deal.id);
  const dur = (settings.get('integrations').event_duration_min || 120) * 60e3;
  const c = deals.contactOf(deal);
  const title = `${deal.title}${c ? ` · ${fullName(c)}` : ''}`;
  if (!ev) {
    const now = settings.now();
    const id = db.insert('events', { deal_id: deal.id, title, start_at: deal.event_at, end_at: deal.event_at + dur, people: deal.people, status: 'confirmed', created_at: now, updated_at: now });
    activity.log({ deal_id: deal.id, kind: 'system', text: `Réservation ajoutée à l'agenda : ${dateEvent(deal.event_at)}` });
    ev = db.get('SELECT * FROM events WHERE id = ?', id);
  }
  if (enabled()) {
    await sync(ev.id);
    activity.log({ deal_id: deal.id, kind: 'system', text: 'Réservation synchronisée avec Google Agenda' });
  }
}

// Suit les changements de la demande (date, nombre, perte)
async function onDealChanged(dealId) {
  const deal = db.get('SELECT * FROM deals WHERE id = ?', dealId);
  const ev = db.get("SELECT * FROM events WHERE deal_id = ? AND status = 'confirmed'", dealId);
  if (!deal || !ev) return;
  const dur = ev.end_at - ev.start_at;
  if (deal.stage === 'perdu') db.update('events', ev.id, { status: 'cancelled', updated_at: settings.now() });
  else if (deal.event_at && (deal.event_at !== ev.start_at || deal.people !== ev.people)) db.update('events', ev.id, { start_at: deal.event_at, end_at: deal.event_at + dur, people: deal.people, updated_at: settings.now() });
  else return;
  if (enabled()) await sync(ev.id).catch((e) => console.error('Agenda :', e.message));
}

async function status() {
  if (!calendarId()) return { ok: false, label: "ID de l'agenda non renseigné" };
  if (!google.serviceAccount()) return { ok: false, label: 'compte de service absent' };
  try {
    await google.api('GET', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?maxResults=1`, SCOPE);
    return { ok: true, label: 'agenda partagé' };
  } catch (e) {
    return { ok: false, label: e.status === 404 || e.status === 403 ? "agenda non partagé avec le compte de service" : 'erreur', error: e.message };
  }
}

module.exports = { sync, onDepositPaid, onDealChanged, status, enabled };
