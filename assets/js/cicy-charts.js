import embed from "https://cdn.jsdelivr.net/npm/vega-embed@6/+esm";

const dataEl = document.getElementById("cicy-chart-data");
if (dataEl) {
  try {
    const data = JSON.parse(dataEl.textContent);
    const theme = readThemeConfig();
    await Promise.all([
      renderHodge(data.hodge_scatter, theme),
      renderRankH11(data.rank_h11_table, theme),
      renderCoxeterSummary(data.coxeter_summary_bar, theme),
      renderPairM(data.pair_m_bar, theme),
    ]);
  } catch (err) {
    console.error("cicy-charts: failed to render", err);
  }
}

function readThemeConfig() {
  const s = getComputedStyle(document.documentElement);
  const fg = s.getPropertyValue("--cicy-chart-fg").trim() || "currentColor";
  const grid = s.getPropertyValue("--cicy-chart-grid").trim() || "rgba(128,128,128,0.25)";
  const accent = s.getPropertyValue("--cicy-chart-accent").trim() || "#4a7bd6";
  const bg = s.getPropertyValue("--cicy-chart-bg").trim() || "transparent";
  return {
    background: bg,
    view: { stroke: null },
    axis: {
      labelColor: fg,
      titleColor: fg,
      domainColor: fg,
      tickColor: fg,
      gridColor: grid,
      labelFontSize: 11,
      titleFontSize: 12,
    },
    legend: { labelColor: fg, titleColor: fg, labelFontSize: 11, titleFontSize: 12 },
    title: { color: fg, fontSize: 13 },
    range: { heatmap: { scheme: "blues" } },
    mark: { color: accent },
  };
}

const embedOpts = { actions: false, renderer: "svg" };

async function renderHodge(rows, config) {
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Hodge numbers of all 7890 CICYs.",
    data: { values: rows },
    width: "container",
    height: 240,
    mark: { type: "circle", opacity: 0.75 },
    encoding: {
      x: { field: "h11", type: "quantitative", title: "h^{1,1}", scale: { nice: true } },
      y: { field: "h21", type: "quantitative", title: "h^{2,1}", scale: { nice: true } },
      size: { field: "count", type: "quantitative", title: "count", scale: { range: [16, 320] } },
      tooltip: [
        { field: "h11", type: "quantitative", title: "h^{1,1}" },
        { field: "h21", type: "quantitative", title: "h^{2,1}" },
        { field: "count", type: "quantitative", title: "CICYs" },
        { field: "kahler_fav", type: "quantitative", title: "Kähler-fav." },
      ],
    },
    config,
  };
  await embed("#cicy-chart-hodge", spec, embedOpts);
}

async function renderRankH11(rows, config) {
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Rank(W) × h^{1,1} heatmap (paper Table 3.1).",
    data: { values: rows.filter(r => r.rank >= 1) },
    width: "container",
    height: 240,
    transform: [
      { aggregate: [{ op: "sum", field: "count", as: "count" }], groupby: ["rank", "h11"] },
    ],
    layer: [
      {
        mark: { type: "rect", tooltip: true },
        encoding: {
          x: { field: "h11", type: "ordinal", title: "h^{1,1}" },
          y: { field: "rank", type: "ordinal", title: "rank(W)", sort: "descending" },
          color: {
            field: "count",
            type: "quantitative",
            title: "models",
            scale: { scheme: "blues", type: "log" },
          },
        },
      },
      {
        mark: { type: "text", fontSize: 10 },
        encoding: {
          x: { field: "h11", type: "ordinal" },
          y: { field: "rank", type: "ordinal", sort: "descending" },
          text: { field: "count", type: "quantitative" },
          color: {
            condition: { test: "datum.count > 100", value: "white" },
            value: "inherit",
          },
        },
      },
    ],
    config,
  };
  await embed("#cicy-chart-rank-h11", spec, embedOpts);
}

async function renderCoxeterSummary(rows, config) {
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Kähler-favourable CICYs by Coxeter summary.",
    data: { values: rows.map(r => ({ ...r, summary: r.summary === "" ? "(none)" : r.summary })) },
    width: "container",
    height: 240,
    mark: { type: "bar", tooltip: true },
    encoding: {
      y: {
        field: "summary",
        type: "nominal",
        title: "Coxeter summary",
        sort: { field: "count", order: "descending" },
      },
      x: { field: "count", type: "quantitative", title: "models" },
    },
    config,
  };
  await embed("#cicy-chart-coxeter", spec, embedOpts);
}

async function renderPairM(rows, config) {
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Edge-label distribution across iso-flop-wall pairs.",
    data: { values: rows },
    width: "container",
    height: 240,
    mark: { type: "bar", tooltip: true },
    encoding: {
      x: {
        field: "m",
        type: "nominal",
        title: "edge label m_{ij}",
        sort: ["2", "3", "4", "P", "H"],
      },
      y: { field: "count", type: "quantitative", title: "pairs" },
    },
    config,
  };
  await embed("#cicy-chart-pairs", spec, embedOpts);
}
