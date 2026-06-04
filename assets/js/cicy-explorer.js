// DuckDB-WASM is imported DYNAMICALLY inside boot() (not as a static top-level
// import) so a CDN/network failure rejects boot()'s promise and surfaces the
// loadingError() message — instead of failing the whole module before the error
// handler can run, which used to leave the loading spinner stuck forever.
const DUCKDB_ESM = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const PARQUET_URL = "/cicy-coxeter/cicy-coxeter.parquet";

// Query-string keys we read/write. Field names match the form input `name`s.
const FILTER_KEYS = [
  "num", "h11_min", "h11_max", "h21_min", "h21_max",
  "kahler_pos", "is_product", "coxeter_rank", "coxeter_kind", "shape",
  "sort", "dir",
];

// Subset counted by the active-filter pill. Excludes `num` (a search, not a
// filter) and `sort` / `dir` (display-only state).
const PILL_FILTER_KEYS = [
  "h11_min", "h11_max", "h21_min", "h21_max",
  "kahler_pos", "is_product", "coxeter_rank", "coxeter_kind", "shape",
];

const SORTABLE_COLS = new Set([
  "Num", "H11", "H21", "Chi", "Favour", "KahlerPos", "IsProduct",
  "IsoFlopRank", "CoxeterKind", "CoxeterSummary",
]);

const KIND_DISPLAY = {
  finite: "finite",
  affine: "affine",
  indefinite: "indefinite",
  trivial: "—",
  sentinel: "—",
};

// Column layouts. The primary #explorer has no `data-cols`
// renderTable builds matching cells; the markup <thead> lists the same
// columns in the same order. The production Explorer uses "refined-chi".
const COLUMN_SPECS = {
  "refined-chi": ["num", "h11", "h21", "chi", "kpos", "rank", "kind", "group"],
};

// One uniform marker for any empty / not-applicable cell, across all columns.
const EMPTY = "—"; // em dash

// ShapeKey → display label (e.g. "A1+B2" → "ℤ₂ × I₂(4)"), populated from the
// JSON the markup emits once; drives the refined "Group" column.
let SHAPE_DISPLAY = {};

function loadShapeDisplay() {
  const el = document.getElementById("cicy-shape-display");
  if (!el) return;
  try {
    const data = JSON.parse(el.textContent);
    if (Array.isArray(data)) {
      // shape_options array: [{key, display, ...}, …]
      SHAPE_DISPLAY = Object.fromEntries(data.map(o => [o.key, o.display]));
    } else if (data && typeof data === "object") {
      SHAPE_DISPLAY = data;
    }
  } catch (_) { SHAPE_DISPLAY = {}; }
}

const explorerSections = Array.from(document.querySelectorAll("[data-cicy-explorer]"));
if (explorerSections.length) {
  boot(explorerSections).catch(err => explorerSections.forEach(s => loadingError(s, err)));
}

// Gallery (landing page): keep the mobile column switcher in sync with an
// inbound `#shape-<key>` deep link (per-model "Gallery →" links), so the
// targeted chip's column is the one shown on narrow screens. No-op on desktop
// (all columns visible) and when the gallery isn't present. Runs at module load
// — independent of the (heavy) Explorer init — so deep links resolve at once.
function syncGalleryColumnToHash() {
  const m = /^#shape-(.+)$/.exec(window.location.hash || "");
  if (!m) return;
  let key = m[1];
  try { key = decodeURIComponent(key); } catch (_) { /* leave as-is */ }
  const chip = document.getElementById("shape-" + key);
  if (!chip) return;
  const cell = chip.closest("[data-kind]");
  const kind = cell && cell.dataset.kind;
  if (!kind) return;
  const radio = document.getElementById("gallery-col-" + kind);
  if (radio && !radio.checked) radio.checked = true;
}
syncGalleryColumnToHash();
window.addEventListener("hashchange", syncGalleryColumnToHash);

// Returns "smooth" or "auto" depending on the user's reduced-motion preference.
// Evaluated at call time so OS-level toggles take effect without a reload.
function scrollBehavior() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

