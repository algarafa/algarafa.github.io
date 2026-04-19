import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const PARQUET_URL = "/cicy-coxeter/cicy-coxeter.parquet";
const LIMIT = 500;

const root = document.getElementById("explorer");
if (root) init(root).catch(err => showStatus(root, `Failed to initialise: ${err.message || err}`, true));

async function init(section) {
  showStatus(section, "Loading DuckDB-WASM \u2026");

  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerBlob = new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" });
  const workerUrl = URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  showStatus(section, "Downloading database \u2026");
  const resp = await fetch(PARQUET_URL);
  if (!resp.ok) throw new Error(`Parquet fetch failed: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await db.registerFileBuffer("cicy.parquet", buf);
  const conn = await db.connect();
  await conn.query("CREATE VIEW cicy AS SELECT * FROM 'cicy.parquet'");
  const countRes = await conn.query("SELECT COUNT(*) AS n FROM cicy");
  const total = Number(countRes.toArray()[0].n);

  hideStatus(section);
  wireUI(section, conn, total);
  applyHashFilter(section, { scroll: false });
  await refresh(section, conn, total);

  // Respond to same-page hash changes (e.g. user clicks another /cicy-coxeter/
  // link in the glossary, comes back, or pastes a new #row= hash, or clicks
  // a gallery tile with #shape=<key>).
  window.addEventListener('hashchange', async () => {
    applyHashFilter(section, { scroll: true });
    await refresh(section, conn, total);
  });
}

function applyHashFilter(section, { scroll = false } = {}) {
  const hash = window.location.hash || "";
  const rowMatch = /^#row=(\d+)$/.exec(hash);
  // Shape keys can contain '+' which Hugo percent-encodes to %2b in hrefs,
  // so accept the percent-encoded form and decode it before comparing with
  // the <select> option values (which use the literal key).
  const shapeMatch = /^#shape=([A-Za-z0-9_%+-]+)$/.exec(hash);
  const numInput = section.querySelector('input[name="num"]');
  const shapeSelect = section.querySelector('select[name="shape"]');

  if (rowMatch && numInput) {
    const num = rowMatch[1];
    numInput.value = num;
    if (shapeSelect) shapeSelect.value = "";
    section.dataset.highlightNum = num;
    delete section.dataset.activeShape;
    return;
  }
  if (shapeMatch && shapeSelect) {
    let key = shapeMatch[1];
    try { key = decodeURIComponent(key); } catch (_) { /* keep raw */ }
    const optExists = Array.from(shapeSelect.options).some(o => o.value === key);
    if (optExists) {
      shapeSelect.value = key;
      section.dataset.activeShape = key;
    } else {
      delete section.dataset.activeShape;
    }
    if (numInput) numInput.value = "";
    delete section.dataset.highlightNum;
    if (scroll) {
      section.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    return;
  }
  // No recognised hash: clear highlight state only. Do not wipe user-entered
  // form values.
  delete section.dataset.highlightNum;
  delete section.dataset.activeShape;
}

function wireUI(section, conn, total) {
  const form = section.querySelector(".cicy-explorer__facets");
  let timer = null;
  form.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(section, conn, total), 150);
  });
  form.addEventListener("change", (ev) => {
    clearTimeout(timer);
    if (ev.target && ev.target.name === "shape") {
      updateHashForShape(ev.target.value);
    }
    refresh(section, conn, total);
  });
  form.addEventListener("reset", () => {
    clearTimeout(timer);
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    delete section.dataset.highlightNum;
    delete section.dataset.activeShape;
    setTimeout(() => refresh(section, conn, total), 0);
  });
  const exportBtn = section.querySelector('[data-action="export-csv"]');
  exportBtn.addEventListener("click", () => exportCsv(section, conn));
}

function updateHashForShape(key) {
  const newHash = key ? `#shape=${key}` : "";
  if (newHash && window.location.hash !== newHash) {
    history.replaceState(null, "", window.location.pathname + window.location.search + newHash);
  } else if (!newHash && window.location.hash) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

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
  if (f.shape) { clauses.push("ShapeKey = ?"); params.push(f.shape); }
  return { sql: clauses.length ? clauses.join(" AND ") : "TRUE", params };
}

async function refresh(section, conn, total) {
  const filters = readFilters(section);
  const { sql: where, params } = buildWhere(filters);
  const countRes = await prepareAndRun(conn, `SELECT COUNT(*) AS n FROM cicy WHERE ${where}`, params);
  const matches = Number(countRes.toArray()[0].n);
  const rowsRes = await prepareAndRun(
    conn,
    `SELECT Num, H11, H21, KahlerPos, IsProduct, IsoFlopRank, CoxeterSummary
     FROM cicy WHERE ${where} ORDER BY Num LIMIT ${LIMIT}`,
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
    if (select) select.value = "";
    updateHashForShape("");
    delete section.dataset.activeShape;
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

function renderTable(section, rows, matches, total) {
  const summary = section.querySelector(".cicy-explorer__summary");
  const tbody = section.querySelector(".cicy-explorer__table tbody");
  const exportBtn = section.querySelector('[data-action="export-csv"]');
  const shown = rows.length;
  if (matches === 0) {
    summary.textContent = `No CICYs match the current filters (of ${total.toLocaleString()} total).`;
    exportBtn.disabled = true;
  } else if (matches > shown) {
    summary.textContent = `Showing the first ${shown.toLocaleString()} of ${matches.toLocaleString()} matches (out of ${total.toLocaleString()} total). Refine filters or export below.`;
    exportBtn.disabled = false;
  } else {
    summary.textContent = `Showing all ${matches.toLocaleString()} matches (out of ${total.toLocaleString()} total).`;
    exportBtn.disabled = false;
  }
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  const highlightNum = section.dataset.highlightNum
    ? String(section.dataset.highlightNum)
    : null;
  let highlightRow = null;
  for (const r of rows) {
    const tr = document.createElement("tr");
    const n = String(r.Num);
    tr.dataset.num = n;
    if (highlightNum && n === highlightNum) {
      tr.classList.add("is-highlighted");
      highlightRow = tr;
    }
    tr.appendChild(cell(linkToEntry(Number(r.Num))));
    tr.appendChild(cell(String(r.H11)));
    tr.appendChild(cell(String(r.H21)));
    tr.appendChild(cell(boolCell(r.KahlerPos)));
    tr.appendChild(cell(boolCell(r.IsProduct)));
    tr.appendChild(cell(r.IsoFlopRank == null ? "\u2014" : String(r.IsoFlopRank)));
    tr.appendChild(cell(r.CoxeterSummary || "\u2014"));
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  if (highlightRow) {
    highlightRow.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function cell(content) {
  const td = document.createElement("td");
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = content;
  return td;
}

function linkToEntry(num) {
  const a = document.createElement("a");
  a.href = `/cicy-coxeter/${num}/`;
  a.textContent = String(num);
  return a;
}

function boolCell(v) {
  if (v === true) return "\u2713";
  if (v === false) return "\u00b7";
  return "\u2014";
}

async function exportCsv(section, conn) {
  const filters = readFilters(section);
  const { sql: where, params } = buildWhere(filters);
  const res = await prepareAndRun(
    conn,
    `SELECT Num, H11, H21, Favour, KahlerPos, IsProduct, IsoFlopRank, CoxeterSummary, ShapeKey
     FROM cicy WHERE ${where} ORDER BY Num`,
    params
  );
  const rows = res.toArray();
  const header = ["Num","H11","H21","Favour","KahlerPos","IsProduct","IsoFlopRank","CoxeterSummary","ShapeKey"];
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

function showStatus(section, msg, isError = false) {
  const el = section.querySelector(".cicy-explorer__status");
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle("cicy-explorer__status--error", isError);
}

function hideStatus(section) {
  const el = section.querySelector(".cicy-explorer__status");
  el.hidden = true;
}
