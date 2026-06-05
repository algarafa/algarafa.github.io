/* CICY landing-page charts.

   DOM-driven: every element carrying `data-cicy-chart="<key>"` is rendered
   with the matching Vega-Lite spec, so the markup decides which charts
   appear and where. The h21-vs-h11 Hodge
   scatter was retired; the rank(W) x h^{1,1} heatmap is the canonical view,
   available "full" (all Kahler-favorable) or "infinite-only".

   A container additionally marked `data-cicy-chart-toggle` can be flipped
   between the two modes by sibling buttons `[data-cicy-chart-mode]`. */

const CHART_FALLBACKS = {
  "rank-h11":
    "Coxeter rank × h¹¹ across the 4874 Kähler-favorable CICYs (paper Section 3, Table 3.1).",
  "rank-h11-infinite":
    "Same axes, restricted to infinite Coxeter groups: 251 Kähler-favorable CICYs, all with h¹¹ ≤ 5.",
};

const FALLBACK_TIMEOUT_MS = 6000;

let DATA = null;
let THEME = null;
let EMBED = null;
let EMBED_OPTS = null;

// Safari/WebKit mis-paints HTML inside an SVG <foreignObject> when a transform
// sits in its ancestor chain (WebKit bug 23113), which breaks the math axis
// titles. Detect genuine WebKit (Safari desktop + every iOS browser) while
// excluding the Blink browsers that also carry "AppleWebKit" in their UA, so
// only Safari takes the workaround and Chrome/Edge/Firefox keep the proven path.
const IS_WEBKIT =
  typeof navigator !== "undefined" &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);

function katexTitle(latex) {
  return `__KATEX:${latex}__`;
}

function chartHasRendered(el) {
  return !!(el && el.querySelector("svg, canvas"));
}

function showFallback(el, key) {
  if (!el || el.dataset.fallback === "shown") return;
  if (chartHasRendered(el)) return;
  el.dataset.fallback = "shown";
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "cicy-chart-fallback";
  wrap.setAttribute("role", "note");
  const summary = document.createElement("p");
  summary.className = "cicy-chart-fallback__summary";
  summary.textContent = CHART_FALLBACKS[key] || "Chart unavailable.";
  const note = document.createElement("p");
  note.className = "cicy-chart-fallback__note";
  note.innerHTML =
    "Chart rendering unavailable in this browser. Download the full dataset as " +
    '<a href="CICY-Coxeter-Database.m">Mathematica</a> or ' +
    '<a href="CICY-Coxeter-Database.txt">plain text</a>.';
  wrap.appendChild(summary);
  wrap.appendChild(note);
  el.appendChild(wrap);
}

function dispatchFilter(detail) {
  document.dispatchEvent(new CustomEvent("cicy:filter", { detail }));
}

// A base data-cicy-chart key seeds the element's initial mode; the toggle
// then drives it. "all" = every Kahler-favorable model, "infinite" = the
// affine + indefinite subset.
function modeFromKey(key) {
  return key === "rank-h11-infinite" ? "infinite" : "all";
}

// Per-element render options, read from data-* so the markup fully decides
// the look.
function elOptions(el) {
  return {
    style: el.dataset.cicyChartStyle || "swap", // "swap" | "overlay"
    scheme: el.dataset.cicyChartScheme || "blues", // "blues" | "gruvbox"
    legend: el.dataset.cicyChartLegend || "right", // "right" | "bottom" | "none"
    // Aspect controls. `cell` (px) gives fixed SQUARE cells (band step on
    // both axes); otherwise the chart fills its container at `height` px.
    cell: el.dataset.cicyChartCell ? Number(el.dataset.cicyChartCell) : null,
    height: el.dataset.cicyChartHeight ? Number(el.dataset.cicyChartHeight) : null,
  };
}

// --- Responsive colour-legend placement ------------------------------------
// `data-cicy-chart-legend="responsive"` puts the "models" scale BENEATH the
// chart on narrow/intermediate columns and BESIDE it (vertical, right) ONLY
// once the column is wide enough to seat the (wider) right-scale layout at full
// size — i.e. without shrinking the cells below the scale-beneath version. The
// square-cell chart's natural width is ~604px with the scale beneath and
// ~656px with it on the right, so we flip at the right-scale natural width plus
// a small margin. The literal values "bottom"/"right"/"none" force a fixed
// placement.
const LEGEND_SIDE_MIN_PX = 662;
function chartHost(el) {
  return el.closest(".cxch2c__frame") || el.parentElement || el;
}
function resolveLegend(el, legend) {
  if (legend !== "responsive") return legend;
  // el (.cxch2c__chart) is width:100% of the card, so its box is the true
  // horizontal room available to the chart.
  return el.getBoundingClientRect().width >= LEGEND_SIDE_MIN_PX ? "right" : "bottom";
}