// Boot DuckDB-WASM ONCE and bind every `[data-cicy-explorer]` section to the
// shared connection. The primary (`#explorer`) owns URL state, legacy-hash
// deep links and chart-tile filter events; any further `[data-cicy-explorer]`
// section is an independent live instance with its own local filter state.
async function boot(sections) {
  const primary = sections.find(s => s.id === "explorer") || sections[0];

  setLoadingStage(primary, "duckdb");
  const duckdb = await import(DUCKDB_ESM);
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerBlob = new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" });
  const workerUrl = URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  setLoadingStage(primary, "parquet");
  const resp = await fetch(PARQUET_URL);
  if (!resp.ok) throw new Error(`Parquet fetch failed: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await db.registerFileBuffer("cicy.parquet", buf);
  const conn = await db.connect();

  setLoadingStage(primary, "view");
  await conn.query("CREATE VIEW cicy AS SELECT * FROM 'cicy.parquet'");
  const countRes = await conn.query("SELECT COUNT(*) AS n FROM cicy");
  const total = Number(countRes.toArray()[0].n);

  loadShapeDisplay();
  // Translate any inbound legacy hash to query string before reading state,
  // so `#row=N` / `#shape=KEY` from per-entry-page links still work.
  translateLegacyHash();

  for (const section of sections) {
    hideLoading(section);
    const isPrimary = section === primary;
    if (isPrimary) applyUrlToForm(section);
    wireUI(section, conn, total, isPrimary);
    await refresh(section, conn, total);
  }

  // URL / deep-link / chart-filter sync targets the primary only.
  window.addEventListener("hashchange", async () => {
    if (translateLegacyHash()) {
      applyUrlToForm(primary);
      await refresh(primary, conn, total);
    }
  });
  window.addEventListener("popstate", async () => {
    applyUrlToForm(primary);
    await refresh(primary, conn, total);
  });
  document.addEventListener("cicy:filter", async (ev) => {
    applyDetailToForm(primary, ev.detail || {});
    writeFormToUrl(primary);
    primary.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    await refresh(primary, conn, total);
  });
}

/* -------- Loading UI ----------------------------------------------- */

function setLoadingStage(section, stage) {
  const ol = section.querySelector(".cicy-loading-stages");
  if (ol) ol.dataset.stage = stage;
}

function hideLoading(section) {
  const el = section.querySelector(".cicy-explorer__loading");
  if (el) el.hidden = true;
}

function loadingError(section, err) {
  const el = section.querySelector(".cicy-explorer__loading");
  if (!el) return;
  el.classList.add("cicy-explorer__loading--error");
  const msg = el.querySelector(".cicy-explorer__loading-error");
  if (msg) {
    msg.hidden = false;
    msg.textContent = `Failed to initialise: ${err && err.message || err}`;
  }
}

/* -------- URL state ------------------------------------------------ */

function translateLegacyHash() {
  // Inbound `#row=N` → query string `?num=N`. Inbound `#shape=KEY` →
  // `?shape=KEY`. Returns `true` when a translation happened so the caller
  // re-applies state. The hash is stripped after translation; the per-entry
  // pages emit these legacy URLs.
  const hash = window.location.hash || "";
  const rowMatch = /^#row=(\d+)$/.exec(hash);
  const shapeMatch = /^#shape=([A-Za-z0-9_%+-]+)$/.exec(hash);
  if (!rowMatch && !shapeMatch) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete("num");
  url.searchParams.delete("shape");
  if (rowMatch) {
    url.searchParams.set("num", rowMatch[1]);
  } else if (shapeMatch) {
    let key = shapeMatch[1];
    try { key = decodeURIComponent(key); } catch (_) { /* keep raw */ }
    url.searchParams.set("shape", key);
  }
  url.hash = ""; // strip the legacy hash
  history.replaceState(null, "", url.toString());
  return true;
}

function applyUrlToForm(section) {
  const params = new URLSearchParams(window.location.search);
  const form = section.querySelector(".cicy-explorer__facets");
  // First clear all known fields so removing a param truly resets the form.
  for (const key of FILTER_KEYS) {
    const el = form.elements.namedItem(key);
    if (!el) continue;
    if (el.tagName === "SELECT") el.value = "";
    else if (el.type === "number") el.value = "";
    else el.value = "";
  }
  for (const key of FILTER_KEYS) {
    const val = params.get(key);
    if (val == null) continue;
    const el = form.elements.namedItem(key);
    if (!el) continue;
    if (el.tagName === "SELECT") {
      const optExists = Array.from(el.options).some(o => o.value === val);
      if (optExists) el.value = val;
    } else {
      el.value = val;
    }
  }
  updateSortIndicators(section, params.get("sort"), params.get("dir"));
  updateFiltersPill(section);
}

function applyDetailToForm(section, detail) {
  // Used by chart→facet wiring. `detail` is a partial filter object using
  // the same query-string keys.
  const form = section.querySelector(".cicy-explorer__facets");
  for (const [key, val] of Object.entries(detail)) {
    const el = form.elements.namedItem(key);
    if (!el) continue;
    el.value = val == null ? "" : String(val);
  }
}

function writeFormToUrl(section) {
  const form = section.querySelector(".cicy-explorer__facets");
  const url = new URL(window.location.href);
  // Clear known params first.
  for (const key of FILTER_KEYS) url.searchParams.delete(key);
  for (const key of FILTER_KEYS) {
    const el = form.elements.namedItem(key);
    if (!el) continue;
    const v = (el.value || "").trim();
    if (v !== "") url.searchParams.set(key, v);
  }
  // Append sort state if non-default.
  const sortCol = section.dataset.sortCol || "";
  const sortDir = section.dataset.sortDir || "";
  if (sortCol && sortDir) {
    url.searchParams.set("sort", sortCol);
    url.searchParams.set("dir", sortDir);
  }
  history.replaceState(null, "", url.toString());
}

/* -------- Form wiring ---------------------------------------------- */

function wireUI(section, conn, total, primary) {
  const form = section.querySelector(".cicy-explorer__facets");
  let timer = null;
  form.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (primary) writeFormToUrl(section);
      updateFiltersPill(section);
      refresh(section, conn, total);
    }, 150);
  });
  form.addEventListener("change", () => {
    clearTimeout(timer);
    if (primary) writeFormToUrl(section);
    updateFiltersPill(section);
    refresh(section, conn, total);
  });
  form.addEventListener("reset", () => {
    clearTimeout(timer);
    delete section.dataset.sortCol;
    delete section.dataset.sortDir;
    setTimeout(() => {
      if (primary) writeFormToUrl(section);
      updateSortIndicators(section, null, null);
      updateFiltersPill(section);
      refresh(section, conn, total);
    }, 0);
  });
  const pill = section.querySelector('[data-role="filters-pill"]');
  if (pill) {
    pill.addEventListener("click", () => {
      form.reset();  // triggers the existing reset listener above.
    });
  }
  updateFiltersPill(section);
  const exportBtn = section.querySelector('[data-action="export-csv"]');
  if (exportBtn) exportBtn.addEventListener("click", () => exportCsv(section, conn));
  // Gallery-tile clicks (landing page) drive the PRIMARY explorer only — they
  // write the URL + scroll to it, so wiring them once is correct.
  if (primary) {
    document.querySelectorAll("a[data-shape]").forEach(link => {
      link.addEventListener("click", (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
        const shape = link.dataset.shape;
        if (!shape) return;
        ev.preventDefault();
        const url = new URL(window.location.href);
        url.searchParams.set("shape", shape);
        url.hash = "";
        history.pushState(null, "", url.toString());
        applyUrlToForm(section);
        section.scrollIntoView({ block: "start", behavior: scrollBehavior() });
        refresh(section, conn, total);
      });
    });
  }
  // Delegated click for whole-row mouse affordance. Keyboard users tab to the
  // anchor inside the #-cell (single focus stop per row); Enter on that anchor
  // navigates natively.
  const tbody = section.querySelector(".cicy-explorer__table tbody");
  if (tbody) {
    tbody.addEventListener("click", (ev) => {
      // "Show all" footer button → render the full (uncapped) result set.
      if (ev.target && ev.target.closest('[data-action="show-all"]')) {
        section.dataset.showAll = "1";
        renderTable(section, section.__rows || [], section.__matches || 0, section.__total || total);
        return;
      }
      if (ev.target && ev.target.tagName === "A") return;
      const tr = ev.target && ev.target.closest("tr[data-num]");
      if (!tr) return;
      window.location.href = `/cicy-coxeter/${tr.dataset.num}/`;
    });
  }
  // Click-to-sort on column headers.
  section.querySelectorAll(".cicy-sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const col = btn.dataset.col;
      if (!SORTABLE_COLS.has(col)) return;
      const cur = (section.dataset.sortCol === col) ? section.dataset.sortDir : null;
      const next = cur === null ? "asc" : (cur === "asc" ? "desc" : null);
      if (next === null) {
        delete section.dataset.sortCol;
        delete section.dataset.sortDir;
      } else {
        section.dataset.sortCol = col;
        section.dataset.sortDir = next;
      }
      updateSortIndicators(section, section.dataset.sortCol, section.dataset.sortDir);
      if (primary) writeFormToUrl(section);
      refresh(section, conn, total);
    });
  });
}

