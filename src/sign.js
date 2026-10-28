'use strict';
// Signature électronique : lien secret et unique (30 jours, sans compte), code à 6 chiffres par mail,
// signature au doigt, PDF signé avec page de preuve et empreintes SHA-256.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const settings = require('./settings');
const activity = require('./activity');
const mail = require('./mail');
const deals = require('./deals');
const quotes = require('./quotes');
const payments = require('./payments');
const rate = require('./ratelimit');
const pages = require('./pages');
const { loadImage } = require('./pdf');
const { config } = require('./env');
const { failuresBlocked, recordFailure, sha256, randomCode, safeEqual, money, dateTime, dateShort, dateEvent, escapeHtml, fullName, HttpError } = require('./util');
const { html, json, send, clientIp, PDF_CSP } = require('./http');

// Le lien permet de signer : devis envoyé, lien et devis encore valables
const signable = (q) => q.status === 'sent' && q.sign_expires_at >= settings.now() && (!q.valid_until || q.valid_until >= settings.now());

function byToken(token) {
  const q = db.get('SELECT * FROM quotes WHERE sign_token = ?', String(token));
  if (!q) throw new HttpError(404, 'Lien introuvable.');
  return q;
}

const maskEmail = (e) => String(e || '').replace(/^(.)[^@]*(@.*)$/, (_, a, b) => `${a}•••${b}`);

function proofRows(q) {
  return [
    ['Devis', `${q.number} · ${money(q.total_ttc)} TTC`],
    ['Signataire', q.signer_name],
    ['Adresse mail', q.signer_email],
    ['Date et heure', `${dateTime(q.signed_at)} (heure de Paris)`],
    ['Adresse IP', q.signer_ip],
    ['Appareil', q.signer_ua || 'non communiqué'],
    ['Code de vérification', `code à 6 chiffres envoyé à ${q.signer_email}, validé le ${dateTime(q.sign_code_validated_at)}`],
    ['Empreinte SHA-256 du devis', q.quote_sha256 || ''],
  ];
}

function proofHtml(q) {
  const rows = [...proofRows(q), ['Empreinte SHA-256 du PDF signé', q.signed_pdf_sha256 || '']];
  return `<div class="pub-box"><div class="label">Page de preuve</div>${rows.map(([k, v]) => `<div class="proof-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div>`;
}

function summary(q, deal) {
  const bits = [settings.dealTypeLabel(deal.type), deal.people ? `${deal.people} ${deal.type === 'anniversaire' ? 'enfants' : 'personnes'}` : null, deal.event_at ? dateEvent(deal.event_at) : null].filter(Boolean).join(' · ');
  return `<div class="pub-box">
    <div class="pub-box-title">Devis N° ${escapeHtml(q.number)}</div>
    <div class="muted">${escapeHtml(bits)}</div>
    <table class="pub-lines">${JSON.parse(q.lines).map((l) => `<tr><td>${escapeHtml(l.label)}<span class="muted"> × ${l.qty}</span></td><td>${escapeHtml(money(l.total_cents))}</td></tr>`).join('')}</table>
    <div class="pub-total"><span>Total TTC</span><strong>${escapeHtml(money(q.total_ttc))}</strong></div>
    <a class="link" href="/s/${escapeHtml(q.sign_token)}/pdf" target="_blank" rel="noopener">Voir le devis complet (PDF)</a>
  </div>`;
}

function signedPage(q, deal, { justSigned = false } = {}) {
  const c = deals.contactOf(deal) || {};
  const dep = q.deposit_cents > 0 ? payments.depositFor(q) : null;
  const pay = dep ? `<div class="pub-deposit"><span>Acompte de ${escapeHtml(String(q.deposit_pct).replace('.', ','))} % pour bloquer la date</span><strong>${escapeHtml(money(dep.amount_cents))}</strong></div>
    <a class="btn btn-primary btn-block" href="/p/${escapeHtml(dep.pay_token)}">Payer l'acompte</a>
    <p class="muted center small">Paiement sécurisé par Stripe · carte bancaire</p>` : '';
  const body = `<main class="pub"><div class="pub-card">${pages.logoTag()}
    <div class="check-circle">✓</div>
    <h1>${justSigned ? 'Devis signé' : 'Ce devis est déjà signé'}</h1>
    <p>${justSigned ? `Merci ${escapeHtml(c.first_name || q.signer_name)} ! Le devis signé vient de vous être envoyé par mail.` : `Signé le ${escapeHtml(dateTime(q.signed_at))} par ${escapeHtml(q.signer_name)}.`}</p>
    ${pay}
    ${proofHtml(q)}
    <a class="link" href="/s/${escapeHtml(q.sign_token)}/pdf" target="_blank" rel="noopener">Télécharger le devis signé (PDF)</a>
  </div></main>`;
  return pages.page({ title: 'Devis signé', body });
}

