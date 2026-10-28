/* Devis automatique : activité, groupe, coordonnées ; le prix se calcule en direct depuis le catalogue du CRM.
   À l'envoi, le serveur recalcule tout : le prix affiché ici n'est jamais repris tel quel. */
'use strict';
(function () {
  const sendHeight = () => { if (window.parent !== window) window.parent.postMessage({ crmHeight: document.documentElement.scrollHeight }, '*'); };
  new ResizeObserver(sendHeight).observe(document.body);

  const root = document.getElementById('auto');
  const form = document.getElementById('auto-form');
  if (!root || !form) return;
  const title = document.getElementById('auto-title');
  const stepEl = document.getElementById('auto-step');
  const money = (c) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let cat = null;
  const st = { step: 1, product: null, people: 10, date: '', options: [], name: '', email: '', phone: '', consent: false };

  function lines() {
    const p = cat.activities.find((a) => a.id === st.product);
    if (!p) return { rows: [], total: 0 };
    const qty = (x) => (x.pricing === 'per_person' ? Math.max(st.people, x.min_people || 0) : 1);
    const rows = [{ label: p.pricing === 'per_person' ? `${qty(p)} personnes × ${money(p.price_cents)}` : p.name, total: qty(p) * p.price_cents }];
    for (const o of cat.options.filter((x) => st.options.includes(x.id))) rows.push({ label: o.name, total: qty(o) * o.price_cents });
    return { rows, total: rows.reduce((s, r) => s + r.total, 0), min: p.pricing === 'per_person' && p.min_people && st.people < p.min_people ? p.min_people : null, max: p.max_people };
  }

  function summary() {
    const l = lines();
    return `<div class="pub-box"><table class="pub-lines">${l.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${money(r.total)}</td></tr>`).join('')}</table>
      <div class="pub-total"><span><b>Total TTC</b></span><strong>${money(l.total)}</strong></div>
      ${l.min ? `<small class="muted">Minimum ${l.min} personnes facturées.</small>` : ''}</div>`;
  }

  function render() {
    const p = cat.activities.find((a) => a.id === st.product);
    stepEl.textContent = `Étape ${st.step} sur 3 · ${['votre activité', 'votre groupe', 'vos coordonnées'][st.step - 1]}`;
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
        ${opts.length ? `<div class="field"><span>Options</span>${opts.map((o) => `<label class="check"><input type="checkbox" data-o="${o.id}" ${st.options.includes(o.id) ? 'checked' : ''}><span>${esc(o.name)} · ${money(o.price_cents)}${o.pricing === 'per_person' ? ' / pers.' : ''}</span></label>`).join('')}</div>` : ''}
        <div id="sum">${summary()}</div>
        <p class="error" id="auto-err" hidden></p>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn btn-ghost" data-back>Retour</button><button class="btn btn-primary" type="submit">Continuer</button></div>`;
      form.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
        const max = p.max_people || 500;
        st.people = Math.min(max, Math.max(1, st.people + Number(b.dataset.d)));
        form.querySelector('output').textContent = st.people;
        form.querySelector('#sum').innerHTML = summary();
      });
      form.querySelectorAll('[data-o]').forEach((c) => c.onchange = () => { const id = Number(c.dataset.o); st.options = c.checked ? [...st.options, id] : st.options.filter((x) => x !== id); form.querySelector('#sum').innerHTML = summary(); });
      form.date.oninput = () => { st.date = form.date.value; };
    } else if (st.step === 3) {
      title.innerHTML = 'Vos<br>coordonnées';
      form.innerHTML = `${summary()}
        <label class="field"><span>Nom et prénom</span><input name="name" autocomplete="name" required value="${esc(st.name)}"></label>
        <label class="field"><span>Mail (pour recevoir le devis)</span><input type="email" name="email" autocomplete="email" required value="${esc(st.email)}"></label>
        <label class="field"><span>Téléphone</span><input type="tel" name="phone" autocomplete="tel" value="${esc(st.phone)}"></label>
        <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="check"><input type="checkbox" name="consent" ${st.consent ? 'checked' : ''}><span>J'accepte que mes données soient utilisées pour établir et suivre mon devis, et seulement pour cela.</span></label>
        <div id="ts-slot"></div>
        <p class="error" id="auto-err" hidden></p>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn btn-ghost" data-back>Retour</button><button class="btn btn-primary" type="submit">Recevoir mon devis</button></div>`;
      const ts = document.getElementById('ts-holder');
      if (ts) { ts.hidden = false; form.querySelector('#ts-slot').appendChild(ts); }
      ['name', 'email', 'phone'].forEach((k) => { form[k].oninput = () => { st[k] = form[k].value; }; });
      form.consent.onchange = () => { st.consent = form.consent.checked; };
    }
    const back = form.querySelector('[data-back]');
    if (back) back.onclick = () => { if (st.step === 3) { const ts = document.getElementById('ts-holder'); if (ts) { ts.hidden = true; root.appendChild(ts); } } st.step--; render(); };
    sendHeight();
  }

  function ready(d) {
    title.innerHTML = 'Votre devis<br>est prêt';
    stepEl.textContent = '';
    form.innerHTML = `<div class="pub-box"><div class="pub-box-title">Devis N° ${esc(d.number)}</div>
        <div class="pub-total"><span>Total TTC</span><strong>${esc(d.total)}</strong></div>
        <a class="link" href="${esc(d.pdf_url)}" target="_blank" rel="noopener">Voir le devis (PDF)</a></div>
      ${d.deposit_pct ? `<div class="pub-deposit"><span>Acompte de ${esc(String(d.deposit_pct).replace('.', ','))} % pour bloquer la date</span><strong>${esc(d.deposit)}</strong></div>` : ''}
      <a class="btn btn-primary btn-block" href="${esc(d.sign_url)}" target="_top">Signer et payer l'acompte</a>
      <p class="muted center small">🔒 Paiement sécurisé par Stripe · carte bancaire</p>
      <p class="muted center small">Le devis et le lien de signature vous ont aussi été envoyés par mail.</p>`;
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
    if (!form.name.value.trim() || !form.email.value.trim()) return showErr('Indiquez votre nom et votre mail.');
    if (!form.consent.checked) return showErr('Merci de cocher le consentement.');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Préparation du devis…';
    const tsInput = document.querySelector('[name="cf-turnstile-response"]');
    try {
      const r = await fetch('/api/public/devis-auto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: st.product, people: st.people, options: st.options, event_at: st.date, name: form.name.value, email: form.email.value, phone: form.phone.value, consent: true, website: form.website.value, ts: Number(root.dataset.ts), page: root.dataset.page, 'cf-turnstile-response': tsInput ? tsInput.value : undefined }),
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
