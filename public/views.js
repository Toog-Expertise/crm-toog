/* Écrans : tableau de bord, demandes, fiche d'une demande, contacts et entreprises. */
'use strict';
(function () {
  const { h, raw, $, $$, api, toast, modal, confirmBox, busy, copy, money, dShort, dDay, dTime, dLong, relative, toLocalInput, head, can } = window.CRM;
  const V = window.CRM.views;
  const stageLabel = (k) => (CRM.me.stages.find((s) => s.key === k) || { label: k }).label;
  const typeDef = (k) => CRM.me.deal_types.find((t) => t.key === k) || { key: k, label: k, fields: [], people_label: 'Nombre de personnes' };
  const SOURCES = { site: 'site', devis_auto: 'devis auto', telephone: 'téléphone', accueil: 'accueil', salon: 'salon', crm: 'CRM', import: 'import', api: 'API' };
  const badge = (stage) => h`<span class="badge b-${stage}">${stageLabel(stage)}</span>`;
  const firstName = () => CRM.me.user.name.split(' ')[0];

  // ================= Tableau de bord =================
  V.dashboard = async ({ params }) => {
    const period = params.get('periode') || 'mois';
    const d = await api('GET', `/api/dashboard?periode=${period}`);
    const k = d.kpis;
    const ga = d.analytics;
    const chart = ga.enabled && !ga.error && ga.weeks.length
      ? { title: 'Visites par semaine · Google Analytics', rows: ga.weeks.map((w) => ({ label: w.week, v: w.visits })) }
      : { title: 'Demandes par semaine', rows: d.deals_by_week.map((w) => ({ label: w.week, v: w.deals })) };
    const max = Math.max(1, ...chart.rows.map((r) => r.v));
    const fmax = Math.max(1, ...d.funnel.map((f) => f.value || 0));
    return h`${head(`Tableau de bord · ${d.label}`, `Bonjour ${firstName()}`, h`<select id="period"><option value="semaine" ${period === 'semaine' ? 'selected' : ''}>Cette semaine</option><option value="mois" ${period === 'mois' ? 'selected' : ''}>Ce mois-ci</option><option value="annee" ${period === 'annee' ? 'selected' : ''}>Cette année</option></select>`)}
      ${d.pending_actions.length ? h`<div class="card" style="margin-bottom:18px"><span class="label">À confirmer · demandé depuis Claude</span><div class="rows">${d.pending_actions.map((a) => h`<div class="row"><span>${a.label}</span><span class="actions"><button class="act" data-pa="${a.id}" data-dec="confirmer">Confirmer</button><button class="act danger" data-pa="${a.id}" data-dec="refuser">Refuser</button></span></div>`)}</div></div>` : ''}
      <div class="kpis">
        <div class="kpi"><b>${k.visits === null ? '—' : k.visits.toLocaleString('fr-FR')}</b><span>visites du site ${ga.enabled ? (ga.error ? '(Analytics en erreur)' : '(GA4)') : '(Analytics non branché)'}</span></div>
        <div class="kpi"><b>${k.deals}</b><span>demandes</span></div>
        <div class="kpi"><b>${k.sent}</b><span>devis envoyés</span></div>
        <div class="kpi"><b>${k.signed}</b><span>devis signés</span></div>
        <div class="kpi"><b>${money(k.signed_amount).replace(',00', '')}</b><span>chiffre d'affaires signé</span></div>
        <div class="kpi"><b>${money(k.cashed).replace(',00', '')}</b><span>encaissé (Stripe)</span></div>
      </div>
      <div class="grid g3-wide">
        <div class="card"><span class="label">${chart.title}</span>
          <div class="bars">${chart.rows.map((r) => h`<div><small>${r.v}</small><i style="height:${Math.round((r.v / max) * 100)}%"></i>${r.label}</div>`)}</div>
          ${ga.enabled && ga.sources.length ? h`<div class="rows" style="margin-top:14px">${ga.sources.map((s) => h`<div class="row"><span>${s.source}</span><b>${s.visits}</b></div>`)}</div>` : ''}
          ${ga.error ? h`<p class="small error">${ga.error}</p>` : ''}
        </div>
        <div class="card"><span class="label">De la visite au devis signé</span>
          <div class="funnel">${d.funnel.map((f) => h`<div class="f"><span>${f.label}</span><i><u style="width:${f.value === null ? 0 : Math.round(((f.value || 0) / fmax) * 100)}%"></u></i><b>${f.value === null ? '—' : f.value}</b></div>`)}</div>
          <div class="rows"><div class="row"><span>Taux de signature</span><b>${k.rate} %</b></div></div>
          ${d.upcoming.length ? h`<span class="label" style="display:block;margin-top:16px">Prochaines venues</span><div class="rows">${d.upcoming.map((e) => h`<div class="row"><a href="#/demandes/${e.deal_id}">${e.title}</a><b>${e.when}</b></div>`)}</div>` : ''}
        </div>
        <div class="card"><span class="label">À faire aujourd'hui</span>
          <div class="rows">${d.todo.length ? d.todo.map((t) => h`<div class="row"><a href="${t.deal_id ? `#/demandes/${t.deal_id}` : '#/'}">${t.text}</a><b>${t.tag}</b></div>`) : h`<p class="empty">Rien d'urgent. Bonne journée !</p>`}</div>
        </div>
      </div>`;
  };
  V.dashboard.bind = (root) => {
    $('#period', root).onchange = (e) => { location.hash = `#/?periode=${e.target.value}`; };
    $$('[data-pa]', root).forEach((b) => b.onclick = () => busy(b, async () => {
      if (b.dataset.dec === 'confirmer' && !(await confirmBox('Confirmer l’action', 'Cette action a été demandée depuis Claude. La confirmer maintenant ?'))) return;
      const r = await api('POST', `/api/pending/${b.dataset.pa}/${b.dataset.dec}`, {});
      toast(b.dataset.dec === 'confirmer' ? `Fait (${r.result}).` : 'Refusée.');
      await CRM.loadMe(); CRM.refresh();
    }));
  };

  // ================= Demandes : une colonne par étape =================
  let showLost = false;
  V.deals = async (ctx) => {
    if (ctx.parts[1] === 'nouvelle') { setTimeout(newDeal, 0); location.hash = '#/demandes'; return undefined; }
    if (ctx.parts[1]) return V.deal(ctx);
    const p = ctx.params;
    const qs = new URLSearchParams();
    for (const k of ['source', 'type', 'q']) if (p.get(k)) qs.set(k, p.get(k));
    const d = await api('GET', `/api/deals?${qs}`);
    const stages = CRM.me.stages.filter((s) => showLost || s.key !== 'perdu');
    return h`${head(`CRM · ${CRM.me.company.name}`, 'Les demandes', h`<input id="q" placeholder="Rechercher…" value="${p.get('q') || ''}"><button class="btn btn-primary" id="new-deal">+ Nouvelle demande</button>`)}
      <div class="kpis">
        <div class="kpi"><b>${d.kpis.week}</b><span>demandes cette semaine</span></div>
        <div class="kpi"><b>${d.kpis.sent}</b><span>devis envoyés en attente</span></div>
        <div class="kpi"><b>${d.kpis.signed}</b><span>devis signés ce mois-ci</span></div>
        <div class="kpi"><b>${money(d.kpis.signed_amount).replace(',00', '')}</b><span>signé ce mois-ci</span></div>
      </div>
      <div class="actions" style="margin-bottom:16px">
        <div class="chips">${[['', 'Toutes'], ...Object.entries(SOURCES).filter(([k]) => !['import', 'crm'].includes(k))].map(([k, l]) => h`<button class="chip ${(p.get('source') || '') === k ? 'on' : ''}" data-source="${k}">${l}</button>`)}</div>
        <select id="type-filter" style="width:auto"><option value="">Tous les types</option>${CRM.me.deal_types.map((t) => h`<option value="${t.key}" ${p.get('type') === t.key ? 'selected' : ''}>${t.label}</option>`)}</select>
        <label class="switch small"><input type="checkbox" id="show-lost" ${showLost ? 'checked' : ''}><i></i>Perdues</label>
        ${can('contacts') ? h`<a class="link small" href="#/contacts?import=1">Importer des contacts</a>` : ''}
      </div>
      <div class="board">${stages.map((s) => {
        const list = d.deals.filter((x) => x.stage === s.key);
        return h`<div class="col" data-col="${s.key}"><h3>${s.label}<small>${list.length}</small></h3>${list.map((x) => h`
          <a class="dcard" href="#/demandes/${x.id}" draggable="true" data-id="${x.id}" data-stage="${x.stage}">
            <b>${x.title}</b><span class="muted small">${x.company || x.contact || '—'}</span>
            <small><span>${x.event_at ? dDay(x.event_at) : SOURCES[x.source] || x.source}</span><em>${x.quote ? (x.quote.total ? money(x.quote.total) : 'sur devis') : (s.key === 'nouvelle' ? '' : 'à chiffrer')}</em></small>
            <select data-move="${x.id}" aria-label="Changer d'étape"><option value="">Changer d'étape…</option>${CRM.me.stages.filter((o) => o.key !== x.stage).map((o) => h`<option value="${o.key}">${o.label}</option>`)}</select>
          </a>`)}</div>`;
      })}</div>`;
  };
  V.deals.bind = (root, ctx) => {
    if (ctx.parts[1]) return V.deal.bind(root, ctx);
    const setParam = (k, v) => { const p = new URLSearchParams(ctx.params); v ? p.set(k, v) : p.delete(k); location.hash = `#/demandes?${p}`; };
    $('#new-deal', root).onclick = () => newDeal();
    let t;
    $('#q', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => setParam('q', e.target.value.trim()), 400); };
    $$('[data-source]', root).forEach((b) => b.onclick = () => setParam('source', b.dataset.source));
    $('#type-filter', root).onchange = (e) => setParam('type', e.target.value);
    $('#show-lost', root).onchange = (e) => { showLost = e.target.checked; CRM.refresh(); };
    const move = async (id, stage) => {
      let note = '';
      if (stage === 'perdu') { const r = await modal('Demande perdue', h`<label class="field"><span>Raison (facultatif)</span><input name="note" placeholder="ex. trop cher, date prise"></label>`, { submit: 'Marquer perdue' }); if (!r) return CRM.refresh(); note = r.note; }
      try { await api('POST', `/api/deals/${id}/stage`, { stage, note }); toast(`Étape : ${stageLabel(stage)}`); } catch (e) { toast(e.message, true); }
      CRM.refresh();
    };
    // Glisser-déposer (ordinateur)
    $$('.dcard', root).forEach((c) => c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.dataset.id)));
    $$('.col', root).forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (id) move(id, col.dataset.col); });
    });
    // « Changer d'étape » (téléphone)
    $$('[data-move]', root).forEach((s) => {
      s.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      s.addEventListener('change', () => { if (s.value) move(s.dataset.move, s.value); });
    });
  };

  // Formulaire « Nouvelle demande » : les mêmes champs que le formulaire du site
  function typeFields(type, data = {}) {
    const t = typeDef(type);
    return h`${(t.fields || []).map((f) => h`<label class="field custom"><span>${f.label}${f.required ? ' *' : ''}</span><input name="data.${f.key}" value="${data[f.key] || ''}"></label>`)}`;
  }
  async function newDeal(prefill = {}) {
    const types = CRM.me.deal_types;
    const first = prefill.type || types[0]?.key;
    const content = h`
      <div class="field"><span>Type de demande</span><select name="type" id="nd-type">${types.map((t) => h`<option value="${t.key}" ${t.key === first ? 'selected' : ''}>${t.label}</option>`)}</select></div>
      <div id="nd-fields">${typeFields(first)}</div>
      <div class="grid g2"><label class="field"><span id="nd-people-label">${typeDef(first).people_label}</span><input name="people" type="number" min="1"></label>
      <label class="field"><span>Date souhaitée</span><input name="event_at" type="datetime-local"></label></div>
      <label class="field"><span>Nom et prénom</span><input name="name" value="${prefill.name || ''}" required></label>
      <div class="grid g2"><label class="field"><span>Mail</span><input name="email" type="email" value="${prefill.email || ''}"></label>
      <label class="field"><span>Téléphone</span><input name="phone" value="${prefill.phone || ''}"></label></div>
      <div class="grid g2"><label class="field"><span>Source</span><select name="source"><option value="telephone">Téléphone</option><option value="accueil">Accueil</option><option value="salon">Salon</option><option value="site">Site (saisie manuelle)</option><option value="crm">Autre</option></select></label>
      <label class="field"><span>Attribuée à</span><select name="assigned_to">${CRM.me.users.map((u) => h`<option value="${u.id}" ${u.id === CRM.me.user.id ? 'selected' : ''}>${u.name}</option>`)}</select></label></div>
      <label class="field"><span>Message ou besoin</span><textarea name="message" rows="2"></textarea></label>
      <label class="check"><input type="checkbox" name="consent"><span>Le client a donné son accord pour être recontacté (RGPD)</span></label>`;
    const v = await modal('Nouvelle demande', content, {
      submit: 'Créer la demande',
      onOpen: (f) => { $('#nd-type', f).onchange = (e) => { $('#nd-fields', f).innerHTML = typeFields(e.target.value).s; $('#nd-people-label', f).textContent = typeDef(e.target.value).people_label; }; },
    });
    if (!v) return;
    const data = {};
    for (const [k, val] of Object.entries(v)) if (k.startsWith('data.')) { data[k.slice(5)] = val; delete v[k]; }
    try {
      const r = await api('POST', '/api/deals', { ...v, data });
      toast('Demande créée.');
      location.hash = `#/demandes/${r.id}`;
    } catch (e) { toast(e.message, true); }
  }
  CRM.newDeal = newDeal;

  // ================= Fiche d'une demande =================
  const KIND_DOT = { mail: 'k-mail', payment: 'k-payment', sign: 'k-sign', reminder: 'k-reminder', note: 'k-note', call: 'k-call' };
  const PAY = { pending: 'En attente', paid: 'Payé', failed: 'Échec', refunded: 'Remboursé', partially_refunded: 'Remboursé en partie', cancelled: 'Annulé' };
  const QST = { draft: 'brouillon', sent: 'envoyé', signed: 'signé', cancelled: 'annulé' };
  CRM.labels = { PAY, QST, SOURCES, stageLabel, typeDef, badge };

  V.deal = async ({ parts }) => {
    const d = await api('GET', `/api/deals/${parts[1]}`);
    const deal = d.deal, c = d.contact || {}, t = typeDef(deal.type);
    const name = d.company?.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Sans nom';
    const unit = deal.type === 'anniversaire' ? 'enfants' : 'pers.';
    const q = d.quotes.find((x) => x.status !== 'cancelled');
    const steps = CRM.me.stages.filter((s) => s.key !== 'perdu');
    const idx = steps.findIndex((s) => s.key === deal.stage);
    const active = d.reminders.filter((r) => r.status === 'scheduled');
    const paused = d.reminders.filter((r) => r.status === 'paused');
    const next = active[0];
    const row = (k, v) => (v ? h`<div class="row"><span>${k}</span><b>${v}</b></div>` : '');
    const mainAction = !q ? h`<button class="btn btn-primary" id="create-quote">Créer le devis</button>`
      : q.status === 'draft' ? h`<a class="btn btn-primary" href="#/devis/${q.id}">Finir le devis</a>`
      : q.status === 'sent' ? h`<button class="btn btn-primary" id="ask-sign" data-q="${q.id}">Demander la signature</button>` : '';
    return h`${head(`Demande · ${t.label}`, `${name}${deal.people ? ` · ${deal.people} ${unit}` : ''}`, h`${deal.stage === 'perdu' ? badge('perdu') : ''}<button class="btn btn-ghost" id="edit-deal">Modifier</button>${mainAction}`)}
      <div class="steps">${steps.map((s, i) => h`<button data-stage="${s.key}" class="${s.key === deal.stage ? 'on' : i < idx ? 'done' : ''}">${s.label}</button>`)}</div>
      <div class="grid g3">
        <div class="card"><span class="label">La demande</span><div class="rows">
          ${row('Contact', c.id ? raw(h`<a href="#/contacts/${c.id}">${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</a>`.s) : '—')}
          ${row('Entreprise', d.company?.name)}
          ${row('Mail', c.email)}${row('Téléphone', c.phone)}
          ${row('Date souhaitée', deal.event_at ? dLong(deal.event_at) : null)}
          ${row(t.people_label, deal.people)}
          ${(t.fields || []).map((f) => row(f.label, deal.data[f.key]))}
          ${row('Options', (deal.data.options || []).length ? `${deal.data.options.length} option(s)` : null)}
          ${row('Source', `${SOURCES[deal.source] || deal.source}${deal.source_page ? ` · ${deal.source_page}` : ''}`)}
          ${row('Consentement', c.consent_at ? `oui · ${dShort(c.consent_at)}` : 'non renseigné')}
          ${deal.lost_reason ? row('Raison de la perte', deal.lost_reason) : ''}
          <div class="row"><span>Attribuée à</span><select id="assign" style="width:auto">${[h`<option value="">—</option>`, ...CRM.me.users.map((u) => h`<option value="${u.id}" ${u.id === deal.assigned_to ? 'selected' : ''}>${u.name}</option>`)]}</select></div>
        </div>
        ${deal.message ? h`<p class="small" style="white-space:pre-wrap;margin-top:14px">${deal.message}</p>` : ''}
        ${deal.stage !== 'perdu' ? h`<button class="act danger" id="lost" style="margin-top:14px">Marquer comme perdue</button>` : ''}
        </div>
        <div class="card"><span class="label">L'historique</span>
          <form class="note-form" id="note-form"><textarea name="text" rows="1" placeholder="Ajouter une note, le résumé d'un appel…"></textarea><button class="btn btn-sm btn-primary">Ajouter</button></form>
          <ul class="timeline">${[...active.slice(0, 1).map((r) => h`<li class="k-reminder"><small>${dTime(r.due_at)}</small><b>${r.label} prévue</b></li>`),
            ...d.activities.map((a) => h`<li class="${KIND_DOT[a.kind] || ''}"><small>${dTime(a.created_at)}</small><b>${a.text}</b></li>`)]}</ul>
        </div>
        <div class="card"><span class="label">Le devis</span>
          ${q ? h`<div class="actions" style="justify-content:space-between"><b>${q.number}</b><span class="big-amount">${money(q.total_ttc)}</span></div>
            <p class="small muted">${QST[q.status]}${q.sent_at ? ` · envoyé le ${dShort(q.sent_at)}` : ''}${q.viewed_at ? ` · ouvert le ${dShort(q.viewed_at)}` : ''}${q.signed_at ? ` · signé le ${dShort(q.signed_at)}` : ''}</p>
            <div class="actions"><a class="link" href="/api/quotes/${q.id}/pdf" target="_blank">Voir le PDF</a>${q.status !== 'signed' ? h`<a class="link" href="#/devis/${q.id}">Modifier</a>` : ''}${q.status === 'sent' ? h`<button class="link" data-resend="${q.id}">Renvoyer</button>` : ''}${q.sign_url && q.status !== 'signed' ? h`<button class="link" data-copy="${q.sign_url}">Lien de signature</button>` : ''}</div>`
            : h`<p class="empty">Pas encore de devis.</p>`}
          ${can('paiements') ? h`<span class="label" style="display:block;margin-top:18px">Les paiements</span>
          <div class="rows">${d.payments.length ? d.payments.map((p) => h`<div class="row"><span>${p.label}<br><span class="badge b-${p.status}">${PAY[p.status]}</span></span><span><b>${money(p.amount_cents)}</b><br>${p.link ? h`<button class="act" data-copy="${p.link}">Copier le lien</button> <button class="act" data-paysend="${p.id}">Envoyer</button>` : ''}${['paid', 'partially_refunded'].includes(p.status) ? h`<button class="act danger" data-refund="${p.id}" data-max="${p.amount_cents - p.refunded_cents}">Rembourser</button>` : ''}</span></div>`) : h`<p class="empty">Aucun paiement.</p>`}</div>
          <div class="actions" style="margin-top:10px">${q && ['sent', 'signed'].includes(q.status) ? h`<button class="btn btn-sm btn-ghost" data-pay="deposit">Lien d'acompte</button>` : ''}${q && q.status === 'signed' ? h`<button class="btn btn-sm btn-ghost" data-pay="balance">Demander le solde</button>` : ''}<button class="btn btn-sm btn-ghost" data-pay="free">Lien de paiement libre</button></div>` : ''}
          ${can('relances') ? h`<span class="label" style="display:block;margin-top:18px">Les relances</span>
          <label class="switch"><input type="checkbox" id="rem-toggle" ${deal.reminders_paused ? '' : 'checked'}><i></i>${deal.reminders_paused ? `Coupées${paused.length ? ` · ${paused.length} en pause` : ''}` : next ? `Actives · prochaine ${relative(next.due_at)}` : 'Actives · aucune prévue'}</label>
          <div class="actions" style="margin-top:8px"><button class="act" id="replied">Le client a répondu</button><button class="act" id="manual-rem">+ Relance manuelle</button></div>` : ''}
          <span class="label" style="display:block;margin-top:18px">Tâches</span>
          <div>${d.tasks.map((tk) => h`<label class="task ${tk.done_at ? 'done' : ''}"><input type="checkbox" data-task="${tk.id}" ${tk.done_at ? 'checked' : ''}><span>${tk.title}</span><small>${tk.due_at ? dShort(tk.due_at) : ''}</small></label>`)}</div>
          <button class="act" id="add-task" style="margin-top:8px">+ Tâche</button>
          ${d.emails.length ? h`<span class="label" style="display:block;margin-top:18px">Mails</span><div class="rows">${d.emails.slice(0, 6).map((m) => h`<div class="row"><span>${m.subject}<br><small class="muted">${m.to_addr} · ${dTime(m.created_at)}</small></span><span class="badge b-${m.status === 'bounced' || m.status === 'failed' ? 'failed' : m.status === 'opened' || m.status === 'delivered' || m.status === 'clicked' ? 'paid' : 'draft'}">${({ queued: 'en file', sent: 'envoyé', delivered: 'délivré', opened: 'ouvert', clicked: 'cliqué', bounced: 'rejeté', complained: 'spam', failed: 'échec', simulated: 'simulé', delayed: 'retardé' })[m.status] || m.status}</span></div>`)}</div>` : ''}
        </div>
      </div>`;
  };

  V.deal.bind = (root, { parts }) => {
    const id = parts[1];
    const post = (url, body = {}) => api('POST', url, body);
    const reload = () => CRM.refresh();
    $$('.steps [data-stage]', root).forEach((b) => b.onclick = () => busy(b, async () => { await post(`/api/deals/${id}/stage`, { stage: b.dataset.stage }); toast(`Étape : ${stageLabel(b.dataset.stage)}`); reload(); }));
    const lost = $('#lost', root);
    if (lost) lost.onclick = async () => { const r = await modal('Demande perdue', h`<label class="field"><span>Raison (facultatif)</span><input name="note"></label>`, { submit: 'Marquer perdue', danger: true }); if (r) { await post(`/api/deals/${id}/stage`, { stage: 'perdu', note: r.note }); reload(); } };
    $('#assign', root).onchange = (e) => busy(null, async () => { await api('PUT', `/api/deals/${id}`, { assigned_to: e.target.value || null }); toast('Attribution enregistrée.'); reload(); });
    $('#note-form', root).onsubmit = (e) => { e.preventDefault(); const text = e.target.text.value.trim(); if (!text) return; busy(e.submitter, async () => { await post(`/api/deals/${id}/note`, { text }); reload(); }); };
    const cq = $('#create-quote', root);
    if (cq) cq.onclick = () => busy(cq, async () => { const q = await post(`/api/deals/${id}/quotes`); location.hash = `#/devis/${q.id}`; });
    const ask = $('#ask-sign', root);
    if (ask) ask.onclick = () => busy(ask, async () => { if (!(await confirmBox('Demander la signature', 'Le client reçoit un lien secret, valable 30 jours, pour signer le devis avec un code envoyé par mail.', { submit: 'Envoyer' }))) return; const r = await post(`/api/quotes/${ask.dataset.q}/send`, { mode: 'demande_signature' }); toast(r.mail === 'simulated' ? 'Envoi simulé (Resend non branché).' : 'Demande de signature envoyée.'); reload(); });
    $$('[data-resend]', root).forEach((b) => b.onclick = () => busy(b, async () => { const r = await post(`/api/quotes/${b.dataset.resend}/send`, { mode: 'devis' }); toast(r.mail === 'simulated' ? 'Envoi simulé (Resend non branché).' : 'Devis renvoyé.'); reload(); }));
    $$('[data-copy]', root).forEach((b) => b.onclick = () => copy(b.dataset.copy));
    $$('[data-paysend]', root).forEach((b) => b.onclick = () => busy(b, async () => { await post(`/api/payments/${b.dataset.paysend}/send`); toast('Lien de paiement envoyé.'); reload(); }));
    $$('[data-refund]', root).forEach((b) => b.onclick = async () => {
      const r = await modal('Rembourser', h`<p>Le remboursement part immédiatement vers la carte du client, par Stripe.</p><label class="field"><span>Montant en euros (maximum ${money(Number(b.dataset.max))})</span><input name="amount" inputmode="decimal" value="${(Number(b.dataset.max) / 100).toFixed(2).replace('.', ',')}"></label>`, { submit: 'Rembourser', danger: true });
      if (r) busy(b, async () => { await post(`/api/payments/${b.dataset.refund}/refund`, { amount: r.amount, confirm: true }); toast('Remboursement effectué.'); reload(); });
    });
    $$('[data-pay]', root).forEach((b) => b.onclick = async () => {
      const kind = b.dataset.pay;
      let body = { kind, deal_id: Number(id) };
      if (kind === 'free') {
        const r = await modal('Lien de paiement libre', h`<label class="field"><span>Montant en euros</span><input name="amount" inputmode="decimal" required></label><label class="field"><span>Libellé</span><input name="label" value="paiement libre"></label><label class="check"><input type="checkbox" name="send" checked><span>Envoyer le lien au client par mail</span></label>`, { submit: 'Créer le lien' });
        if (!r) return;
        body = { ...body, ...r };
      } else {
        const r = await modal(kind === 'balance' ? 'Demander le solde' : "Lien d'acompte", h`<p>Le montant est calculé par le CRM à partir du devis.</p><label class="check"><input type="checkbox" name="send" checked><span>Envoyer le lien au client par mail</span></label>`, { submit: 'Créer le lien' });
        if (!r) return;
        body.send = r.send;
      }
      busy(b, async () => { const r = await post('/api/payments', body); toast(body.send ? 'Lien envoyé au client.' : 'Lien créé.'); if (!body.send) copy(r.link); reload(); });
    });
    const tog = $('#rem-toggle', root);
    if (tog) tog.onchange = () => busy(null, async () => { await post(`/api/deals/${id}/reminders/${tog.checked ? 'resume' : 'cut'}`); reload(); });
    const rep = $('#replied', root);
    if (rep) rep.onclick = () => busy(rep, async () => { await post(`/api/deals/${id}/replied`); toast('Relances automatiques arrêtées.'); reload(); });
    const man = $('#manual-rem', root);
    if (man) man.onclick = () => manualReminder(id);
    $('#add-task', root).onclick = async () => {
      const r = await modal('Nouvelle tâche', h`<label class="field"><span>Tâche</span><input name="title" required placeholder="ex. Rappeler si pas signé"></label><label class="field"><span>Pour le</span><input type="datetime-local" name="due_at"></label>`, { submit: 'Ajouter' });
      if (r) busy(null, async () => { await post(`/api/deals/${id}/tasks`, r); reload(); });
    };
    $$('[data-task]', root).forEach((cb) => cb.onchange = () => busy(null, async () => { await api('PUT', `/api/tasks/${cb.dataset.task}`, { done: cb.checked }); reload(); }));
    $('#edit-deal', root).onclick = () => editDeal(id);
  };

  async function manualReminder(dealId) {
    const r = await modal('Relance manuelle', h`<div class="field"><span>Canal</span><select name="channel"><option value="mail">Mail au client</option><option value="call">Appel (tâche)</option></select></div><label class="field"><span>Quand</span><input type="datetime-local" name="due_at" value="${toLocalInput(CRM.now() + 86400e3).slice(0, 11)}10:00"></label><label class="field"><span>Message</span><textarea name="message" rows="4" placeholder="Le texte du mail (le bonjour et la signature sont ajoutés)"></textarea></label>`, { submit: 'Programmer' });
    if (r) busy(null, async () => { await api('POST', `/api/deals/${dealId}/reminders`, r); toast('Relance programmée.'); CRM.refresh(); });
  }
  CRM.manualReminder = manualReminder;

  async function editDeal(id) {
    const d = await api('GET', `/api/deals/${id}`);
    const deal = d.deal, t = typeDef(deal.type);
    const r = await modal('Modifier la demande', h`
      <label class="field"><span>Titre</span><input name="title" value="${deal.title}"></label>
      <div class="field"><span>Type</span><select name="type">${CRM.me.deal_types.map((x) => h`<option value="${x.key}" ${x.key === deal.type ? 'selected' : ''}>${x.label}</option>`)}</select></div>
      <div class="grid g2"><label class="field"><span>${t.people_label}</span><input name="people" type="number" value="${deal.people || ''}"></label>
      <label class="field"><span>Date de la venue</span><input name="event_at" type="datetime-local" value="${toLocalInput(deal.event_at)}"></label></div>
      ${typeFields(deal.type, deal.data)}
      <label class="field"><span>Message</span><textarea name="message" rows="3">${deal.message || ''}</textarea></label>`, { submit: 'Enregistrer' });
    if (!r) return;
    const data = { ...deal.data };
    for (const [k, v] of Object.entries(r)) if (k.startsWith('data.')) { data[k.slice(5)] = v; delete r[k]; }
    busy(null, async () => { await api('PUT', `/api/deals/${id}`, { ...r, data }); toast('Demande enregistrée.'); CRM.refresh(); });
  }

  // ================= Contacts et entreprises =================
  V.contacts = async (ctx) => {
    const { parts, params, view } = ctx;
    if (view === 'contacts' && parts[1]) return V.contact(ctx);
    if (view === 'entreprises' && parts[1]) return V.company(ctx);
    const companies = view === 'entreprises';
    const q = params.get('q') || '';
    const list = await api('GET', `/api/${companies ? 'companies' : 'contacts'}?q=${encodeURIComponent(q)}`);
    if (params.get('import')) setTimeout(importContacts, 0);
    return h`${head(`CRM · ${CRM.me.company.name}`, companies ? 'Les entreprises' : 'Les contacts', h`<input id="q" placeholder="Rechercher…" value="${q}">${companies ? '' : h`<button class="btn btn-ghost" id="import">Importer</button><button class="btn btn-primary" id="new-contact">+ Contact</button>`}`)}
      <div class="tabs"><a class="tab ${companies ? '' : 'on'}" href="#/contacts">Contacts</a><a class="tab ${companies ? 'on' : ''}" href="#/entreprises">Entreprises</a></div>
      ${companies
        ? h`<div class="list-head cols-contacts"><span>Entreprise</span><span>Mail</span><span>Téléphone</span><span>Contacts</span><span>Demandes</span></div>
          ${list.map((co) => h`<a class="list-row cols-contacts" href="#/entreprises/${co.id}" style="text-decoration:none"><span><b>${co.name}</b><small>${co.siret || ''}</small></span><span>${co.email || '—'}</span><span>${co.phone || '—'}</span><span>${co.contacts}</span><span>${co.deals}</span></a>`)}`
        : h`<div class="list-head cols-contacts"><span>Nom</span><span>Mail</span><span>Téléphone</span><span>Entreprise</span><span>Demandes</span></div>
          ${list.map((c) => h`<a class="list-row cols-contacts" href="#/contacts/${c.id}" style="text-decoration:none"><span><b>${[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</b><small>${c.source || ''}</small></span><span>${c.email || '—'}</span><span>${c.phone || '—'}</span><span>${c.company_name || '—'}</span><span>${c.deals}</span></a>`)}`}
      ${list.length ? '' : h`<p class="empty">Aucun résultat.</p>`}`;
  };
  V.contacts.bind = (root, ctx) => {
    if (ctx.parts[1]) return ctx.view === 'entreprises' ? V.company.bind(root, ctx) : V.contact.bind(root, ctx);
    let t;
    $('#q', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { location.hash = `#/${ctx.view}?q=${encodeURIComponent(e.target.value.trim())}`; }, 400); };
    const imp = $('#import', root);
    if (imp) imp.onclick = importContacts;
    const nc = $('#new-contact', root);
    if (nc) nc.onclick = async () => {
      const r = await modal('Nouveau contact', h`<div class="grid g2"><label class="field"><span>Prénom</span><input name="first_name"></label><label class="field"><span>Nom</span><input name="last_name"></label></div><label class="field"><span>Mail</span><input name="email" type="email"></label><label class="field"><span>Téléphone</span><input name="phone"></label><label class="field"><span>Entreprise ou association</span><input name="company"></label>`, { submit: 'Créer' });
      if (r) busy(null, async () => { const x = await api('POST', '/api/contacts', r); toast(x.created ? 'Contact créé.' : 'Ce contact existait déjà (même mail ou téléphone) : fiche complétée.'); location.hash = `#/contacts/${x.id}`; });
    };
  };

  async function importContacts() {
    let file = null, prev = null;
    const v = await modal('Importer des contacts', h`<p class="small muted">Fichier Excel (.xlsx) ou CSV, avec une ligne de titres (prénom, nom, mail, téléphone, entreprise). Règle anti-doublon : même mail ou même téléphone = même contact (la fiche existante est complétée).</p>
      <label class="field"><span>Fichier</span><input type="file" id="imp-file" accept=".csv,.xlsx,text/csv"></label><div id="imp-prev"></div>`, {
      submit: 'Importer',
      onOpen: (f) => {
        $('#imp-file', f).onchange = async (e) => {
          file = e.target.files[0];
          if (!file) return;
          f.showError('');
          try {
            const content = await CRM.fileToBase64(file);
            prev = { filename: file.name, content };
            const p = await api('POST', '/api/import/preview', prev);
            prev.mapping = p.mapping;
            const fields = { first_name: 'Prénom', last_name: 'Nom', name: 'Nom complet', email: 'Mail', phone: 'Téléphone', company: 'Entreprise' };
            $('#imp-prev', f).innerHTML = h`<div class="alert alert-ok">Aperçu : ${p.create} à créer · ${p.update} à compléter · ${p.skip} ignoré(s)${p.truncated ? ' · limité aux 2 000 premières lignes' : ''}</div>
              <p class="small muted">Colonnes reconnues : ${Object.entries(p.mapping).map(([k, i]) => `${fields[k]} = « ${p.header[i]} »`).join(', ') || 'aucune : renommez les titres du fichier'}</p>
              <table class="simple"><tr><th>Nom</th><th>Mail</th><th>Téléphone</th><th>Action</th></tr>${p.items.slice(0, 12).map((i) => h`<tr><td>${[i.first_name, i.last_name].join(' ')}</td><td>${i.email}</td><td>${i.phone}</td><td>${i.action}</td></tr>`)}</table>`.s;
          } catch (err) { f.showError(err.message); prev = null; }
        };
      },
    });
    if (v === null || !prev) return;
    busy(null, async () => { const r = await api('POST', '/api/import/commit', prev); toast(`${r.created} contact(s) créé(s), ${r.updated} complété(s).`); location.hash = '#/contacts'; CRM.refresh(); });
  }

  V.contact = async ({ parts }) => {
    const d = await api('GET', `/api/contacts/${parts[1]}`);
    const c = d.contact;
    return h`${head('Contact', [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Contact', h`<button class="btn btn-ghost" id="edit">Modifier</button><button class="btn btn-primary" id="new-deal">+ Demande</button>`)}
      <div class="grid g3">
        <div class="card"><span class="label">La fiche</span><div class="rows">
          <div class="row"><span>Mail</span><b>${c.email || '—'}</b></div><div class="row"><span>Téléphone</span><b>${c.phone || '—'}</b></div>
          <div class="row"><span>Entreprise</span><b>${d.company ? raw(h`<a href="#/entreprises/${d.company.id}">${d.company.name}</a>`.s) : '—'}</b></div>
          <div class="row"><span>Source</span><b>${c.source || '—'}</b></div><div class="row"><span>Consentement</span><b>${c.consent_at ? dShort(c.consent_at) : 'non renseigné'}</b></div>
          <div class="row"><span>Créé le</span><b>${dShort(c.created_at)}</b></div><div class="row"><span>Dernière activité</span><b>${dShort(c.last_activity_at)}</b></div>
        </div>
        <span class="label" style="display:block;margin-top:18px">RGPD</span>
        <div class="actions"><a class="act" href="/api/contacts/${c.id}/export">Exporter ses données</a><button class="act" id="merge">Fusionner un doublon</button>${can('parametres') ? h`<button class="act danger" id="erase">Supprimer ses données</button>` : ''}</div></div>
        <div class="card"><span class="label">Ses demandes</span><div class="rows">${d.deals.length ? d.deals.map((x) => h`<div class="row"><a href="#/demandes/${x.id}">${x.title}</a>${badge(x.stage)}</div>`) : h`<p class="empty">Aucune demande.</p>`}</div></div>
        <div class="card"><span class="label">L'historique</span><ul class="timeline">${d.activities.map((a) => h`<li><small>${dTime(a.created_at)}</small><b>${a.text}</b></li>`)}</ul></div>
      </div>`;
  };
  V.contact.bind = (root, { parts }) => {
    const id = parts[1];
    $('#new-deal', root).onclick = async () => { const d = await api('GET', `/api/contacts/${id}`); newDeal({ name: [d.contact.first_name, d.contact.last_name].join(' ').trim(), email: d.contact.email, phone: d.contact.phone }); };
    $('#edit', root).onclick = async () => {
      const d = await api('GET', `/api/contacts/${id}`), c = d.contact;
      const r = await modal('Modifier le contact', h`<div class="grid g2"><label class="field"><span>Prénom</span><input name="first_name" value="${c.first_name}"></label><label class="field"><span>Nom</span><input name="last_name" value="${c.last_name}"></label></div><label class="field"><span>Mail</span><input name="email" value="${c.email || ''}"></label><label class="field"><span>Téléphone</span><input name="phone" value="${c.phone || ''}"></label><label class="field"><span>Entreprise</span><input name="company" value="${d.company?.name || ''}"></label>`, { submit: 'Enregistrer' });
      if (r) busy(null, async () => { await api('PUT', `/api/contacts/${id}`, r); toast('Contact enregistré.'); CRM.refresh(); });
    };
    $('#merge', root).onclick = async () => {
      const r = await modal('Fusionner un doublon', h`<p class="small">Cherchez l'autre fiche : ses demandes, mails et historique passent sur celle-ci, puis elle est supprimée. Les champs vides de cette fiche sont complétés.</p><label class="field"><span>Mail, téléphone ou nom</span><input name="q" id="mq"></label><div id="mres"></div><input type="hidden" name="remove" id="mrm">`, {
        submit: 'Fusionner',
        onOpen: (f) => {
          let t;
          $('#mq', f).oninput = (e) => { clearTimeout(t); t = setTimeout(async () => {
            const list = (await api('GET', `/api/contacts?q=${encodeURIComponent(e.target.value)}`)).filter((x) => String(x.id) !== String(id)).slice(0, 6);
            $('#mres', f).innerHTML = h`${list.map((x) => h`<label class="check"><input type="radio" name="pick" value="${x.id}"><span>${[x.first_name, x.last_name].join(' ')} · ${x.email || ''} ${x.phone || ''}</span></label>`)}`.s;
            $$('[name=pick]', f).forEach((rb) => rb.onchange = () => { $('#mrm', f).value = rb.value; });
          }, 300); };
        },
      });
      if (r?.remove) busy(null, async () => { await api('POST', '/api/contacts/merge', { keep: Number(id), remove: Number(r.remove) }); toast('Fiches fusionnées.'); CRM.refresh(); });
    };
    const er = $('#erase', root);
    if (er) er.onclick = async () => {
      if (!(await confirmBox('Supprimer les données', 'Les données personnelles de ce contact sont effacées. S’il a payé, la fiche est anonymisée (les montants restent pour la comptabilité). Action définitive.', { submit: 'Supprimer', danger: true }))) return;
      busy(er, async () => { const r = await api('DELETE', `/api/contacts/${id}`); toast(`Contact ${r.mode}.`); location.hash = '#/contacts'; });
    };
  };

  V.company = async ({ parts }) => {
    const d = await api('GET', `/api/companies/${parts[1]}`);
    const co = d.company;
    return h`${head('Entreprise', co.name, h`<button class="btn btn-ghost" id="edit">Modifier</button>`)}
      <div class="grid g3">
        <div class="card"><span class="label">La fiche</span><div class="rows">
          <div class="row"><span>SIRET</span><b>${co.siret || '—'}</b></div><div class="row"><span>Adresse</span><b>${co.address || '—'}</b></div>
          <div class="row"><span>Téléphone</span><b>${co.phone || '—'}</b></div><div class="row"><span>Mail</span><b>${co.email || '—'}</b></div></div></div>
        <div class="card"><span class="label">Contacts</span><div class="rows">${d.contacts.map((c) => h`<div class="row"><a href="#/contacts/${c.id}">${[c.first_name, c.last_name].join(' ')}</a><span>${c.email || c.phone || ''}</span></div>`)}</div></div>
        <div class="card"><span class="label">Demandes</span><div class="rows">${d.deals.map((x) => h`<div class="row"><a href="#/demandes/${x.id}">${x.title}</a>${badge(x.stage)}</div>`)}</div></div>
      </div>`;
  };
  V.company.bind = (root, { parts }) => {
    $('#edit', root).onclick = async () => {
      const co = (await api('GET', `/api/companies/${parts[1]}`)).company;
      const r = await modal('Modifier l’entreprise', h`${['name:Nom', 'siret:SIRET', 'address:Adresse', 'phone:Téléphone', 'email:Mail'].map((x) => { const [k, l] = x.split(':'); return h`<label class="field"><span>${l}</span><input name="${k}" value="${co[k] || ''}"></label>`; })}`, { submit: 'Enregistrer' });
      if (r) busy(null, async () => { await api('PUT', `/api/companies/${parts[1]}`, r); CRM.refresh(); });
    };
  };
})();