// Make a freshly embedded Vega SVG scale fluidly: a viewBox preserves the
// aspect ratio while `width:100%` (capped at the natural pixel width so it
// never upscales past the square-cell design) lets it shrink to fit a narrow
// card instead of overflowing it.
function makeChartFluid(container) {
  const svg = container.querySelector("svg");
  if (!svg) return;
  const w = parseFloat(svg.getAttribute("width"));
  const h = parseFloat(svg.getAttribute("height"));
  if (w && h && !svg.getAttribute("viewBox")) {
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = "100%";
  svg.style.height = "auto";
  if (w) svg.style.maxWidth = `${w}px`;
  svg.style.display = "block";
  svg.style.margin = "0 auto";
}

function fallbackKeyFor(el, mode) {
  if (elOptions(el).style === "overlay") return "rank-h11";
  return mode === "infinite" ? "rank-h11-infinite" : "rank-h11";
}

function clickHandlerFor(el, mode) {
  const overlay = elOptions(el).style === "overlay";
  return (datum) => {
    const detail = {
      coxeter_rank: datum.rank,
      h11_min: datum.h11,
      h11_max: datum.h11,
    };
    // Pre-select the infinite facet only when the click semantically targets
    // it: in the infinite swap view, or on a highlighted cell of the overlay
    // while highlighting (gold cells carry `inf`, faded base cells `hasInf`).
    if (mode === "infinite" && (overlay ? (datum.inf || datum.hasInf) : true)) {
      detail.coxeter_kind = "infinite";
    }
    dispatchFilter(detail);
  };
}

function specForElement(el, mode) {
  const o = elOptions(el);
  const legend = resolveLegend(el, o.legend);
  el.dataset.cicyLegendNow = legend; // tracked so a resize can re-render on flip
  const opts = { legend, scheme: o.scheme, cell: o.cell, height: o.height };
  if (o.style === "overlay") {
    return overlaySpec(DATA.rank_h11_table, THEME, mode, opts);
  }
  const allow = mode === "infinite" ? ["affine", "indefinite"] : null;
  return rankH11Spec(DATA.rank_h11_table, THEME, allow, opts);
}

async function renderChart(el, mode) {
  el.dataset.cicyMode = mode; // remembered so theme switches can re-render
  el.dataset.fallback = "";
  el.innerHTML = "";
  el.classList.remove("cicy-chart--clickable");
  const fbKey = fallbackKeyFor(el, mode);
  const timer = window.setTimeout(() => showFallback(el, fbKey), FALLBACK_TIMEOUT_MS);
  try {
    const spec = specForElement(el, mode);
    const result = await EMBED(el, spec, EMBED_OPTS);
    injectKatexTitles(el);
    makeChartFluid(el);
    const onClick = clickHandlerFor(el, mode);
    if (result && result.view) {
      result.view.addEventListener("click", (event, item) => {
        if (!item || !item.datum) return;
        onClick(item.datum);
      });
      el.classList.add("cicy-chart--clickable");
    }
  } catch (err) {
    console.error("cicy-charts: render failed", err);
    showFallback(el, fbKey);
  } finally {
    window.clearTimeout(timer);
  }
}

function initToggle(el) {
  // The toggle buttons live in the nearest ancestor that also holds the
  // chart container, so scope the lookup there.
  const scope = el.closest("[data-cicy-chart-group]") || el.parentElement || document;
  const buttons = scope.querySelectorAll("[data-cicy-chart-mode]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = btn.getAttribute("data-cicy-chart-mode") === "infinite" ? "infinite" : "all";
      buttons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
      await renderChart(el, mode);
    });
  });
}

