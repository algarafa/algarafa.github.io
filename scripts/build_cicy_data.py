#!/usr/bin/env python
"""Build CICY Coxeter database artefacts for the Hugo site.

Deterministic extraction from `static/cicy-coxeter/CICY-Coxeter-Database.txt`
producing:

    static/cicy-coxeter/cicy-coxeter.parquet      (one row per CICY)
    static/cicy-coxeter/cicy-coxeter.schema.json  (column descriptions)
    content/english/cicy-coxeter/<Num>.md         (7890 per-entry stubs)

The parser handles the Mathematica-style value syntax used in the .txt file:
nested `{...}` lists, booleans, integers, and the literals `NonKahlerPos`,
`P`, and `H`. All output is a pure function of the input bytes; repeated runs
are byte-identical.

Modes:
    (no flag)            regenerate all outputs
    --check              regenerate to a temp dir and diff against what is
                         currently on disk; exit 1 on mismatch
    --sample N --seed S  write scripts/.sample-runs/extraction_sample.md
                         containing N random records, source vs parsed,
                         side by side for manual review
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import random
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SOURCE_TXT = ROOT / "static" / "cicy-coxeter" / "CICY-Coxeter-Database.txt"
PARQUET_OUT = ROOT / "static" / "cicy-coxeter" / "cicy-coxeter.parquet"
SCHEMA_OUT = ROOT / "static" / "cicy-coxeter" / "cicy-coxeter.schema.json"
ENGLISH_CONTENT_DIR = ROOT / "content" / "english" / "cicy-coxeter"
GALLERY_OUT = ROOT / "data" / "cicy_coxeter" / "diagram_gallery.json"
CHART_DATA_OUT = ROOT / "data" / "cicy_coxeter" / "chart_data.json"
SAMPLE_DIR = ROOT / "scripts" / ".sample-runs"

EXPECTED_KEYS = (
    "Num",
    "H11",
    "H21",
    "C2",
    "Conf",
    "Favour",
    "KahlerPos",
    "IsProduct",
    "IsoFlopRows",
    "KahlerRefGens",
    "CoxeterMat",
)

NON_KAHLER_POS = "NonKahlerPos"

_SYMBOL_P = re.compile(r"\bP\b")
_SYMBOL_H = re.compile(r"\bH\b")
_INT_LITERAL = re.compile(r"-?\d+")


def parse_value(field: str, raw: str) -> Any:
    raw = raw.strip()
    if raw == NON_KAHLER_POS:
        return None
    if raw == "True":
        return True
    if raw == "False":
        return False
    if _INT_LITERAL.fullmatch(raw):
        return int(raw)
    transformed = raw.replace("{", "[").replace("}", "]")
    if field == "CoxeterMat":
        transformed = _SYMBOL_P.sub('"P"', transformed)
        transformed = _SYMBOL_H.sub('"H"', transformed)
    return ast.literal_eval(transformed)


@dataclass
class Record:
    Num: int
    H11: int
    H21: int
    C2: list[int]
    Conf: list[list[int]]
    Favour: bool
    KahlerPos: bool
    IsProduct: bool
    IsoFlopRows: list[dict] | None
    KahlerRefGens: list[list[list[int]]] | None
    CoxeterMat: list[list[str]] | None

    @property
    def iso_flop_rank(self) -> int | None:
        if self.IsoFlopRows is None:
            return None
        return len(self.IsoFlopRows)

    @property
    def coxeter_summary(self) -> str:
        if self.CoxeterMat is None:
            return NON_KAHLER_POS
        if not self.CoxeterMat:
            return ""
        rank = len(self.CoxeterMat)
        if rank == 1:
            return "Z2"
        if rank == 2:
            off = self.CoxeterMat[0][1]
            return f"I2({off})"
        return f"rank{rank}"


def parse_records(text: str) -> list[Record]:
    blocks = [b for b in text.split("\n\n") if b.strip()]
    records: list[Record] = []
    for block in blocks:
        fields: dict[str, Any] = {}
        for line in block.splitlines():
            if not line.strip():
                continue
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()
            if key not in EXPECTED_KEYS:
                raise ValueError(f"Unexpected key {key!r} in block:\n{block}")
            parsed = parse_value(key, value)
            if key == "IsoFlopRows" and parsed is not None:
                parsed = [{"row": r, "type": t} for r, t in parsed]
            if key == "CoxeterMat" and parsed is not None:
                parsed = [[str(x) for x in row] for row in parsed]
            fields[key] = parsed
        missing = set(EXPECTED_KEYS) - fields.keys()
        if missing:
            raise ValueError(f"Missing keys {missing} in block:\n{block}")
        records.append(Record(**fields))
    return records


def validate(records: list[Record]) -> None:
    if len(records) != 7890:
        raise ValueError(f"Expected 7890 records, got {len(records)}")
    nums = [r.Num for r in records]
    if nums != list(range(1, 7891)):
        raise ValueError("Num is not the contiguous sequence 1..7890")
    kahler_count = sum(1 for r in records if r.KahlerPos)
    if kahler_count != 4874:
        raise ValueError(
            f"Expected 4874 Kahler-favourable CICYs, got {kahler_count}"
        )
    for r in records:
        if r.KahlerPos:
            for fld_name, fld in (
                ("IsoFlopRows", r.IsoFlopRows),
                ("KahlerRefGens", r.KahlerRefGens),
                ("CoxeterMat", r.CoxeterMat),
            ):
                if fld is None:
                    raise ValueError(
                        f"CICY #{r.Num}: {fld_name} is NonKahlerPos but "
                        "KahlerPos=True"
                    )
        else:
            for fld_name, fld in (
                ("IsoFlopRows", r.IsoFlopRows),
                ("KahlerRefGens", r.KahlerRefGens),
                ("CoxeterMat", r.CoxeterMat),
            ):
                if fld is not None:
                    raise ValueError(
                        f"CICY #{r.Num}: {fld_name} populated but "
                        "KahlerPos=False"
                    )


def write_parquet(records: list[Record], out_path: Path) -> None:
    import duckdb

    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE cicy (
            Num INTEGER,
            H11 INTEGER,
            H21 INTEGER,
            C2 INTEGER[],
            Conf INTEGER[][],
            Favour BOOLEAN,
            KahlerPos BOOLEAN,
            IsProduct BOOLEAN,
            IsoFlopRows STRUCT(row INTEGER, type VARCHAR)[],
            KahlerRefGens INTEGER[][][],
            CoxeterMat VARCHAR[][],
            IsoFlopRank INTEGER,
            CoxeterSummary VARCHAR
        )
        """
    )
    rows = [
        (
            r.Num,
            r.H11,
            r.H21,
            r.C2,
            r.Conf,
            r.Favour,
            r.KahlerPos,
            r.IsProduct,
            r.IsoFlopRows,
            r.KahlerRefGens,
            r.CoxeterMat,
            r.iso_flop_rank,
            r.coxeter_summary,
        )
        for r in records
    ]
    con.executemany(
        "INSERT INTO cicy VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    con.execute(
        f"COPY cicy TO '{tmp.as_posix()}' "
        "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 4096)"
    )
    con.close()
    tmp.replace(out_path)


