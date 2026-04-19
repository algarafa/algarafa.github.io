const CHART_IDS = ["cicy-chart-hodge", "cicy-chart-rank-h11", "cicy-chart-rank-h11-infinite"];

// Sentinel string used as the Vega-Lite axis title; the post-render hook
// `injectKatexTitles` finds <text> nodes whose textContent matches
// /^__KATEX:(.+)__$/ and replaces them with a KaTeX-rendered <foreignObject>.
function katexTitle(latex) {
  return `__KATEX:${latex}__`;
}

function showError(targetId, msg) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = "";
  const p = document.createElement("p");
  p.style.cssText = "color:#c0392b;margin:0;padding:0.5rem;";
  p.textContent = msg;
  el.appendChild(p);
}

function showErrorAll(msg) {
  for (const id of CHART_IDS) showError(id, msg);
}

function dispatchFilter(detail) {
  document.dispatchEvent(new CustomEvent("cicy:filter", { detail }));
}

(async () => {
  const dataEl = document.getElementById("cicy-chart-data");
  if (!dataEl) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    showErrorAll("Could not parse chart data: " + err.message);
    return;
  }

  let embed;
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/vega-embed@6/+esm");
    embed = mod.default;
    if (typeof embed !== "function") throw new Error("vega-embed default export is not a function");
  } catch (err) {
    console.error("cicy-charts: failed to load vega-embed", err);
    showErrorAll("Could not load Vega-Embed from CDN: " + (err.message || err));
    return;
  }

  const theme = readThemeConfig();
  const embedOpts = { actions: false, renderer: "svg" };

  await runRender(
    "cicy-chart-hodge",
    () => hodgeSpec(data.hodge_scatter, theme),
    embed, embedOpts,
    (datum) => dispatchFilter({
      h11_min: datum.h11, h11_max: datum.h11,
      h21_min: datum.h21, h21_max: datum.h21,
    })
  );
  await runRender(
    "cicy-chart-rank-h11",
    () => rankH11Spec(data.rank_h11_table, theme, null),
    embed, embedOpts,
    (datum) => dispatchFilter({
      coxeter_rank: datum.rank,
      h11_min: datum.h11, h11_max: datum.h11,
    })
  );
  await runRender(
    "cicy-chart-rank-h11-infinite",
    () => rankH11Spec(data.rank_h11_table, theme, ["affine", "indefinite"]),
    embed, embedOpts,
    (datum) => dispatchFilter({
      coxeter_rank: datum.rank,
      h11_min: datum.h11, h11_max: datum.h11,
      coxeter_kind: "infinite",
    })
  );
})();

async function runRender(targetId, specFn, embed, opts, onClick) {
  try {
    const spec = specFn();
    const result = await embed("#" + targetId, spec, opts);
    injectKatexTitles(document.getElementById(targetId));
    if (onClick && result && result.view) {
      result.view.addEventListener("click", (event, item) => {
        if (!item || !item.datum) return;
        onClick(item.datum);
      });
      // Visual cue that cells are clickable.
      const container = document.getElementById(targetId);
      if (container) container.classList.add("cicy-chart--clickable");
    }
  } catch (err) {
    console.error("cicy-charts: render failed for " + targetId, err);
    showError(targetId, "Render failed: " + (err.message || err));
  }
}

function injectKatexTitles(container) {
  if (!container || !window.katex) return;
  const svg = container.querySelector("svg");
  if (!svg) return;
  const xhtmlNs = "http://www.w3.org/1999/xhtml";
  const svgNs = "http://www.w3.org/2000/svg";
  const titles = svg.querySelectorAll("text");
  titles.forEach(textEl => {
    const txt = textEl.textContent || "";
    const match = /^__KATEX:(.+)__$/.exec(txt);
    if (!match) return;
    let html;
    try {
      html = window.katex.renderToString(match[1], {
        throwOnError: false,
        displayMode: false,
      });
    } catch (err) {
      console.warn("cicy-charts: KaTeX render failed for", match[1], err);
      textEl.textContent = match[1]; // fallback to raw LaTeX
      return;
    }
    let bbox;
    try { bbox = textEl.getBBox(); } catch (_) { bbox = { x: 0, y: 0, width: 60, height: 16 }; }
    const transform = textEl.getAttribute("transform") || "";
    // Generous padding so the rendered KaTeX HTML fits without clipping.
    const w = Math.max(bbox.width * 1.6 + 24, 80);
    const h = Math.max(bbox.height * 1.6 + 8, 22);
    const fo = document.createElementNS(svgNs, "foreignObject");
    fo.setAttribute("x", String(bbox.x - 12));
    fo.setAttribute("y", String(bbox.y - 4));
    fo.setAttribute("width", String(w));
    fo.setAttribute("height", String(h));
    if (transform) fo.setAttribute("transform", transform);
    fo.style.overflow = "visible";
    const div = document.createElementNS(xhtmlNs, "div");
    div.setAttribute("xmlns", xhtmlNs);
    div.style.fontSize = "16px";
    div.style.color = "currentColor";
    div.style.lineHeight = "1";
    div.style.textAlign = "center";
    div.innerHTML = html;
    fo.appendChild(div);
    textEl.parentNode.appendChild(fo);
    textEl.style.display = "none";
    textEl.setAttribute("aria-hidden", "true");
  });
}