(async () => {
  const dataEl = document.getElementById("cicy-chart-data");
  if (!dataEl) return;
  const targets = Array.from(document.querySelectorAll("[data-cicy-chart]"));
  if (targets.length === 0) return;

  try {
    DATA = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("cicy-charts: chart data parse failed", err);
    targets.forEach((el) => showFallback(el, el.dataset.cicyChart));
    return;
  }

  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/vega-embed@7/+esm");
    EMBED = mod.default;
    if (typeof EMBED !== "function") throw new Error("vega-embed default export is not a function");
  } catch (err) {
    console.error("cicy-charts: failed to load vega-embed", err);
    targets.forEach((el) => showFallback(el, el.dataset.cicyChart));
    return;
  }

  THEME = readThemeConfig();
  EMBED_OPTS = { actions: false, renderer: "svg" };

  for (const el of targets) {
    const key = el.dataset.cicyChart || "rank-h11";
    await renderChart(el, modeFromKey(key));
    if (el.hasAttribute("data-cicy-chart-toggle")) initToggle(el);
  }

  // The heat ramps are theme-aware (dense cells brighten in dark mode rather
  // than receding into the background), so re-render every chart when the
  // anatole switcher flips the `theme--{light,dark}` class on <html>.
  let themeTimer = null;
  const reRender = () => {
    for (const el of targets) {
      const mode = el.dataset.cicyMode || modeFromKey(el.dataset.cicyChart || "rank-h11");
      renderChart(el, mode);
    }
  };
  const obs = new MutationObserver(() => {
    window.clearTimeout(themeTimer);
    themeTimer = window.setTimeout(reRender, 60);
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  // Re-render a chart only when its card crosses the legend-placement
  // threshold (bottom ⇄ right); the SVG itself scales fluidly between, so
  // ordinary resizes need no work.
  if (typeof ResizeObserver === "function") {
    const legendTimers = new Map();
    const ro = new ResizeObserver(() => {
      for (const el of targets) {
        const want = resolveLegend(el, elOptions(el).legend);
        if (!el.dataset.cicyLegendNow || want === el.dataset.cicyLegendNow) continue;
        window.clearTimeout(legendTimers.get(el));
        legendTimers.set(el, window.setTimeout(() => {
          const mode = el.dataset.cicyMode || modeFromKey(el.dataset.cicyChart || "rank-h11");
          renderChart(el, mode);
        }, 120));
      }
    });
    targets.forEach((el) => ro.observe(chartHost(el)));
  }
})();

function injectKatexTitles(container) {
  if (!container || !window.katex) return;
  const svg = container.querySelector("svg");
  if (!svg) return;
  const xhtmlNs = "http://www.w3.org/1999/xhtml";
  const svgNs = "http://www.w3.org/2000/svg";

  // Tear down any WebKit overlay (and its resize observer) left by a prior render.
  if (container.__cicyOverlayRO) { container.__cicyOverlayRO.disconnect(); container.__cicyOverlayRO = null; }
  const staleOverlay = container.querySelector(".cicy-katex-overlay");
  if (staleOverlay) staleOverlay.remove();

  const titles = svg.querySelectorAll("text");
  const webkitSpecs = [];
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
    if (IS_WEBKIT) {
      // WebKit titles are drawn together as one HTML overlay (see below).
      webkitSpecs.push({ textEl, html });
    } else {
      // Every other engine keeps the proven in-SVG path, byte-for-byte unchanged.
      injectKatexTitleSvg(textEl, html, svgNs, xhtmlNs);
      textEl.style.display = "none";
      textEl.setAttribute("aria-hidden", "true");
    }
  });

  if (IS_WEBKIT && webkitSpecs.length) injectKatexTitlesWebkit(container, svg, webkitSpecs);
}

// Blink/Gecko placement (the proven path): a <foreignObject> appended next to
// the Vega title <text>, carrying that text's own `transform` so it lands
// exactly where Vega positioned the title.
function injectKatexTitleSvg(textEl, html, svgNs, xhtmlNs) {
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
}