function updateFiltersPill(section) {
  const pill = section.querySelector('[data-role="filters-pill"]');
  if (!pill) return;
  const form = section.querySelector(".cicy-explorer__facets");
  let count = 0;
  for (const key of PILL_FILTER_KEYS) {
    const el = form.elements.namedItem(key);
    if (el && el.value !== "" && el.value != null) count += 1;
  }
  if (count === 0) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const countEl = pill.querySelector(".cicy-explorer__filters-pill-count");
  if (countEl) countEl.textContent = count === 1 ? "1 filter" : `${count} filters`;
}

function updateSortIndicators(section, col, dir) {
  if (col && SORTABLE_COLS.has(col) && (dir === "asc" || dir === "desc")) {
    section.dataset.sortCol = col;
    section.dataset.sortDir = dir;
  } else {
    delete section.dataset.sortCol;
    delete section.dataset.sortDir;
  }
  const activeCol = section.dataset.sortCol;
  const activeDir = section.dataset.sortDir;
  section.querySelectorAll(".cicy-sort-btn").forEach(btn => {
    const arrow = btn.querySelector(".cicy-sort-arrow");
    const th = btn.closest("th");
    btn.classList.remove("is-sort-asc", "is-sort-desc");
    if (activeCol && btn.dataset.col === activeCol) {
      btn.classList.add(activeDir === "asc" ? "is-sort-asc" : "is-sort-desc");
      if (arrow) arrow.textContent = activeDir === "asc" ? " ▲" : " ▼";
      if (th) th.setAttribute("aria-sort", activeDir === "asc" ? "ascending" : "descending");
    } else {
      if (arrow) arrow.textContent = "";
      if (th) th.setAttribute("aria-sort", "none");
    }
  });
}

