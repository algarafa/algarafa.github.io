const CHART_IDS = ["cicy-chart-hodge", "cicy-chart-rank-h11", "cicy-chart-rank-h11-infinite", "cicy-chart-coxeter", "cicy-chart-pairs"];

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

  await runRender("cicy-chart-hodge",               () => hodgeSpec(data.hodge_scatter, theme),                     embed, embedOpts);
  await runRender("cicy-chart-rank-h11",            () => rankH11Spec(data.rank_h11_table, theme, null),            embed, embedOpts);
  await runRender("cicy-chart-rank-h11-infinite",   () => rankH11Spec(data.rank_h11_table, theme, ["affine","indefinite"]), embed, embedOpts);
  await runRender("cicy-chart-coxeter",             () => coxeterSpec(data.coxeter_summary_bar, theme),             embed, embedOpts);
  await runRender("cicy-chart-pairs",               () => pairMSpec(data.pair_m_bar, theme),                        embed, embedOpts);
})();

async function runRender(targetId, specFn, embed, opts) {
  try {
    const spec = specFn();
    await embed("#" + targetId, spec, opts);
  } catch (err) {
    console.error("cicy-charts: render failed for " + targetId, err);
    showError(targetId, "Render failed: " + (err.message || err));
  }
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
    mark: { type: "circle", opacity: 0.75 },
    encoding: {
      x: { field: "h11", type: "quantitative", title: "h¹·¹" },
      y: { field: "h21", type: "quantitative", title: "h²·¹" },
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
  let filtered = rows.filter(r => r.rank >= 1);
  if (kindAllowlist) {
    filtered = filtered.filter(r => kindAllowlist.includes(r.coxeter_kind));
  }
  const description = kindAllowlist
    ? "Rank(W) × h¹·¹ heatmap restricted to infinite (affine + indefinite) Coxeter groups."
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
      { mark: { type: "rect", tooltip: true },
        encoding: {
          x: { field: "h11", type: "ordinal", title: "h¹·¹" },
          y: { field: "rank", type: "ordinal", title: "rank(W)",
               sort: "descending" },
          color: { field: "count", type: "quantitative", title: "models",
                   scale: { scheme: "blues", type: "log" } },
        } },
      { mark: { type: "text", fontSize: 16 },
        encoding: {
          x: { field: "h11", type: "ordinal" },
          y: { field: "rank", type: "ordinal", sort: "descending" },
          text: { field: "count", type: "quantitative" },
          color: { condition: { test: "datum.count > 100", value: "white" },
                   value: "black" },
        } },
    ],
    config,
  };
}

function coxeterSpec(rows, config) {
  const labelled = rows.map(r => ({ ...r, summary: r.summary === "" ? "(none)" : r.summary }));
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Kähler-favorable CICYs by Coxeter summary.",
    data: { values: labelled },
    width: "container",
    height: 260,
    mark: { type: "bar", tooltip: true },
    encoding: {
      y: { field: "summary", type: "nominal", title: "Coxeter summary",
           sort: { field: "count", order: "descending" } },
      x: { field: "count", type: "quantitative", title: "models" },
    },
    config,
  };
}

function pairMSpec(rows, config) {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Edge-label distribution across iso-flop-wall pairs.",
    data: { values: rows },
    width: "container",
    height: 260,
    mark: { type: "bar", tooltip: true },
    encoding: {
      x: { field: "m", type: "nominal", title: "edge label mᵢⱼ",
           sort: ["2", "3", "4", "P", "H"] },
      y: { field: "count", type: "quantitative", title: "pairs" },
    },
    config,
  };
}
