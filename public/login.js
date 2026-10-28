/* Connexion par code à 6 chiffres envoyé par mail (secours sans Google Workspace). */
'use strict';
(function () {
  const form = document.getElementById('code-form');
  if (!form) return;
  const err = document.getElementById('code-error');
  const info = document.getElementById('code-info');
  const step = document.getElementById('code-step');
  const btn = document.getElementById('code-btn');
  let sent = false;
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Erreur');
    return d;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      if (!sent) {
        const d = await post('/auth/code/request', { email: form.email.value.trim() });
        sent = true;
        step.hidden = false;
        info.hidden = false;
        info.textContent = d.simulated ? 'Code envoyé (Resend non branché : il s’affiche dans le terminal du serveur).' : 'Code envoyé : regardez votre boîte mail.';
        btn.textContent = 'Se connecter';
        form.code.focus();
      } else {
        await post('/auth/code/verify', { email: form.email.value.trim(), code: form.code.value });
        location.href = '/';
      }
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
})();