// WebKit/Safari renders HTML inside an SVG <foreignObject> unreliably: once the
// SVG is CSS-scaled (which makeChartFluid does for responsiveness) it can fail to
// paint the content, or mis-paint it to the SVG origin (WebKit bug 23113). That
// is what made the math axis titles collapse / vanish on Safari. So WebKit draws
// the KaTeX titles as an absolutely-positioned HTML overlay ON TOP of the chart —
// ordinary HTML, which always paints — instead of inside the SVG. Each title
// tracks its Vega placeholder <text>: getScreenCTM gives the anchor, rotation and
// the chart's live scale, so the title sits exactly where the in-SVG title would
// and scales with the chart through every resize, matching the other engines'
// continuous behaviour. A ResizeObserver re-places the overlay on each resize
// (cheap: read CTMs + set styles, no chart re-render).
function injectKatexTitlesWebkit(container, svg, specs) {
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  const overlay = document.createElement("div");
  overlay.className = "cicy-katex-overlay";
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:visible;";
  container.appendChild(overlay);

  specs.forEach(spec => {
    const node = document.createElement("div");
    node.style.cssText =
      "position:absolute;transform-origin:center center;white-space:nowrap;" +
      "color:currentColor;line-height:1;";
    node.innerHTML = spec.html;
    overlay.appendChild(node);
    spec.node = node;
    // Keep the Vega placeholder <text> for geometry (getScreenCTM) but make it
    // invisible and unannounced — do NOT display:none it, that nulls the CTM.
    spec.textEl.style.fill = "transparent";
    spec.textEl.setAttribute("aria-hidden", "true");
  });

  const place = () => {
    const cr = container.getBoundingClientRect();
    specs.forEach(spec => {
      const m = spec.textEl.getScreenCTM();
      if (!m) return;
      const scale = Math.hypot(m.a, m.b) || 1;
      const angle = Math.atan2(m.b, m.a) * 180 / Math.PI; // 0 x-title, -90 y-title
      const s = spec.node.style;
      s.left = (m.e - cr.x) + "px";      // the title anchor, in container space
      s.top = (m.f - cr.y) + "px";
      s.fontSize = (16 * scale) + "px";  // 16px user-space, scaled like the in-SVG path
      s.transform = "translate(-50%,-50%) rotate(" + angle + "deg)";
    });
  };

  place();
  // makeChartFluid() runs right after injectKatexTitles and CSS-scales the SVG;
  // re-place next frame to pick that up, then track every later resize.
  requestAnimationFrame(place);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => place());
    ro.observe(svg);
    container.__cicyOverlayRO = ro;
  }
}

function readThemeConfig() {
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
      titlePadding: 10,
    },
    legend: {
      labelColor: "currentColor",
      titleColor: "currentColor",
      labelFontSize: 13,
      titleFontSize: 13,
      // a narrower gradient + tighter offset returns horizontal room to the
      // plotting area, so dense cell labels stop crowding
      gradientLength: 120,
      gradientThickness: 12,
      offset: 6,
    },
    title: { color: "currentColor", fontSize: 16 },
    range: { heatmap: { scheme: "blues" } },
    mark: { color: accent },
  };
}

function rankH11Spec(rows, config, kindAllowlist, opts = {}) {
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
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    description,
    data: { values: filtered },
    width: "container",
    height: 290,
    // `contains: padding` keeps the right-hand "models" legend inside the
    // container so its title no longer clips; the explicit right padding
    // gives it a little extra breathing room.
    autosize: { type: "fit", contains: "padding" },
    padding: { left: 4, top: 4, right: 14, bottom: 4 },
    transform: [
      { aggregate: [{ op: "sum", field: "count", as: "count" }],
        groupby: ["rank", "h11"] },
    ],
    layer: [
      { mark: { type: "rect", tooltip: true, cursor: "pointer" },
        encoding: {
          x: { field: "h11", type: "ordinal", title: katexTitle("h^{1,1}"),
               scale: { domain: h11sAsc }, axis: { labelAngle: 0 } },
          y: { field: "rank", type: "ordinal", title: katexTitle("\\mathrm{rank}(W)"),
               scale: { domain: ranksDesc } },
          color: heatColor(fullCellMax, opts),
        } },
      { mark: { type: "text", fontSize: 13 },
        encoding: {
          x: { field: "h11", type: "ordinal", scale: { domain: h11sAsc } },
          y: { field: "rank", type: "ordinal", scale: { domain: ranksDesc } },
          text: { field: "count", type: "quantitative" },
          color: heatText(whiteThreshold, opts),
        } },
    ],
    config,
  };
}

function isDark() {
  return document.documentElement.classList.contains("theme--dark");
}

