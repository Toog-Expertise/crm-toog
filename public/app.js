/* CRM Toog : le socle des écrans (sans framework). Les écrans sont dans views.js. */
'use strict';
(function () {
  const CRM = (window.CRM = { views: {}, me: null });

  // --- Petits outils ---
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(s);
  // Gabarit HTML : tout ce qui est inséré est échappé, sauf raw() et les listes de raw()
  function h(strings, ...vals) {
    let out = strings[0];
    vals.forEach((v, i) => {
      if (v instanceof Raw) out += v.s;
      else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
      else if (v !== false && v !== null && v !== undefined) out += esc(v);
      out += strings[i + 1];
    });
    return raw(out);
  }
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (c) => (c === null || c === undefined ? 'sur devis' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100));
  const fmt = (o) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', ...o });
  const dShort = (t) => (t ? fmt({ day: '2-digit', month: '2-digit' }).format(t) : '');
  const dDay = (t) => (t ? fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(t) : '');
  const dTime = (t) => (t ? fmt({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(t).replace(',', '') : '');
  const dLong = (t) => (t ? fmt({ weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(t).replace(':', ' h ').replace(' h 00', ' h') : '');
  function toLocalInput(ts) {
    if (!ts) return '';
    const p = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  function relative(ts) {
    const now = CRM.now();
    const day = 86400e3, startToday = new Date(toLocalInput(now).slice(0, 10) + 'T00:00').getTime();
    const local = new Date(toLocalInput(ts)).getTime();
    const hm = fmt({ hour: '2-digit', minute: '2-digit' }).format(ts).replace(':', ' h ').replace(' h 00', ' h');
    if (ts < now) return 'en retard';
    if (ts - now < 3 * 3600e3) return `dans ${Math.max(1, Math.round((ts - now) / 3600e3))} h`;
    if (local < startToday + day) return `aujourd'hui ${hm}`;
    if (local < startToday + 2 * day) return `demain ${hm}`;
    return `${fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(ts)} ${hm}`;
  }
  const initials = (s) => String(s || '?').trim().charAt(0).toUpperCase();

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (r.status === 401) { location.href = '/login'; throw new Error('Connexion requise.'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Erreur ${r.status}`); e.data = data; e.status = r.status; throw e; }
    return data;
  }

  function toast(msg, err = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), err ? 6000 : 3200);
  }

  // Fenêtre : renvoie une promesse avec les valeurs du formulaire (ou null si annulée)
  function modal(title, content, { submit = 'Enregistrer', danger = false, onOpen } = {}) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = h`<form class="modal" novalidate><h2>${title}</h2>${content}<p class="error" data-err hidden></p><div class="actions"><button type="button" class="btn btn-ghost" data-cancel>Annuler</button>${submit ? h`<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${submit}</button>` : ''}</div></form>`.s;
      document.body.appendChild(bg);
      const form = $('form', bg);
      const close = (v) => { bg.remove(); resolve(v); };
      $('[data-cancel]', bg).onclick = () => close(null);
      bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
      form.onsubmit = (e) => { e.preventDefault(); close(formData(form)); };
      form.showError = (m) => { const p = $('[data-err]', form); p.textContent = m; p.hidden = !m; };
      form.close = close;
      if (onOpen) onOpen(form);
      const first = $('input,select,textarea', form);
      if (first) first.focus();
    });
  }
  const confirmBox = (title, text, opts = {}) => modal(title, h`<p>${text}</p>`, { submit: opts.submit || 'Confirmer', danger: opts.danger }).then((v) => v !== null);

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') {
        if (el.dataset.multi !== undefined) { out[el.name] = out[el.name] || []; if (el.checked) out[el.name].push(el.value); }
        else out[el.name] = el.checked;
      } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    }
    return out;
  }

  // Bouton occupé pendant une action
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message, true); return undefined; } finally { if (btn) btn.disabled = false; }
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(() => toast('Lien copié.'), () => modal('Lien', h`<div class="copy"><code>${text}</code></div>`, { submit: null }));
  }

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  // --- Mise en page : menu, barre téléphone ---
  // Le menu : l'essentiel (Accueil, Devis, Mails auto, Équipe), Paramètres en bas,
  // et « Pour aller plus loin » (montré, pas au programme du module)
  const NAV = [
    { key: 'accueil', href: '#/', label: 'Accueil', icon: '⌂' },
    { key: 'devis', href: '#/devis', label: 'Devis', icon: '✎' },
    { key: 'mails', href: '#/mails', label: 'Mails auto', icon: '✉' },
    { key: 'equipe', href: '#/equipe', label: 'Équipe', icon: '♟' },
  ];
  const MORE = [
    { key: 'messages', href: '#/messages', label: 'Messages' },
    { key: 'contacts', href: '#/contacts', label: 'Contacts' },
    { key: 'paiements', href: '#/paiements', label: 'Paiements' },
    { key: 'agenda', href: '#/agenda', label: 'Agenda' },
    { key: 'api', href: '#/parametres/integrations', label: 'Intégrations (API et MCP)' },
  ];
  const can = (area) => CRM.me.access.includes(area);

  function logoHtml(cls) {
    return CRM.me.logo ? h`<img class="${cls}" src="/logo?v=${CRM.logoVersion || ''}" alt="${CRM.me.company.name}">` : h`<div class="${cls} pub-logo-text">${CRM.me.company.name}</div>`;
  }

  function layout(active) {
    const link = (n) => h`<a href="${n.href}" class="${n.key === active ? 'on' : ''}">${n.label}${n.key === 'messages' && CRM.me.unread_messages ? h`<span class="count">${CRM.me.unread_messages}</span>` : ''}</a>`;
    const moreOpen = MORE.some((n) => n.key === active);
    $('#side').innerHTML = h`${logoHtml('side-logo')}
      <nav class="nav">${NAV.map(link)}</nav>
      <details class="nav-more" ${moreOpen ? 'open' : ''}><summary>Pour aller plus loin</summary><nav class="nav">${MORE.map(link)}</nav></details>
      <nav class="nav nav-bottom">${link({ key: 'parametres', href: '#/parametres', label: 'Paramètres' })}</nav>
      <div class="side-user"><b>${CRM.me.user.name}</b><span class="muted">${CRM.me.user.email}</span><br><a class="link" href="#/compte">Mon compte</a> · <button class="link" id="logout">Se déconnecter</button></div>`.s;
    $('#logout').onclick = async () => { await api('POST', '/auth/logout', {}); location.href = '/login'; };
    $('#mobile-bar').innerHTML = h`${NAV.map((n) => h`<a href="${n.href}" class="${n.key === active ? 'on' : ''}"><i>${n.icon}</i>${n.label}</a>`)}<button id="more-btn" class="${NAV.some((n) => n.key === active) ? '' : 'on'}"><i>⋯</i>Plus</button>`.s;
    $('#more-btn').onclick = () => modal('Menu', h`<div class="nav"><a href="#/parametres" data-go>Paramètres</a><a href="#/compte" data-go>Mon compte</a></div><p class="label" style="margin-top:14px">Pour aller plus loin</p><div class="nav">${MORE.map((n) => h`<a href="${n.href}" data-go>${n.label}</a>`)}</div>`, { submit: null, onOpen: (f) => $$('[data-go]', f).forEach((a) => a.addEventListener('click', () => f.close(null))) });
    $('#demo-badge').hidden = !CRM.me.demo;
  }

  // En-tête commun des écrans
  function head(label, title, actions = '') {
    const offset = CRM.me.clock_offset_ms;
    return h`<div class="mobile-top">${logoHtml('')}<a class="link small" href="#/compte">${CRM.me.user.name}</a></div>
      ${offset ? h`<div class="banner">Horloge de test : le CRM vit ${Math.round(offset / 86400e3)} jour(s) en avance (${dLong(CRM.now())}).${can('parametres') ? h` <button class="btn btn-sm btn-ghost" id="clock-reset">Remettre à l'heure</button>` : ''}</div>` : ''}
      <div class="head"><div><div class="label">${label}</div><h1>${title}</h1></div><div class="head-actions">${actions}</div></div>`;
  }
  function bindHead(root) {
    const b = $('#clock-reset', root);
    if (b) b.onclick = () => busy(b, async () => { await api('POST', '/api/clock', { reset: true }); await loadMe(); route(); });
  }

  CRM.now = () => Date.now() + (CRM.me?.clock_offset_ms || 0);

  // --- Navigation ---
  async function loadMe() {
    CRM.me = await api('GET', '/api/me');
    document.title = `CRM · ${CRM.me.company.name}`;
  }

  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('?')[0].split('/').filter(Boolean);
    const params = new URLSearchParams(hash.split('?')[1] || '');
    let view = parts[0] || 'accueil';
    // Demandes et devis : une seule page (#/devis) ; la fiche d'une demande reste #/demandes/123
    if (view === 'demandes' && !parts[1]) { location.hash = '#/devis' + (hash.includes('?') ? '?' + hash.split('?')[1] : ''); return; }
    if (view === 'relances') { location.hash = '#/mails?onglet=envois'; return; }
    const map = { accueil: 'dashboard', demandes: 'deals', messages: 'messages', contacts: 'contacts', entreprises: 'contacts', devis: 'pipeline', mails: 'mails', paiements: 'payments', catalogue: 'catalogue', agenda: 'agenda', equipe: 'team', parametres: 'settings', compte: 'account', demarrage: 'setup' };
    const active = { dashboard: 'accueil', deals: 'devis', pipeline: 'devis', mails: 'mails', messages: 'messages', contacts: 'contacts', payments: 'paiements', catalogue: 'parametres', agenda: 'agenda', team: 'equipe', settings: parts[1] === 'api' ? 'api' : 'parametres', setup: 'parametres' };
    const name = map[view] || 'dashboard';
    layout(active[name] || '');
    const main = $('#main');
    try {
      const html = await CRM.views[name]({ parts, params, view });
      if (html === undefined) return;
      main.innerHTML = html.s ?? html;
      bindHead(main);
      if (CRM.views[name].bind) await CRM.views[name].bind(main, { parts, params, view });
      window.scrollTo(0, 0);
    } catch (e) {
      main.innerHTML = h`<div class="card"><p class="error">${e.message}</p></div>`.s;
    }
  }
  CRM.refresh = route;

  Object.assign(CRM, { h, raw, esc, $, $$, api, toast, modal, confirmBox, formData, busy, copy, money, dShort, dDay, dTime, dLong, relative, toLocalInput, initials, head, can, loadMe, logoHtml, fileToBase64 });

  document.addEventListener('DOMContentLoaded', async () => {
    try { await loadMe(); } catch { return; }
    window.addEventListener('hashchange', route);
    route();
  });
})();
