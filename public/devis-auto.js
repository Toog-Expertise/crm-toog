/* Devis automatique B2B : 4 étapes avec une jauge (biais de complétude), activité, groupe,
   entreprise, coordonnées, puis « Recevoir mon devis ». Pas d'estimation pendant qu'on remplit : le prix n'apparaît
   qu'à la fin, avec le devis, calculé par le serveur depuis le catalogue du CRM. */
'use strict';
(function () {
  const sendHeight = () => { if (window.parent !== window) window.parent.postMessage({ crmHeight: document.documentElement.scrollHeight }, '*'); };
  new ResizeObserver(sendHeight).observe(document.body);

  const root = document.getElementById('auto');
  const form = document.getElementById('auto-form');
  if (!root || !form) return;
  const title = document.getElementById('auto-title');
  const stepEl = document.getElementById('auto-step');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let cat = null;
  const st = { step: 1, product: null, people: 10, date: '', options: [], company: '', first_name: '', last_name: '', role: '', email: '', phone: '', consent: false };
  const STEPS = ['votre activité', 'votre groupe', 'votre entreprise', 'vos coordonnées'];

  function render() {
    const p = cat.activities.find((a) => a.id === st.product);
    stepEl.innerHTML = `<span class="gauge" aria-hidden="true"><i style="width:${(st.step / 4) * 100}%"></i></span>Étape ${st.step} sur 4 · ${STEPS[st.step - 1]}`;
    if (st.step === 1) {
      title.innerHTML = 'Votre devis<br>en ligne';
      form.innerHTML = `<div class="field"><span>Activité</span><div class="chips">${cat.activities.map((a) => `<button type="button" class="chip${a.id === st.product ? ' on' : ''}" data-p="${a.id}">${esc(a.name)}</button>`).join('')}</div></div>
        ${p ? `<p class="small muted">${esc(p.description || '')}${p.example ? ' · prix d’exemple' : ''}</p>` : ''}
        <button class="btn btn-primary btn-block" type="submit" ${p ? '' : 'disabled'}>Continuer</button>`;
      form.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { st.product = Number(b.dataset.p); const a = cat.activities.find((x) => x.id === st.product); if (a.min_people && st.people < a.min_people) st.people = a.min_people; render(); });
    } else if (st.step === 2) {
      title.innerHTML = `Votre groupe`;
      const opts = cat.options.filter((o) => !o.types.length || o.types.some((t) => p.types.includes(t)));
      form.innerHTML = `<div class="field"><span>Activité</span><input value="${esc(p.name)}" disabled></div>
        <div class="field custom"><span>Nombre de personnes</span><div class="stepper"><button type="button" data-d="-1" aria-label="Moins">−</button><output>${st.people}</output><button type="button" data-d="1" aria-label="Plus">+</button></div></div>
        <label class="field"><span>Date souhaitée</span><input type="datetime-local" name="date" value="${esc(st.date)}" required></label>
        ${opts.length ? `<div class="field"><span>Options</span>${opts.map((o) => `<label class="check"><input type="checkbox" data-o="${o.id}" ${st.options.includes(o.id) ? 'checked' : ''}><span>${esc(o.name)}</span></label>`).join('')}</div>` : ''}
        <p class="error" id="auto-err" hidden></p>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn btn-ghost" data-back>Retour</button><button class="btn btn-primary" type="submit">Continuer</button></div>`;
      form.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
        const max = p.max_people || 500;
        st.people = Math.min(max, Math.max(1, st.people + Number(b.dataset.d)));
        form.querySelector('output').textContent = st.people;
      });
      form.querySelectorAll('[data-o]').forEach((c) => c.onchange = () => { const id = Number(c.dataset.o); st.options = c.checked ? [...st.options, id] : st.options.filter((x) => x !== id); });
      form.date.oninput = () => { st.date = form.date.value; };
    } else if (st.step === 3) {
      title.innerHTML = 'Votre<br>entreprise';
      form.innerHTML = `<label class="field"><span>Entreprise${cat.sirene ? ' · le plus simple : son numéro SIRET, ou son nom' : ''}</span><input name="company" autocomplete="organization" required value="${esc(st.company)}"></label>
        <div id="sir"></div>
        <div class="grid g2"><label class="field"><span>Prénom</span><input name="first_name" autocomplete="given-name" required value="${esc(st.first_name)}"></label>
        <label class="field"><span>Nom</span><input name="last_name" autocomplete="family-name" required value="${esc(st.last_name)}"></label></div>
        <label class="field"><span>Votre poste</span><input name="role" autocomplete="organization-title" value="${esc(st.role)}" placeholder="ex. assistante de direction, responsable RH"></label>
        <p class="error" id="auto-err" hidden></p>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn btn-ghost" data-back>Retour</button><button class="btn btn-primary" type="submit">Continuer</button></div>`;
      ['company', 'first_name', 'last_name', 'role'].forEach((k) => { form[k].oninput = () => { st[k] = form[k].value; }; });
      if (cat.sirene) bindSirene();
    } else if (st.step === 4) {
      title.innerHTML = 'Vos<br>coordonnées';
      form.innerHTML = `
        <label class="field"><span>Mail (pour recevoir le devis)</span><input type="email" name="email" autocomplete="email" required value="${esc(st.email)}"></label>
        <label class="field"><span>Téléphone</span><input type="tel" name="phone" autocomplete="tel" value="${esc(st.phone)}"></label>
        <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="check"><input type="checkbox" name="consent" ${st.consent ? 'checked' : ''}><span>J'accepte que mes données soient utilisées pour établir et suivre mon devis, et seulement pour cela.</span></label>
        <div id="ts-slot"></div>
        <p class="error" id="auto-err" hidden></p>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn btn-ghost" data-back>Retour</button><button class="btn btn-primary" type="submit">Recevoir mon devis</button></div>`;
      const ts = document.getElementById('ts-holder');
      if (ts) { ts.hidden = false; form.querySelector('#ts-slot').appendChild(ts); }
      ['email', 'phone'].forEach((k) => { form[k].oninput = () => { st[k] = form[k].value; }; });
      form.consent.onchange = () => { st.consent = form.consent.checked; };
    }
    const back = form.querySelector('[data-back]');
    if (back) back.onclick = () => { if (st.step === 4) { const ts = document.getElementById('ts-holder'); if (ts) { ts.hidden = true; root.appendChild(ts); } } st.step--; render(); };
    sendHeight();
  }

  // L'organisme qui règle, trouvé dans la base Sirene (option activée dans le CRM)
  function card(c) {
    return `<div class="sir-card"><small>Entreprise</small><b>${esc(c.name)}</b><span>${esc(c.address)}</span><span>SIRET ${esc(c.siret)}</span><button type="button" class="link small" id="sir-other">Choisir un autre organisme</button></div>`;
  }
  function bindSirene() {
    const box = form.querySelector('#sir');
    if (st.pick) { box.innerHTML = card(st.pick); box.querySelector('#sir-other').onclick = () => { st.pick = null; box.innerHTML = ''; form.company.focus(); }; }
    let t;
    form.company.addEventListener('input', () => {
      clearTimeout(t); st.pick = null;
      const q = form.company.value.trim();
      if (q.length < 3) { box.innerHTML = ''; return; }
      t = setTimeout(async () => {
        try {
          const list = await (await fetch(`/api/public/sirene?q=${encodeURIComponent(q)}`)).json();
          if (!Array.isArray(list) || !list.length) { box.innerHTML = '<p class="small muted">Aucune entreprise trouvée : gardez le nom tapé.</p>'; return; }
          box.innerHTML = list.map((c, i) => `<button type="button" class="sirene-hit" data-i="${i}"><b>${esc(c.name)}</b><small>SIRET ${esc(c.siret)} · ${esc(c.address)}</small></button>`).join('');
          box.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { st.pick = list[Number(b.dataset.i)]; st.company = st.pick.name; form.company.value = st.pick.name; bindSirene(); sendHeight(); });
          sendHeight();
        } catch { box.innerHTML = ''; }
      }, 450);
    });
  }

  function ready(d) {
    title.innerHTML = 'Votre devis<br>est prêt';
    stepEl.textContent = '';
    form.innerHTML = `<div class="pub-box"><div class="pub-box-title">Devis N° ${esc(d.number)}</div>
        <div class="pub-total"><span>Total TTC</span><strong>${esc(d.total)}</strong></div>
        <a class="link" href="${esc(d.pdf_url)}" target="_blank" rel="noopener">Voir le devis (PDF)</a></div>
      ${d.deposit_cents ? `<div class="pub-deposit"><span>Acompte pour bloquer la date</span><strong>${esc(d.deposit)}</strong></div>` : ''}
      <a class="btn btn-primary btn-block" href="${esc(d.sign_url)}" target="_top">Valider le devis et payer l'acompte</a>
      <p class="muted center small">Le devis vous a aussi été envoyé par mail, avec ce lien.</p>`;
    sendHeight();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const showErr = (m) => { const x = form.querySelector('#auto-err'); if (x) { x.textContent = m; x.hidden = !m; } };
    if (st.step === 1) { st.step = 2; return render(); }
    if (st.step === 2) {
      if (!st.date) return showErr('Choisissez une date.');
      st.step = 3; return render();
    }
    if (st.step === 3) {
      if (!st.company.trim() || !st.first_name.trim() || !st.last_name.trim()) return showErr('Indiquez votre entreprise, votre prénom et votre nom.');
      st.step = 4; return render();
    }
    if (!form.email.value.trim()) return showErr('Indiquez votre mail : le devis y est envoyé.');
    if (!form.consent.checked) return showErr('Merci de cocher le consentement.');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Préparation du devis…';
    const tsInput = document.querySelector('[name="cf-turnstile-response"]');
    try {
      const r = await fetch('/api/public/devis-auto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: st.product, people: st.people, options: st.options, event_at: st.date, company: st.company, company_siret: st.pick?.siret, company_address: st.pick?.address, first_name: st.first_name, last_name: st.last_name, role: st.role, email: form.email.value, phone: form.phone.value, consent: true, website: form.website.value, ts: Number(root.dataset.ts), page: root.dataset.page, 'cf-turnstile-response': tsInput ? tsInput.value : undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || 'Envoi impossible. Réessayez.');
      ready(d);
    } catch (x) {
      showErr(x.message);
      btn.disabled = false; btn.textContent = 'Recevoir mon devis';
      if (window.turnstile) window.turnstile.reset();
    }
  });

  fetch('/api/public/catalogue').then((r) => r.json()).then((d) => {
    cat = d;
    const pre = Number(root.dataset.activite);
    if (cat.activities.some((a) => a.id === pre)) { st.product = pre; st.step = 2; }
    else if (cat.activities.length === 1) st.product = cat.activities[0].id;
    const p = cat.activities.find((a) => a.id === st.product);
    if (p?.min_people && st.people < p.min_people) st.people = p.min_people;
    render();
  });
})();