// Theme-aware sequential ramps. Light themes run pale → deep (dense cells go
// dark and pop on the white card, with white text on top). Dark themes run
// deep → bright (dense cells go luminous and pop on the navy card, with dark
// text on top) — this is what stops the densest cells from receding into a
// dark background, the failure mode of a single fixed ramp.
const RAMPS = {
  blue: {
    light: ["#eef4f3", "#cbe1dc", "#9ecabf", "#6ba89e", "#3f8487", "#2f6567", "#214a4c"],
    dark:  ["#1c393b", "#235658", "#2f7376", "#469296", "#69b2b2", "#94d0cd", "#c4e8e3"],
  },
  gold: {
    light: ["#fbf3d6", "#f2dfa0", "#e7c259", "#d79921", "#b07a14", "#8a5f12", "#664710"],
    dark:  ["#3a2e10", "#5a4711", "#856411", "#b6871a", "#dfa828", "#fabd2f", "#ffd569"],
  },
};

function ramp(hue) {
  const set = RAMPS[hue] || RAMPS.blue;
  return isDark() ? set.dark : set.light;
}

// Resolve the heat hue: an explicit `opts.hue` wins; otherwise "gruvbox"
// maps to the blue/teal ramp and anything else to D3 "blues".
function heatHue(opts = {}) {
  return opts.hue || (opts.scheme === "gruvbox" ? "blue" : null);
}

// Shared colour encoding for the count → fill scale.
function heatColor(domainMax, opts = {}) {
  const hue = heatHue(opts);
  const title = opts.title || "models";
  const scale = { type: "log", domain: [1, domainMax] };
  if (hue) scale.range = ramp(hue);
  else scale.scheme = "blues";
  const enc = { field: "count", type: "quantitative", title, scale };
  if (opts.legend === "none") {
    enc.legend = null;
  } else if (opts.legend === "bottom") {
    enc.legend = {
      orient: "bottom",
      direction: "horizontal",
      gradientLength: 180,
      gradientThickness: 10,
      title,
      titleOrient: "left",
    };
  }
  return enc;
}

// In-cell label colour. For a theme-aware gruvbox ramp the dark variant runs
// deep → bright, so the high/low text contrast flips relative to the light
// variant and to D3 "blues" (whose low end is always pale).
function heatText(threshold, opts = {}) {
  const brightHigh = !!heatHue(opts) && isDark();
  return {
    condition: { test: `datum.count > ${threshold}`, value: brightHigh ? "#15212a" : "white" },
    value: brightHigh ? "#e6ecf2" : "black",
  };
}

