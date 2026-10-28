'use strict';
// Côté client : formulaire de demande, devis automatique, API du site, pages de paiement.
// Protection : champ invisible, délai minimum, Turnstile (si clés), limite par minute.
const db = require('./db');
const settings = require('./settings');
const mail = require('./mail');
const deals = require('./deals');
const quotes = require('./quotes');
const pricing = require('./pricing');
const payments = require('./payments');
const rate = require('./ratelimit');
const pages = require('./pages');
const { config } = require('./env');
const { escapeHtml, money, fullName, isEmail, safeEqual, HttpError, dateEvent } = require('./util');
const { html, json, clientIp, csp } = require('./http');

// Les pages intégrables au site (iframe) n'acceptent d'être affichées que par le site et le CRM
function frameHeaders() {
  const site = settings.get('integrations').site_url;
  let origin = '';
  try { if (site) origin = new URL(site).origin; } catch { /* adresse invalide */ }
  return { 'Content-Security-Policy': csp(`'self'${origin ? ' ' + origin : ''}`) };
}

async function verifyTurnstile(token, ip) {
  if (!config.turnstile.secret) return true;
  if (!token) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: config.turnstile.secret, response: token, remoteip: ip }),
  });
  const d = await r.json().catch(() => ({}));
  return Boolean(d.success);
}

async function guard(req) {
  const ip = clientIp(req);
  if (!rate.hit('form:' + ip, 5, 60e3)) throw new HttpError(429, 'Trop d’envois en une minute. Réessayez dans un instant.');
  const b = req.body;
  // Champ invisible rempli ou envoi trop rapide : un robot. On fait semblant d'accepter.
  if (b.website || (b.ts && Date.now() - Number(b.ts) < 2500)) return false;
  if (!(await verifyTurnstile(b['cf-turnstile-response'], ip))) throw new HttpError(400, 'Vérification anti-spam échouée : rechargez la page et réessayez.');
  if (!b.consent) throw new HttpError(400, 'Merci de cocher le consentement.');
  if (!String(b.name || '').trim()) throw new HttpError(400, 'Indiquez votre nom.');
  if (!isEmail(b.email)) throw new HttpError(400, 'Adresse mail invalide.');
  // Pas plus de 3 envois par heure vers une même adresse (le formulaire n'est pas un relais de mails)
  if (!rate.hit('dest:' + String(b.email).trim().toLowerCase(), 3, 3600e3)) throw new HttpError(429, 'Plusieurs demandes viennent déjà d’être envoyées pour cette adresse. Réessayez plus tard.');
  return true;
}

// Alerte à l'équipe et accusé de réception au client
async function notify(dealId, { ack = true } = {}) {
  const deal = deals.getDeal(dealId);
  const c = deals.contactOf(deal) || {};
  const data = pricing.safeJson(deal.data);
  const type = settings.dealTypes().find((t) => t.key === deal.type) || { fields: [] };
  const resume = [
    `Contact : ${fullName(c)}${c.email ? ` · ${c.email}` : ''}${c.phone ? ` · ${c.phone}` : ''}`,
    `Type : ${settings.dealTypeLabel(deal.type)}`,
    deal.people ? `${type.people_label || 'Personnes'} : ${deal.people}` : null,
    deal.event_at ? `Date souhaitée : ${dateEvent(deal.event_at)}` : null,
    ...(type.fields || []).filter((f) => data[f.key]).map((f) => `${f.label} : ${data[f.key]}`),
    deal.message ? `Message : ${deal.message}` : null,
  ].filter(Boolean).join('\n');
  const vars = { titre: `${deal.title} · ${fullName(c)}`, source: deals.SOURCE_LABEL[deal.source] || deal.source, resume, lien: `${config.appUrl}/#/demandes/${deal.id}` };
  const team = db.all("SELECT email FROM users WHERE active = 1 AND role IN ('gerant', 'accueil')").map((u) => u.email);
  if (config.resend.replyTo) team.push(config.resend.replyTo.replace(/^.*<(.+)>$/, '$1'));
  for (const to of new Set(team)) await mail.send({ to, template: 'alerte_equipe', vars, deal_id: deal.id, quiet: true });
  require('./activity').log({ deal_id: deal.id, kind: 'mail', text: `Alerte envoyée à l'équipe (${new Set(team).size} adresse(s))` });
  if (ack && c.email) await mail.send({ to: c.email, template: 'accuse_reception', deal_id: deal.id, contact_id: c.id, vars: { prenom: c.first_name } });
}