/* -------- Filter SQL ----------------------------------------------- */

function readFilters(section) {
  const form = section.querySelector(".cicy-explorer__facets");
  const data = new FormData(form);
  const num = parseIntOrNull(data.get("num"));
  if (num !== null) return { num };
  return {
    h11Min: parseIntOrNull(data.get("h11_min")),
    h11Max: parseIntOrNull(data.get("h11_max")),
    h21Min: parseIntOrNull(data.get("h21_min")),
    h21Max: parseIntOrNull(data.get("h21_max")),
    kahlerPos: triStateBool(data.get("kahler_pos")),
    isProduct: triStateBool(data.get("is_product")),
    coxeterRank: parseIntOrNull(data.get("coxeter_rank")),
    coxeterKind: nonEmptyString(data.get("coxeter_kind")),
    shape: nonEmptyString(data.get("shape")),
  };
}

function buildWhere(f) {
  const clauses = [];
  const params = [];
  if ("num" in f) {
    clauses.push("Num = ?");
    params.push(f.num);
    return { sql: clauses.join(" AND "), params };
  }
  if (f.h11Min !== null) { clauses.push("H11 >= ?"); params.push(f.h11Min); }
  if (f.h11Max !== null) { clauses.push("H11 <= ?"); params.push(f.h11Max); }
  if (f.h21Min !== null) { clauses.push("H21 >= ?"); params.push(f.h21Min); }
  if (f.h21Max !== null) { clauses.push("H21 <= ?"); params.push(f.h21Max); }
  if (f.kahlerPos !== null) { clauses.push("KahlerPos = ?"); params.push(f.kahlerPos); }
  if (f.isProduct !== null) { clauses.push("IsProduct = ?"); params.push(f.isProduct); }
  if (f.coxeterRank !== null) {
    if (f.coxeterRank === 0) clauses.push("(IsoFlopRank IS NULL OR IsoFlopRank = 0)");
    else { clauses.push("IsoFlopRank = ?"); params.push(f.coxeterRank); }
  }
  if (f.coxeterKind) {
    if (f.coxeterKind === "none") {
      clauses.push("CoxeterKind IN ('trivial', 'sentinel')");
    } else if (f.coxeterKind === "infinite") {
      clauses.push("CoxeterKind IN ('affine', 'indefinite')");
    } else {
      clauses.push("CoxeterKind = ?");
      params.push(f.coxeterKind);
    }
  }
  if (f.shape) { clauses.push("ShapeKey = ?"); params.push(f.shape); }
  return { sql: clauses.length ? clauses.join(" AND ") : "TRUE", params };
}

