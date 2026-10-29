'use strict';
// La page du client : une seule page pour valider le devis puis payer l'acompte.
// À gauche le devis ; à droite les étapes (1. je valide, 2. je paie), l'établissement et la plaquette.
// Validation : prénom, nom et « bon pour accord » écrit en toutes lettres. Lien secret et unique,
// PDF signé avec page de preuve et empreintes SHA-256.
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
const { config } = require('./env');
const { sha256, money, dateTime, dateShort, dateEvent, escapeHtml, fullName, HttpError } = require('./util');
const { html, json, send, clientIp, PDF_CSP } = require('./http');

// Le lien permet de valider : devis envoyé, lien et devis encore valables
const signable = (q) => q.status === 'sent' && q.sign_expires_at >= settings.now() && (!q.valid_until || q.valid_until >= settings.now());

function byToken(token) {
  const q = db.get('SELECT * FROM quotes WHERE sign_token = ?', String(token));
  if (!q) throw new HttpError(404, 'Lien introuvable.');
  return q;
}

const signerName = (q) => [q.signer_first_name, q.signer_last_name].filter(Boolean).join(' ') || q.signer_name || '';

function proofRows(q) {
  return [
    ['Devis', `${q.number} · ${money(q.total_ttc)} TTC`],
    ['Validé par', `${signerName(q)}${q.signer_role ? `, ${q.signer_role}` : ''}${q.signer_company ? ` · ${q.signer_company}` : ''}`],
    ['Mention écrite', q.signer_agreement || 'Bon pour accord'],
    ['Adresse mail du lien', q.signer_email],
    ['Date et heure', `${dateTime(q.signed_at)} (heure de Paris)`],
    ['Adresse IP', q.signer_ip],
    ['Appareil', q.signer_ua || 'non communiqué'],
    ['Empreinte SHA-256 du devis', q.quote_sha256 || ''],
  ];
}

