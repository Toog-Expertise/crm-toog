/* Formulaire de demande du site : un premier choix, puis seulement les questions utiles. */
'use strict';
(function () {
  // Hauteur transmise au site (iframe ajustée automatiquement)
  const sendHeight = () => { if (window.parent !== window) window.parent.postMessage({ crmHeight: document.documentElement.scrollHeight }, '*'); };
  window.CRMHeight = sendHeight;
  new ResizeObserver(sendHeight).observe(document.body);

  const root = document.getElementById('lead');
  if (!root) return;
  const types = JSON.parse(document.getElementById('lead-types').textContent);
  const form = document.getElementById('lead-form');
  const chips = document.getElementById('type-chips');
  const fields = document.getElementById('type-fields');
  const err = document.getElementById('lead-error');
  let current = root.dataset.type;

  const el = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; return e; };

  function render() {
    chips.replaceChildren(...types.map((t) => { const b = el('button', { type: 'button', class: 'chip' + (t.key === current ? ' on' : '') }, t.label); b.onclick = () => { current = t.key; render(); }; return b; }));
    const t = types.find((x) => x.key === current) || types[0];
    const nodes = (t.fields || []).map((f) => {
      const l = el('label', { class: 'field custom' });
      l.append(el('span', {}, f.label + (f.required ? ' *' : '')), el('input', { name: 'data.' + f.key, ...(f.required ? { required: '' } : {}) }));
      return l;
    });
    const p = el('label', { class: 'field custom' });
    p.append(el('span', {}, t.people_label || 'Nombre de personnes'), el('input', { name: 'people', type: 'number', min: '1', inputmode: 'numeric' }));
    nodes.push(p);
    fields.replaceChildren(...nodes);
  }
  render();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const body = { type: current, page: root.dataset.page, ts: Number(root.dataset.ts), data: {} };
    for (const x of form.elements) {
      if (!x.name) continue;
      if (x.name.startsWith('data.')) body.data[x.name.slice(5)] = x.value;
      else body[x.name] = x.type === 'checkbox' ? x.checked : x.value;
    }
    const ts = form.querySelector('[name="cf-turnstile-response"]');
    if (ts) body['cf-turnstile-response'] = ts.value;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await fetch('/api/public/demande', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Envoi impossible. Réessayez.');
      form.hidden = true;
      document.getElementById('lead-done').hidden = false;
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      if (window.turnstile) window.turnstile.reset();
    } finally {
      btn.disabled = false;
      sendHeight();
    }
  });
})();
