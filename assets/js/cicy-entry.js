// Small helpers for the CICY Coxeter per-model pages. Loaded on every entry
// page via layouts/partials/cicy-entry-assets.html.

(() => {
  const TOTAL = 7890;

  // Uniform random: pick a CICY index in [1, TOTAL].
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-role="cicy-random"]');
    if (!trigger) return;
    event.preventDefault();
    const n = Math.floor(Math.random() * TOTAL) + 1;
    const base = trigger.getAttribute('href') || '/cicy-coxeter/';
    const prefix = base.endsWith('/') ? base : base + '/';
    window.location.href = `${prefix}${n}/`;
  });

  // Random sibling: pick a CICY from the list on data-siblings, cycling
  // within the same Coxeter-matrix shape. Only bound on pages that actually
  // have siblings (the layout only emits the link when siblings.length > 0).
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-role="cicy-random-sibling"]');
    if (!trigger) return;
    event.preventDefault();
    const raw = trigger.getAttribute('data-siblings') || '';
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    const n = ids[Math.floor(Math.random() * ids.length)];
    const base = trigger.getAttribute('href') || '/cicy-coxeter/';
    const prefix = base.endsWith('/') ? base : base + '/';
    window.location.href = `${prefix}${n}/`;
  });

  // Copy-to-clipboard buttons on each .cicy-entry__record block.
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-role="cicy-copy"]');
    if (!btn) return;
    const figure = btn.closest('.cicy-entry__record');
    const code = figure && figure.querySelector('pre code');
    if (!code) return;
    const text = code.textContent;
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('is-copied');
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove('is-copied');
      }, 1200);
    } catch (_err) {
      // Fallback for contexts without the async Clipboard API
      // (older Safari over http, etc.). Uses a temporary textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_e) { /* swallow */ }
      document.body.removeChild(ta);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    }
  });

  // "Expand / collapse all" toggle for iso-flop generator matrices. Targets
  // only .cicy-entry__matrix-collapsible.is-generator so the configuration
  // matrix's own open/closed state is preserved.
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-role="cicy-toggle-generators"]');
    if (!btn) return;
    event.preventDefault();
    const gens = document.querySelectorAll('.cicy-entry__matrix-collapsible.is-generator');
    if (gens.length === 0) return;
    const anyClosed = Array.from(gens).some((d) => !d.open);
    gens.forEach((d) => { d.open = anyClosed; });
    btn.textContent = anyClosed ? 'Collapse all' : 'Expand all';
    btn.setAttribute('aria-expanded', anyClosed ? 'true' : 'false');
  });

  // Keep the toggle button's label in sync when the user opens/closes any
  // individual generator <details> by clicking its own summary.
  document.addEventListener('toggle', (event) => {
    const d = event.target;
    if (!d || !d.classList || !d.classList.contains('is-generator')) return;
    const btn = document.querySelector('[data-role="cicy-toggle-generators"]');
    if (!btn) return;
    const gens = document.querySelectorAll('.cicy-entry__matrix-collapsible.is-generator');
    const anyClosed = Array.from(gens).some((x) => !x.open);
    btn.textContent = anyClosed ? 'Expand all' : 'Collapse all';
    btn.setAttribute('aria-expanded', anyClosed ? 'false' : 'true');
  }, true); // capture — the <details> `toggle` event does not bubble

  // Keyboard navigation: ← prev, → next, r uniform random, s random sibling.
  // Guards: skip when any modifier is held (so browser / OS shortcuts still
  // work) and when focus is inside an input / textarea / contenteditable.
  const KEY_TO_SELECTOR = {
    ArrowLeft:  '.cicy-entry__nav-prev',
    ArrowRight: '.cicy-entry__nav-next',
    r:          '.cicy-entry__nav-random',
    R:          '.cicy-entry__nav-random',
    s:          '.cicy-entry__nav-sibling',
    S:          '.cicy-entry__nav-sibling',
  };

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const t = event.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    const selector = KEY_TO_SELECTOR[event.key];
    if (!selector) return;
    const link = document.querySelector(selector);
    if (!link) return; // page doesn't have that nav (e.g. no-sibling model)
    event.preventDefault();
    link.click();
  });
})();