function register(router) {
  router.get('/s/:token', (req, res) => {
    let q;
    try { q = byToken(req.params.token); } catch { return html(res, pages.message('Lien introuvable', "Ce lien de signature n'existe pas. Vérifiez le lien reçu par mail."), 404); }
    const deal = deals.getDeal(q.deal_id);
    if (q.status === 'signed') return html(res, signedPage(q, deal, { justSigned: req.query.get('signe') === '1' }));
    if (q.status !== 'sent') return html(res, pages.message('Devis en cours de modification', "Ce devis a été modifié : une nouvelle version va vous être envoyée."), 410);
    if (!signable(q)) return html(res, pages.message('Lien expiré', 'Ce lien de signature ou ce devis a expiré. Contactez-nous pour en recevoir un nouveau.'), 410);
    if (!q.viewed_at) {
      db.update('quotes', q.id, { viewed_at: settings.now() });
      activity.log({ deal_id: q.deal_id, kind: 'quote', text: `Devis ${q.number} ouvert par le client` });
    }
    const c = deals.contactOf(deal) || {};
    const body = `<main class="pub"><div class="pub-card" id="sign" data-token="${escapeHtml(q.sign_token)}">${pages.logoTag()}
      <h1>Votre devis<br>à signer</h1>
      ${summary(q, deal)}
      <p class="muted small">Valable jusqu'au ${escapeHtml(dateShort(q.valid_until))}.${q.deposit_cents ? ` Acompte de ${escapeHtml(money(q.deposit_cents))} à la signature.` : ''}</p>
      <form id="sign-form" novalidate>
        <label class="field"><span>Nom et prénom</span><input name="name" autocomplete="name" required value="${escapeHtml(fullName(c))}"></label>
        <label class="check"><input type="checkbox" name="accept" required><span>Bon pour accord. J'accepte le devis et ses conditions.</span></label>
        <div class="field"><span>Signez avec le doigt</span><canvas id="pad" class="sign-pad" width="600" height="220"></canvas><button type="button" class="link small" id="pad-clear">Effacer</button></div>
        <div class="field"><span>Code de vérification</span>
          <div class="row-code"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 chiffres"><button type="button" class="btn btn-ghost" id="send-code">Recevoir mon code</button></div>
          <small class="muted" id="code-info">Le code est envoyé à ${escapeHtml(maskEmail(c.email))}.</small>
        </div>
        <p class="error" id="sign-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Signer le devis</button>
      </form>
    </div></main>`;
    html(res, pages.page({ title: 'Votre devis à signer', body, scripts: ['/static/sign.js'] }));
  });

  router.get('/s/:token/pdf', (req, res) => {
    const q = byToken(req.params.token);
    if (q.status === 'draft' || q.status === 'cancelled') throw new HttpError(410, 'Devis indisponible.');
    send(res, 200, quotes.pdfFor(q), 'application/pdf', { 'Content-Disposition': `inline; filename="Devis ${q.number}${q.status === 'signed' ? ' signe' : ''}.pdf"`, 'Cache-Control': 'no-store', 'Content-Security-Policy': PDF_CSP });
  });

  router.post('/s/:token/code', async (req, res) => {
    const q = byToken(req.params.token);
    if (!signable(q)) throw new HttpError(410, 'Ce lien ne permet plus de signer.');
    if (!rate.hit('sign-code:' + q.id, 5, 3600e3) || !rate.hit('sign-ip:' + clientIp(req), 10, 3600e3)) throw new HttpError(429, 'Trop de demandes de code. Réessayez plus tard.');
    const deal = deals.getDeal(q.deal_id);
    const c = deals.contactOf(deal);
    if (!c?.email) throw new HttpError(400, 'Aucune adresse mail pour ce devis.');
    const code = randomCode();
    db.update('quotes', q.id, { sign_code_hash: sha256(config.sessionSecret + q.id + code), sign_code_expires_at: settings.now() + 600e3, sign_code_attempts: 0 });
    const r = await mail.send({ to: c.email, template: 'code_signature', deal_id: deal.id, contact_id: c.id, vars: { prenom: c.first_name, numero: q.number, code }, quiet: true });
    if (r.status === 'failed') throw new HttpError(502, "Le code n'a pas pu être envoyé. Réessayez dans un instant.");
    activity.log({ deal_id: deal.id, kind: 'sign', text: `Code de signature envoyé à ${c.email}` });
    json(res, { ok: true, to: maskEmail(c.email) });
  });

  router.post('/s/:token/sign', async (req, res) => {
    const q = byToken(req.params.token);
    if (q.status === 'signed') throw new HttpError(409, 'Ce devis est déjà signé.');
    if (!signable(q)) throw new HttpError(410, 'Ce lien ne permet plus de signer.');
    // Le client signe exactement la version reçue : si le devis a changé depuis (entreprise, mentions…), on arrête
    if (q.quote_sha256 && sha256(quotes.renderPdf(q)) !== q.quote_sha256) {
      activity.log({ deal_id: q.deal_id, kind: 'sign', text: `Signature refusée : le devis ${q.number} a changé depuis son envoi. Renvoyez-le au client.` });
      db.insert('tasks', { deal_id: q.deal_id, title: `Renvoyer le devis ${q.number} (modifié depuis l'envoi)`, due_at: settings.now(), created_at: settings.now() });
      throw new HttpError(409, "Ce devis a été mis à jour depuis son envoi : l'équipe va vous envoyer la nouvelle version.");
    }
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (name.length < 3) throw new HttpError(400, 'Indiquez votre nom et prénom.');
    if (req.body.accept !== true) throw new HttpError(400, 'Cochez « Bon pour accord ».');
    // La signature dessinée (PNG)
    const m = String(req.body.signature || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    const png = m ? Buffer.from(m[1], 'base64') : null;
    if (!png || png.length > 600e3 || !loadImage(png)) throw new HttpError(400, 'Signez dans le cadre avec le doigt.');
    // Le code reçu par mail
    if (!q.sign_code_hash || q.sign_code_expires_at < settings.now()) throw new HttpError(400, 'Demandez votre code de vérification (il est valable 10 minutes).');
    if (failuresBlocked(db, 'sign:' + q.id)) throw new HttpError(429, 'Trop de codes faux aujourd’hui : réessayez demain ou contactez-nous.');
    if (q.sign_code_attempts >= 5) throw new HttpError(429, 'Trop d’essais : demandez un nouveau code.');
    db.run('UPDATE quotes SET sign_code_attempts = sign_code_attempts + 1 WHERE id = ?', q.id);
    const code = String(req.body.code || '').replace(/\D/g, '');
    if (!safeEqual(q.sign_code_hash, sha256(config.sessionSecret + q.id + code))) { recordFailure(db, 'sign:' + q.id); throw new HttpError(400, 'Code incorrect.'); }

    const deal = deals.getDeal(q.deal_id);
    const c = deals.contactOf(deal) || {};
    const now = settings.now();
    db.update('quotes', q.id, {
      status: 'signed', signed_at: now, signer_name: name, signer_email: c.email, signer_ip: clientIp(req),
      signer_ua: String(req.headers['user-agent'] || '').slice(0, 300), sign_code_validated_at: now, sign_code_hash: null, updated_at: now,
    });
    let signed = quotes.getQuote(q.id);
    const pdf = quotes.renderPdf(signed, { signature: { png, name, at: now }, proof: proofRows(signed) });
    fs.writeFileSync(path.join(quotes.pdfDir(), `${signed.number}-signe.pdf`), pdf);
    db.update('quotes', q.id, { signed_pdf_sha256: sha256(pdf) });
    signed = quotes.getQuote(q.id);
    activity.log({ deal_id: deal.id, kind: 'sign', text: `Devis ${signed.number} signé par ${name} · empreinte du PDF signé ${signed.signed_pdf_sha256.slice(0, 12)}…` });
    // L'étape n'avance que si la demande est avant « Signé » (jamais de retour en arrière)
    const order = settings.STAGES.map((s) => s.key);
    if (order.indexOf(deal.stage) < order.indexOf('signe') || deal.stage === 'perdu') deals.setStage(deal.id, 'signe', null, 'signature électronique');
    else require('./reminders').onStage(deal.id, 'acompte'); // déjà plus loin : on arrête seulement les relances du devis

    const attach = [{ filename: `Devis ${signed.number} signé.pdf`, content: pdf }];
    const dep = signed.deposit_cents > 0 ? payments.depositFor(signed) : null;
    if (c.email) {
      await mail.send({
        to: c.email, template: 'confirmation', deal_id: deal.id, contact_id: c.id, attachments: attach,
        vars: quotes.quoteVars(signed, { montant: dep ? money(dep.amount_cents) : money(0), lien: dep ? payments.payLink(dep) : `${config.appUrl}/s/${signed.sign_token}` }),
      });
    }
    const team = db.all("SELECT email FROM users WHERE active = 1 AND role = 'gerant'").map((u) => u.email);
    if (deal.assigned_to) { const u = db.get('SELECT email FROM users WHERE id = ?', deal.assigned_to); if (u) team.push(u.email); }
    for (const to of new Set(team)) {
      await mail.send({ to, template: 'signe_equipe', attachments: attach, deal_id: deal.id, quiet: true, vars: quotes.quoteVars(signed, { lien: `${config.appUrl}/#/demandes/${deal.id}` }) });
    }
    json(res, { ok: true, redirect: `/s/${signed.sign_token}?signe=1` });
  });
}

module.exports = { register, signedPage, proofRows };
