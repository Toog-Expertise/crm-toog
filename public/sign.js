/* Page de signature : tracé au doigt (iPhone et Android, sans faire défiler la page) et code par mail. */
'use strict';
(function () {
  const root = document.getElementById('sign');
  if (!root) return;
  const token = root.dataset.token;
  const form = document.getElementById('sign-form');
  const pad = document.getElementById('pad');
  const err = document.getElementById('sign-error');
  const ctx = pad.getContext('2d');
  let drawing = false, drawn = false, last = null;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const w = pad.clientWidth, hgt = pad.clientHeight;
    pad.width = w * ratio; pad.height = hgt * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = getComputedStyle(document.body).color || '#fff';
    drawn = false;
  }
  resize();
  window.addEventListener('resize', () => { if (!drawn) resize(); });

  const pos = (e) => { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); drawing = true; last = pos(e); });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; drawn = true;
  });
  const end = () => { drawing = false; };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.getElementById('pad-clear').addEventListener('click', () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; });

  // La signature exportée : trait foncé sur fond transparent (pour le PDF blanc)
  function signaturePng() {
    const out = document.createElement('canvas');
    out.width = pad.width; out.height = pad.height;
    const o = out.getContext('2d');
    o.drawImage(pad, 0, 0);
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = '#1d1b29';
    o.fillRect(0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Erreur');
    return d;
  };
  const show = (m) => { err.textContent = m; err.hidden = !m; };

  const codeBtn = document.getElementById('send-code');
  codeBtn.addEventListener('click', async () => {
    show('');
    codeBtn.disabled = true;
    try {
      const d = await post(`/s/${token}/code`, {});
      document.getElementById('code-info').textContent = `Code envoyé à ${d.to}. Il est valable 10 minutes.`;
      codeBtn.textContent = 'Renvoyer le code';
      form.code.focus();
    } catch (x) { show(x.message); }
    setTimeout(() => { codeBtn.disabled = false; }, 20000);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    show('');
    if (!form.accept.checked) return show('Cochez « Bon pour accord ».');
    if (!drawn) return show('Signez dans le cadre avec le doigt.');
    if (!/^\d{6}$/.test(form.code.value.trim())) return show('Saisissez le code à 6 chiffres reçu par mail (bouton « Recevoir mon code »).');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Signature en cours…';
    try {
      const d = await post(`/s/${token}/sign`, { name: form.name.value.trim(), accept: true, code: form.code.value.trim(), signature: signaturePng() });
      location.href = d.redirect;
    } catch (x) {
      show(x.message);
      btn.disabled = false;
      btn.textContent = 'Signer le devis';
    }
  });
})();