function formInput(b, source) {
  return {
    type: b.type, name: b.name, email: b.email, phone: b.phone, event_at: b.event_at, people: b.people,
    message: b.message, consent: Boolean(b.consent), data: b.data || {}, company: b.company,
    source, source_page: String(b.page || '').slice(0, 200) || null,
  };
}

function register(router) {
  // Script à coller dans le site : <script src="https://crm…/embed.js" data-crm="formulaire" data-type="anniversaire"></script>
  router.get('/embed.js', (req, res) => {
    const js = `(function(){var s=document.currentScript;var kind=s.getAttribute('data-crm')||'formulaire';var p=new URLSearchParams();['type','activite'].forEach(function(k){var v=s.getAttribute('data-'+k);if(v)p.set(k,v)});p.set('page',location.pathname);
var f=document.createElement('iframe');f.src=${JSON.stringify(config.appUrl)}+'/'+(kind==='devis'?'devis-auto':'formulaire')+'?'+p.toString();f.title=kind==='devis'?'Devis en ligne':'Formulaire de demande';f.loading='lazy';f.style.cssText='width:100%;max-width:560px;border:0;display:block;margin:0 auto;min-height:620px;border-radius:24px';s.parentNode.insertBefore(f,s);
window.addEventListener('message',function(e){if(e.origin!==${JSON.stringify(new URL(config.appUrl).origin)})return;if(e.data&&e.data.crmHeight&&e.source===f.contentWindow)f.style.height=e.data.crmHeight+'px'});})();`;
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(js);
  });

  router.get('/formulaire', (req, res) => {
    const types = settings.dealTypes();
    const type = types.some((t) => t.key === req.query.get('type')) ? req.query.get('type') : types[0]?.key;
    const body = `<main class="pub embed"><div class="pub-card" id="lead" data-type="${escapeHtml(type)}" data-page="${escapeHtml(req.query.get('page') || '')}" data-ts="${Date.now()}">
      ${pages.logoTag()}
      <h1>Votre<br>demande</h1>
      <script type="application/json" id="lead-types">${JSON.stringify(types).replace(/</g, '\\u003c')}</script>
      <form id="lead-form" novalidate>
        <div class="field"><span>Votre demande concerne</span><div class="chips" id="type-chips"></div></div>
        <div id="type-fields"></div>
        <label class="field"><span>Date souhaitée</span><input type="datetime-local" name="event_at"></label>
        <label class="field"><span>Nom et prénom</span><input name="name" autocomplete="name" required></label>
        <label class="field"><span>Mail</span><input type="email" name="email" autocomplete="email" required></label>
        <label class="field"><span>Téléphone</span><input type="tel" name="phone" autocomplete="tel"></label>
        <label class="field"><span>Message</span><textarea name="message" rows="3"></textarea></label>
        <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="check"><input type="checkbox" name="consent" required><span>J'accepte que mes données soient utilisées pour traiter ma demande, et seulement pour cela.</span></label>
        ${config.turnstile.siteKey ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstile.siteKey)}" data-language="fr"></div>` : ''}
        <p class="error" id="lead-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Envoyer ma demande</button>
      </form>
      <div id="lead-done" hidden><div class="check-circle">✓</div><h2>Demande envoyée</h2><p>Merci ! Nous revenons vers vous très vite. Un accusé de réception vient de vous être envoyé par mail.</p></div>
    </div></main>`;
    const scripts = ['/static/public.js'];
    if (config.turnstile.siteKey) scripts.push('https://challenges.cloudflare.com/turnstile/v0/api.js');
    html(res, pages.page({ title: 'Votre demande', body, scripts }), 200, frameHeaders());
  });

  router.post('/api/public/demande', async (req, res) => {
    if (!(await guard(req))) return json(res, { ok: true });
    const r = deals.createDeal(formInput(req.body, 'site'));
    await notify(r.id);
    json(res, { ok: true });
  });

  // API pour un formulaire du site existant (serveur à serveur), clé SITE_API_KEY
  router.post('/api/public/demandes', async (req, res) => {
    if (!config.siteApiKey || !safeEqual(req.headers['x-api-key'] || '', config.siteApiKey)) throw new HttpError(401, 'Clé API invalide.');
    const r = deals.createDeal(formInput(req.body, 'api'));
    await notify(r.id, { ack: req.body.ack !== false });
    json(res, { ok: true, id: r.id }, 201);
  });

  // --- Devis automatique ---
  router.get('/api/public/catalogue', (req, res) => json(res, pricing.publicCatalog()));

  router.get('/devis-auto', (req, res) => {
    const cat = pricing.publicCatalog();
    const body = `<main class="pub embed"><div class="pub-card" id="auto" data-page="${escapeHtml(req.query.get('page') || '')}" data-activite="${escapeHtml(req.query.get('activite') || '')}" data-ts="${Date.now()}">
      ${pages.logoTag()}
      ${cat.activities.length ? `<div id="auto-app"><h1 id="auto-title">Votre devis<br>en ligne</h1><p class="muted small" id="auto-step"></p><form id="auto-form" novalidate></form></div>` : '<h1>Devis en ligne</h1><p>Le devis en ligne n’est pas encore disponible. Contactez-nous.</p>'}
      ${config.turnstile.siteKey ? `<div id="ts-holder" hidden><div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstile.siteKey)}" data-language="fr"></div></div>` : ''}
    </div></main>`;
    const scripts = ['/static/devis-auto.js'];
    if (config.turnstile.siteKey) scripts.push('https://challenges.cloudflare.com/turnstile/v0/api.js');
    html(res, pages.page({ title: 'Votre devis en ligne', body, scripts }), 200, frameHeaders());
  });

  router.post('/api/public/devis-auto', async (req, res) => {
    if (!(await guard(req))) return json(res, { ok: false, error: 'Envoi refusé.' }, 400);
    const b = req.body;
    // Le serveur recalcule tout depuis le catalogue : le prix du navigateur n'est jamais repris.
    const calc = pricing.autoQuote({ product_id: b.product_id, people: b.people, options: b.options || [] });
    // Type de la demande : celui de l'activité (« autre » si elle en couvre plusieurs). Le client n'a pas vu
    // les questions propres au type : elles ne sont pas exigées ici.
    const types = String(calc.product.deal_types || '').split(',').map((t) => t.trim()).filter(Boolean);
    const type = types.length === 1 ? types[0] : types.includes('autre') || !types.length ? 'autre' : types[0];
    const r = deals.createDeal({ ...formInput(b, 'devis_auto'), type, people: calc.people, title: `${calc.product.name} · ${calc.people} pers.`, data: { options: b.options || [] }, lenient: true });
    const q = quotes.createQuote(r.id, null, calc.lines);
    const sent = await quotes.sendQuote(q.id, null, 'devis');
    await notify(r.id, { ack: false });
    const fresh = quotes.getQuote(q.id);
    json(res, {
      ok: true, number: fresh.number, total: money(fresh.total_ttc), total_cents: fresh.total_ttc,
      deposit: money(fresh.deposit_cents), deposit_pct: fresh.deposit_pct, notes: calc.notes,
      sign_url: `/s/${fresh.sign_token}`, pdf_url: `/s/${fresh.sign_token}/pdf`, mail: sent.mail.status,
    });
  });

  // --- Paiement : /p/… crée la session Stripe au clic ---
  router.get('/p/:token', async (req, res) => {
    const p = db.get('SELECT * FROM payments WHERE pay_token = ?', req.params.token);
    if (!p) return html(res, pages.message('Lien introuvable', "Ce lien de paiement n'existe pas."), 404);
    const amount = `<div class="pub-total"><span>${escapeHtml(p.label)}</span><strong>${escapeHtml(money(p.amount_cents))}</strong></div>`;
    if (req.query.get('merci')) {
      const done = p.status === 'paid' || p.status === 'partially_refunded';
      return html(res, pages.message(done ? 'Paiement reçu' : 'Paiement en cours de confirmation', done ? 'Merci ! Votre paiement est bien reçu. Un reçu vient de vous être envoyé par mail.' : 'Merci ! Stripe confirme votre paiement : vous recevrez un reçu par mail dans quelques instants.', { extra: amount }));
    }
    if (['paid', 'partially_refunded'].includes(p.status)) return html(res, pages.message('Déjà réglé', 'Ce paiement est déjà réglé. Merci !', { extra: amount }));
    if (req.query.get('annule')) return html(res, pages.message('Paiement annulé', "Le paiement n'a pas été effectué.", { extra: `${amount}<a class="btn btn-primary btn-block" href="/p/${escapeHtml(p.pay_token)}">Réessayer</a>` }));
    try {
      const r = await payments.checkoutUrl(p.pay_token);
      if (r.done) return html(res, pages.message('Déjà réglé', 'Ce paiement est déjà réglé. Merci !', { extra: amount }));
      res.writeHead(303, { Location: r.url }); res.end();
    } catch (e) {
      html(res, pages.message('Paiement indisponible', e.status ? e.message : 'Le paiement en ligne est momentanément indisponible. Réessayez plus tard.', { extra: amount }), e.status === 410 ? 410 : 503);
    }
  });
}

module.exports = { register, notify };
