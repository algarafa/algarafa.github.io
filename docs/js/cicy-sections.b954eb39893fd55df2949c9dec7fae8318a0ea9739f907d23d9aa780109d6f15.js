/* Progressive-enhancement micro-interactions for the CICY landing-page
   section panels. Currently just the copy-to-clipboard buttons; every control
   keeps a working no-JS baseline (copy targets stay visible and selectable). */

/* --- Copy-to-clipboard buttons -------------------------------------- */
/* <button data-cx-copy=".cx-bibtex"> copies the textContent of the first
   matching element within the nearest [data-cx-cite] scope (or document).
   Shows a transient confirmation. */
function initCopyButtons() {
  const buttons = document.querySelectorAll("[data-cx-copy]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const scope = btn.closest("[data-cx-cite]") || document;
      const sel = btn.getAttribute("data-cx-copy") || ".cx-bibtex";
      const src = scope.querySelector(sel);
      if (!src) return;
      const text = (src.textContent || "").replace(/\s+$/g, "");
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (_) {
        try {
          const range = document.createRange();
          range.selectNodeContents(src);
          const selObj = window.getSelection();
          selObj.removeAllRanges();
          selObj.addRange(range);
          ok = document.execCommand("copy");
          selObj.removeAllRanges();
        } catch (_e) {
          ok = false;
        }
      }
      const label = btn.querySelector("[data-cx-copy-label]") || btn;
      const original = label.textContent;
      label.textContent = ok ? "Copied" : "Copy failed";
      btn.classList.add(ok ? "is-copied" : "is-failed");
      window.setTimeout(() => {
        label.textContent = original;
        btn.classList.remove("is-copied", "is-failed");
      }, 1600);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCopyButtons);
} else {
  initCopyButtons();
}