// Overlay heatmap. Always the full Kähler-favorable distribution; the toggle
// SUPERIMPOSES the infinite-order subset rather than swapping data. In
// "infinite" mode the full map fades to a hint (keeping its TOTAL counts on
// the non-infinite cells) and a gold layer is drawn on top of the cells that
// contain infinite-order groups, showing their INFINITE-only counts on their
// own colour scale. Teal = whole landscape, gold = the infinite subset.
function overlaySpec(rows, config, mode, opts = {}) {
  const fullData = rows.filter(r => r.rank >= 1);
  const cellTotal = new Map();
  const cellInfinite = new Map();
  for (const r of fullData) {
    const key = `${r.rank}|${r.h11}`;
    cellTotal.set(key, (cellTotal.get(key) || 0) + r.count);
    if (r.coxeter_kind === "affine" || r.coxeter_kind === "indefinite") {
      cellInfinite.set(key, (cellInfinite.get(key) || 0) + r.count);
    }
  }
  const fullCellMax = cellTotal.size ? Math.max(...cellTotal.values()) : 1;
  const infMax = cellInfinite.size ? Math.max(...cellInfinite.values()) : 1;
  const ranksDesc = [...new Set(fullData.map(r => r.rank))].sort((a, b) => b - a);
  // Contiguous h¹·¹ axis from 1 (so the empty h¹·¹ = 1 column is shown), up
  // to the largest populated value.
  const maxH11 = Math.max(...fullData.map(r => r.h11));
  const h11Domain = Array.from({ length: maxH11 }, (_, i) => i + 1);
  const infinite = mode === "infinite";

  // Base layer data: every cell, its TOTAL count.
  const baseValues = [];
  for (const [key, count] of cellTotal) {
    const [rank, h11] = key.split("|").map(Number);
    const hasInf = (cellInfinite.get(key) || 0) > 0;
    baseValues.push({
      rank, h11, count, hasInf,
      // Fade the whole map to a hint while highlighting.
      fop: infinite ? 0.16 : 1,
      // In "all" mode show every total; while highlighting keep totals only
      // on the FADED (non-infinite) cells — the gold layer overwrites the
      // active cells with their infinite counts.
      top: infinite ? (hasInf ? 0 : 1) : 1,
    });
  }

  // Gold layer data: only the infinite cells, their INFINITE-only count.
  const infValues = [];
  for (const [key, count] of cellInfinite) {
    const [rank, h11] = key.split("|").map(Number);
    infValues.push({ rank, h11, count, inf: true });
  }

  const baseColorOpts = { scheme: opts.scheme, legend: infinite ? "none" : opts.legend, title: "models" };
  // Gold legend matches the base legend exactly — same title and (below) the
  // same 1..fullCellMax domain — so toggling only swaps the gradient's hue
  // instead of making the scale bar jump.
  const goldColorOpts = { hue: "gold", legend: infinite ? opts.legend : "none", title: "models" };
  const baseThreshold = Math.max(1, fullCellMax * 0.4);
  const goldThreshold = Math.max(1, infMax * 0.4);
  const goldRing = isDark() ? "#ffd569" : "#9c6b08";
  // Faded base cells read as ~background, so their hint numbers want a muted
  // foreground colour, not the on-cell white/black of a solid heatmap.
  const hintColor = isDark() ? "#b3bfca" : "#586471";

  const x = (extra) => ({ field: "h11", type: "ordinal", scale: { domain: h11Domain }, ...(extra || {}) });
  const y = (extra) => ({ field: "rank", type: "ordinal", scale: { domain: ranksDesc }, ...(extra || {}) });

  const layers = [
    // Base fills (full map; faded while highlighting).
    { mark: { type: "rect", tooltip: true, cursor: "pointer" },
      encoding: {
        x: x({ title: katexTitle("h^{1,1}"), axis: { labelAngle: 0 } }),
        y: y({ title: katexTitle("\\mathrm{rank}(W)") }),
        color: heatColor(fullCellMax, baseColorOpts),
        fillOpacity: { field: "fop", type: "quantitative", scale: null, legend: null },
        tooltip: [
          { field: "rank", type: "ordinal", title: "rank(W)" },
          { field: "h11", type: "ordinal", title: "h¹¹" },
          { field: "count", type: "quantitative", title: "models" },
        ],
      } },
    // Base totals.
    { mark: { type: "text", fontSize: 13 },
      encoding: {
        x: x(), y: y(),
        text: { field: "count", type: "quantitative" },
        opacity: { field: "top", type: "quantitative", scale: null, legend: null },
        color: infinite ? { value: hintColor } : heatText(baseThreshold, baseColorOpts),
      } },
  ];

  if (infinite) {
    layers.push(
      // Gold infinite fills, ringed, on top.
      { data: { values: infValues },
        mark: { type: "rect", tooltip: true, cursor: "pointer", stroke: goldRing, strokeWidth: 2, strokeOpacity: 0.9 },
        encoding: {
          x: x(), y: y(),
          // Same domain as the base scale (1..fullCellMax) so the legend bar
          // is identical to "All groups" — only the gradient hue changes.
          color: heatColor(fullCellMax, goldColorOpts),
          tooltip: [
            { field: "rank", type: "ordinal", title: "rank(W)" },
            { field: "h11", type: "ordinal", title: "h¹¹" },
            { field: "count", type: "quantitative", title: "infinite group models" },
          ],
        } },
      // Gold infinite counts.
      { data: { values: infValues },
        mark: { type: "text", fontSize: 13 },
        encoding: {
          x: x(), y: y(),
          text: { field: "count", type: "quantitative" },
          color: heatText(goldThreshold, goldColorOpts),
        } },
    );
  }

  // Aspect: fixed square cells (band step on both axes) vs. fill-the-card
  // width at an explicit height.
  const sized = opts.cell
    ? { width: { step: opts.cell }, height: { step: opts.cell } }
    : { width: "container", height: opts.height || 290, autosize: { type: "fit", contains: "padding" } };

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    description:
      "Rank(W) × h¹·¹ heatmap. The toggle superimposes the infinite-order (affine + indefinite) subset — its own counts in gold — over the faded full Kähler-favorable distribution.",
    data: { values: baseValues },
    ...sized,
    padding: { left: 4, top: 4, right: 14, bottom: 4 },
    resolve: { scale: { color: "independent" } },
    layer: layers,
    config,
  };
}