function readThemeConfig() {
  // With the SVG renderer, `currentColor` in the Vega config propagates to
  // `fill="currentColor"` / `stroke="currentColor"` on the emitted SVG
  // primitives, and the browser resolves it against the nearest cascading
  // CSS `color`. The charts sit inside `.post__content`, which inherits
  // Anatole's theme-aware body colour — so axis labels and lines track the
  // current theme without any JS-side theme detection.
  const docStyle = getComputedStyle(document.documentElement);
  const read = (name, fallback) => (docStyle.getPropertyValue(name).trim() || fallback);
  const accent = read("--cicy-chart-accent", "#4a7bd6");
  const bg = read("--cicy-chart-bg", "transparent");
  return {
    background: bg,
    view: { stroke: null },
    axis: {
      labelColor: "currentColor",
      titleColor: "currentColor",
      domainColor: "currentColor",
      tickColor: "currentColor",
      gridColor: "currentColor",
      gridOpacity: 0.15,
      labelFontSize: 16,
      titleFontSize: 16,
    },
    legend: {
      labelColor: "currentColor",
      titleColor: "currentColor",
      labelFontSize: 16,
      titleFontSize: 16,
    },
    title: { color: "currentColor", fontSize: 16 },
    range: { heatmap: { scheme: "blues" } },
    mark: { color: accent },
  };
}

function hodgeSpec(rows, config) {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Hodge numbers of all 7890 CICYs.",
    data: { values: rows },
    width: "container",
    height: 260,
    mark: { type: "circle", opacity: 0.75, cursor: "pointer" },
    encoding: {
      x: { field: "h11", type: "quantitative", title: katexTitle("h^{1,1}") },
      y: { field: "h21", type: "quantitative", title: katexTitle("h^{2,1}") },
      size: { field: "count", type: "quantitative", title: "count",
              scale: { range: [16, 320] } },
      tooltip: [
        { field: "h11", type: "quantitative", title: "h¹·¹" },
        { field: "h21", type: "quantitative", title: "h²·¹" },
        { field: "count", type: "quantitative", title: "CICYs" },
        { field: "kahler_fav", type: "quantitative", title: "Kähler-fav." },
      ],
    },
    config,
  };
}

function rankH11Spec(rows, config, kindAllowlist) {
  // Reference data spans every (rank, h11) cell in the Kähler-favorable set
  // regardless of kind, so the full and infinite-only heatmaps share x/y
  // axes and the colour scale. The infinite chart then reads as a sparser
  // version of the full chart instead of a tighter one.
  const fullData = rows.filter(r => r.rank >= 1);
  const fullCellTotals = new Map();
  for (const r of fullData) {
    const key = `${r.rank}|${r.h11}`;
    fullCellTotals.set(key, (fullCellTotals.get(key) || 0) + r.count);
  }
  const fullCellMax = fullCellTotals.size ? Math.max(...fullCellTotals.values()) : 1;
  const ranksDesc = [...new Set(fullData.map(r => r.rank))].sort((a, b) => b - a);
  const h11sAsc = [...new Set(fullData.map(r => r.h11))].sort((a, b) => a - b);

  const filtered = kindAllowlist
    ? fullData.filter(r => kindAllowlist.includes(r.coxeter_kind))
    : fullData;

  // Single threshold computed from the shared fullCellMax so both heatmaps
  // flip text colour at the same cell-count level.
  const whiteThreshold = Math.max(1, fullCellMax * 0.4);
  const description = kindAllowlist
    ? "Rank(W) × h¹·¹ heatmap restricted to infinite (affine + indefinite) Coxeter groups, drawn on the full chart's axes."
    : "Rank(W) × h¹·¹ heatmap (paper Table 3.1).";
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description,
    data: { values: filtered },
    width: "container",
    height: 260,
    transform: [
      { aggregate: [{ op: "sum", field: "count", as: "count" }],
        groupby: ["rank", "h11"] },
    ],
    layer: [
      { mark: { type: "rect", tooltip: true, cursor: "pointer" },
        encoding: {
          x: { field: "h11", type: "ordinal", title: katexTitle("h^{1,1}"),
               scale: { domain: h11sAsc } },
          y: { field: "rank", type: "ordinal", title: katexTitle("\\mathrm{rank}(W)"),
               scale: { domain: ranksDesc } },
          color: { field: "count", type: "quantitative", title: "models",
                   scale: { scheme: "blues", type: "log",
                            domain: [1, fullCellMax] } },
        } },
      { mark: { type: "text", fontSize: 16 },
        encoding: {
          x: { field: "h11", type: "ordinal", scale: { domain: h11sAsc } },
          y: { field: "rank", type: "ordinal", scale: { domain: ranksDesc } },
          text: { field: "count", type: "quantitative" },
          color: { condition: { test: `datum.count > ${whiteThreshold}`, value: "white" },
                   value: "black" },
        } },
    ],
    config,
  };
}
