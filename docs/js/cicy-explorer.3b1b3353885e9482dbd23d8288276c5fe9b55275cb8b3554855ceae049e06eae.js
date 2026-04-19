import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

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
  "Num", "H11", "H21", "Favour", "KahlerPos", "IsProduct",
  "IsoFlopRank", "CoxeterKind", "CoxeterSummary",
]);

const KIND_DISPLAY = {
  finite: "finite",
  affine: "affine",
  indefinite: "indefinite",
  trivial: "—",
  sentinel: "—",
};

const root = document.getElementById("explorer");
if (root) init(root).catch(err => loadingError(root, err));

// Returns "smooth" or "auto" depending on the user's reduced-motion preference.
// Evaluated at call time so OS-level toggles take effect without a reload.
function scrollBehavior() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

async function init(section) {
  setLoadingStage(section, "duckdb");
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerBlob = new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" });
  const workerUrl = URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  setLoadingStage(section, "parquet");
  const resp = await fetch(PARQUET_URL);
  if (!resp.ok) throw new Error(`Parquet fetch failed: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await db.registerFileBuffer("cicy.parquet", buf);
  const conn = await db.connect();

  setLoadingStage(section, "view");
  await conn.query("CREATE VIEW cicy AS SELECT * FROM 'cicy.parquet'");
  const countRes = await conn.query("SELECT COUNT(*) AS n FROM cicy");
  const total = Number(countRes.toArray()[0].n);

  hideLoading(section);
  // Translate any inbound legacy hash to query string before reading state,
  // so `#row=N` / `#shape=KEY` from per-entry-page links still work as
  // first-class entry points.
  translateLegacyHash();
  applyUrlToForm(section);
  wireUI(section, conn, total);
  await refresh(section, conn, total);

  // Same-page hash changes (e.g. another cross-link click in this tab).
  window.addEventListener("hashchange", async () => {
    if (translateLegacyHash()) {
      applyUrlToForm(section);
      await refresh(section, conn, total);
    }
  });
  // Browser back/forward across query-string filter states.
  window.addEventListener("popstate", async () => {
    applyUrlToForm(section);
    await refresh(section, conn, total);
  });
  // Chart-tile click events from cicy-charts.js.
  document.addEventListener("cicy:filter", async (ev) => {
    applyDetailToForm(section, ev.detail || {});
    writeFormToUrl(section);
    section.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    await refresh(section, conn, total);
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

function wireUI(section, conn, total) {
  const form = section.querySelector(".cicy-explorer__facets");
  let timer = null;
  form.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      writeFormToUrl(section);
      updateFiltersPill(section);
      refresh(section, conn, total);
    }, 150);
  });
  form.addEventListener("change", () => {
    clearTimeout(timer);
    writeFormToUrl(section);
    updateFiltersPill(section);
    refresh(section, conn, total);
  });
  form.addEventListener("reset", () => {
    clearTimeout(timer);
    delete section.dataset.sortCol;
    delete section.dataset.sortDir;
    setTimeout(() => {
      writeFormToUrl(section);
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
  section.querySelector('[data-action="export-csv"]')
    .addEventListener("click", () => exportCsv(section, conn));
  const shareBtn = section.querySelector('[data-action="copy-url"]');
  if (shareBtn) shareBtn.addEventListener("click", () => copyUrl(section, shareBtn));
  // Gallery-tile clicks: intercept on the landing page so we don't full-reload
  // (which would re-instantiate DuckDB-WASM). External / new-tab clicks fall
  // through to the native href.
  document.querySelectorAll(".cicy-gallery__link").forEach(link => {
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
  // Delegated click for whole-row mouse affordance. Keyboard users tab to the
  // anchor inside the #-cell (single focus stop per row); Enter on that anchor
  // navigates natively.
  const tbody = section.querySelector(".cicy-explorer__table tbody");
  if (tbody) {
    tbody.addEventListener("click", (ev) => {
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
      writeFormToUrl(section);
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

function copyUrl(section, btn) {
  const original = btn.textContent;
  navigator.clipboard.writeText(window.location.href).then(
    () => {
      btn.textContent = "URL copied";
      setTimeout(() => { btn.textContent = original; }, 1500);
    },
    () => {
      btn.textContent = "Copy failed";
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  );
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
    `SELECT Num, H11, H21, Favour, KahlerPos, IsProduct, IsoFlopRank, CoxeterKind, CoxeterSummary
     FROM cicy WHERE ${where} ${orderBy}`,
    params
  );
  renderShapeNotice(section, filters);
  renderGalleryActiveHighlight(filters);
  renderTable(section, rowsRes.toArray(), matches, total);
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

/* -------- Notice + gallery highlight ------------------------------- */

function renderShapeNotice(section, filters) {
  let notice = section.querySelector(".cicy-explorer__shape-notice");
  const shape = "shape" in filters ? filters.shape : null;
  if (!shape) {
    if (notice) notice.remove();
    return;
  }
  const select = section.querySelector('select[name="shape"]');
  const opt = select && Array.from(select.options).find(o => o.value === shape);
  const label = opt ? opt.textContent.trim() : shape;
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "cicy-explorer__shape-notice";
    notice.setAttribute("role", "status");
    const summary = section.querySelector(".cicy-explorer__summary");
    summary.parentNode.insertBefore(notice, summary);
  }
  notice.innerHTML = "";
  const textSpan = document.createElement("span");
  textSpan.textContent = `Filtered by diagram shape: ${label}`;
  notice.appendChild(textSpan);
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    if (select) {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  notice.appendChild(clearBtn);
}

function renderGalleryActiveHighlight(filters) {
  const active = "shape" in filters ? filters.shape : null;
  document.querySelectorAll(".cicy-gallery__tile").forEach(tile => {
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
  if (matches === 0) {
    summary.textContent = `No CICYs match the current filters (of ${total.toLocaleString()} total).`;
    exportBtn.disabled = true;
  } else {
    summary.textContent = `Showing all ${matches.toLocaleString()} matches (out of ${total.toLocaleString()} total).`;
    exportBtn.disabled = false;
  }
  tbody.innerHTML = "";
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "cicy-explorer__empty-row";
    const td = document.createElement("td");
    td.colSpan = 9;
    td.textContent = "No matches. Adjust or reset the filters above.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    const n = Number(r.Num);
    tr.dataset.num = String(n);
    tr.setAttribute("role", "link");
    tr.setAttribute("aria-label", `Open CICY ${n}`);
    tr.appendChild(numCell(n));
    tr.appendChild(numericCell(String(r.H11)));
    tr.appendChild(numericCell(String(r.H21)));
    tr.appendChild(boolCell(r.Favour));
    tr.appendChild(boolCell(r.KahlerPos));
    tr.appendChild(boolCell(r.IsProduct));
    tr.appendChild(numericCell(r.IsoFlopRank == null ? "\u2014" : String(r.IsoFlopRank)));
    tr.appendChild(textCell(KIND_DISPLAY[r.CoxeterKind] || r.CoxeterKind || "\u2014"));
    tr.appendChild(textCell(r.CoxeterSummary || "\u2014"));
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
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
  if (v === true) td.textContent = "\u2713";
  else if (v === false) td.textContent = "\u00b7";
  else td.textContent = "\u2014";
  return td;
}

/* -------- CSV export ----------------------------------------------- */

async function exportCsv(section, conn) {
  const filters = readFilters(section);
  const { sql: where, params } = buildWhere(filters);
  const res = await prepareAndRun(
    conn,
    `SELECT Num, H11, H21, Favour, KahlerPos, IsProduct, IsoFlopRank,
            CoxeterKind, CoxeterSummary, ShapeKey
     FROM cicy WHERE ${where} ORDER BY Num`,
    params
  );
  const rows = res.toArray();
  const header = ["Num","H11","H21","Favour","KahlerPos","IsProduct","IsoFlopRank","CoxeterKind","CoxeterSummary","ShapeKey"];
  const csv = [header.join(",")]
    .concat(rows.map(r => header.map(k => csvCell(r[k])).join(",")))
    .join("\n");
  const blob = new Blob([csv + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cicy-coxeter-matches.csv";
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