function buildOrderBy(section) {
  const col = section.dataset.sortCol;
  const dir = section.dataset.sortDir;
  if (!col || !SORTABLE_COLS.has(col) || (dir !== "asc" && dir !== "desc")) {
    return "ORDER BY Num";
  }
  // BOOLEAN/VARCHAR sort: NULLs last on ASC, first on DESC. Tie-break by Num
  // so the order is deterministic.
  const nulls = dir === "asc" ? "NULLS LAST" : "NULLS FIRST";
  return `ORDER BY ${col} ${dir.toUpperCase()} ${nulls}, Num`;
}

async function refresh(section, conn, total) {
  const filters = readFilters(section);
  const { sql: where, params } = buildWhere(filters);
  const orderBy = buildOrderBy(section);
  const countRes = await prepareAndRun(conn, `SELECT COUNT(*) AS n FROM cicy WHERE ${where}`, params);
  const matches = Number(countRes.toArray()[0].n);
  const rowsRes = await prepareAndRun(
    conn,
    `SELECT Num, H11, H21, 2*(H11-H21) AS Chi, Favour, KahlerPos, IsProduct,
            IsoFlopRank, CoxeterKind, CoxeterSummary, ShapeKey
     FROM cicy WHERE ${where} ${orderBy}`,
    params
  );
  renderGalleryActiveHighlight(filters);
  // Cache the full result set + reset the "show all" toggle so a new query
  // starts capped again; the Show-all button re-renders from this cache.
  section.__rows = rowsRes.toArray();
  section.__matches = matches;
  section.__total = total;
  delete section.dataset.showAll;
  renderTable(section, section.__rows, matches, total);
}

async function prepareAndRun(conn, sql, params) {
  if (params.length === 0) return conn.query(sql);
  const stmt = await conn.prepare(sql);
  try {
    return await stmt.query(...params);
  } finally {
    await stmt.close();
  }
}

/* -------- Gallery highlight ---------------------------------------- */

function renderGalleryActiveHighlight(filters) {
  const active = "shape" in filters ? filters.shape : null;
  document.querySelectorAll('.cxatlas__chip[id^="shape-"]').forEach(tile => {
    const key = tile.id && tile.id.startsWith("shape-") ? tile.id.slice(6) : null;
    if (key && active && key === active) tile.classList.add("is-active-shape");
    else tile.classList.remove("is-active-shape");
  });
}

/* -------- Table render --------------------------------------------- */

