/* Écrans : devis, paiements, relances, catalogue, agenda, équipe, paramètres, mon compte, assistant de démarrage. */
'use strict';
(function () {
  const { h, raw, $, $$, api, toast, modal, confirmBox, busy, copy, money, dShort, dDay, dTime, dLong, relative, toLocalInput, head, can } = window.CRM;
  const V = window.CRM.views;
  const L = () => CRM.labels;
  const euros = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
  const toCents = (v) => Math.round(Number(String(v).replace(/\s/g, '').replace(',', '.')) * 100) || 0;

  // ================= Devis =================
  V.quotes = async (ctx) => {
    if (ctx.parts[1]) return V.quote(ctx);
    const st = ctx.params.get('status') || '';
    const list = await api('GET', `/api/quotes${st ? `?status=${st}` : ''}`);
    const tabs = [['', 'Tous'], ['draft', 'Brouillons'], ['sent', 'Envoyés'], ['signed', 'Signés'], ['cancelled', 'Annulés']];
    return h`${head(`CRM · ${CRM.me.company.name}`, 'Les devis', h`<a class="btn btn-primary" href="#/demandes">Créer depuis une demande</a>`)}
      <div class="tabs">${tabs.map(([k, l]) => h`<a class="tab ${st === k ? 'on' : ''}" href="#/devis${k ? `?status=${k}` : ''}">${l}</a>`)}</div>
      <div class="list-head cols-quotes"><span>Numéro</span><span>Client</span><span>Montant</span><span>Statut</span><span>Dates</span></div>
      ${list.map((q) => h`<a class="list-row cols-quotes ${q.status === 'signed' ? 'tone-ok' : q.status === 'sent' ? 'tone-warn' : q.status === 'cancelled' ? 'tone-off' : ''}" href="#/devis/${q.id}" style="text-decoration:none">
        <span><b>${q.number}</b></span><span><b>${q.contact || '—'}</b><small>${q.title}</small></span><span><b>${money(q.total_ttc)}</b><small>acompte ${money(q.deposit_cents)}</small></span>
        <span><span class="badge b-${q.status}">${L().QST[q.status]}</span></span><span><small>${q.signed_at ? `signé le ${dShort(q.signed_at)}` : q.sent_at ? `envoyé le ${dShort(q.sent_at)}${q.viewed_at ? ' · ouvert' : ''}` : `créé le ${dShort(q.created_at)}`}</small></span></a>`)}
      ${list.length ? '' : h`<p class="empty">Aucun devis.</p>`}`;
  };
  V.quotes.bind = (root, ctx) => { if (ctx.parts[1]) return V.quote.bind(root, ctx); };

  let qstate = null;
  V.quote = async ({ parts }) => {
    const d = await api('GET', `/api/quotes/${parts[1]}`);
    qstate = d;
    const q = d.quote, c = d.contact || {};
    const locked = q.status === 'signed' || q.status === 'cancelled';
    return h`${head(`Devis · ${q.number} · ${L().QST[q.status]}`, 'Le devis', h`<a class="btn btn-ghost" href="#/demandes/${q.deal_id}">Voir la demande</a>${locked ? '' : h`<button class="btn btn-ghost" id="save">Enregistrer</button><button class="btn btn-ghost" id="send">Envoyer le devis</button><button class="btn btn-primary" id="sign">Demander la signature</button>`}`)}
      ${q.status === 'sent' ? h`<div class="banner">Ce devis est envoyé. Si vous le modifiez, il repasse en brouillon et devra être renvoyé : le client signe toujours la version reçue.</div>` : ''}
      ${q.status === 'signed' ? h`<div class="banner" style="color:var(--accent);border-color:var(--accent);background:rgba(var(--accent-rgb),.08)">Signé le ${dLong(q.signed_at)} par ${q.signer_name} · empreinte du PDF signé ${String(q.signed_pdf_sha256 || '').slice(0, 16)}… Reste à payer : ${money(d.balance.remaining)}.</div>` : ''}
      <div class="grid g2">
        <div class="card">
          <span class="label">Client : ${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '—'}</span>
          <label class="field"><span>Objet</span><input id="q-object" value="${q.object}" ${locked ? 'disabled' : ''}></label>
          <span class="label" style="display:block;margin:16px 0 8px">Les lignes</span>
          <div class="qlines" id="qlines"></div>
          ${locked ? '' : h`<div class="actions"><select id="add-product" style="width:auto;max-width:100%"><option value="">+ Ligne du catalogue…</option>${d.products.map((p) => h`<option value="${p.id}">${p.name}${p.is_option ? ' (option)' : ''} · ${p.price_cents === null ? 'sur devis' : money(p.price_cents)}${p.pricing === 'per_person' ? ' / pers.' : ''}${p.example ? ' · PRIX D’EXEMPLE' : ''}</option>`)}</select><button class="btn btn-sm btn-ghost" id="add-line">+ Ligne libre</button></div>`}
          <div class="grid g2" style="margin-top:16px"><label class="field"><span>Acompte (%)</span><input id="q-dep" type="number" min="0" max="100" step="1" value="${q.deposit_pct}" ${locked ? 'disabled' : ''}></label>
          <label class="field"><span>Valable jusqu'au</span><input id="q-valid" type="date" value="${toLocalInput(q.valid_until).slice(0, 10)}" ${locked ? 'disabled' : ''}></label></div>
          <div class="rows totals" id="totals"></div>
          <label class="field" style="margin-top:14px"><span>Conditions</span><textarea id="q-cond" rows="3" ${locked ? 'disabled' : ''}>${q.conditions}</textarea></label>
          ${!locked && q.status !== 'draft' ? '' : ''}
          ${locked ? '' : h`<button class="act danger" id="cancel-q">Annuler ce devis</button>`}
        </div>
        <div class="card"><span class="label">Aperçu du PDF</span><iframe class="pdf-frame" id="pdf" src="/api/quotes/${q.id}/pdf#view=FitH" title="Aperçu du devis"></iframe>
          ${q.sign_url && q.status !== 'signed' ? h`<div class="copy" style="margin-top:10px"><code>${q.sign_url}</code><button class="btn btn-sm btn-ghost" data-copy="${q.sign_url}">Copier</button></div>` : ''}
        </div>
      </div>`;
  };

  function renderLines(root) {
    const q = qstate.quote, locked = q.status === 'signed' || q.status === 'cancelled';
    const lines = q.lines;
    $('#qlines', root).innerHTML = h`<div class="ql qhead muted small"><span>Prestation, puis quantité, prix unitaire TTC (€) et TVA (%)</span><span></span></div>
      ${lines.map((l, i) => h`<div class="ql" data-i="${i}"><input data-k="label" value="${l.label}" placeholder="Prestation" ${locked ? 'disabled' : ''}>${locked ? h`<span></span>` : h`<button class="icon-btn" data-del="${i}" title="Retirer la ligne">×</button>`}<input data-k="qty" type="number" min="0" step="1" value="${l.qty}" title="Quantité" ${locked ? 'disabled' : ''}><input data-k="unit" inputmode="decimal" value="${euros(l.unit_cents)}" title="Prix unitaire TTC (€)" ${locked ? 'disabled' : ''}><input data-k="vat_rate" inputmode="decimal" value="${String(l.vat_rate).replace('.', ',')}" title="TVA (%)" ${locked ? 'disabled' : ''}><span class="tot">${money(Math.round((Number(l.qty) || 0) * (l.unit_cents || 0)))}</span><span></span></div>`)}`.s;
    // Totaux affichés (le serveur recalcule à l'enregistrement)
    let ttc = 0, ht = 0;
    for (const l of lines) { const t = Math.round((Number(l.qty) || 0) * (l.unit_cents || 0)); ttc += t; ht += Math.round(t / (1 + (Number(l.vat_rate) || 0) / 100)); }
    const pct = Number($('#q-dep', root).value) || 0;
    $('#totals', root).innerHTML = h`<div class="row"><span>Total HT</span><b>${money(ht)}</b></div><div class="row"><span>TVA</span><b>${money(ttc - ht)}</b></div><div class="row"><span>Total TTC</span><span class="big-amount">${money(ttc)}</span></div><div class="row"><span>Acompte ${pct} %</span><b>${money(Math.round((ttc * pct) / 100))}</b></div>`.s;
    $$('.ql[data-i] input', root).forEach((inp) => inp.oninput = () => {
      const l = lines[Number(inp.closest('.ql').dataset.i)];
      const k = inp.dataset.k;
      if (k === 'unit') l.unit_cents = toCents(inp.value);
      else if (k === 'vat_rate') l.vat_rate = Number(inp.value.replace(',', '.')) || 0;
      else if (k === 'qty') l.qty = Number(inp.value) || 0;
      else l[k] = inp.value;
      if (k !== 'label') { const pos = inp.selectionStart; renderLines(root); const again = $(`.ql[data-i="${lines.indexOf(l)}"] [data-k="${k}"]`, root); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* champ numérique */ } } }
    });
    $$('[data-del]', root).forEach((b) => b.onclick = () => { lines.splice(Number(b.dataset.del), 1); renderLines(root); });
  }

  V.quote.bind = (root) => {
    const q = qstate.quote;
    renderLines(root);
    $$('[data-copy]', root).forEach((b) => b.onclick = () => copy(b.dataset.copy));
    if (q.status === 'signed' || q.status === 'cancelled') return;
    $('#q-dep', root).oninput = () => renderLines(root);
    const deal = qstate.deal;
    $('#add-product', root).onchange = (e) => {
      const p = qstate.products.find((x) => String(x.id) === e.target.value);
      if (!p) return;
      const people = deal.people || 1;
      q.lines.push({ product_id: p.id, label: p.name, description: p.description, qty: p.pricing === 'per_person' ? Math.max(people, p.min_people || 0) : 1, unit_cents: p.price_cents || 0, vat_rate: p.vat_rate });
      e.target.value = '';
      renderLines(root);
    };
    $('#add-line', root).onclick = () => { q.lines.push({ label: '', qty: 1, unit_cents: 0, vat_rate: 20 }); renderLines(root); };
    const payload = () => {
      const valid = $('#q-valid', root).value;
      return { object: $('#q-object', root).value, conditions: $('#q-cond', root).value, deposit_pct: Number($('#q-dep', root).value) || 0, lines: q.lines.map((l) => ({ product_id: l.product_id, label: l.label, description: l.description, qty: l.qty, unit_cents: l.unit_cents, vat_rate: l.vat_rate })), valid_until: valid ? new Date(valid + 'T23:59').getTime() : undefined };
    };
    const save = async () => { const r = await api('PUT', `/api/quotes/${q.id}`, payload()); Object.assign(q, r, { lines: JSON.parse(r.lines) }); $('#pdf', root).src = `/api/quotes/${q.id}/pdf?t=${Date.now()}#view=FitH`; return r; };
    $('#save', root).onclick = (e) => busy(e.target, async () => { const r = await save(); toast(r.status === 'draft' && q.sent_at ? 'Enregistré : à renvoyer au client.' : 'Devis enregistré.'); CRM.refresh(); });
    const sendIt = (mode) => async (e) => {
      const txt = mode === 'devis' ? 'Le client reçoit le devis en PDF et un lien en ligne, sans compte, pour le consulter et le signer.' : 'Le client reçoit un lien secret, valable 30 jours, pour signer avec un code envoyé par mail.';
      if (!(await confirmBox(mode === 'devis' ? 'Envoyer le devis' : 'Demander la signature', txt, { submit: 'Envoyer' }))) return;
      busy(e.target, async () => { await save(); const r = await api('POST', `/api/quotes/${q.id}/send`, { mode }); toast(r.mail === 'simulated' ? 'Envoi simulé (Resend non branché) : voir le terminal.' : 'Envoyé.'); CRM.refresh(); });
    };
    $('#send', root).onclick = sendIt('devis');
    $('#sign', root).onclick = sendIt('demande_signature');
    $('#cancel-q', root).onclick = async () => { if (await confirmBox('Annuler le devis', 'Le lien de signature est fermé et les relances de ce devis s’arrêtent.', { submit: 'Annuler le devis', danger: true })) busy(null, async () => { await api('POST', `/api/quotes/${q.id}/cancel`, {}); CRM.refresh(); }); };
  };

  // ================= Paiements =================
  V.payments = async () => {
    const d = await api('GET', '/api/payments');
    const tone = { paid: 'tone-ok', pending: 'tone-warn', failed: 'tone-warn', refunded: 'tone-off', partially_refunded: 'tone-off', cancelled: 'tone-off' };
    const mode = d.stripe_mode === 'test' ? 'Test' : d.stripe_mode === 'live' ? 'Réel' : 'Non branché';
    return h`${head(`CRM · ${CRM.me.company.name}`, 'Les paiements', h`<button class="btn btn-primary" id="new-pay">+ Lien de paiement</button>`)}
      <div class="kpis">
        <div class="kpi"><b>${money(d.kpis.cashed_month).replace(',00', '')}</b><span>encaissé ce mois-ci</span></div>
        <div class="kpi"><b>${money(d.kpis.pending_deposits).replace(',00', '')}</b><span>acomptes en attente</span></div>
        <div class="kpi"><b>${d.kpis.count_paid}</b><span>paiements reçus</span></div>
        <div class="kpi"><b>${mode}</b><span>mode Stripe actuel</span></div>
      </div>
      <div class="with-aside"><div>
        <div class="list-head cols-pay"><span>Client</span><span>Montant</span><span>Statut</span><span>Date</span><span>Actions</span></div>
        ${d.payments.map((p) => h`<div class="list-row cols-pay ${tone[p.status] || ''}">
          <span><b>${p.client}</b><small>${p.quote_number ? `${p.quote_number} · ` : ''}${p.label}</small></span>
          <span><b>${money(p.amount_cents)}</b>${p.refunded_cents ? h`<small>remboursé ${money(p.refunded_cents)}</small>` : ''}</span>
          <span><span class="badge b-${p.status}">${L().PAY[p.status]}</span></span>
          <span><small>${p.status === 'paid' || p.status === 'partially_refunded' ? dTime(p.paid_at) : p.status === 'refunded' ? `remboursé le ${dShort(p.refunded_at)}` : p.sent_at ? `lien envoyé le ${dShort(p.sent_at)}` : `créé le ${dShort(p.created_at)}`}</small></span>
          <span class="actions">${p.deal_id ? h`<a class="act" href="#/demandes/${p.deal_id}">Voir</a>` : ''}${p.link ? h`<button class="act" data-copy="${p.link}">Copier le lien</button>` : ''}${['paid', 'partially_refunded'].includes(p.status) ? h`<button class="act danger" data-refund="${p.id}" data-max="${p.amount_cents - p.refunded_cents}">Rembourser</button>` : ''}</span>
        </div>`)}
        ${d.payments.length ? '' : h`<p class="empty">Aucun paiement pour le moment.</p>`}
      </div>
      <div class="card"><span class="label">Stripe</span><div class="rows">
        <div class="row"><span><b>${d.stripe_mode ? 'Connecté' : 'Non branché'}</b><br><small class="muted">${d.stripe_mode ? 'clés dans le .env du serveur' : 'ajoutez les clés dans le .env'}</small></span></div>
        <div class="row"><span><b>${mode === 'Test' ? 'Mode test' : mode === 'Réel' ? 'Mode réel' : '—'}</b><br><small class="muted">${mode === 'Test' ? 'cartes de test seulement (4242 4242 4242 4242)' : mode === 'Réel' ? 'vrais paiements' : ''}</small></span></div>
        <div class="row"><span><b>Acompte par défaut</b><br><small class="muted">${d.deposit_pct} % du devis</small></span></div>
        <div class="row"><span><b>Reçus</b><br><small class="muted">envoyés par le CRM et notés dans la fiche</small></span></div>
      </div>${can('parametres') && d.stripe_mode === 'test' ? h`<button class="btn btn-primary btn-block" id="test-pay" style="margin-top:14px">Tester : paiement de 1 €</button>` : ''}
      ${d.stripe_mode === 'test' ? h`<p class="small muted" style="margin-top:12px">Pour passer en réel : le gérant active le compte Stripe, puis on remplace les clés de test par les clés réelles dans le .env et on recrée le webhook.</p>` : ''}</div></div>`;
  };
  V.payments.bind = (root) => {
    $$('[data-copy]', root).forEach((b) => b.onclick = () => copy(b.dataset.copy));
    $$('[data-refund]', root).forEach((b) => b.onclick = async () => {
      const r = await modal('Rembourser', h`<p>Le remboursement part immédiatement vers la carte du client, par Stripe.</p><label class="field"><span>Montant en euros (maximum ${money(Number(b.dataset.max))})</span><input name="amount" inputmode="decimal" value="${euros(Number(b.dataset.max))}"></label>`, { submit: 'Rembourser', danger: true });
      if (r) busy(b, async () => { await api('POST', `/api/payments/${b.dataset.refund}/refund`, { amount: r.amount, confirm: true }); toast('Remboursement effectué.'); CRM.refresh(); });
    });
    const t = $('#test-pay', root);
    if (t) t.onclick = () => busy(t, async () => { const r = await api('POST', '/api/payments/test', {}); window.open(r.link, '_blank'); });
    $('#new-pay', root).onclick = () => pickDeal('Lien de paiement', h`<label class="field"><span>Montant en euros</span><input name="amount" inputmode="decimal" required></label><label class="field"><span>Libellé</span><input name="label" value="paiement libre"></label><label class="check"><input type="checkbox" name="send" checked><span>Envoyer le lien au client par mail</span></label>`, async (v) => {
      const r = await api('POST', '/api/payments', { kind: 'free', deal_id: v.deal_id ? Number(v.deal_id) : null, amount: v.amount, label: v.label, send: v.send && Boolean(v.deal_id) });
      if (!(v.send && v.deal_id)) copy(r.link); else toast('Lien envoyé.');
      CRM.refresh();
    });
  };

  // Choisir une demande puis compléter un formulaire
  async function pickDeal(title, extra, done) {
    const v = await modal(title, h`<label class="field"><span>Demande (client)</span><input id="pd-q" placeholder="Nom, mail…" autocomplete="off"></label><div id="pd-res" class="small"></div><input type="hidden" name="deal_id" id="pd-id">${extra}`, {
      submit: 'Valider',
      onOpen: (f) => {
        let t;
        $('#pd-q', f).oninput = (e) => { clearTimeout(t); t = setTimeout(async () => {
          const r = await api('GET', `/api/search?q=${encodeURIComponent(e.target.value)}`);
          $('#pd-res', f).innerHTML = h`${r.deals.map((d) => h`<label class="check"><input type="radio" name="pick" value="${d.id}"><span>${d.title} · ${d.contact}</span></label>`)}`.s;
          $$('[name=pick]', f).forEach((rb) => rb.onchange = () => { $('#pd-id', f).value = rb.value; });
        }, 300); };
      },
    });
    if (v) busy(null, () => done(v));
  }

  // ================= Relances =================
  V.reminders = async ({ params }) => {
    const tab = params.get('tab') || 'a_venir';
    const d = await api('GET', `/api/reminders?tab=${tab}`);
    const r = d.rules;
    const CH = { mail: 'Mail', call: 'Appel', alert: 'Alerte' };
    const dot = (rule) => ({ quote_unsigned: 'var(--secondary)', deposit_unpaid: '#ffb020', after_visit: 'var(--accent)', no_answer: '#ffb020', manual: 'var(--primary)' }[rule]);
    return h`${head(`CRM · ${CRM.me.company.name}`, 'Les relances', h`<button class="btn btn-primary" id="manual">+ Relance manuelle</button>`)}
      <div class="tabs">${[['a_venir', 'À venir'], ['envoyees', 'Envoyées'], ['pause', 'En pause']].map(([k, l]) => h`<a class="tab ${tab === k ? 'on' : ''}" href="#/relances?tab=${k}">${l} · ${d.counts[k]}</a>`)}</div>
      <div class="with-aside"><div>
        <div class="list-head cols-rem"><span>Client</span><span>Relance</span><span>${tab === 'envoyees' ? 'Partie' : 'Prévue'}</span><span>Canal</span><span>Actions</span></div>
        ${d.reminders.map((x) => h`<div class="list-row cols-rem ${x.status === 'paused' ? 'tone-off' : x.rule === 'after_visit' ? 'tone-ok' : x.channel !== 'mail' ? 'tone-warn' : ''}">
          <span><b>${x.client}</b><small>${x.quote_number ? `${x.quote_number} · ${money(x.total_ttc)}` : x.title}</small></span>
          <span><b><span style="color:${dot(x.rule)}">●</span> ${x.status === 'paused' ? (x.rule === 'manual' ? `${x.label} · en pause` : 'Relances coupées') : x.label}</b>${x.error ? h`<small class="error">${x.error}</small>` : ''}</span>
          <span><b>${x.status === 'sent' ? dTime(x.sent_at) : x.status === 'paused' ? '—' : relative(x.due_at)}</b></span>
          <span>${x.status === 'paused' ? 'En pause' : CH[x.channel]}</span>
          <span class="actions">${x.status === 'paused' ? h`<button class="act" data-resume="${x.deal_id}">Réactiver</button>` : x.status === 'sent' ? h`<a class="act" href="#/demandes/${x.deal_id}">Voir</a>` : h`<button class="act" data-send="${x.id}">Envoyer</button><button class="act" data-post="${x.id}">Reporter</button><button class="act" data-cut="${x.deal_id}">Couper</button>`}</span>
        </div>`)}
        ${d.reminders.length ? '' : h`<p class="empty">Aucune relance ici.</p>`}
      </div>
      <div><div class="card"><span class="label">Les règles</span><div class="rows">
        <div class="row"><span><b>Demande sans réponse</b><br><small class="muted">${r.no_answer.enabled ? `alerte à l'équipe après ${r.no_answer.hours} h` : 'désactivée'}</small></span></div>
        <div class="row"><span><b>Devis non signé</b><br><small class="muted">${r.quote_unsigned.enabled ? `mail à ${r.quote_unsigned.mail_days.map((x) => `J+${x}`).join(' et ')}${r.quote_unsigned.call_day ? `, appel à J+${r.quote_unsigned.call_day}` : ''}` : 'désactivée'}</small></span></div>
        <div class="row"><span><b>Acompte non payé</b><br><small class="muted">${r.deposit_unpaid.enabled ? `rappel à ${r.deposit_unpaid.days.map((x) => `J+${x}`).join(' et ')}` : 'désactivé'}</small></span></div>
        <div class="row"><span><b>Après la venue</b><br><small class="muted">${r.after_visit.enabled ? `J+${r.after_visit.days} : merci et lien d'avis Google` : 'désactivé'}</small></span></div>
        <div class="row"><span><b>Quand</b><br><small class="muted">${r.window.start} h – ${r.window.end} h${r.window.sunday ? '' : ', jamais le dimanche'}</small></span></div>
        <div class="row"><span><b>Ça s'arrête</b><br><small class="muted">dès que le client signe, paie ou répond</small></span></div>
      </div>${can('parametres') ? h`<a class="btn btn-primary btn-block" href="#/parametres/mails" style="margin-top:14px">Modifier les règles</a>` : ''}</div>
      ${can('parametres') ? h`<div class="card" style="margin-top:16px"><span class="label">Horloge de test</span><p class="small muted">Réservé à l'administrateur : avance le temps du CRM pour voir partir les relances. Heure du CRM : ${dLong(d.now)}.</p>
        <div class="actions"><button class="btn btn-sm btn-ghost" data-clock="1">+1 jour</button><button class="btn btn-sm btn-ghost" data-clock="3">+3 jours</button><button class="btn btn-sm btn-ghost" data-clock="7">+7 jours</button>${d.clock_offset_ms ? h`<button class="btn btn-sm btn-danger" data-clock="reset">Remettre à l'heure</button>` : ''}</div></div>` : ''}
      </div></div>`;
  };
  V.reminders.bind = (root) => {
    $$('[data-send]', root).forEach((b) => b.onclick = () => busy(b, async () => { const r = await api('POST', `/api/reminders/${b.dataset.send}/send`, {}); toast(r.sent ? 'Relance envoyée.' : r.skipped ? `Annulée : ${r.skipped}.` : `Erreur : ${r.error}`, Boolean(r.error)); CRM.refresh(); }));
    $$('[data-post]', root).forEach((b) => b.onclick = async () => {
      const v = await modal('Reporter la relance', h`<label class="field"><span>Nouvelle date</span><input type="datetime-local" name="until" value="${toLocalInput(CRM.now() + 2 * 86400e3).slice(0, 11)}10:00"></label>`, { submit: 'Reporter' });
      if (v) busy(b, async () => { await api('POST', `/api/reminders/${b.dataset.post}/postpone`, v); toast('Relance reportée.'); CRM.refresh(); });
    });
    $$('[data-cut]', root).forEach((b) => b.onclick = () => busy(b, async () => { await api('POST', `/api/deals/${b.dataset.cut}/reminders/cut`, {}); toast('Relances de cette demande coupées.'); CRM.refresh(); }));
    $$('[data-resume]', root).forEach((b) => b.onclick = () => busy(b, async () => { await api('POST', `/api/deals/${b.dataset.resume}/reminders/resume`, {}); toast('Relances réactivées.'); CRM.refresh(); }));
    $$('[data-clock]', root).forEach((b) => b.onclick = () => busy(b, async () => {
      const reset = b.dataset.clock === 'reset';
      await api('POST', '/api/clock', reset ? { reset: true } : { days: Number(b.dataset.clock) });
      await CRM.loadMe();
      toast(reset ? 'Horloge remise à l’heure.' : `Horloge avancée de ${b.dataset.clock} jour(s) : les relances dues sont parties.`);
      CRM.refresh();
    }));
    $('#manual', root).onclick = () => pickDeal('Relance manuelle', h`<div class="field"><span>Canal</span><select name="channel"><option value="mail">Mail au client</option><option value="call">Appel (tâche)</option></select></div><label class="field"><span>Quand</span><input type="datetime-local" name="due_at" value="${toLocalInput(CRM.now() + 86400e3).slice(0, 11)}10:00"></label><label class="field"><span>Message</span><textarea name="message" rows="3"></textarea></label>`, async (v) => {
      if (!v.deal_id) throw new Error('Choisissez une demande.');
      await api('POST', `/api/deals/${v.deal_id}/reminders`, v); toast('Relance programmée.'); CRM.refresh();
    });
  };

  // ================= Catalogue =================
  const RULE = { per_person: 'par personne', flat: 'forfait', quote: 'sur devis' };
  V.catalogue = async () => {
    const list = await api('GET', '/api/products');
    const edit = can('parametres');
    return h`${head(`CRM · ${CRM.me.company.name}`, 'Le catalogue', edit ? h`<button class="btn btn-primary" id="new-product">+ Prestation</button>` : '')}
      <p class="muted small">Prix TTC. Les prestations « publiques » sont proposées dans le devis automatique du site ; le serveur recalcule toujours le prix à partir de ce catalogue.</p>
      <div class="list-head cols-cat"><span>Prestation</span><span>Règle de prix</span><span>Prix TTC</span><span>TVA</span><span>Types</span><span></span></div>
      ${list.map((p) => h`<div class="list-row cols-cat ${p.active ? '' : 'tone-off'} ${p.is_option ? 'tone-warn' : ''}">
        <span><b>${p.name}</b><small>${p.description}</small><small>${p.is_option ? 'option · ' : ''}${p.public ? 'devis auto · ' : ''}${p.example ? h`<b style="color:#ffc04d;display:inline">PRIX D'EXEMPLE</b>` : ''}${p.active ? '' : ' désactivée'}</small></span>
        <span>${RULE[p.pricing]}${p.min_people ? ` · min. ${p.min_people}` : ''}${p.max_people ? ` · max. ${p.max_people}` : ''}</span>
        <span><b>${p.price_cents === null ? 'sur devis' : money(p.price_cents)}</b></span><span>${String(p.vat_rate).replace('.', ',')} %</span>
        <span><small>${p.deal_types ? p.deal_types.split(',').map((k) => L().typeDef(k).label).join(', ') : 'tous'}</small></span>
        <span>${edit ? h`<button class="act" data-edit="${p.id}">Modifier</button>` : ''}</span></div>`)}
      ${list.length ? '' : h`<p class="empty">Le catalogue est vide.${edit ? ' Ajoutez vos prestations et leurs prix.' : ''}</p>`}`;
  };
  async function productForm(p = {}) {
    const types = (p.deal_types || '').split(',').filter(Boolean);
    const v = await modal(p.id ? 'Modifier la prestation' : 'Nouvelle prestation', h`
      <label class="field"><span>Nom</span><input name="name" value="${p.name || ''}" required></label>
      <label class="field"><span>Description (sur le devis)</span><input name="description" value="${p.description || ''}"></label>
      <div class="grid g2"><div class="field"><span>Règle de prix</span><select name="pricing">${Object.entries(RULE).map(([k, l]) => h`<option value="${k}" ${p.pricing === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      <label class="field"><span>Prix TTC (€)</span><input name="price" inputmode="decimal" value="${euros(p.price_cents)}"></label></div>
      <div class="grid g2"><label class="field"><span>Minimum de personnes</span><input name="min_people" type="number" value="${p.min_people || ''}"></label><label class="field"><span>Maximum</span><input name="max_people" type="number" value="${p.max_people || ''}"></label></div>
      <label class="field"><span>TVA (%)</span><input name="vat_rate" inputmode="decimal" value="${String(p.vat_rate ?? 20).replace('.', ',')}"></label>
      <div class="field"><span>Types de demande concernés (aucun = tous)</span><div class="chips">${CRM.me.deal_types.map((t) => h`<label class="check" style="margin:0 10px 0 0"><input type="checkbox" name="deal_types" data-multi value="${t.key}" ${types.includes(t.key) ? 'checked' : ''}><span>${t.label}</span></label>`)}</div></div>
      <label class="check"><input type="checkbox" name="is_option" ${p.is_option ? 'checked' : ''}><span>C'est une option (s'ajoute à une prestation)</span></label>
      <label class="check"><input type="checkbox" name="public" ${p.public ? 'checked' : ''}><span>Proposée dans le devis automatique du site</span></label>
      <label class="check"><input type="checkbox" name="example" ${p.example ? 'checked' : ''}><span>PRIX D'EXEMPLE (à remplacer par le vrai prix)</span></label>
      <label class="check"><input type="checkbox" name="active" ${p.active === 0 ? '' : 'checked'}><span>Active</span></label>`, { submit: 'Enregistrer' });
    if (!v) return;
    busy(null, async () => { if (p.id) await api('PUT', `/api/products/${p.id}`, v); else await api('POST', '/api/products', v); toast('Catalogue enregistré.'); CRM.refresh(); });
  }
  CRM.productForm = productForm;
  V.catalogue.bind = (root) => {
    const n = $('#new-product', root);
    if (n) n.onclick = () => productForm();
    $$('[data-edit]', root).forEach((b) => b.onclick = async () => { const list = await api('GET', '/api/products'); productForm(list.find((p) => String(p.id) === b.dataset.edit)); });
  };

  // ================= Agenda =================
  V.agenda = async ({ params }) => {
    const week = Number(params.get('semaine') || 0);
    const now = CRM.now();
    const today = new Date(toLocalInput(now).slice(0, 10) + 'T00:00');
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + week * 7);
    const from = monday.getTime(), to = from + 7 * 86400e3;
    const d = await api('GET', `/api/events?from=${from}&to=${to}`);
    const days = [...Array(7)].map((_, i) => { const x = new Date(monday); x.setDate(monday.getDate() + i); return x; });
    return h`${head(`Agenda · ${d.google.enabled ? 'synchronisé avec Google Agenda' : 'Google Agenda non branché'}`, "L'agenda", h`<a class="btn btn-ghost btn-sm" href="#/agenda?semaine=${week - 1}">‹</a><a class="btn btn-ghost btn-sm" href="#/agenda">Cette semaine</a><a class="btn btn-ghost btn-sm" href="#/agenda?semaine=${week + 1}">›</a><button class="btn btn-primary" id="new-ev">+ Réservation</button>`)}
      <p class="muted small">Chaque réservation dont l'acompte est payé arrive ici toute seule${d.google.enabled ? ', et dans Google Agenda' : ''}.</p>
      <div class="week">${days.map((day) => {
        const a = day.getTime(), b = a + 86400e3;
        const evs = d.events.filter((e) => e.start_at >= a && e.start_at < b);
        return h`<div class="day ${a === today.getTime() ? 'today' : ''}"><h4>${new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' }).format(day)}</h4>
          ${evs.map((e) => h`<a class="ev" href="${e.deal_id && can('demandes') ? `#/demandes/${e.deal_id}` : '#/agenda'}"><b>${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(e.start_at)} · ${e.title}</b>${e.people ? `${e.people} pers.` : ''}${e.gcal_error ? h`<br><span class="error">Google : ${e.gcal_error}</span>` : e.gcal_id ? ' · ✓ Google' : ''}</a>`)}</div>`;
      })}</div>`;
  };
  V.agenda.bind = (root) => {
    $('#new-ev', root).onclick = async () => {
      const v = await modal('Nouvelle réservation', h`<label class="field"><span>Titre</span><input name="title" required placeholder="ex. Anniversaire · 10 enfants · Famille TEST"></label><label class="field"><span>Début</span><input type="datetime-local" name="start_at" required></label><div class="grid g2"><label class="field"><span>Durée (minutes)</span><input type="number" name="duration_min" value="120"></label><label class="field"><span>Personnes</span><input type="number" name="people"></label></div><label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>`, { submit: 'Ajouter' });
      if (v) busy(null, async () => { await api('POST', '/api/events', v); toast('Réservation ajoutée.'); CRM.refresh(); });
    };
  };

  // ================= Équipe =================
  V.team = async () => {
    const users = await api('GET', '/api/users');
    const roles = CRM.me.roles;
    const desc = { gerant: 'tout', accueil: 'demandes, devis, paiements, relances', animation: 'agenda' };
    return h`${head(`Équipe · ${users.filter((u) => u.active).length} comptes`, "L'équipe", h`<button class="btn btn-primary" id="invite">+ Inviter un membre</button>`)}
      <div class="list-head cols-team"><span>Membre</span><span>Rôle</span><span>Dernière connexion</span><span></span></div>
      ${users.map((u) => h`<div class="list-row cols-team ${u.active ? '' : 'tone-off'}">
        <span style="display:flex;gap:12px;align-items:center"><span class="avatar">${CRM.initials(u.name)}</span><span><b>${u.name}</b><small>${u.email}</small></span></span>
        <span><select data-role="${u.id}" ${u.id === CRM.me.user.id ? 'disabled' : ''}>${roles.map((r) => h`<option value="${r.key}" ${u.role === r.key ? 'selected' : ''}>${r.label} · ${desc[r.key]}</option>`)}</select></span>
        <span><small>${u.last_login_at ? `${dTime(u.last_login_at)} · ${u.last_login_method}` : 'jamais connecté (invité)'}</small></span>
        <span>${u.id === CRM.me.user.id ? h`<small>vous</small>` : h`<button class="act ${u.active ? 'danger' : ''}" data-active="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? 'Désactiver' : 'Réactiver'}</button>`}</span></div>`)}
      <p class="small muted">Gérant : tout. Accueil : demandes, devis, paiements, relances. Animation : agenda. Chaque action est signée du nom de la personne dans l'historique.</p>`;
  };
  V.team.bind = (root) => {
    $('#invite', root).onclick = async () => {
      const v = await modal('Inviter un membre', h`<label class="field"><span>Adresse de l'entreprise</span><input type="email" name="email" required></label><label class="field"><span>Prénom ou nom affiché</span><input name="name"></label><div class="field"><span>Rôle</span><select name="role">${CRM.me.roles.map((r) => h`<option value="${r.key}" ${r.key === 'accueil' ? 'selected' : ''}>${r.label}</option>`)}</select></div><p class="small muted">La personne reçoit un mail d'invitation. Elle se connecte avec Google, ou avec un code par mail.</p>`, { submit: 'Inviter' });
      if (v) busy(null, async () => { const r = await api('POST', '/api/users', v); toast(r.mail === 'simulated' ? 'Invitée (mail simulé : Resend non branché).' : 'Invitation envoyée.'); CRM.refresh(); });
    };
    $$('[data-role]', root).forEach((s) => s.onchange = () => busy(null, async () => { await api('PUT', `/api/users/${s.dataset.role}`, { role: s.value }); toast('Rôle modifié.'); CRM.refresh(); }));
    $$('[data-active]', root).forEach((b) => b.onclick = () => busy(b, async () => { await api('PUT', `/api/users/${b.dataset.active}`, { active: b.dataset.v === '1' }); CRM.refresh(); }));
  };

  // ================= Mon compte (jeton MCP) =================
  V.account = async () => {
    const tokens = await api('GET', '/api/tokens');
    return h`${head('Mon compte', CRM.me.user.name)}
      <div class="grid g2">
        <div class="card"><span class="label">Mon accès</span><div class="rows"><div class="row"><span>Adresse</span><b>${CRM.me.user.email}</b></div><div class="row"><span>Rôle</span><b>${CRM.me.user.role_label}</b></div><div class="row"><span>Version du CRM</span><b>${CRM.me.version}</b></div></div></div>
        <div class="card"><span class="label">Claude (MCP)</span>
          <p class="small">Un jeton personnel pour interroger le CRM depuis Claude : lire les demandes, devis, paiements et chiffres ; préparer un devis ou une relance. Les actions sensibles (envoyer, rembourser, supprimer) restent à confirmer ici, dans le CRM.</p>
          <div class="rows">${tokens.map((t) => h`<div class="row"><span>${t.label} · créé le ${dShort(t.created_at)}${t.last_used_at ? ` · utilisé le ${dShort(t.last_used_at)}` : ''}</span><button class="act danger" data-del="${t.id}">Révoquer</button></div>`)}</div>
          <button class="btn btn-primary" id="new-token" style="margin-top:12px">Créer un jeton</button>
          <p class="small muted" style="margin-top:12px">Dans Claude : Paramètres › Connecteurs › Ajouter un connecteur personnalisé › collez l'adresse donnée à la création du jeton.</p>
        </div>
      </div>`;
  };
  V.account.bind = (root) => {
    $('#new-token', root).onclick = (e) => busy(e.target, async () => {
      const r = await api('POST', '/api/tokens', { label: 'Claude' });
      await modal('Votre adresse MCP', h`<p class="small">Copiez-la maintenant : elle ne sera plus affichée. Elle donne accès au CRM avec vos droits : ne la partagez pas.</p><div class="copy"><code>${r.url}</code></div>`, { submit: null, onOpen: (f) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'Copier'; b.onclick = () => copy(r.url); $('.actions', f).appendChild(b); } });
      CRM.refresh();
    });
    $$('[data-del]', root).forEach((b) => b.onclick = () => busy(b, async () => { await api('DELETE', `/api/tokens/${b.dataset.del}`); CRM.refresh(); }));
  };

  // ================= Paramètres =================
  const TABS = [['entreprise', 'Entreprise'], ['couleurs', 'Couleurs'], ['acces', 'Accès'], ['devis', 'Devis et paiements'], ['mails', 'Mails et relances'], ['formulaire', 'Formulaire et site'], ['integrations', 'Intégrations']];
  let S = null;
  const COLOR_LABELS = { primary: 'principale', secondary: 'secondaire', accent: 'accent', background: 'fond', card: 'cartes', text: 'texte' };

  V.settings = async ({ parts }) => {
    const tab = parts[1] || 'entreprise';
    S = await api('GET', '/api/settings');
    let body = '';
    const field = (k, l, v, attrs = '') => h`<label class="field"><span>${l}</span><input name="${k}" value="${v ?? ''}" ${raw(attrs)}></label>`;
    if (tab === 'entreprise') {
      const c = S.company;
      body = h`<div class="grid g2"><div class="card"><span class="label">L'entreprise</span><form id="f">
        ${field('name', 'Nom affiché', c.name)}${field('legal_name', 'Raison sociale (devis)', c.legal_name)}${field('address', 'Adresse', c.address)}
        <div class="grid g2">${field('phone', 'Téléphone', c.phone)}${field('email', 'Mail de contact', c.email)}</div>
        <div class="grid g2">${field('siret', 'SIRET', c.siret)}${field('vat_number', 'N° de TVA', c.vat_number)}</div>
        ${field('website', 'Site', c.website)}${field('tagline', 'Signature en bas des devis (ex. activités et ville)', c.tagline)}</form></div>
        <div class="card"><span class="label">Le logo</span>${S.logo ? h`<img src="/logo?t=${Date.now()}" alt="" style="max-width:180px;max-height:120px;display:block;margin-bottom:14px">` : h`<p class="empty">Pas encore de logo.</p>`}
        <label class="field"><span>Image PNG ou JPEG (2 Mo maximum)</span><input type="file" id="logo-file" accept="image/png,image/jpeg"></label>
        <p class="small muted">Il apparaît dans le menu, sur les devis PDF, les mails et les pages client.</p></div></div>`;
    } else if (tab === 'couleurs') {
      const c = S.colors, f = S.fonts;
      body = h`<div class="grid g2"><div class="card"><span class="label">Les couleurs</span><form id="f"><div class="swatches">${Object.entries(COLOR_LABELS).map(([k, l]) => h`<div class="swatch"><input type="color" data-color="${k}" value="${c[k]}"><span>${l}</span><input type="text" name="${k}" value="${c[k]}" maxlength="7"></div>`)}</div></form>
        <div id="contrast" style="margin-top:14px"></div>
        <span class="label" style="display:block;margin-top:18px">Les polices (Google Fonts)</span>
        <form id="f2"><div class="grid g2">${field('title', 'Titres', f.title)}${field('text', 'Texte', f.text)}</div><label class="check"><input type="checkbox" name="title_uppercase" ${f.title_uppercase === false ? '' : 'checked'}><span>Titres en majuscules</span></label></form></div>
        <div class="card"><span class="label">Aperçu en direct</span><div class="preview-box" id="preview" style="background:var(--bg)">
          <h2>Titre de page</h2><p>Texte courant, lisible sur téléphone.</p>
          <div class="kpi" style="margin:12px 0"><b>9 840 €</b><span>chiffre d'affaires signé</span></div>
          <div class="actions"><button type="button" class="btn btn-primary">Créer le devis</button><button type="button" class="btn btn-ghost">Annuler</button></div>
          <div class="dcard" style="margin-top:14px"><b>Anniversaire · 12 enfants</b><span class="muted small">Famille TEST</span><small><span>sam. 15 nov.</span><em>204,00 €</em></small></div>
          <div class="chips"><span class="badge b-nouvelle">Nouvelle demande</span><span class="badge b-devis_envoye">Devis envoyé</span><span class="badge b-signe">Signé</span></div>
        </div></div></div>`;
    } else if (tab === 'acces') {
      const stale = await api('GET', '/api/rgpd/stale');
      body = h`<div class="grid g2"><div class="card"><span class="label">Qui peut se connecter</span><form id="f">${field('allowed_domain', 'Domaine autorisé (ex. mon-entreprise.fr)', S.access.allowed_domain, 'placeholder="mon-entreprise.fr"')}</form>
        <p class="small muted">Seules les adresses vérifiées de ce domaine entrent, avec Google ou avec un code par mail, et seulement si elles ont été invitées (écran Équipe). La vérification se fait sur le serveur.</p>
        <div class="rows"><div class="row"><span>Gérant</span><b>tout</b></div><div class="row"><span>Accueil</span><b>demandes, devis, paiements, relances</b></div><div class="row"><span>Animation</span><b>agenda</b></div></div></div>
        <div class="card"><span class="label">RGPD</span><form id="f-rgpd">${field('retention_years', 'Durée de conservation sans activité (années)', S.rgpd.retention_years, 'type="number" min="1" max="10"')}</form>
        <p class="small muted">Chaque nuit, les contacts sans activité depuis cette durée sont supprimés (ou anonymisés s'ils ont payé). Export et suppression d'un contact : sur sa fiche.</p>
        <p class="small"><b>${stale.length}</b> contact(s) concerné(s) aujourd'hui.${stale.length ? h` <button class="act danger" id="purge">Purger maintenant</button>` : ''}</p></div></div>`;
    } else if (tab === 'devis') {
      const q = S.quotes;
      body = h`<div class="grid g2"><div class="card"><span class="label">Devis</span><form id="f">
        <div class="grid g2">${field('deposit_pct', 'Acompte par défaut (%)', q.deposit_pct, 'type="number" min="0" max="100"')}${field('default_vat', 'TVA par défaut (%)', q.default_vat, 'inputmode="decimal"')}</div>
        <div class="grid g2">${field('validity_days', 'Validité (jours)', q.validity_days, 'type="number" min="1"')}${field('number_prefix', 'Préfixe des numéros', q.number_prefix)}</div>
        <label class="field"><span>Conditions (sur chaque devis)</span><textarea name="conditions" rows="4">${q.conditions}</textarea></label>
        <label class="field"><span>Mentions légales (sur chaque devis)</span><textarea name="legal_mentions" rows="3">${q.legal_mentions}</textarea></label></form>
        <p class="small muted">Numérotation continue : ${q.number_prefix}-AAAA-0001, 0002… Taux de TVA : à faire valider par le comptable.</p></div>
        <div class="card"><span class="label">Paiements</span><p class="small">Stripe Checkout : le montant est toujours calculé par le CRM, sur le serveur. Les clés restent dans le .env du serveur.</p>
        <button class="btn btn-ghost" id="test-pay">Tester : paiement de 1 € (mode test)</button></div></div>`;
    } else if (tab === 'mails') {
      const r = S.reminders;
      body = h`<div class="grid g2"><div class="card"><span class="label">Les règles de relance</span><form id="f">
        <label class="check"><input type="checkbox" name="qu_enabled" ${r.quote_unsigned.enabled ? 'checked' : ''}><span>Devis non signé</span></label>
        <div class="grid g2">${field('qu_days', 'Mails à J+ (séparés par des virgules)', r.quote_unsigned.mail_days.join(', '))}${field('qu_call', 'Tâche « Appeler » à J+', r.quote_unsigned.call_day, 'type="number"')}</div>
        <label class="check"><input type="checkbox" name="du_enabled" ${r.deposit_unpaid.enabled ? 'checked' : ''}><span>Acompte non payé</span></label>
        ${field('du_days', 'Rappels à J+ (après la signature)', r.deposit_unpaid.days.join(', '))}
        <label class="check"><input type="checkbox" name="av_enabled" ${r.after_visit.enabled ? 'checked' : ''}><span>Après la venue : merci et avis Google</span></label>
        <div class="grid g2">${field('av_days', 'À J+', r.after_visit.days, 'type="number"')}${field('av_url', "Lien d'avis Google", r.after_visit.review_url, 'placeholder="https://g.page/r/…"')}</div>
        <label class="check"><input type="checkbox" name="na_enabled" ${r.no_answer.enabled ? 'checked' : ''}><span>Demande sans réponse : alerte à l'équipe</span></label>
        ${field('na_hours', 'Après (heures)', r.no_answer.hours, 'type="number"')}
        <div class="grid g2">${field('w_start', 'Envois à partir de (heure)', r.window.start, 'type="number" min="0" max="23"')}${field('w_end', "Jusqu'à (heure)", r.window.end, 'type="number" min="1" max="24"')}</div>
        <label class="check"><input type="checkbox" name="w_sunday" ${r.window.sunday ? 'checked' : ''}><span>Envoyer aussi le dimanche</span></label></form></div>
        <div class="card"><span class="label">Les modèles de mails</span><p class="small muted">Champs automatiques : {{prenom}}, {{client}}, {{numero}}, {{montant}}, {{date}}, {{validite}}, {{lien}}, {{code}}, {{entreprise}}. Une ligne qui ne contient que {{lien}} devient un bouton.</p>
        <form id="f-mails">${Object.entries(S.mail_templates).map(([k, t]) => h`<details class="tpl"><summary><b>${t.label}</b></summary>
          <label class="field" style="margin-top:10px"><span>Objet</span><input name="${k}.subject" value="${t.subject}"></label>
          <label class="field"><span>Texte</span><textarea name="${k}.body">${t.body}</textarea></label>
          <div class="actions"><a class="act" href="/api/mails/preview/${k}" target="_blank">Aperçu</a><button type="button" class="act" data-testmail="${k}">M'envoyer un test</button></div></details>`)}</form></div></div>`;
    } else if (tab === 'formulaire') {
      const i = S.integrations;
      const types = S.deal_types;
      const base = S.app_url;
      body = h`<div class="grid g2"><div class="card"><span class="label">Le site</span><form id="f">
        ${field('site_url', 'Adresse du site (pour autoriser l’intégration)', i.site_url, 'placeholder="https://www.mon-entreprise.fr"')}
        ${field('calendar_id', 'ID de l’agenda Google des réservations', i.calendar_id, 'placeholder="…@group.calendar.google.com"')}
        ${field('event_duration_min', 'Durée d’une réservation (minutes)', i.event_duration_min, 'type="number"')}</form>
        <span class="label" style="display:block;margin-top:16px">À coller dans les pages du site</span>
        ${types.map((t) => h`<p class="small"><b>${t.label}</b></p><div class="copy"><code>${`<script src="${base}/embed.js" data-crm="formulaire" data-type="${t.key}"></script>`}</code></div>`)}
        <p class="small"><b>Devis automatique</b></p><div class="copy"><code>${`<script src="${base}/embed.js" data-crm="devis"></script>`}</code></div>
        <p class="small muted">Pour une activité précise : ajoutez data-activite="numéro de la prestation".</p></div>
        <div class="card"><span class="label">Types de demande et champs du formulaire</span>
        <p class="small muted">Les champs communs (nom, mail, téléphone, date, message, consentement) sont toujours là. Ici, les champs propres à chaque type, au format JSON. « company » : true range la valeur comme entreprise.</p>
        <textarea id="types-json" rows="22" class="mono">${JSON.stringify(types, null, 2)}</textarea>
        <button class="btn btn-ghost" id="save-types" style="margin-top:10px">Enregistrer les types</button></div></div>`;
    } else if (tab === 'integrations') {
      const st = await api('GET', '/api/integrations');
      const line = (l, s) => h`<div class="row"><span>${l}</span><span class="${s.ok ? 'status-ok' : 'status-ko'}">${s.ok ? '✓ ' : ''}${s.label}</span></div>`;
      body = h`<div class="grid g2"><div class="card"><span class="label">Les intégrations</span><div class="rows">
        ${line('Connexion Google', st.google)}${line('Stripe', st.stripe)}${line('Resend', st.resend)}${line('Google Analytics', st.analytics)}${line('Google Agenda', st.calendar)}${line('Cloudflare Turnstile', st.turnstile)}${line('Site', st.site)}</div>
        <p class="small accent-text" style="margin-top:12px">Les clés restent dans le .env du serveur : jamais affichées ici.</p>
        ${st.stripe.error ? h`<p class="small error">Stripe : ${st.stripe.error}</p>` : ''}${st.analytics.error ? h`<p class="small error">Analytics : ${st.analytics.error}</p>` : ''}${st.calendar.error ? h`<p class="small error">Agenda : ${st.calendar.error}</p>` : ''}
        <label class="switch" style="margin-top:16px"><input type="checkbox" id="demo" ${S.demo ? 'checked' : ''}><i></i>Afficher le badge « Données d'exemple »</label></div>
        <div class="card"><span class="label">Adresses à recopier</span>
        ${[['URI de redirection Google', st.urls.google_redirect], ['Webhook Stripe', st.urls.stripe_webhook], ['Webhook Resend', st.urls.resend_webhook], ['Script du site', st.urls.embed], ['MCP (jeton dans Mon compte)', st.urls.mcp]].map(([l, u]) => h`<p class="small"><b>${l}</b></p><div class="copy"><code>${u}</code><button class="btn btn-sm btn-ghost" data-copy="${u}">Copier</button></div>`)}
        ${st.service_account ? h`<p class="small"><b>Compte de service Google</b> (à ajouter en lecteur dans Analytics et en éditeur de l'agenda)</p><div class="copy"><code>${st.service_account}</code></div>` : ''}</div></div>`;
    }
    const saveBtn = ['entreprise', 'couleurs', 'acces', 'devis', 'mails', 'formulaire'].includes(tab);
    return h`${head('Paramètres', 'Votre entreprise', saveBtn ? h`<button class="btn btn-primary" id="save">Enregistrer</button>` : '')}
      <div class="tabs">${TABS.map(([k, l]) => h`<a class="tab ${tab === k ? 'on' : ''}" href="#/parametres/${k}">${l}</a>`)}<a class="tab" href="#/demarrage">Assistant de démarrage</a></div>${body}`;
  };

  function liveColors(root) {
    const vals = {};
    $$('#f input[type=text]', root).forEach((i) => { vals[i.name] = i.value; });
    const st = document.documentElement.style;
    const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`; };
    if (Object.values(vals).every((v) => /^#[0-9a-f]{6}$/i.test(v))) {
      st.setProperty('--primary', vals.primary); st.setProperty('--secondary', vals.secondary); st.setProperty('--accent', vals.accent);
      st.setProperty('--bg', vals.background); st.setProperty('--card', vals.card); st.setProperty('--text', vals.text);
      st.setProperty('--primary-rgb', rgb(vals.primary)); st.setProperty('--secondary-rgb', rgb(vals.secondary)); st.setProperty('--accent-rgb', rgb(vals.accent)); st.setProperty('--text-rgb', rgb(vals.text));
      st.setProperty('--grad', `linear-gradient(90deg, ${vals.primary}, ${vals.secondary})`);
    }
    return vals;
  }

  async function checkContrast(root) {
    const vals = liveColors(root);
    const { issues } = await api('POST', '/api/settings/colors/check', vals).catch(() => ({ issues: [] }));
    $('#contrast', root).innerHTML = issues.length
      ? h`${issues.map((i) => h`<div class="alert alert-error">${i.message}${i.suggestion ? h` <button type="button" class="act" data-fix="${i.key}" data-val="${i.suggestion}">Utiliser ${i.suggestion}</button>` : ''}</div>`)}`.s
      : h`<div class="alert alert-ok">✓ Contrastes suffisants : le texte reste lisible.</div>`.s;
    $$('[data-fix]', root).forEach((b) => b.onclick = () => { $(`#f input[name=${b.dataset.fix}]`, root).value = b.dataset.val; $(`[data-color=${b.dataset.fix}]`, root).value = b.dataset.val; checkContrast(root); });
    return issues;
  }

  V.settings.bind = (root, { parts }) => {
    const tab = parts[1] || 'entreprise';
    const put = (key, value, extra = {}) => api('PUT', `/api/settings/${key}`, { value, ...extra });
    const done = async (msg = 'Paramètres enregistrés.') => { toast(msg); await CRM.loadMe(); CRM.refresh(); };
    $$('[data-copy]', root).forEach((b) => b.onclick = () => copy(b.dataset.copy));
    const save = $('#save', root);
    if (tab === 'entreprise') {
      save.onclick = () => busy(save, async () => { await put('company', CRM.formData($('#f', root))); await done(); });
      $('#logo-file', root).onchange = (e) => busy(null, async () => { const f = e.target.files[0]; if (!f) return; await api('POST', '/api/settings/logo', { content: await CRM.fileToBase64(f) }); CRM.logoVersion = Date.now(); await done('Logo enregistré.'); });
    }
    if (tab === 'couleurs') {
      $$('[data-color]', root).forEach((c) => c.oninput = () => { $(`#f input[name=${c.dataset.color}]`, root).value = c.value.toUpperCase(); checkContrast(root); });
      $$('#f input[type=text]', root).forEach((i) => i.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(i.value)) { $(`[data-color=${i.name}]`, root).value = i.value; checkContrast(root); } });
      checkContrast(root);
      save.onclick = () => busy(save, async () => {
        const issues = await checkContrast(root);
        if (issues.length) throw new Error('Contraste insuffisant : utilisez la couleur proposée, ou corrigez-la.');
        await put('colors', liveColors(root));
        await put('fonts', CRM.formData($('#f2', root)));
        location.reload();
      });
    }
    if (tab === 'acces') {
      save.onclick = () => busy(save, async () => { await put('access', CRM.formData($('#f', root))); await put('rgpd', { retention_years: Number($('#f-rgpd [name=retention_years]', root).value) || 3 }); await done(); });
      const p = $('#purge', root);
      if (p) p.onclick = async () => { if (await confirmBox('Purger', 'Les contacts sans activité depuis la durée choisie sont supprimés ou anonymisés. Action définitive.', { submit: 'Purger', danger: true })) busy(p, async () => { const r = await api('POST', '/api/rgpd/purge', {}); await done(`${r.purged} contact(s) purgé(s).`); }); };
    }
    if (tab === 'devis') {
      save.onclick = () => busy(save, async () => {
        const v = CRM.formData($('#f', root));
        await put('quotes', { ...v, deposit_pct: Number(v.deposit_pct) || 0, default_vat: Number(String(v.default_vat).replace(',', '.')) || 0, validity_days: Number(v.validity_days) || 30 });
        await done();
      });
      $('#test-pay', root).onclick = (e) => busy(e.target, async () => { const r = await api('POST', '/api/payments/test', {}); window.open(r.link, '_blank'); });
    }
    if (tab === 'mails') {
      const days = (s) => String(s).split(/[,; ]+/).map(Number).filter((n) => n > 0);
      save.onclick = () => busy(save, async () => {
        const v = CRM.formData($('#f', root));
        await put('reminders', {
          quote_unsigned: { enabled: v.qu_enabled, mail_days: days(v.qu_days), call_day: Number(v.qu_call) || 0 },
          deposit_unpaid: { enabled: v.du_enabled, days: days(v.du_days) },
          after_visit: { enabled: v.av_enabled, days: Number(v.av_days) || 1, review_url: v.av_url.trim() },
          no_answer: { enabled: v.na_enabled, hours: Number(v.na_hours) || 24 },
          window: { start: Number(v.w_start) || 9, end: Number(v.w_end) || 19, sunday: v.w_sunday },
        });
        const m = CRM.formData($('#f-mails', root)), mails = {};
        for (const [k, val] of Object.entries(m)) { const [tpl, field] = k.split('.'); (mails[tpl] = mails[tpl] || {})[field] = val; }
        await put('mails', mails);
        await done();
      });
      $$('[data-testmail]', root).forEach((b) => b.onclick = () => busy(b, async () => { const r = await api('POST', '/api/mails/test', { template: b.dataset.testmail }); toast(r.status === 'simulated' ? 'Mail simulé (Resend non branché) : voir le terminal du serveur.' : r.status === 'failed' ? `Échec : ${r.error}` : `Envoyé à ${CRM.me.user.email}.`, r.status === 'failed'); }));
    }
    if (tab === 'formulaire') {
      save.onclick = () => busy(save, async () => { const v = CRM.formData($('#f', root)); await put('integrations', { ...v, event_duration_min: Number(v.event_duration_min) || 120 }); await done(); });
      $('#save-types', root).onclick = (e) => busy(e.target, async () => {
        let v;
        try { v = JSON.parse($('#types-json', root).value); } catch { throw new Error('JSON invalide : vérifiez les virgules et les guillemets.'); }
        await put('deal_types', v);
        await done('Types enregistrés.');
      });
    }
    if (tab === 'integrations') {
      $('#demo', root).onchange = (e) => busy(null, async () => { await put('demo', e.target.checked); await done(); });
    }
  };

  // ================= Assistant de démarrage =================
  V.setup = async ({ params }) => {
    const step = Number(params.get('etape') || 1);
    S = await api('GET', '/api/settings');
    const steps = ['Votre entreprise', 'Vos couleurs', 'Les accès', 'Devis et acompte', 'Vos prix'];
    let body;
    if (step === 1) body = h`<form id="f"><label class="field"><span>Nom de l'entreprise</span><input name="name" value="${S.company.name === 'Mon entreprise' ? '' : S.company.name}" required></label>
      <label class="field"><span>Raison sociale</span><input name="legal_name" value="${S.company.legal_name}"></label><label class="field"><span>Adresse</span><input name="address" value="${S.company.address}"></label>
      <div class="grid g2"><label class="field"><span>Téléphone</span><input name="phone" value="${S.company.phone}"></label><label class="field"><span>Site</span><input name="website" value="${S.company.website}"></label></div></form>
      <label class="field"><span>Logo (PNG ou JPEG)</span><input type="file" id="logo-file" accept="image/png,image/jpeg"></label>${S.logo ? h`<p class="small ok-text">✓ Logo enregistré.</p>` : ''}`;
    if (step === 2) body = h`<p class="small muted">Choisissez vos couleurs : l'aperçu est immédiat, et le contraste est vérifié.</p><form id="f"><div class="swatches">${Object.entries(COLOR_LABELS).map(([k, l]) => h`<div class="swatch"><input type="color" data-color="${k}" value="${S.colors[k]}"><span>${l}</span><input type="text" name="${k}" value="${S.colors[k]}" maxlength="7"></div>`)}</div></form><div id="contrast" style="margin-top:12px"></div>
      <form id="f2"><div class="grid g2"><label class="field"><span>Police des titres</span><input name="title" value="${S.fonts.title}"></label><label class="field"><span>Police du texte</span><input name="text" value="${S.fonts.text}"></label></div><label class="check"><input type="checkbox" name="title_uppercase" ${S.fonts.title_uppercase === false ? '' : 'checked'}><span>Titres en majuscules</span></label></form>`;
    if (step === 3) body = h`<form id="f"><label class="field"><span>Domaine autorisé</span><input name="allowed_domain" value="${S.access.allowed_domain}" placeholder="mon-entreprise.fr" required></label></form><p class="small muted">Seules les adresses @domaine invitées pourront se connecter. Invitez ensuite votre équipe depuis l'écran Équipe.</p>`;
    if (step === 4) body = h`<form id="f"><div class="grid g2"><label class="field"><span>Acompte par défaut (%)</span><input name="deposit_pct" type="number" value="${S.quotes.deposit_pct}"></label><label class="field"><span>TVA par défaut (%)</span><input name="default_vat" value="${S.quotes.default_vat}"></label></div>
      <label class="field"><span>Validité des devis (jours)</span><input name="validity_days" type="number" value="${S.quotes.validity_days}"></label><label class="field"><span>Conditions</span><textarea name="conditions" rows="3">${S.quotes.conditions}</textarea></label></form>`;
    if (step === 5) {
      const list = await api('GET', '/api/products');
      body = h`<p class="small muted">Ajoutez vos prestations et leurs vrais prix. N'inventez aucun prix : une prestation « sur devis » n'a pas de montant.</p>
        <div class="rows">${list.map((p) => h`<div class="row"><span>${p.name}${p.example ? ' · PRIX D’EXEMPLE' : ''}</span><b>${p.price_cents === null ? 'sur devis' : money(p.price_cents)} ${p.pricing === 'per_person' ? '/ pers.' : ''}</b></div>`)}</div>
        <button class="btn btn-ghost" id="add-product" style="margin-top:12px">+ Prestation</button>`;
    }
    return h`${head(`Assistant de démarrage · étape ${step} sur 5`, steps[step - 1])}
      <div class="steps">${steps.map((s, i) => h`<button data-go="${i + 1}" class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}">${i + 1}. ${s}</button>`)}</div>
      <div class="card" style="max-width:720px">${body}
      <div class="actions" style="margin-top:18px;justify-content:space-between"><button class="link" id="later">Plus tard</button><span class="actions">${step > 1 ? h`<a class="btn btn-ghost" href="#/demarrage?etape=${step - 1}">Retour</a>` : ''}<button class="btn btn-primary" id="next">${step === 5 ? 'Terminer' : 'Continuer'}</button></span></div></div>`;
  };
  V.setup.bind = (root, { params }) => {
    const step = Number(params.get('etape') || 1);
    const put = (key, value) => api('PUT', `/api/settings/${key}`, { value });
    $$('[data-go]', root).forEach((b) => b.onclick = () => { location.hash = `#/demarrage?etape=${b.dataset.go}`; });
    $('#later', root).onclick = () => { sessionStorage.setItem('setup-later', '1'); location.hash = '#/'; CRM.refresh(); };
    if (step === 1) $('#logo-file', root).onchange = (e) => busy(null, async () => { const f = e.target.files[0]; if (!f) return; await api('POST', '/api/settings/logo', { content: await CRM.fileToBase64(f) }); CRM.logoVersion = Date.now(); await CRM.loadMe(); toast('Logo enregistré.'); CRM.refresh(); });
    if (step === 2) {
      $$('[data-color]', root).forEach((c) => c.oninput = () => { $(`#f input[name=${c.dataset.color}]`, root).value = c.value.toUpperCase(); checkContrast(root); });
      $$('#f input[type=text]', root).forEach((i) => i.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(i.value)) { $(`[data-color=${i.name}]`, root).value = i.value; checkContrast(root); } });
      checkContrast(root);
    }
    if (step === 5) $('#add-product', root).onclick = () => CRM.productForm();
    $('#next', root).onclick = (e) => busy(e.target, async () => {
      if (step === 1) { const v = CRM.formData($('#f', root)); if (!v.name.trim()) throw new Error("Indiquez le nom de l'entreprise."); await put('company', { ...S.company, ...v }); }
      if (step === 2) { const issues = await checkContrast(root); if (issues.length) throw new Error('Contraste insuffisant : utilisez la couleur proposée.'); await put('colors', liveColors(root)); await put('fonts', CRM.formData($('#f2', root))); }
      if (step === 3) await put('access', CRM.formData($('#f', root)));
      if (step === 4) { const v = CRM.formData($('#f', root)); await put('quotes', { ...S.quotes, ...v, deposit_pct: Number(v.deposit_pct) || 0, default_vat: Number(String(v.default_vat).replace(',', '.')) || 0, validity_days: Number(v.validity_days) || 30 }); }
      if (step === 5) { await api('POST', '/api/setup/done', {}); await CRM.loadMe(); toast('Votre CRM est prêt.'); location.hash = '#/'; location.reload(); return; }
      await CRM.loadMe();
      if (step === 2) { location.hash = `#/demarrage?etape=3`; location.reload(); return; }
      location.hash = `#/demarrage?etape=${step + 1}`;
    });
  };
})();