SCHEMA = {
    "columns": [
        {"name": "Num", "type": "INTEGER", "description": "CICY index, 1..7890."},
        {"name": "H11", "type": "INTEGER", "description": "Hodge number h^{1,1}."},
        {"name": "H21", "type": "INTEGER", "description": "Hodge number h^{2,1}."},
        {"name": "C2", "type": "INTEGER[]", "description": "c2(X).D_i in the favourable basis."},
        {"name": "Conf", "type": "INTEGER[][]", "description": "Configuration matrix in the favourable presentation."},
        {"name": "Favour", "type": "BOOLEAN", "description": "Favourable (projective-product) presentation exists."},
        {"name": "KahlerPos", "type": "BOOLEAN", "description": "Kahler-favourable."},
        {"name": "IsProduct", "type": "BOOLEAN", "description": "Direct product of lower-dim Calabi-Yaus."},
        {"name": "IsoFlopRows", "type": "STRUCT(row INTEGER, type VARCHAR)[]", "description": "Config-matrix rows yielding iso-flop walls; NULL when non-Kahler-pos."},
        {"name": "KahlerRefGens", "type": "INTEGER[][][]", "description": "Simple reflections in the Kahler representation; NULL when non-Kahler-pos."},
        {"name": "CoxeterMat", "type": "VARCHAR[][]", "description": "Coxeter matrix entries as strings; \"P\"/\"H\" denote infinite orders; NULL when non-Kahler-pos."},
        {"name": "IsoFlopRank", "type": "INTEGER", "description": "Derived: len(IsoFlopRows); NULL when non-Kahler-pos."},
        {"name": "CoxeterSummary", "type": "VARCHAR", "description": "Derived one-liner (\"Z2\", \"I2(H)\", \"NonKahlerPos\", \"\" for empty, etc.)."},
    ],
    "row_count": 7890,
    "kahler_favourable_count": 4874,
}