// Le lien de la plaquette : celui écrit dans le mail d'envoi du devis (Mails auto)
function brochureUrl() {
  const m = String(settings.mailTemplate('devis').body || '').match(/https:\/\/[^\s<>"]+/);
  return m ? m[0] : '';
}

// La colonne de gauche : le devis lui-même
function quoteHtml(q, deal) {
  const co = settings.get('company');
  const c = deals.contactOf(deal) || {};
  const company = deal.company_id ? db.get('SELECT * FROM companies WHERE id = ?', deal.company_id) : null;
  const lines = JSON.parse(q.lines);
  const vatRates = {};
  for (const l of lines) { const ht = Math.round(l.total_cents / (1 + (l.vat_rate || 0) / 100)); vatRates[l.vat_rate] = (vatRates[l.vat_rate] || 0) + (l.total_cents - ht); }
  const bits = [settings.dealTypeLabel(deal.type), deal.people ? `${deal.people} personnes` : null, deal.event_at ? dateEvent(deal.event_at) : null].filter(Boolean).join(' · ');
  return `<div class="sg-doc">
    <div class="sg-doc-top">${pages.logoTag()}<div class="sg-doc-id"><b>Devis N° ${escapeHtml(q.number)}</b><span>du ${escapeHtml(dateShort(q.issued_at || q.created_at))} · valable jusqu'au ${escapeHtml(dateShort(q.valid_until))}</span></div></div>
    <div class="sg-doc-2"><div><span class="label">${escapeHtml(co.name)}</span><p>${escapeHtml([co.legal_name, co.address, co.siret ? `SIRET ${co.siret}` : ''].filter(Boolean).join(' · '))}</p></div>
      <div><span class="label">Client</span><p>${escapeHtml([company?.name, fullName(c), c.email].filter(Boolean).join(' · '))}</p></div></div>
    ${q.object || bits ? `<p class="sg-obj"><b>Objet :</b> ${escapeHtml(q.object || bits)}</p>` : ''}
    <table class="sg-lines"><tr><th>Prestation</th><th>Qté</th><th>Total TTC</th></tr>${lines.map((l) => `<tr><td>${escapeHtml(l.label)}${l.description ? `<small>${escapeHtml(l.description)}</small>` : ''}</td><td>${l.qty}</td><td>${escapeHtml(money(l.total_cents))}</td></tr>`).join('')}</table>
    <div class="sg-tot"><div><span>Total HT</span><b>${escapeHtml(money(q.total_ht))}</b></div>${Object.entries(vatRates).map(([r, v]) => `<div><span>TVA ${escapeHtml(String(r).replace('.', ','))} %</span><b>${escapeHtml(money(v))}</b></div>`).join('')}
      <div class="sg-ttc"><span>Total TTC</span><b>${escapeHtml(money(q.total_ttc))}</b></div>
      ${q.deposit_cents > 0 ? `<div class="sg-dep"><span>${escapeHtml(quotes.depositLabel(q))} à la validation</span><b>${escapeHtml(money(q.deposit_cents))}</b></div>` : ''}</div>
    ${q.conditions ? `<p class="sg-cond">${escapeHtml(q.conditions)}</p>` : ''}
    <a class="link small" href="/s/${escapeHtml(q.sign_token)}/pdf" target="_blank" rel="noopener">Télécharger le devis (PDF)</a>
  </div>`;
}

// L'établissement : quelques lignes, la photo et le prénom du contact, la plaquette
function aboutHtml() {
  const co = settings.get('company');
  const photo = settings.get('contact_photo');
  const tel = co.contact_phone || co.phone;
  const plaquette = brochureUrl();
  const points = String(co.highlights || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
  if (!co.presentation && !co.contact_name && !plaquette && !points.length) return '';
  return `<div class="sg-about"><h2>On a hâte de vous accueillir</h2>
    ${co.presentation ? `<p>${escapeHtml(co.presentation)}</p>` : ''}
    ${points.length ? `<ul class="sg-points">${points.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
    ${co.contact_name ? `<div class="sg-contact">${photo ? '<img src="/photo-contact" alt="">' : `<span class="sg-ini">${escapeHtml(co.contact_name.charAt(0))}</span>`}<div><b>${escapeHtml(co.contact_name)}</b><span>Une question ? Appelez-moi${tel ? ` au <a href="tel:${escapeHtml(tel.replace(/\s/g, ''))}">${escapeHtml(tel)}</a>` : ''}</span></div></div>` : ''}
    ${plaquette ? `<a class="btn btn-ghost btn-block" href="${escapeHtml(plaquette)}" target="_blank" rel="noopener">Découvrez notre plaquette</a>` : ''}
  </div>`;
}

// Étape 2 : payer l'acompte (carte et virement suivi par Stripe, ou RIB classique), selon les moyens de ce devis ;
// « Tout régler maintenant » si le dirigeant le propose ; un acompte de 100 % s'affiche « Paiement intégral »
function payHtml(q, signed) {
  if (!(q.deposit_cents > 0)) return `<div class="sg-step ${signed ? 'on' : 'off'}"><div class="sg-n">2</div><div><h2>Je paie</h2><p class="muted">Pas d'acompte demandé pour ce devis.</p></div></div>`;
  const ways = payments.quoteMethods(q);
  const balance = payments.quoteBalance(q);
  const full = quotes.isFull(q);
  const what = full ? 'le montant total' : "l'acompte";
  const done = balance.paid >= q.deposit_cents;
  let inner;
  if (!signed) inner = `<p class="muted">Après la validation : ${full ? 'paiement intégral' : 'acompte'} de <b>${escapeHtml(money(q.deposit_cents))}</b>.</p>`;
  else if (done) inner = `<p class="ok-text">✓ ${balance.remaining > 0 ? 'Acompte reçu' : 'Paiement reçu'}, merci ! Votre réservation est confirmée.</p>`;
  else {
    const dep = payments.depositFor(q);
    const pm = settings.get('payments');
    const all = ways.includes('stripe') && pm.stripe_full && !full ? payments.fullFor(q) : null;
    inner = `<div class="pub-deposit"><span>${full ? 'Paiement intégral' : 'Acompte'}</span><strong>${escapeHtml(money(dep ? dep.amount_cents : q.deposit_cents))}</strong></div>`;
    if (ways.includes('stripe') && dep) {
      inner += `<a class="btn btn-primary btn-block" href="/p/${escapeHtml(dep.pay_token)}?carte=1">${full ? 'Payer le montant total' : "Payer l'acompte"}</a>`;
      if (all) inner += `<a class="btn btn-ghost btn-block" href="/p/${escapeHtml(all.pay_token)}?carte=1">Tout régler maintenant (${escapeHtml(money(all.amount_cents))})</a>`;
      inner += `<p class="muted small center">Paiement sécurisé par Stripe${pm.stripe_transfer ? ' : carte bancaire ou virement' : ' : carte bancaire'}</p>`;
    }
    if (ways.includes('rib')) {
      const rows = [['Titulaire', pm.holder], ['IBAN', quotes.formatIban(pm.iban)], ['BIC', pm.bic], ['Référence', q.number]].filter(([, v]) => v);
      inner += `<div class="pub-transfer"><h3>${ways.includes('stripe') ? 'Ou par virement' : 'Par virement'}</h3><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><p class="muted small">${escapeHtml(pm.transfer_note || '')} La réservation est confirmée à réception.</p></div>`;
    }
    if (!ways.length) inner += `<p class="muted">Nous revenons vers vous pour le règlement de ${what}.</p>`;
  }
  return `<div class="sg-step ${signed ? 'on' : 'off'}"><div class="sg-n">2</div><div><h2>${full ? 'Je paie' : "Je paie l'acompte"}</h2>${inner}</div></div>`;
}

function clientPage(q, deal, { justSigned = false } = {}) {
  const c = deals.contactOf(deal) || {};
  const company = deal.company_id ? db.get('SELECT name FROM companies WHERE id = ?', deal.company_id) : null;
  const signed = q.status === 'signed';
  const step1 = signed
    ? `<div class="sg-step done"><div class="sg-n">✓</div><div><h2>Je valide le devis</h2><p class="ok-text">${justSigned ? 'Merci ! ' : ''}Validé le ${escapeHtml(dateTime(q.signed_at))} par ${escapeHtml(signerName(q))}${q.signer_role ? `, ${escapeHtml(q.signer_role)}` : ''}.</p><p class="muted small">Le devis validé vous a été envoyé par mail.</p></div></div>`
    : `<div class="sg-step on"><div class="sg-n">1</div><div><h2>Je valide le devis</h2>
      <form id="sign-form" novalidate>
        <div class="grid g2"><label class="field"><span>Prénom</span><input name="first_name" autocomplete="given-name" required value="${escapeHtml(c.first_name || '')}"></label>
        <label class="field"><span>Nom</span><input name="last_name" autocomplete="family-name" required value="${escapeHtml(c.last_name || '')}"></label></div>
        <label class="field"><span>Écrivez « Bon pour accord »</span><input name="agreement" required autocomplete="off" placeholder="Bon pour accord"></label>
        <p class="error" id="sign-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Valider le devis</button>
        <p class="muted small">En validant, vous acceptez le devis et ses conditions. Votre validation est horodatée et jointe au devis.</p>
      </form></div></div>`;
  const body = `<main class="sg" id="sign" data-token="${escapeHtml(q.sign_token)}">
    <section class="sg-left" id="devis">${quoteHtml(q, deal)}</section>
    <aside class="sg-right"><h1>Votre devis</h1>
      <a class="sg-mini" href="#devis"><span>Devis N° ${escapeHtml(q.number)}</span><b>${escapeHtml(money(q.total_ttc))} TTC</b>${q.deposit_cents > 0 && !quotes.isFull(q) ? `<span>acompte ${escapeHtml(money(q.deposit_cents))}</span>` : ''}<u>Voir le détail ↓</u></a>
      ${step1}${payHtml(q, signed)}${aboutHtml()}</aside>
  </main>`;
  return pages.page({ title: `Devis ${q.number}`, body, scripts: signed ? [] : ['/static/sign.js'] });
}

function register(router) {
  router.get('/s/:token', (req, res) => {
    let q;
    try { q = byToken(req.params.token); } catch { return html(res, pages.message('Lien introuvable', "Ce lien n'existe pas. Vérifiez le lien reçu par mail."), 404); }
    const deal = deals.getDeal(q.deal_id);
    if (q.status === 'signed') return html(res, clientPage(q, deal, { justSigned: req.query.get('signe') === '1' }));
    if (q.status !== 'sent') return html(res, pages.message('Devis en cours de modification', 'Ce devis a été modifié : une nouvelle version va vous être envoyée.'), 410);
    if (!signable(q)) return html(res, pages.message('Lien expiré', 'Ce devis a expiré. Contactez-nous pour en recevoir un nouveau.'), 410);
    if (!q.viewed_at) {
      db.update('quotes', q.id, { viewed_at: settings.now() });
      activity.log({ deal_id: q.deal_id, kind: 'quote', text: `Devis ${q.number} ouvert par le client` });
    }
    html(res, clientPage(q, deal));
  });

  router.get('/s/:token/pdf', (req, res) => {
    const q = byToken(req.params.token);
    if (q.status === 'draft' || q.status === 'cancelled') throw new HttpError(410, 'Devis indisponible.');
    send(res, 200, quotes.pdfFor(q), 'application/pdf', { 'Content-Disposition': `inline; filename="Devis ${q.number}${q.status === 'signed' ? ' signe' : ''}.pdf"`, 'Cache-Control': 'no-store', 'Content-Security-Policy': PDF_CSP });
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
    if (!rate.hit('sign-ip:' + clientIp(req), 20, 3600e3)) throw new HttpError(429, 'Trop d’essais. Réessayez plus tard.');
    const f = (k, n = 120) => String(req.body[k] || '').trim().slice(0, n);
    const first = f('first_name'), last = f('last_name'), agreement = f('agreement', 60);
    if (!first || !last) throw new HttpError(400, 'Indiquez votre prénom et votre nom.');
    const norm = agreement.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
    if (norm !== 'bonpouraccord') throw new HttpError(400, 'Écrivez « Bon pour accord » en toutes lettres.');
    const name = `${first} ${last}`;
    // L'entreprise vient de la demande (on ne la redemande pas au client)
    const deal0 = deals.getDeal(q.deal_id);
    const company = deal0.company_id ? db.get('SELECT name FROM companies WHERE id = ?', deal0.company_id)?.name || null : null;
    const role = null;

    const deal = deals.getDeal(q.deal_id);
    const c = deals.contactOf(deal) || {};
    const now = settings.now();
    db.update('quotes', q.id, {
      status: 'signed', signed_at: now, signer_name: name, signer_first_name: first, signer_last_name: last, signer_company: company, signer_role: role, signer_agreement: agreement,
      signer_email: c.email, signer_ip: clientIp(req), signer_ua: String(req.headers['user-agent'] || '').slice(0, 300), updated_at: now,
    });
    let signed = quotes.getQuote(q.id);
    const pdf = quotes.renderPdf(signed, { signature: { name, role, company, agreement, at: now }, proof: proofRows(signed) });
    fs.writeFileSync(path.join(quotes.pdfDir(), `${signed.number}-signe.pdf`), pdf);
    db.update('quotes', q.id, { signed_pdf_sha256: sha256(pdf) });
    signed = quotes.getQuote(q.id);
    activity.log({ deal_id: deal.id, kind: 'sign', text: `Devis ${signed.number} validé par ${name}${company ? ` (${company})` : ''} · « ${agreement} » · empreinte du PDF ${signed.signed_pdf_sha256.slice(0, 12)}…` });
    // L'étape n'avance que si la demande est avant « Signé » (jamais de retour en arrière)
    const order = settings.STAGES.map((s) => s.key);
    if (order.indexOf(deal.stage) < order.indexOf('signe') || deal.stage === 'perdu') deals.setStage(deal.id, 'signe', null, 'validé en ligne par le client');
    else require('./reminders').onStage(deal.id, 'acompte'); // déjà plus loin : on arrête seulement les relances du devis

    const attach = [{ filename: `Devis ${signed.number} signé.pdf`, content: pdf }];
    const dep = signed.deposit_cents > 0 ? payments.depositFor(signed) : null;
    if (c.email) {
      await mail.send({
        to: c.email, template: 'confirmation', deal_id: deal.id, contact_id: c.id, attachments: attach,
        vars: quotes.quoteVars(signed, { acompte: dep ? money(dep.amount_cents) : money(0), lien: `${config.appUrl}/s/${signed.sign_token}` }),
      });
    }
    const team = db.all('SELECT email FROM users WHERE active = 1').map((u) => u.email);
    if (deal.assigned_to) { const u = db.get('SELECT email FROM users WHERE id = ?', deal.assigned_to); if (u) team.push(u.email); }
    for (const to of new Set(team)) {
      await mail.send({ to, template: 'signe_equipe', attachments: attach, deal_id: deal.id, quiet: true, vars: quotes.quoteVars(signed, { lien: `${config.appUrl}/#/demandes/${deal.id}` }) });
    }
    json(res, { ok: true, redirect: `/s/${signed.sign_token}?signe=1` });
  });
}

module.exports = { register, clientPage, proofRows, brochureUrl };