function renderTable(section, rows, matches, total) {
  const summary = section.querySelector(".cicy-explorer__summary");
  const tbody = section.querySelector(".cicy-explorer__table tbody");
  const exportBtn = section.querySelector('[data-action="export-csv"]');
  const spec = COLUMN_SPECS[section.dataset.cols] || COLUMN_SPECS["refined-chi"];
  if (summary) {
    summary.innerHTML = matches === 0
      ? `<span class="cicy-explorer__count-empty">No matches. Adjust or reset the filters.</span>`
      : `<span class="cicy-explorer__count-n">${matches.toLocaleString()}</span>`
        + `<span class="cicy-explorer__count-lbl">${matches === 1 ? "model" : "models"}`
        + `<span class="cicy-explorer__count-of"> of ${total.toLocaleString()}</span></span>`;
  }
  if (exportBtn) exportBtn.disabled = matches === 0;
  tbody.innerHTML = "";
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "cicy-explorer__empty-row";
    const td = document.createElement("td");
    td.colSpan = spec.length;
    td.textContent = "No matches. Adjust or reset the filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  // Cap the rendered rows by default (a multi-thousand-row table is heavy to
  // build and slow to scan) but offer a "Show all" button to render the rest.
  const RENDER_CAP = 250;
  const showAll = section.dataset.showAll === "1";
  const capped = !showAll && rows.length > RENDER_CAP;
  const display = capped ? rows.slice(0, RENDER_CAP) : rows;
  const frag = document.createDocumentFragment();
  for (const r of display) {
    const tr = document.createElement("tr");
    const n = Number(r.Num);
    tr.dataset.num = String(n);
    tr.setAttribute("role", "link");
    tr.setAttribute("aria-label", `Open CICY ${n}`);
    for (const col of spec) tr.appendChild(buildCell(col, r));
    frag.appendChild(tr);
  }
  if (capped) {
    const tr = document.createElement("tr");
    tr.className = "cicy-explorer__more-row";
    const td = document.createElement("td");
    td.colSpan = spec.length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cicy-explorer__more-btn";
    btn.dataset.action = "show-all";
    btn.textContent = `Show all ${matches.toLocaleString()}`;
    td.appendChild(btn);
    tr.appendChild(td);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

// One cell for the refined column specs.
function buildCell(col, r) {
  switch (col) {
    case "num": return numCell(Number(r.Num));
    case "h11": return numericCell(String(r.H11));
    case "h21": return numericCell(String(r.H21));
    case "chi": return numericCell(r.Chi == null ? EMPTY : String(Number(r.Chi)));
    case "kpos": return boolCell(r.KahlerPos);
    case "rank": return numericCell(r.IsoFlopRank == null ? EMPTY : String(r.IsoFlopRank));
    case "kind": return kindCell(r.CoxeterKind);
    case "group": return groupCell(r);
    default: return textCell("");
  }
}

// Kind cell \u2014 colour-keyed for finite / affine / indefinite (via [data-kind]
// + the --cx-* palette); muted em dash for trivial / sentinel.
function kindCell(kind) {
  const td = document.createElement("td");
  td.className = "cicy-cell--kind";
  if (kind === "finite" || kind === "affine" || kind === "indefinite") {
    td.dataset.kind = kind;
    const span = document.createElement("span");
    span.className = "cicy-kind";
    span.dataset.kind = kind;
    span.textContent = KIND_DISPLAY[kind];
    td.appendChild(span);
  } else if (kind === "trivial") {
    // Kähler-favorable, no iso-flop walls: DETERMINED — the trivial group.
    td.textContent = "trivial";
  } else {
    // sentinel (non-Kähler-favorable): Coxeter type UNDETERMINED.
    td.textContent = EMPTY;
    td.classList.add("cicy-cell--muted");
  }
  return td;
}

// Group cell \u2014 the canonical Coxeter-diagram display label (\u2124\u2082, I\u2082(4),
// \u2124\u2082 \u00d7 I\u2082(4), K\u2085(3), \u2026) resolved from ShapeKey; muted em dash when none.
function groupCell(r) {
  const td = document.createElement("td");
  td.className = "cicy-cell--group";
  const label = r.ShapeKey && SHAPE_DISPLAY[r.ShapeKey];
  if (!label) {
    if (r.CoxeterKind === "trivial") {
      td.textContent = "1"; // DETERMINED: the trivial Coxeter group W = 1
    } else {
      td.textContent = EMPTY; // sentinel: UNDETERMINED
      td.classList.add("cicy-cell--muted");
    }
    return td;
  }
  // Demote the trailing parabolic/hyperbolic representation tag, e.g. the
  // "(P)" in "I\u2082(\u221e) (P)" \u2014 it's secondary annotation (both P and H mean \u221e).
  const m = /^(.*?)(\s*\((?:P|H)\))$/.exec(label);
  if (m) {
    td.appendChild(document.createTextNode(m[1]));
    const rep = document.createElement("span");
    rep.className = "cicy-group-rep";
    rep.textContent = m[2];
    td.appendChild(rep);
  } else {
    td.textContent = label;
  }
  return td;
}

function numCell(num) {
  const td = document.createElement("td");
  td.className = "cicy-cell--num";
  const a = document.createElement("a");
  a.href = `/cicy-coxeter/${num}/`;
  a.textContent = String(num);
  td.appendChild(a);
  return td;
}

function numericCell(text) {
  const td = document.createElement("td");
  td.className = "cicy-cell--numeric";
  td.textContent = text;
  // An em dash here means undetermined (sentinel Rank) — fade it to match the
  // Type / Group undetermined cells in the same row.
  if (text === EMPTY) td.classList.add("cicy-cell--muted");
  return td;
}

function textCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function boolCell(v) {
  const td = document.createElement("td");
  td.className = "cicy-cell--bool";
  // K\u00e4hler-favorability is always determined, so show a definite \u2713 / \u2717; the
  // muted em dash is reserved for genuinely undetermined Coxeter cells.
  td.textContent = v === true ? "\u2713" : "\u2717";
  return td;
}

/* -------- CSV export ----------------------------------------------- */

// The 11 fields of the published CICY-Coxeter database, in source order — no
// more, no less. The download is a row-subset of the full database (the active
// filter), not the Explorer's display columns.
const DB_FIELDS = [
  "Num", "H11", "H21", "C2", "Conf", "Favour", "KahlerPos", "IsProduct",
  "IsoFlopRows", "KahlerRefGens", "CoxeterMat",
];

// SQL that reconstructs each field's Mathematica-style text exactly as the
// source database renders it: `{...}` lists with ", " separators, True/False,
// the NonKahlerPos sentinel for the three gated fields, quoted IsoFlopRows
// types, and bare P/H symbols in CoxeterMat. Verified byte-for-byte against
// CICY-Coxeter-Database.txt (records 1, 232, 6771).
const DB_EXPORT_SQL = `
  SELECT
    Num, H11, H21,
    '{' || array_to_string(C2, ', ') || '}' AS C2,
    '{' || array_to_string(list_transform(Conf, r -> '{' || array_to_string(r, ', ') || '}'), ', ') || '}' AS Conf,
    CASE WHEN Favour THEN 'True' ELSE 'False' END AS Favour,
    CASE WHEN KahlerPos THEN 'True' ELSE 'False' END AS KahlerPos,
    CASE WHEN IsProduct THEN 'True' ELSE 'False' END AS IsProduct,
    CASE WHEN IsoFlopRows IS NULL THEN 'NonKahlerPos'
         ELSE '{' || array_to_string(list_transform(IsoFlopRows, s -> '{' || s.row::VARCHAR || ', "' || s.type || '"}'), ', ') || '}' END AS IsoFlopRows,
    CASE WHEN KahlerRefGens IS NULL THEN 'NonKahlerPos'
         ELSE '{' || array_to_string(list_transform(KahlerRefGens, m -> '{' || array_to_string(list_transform(m, r -> '{' || array_to_string(r, ', ') || '}'), ', ') || '}'), ', ') || '}' END AS KahlerRefGens,
    CASE WHEN CoxeterMat IS NULL THEN 'NonKahlerPos'
         ELSE '{' || array_to_string(list_transform(CoxeterMat, r -> '{' || array_to_string(r, ', ') || '}'), ', ') || '}' END AS CoxeterMat
  FROM cicy`;

async function exportCsv(section, conn) {
  const filters = readFilters(section);
  const { sql: where, params } = buildWhere(filters);
  const res = await prepareAndRun(
    conn,
    `${DB_EXPORT_SQL} WHERE ${where} ORDER BY Num`,
    params
  );
  const rows = res.toArray();
  const csv = [DB_FIELDS.join(",")]
    .concat(rows.map(r => DB_FIELDS.map(k => csvCell(r[k])).join(",")))
    .join("\n");
  const blob = new Blob([csv + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // `where === "TRUE"` exactly when no filter or `num` search is active, i.e.
  // the export is the whole database. Name the download to match the full-DB
  // file style (CICY-Coxeter-Database.{m,txt}), flagging filtered subsets.
  const filtered = where !== "TRUE";
  a.download = filtered
    ? "CICY-Coxeter-Filtered-Database.csv"
    : "CICY-Coxeter-Database.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  if (v == null) return "";
  const s = typeof v === "bigint" ? v.toString() : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/* -------- Helpers -------------------------------------------------- */

function parseIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function triStateBool(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function nonEmptyString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