def write_schema(out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(SCHEMA, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def build_diagram_gallery(records: list[Record]) -> dict:
    """Deduplicate CoxeterMat shapes across all Kahler-favourable CICYs and
    return a grouped-by-rank gallery ready to be rendered on the landing page."""
    from collections import defaultdict

    counts: dict[tuple, dict] = {}
    for r in records:
        if not r.KahlerPos or r.CoxeterMat is None or not r.CoxeterMat:
            continue
        rank = len(r.CoxeterMat)
        key = tuple(tuple(row) for row in r.CoxeterMat)
        if key not in counts:
            counts[key] = {
                "rank": rank,
                "mat": [list(row) for row in key],
                "count": 0,
                "example_num": r.Num,
            }
        counts[key]["count"] += 1
        if r.Num < counts[key]["example_num"]:
            counts[key]["example_num"] = r.Num

    by_rank: dict[int, list] = defaultdict(list)
    for key, info in counts.items():
        info["svg"] = coxeter_diagram_svg(info["mat"], info["example_num"])
        info["latex"] = latex_coxeter_matrix(info["mat"]) if info["mat"] else ""
        by_rank[info["rank"]].append(info)

    groups = []
    for rank in sorted(by_rank.keys()):
        shapes = sorted(by_rank[rank], key=lambda x: (-x["count"], x["example_num"]))
        groups.append({"rank": rank, "shapes": shapes})
    total_shapes = sum(len(g["shapes"]) for g in groups)
    return {
        "groups": groups,
        "total_shapes": total_shapes,
        "total_models": sum(s["count"] for g in groups for s in g["shapes"]),
    }


def write_gallery(records: list[Record], out_path: Path) -> None:
    gallery = build_diagram_gallery(records)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(gallery, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


_PAIR_M_ORDER = {"2": 0, "3": 1, "4": 2, "P": 3, "H": 4}


def _classify_coxeter_kind(mat: list[list[str]]) -> str:
    """Paper §3 classification of a Coxeter diagram into finite / affine /
    indefinite. Returns '' for empty (rank-0) input."""
    if not mat:
        return ""
    offs = set()
    for i in range(len(mat)):
        for j in range(i + 1, len(mat)):
            offs.add(mat[i][j])
    offs.discard("2")
    if "H" in offs:
        return "indefinite"
    if "P" in offs:
        return "affine"
    return "finite"


def build_chart_data(records: list[Record]) -> dict:
    """Aggregate the four Explorer-landing charts into one JSON blob."""
    from collections import Counter

    hodge = Counter()
    hodge_kahler = Counter()
    rank_h11 = Counter()
    summary_bar = Counter()
    pair_m = Counter()

    for r in records:
        hodge[(r.H11, r.H21)] += 1
        if not r.KahlerPos:
            continue
        hodge_kahler[(r.H11, r.H21)] += 1
        mat = r.CoxeterMat or []
        rank = len(mat)
        kind = _classify_coxeter_kind(mat)
        rank_h11[(rank, r.H11, kind)] += 1
        summary_bar[r.coxeter_summary] += 1
        if mat:
            for i in range(rank):
                for j in range(i + 1, rank):
                    pair_m[mat[i][j]] += 1

    hodge_scatter = [
        {
            "h11": h11,
            "h21": h21,
            "count": c,
            "kahler_fav": hodge_kahler[(h11, h21)],
        }
        for (h11, h21), c in sorted(hodge.items())
    ]
    rank_h11_table = [
        {"rank": rank, "h11": h11, "coxeter_kind": kind, "count": c}
        for (rank, h11, kind), c in sorted(rank_h11.items())
    ]
    coxeter_summary_bar = [
        {"summary": s, "count": c}
        for s, c in sorted(summary_bar.items(), key=lambda x: (-x[1], x[0]))
    ]
    pair_m_bar = [
        {"m": m, "count": c}
        for m, c in sorted(
            pair_m.items(), key=lambda x: _PAIR_M_ORDER.get(x[0], 999)
        )
    ]
    return {
        "hodge_scatter": hodge_scatter,
        "rank_h11_table": rank_h11_table,
        "coxeter_summary_bar": coxeter_summary_bar,
        "pair_m_bar": pair_m_bar,
    }


def write_chart_data(records: list[Record], out_path: Path) -> None:
    data = build_chart_data(records)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def latex_pmatrix(rows: list[list[int]]) -> str:
    body = " \\\\\n".join(" & ".join(str(v) for v in row) for row in rows)
    return "\\begin{pmatrix}\n" + body + "\n\\end{pmatrix}"


def latex_row_vector(values: list[int]) -> str:
    body = " & ".join(str(v) for v in values)
    return "\\begin{pmatrix} " + body + " \\end{pmatrix}"


def latex_coxeter_matrix(mat: list[list[str]]) -> str:
    def cell(v: str) -> str:
        return f"\\text{{{v}}}" if v in ("P", "H") else v
    body = " \\\\\n".join(" & ".join(cell(v) for v in row) for row in mat)
    return "\\begin{pmatrix}\n" + body + "\n\\end{pmatrix}"


def _svg_coord(v: float) -> str:
    return f"{v:.1f}" if abs(v - round(v)) > 1e-9 else f"{int(round(v))}"


def coxeter_diagram_svg(mat: list[list[str]], num: int) -> str:
    """Render a Coxeter diagram as inline SVG. Standard conventions:
    no edge for m=2; unlabeled edge for m=3; label `m` for finite m>=4;
    label `P` or `H` literally for infinite orders (per paper §3)."""
    rank = len(mat)
    if rank == 1:
        w, h = 24, 24
        node_r = 4
        cx, cy = w / 2, h / 2
        body = f'<circle cx="{_svg_coord(cx)}" cy="{_svg_coord(cy)}" r="{node_r}" fill="currentColor"/>'
        return (
            f'<svg class="cicy-entry__diagram" viewBox="0 0 {w} {h}" '
            f'xmlns="http://www.w3.org/2000/svg" role="img" '
            f'aria-label="Coxeter diagram for CICY {num}: rank 1 (single node)">'
            f"{body}</svg>"
        )

    node_r = 4
    if rank == 2:
        w, h = 140, 40
        nodes = [(24.0, h / 2), (w - 24.0, h / 2)]
        label_offset = (0.0, -10.0)
    else:
        w = h = 140.0
        center = (w / 2, h / 2)
        radius = min(w, h) / 2 - 24
        nodes = []
        for i in range(rank):
            theta = 2 * math.pi * i / rank - math.pi / 2
            nodes.append(
                (center[0] + radius * math.cos(theta),
                 center[1] + radius * math.sin(theta))
            )
        label_offset = None

    parts: list[str] = []
    for i in range(rank):
        for j in range(i + 1, rank):
            m = mat[i][j]
            if m == "2":
                continue
            x1, y1 = nodes[i]
            x2, y2 = nodes[j]
            parts.append(
                f'<line x1="{_svg_coord(x1)}" y1="{_svg_coord(y1)}" '
                f'x2="{_svg_coord(x2)}" y2="{_svg_coord(y2)}" '
                'stroke="currentColor" stroke-width="1.2"/>'
            )
            if m == "3":
                continue
            mx = (x1 + x2) / 2
            my = (y1 + y2) / 2
            if rank == 2:
                tx = mx + label_offset[0]
                ty = my + label_offset[1]
            else:
                dx = mx - center[0]
                dy = my - center[1]
                dist = math.hypot(dx, dy) or 1.0
                tx = mx + 10 * dx / dist
                ty = my + 10 * dy / dist
            parts.append(
                f'<text x="{_svg_coord(tx)}" y="{_svg_coord(ty)}" '
                'text-anchor="middle" dominant-baseline="central" '
                'font-family="serif" font-style="italic" font-size="11" '
                f'fill="currentColor">{m}</text>'
            )
    for cx, cy in nodes:
        parts.append(
            f'<circle cx="{_svg_coord(cx)}" cy="{_svg_coord(cy)}" '
            f'r="{node_r}" fill="currentColor"/>'
        )
    width = _svg_coord(w)
    height = _svg_coord(h)
    return (
        f'<svg class="cicy-entry__diagram" viewBox="0 0 {width} {height}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img" '
        f'aria-label="Coxeter diagram for CICY {num}: rank {rank}">'
        + "".join(parts)
        + "</svg>"
    )


def latex_configuration_matrix(conf: list[list[int]], h11: int, h21: int, num: int) -> str:
    """Paper-style augmented CICY configuration matrix with P^{n_i} prefix,
    Hodge-number superscript, and Euler-characteristic subscript."""
    num_cols = len(conf[0])
    col_spec = "c|" + "c" * num_cols
    chi = 2 * (h11 - h21)
    body_lines = []
    for row in conf:
        n = sum(row) - 1
        cells = [f"\\mathbb{{P}}^{{{n}}}"] + [str(v) for v in row]
        body_lines.append(" & ".join(cells))
    body = " \\\\\n".join(body_lines)
    return (
        f"X_{{{num}}} = \\left[\\begin{{array}}{{{col_spec}}}\n"
        + body
        + "\n\\end{array}\\right]^{"
        + f"{h11},{h21}"
        + "}_{"
        + f"{chi}"
        + "}"
    )


def serialise_field(field: str, value: Any) -> str:
    """Round-trip a parsed value back into the source .txt layout for review."""
    if value is None:
        return NON_KAHLER_POS
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, int):
        return str(value)
    if field == "IsoFlopRows":
        if not value:
            return "{}"
        parts = [f'{{{item["row"]}, "{item["type"]}"}}' for item in value]
        return "{" + ", ".join(parts) + "}"
    if field == "CoxeterMat":
        if not value:
            return "{}"
        def cell(v: str) -> str:
            return v if v in ("P", "H") else v
        rows = [
            "{" + ", ".join(cell(c) for c in row) + "}" for row in value
        ]
        return "{" + ", ".join(rows) + "}"
    return _mma_list(value)


def _mma_list(value: Any) -> str:
    if isinstance(value, list):
        return "{" + ", ".join(_mma_list(v) for v in value) + "}"
    return str(value)


def _matrix_shortcode(latex: str) -> list[str]:
    return ["{{< matrix >}}", latex, "{{< /matrix >}}", ""]


def _iso_flop_reflections_section(r: Record) -> list[str]:
    lines: list[str] = ["## Iso-flop reflections", ""]
    for idx, (mat, iso) in enumerate(zip(r.KahlerRefGens, r.IsoFlopRows), start=1):
        lines.append(
            f"**Generator {idx}** — iso-flop row {iso['row']}, {iso['type']}:"
        )
        lines.append("")
        lines.extend(_matrix_shortcode(f"M_{idx} = {latex_pmatrix(mat)}"))
    return lines


def _coxeter_diagram_section(r: Record) -> list[str]:
    svg = coxeter_diagram_svg(r.CoxeterMat, r.Num)
    return [
        "## Coxeter diagram",
        "",
        f'<div class="cicy-entry__diagram-wrap">{svg}</div>',
        "",
    ]


def _coxeter_matrix_section(r: Record) -> list[str]:
    lines: list[str] = ["## Coxeter matrix", ""]
    lines.extend(_matrix_shortcode(latex_coxeter_matrix(r.CoxeterMat)))
    flat = [v for row in r.CoxeterMat for v in row]
    if "P" in flat or "H" in flat:
        lines.append(
            "Entries `P` and `H` both denote order \u221e; the distinction is "
            "parabolic vs hyperbolic (see \u00a74.1 of the paper)."
        )
        lines.append("")
    return lines


def render_markdown_stub(r: Record) -> str:
    lines: list[str] = []
    lines.append("+++")
    lines.append(f'title = "CICY #{r.Num}"')
    lines.append(f"num = {r.Num}")
    lines.append(f"h11 = {r.H11}")
    lines.append(f"h21 = {r.H21}")
    lines.append("+++")
    lines.append("")
    lines.append(f"**CICY number:** {r.Num}")
    lines.append("")
    lines.append(f"- Hodge numbers: \\\\(h^{{1,1}} = {r.H11}\\\\), \\\\(h^{{2,1}} = {r.H21}\\\\)")
    lines.append(f"- Favourable presentation: `{r.Favour}`")
    lines.append(f"- Kahler-favourable: `{r.KahlerPos}`")
    lines.append(f"- Direct product: `{r.IsProduct}`")
    lines.append("")

    lines.append("## Second Chern class")
    lines.append("")
    lines.append("Intersections \\\\(c_2(X)\\cdot D_i\\\\) in the favourable divisor basis:")
    lines.append("")
    lines.extend(_matrix_shortcode(
        f"c_2(X)\\cdot D_i = {latex_row_vector(r.C2)}"
    ))

    lines.append("## Configuration matrix")
    lines.append("")
    lines.append(
        "Rows are ordered as in the source database (the i-th ambient factor "
        "\\\\(\\mathbb{P}^{n_i}\\\\) has \\\\(n_i = \\sum_j q_{ij} - 1\\\\)). "
        "Top-right superscript is \\\\((h^{1,1}, h^{2,1})\\\\); "
        "bottom-right subscript is the Euler characteristic "
        "\\\\(\\chi = 2(h^{1,1} - h^{2,1})\\\\)."
    )
    lines.append("")
    lines.extend(_matrix_shortcode(
        latex_configuration_matrix(r.Conf, r.H11, r.H21, r.Num)
    ))

    if r.KahlerPos:
        if r.KahlerRefGens:
            lines.extend(_iso_flop_reflections_section(r))
        else:
            lines.append("## Iso-flop reflections")
            lines.append("")
            lines.append("_No iso-flop walls; the Coxeter group is trivial._")
            lines.append("")

        if r.CoxeterMat:
            lines.extend(_coxeter_diagram_section(r))
            lines.extend(_coxeter_matrix_section(r))

    lines.append("## Database record")
    lines.append("")
    lines.append("```")
    lines.append(f"Num           : {r.Num}")
    lines.append(f"H11           : {r.H11}")
    lines.append(f"H21           : {r.H21}")
    lines.append(f"C2            : {serialise_field('C2', r.C2)}")
    lines.append(f"Conf          : {serialise_field('Conf', r.Conf)}")
    lines.append(f"Favour        : {serialise_field('Favour', r.Favour)}")
    lines.append(f"KahlerPos     : {serialise_field('KahlerPos', r.KahlerPos)}")
    lines.append(f"IsProduct     : {serialise_field('IsProduct', r.IsProduct)}")
    lines.append(f"IsoFlopRows   : {serialise_field('IsoFlopRows', r.IsoFlopRows)}")
    lines.append(f"KahlerRefGens : {serialise_field('KahlerRefGens', r.KahlerRefGens)}")
    lines.append(f"CoxeterMat    : {serialise_field('CoxeterMat', r.CoxeterMat)}")
    lines.append("```")
    lines.append("")
    lines.append(
        "[Back to the CICY Coxeter Database explorer](/cicy-coxeter/)."
    )
    lines.append("")
    return "\n".join(lines)


def write_markdown_stubs(records: list[Record], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in out_dir.glob("*.md") if p.name != "_index.md"}
    written: set[str] = set()
    for r in records:
        target = out_dir / f"{r.Num}.md"
        target.write_text(render_markdown_stub(r), encoding="utf-8", newline="\n")
        written.add(target.name)
    for stale in existing - written:
        (out_dir / stale).unlink()


def extract_source_block(text: str, num: int) -> str:
    marker = f"Num           : {num}\n"
    idx = text.find(marker)
    if idx == -1:
        raise KeyError(f"Num {num} not found in source")
    end = text.find("\n\n", idx)
    if end == -1:
        end = len(text)
    return text[idx:end].rstrip() + "\n"


def render_parsed_block(r: Record) -> str:
    return (
        f"Num           : {r.Num}\n"
        f"H11           : {r.H11}\n"
        f"H21           : {r.H21}\n"
        f"C2            : {serialise_field('C2', r.C2)}\n"
        f"Conf          : {serialise_field('Conf', r.Conf)}\n"
        f"Favour        : {serialise_field('Favour', r.Favour)}\n"
        f"KahlerPos     : {serialise_field('KahlerPos', r.KahlerPos)}\n"
        f"IsProduct     : {serialise_field('IsProduct', r.IsProduct)}\n"
        f"IsoFlopRows   : {serialise_field('IsoFlopRows', r.IsoFlopRows)}\n"
        f"KahlerRefGens : {serialise_field('KahlerRefGens', r.KahlerRefGens)}\n"
        f"CoxeterMat    : {serialise_field('CoxeterMat', r.CoxeterMat)}\n"
    )


def write_sample(
    records: list[Record], text: str, n: int, seed: int, include: list[int] | None = None
) -> Path:
    rng = random.Random(seed)
    include_set = set(include or [])
    remaining = n - len(include_set)
    candidates = [i for i in range(1, 7891) if i not in include_set]
    random_nums = rng.sample(candidates, max(remaining, 0))
    nums = sorted(include_set.union(random_nums))
    by_num = {r.Num: r for r in records}
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    out = SAMPLE_DIR / "extraction_sample.md"
    parts = [
        "# CICY extraction spot-check\n",
        f"_Random sample of {n} records (seed={seed}) from "
        "`static/cicy-coxeter/CICY-Coxeter-Database.txt` alongside their "
        "round-tripped parsed counterparts. A human (or LLM) reads this file "
        "and confirms field-for-field equivalence._\n",
    ]
    for num in nums:
        src = extract_source_block(text, num)
        r = by_num[num]
        parsed = render_parsed_block(r)
        match = "match" if src.strip() == parsed.strip() else "DIFFERS"
        parts.append(f"\n## CICY #{num} — {match}\n")
        parts.append("### Source (raw .txt)\n")
        parts.append("```\n" + src + "```\n")
        parts.append("### Parsed (re-serialised from Parquet row)\n")
        parts.append("```\n" + parsed + "```\n")
        parts.append("### Rendered LaTeX (what the per-entry page will ship)\n")
        parts.append("**C2:**\n")
        parts.append(
            "```latex\n" + f"c_2(X)\\cdot D_i = {latex_row_vector(r.C2)}" + "\n```\n"
        )
        parts.append("**Conf:**\n")
        parts.append(
            "```latex\n"
            + latex_configuration_matrix(r.Conf, r.H11, r.H21, r.Num)
            + "\n```\n"
        )
        if r.KahlerPos and r.KahlerRefGens:
            parts.append("**KahlerRefGens:**\n")
            for idx, (mat, iso) in enumerate(zip(r.KahlerRefGens, r.IsoFlopRows), start=1):
                parts.append(
                    f"_Generator {idx} — iso-flop row {iso['row']}, {iso['type']}_\n"
                )
                parts.append(
                    "```latex\n" + f"M_{idx} = {latex_pmatrix(mat)}" + "\n```\n"
                )
        elif r.KahlerPos:
            parts.append("**KahlerRefGens:** _(empty — no iso-flop walls)_\n")
        else:
            parts.append("**KahlerRefGens:** _(NonKahlerPos — section omitted on page)_\n")
        if r.KahlerPos and r.CoxeterMat:
            parts.append("**CoxeterMat:**\n")
            parts.append(
                "```latex\n" + latex_coxeter_matrix(r.CoxeterMat) + "\n```\n"
            )
            parts.append("**Coxeter diagram SVG (raw):**\n")
            parts.append(
                "```xml\n" + coxeter_diagram_svg(r.CoxeterMat, r.Num) + "\n```\n"
            )
        elif r.KahlerPos:
            parts.append("**CoxeterMat:** _(empty)_\n")
        else:
            parts.append("**CoxeterMat:** _(NonKahlerPos — section omitted on page)_\n")
    out.write_text("\n".join(parts), encoding="utf-8", newline="\n")
    return out


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_build(target_root: Path) -> None:
    text = SOURCE_TXT.read_text(encoding="utf-8")
    records = parse_records(text)
    validate(records)
    parquet = target_root / PARQUET_OUT.relative_to(ROOT)
    schema = target_root / SCHEMA_OUT.relative_to(ROOT)
    content = target_root / ENGLISH_CONTENT_DIR.relative_to(ROOT)
    gallery = target_root / GALLERY_OUT.relative_to(ROOT)
    chart_data = target_root / CHART_DATA_OUT.relative_to(ROOT)
    write_parquet(records, parquet)
    write_schema(schema)
    write_markdown_stubs(records, content)
    write_gallery(records, gallery)
    write_chart_data(records, chart_data)


def check_mode() -> int:
    if not PARQUET_OUT.exists() or not SCHEMA_OUT.exists() or not GALLERY_OUT.exists() or not CHART_DATA_OUT.exists():
        print("ERROR: expected outputs are missing; run the script without --check first.")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        (tmp_root / "static" / "cicy-coxeter").mkdir(parents=True)
        (tmp_root / "content" / "english" / "cicy-coxeter").mkdir(parents=True)
        (tmp_root / "data" / "cicy_coxeter").mkdir(parents=True)
        # Make source reachable relative to tmp_root without copying 4 MB.
        (tmp_root / "static" / "cicy-coxeter" / SOURCE_TXT.name).write_bytes(
            SOURCE_TXT.read_bytes()
        )
        run_build(tmp_root)
        diffs: list[str] = []
        for rel in (
            PARQUET_OUT.relative_to(ROOT),
            SCHEMA_OUT.relative_to(ROOT),
            GALLERY_OUT.relative_to(ROOT),
            CHART_DATA_OUT.relative_to(ROOT),
        ):
            committed = sha256(ROOT / rel)
            fresh = sha256(tmp_root / rel)
            if committed != fresh:
                diffs.append(f"{rel}: committed {committed[:12]} != fresh {fresh[:12]}")
        committed_stubs = sorted(
            p.name for p in ENGLISH_CONTENT_DIR.glob("*.md") if p.name != "_index.md"
        )
        fresh_stubs_dir = tmp_root / ENGLISH_CONTENT_DIR.relative_to(ROOT)
        fresh_stubs = sorted(
            p.name for p in fresh_stubs_dir.glob("*.md") if p.name != "_index.md"
        )
        if committed_stubs != fresh_stubs:
            diffs.append(
                f"markdown stub filenames differ "
                f"(committed {len(committed_stubs)}, fresh {len(fresh_stubs)})"
            )
        else:
            for name in committed_stubs:
                if (ENGLISH_CONTENT_DIR / name).read_bytes() != (
                    fresh_stubs_dir / name
                ).read_bytes():
                    diffs.append(f"{ENGLISH_CONTENT_DIR.relative_to(ROOT) / name} differs")
                    break
    if diffs:
        for d in diffs:
            print(f"DIFF {d}")
        return 1
    print("OK: all outputs are byte-identical to a fresh extraction.")
    return 0


def sample_mode(n: int, seed: int, include: list[int] | None) -> int:
    text = SOURCE_TXT.read_text(encoding="utf-8")
    records = parse_records(text)
    validate(records)
    out = write_sample(records, text, n=n, seed=seed, include=include)
    print(f"Wrote {out.relative_to(ROOT)} (N={n}, seed={seed}, include={include or []}).")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="diff-mode: verify outputs are up to date")
    parser.add_argument("--sample", type=int, metavar="N", help="write extraction spot-check file with N records")
    parser.add_argument("--seed", type=int, default=0, help="RNG seed for --sample (default 0)")
    parser.add_argument("--include", type=str, default="", help="comma-separated list of Nums to force-include in the sample")
    args = parser.parse_args(argv)

    include = [int(x) for x in args.include.split(",") if x.strip()] if args.include else None

    if args.check:
        return check_mode()
    if args.sample is not None:
        return sample_mode(args.sample, args.seed, include)
    run_build(ROOT)
    print(f"Wrote {PARQUET_OUT.relative_to(ROOT)}")
    print(f"Wrote {SCHEMA_OUT.relative_to(ROOT)}")
    print(f"Wrote {ENGLISH_CONTENT_DIR.relative_to(ROOT)}/<Num>.md (7890 files)")
    print(f"Wrote {GALLERY_OUT.relative_to(ROOT)}")
    print(f"Wrote {CHART_DATA_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
