/* Page du client : valider le devis (prénom, nom, entreprise, poste, « bon pour accord » écrit), puis payer l'acompte. */
'use strict';
(function () {
  const root = document.getElementById('sign');
  const form = document.getElementById('sign-form');
  if (!root || !form) return;
  const err = document.getElementById('sign-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const body = {};
    for (const k of ['first_name', 'last_name', 'company', 'role', 'agreement']) body[k] = form[k].value.trim();
    try {
      const r = await fetch(`/s/${encodeURIComponent(root.dataset.token)}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'La validation a échoué. Réessayez.');
      location.href = d.redirect;
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
})();
