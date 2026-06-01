// Interactivity for the CICY Coxeter per-model page. Loaded on every entry
// page via layouts/partials/cicy-entry-assets.html. All handlers are bound at
// the document level and key off data-role attributes, so the markup stays
// decoupled from the styling.
//
//   [data-role="cxpg-copy"]          copy the nearest [data-cxpg-record] block
//   [data-role="cxpg-toggle-gens"]   expand/collapse <details[data-cxpg-gen]>
//   [data-role="cicy-random"]        jump to a uniformly random model
//   [data-role="cicy-random-sibling"] jump to a random model of the same shape
//   keyboard: ← prev · → next · r random · s random sibling

(() => {
  const TOTAL = 7890;

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_e) { /* swallow */ }
      document.body.removeChild(ta);
    }
  }

  // Copy a serialisation block.
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-role="cxpg-copy"]');
    if (!btn) return;
    const rec = btn.closest('[data-cxpg-record]');
    const code = rec && rec.querySelector('pre code, pre');
    if (!code) return;
    await copyText(code.textContent);
    const label = btn.getAttribute('data-label') || 'Copy';
    btn.textContent = 'Copied';
    btn.classList.add('is-copied');
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('is-copied');
    }, 1200);
  });

  // Expand / collapse all iso-flop generator matrices in the same page root.
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-role="cxpg-toggle-gens"]');
    if (!btn) return;
    event.preventDefault();
    const root = btn.closest('[data-cxpg]') || document;
    const gens = root.querySelectorAll('details[data-cxpg-gen]');
    if (!gens.length) return;
    const anyClosed = Array.from(gens).some((d) => !d.open);
    gens.forEach((d) => { d.open = anyClosed; });
    btn.textContent = anyClosed ? 'Collapse all' : 'Expand all';
    btn.setAttribute('aria-expanded', anyClosed ? 'true' : 'false');
  });

  // Keep a toggle's label in sync when an individual <details> is opened.
  // Capture phase: the `toggle` event does not bubble.
  document.addEventListener('toggle', (event) => {
    const d = event.target;
    if (!d || !d.matches || !d.matches('details[data-cxpg-gen]')) return;
    const root = d.closest('[data-cxpg]');
    if (!root) return;
    const btn = root.querySelector('[data-role="cxpg-toggle-gens"]');
    if (!btn) return;
    const gens = root.querySelectorAll('details[data-cxpg-gen]');
    const anyClosed = Array.from(gens).some((x) => !x.open);
    btn.textContent = anyClosed ? 'Expand all' : 'Collapse all';
    btn.setAttribute('aria-expanded', anyClosed ? 'false' : 'true');
  }, true);

  // Uniform random model in [1, TOTAL].
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-role="cicy-random"]');
    if (!trigger) return;
    event.preventDefault();
    const n = Math.floor(Math.random() * TOTAL) + 1;
    const base = trigger.getAttribute('href') || '/cicy-coxeter/';
    const prefix = base.endsWith('/') ? base : base + '/';
    window.location.href = `${prefix}${n}/`;
  });

  // Random sibling — a random model of the same Coxeter-matrix shape, read
  // from data-siblings. Only present on pages that actually have siblings.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-role="cicy-random-sibling"]');
    if (!trigger) return;
    event.preventDefault();
    const ids = (trigger.getAttribute('data-siblings') || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return;
    const n = ids[Math.floor(Math.random() * ids.length)];
    const base = trigger.getAttribute('href') || '/cicy-coxeter/';
    const prefix = base.endsWith('/') ? base : base + '/';
    window.location.href = `${prefix}${n}/`;
  });

  // Keyboard navigation: ← prev, → next, r random, s random sibling.
  // Skip when a modifier is held or focus is inside a form field.
  const KEY_TO_ROLE = {
    ArrowLeft: 'cicy-nav-prev',
    ArrowRight: 'cicy-nav-next',
    r: 'cicy-random', R: 'cicy-random',
    s: 'cicy-random-sibling', S: 'cicy-random-sibling',
  };
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const t = event.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    const role = KEY_TO_ROLE[event.key];
    if (!role) return;
    const link = document.querySelector(`[data-role="${role}"]`);
    if (!link) return; // page lacks that nav (e.g. a no-sibling model)
    event.preventDefault();
    link.click();
  });
})();
