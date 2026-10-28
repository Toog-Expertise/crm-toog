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

  // ================= Accueil : 3 chiffres et la période =================
  const periodSelect = (period, id = 'period') => h`<select id="${id}" style="width:auto"><option value="semaine" ${period === 'semaine' ? 'selected' : ''}>Cette semaine (lundi → dimanche)</option><option value="mois" ${period === 'mois' ? 'selected' : ''}>Ce mois-ci</option></select>`;
  const kpiRow = (k) => h`<div class="kpis k3">
      <div class="kpi"><b>${k.deals}</b><span>demandes reçues</span></div>
      <div class="kpi"><b>${k.signed}</b><span>devis signés${k.signed_amount ? ` · ${money(k.signed_amount).replace(',00', '')}` : ''}</span></div>
      <div class="kpi"><b>${k.rate} %</b><span>taux de signature (${k.signed} signés sur ${k.sent} envoyés)</span></div>
    </div>`;
  CRM.kpiRow = kpiRow; CRM.periodSelect = periodSelect;

  V.dashboard = async ({ params }) => {
    const period = params.get('periode') || 'mois';
    const d = await api('GET', `/api/dashboard?periode=${period}`);
    return h`${head(`Accueil · ${d.label}`, `Bonjour ${firstName()}`, periodSelect(period))}
      ${d.pending_actions.length ? h`<div class="card" style="margin-bottom:18px"><span class="label">À confirmer · demandé depuis Claude</span><div class="rows">${d.pending_actions.map((a) => h`<div class="row"><span>${a.label}</span><span class="actions"><button class="act" data-pa="${a.id}" data-dec="confirmer">Confirmer</button><button class="act danger" data-pa="${a.id}" data-dec="refuser">Refuser</button></span></div>`)}</div></div>` : ''}
      ${kpiRow(d)}
      <div class="grid g2">
        <div class="card"><span class="label">À faire aujourd'hui</span>
          <div class="rows">${d.todo.length ? d.todo.map((t) => h`<div class="row"><a href="${t.deal_id ? `#/demandes/${t.deal_id}` : '#/'}">${t.text}</a><b>${t.tag}</b></div>`) : h`<p class="empty">Rien d'urgent. Bonne journée !</p>`}</div>
        </div>
        <div class="card"><span class="label">Les derniers devis</span>
          <div class="rows">${d.live.quotes.length ? d.live.quotes.map((q) => h`<div class="row"><a href="#/devis/${q.id}">${q.number}<small class="muted"> · ${q.client}</small></a><span><b>${money(q.total)}</b> <span class="badge b-${q.status}">${({ draft: 'brouillon', sent: 'envoyé', signed: 'signé' })[q.status] || q.status}${q.status === 'sent' && q.viewed ? ' · ouvert' : ''}</span></span></div>`) : h`<p class="empty">Aucun devis pour le moment.</p>`}</div>
          <a class="btn btn-ghost btn-sm" href="#/devis" style="margin-top:12px">Tous les devis</a>
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

  let liveTimer = null;
  const QSTATE = { draft: 'brouillon', sent: 'envoyé', signed: 'signé' };
  function liveCard(l) {
    const hm = (ts) => (CRM.now() - ts < 86400e3 ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(ts) : dShort(ts));
    return h`<div class="live-head"><span class="label"><i class="live-dot"></i>En direct</span><span class="small muted">mis à jour à ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' }).format(l.at)}</span></div>
      <div class="grid g2">
        <div><span class="small muted">Dernières demandes</span><div class="rows">${l.deals.length ? l.deals.map((x) => h`<div class="row"><a href="#/demandes/${x.id}">${x.client}<small class="muted"> · ${x.title}</small></a><span>${badge(x.stage)} <small class="muted">${hm(x.at)}</small></span></div>`) : h`<p class="empty">Aucune demande.</p>`}</div></div>
        <div><span class="small muted">Derniers devis</span><div class="rows">${l.quotes.length ? l.quotes.map((q) => h`<div class="row"><a href="#/devis/${q.id}">${q.number}<small class="muted"> · ${q.client}</small></a><span><b>${money(q.total)}</b> <span class="badge b-${q.status}">${QSTATE[q.status] || q.status}${q.status === 'sent' && q.viewed ? ' · ouvert' : ''}</span> <small class="muted">${hm(q.at)}</small></span></div>`) : h`<p class="empty">Aucun devis.</p>`}</div></div>
      </div>`;
  }

  // Suivi des relances en une ligne : « ✉ 2 · ☎ 1 · prochaine dans 3 j »
  function followLine(f) {
    if (!f || (!f.mails && !f.calls && !f.next)) return '';
    return [f.mails ? `✉ ${f.mails}` : '', f.calls ? `☎ ${f.calls}` : '', f.next ? `prochaine ${relative(f.next.at)}` : ''].filter(Boolean).join(' · ');
  }
  CRM.followLine = followLine;

  // ================= Devis : demandes et devis sur une seule page (liste ou Kanban) =================
  let showLost = false;
  const viewMode = () => { try { return localStorage.getItem('crm-vue') || 'liste'; } catch { return 'liste'; } };
  V.pipeline = async (ctx) => {
    if (ctx.parts[1] === 'nouveau') { setTimeout(newQuote, 0); location.hash = '#/devis'; return undefined; }
    if (ctx.parts[1]) return CRM.views.quote(ctx);
    const p = ctx.params;
    const period = p.get('periode') || 'mois';
    const qs = new URLSearchParams({ periode: period });
    for (const k of ['type', 'q']) if (p.get(k)) qs.set(k, p.get(k));
    const d = await api('GET', `/api/deals?${qs}`);
    const mode = viewMode();
    const stages = CRM.me.stages.filter((s) => showLost || s.key !== 'perdu');
    const list = d.deals.filter((x) => showLost || x.stage !== 'perdu');
    const amount = (x) => (x.quote ? (x.quote.total ? money(x.quote.total) : 'sur devis') : 'à chiffrer');
    const etape = p.get('etape') || '';
    const shown = list.filter((x) => !etape || x.stage === etape);
    const PM = { rib: 'Virement', stripe: 'Stripe' };
    const payment = (x) => {
      const q = x.quote_detail;
      if (!q) return h`<small class="muted">—</small>`;
      if (q.paid_method) return h`<b>${q.paid_method === 'carte' ? 'Stripe' : PM.rib}</b><small>${q.paid_method === 'carte' ? 'CB · suivi auto' : 'validation manuelle'}</small>`;
      if (!q.methods.length) return h`<small class="muted">sans lien de paiement</small>`;
      return h`<b>${q.methods.map((m) => PM[m]).join(' · ')}</b><small>${q.methods.includes('stripe') ? 'suivi auto' : 'validation manuelle'}</small>`;
    };
    // La prochaine action automatique (ou le geste à faire)
    const nextAction = (x) => {
      const q = x.quote_detail;
      if (x.stage === 'signe' && q && q.deposit > q.paid && q.methods.includes('rib') && !q.methods.includes('stripe')) return h`<button class="btn btn-sm btn-ghost" data-deposit="${x.id}">Valider l'acompte reçu</button>`;
      if (x.followup?.next) return h`<span>${x.followup.next.label.replace(/\s*\(.*\)$/, '')}</span><small>${dShort(x.followup.next.at)}</small>`;
      if (x.stage === 'nouvelle') return h`<span>Devis à générer depuis la demande</span>`;
      if (x.stage === 'signe') return h`<span>Acompte en attente</span>`;
      if (x.stage === 'realise') return h`<span>Solde à encaisser</span>`;
      return h`<small class="muted">—</small>`;
    };
    const who = (x) => h`<b>${x.company || x.contact || '—'}</b>${x.asso ? h` <span class="tag-asso">Asso</span>` : ''}<small>${x.title}</small>${x.postit ? h`<small class="postit-mini">✎ ${x.postit}</small>` : ''}`;
    const counts = Object.fromEntries(CRM.me.stages.map((s) => [s.key, list.filter((x) => x.stage === s.key).length]));
    const chips = h`<div class="chips">${[['', `Tous · ${list.length}`], ...stages.map((s) => [s.key, `${s.label} · ${counts[s.key]}`])].map(([k, l]) => h`<a class="chip ${etape === k ? 'on' : ''}" href="#/devis?${new URLSearchParams({ ...Object.fromEntries(p), etape: k })}">${l}</a>`)}</div>`;
    const listView = h`<div class="list-head cols-pipe"><span>Réf.</span><span>Client · événement</span><span>Date</span><span>Montant TTC</span><span>Statut</span><span>Paiement</span><span>Prochaine action auto</span></div>
      ${shown.map((x) => h`<div class="list-row cols-pipe ${x.stage === 'perdu' ? 'tone-off' : ''}">
        <span><a href="#/demandes/${x.id}"><b>${x.quote_detail?.number || '—'}</b></a><span class="row-acts">${x.quote && x.quote.status === 'sent' ? h`<button class="act" data-resend="${x.quote.id}" title="Renvoyer le devis">Renvoyer</button>` : ''}${x.quote_detail?.link ? h`<button class="act" data-copy="${x.quote_detail.link}" title="Copier le lien du devis">Lien</button>` : ''}<button class="act" data-postit="${x.id}" title="Post-it">✎</button></span></span>
        <span>${who(x)}</span>
        <span>${x.event_at ? dShort(x.event_at) : '—'}</span>
        <span><b>${amount(x)}</b>${x.quote_detail?.ht ? h`<small>${money(x.quote_detail.ht)} HT</small>` : ''}</span>
        <span>${badge(x.stage)}${followLine(x.followup) ? h`<small>${followLine(x.followup)}</small>` : ''}</span>
        <span>${payment(x)}</span>
        <span class="next-act">${nextAction(x)}</span></div>`)}
      ${shown.length ? '' : h`<p class="empty">Aucun devis ici. Créez-en un avec « + Nouveau devis ».</p>`}`;
    const kanban = h`<div class="board">${stages.map((s) => {
        const col = list.filter((x) => x.stage === s.key);
        const sum = col.reduce((a, x) => a + (x.quote?.total || 0), 0);
        return h`<div class="col" data-col="${s.key}"><h3>${s.label}<small>${col.length}${sum ? ` · ${money(sum).replace(',00', '')}` : ''}</small></h3>${col.map((x) => h`
          <a class="dcard" href="#/demandes/${x.id}" draggable="true" data-id="${x.id}" data-stage="${x.stage}">
            <span class="dc-top"><small>${x.quote_detail?.number || 'Demande'}</small>${x.asso ? h`<span class="tag-asso">Asso</span>` : ''}</span>
            <b>${x.company || x.contact || x.title}</b><span class="muted small">${x.title}${x.event_at ? ` · ${dShort(x.event_at)}` : ''}</span>
            ${x.postit ? h`<span class="postit-mini">✎ ${x.postit}</span>` : ''}
            <small><em>${amount(x)}</em><span>${x.quote_detail ? (x.quote_detail.paid_method ? (x.quote_detail.paid_method === 'carte' ? 'Stripe' : 'Virement') : x.quote_detail.methods.map((m) => PM[m]).join(' · ')) : ''}</span></small>
            <small class="follow">${x.followup?.next ? `${x.followup.next.label.replace(/\s*\(.*\)$/, '')} · ${dShort(x.followup.next.at)}` : x.stage === 'nouvelle' ? 'Devis à générer depuis la demande' : ''}</small>
            <select data-move="${x.id}" aria-label="Changer d'étape"><option value="">Changer d'étape…</option>${CRM.me.stages.filter((o) => o.key !== x.stage).map((o) => h`<option value="${o.key}">${o.label}</option>`)}</select>
          </a>`)}</div>`;
      })}</div>
      <p class="small muted legend"><b>Virement</b> : le gérant valide l'acompte à la main (N1) · <b>Stripe</b> : le webhook met le statut à jour tout seul (N2) · <b>Pennylane</b> : facture et rapprochement bancaire (N3, module à part)</p>`;
    return h`${head('Les demandes du formulaire du site arrivent ici automatiquement', 'Les devis', h`<input id="q" placeholder="Rechercher…" value="${p.get('q') || ''}">${periodSelect(period)}<a class="btn btn-ghost" href="/api/deals/export.csv">Exporter</a><button class="btn btn-primary" id="new-quote">+ Nouveau devis</button>`)}
      ${kpiRow(d.kpis)}
      <div class="actions pipe-bar">
        ${mode === 'liste' ? chips : h`<span></span>`}
        <div class="actions"><label class="switch small"><input type="checkbox" id="show-lost" ${showLost ? 'checked' : ''}><i></i>Perdus</label>
        <div class="seg"><button class="${mode === 'liste' ? 'on' : ''}" data-mode="liste">Liste</button><button class="${mode === 'kanban' ? 'on' : ''}" data-mode="kanban">Kanban</button></div></div>
      </div>
      ${mode === 'kanban' ? kanban : listView}`;
  };
  V.pipeline.bind = (root, ctx) => {
    if (ctx.parts[1]) return CRM.views.quote.bind(root, ctx);
    const setParam = (k, v) => { const p = new URLSearchParams(ctx.params); v ? p.set(k, v) : p.delete(k); location.hash = `#/devis?${p}`; };
    $('#new-quote', root).onclick = () => newQuote();
    let t;
    $('#q', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => setParam('q', e.target.value.trim()), 400); };
    $('#period', root).onchange = (e) => setParam('periode', e.target.value);
    $('#show-lost', root).onchange = (e) => { showLost = e.target.checked; CRM.refresh(); };
    $$('[data-mode]', root).forEach((b) => b.onclick = () => { try { localStorage.setItem('crm-vue', b.dataset.mode); } catch { /* sans mémoire */ } CRM.refresh(); });
    $$('[data-copy]', root).forEach((b) => b.onclick = () => copy(b.dataset.copy));
    $$('[data-resend]', root).forEach((b) => b.onclick = () => busy(b, async () => { const r = await api('POST', `/api/quotes/${b.dataset.resend}/send`, {}); toast(r.mail === 'simulated' ? 'Devis renvoyé (envoi simulé : Resend non branché).' : 'Devis renvoyé.'); CRM.refresh(); }));
    $$('[data-postit]', root).forEach((b) => b.onclick = () => editPostit(b.dataset.postit));
    // Tiroir virement : le gérant a vu l'acompte sur sa banque
    $$('[data-deposit]', root).forEach((b) => b.onclick = async () => {
      if (!(await confirmBox('Valider l’acompte reçu', "Vous avez vérifié votre banque : l'acompte est bien arrivé ? Le devis passe en « Acompte payé » et le client reçoit son reçu.", { submit: 'Oui, acompte reçu' }))) return;
      busy(b, async () => { await api('POST', `/api/deals/${b.dataset.deposit}/stage`, { stage: 'acompte' }); toast('Acompte validé.'); CRM.refresh(); });
    });
    const move = async (id, stage) => {
      let note = '';
      if (stage === 'perdu') { const r = await modal('Devis perdu', h`<label class="field"><span>Raison (facultatif)</span><input name="note" placeholder="ex. trop cher, date prise"></label>`, { submit: 'Marquer perdu' }); if (!r) return CRM.refresh(); note = r.note; }
      if (stage === 'acompte' && !(await confirmBox('Acompte payé', "Vous avez vérifié votre banque : l'acompte est bien arrivé ? Il est enregistré comme reçu par virement, et le client reçoit son reçu.", { submit: 'Oui, acompte reçu' }))) return CRM.refresh();
      try { await api('POST', `/api/deals/${id}/stage`, { stage, note }); toast(`Étape : ${stageLabel(stage)}`); } catch (e) { toast(e.message, true); }
      CRM.refresh();
    };
    $$('.dcard', root).forEach((c) => c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.dataset.id)));
    $$('.col', root).forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (id) move(id, col.dataset.col); });
    });
    $$('[data-move]', root).forEach((s) => {
      s.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      s.addEventListener('change', () => { if (s.value) move(s.dataset.move, s.value); });
    });
  };
  CRM.stageMove = true;

  async function editPostit(id) {
    const d = await api('GET', `/api/deals/${id}`);
    const r = await modal('Post-it', h`<label class="field"><span>Ce que le client demande, en deux mots</span><textarea name="text" rows="4" placeholder="ex. veut une salle privée, budget serré, rappeler après 17 h">${d.deal.postit || ''}</textarea></label>`, { submit: 'Enregistrer' });
    if (r) busy(null, async () => { await api('PUT', `/api/deals/${id}/postit`, r); toast('Post-it enregistré.'); CRM.refresh(); });
  }
  CRM.editPostit = editPostit;

  // Recherche Sirene (option, Paramètres › Intégrations) sous le champ « Entreprise »
  function bindSirene(form, onPick) {
    $$('[data-sirene]', form).forEach((input) => {
      const box = input.closest('label').nextElementSibling;
      let t, last = '';
      input.oninput = () => {
        clearTimeout(t);
        const q = input.value.trim();
        if (q.length < 3 || q === last) { if (q.length < 3) box.innerHTML = ''; return; }
        t = setTimeout(async () => {
          last = q;
          box.innerHTML = h`<p class="small muted">Recherche dans la base Sirene (INSEE)…</p>`.s;
          try {
            const list = await api('GET', `/api/sirene?q=${encodeURIComponent(q)}`);
            box.innerHTML = list.length ? h`${list.map((c, i) => h`<button type="button" class="sirene-hit" data-i="${i}"><b>${c.name}</b><small>${c.siret ? `SIRET ${c.siret}` : `SIREN ${c.siren}`} · ${c.address}${c.active ? '' : ' · fermée'}</small></button>`)}`.s : h`<p class="small muted">Aucune entreprise trouvée : gardez le nom tapé.</p>`.s;
            $$('.sirene-hit', box).forEach((b) => b.onclick = () => { const c = list[Number(b.dataset.i)]; input.value = c.name; last = c.name; box.innerHTML = h`<p class="small status-ok">✓ ${c.name} · SIRET ${c.siret} · ${c.address}</p>`.s; onPick(c); });
          } catch (e) { box.innerHTML = h`<p class="small error">${e.message}</p>`.s; }
        }, 450);
      };
    });
  }
  CRM.bindSirene = bindSirene;

  // ================= Nouveau devis manuel =================
  const euro = (c) => money(c || 0);
  async function newQuote(prefill = {}) {
    const products = (await api('GET', '/api/products').catch(() => [])).filter((p) => p.active && !p.is_option || p.active && p.is_option);
    const types = CRM.me.deal_types;
    const pm = CRM.me.pay_methods || {};
    const dep = CRM.me.deposit || { deposit_mode: 'pct', deposit_pct: 30 };
    const sirene = Boolean(CRM.me.sirene);
    const opt = (sel) => h`<option value="">— Choisir une activité —</option>${products.map((p) => h`<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${p.is_option ? 'Option · ' : ''}${p.name}${p.price_cents === null ? ' · sur devis' : ` · ${euro(p.price_cents)} TTC${p.pricing === 'per_person' ? ' / pers.' : ''}`}</option>`)}`;
    const lineRow = (i) => h`<div class="nq-line" data-i="${i}"><select data-prod>${opt('')}</select><input data-qty type="number" min="1" value="1" aria-label="Quantité"><input data-unit inputmode="decimal" placeholder="Prix TTC" aria-label="Prix unitaire TTC"><small data-ht class="muted"></small></div>`;
    const content = h`
      <div class="grid g2"><label class="field"><span>Entreprise *${sirene ? ' · nom ou SIRET : fiche INSEE' : ''}</span><input name="company" required value="${prefill.company || ''}" ${sirene ? 'data-sirene autocomplete="off"' : ''}></label>${sirene ? h`<div class="sirene-res"></div>` : ''}
      <div class="field"><span>Type de client</span><select name="type">${types.map((t) => h`<option value="${t.key}">${t.label}</option>`)}</select></div></div>
      <div class="grid g2"><label class="field"><span>Prénom</span><input name="first_name" value="${prefill.first_name || ''}"></label><label class="field"><span>Nom</span><input name="last_name" value="${prefill.last_name || ''}"></label></div>
      <div class="grid g2"><label class="field"><span>Mail *</span><input name="email" type="email" required value="${prefill.email || ''}"></label><label class="field"><span>Téléphone</span><input name="phone" value="${prefill.phone || ''}"></label></div>
      <div class="grid g2"><label class="field"><span>Nombre de personnes</span><input name="people" type="number" min="1"></label><label class="field"><span>Date de l'événement</span><input name="event_at" type="datetime-local"></label></div>
      <div class="field"><span>Les activités</span><div id="nq-lines">${lineRow(0)}</div><button type="button" class="act" id="nq-add">+ Ajouter une activité</button></div>
      <div class="nq-tot" id="nq-tot"></div>
      <div class="grid g2"><div class="field"><span>Acompte</span><div class="nq-dep"><select name="deposit_mode"><option value="pct" ${dep.deposit_mode !== 'fixe' ? 'selected' : ''}>en %</option><option value="fixe" ${dep.deposit_mode === 'fixe' ? 'selected' : ''}>montant fixe (€)</option></select><input name="deposit_value" inputmode="decimal" value="${dep.deposit_mode === 'fixe' ? ((dep.deposit_fixed_cents || 0) / 100).toFixed(2).replace('.', ',') : dep.deposit_pct}"></div></div>
      <div class="field"><span>Paiement de l'acompte</span>
        <label class="check"><input type="checkbox" name="payment_link" checked><span>Avec lien de paiement</span></label>
        ${pm.stripe ? h`<label class="check"><input type="checkbox" name="pm_stripe" checked><span>Stripe (carte, virement suivi)</span></label>` : ''}
        ${pm.rib ? h`<label class="check"><input type="checkbox" name="pm_rib" checked><span>Virement classique (RIB)</span></label>` : ''}
        ${!pm.stripe && !pm.rib ? h`<small class="muted">Aucun moyen réglé : Paramètres › Paiements.</small>` : ''}</div></div>
      <label class="field"><span>Post-it : la demande du client</span><textarea name="postit" rows="2" placeholder="ex. séminaire de 40 personnes, veut finir par un apéro"></textarea></label>`;
    let picked = null;
    const v = await modal('Nouveau devis', content, {
      submit: 'Créer le devis',
      onOpen: (f) => {
        if (sirene) bindSirene(f, (c) => { picked = c; });
        const recalc = () => {
          let ttc = 0, ht = 0;
          $$('.nq-line', f).forEach((row) => {
            const p = products.find((x) => String(x.id) === row.querySelector('[data-prod]').value);
            const qty = Number(row.querySelector('[data-qty]').value) || 0;
            const unit = Math.round(Number(String(row.querySelector('[data-unit]').value).replace(',', '.')) * 100) || 0;
            const vat = p ? p.vat_rate : 20;
            const lt = qty * unit, lh = Math.round(lt / (1 + vat / 100));
            ttc += lt; ht += lh;
            row.querySelector('[data-ht]').textContent = lt ? `${euro(lh)} HT · ${euro(lt)} TTC` : '';
          });
          const mode = f.querySelector('[name=deposit_mode]').value, val = Number(String(f.querySelector('[name=deposit_value]').value).replace(',', '.')) || 0;
          const depC = mode === 'fixe' ? Math.min(ttc, Math.round(val * 100)) : Math.round(ttc * val / 100);
          $('#nq-tot', f).innerHTML = ttc ? h`<span>Total <b>${euro(ht)} HT</b> · <b>${euro(ttc)} TTC</b></span><span>Acompte : <b>${euro(depC)}</b></span>`.s : '';
        };
        const bindLine = (row) => {
          row.querySelector('[data-prod]').onchange = (e) => {
            const p = products.find((x) => String(x.id) === e.target.value);
            if (p) { row.querySelector('[data-unit]').value = p.price_cents === null ? '' : (p.price_cents / 100).toFixed(2).replace('.', ','); const people = Number(f.querySelector('[name=people]').value); if (p.pricing === 'per_person' && people) row.querySelector('[data-qty]').value = Math.max(people, p.min_people || 0); }
            recalc();
          };
          $$('input', row).forEach((i) => i.oninput = recalc);
        };
        $$('.nq-line', f).forEach(bindLine);
        $('#nq-add', f).onclick = () => { const wrap = document.createElement('div'); wrap.innerHTML = lineRow($$('.nq-line', f).length).s; const row = wrap.firstElementChild; $('#nq-lines', f).appendChild(row); bindLine(row); };
        $$('[name=deposit_mode], [name=deposit_value]', f).forEach((i) => { i.oninput = recalc; i.onchange = recalc; });
        f.querySelector('[name=people]').oninput = () => { $$('.nq-line', f).forEach((row) => { const p = products.find((x) => String(x.id) === row.querySelector('[data-prod]').value); const people = Number(f.querySelector('[name=people]').value); if (p && p.pricing === 'per_person' && people) row.querySelector('[data-qty]').value = Math.max(people, p.min_people || 0); }); recalc(); };
        f._lines = () => $$('.nq-line', f).map((row) => ({ product_id: Number(row.querySelector('[data-prod]').value) || null, label: (products.find((x) => String(x.id) === row.querySelector('[data-prod]').value) || {}).name || '', qty: Number(row.querySelector('[data-qty]').value) || 1, unit: row.querySelector('[data-unit]').value })).filter((l) => l.product_id);
        modalLines = f._lines;
      },
    });
    if (!v) return;
    const lines = modalLines ? modalLines() : [];
    const methods = [v.pm_stripe ? 'stripe' : null, v.pm_rib ? 'rib' : null].filter(Boolean);
    const company = picked && v.company === picked.name ? { company_siret: picked.siret, company_address: picked.address, company_naf: picked.naf } : {};
    try {
      const r = await api('POST', '/api/quotes/manual', { ...v, ...company, lines, payment_link: Boolean(v.payment_link), pay_methods: methods });
      toast('Devis créé : vérifiez-le, puis envoyez-le.');
      location.hash = `#/devis/${r.id}`;
    } catch (e) { toast(e.message, true); }
  }
  let modalLines = null;
  CRM.newQuote = newQuote;
  const newDeal = newQuote;
  CRM.newDeal = newDeal;

  // ================= Fiche d'une demande =================
  const KIND_DOT = { mail: 'k-mail', payment: 'k-payment', sign: 'k-sign', reminder: 'k-reminder', note: 'k-note', call: 'k-call' };
  const PAY = { pending: 'En attente', paid: 'Payé', failed: 'Échec', refunded: 'Remboursé', partially_refunded: 'Remboursé en partie', cancelled: 'Annulé' };
  const QST = { draft: 'brouillon', sent: 'envoyé', signed: 'signé', cancelled: 'annulé' };
  const METHOD = { carte: 'carte', virement: 'virement', especes: 'espèces', cheque: 'chèque' };
  CRM.labels = { PAY, QST, SOURCES, METHOD, stageLabel, typeDef, badge };

  // Encaissement noté à la main (virement reçu sur le compte, espèces, chèque)
  async function markReceived(id, amountCents) {
    const r = await modal('Paiement reçu', h`<p class="small">Pour un virement reçu sur votre compte (ou des espèces, un chèque). Le client reçoit son reçu et la demande avance d'étape, comme avec Stripe.</p>
      <div class="grid g2"><div class="field"><span>Moyen</span><select name="method"><option value="virement">Virement</option><option value="especes">Espèces</option><option value="cheque">Chèque</option></select></div>
      <label class="field"><span>Montant reçu (€)</span><input name="amount" inputmode="decimal" value="${(amountCents / 100).toFixed(2).replace('.', ',')}"></label></div>
      <label class="field"><span>Reçu le</span><input name="paid_at" type="datetime-local" value="${toLocalInput(CRM.now())}"></label>`, { submit: 'Enregistrer le paiement' });
    if (r) busy(null, async () => { await api('POST', `/api/payments/${id}/received`, r); toast('Paiement enregistré, reçu envoyé au client.'); CRM.refresh(); });
  }
  CRM.markReceived = markReceived;

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
      : q.status === 'sent' && q.sign_url ? h`<button class="btn btn-primary" data-copy="${q.sign_url}">Copier le lien du devis</button>` : '';
    return h`${head(`Demande · ${t.label}`, `${name}${deal.people ? ` · ${deal.people} ${unit}` : ''}`, h`${deal.stage === 'perdu' ? badge('perdu') : ''}${can('messages') && c.email ? h`<button class="btn btn-ghost" id="write">Écrire au client</button>` : ''}<button class="btn btn-ghost" id="edit-deal">Modifier</button>${mainAction}`)}
      <div class="steps">${steps.map((s, i) => h`<button data-stage="${s.key}" class="${s.key === deal.stage ? 'on' : i < idx ? 'done' : ''}">${s.label}</button>`)}</div>
      <div class="postit" id="postit">${deal.postit ? h`<span>✎ ${deal.postit}</span>` : h`<span class="muted">✎ Ajouter un post-it : ce que le client demande, en deux mots</span>`}</div>
      <div class="grid g3">
        <div class="card"><span class="label">La demande</span><div class="rows">
          ${row('Contact', c.id ? raw(h`<a href="#/contacts/${c.id}">${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</a>`.s) : '—')}
          ${row('Entreprise', d.company?.name)}
          ${row('Mail', c.email)}${row('Téléphone', c.phone)}
          ${row('Date souhaitée', deal.event_at ? dLong(deal.event_at) : null)}
          ${row('Activité', d.product?.name)}
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
            <div class="actions"><a class="link" href="/api/quotes/${q.id}/pdf" target="_blank">Voir le PDF</a>${q.status !== 'signed' ? h`<a class="link" href="#/devis/${q.id}">Modifier</a>` : ''}${q.status === 'sent' ? h`<button class="link" data-resend="${q.id}">Renvoyer</button>` : ''}${q.sign_url && q.status !== 'signed' ? h`<button class="link" data-copy="${q.sign_url}">Lien du devis</button>` : ''}</div>`
            : h`<p class="empty">Pas encore de devis.</p>`}
          ${can('paiements') ? h`<span class="label" style="display:block;margin-top:18px">Les paiements</span>
          <div class="rows">${d.payments.length ? d.payments.map((p) => h`<div class="row"><span>${p.label}<br><span class="badge b-${p.status}">${PAY[p.status]}${p.method && p.status !== 'pending' ? ` · ${METHOD[p.method] || p.method}` : ''}</span></span><span><b>${money(p.amount_cents)}</b><br>${p.link ? h`<button class="act" data-copy="${p.link}">Copier le lien</button> <button class="act" data-paysend="${p.id}">Envoyer</button> <button class="act" data-received="${p.id}" data-amount="${p.amount_cents}">Reçu par virement…</button>` : ''}${['paid', 'partially_refunded'].includes(p.status) && (!p.method || p.method === 'carte') ? h`<button class="act danger" data-refund="${p.id}" data-max="${p.amount_cents - p.refunded_cents}">Rembourser</button>` : ''}</span></div>`) : h`<p class="empty">Aucun paiement.</p>`}</div>
          <div class="actions" style="margin-top:10px">${q && ['sent', 'signed'].includes(q.status) ? h`<button class="btn btn-sm btn-ghost" data-pay="deposit">Lien d'acompte</button>` : ''}${q && q.status === 'signed' ? h`<button class="btn btn-sm btn-ghost" data-pay="balance">Demander le solde</button>` : ''}<button class="btn btn-sm btn-ghost" data-pay="free">Lien de paiement libre</button></div>` : ''}
          ${can('relances') ? h`<span class="label" style="display:block;margin-top:18px">Les relances</span>
          <label class="switch"><input type="checkbox" id="rem-toggle" ${deal.reminders_paused ? '' : 'checked'}><i></i>${deal.reminders_paused ? `Coupées${paused.length ? ` · ${paused.length} en pause` : ''}` : next ? `Actives · prochaine ${relative(next.due_at)}` : 'Actives · aucune prévue'}</label>

          <div class="follow-table">${d.followup.length ? d.followup.map((r) => h`<div class="fr ${r.status}"><span class="fr-ch">${r.channel === 'call' ? '☎' : '✉'}</span><span><b>${r.label}</b>${r.message && r.rule === 'call_log' ? h`<small>${r.message}</small>` : ''}${r.status === 'error' ? h`<small class="error">${r.error}</small>` : ''}</span><small>${r.status === 'sent' ? `${r.rule === 'call_log' ? 'noté' : 'parti'} le ${dShort(r.sent_at)}${r.user_name && r.rule === 'call_log' ? ` · ${r.user_name}` : ''}` : r.status === 'paused' ? 'en pause' : r.status === 'error' ? 'en erreur' : `prévue ${relative(r.due_at)}`}</small></div>`) : h`<p class="empty small">Aucune relance pour le moment.</p>`}</div>
          <div class="actions" style="margin-top:8px"><button class="act" id="log-call">☎ Noter un appel</button><button class="act" id="replied">Le client a répondu</button><button class="act" id="manual-rem">+ Relance manuelle</button></div>` : ''}
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
    $$('.steps [data-stage]', root).forEach((b) => b.onclick = () => busy(b, async () => {
      if (b.dataset.stage === 'acompte' && !(await confirmBox('Acompte payé', "Vous avez vérifié votre banque : l'acompte est bien arrivé ? Il est enregistré comme reçu par virement, et le client reçoit son reçu.", { submit: 'Oui, acompte reçu' }))) return;
      await post(`/api/deals/${id}/stage`, { stage: b.dataset.stage }); toast(`Étape : ${stageLabel(b.dataset.stage)}`); reload();
    }));
    const lost = $('#lost', root);
    if (lost) lost.onclick = async () => { const r = await modal('Demande perdue', h`<label class="field"><span>Raison (facultatif)</span><input name="note"></label>`, { submit: 'Marquer perdue', danger: true }); if (r) { await post(`/api/deals/${id}/stage`, { stage: 'perdu', note: r.note }); reload(); } };
    $('#assign', root).onchange = (e) => busy(null, async () => { await api('PUT', `/api/deals/${id}`, { assigned_to: e.target.value || null }); toast('Attribution enregistrée.'); reload(); });
    $('#note-form', root).onsubmit = (e) => { e.preventDefault(); const text = e.target.text.value.trim(); if (!text) return; busy(e.submitter, async () => { await post(`/api/deals/${id}/note`, { text }); reload(); }); };
    const cq = $('#create-quote', root);
    if (cq) cq.onclick = () => busy(cq, async () => { const q = await post(`/api/deals/${id}/quotes`); location.hash = `#/devis/${q.id}`; });
    $('#postit', root).onclick = () => CRM.editPostit(id);
    $$('[data-resend]', root).forEach((b) => b.onclick = () => busy(b, async () => { const r = await post(`/api/quotes/${b.dataset.resend}/send`, {}); toast(r.mail === 'simulated' ? 'Envoi simulé (Resend non branché).' : 'Devis renvoyé.'); reload(); }));
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
    const lc = $('#log-call', root);
    if (lc) lc.onclick = async () => {
      const r = await modal('Noter un appel', h`<div class="field"><span>Résultat</span><select name="outcome"><option value="joint">Client joint</option><option value="pas_de_reponse">Pas de réponse</option><option value="message">Message laissé</option><option value="rappeler">À rappeler</option></select></div>
        <label class="field"><span>Ce qui s'est dit (facultatif)</span><textarea name="note" rows="3" placeholder="ex. hésite sur la date, rappeler jeudi"></textarea></label>
        <label class="check"><input type="checkbox" name="replied"><span>Le client a répondu : arrêter les relances automatiques</span></label>`, { submit: 'Enregistrer' });
      if (r) busy(lc, async () => { await post(`/api/deals/${id}/calls`, { ...r, replied: Boolean(r.replied) }); toast('Appel noté.'); reload(); });
    };
    $$('[data-received]', root).forEach((b) => b.onclick = () => markReceived(b.dataset.received, Number(b.dataset.amount)));
    $('#add-task', root).onclick = async () => {
      const r = await modal('Nouvelle tâche', h`<label class="field"><span>Tâche</span><input name="title" required placeholder="ex. Rappeler si pas signé"></label><label class="field"><span>Pour le</span><input type="datetime-local" name="due_at"></label>`, { submit: 'Ajouter' });
      if (r) busy(null, async () => { await post(`/api/deals/${id}/tasks`, r); reload(); });
    };
    $$('[data-task]', root).forEach((cb) => cb.onchange = () => busy(null, async () => { await api('PUT', `/api/tasks/${cb.dataset.task}`, { done: cb.checked }); reload(); }));
    $('#edit-deal', root).onclick = () => editDeal(id);
    const w = $('#write', root);
    if (w) w.onclick = async () => {
      const r = await modal('Écrire au client', h`<label class="field"><span>Objet</span><input name="subject" required></label><label class="field"><span>Message</span><textarea name="text" rows="6" placeholder="Bonjour, …"></textarea></label><p class="small muted">Sa réponse arrivera dans l'écran Messages, rangée avec cette demande.</p>`, { submit: 'Envoyer' });
      if (r) busy(w, async () => { const x = await api('POST', `/api/deals/${id}/message`, r); toast(x.status === 'simulated' ? 'Message enregistré (envoi simulé).' : 'Message envoyé.'); reload(); });
    };
  };

  // La fiche d'une demande (#/demandes/123)
  V.deals = (ctx) => V.deal(ctx);
  V.deals.bind = (root, ctx) => V.deal.bind(root, ctx);

  async function manualReminder(dealId) {
    const r = await modal('Relance manuelle', h`<div class="field"><span>Canal</span><select name="channel"><option value="mail">Mail au client</option><option value="call">Appel (tâche)</option></select></div><label class="field"><span>Quand</span><input type="datetime-local" name="due_at" value="${toLocalInput(CRM.now() + 86400e3).slice(0, 11)}10:00"></label><label class="field"><span>Message</span><textarea name="message" rows="4" placeholder="Le texte du mail (le bonjour et la signature sont ajoutés)"></textarea></label>`, { submit: 'Programmer' });
    if (r) busy(null, async () => { await api('POST', `/api/deals/${dealId}/reminders`, r); toast('Relance programmée.'); CRM.refresh(); });
  }
  CRM.manualReminder = manualReminder;

  async function editDeal(id) {
    const d = await api('GET', `/api/deals/${id}`);
    const deal = d.deal, t = typeDef(deal.type);
    const products = can('catalogue') ? await api('GET', '/api/products').catch(() => []) : [];
    const r = await modal('Modifier la demande', h`
      <label class="field"><span>Titre</span><input name="title" value="${deal.title}"></label>
      <div class="grid g2"><div class="field"><span>Type</span><select name="type">${CRM.me.deal_types.map((x) => h`<option value="${x.key}" ${x.key === deal.type ? 'selected' : ''}>${x.label}</option>`)}</select></div>
      <div class="field"><span>Activité</span><select name="product_id">${activityOptions(products, '', deal.data.product_id)}</select></div></div>
      <div class="grid g2"><label class="field"><span>${t.people_label}</span><input name="people" type="number" value="${deal.people || ''}"></label>
      <label class="field"><span>Date de la venue</span><input name="event_at" type="datetime-local" value="${toLocalInput(deal.event_at)}"></label></div>
      ${typeFields(deal.type, deal.data)}
      <label class="field"><span>Message</span><textarea name="message" rows="3">${deal.message || ''}</textarea></label>`, { submit: 'Enregistrer' });
    if (!r) return;
    const data = { ...deal.data, product_id: Number(r.product_id) || undefined };
    delete r.product_id;
    for (const [k, v] of Object.entries(r)) if (k.startsWith('data.')) { data[k.slice(5)] = v; delete r[k]; }
    busy(null, async () => { await api('PUT', `/api/deals/${id}`, { ...r, data }); toast('Demande enregistrée.'); CRM.refresh(); });
  }

  // ================= Messages : mails reçus des clients et réponses =================
  V.messages = async ({ parts, params }) => {
    const key = parts[1] ? decodeURIComponent(parts[1]) : null;
    const filtre = params.get('filtre') || 'a_traiter';
    const d = await api('GET', `/api/messages?filtre=${filtre}`);
    const t = key ? await api('GET', `/api/messages/thread/${encodeURIComponent(key)}`) : null;
    const when = (ts) => (CRM.now() - ts < 86400e3 ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(ts) : dShort(ts));
    const name = t ? (t.contact ? [t.contact.first_name, t.contact.last_name].filter(Boolean).join(' ') : '') || t.reply_to : '';
    return h`${head(`CRM · ${CRM.me.company.name}`, 'Les messages')}
      ${d.enabled ? '' : h`<div class="banner">La réception des mails n'est pas encore branchée : les réponses des clients n'arrivent pas ici (README, « Boîte de réception »). Les mails envoyés depuis le CRM s'y rangent déjà.</div>`}
      <div class="tabs">${[['a_traiter', `À traiter · ${d.counts.a_traiter}`], ['traites', 'Traités'], ['tous', 'Tous']].map(([k, l]) => h`<a class="tab ${filtre === k ? 'on' : ''}" href="#/messages?filtre=${k}">${l}</a>`)}</div>
      <div class="inbox ${t ? 'has-thread' : ''}">
        <div class="threads">${d.threads.length ? d.threads.map((x) => h`<a class="th ${x.thread === key ? 'on' : ''}" href="#/messages/${encodeURIComponent(x.thread)}?filtre=${filtre}">
            <span class="th-top"><b>${x.unread ? h`<span class="dot"></span>` : ''}${x.name}</b><span class="muted">${when(x.last_at)}</span></span>
            <span class="th-subj">${x.subject}</span><span class="th-prev">${x.last_direction === 'out' ? 'Vous : ' : ''}${x.preview}</span>
            ${x.deal ? h`<span class="small muted">${x.deal.title}</span>` : h`<span class="small muted">expéditeur inconnu</span>`}</a>`) : h`<p class="empty">${filtre === 'a_traiter' ? 'Aucun message à traiter.' : 'Aucun message.'}</p>`}</div>
        <div class="convo">${t ? h`
          <div class="convo-head"><div><a class="link small" href="#/messages?filtre=${filtre}">‹ Tous les messages</a><h2 style="margin-top:6px">${name}</h2><span class="muted small">${t.reply_to || t.contact?.email || ''}${t.contact?.phone ? ` · ${t.contact.phone}` : ''}</span></div>
            <div class="actions">${t.deal ? h`<a class="btn btn-sm btn-ghost" href="#/demandes/${t.deal.id}">Voir la demande</a>` : h`<button class="btn btn-sm btn-ghost" id="to-deal">Créer une demande</button>`}<button class="btn btn-sm btn-ghost" id="done" data-v="${t.done ? '0' : '1'}">${t.done ? 'Rouvrir' : 'Marquer traité'}</button></div></div>
          ${t.messages.map((m) => h`<div class="msg ${m.direction}"><small>${m.direction === 'in' ? (m.from_name || m.from_addr) : `Vous${m.user_name ? ` (${m.user_name})` : ''}`} · ${dTime(m.created_at)}</small>
            <div class="bubble"><span class="subj">${m.subject}</span>${m.body}${m.attachments.length ? h`<span style="display:block;margin-top:8px">${m.attachments.map((a) => h`<a class="link small" href="/api/messages/${m.id}/attachments/${a.id}" target="_blank">📎 ${a.filename}</a> `)}</span>` : ''}</div></div>`)}
          <form class="reply" id="reply-form"><label class="field"><span>Votre réponse à ${t.reply_to || t.contact?.email || ''}</span><textarea name="text" placeholder="Bonjour, …"></textarea></label>
            <div class="actions" style="justify-content:space-between"><span class="small muted">Envoyée par mail avec votre signature d'entreprise ; la conversation passe en « traité ».</span><button class="btn btn-primary">Envoyer</button></div></form>`
          : h`<p class="empty">Choisissez une conversation à gauche.</p>`}</div>
      </div>`;
  };
  V.messages.bind = (root, { parts, params }) => {
    const key = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!key) return;
    const filtre = params.get('filtre') || 'a_traiter';
    CRM.loadMe().then(() => { const c = $('.nav a[href="#/messages"] .count'); if (c && !CRM.me.unread_messages) c.remove(); else if (c) c.textContent = CRM.me.unread_messages; });
    $('#reply-form', root).onsubmit = (e) => {
      e.preventDefault();
      const text = e.target.text.value.trim();
      if (!text) return toast('Écrivez votre réponse.', true);
      busy(e.submitter, async () => {
        const r = await api('POST', `/api/messages/thread/${encodeURIComponent(key)}/reply`, { text });
        toast(r.status === 'simulated' ? 'Réponse enregistrée (envoi simulé : Resend non branché).' : r.status === 'failed' ? `Échec de l'envoi : ${r.error}` : 'Réponse envoyée.', r.status === 'failed');
        CRM.refresh();
      });
    };
    $('#done', root).onclick = (e) => busy(e.target, async () => { await api('POST', `/api/messages/thread/${encodeURIComponent(key)}/done`, { done: e.target.dataset.v === '1' }); location.hash = `#/messages?filtre=${filtre}`; });
    const td = $('#to-deal', root);
    if (td) td.onclick = () => busy(td, async () => { const r = await api('POST', `/api/messages/thread/${encodeURIComponent(key)}/deal`, {}); toast('Demande créée.'); location.hash = `#/demandes/${r.id}`; });
  };

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
    $('#new-deal', root).onclick = async () => { const d = await api('GET', `/api/contacts/${id}`); CRM.newQuote({ first_name: d.contact.first_name, last_name: d.contact.last_name, email: d.contact.email, phone: d.contact.phone, company: d.company?.name }); };
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
          <div class="row"><span>SIRET</span><b>${co.siret || '—'}</b></div><div class="row"><span>Adresse</span><b>${co.address || '—'}</b></div>${co.naf ? h`<div class="row"><span>Code NAF</span><b>${co.naf}</b></div>` : ''}
          <div class="row"><span>Téléphone</span><b>${co.phone || '—'}</b></div><div class="row"><span>Mail</span><b>${co.email || '—'}</b></div></div></div>
        <div class="card"><span class="label">Contacts</span><div class="rows">${d.contacts.map((c) => h`<div class="row"><a href="#/contacts/${c.id}">${[c.first_name, c.last_name].join(' ')}</a><span>${c.email || c.phone || ''}</span></div>`)}</div></div>
        <div class="card"><span class="label">Demandes</span><div class="rows">${d.deals.map((x) => h`<div class="row"><a href="#/demandes/${x.id}">${x.title}</a>${badge(x.stage)}</div>`)}</div></div>
      </div>`;
  };
  V.company.bind = (root, { parts }) => {
    $('#edit', root).onclick = async () => {
      const co = (await api('GET', `/api/companies/${parts[1]}`)).company;
      const r = await modal('Modifier l’entreprise', h`<label class="field"><span>Rechercher dans la base Sirene (nom ou SIRET)</span><input id="sir-q" data-sirene value="${co.name}" autocomplete="off"></label><div class="sirene-res"></div>
        ${['name:Nom', 'siret:SIRET', 'address:Adresse', 'naf:Code NAF (activité)', 'phone:Téléphone', 'email:Mail'].map((x) => { const [k, l] = x.split(':'); return h`<label class="field"><span>${l}</span><input name="${k}" value="${co[k] || ''}"></label>`; })}`, {
        submit: 'Enregistrer',
        onOpen: (f) => bindSirene(f, (c) => { for (const k of ['name', 'siret', 'address', 'naf']) if (c[k]) $(`[name=${k}]`, f).value = c[k]; }),
      });
      if (r) delete r['sir-q'];
      if (r) busy(null, async () => { await api('PUT', `/api/companies/${parts[1]}`, r); CRM.refresh(); });
    };
  };
})();
