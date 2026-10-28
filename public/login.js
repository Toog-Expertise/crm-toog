/* Connexion par adresse mail et mot de passe. */
'use strict';
(function () {
  const form = document.getElementById('login-form');
  if (!form) return;
  const err = document.getElementById('login-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Connexion impossible.');
      location.href = '/';
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
})();
