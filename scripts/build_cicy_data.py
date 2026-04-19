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
PAGE_META_OUT = ROOT / "data" / "cicy_coxeter" / "page_meta.json"
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

    @property
    def shape_key(self) -> str | None:
        """Canonical shape name (e.g. "A2", "B2", "Atilde1-H") used by the
        Explorer's Diagram-shape facet and the gallery's `#shape=` links.
        NULL for records without a non-trivial Coxeter action (non-Kähler-
        favorable or empty CoxeterMat)."""
        if self.CoxeterMat is None or not self.CoxeterMat:
            return None
        key, _ = _canonical_shape_key(self.CoxeterMat)
        layout = SHAPE_LAYOUTS.get(key)
        if layout:
            return layout.name
        return f"fallback-rank{len(self.CoxeterMat)}"

    @property
    def coxeter_kind(self) -> str:
        """One of "finite", "affine", "indefinite", "trivial", "sentinel".
        "sentinel" for non-Kähler-favorable rows (no Coxeter data computed),
        "trivial" for Kähler-favorable rows with no iso-flop walls."""
        if self.CoxeterMat is None:
            return "sentinel"
        if not self.CoxeterMat:
            return "trivial"
        return _classify_coxeter_kind(self.CoxeterMat)


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
            CoxeterSummary VARCHAR,
            ShapeKey VARCHAR,
            CoxeterKind VARCHAR
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
            r.shape_key,
            r.coxeter_kind,
        )
        for r in records
    ]
    con.executemany(
        "INSERT INTO cicy VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        {"name": "C2", "type": "INTEGER[]", "description": "c2(X).D_i in the favorable basis."},
        {"name": "Conf", "type": "INTEGER[][]", "description": "Configuration matrix in the favorable presentation."},
        {"name": "Favour", "type": "BOOLEAN", "description": "Favorable (projective-product) presentation exists."},
        {"name": "KahlerPos", "type": "BOOLEAN", "description": "Kahler-favorable."},
        {"name": "IsProduct", "type": "BOOLEAN", "description": "Direct product of lower-dim Calabi-Yaus."},
        {"name": "IsoFlopRows", "type": "STRUCT(row INTEGER, type VARCHAR)[]", "description": "Config-matrix rows yielding iso-flop walls; NULL when non-Kahler-pos."},
        {"name": "KahlerRefGens", "type": "INTEGER[][][]", "description": "Simple reflections in the Kahler representation; NULL when non-Kahler-pos."},
        {"name": "CoxeterMat", "type": "VARCHAR[][]", "description": "Coxeter matrix entries as strings; \"P\"/\"H\" denote infinite orders; NULL when non-Kahler-pos."},
        {"name": "IsoFlopRank", "type": "INTEGER", "description": "Derived: len(IsoFlopRows); NULL when non-Kahler-pos."},
        {"name": "CoxeterSummary", "type": "VARCHAR", "description": "Derived one-liner (\"Z2\", \"I2(H)\", \"NonKahlerPos\", \"\" for empty, etc.)."},
        {"name": "ShapeKey", "type": "VARCHAR", "description": "Canonical Coxeter-diagram shape id (e.g. \"A2\", \"B2\", \"Atilde1-H\", \"dot\"); NULL when there is no non-trivial Coxeter action. Matches the landing-page Explorer's Diagram-shape facet and gallery tile ids."},
        {"name": "CoxeterKind", "type": "VARCHAR", "description": "Classification of the Coxeter group: \"finite\", \"affine\", \"indefinite\", \"trivial\" (Kähler-fav with no iso-flop walls), or \"sentinel\" (non-Kähler-favorable, no Coxeter data computed)."},
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
    """Group Kahler-favourable CICYs by the isomorphism class of their
    Coxeter diagram (paper §3 canonicalisation, not raw-matrix equality)
    and return a rank-grouped gallery ready to render on the landing page.
    Each tile shows one shape using the smallest CICY's CoxeterMat as the
    representative."""
    from collections import defaultdict

    counts: dict[tuple, dict] = {}
    for r in records:
        if not r.KahlerPos or r.CoxeterMat is None or not r.CoxeterMat:
            continue
        shape_key, _ = _canonical_shape_key(r.CoxeterMat)
        rank = len(r.CoxeterMat)
        if shape_key not in counts:
            layout = SHAPE_LAYOUTS.get(shape_key)
            name = layout.name if layout else f"fallback-rank{rank}"
            counts[shape_key] = {
                "rank": rank,
                "name": name,
                "mat": [list(row) for row in r.CoxeterMat],
                "count": 0,
                "example_num": r.Num,
            }
        info = counts[shape_key]
        info["count"] += 1
        if r.Num < info["example_num"]:
            info["example_num"] = r.Num
            info["mat"] = [list(row) for row in r.CoxeterMat]

    by_rank: dict[int, list] = defaultdict(list)
    for key, info in counts.items():
        info["svg"] = coxeter_diagram_svg(info["mat"], info["example_num"])
        info["latex"] = latex_coxeter_matrix(info["mat"]) if info["mat"] else ""
        info["display"] = _shape_display(info["name"], info["rank"])
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


_EIGENVALUE_TOL = 1e-9


def _mij_cos(m: str) -> float:
    """Return -cos(π/m) for a Coxeter-matrix off-diagonal label m, where
    'P' and 'H' both denote m = ∞ (so cos(π/∞) = 1 and the entry is -1)."""
    if m in ("P", "H"):
        return -1.0
    k = int(m)
    return -math.cos(math.pi / k)


def _sym_eigvals(mat: list[list[float]]) -> list[float]:
    """Return sorted eigenvalues of a small real symmetric matrix via the
    Jacobi eigenvalue method. Pure Python to avoid the numpy-on-Windows
    DLL crash that hit this repo's environment; accuracy is sufficient for
    the finite/affine/indefinite classification here (ranks ≤ 5)."""
    n = len(mat)
    a = [row[:] for row in mat]
    for _ in range(200):
        off_max = 0.0
        p, q = 0, 1
        for i in range(n):
            for j in range(i + 1, n):
                v = abs(a[i][j])
                if v > off_max:
                    off_max = v
                    p, q = i, j
        if off_max < 1e-14:
            break
        app, aqq, apq = a[p][p], a[q][q], a[p][q]
        if app == aqq:
            theta = math.pi / 4
        else:
            theta = 0.5 * math.atan2(2 * apq, app - aqq)
        c = math.cos(theta)
        s = math.sin(theta)
        new_pp = c * c * app + 2 * c * s * apq + s * s * aqq
        new_qq = s * s * app - 2 * c * s * apq + c * c * aqq
        a[p][p] = new_pp
        a[q][q] = new_qq
        a[p][q] = 0.0
        a[q][p] = 0.0
        for i in range(n):
            if i == p or i == q:
                continue
            aip = c * a[i][p] + s * a[i][q]
            aiq = -s * a[i][p] + c * a[i][q]
            a[i][p] = aip
            a[p][i] = aip
            a[i][q] = aiq
            a[q][i] = aiq
    return sorted(a[i][i] for i in range(n))


def _classify_coxeter_kind(mat: list[list[str]]) -> str:
    """Classify a Coxeter matrix as finite / affine / indefinite. Uses the
    eigenvalue signature of the Gram matrix G_{ij} = -cos(π / m_{ij}) with
    G_{ii} = 1, then overrides to `indefinite` whenever any off-diagonal
    carries the paper's `H` label — since `P` and `H` both give the same
    Gram entry but the paper treats `H` as the hyperbolic (indefinite)
    representation of the same abstract I₂(∞) group. Returns '' for empty
    input."""
    if not mat:
        return ""
    rank = len(mat)
    has_h = any(
        mat[i][j] == "H" for i in range(rank) for j in range(i + 1, rank)
    )
    if has_h:
        return "indefinite"
    g = [[1.0 if i == j else _mij_cos(mat[i][j]) for j in range(rank)] for i in range(rank)]
    eigs = _sym_eigvals(g)
    if all(e > _EIGENVALUE_TOL for e in eigs):
        return "finite"
    if all(e > -_EIGENVALUE_TOL for e in eigs):
        return "affine"
    return "indefinite"


def build_chart_data(records: list[Record]) -> dict:
    """Aggregate the landing-page charts (Hodge scatter + two rank×h11
    heatmaps), the landing stats strip, and the shape-facet options into
    one JSON blob."""
    from collections import Counter

    hodge = Counter()
    hodge_kahler = Counter()
    rank_h11 = Counter()
    shape_counts: Counter = Counter()
    shape_rank: dict[str, int] = {}

    total = len(records)
    kahler_favorable = 0
    with_coxeter = 0
    infinite_order = 0

    for r in records:
        hodge[(r.H11, r.H21)] += 1
        if not r.KahlerPos:
            continue
        kahler_favorable += 1
        hodge_kahler[(r.H11, r.H21)] += 1
        mat = r.CoxeterMat or []
        rank = len(mat)
        kind = _classify_coxeter_kind(mat)
        rank_h11[(rank, r.H11, kind)] += 1
        if mat:
            with_coxeter += 1
            if kind in ("affine", "indefinite"):
                infinite_order += 1
            key = r.shape_key
            if key is not None:
                shape_counts[key] += 1
                shape_rank.setdefault(key, rank)

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
    shape_options = [
        {
            "key": key,
            "display": _shape_display(key, shape_rank[key]),
            "rank": shape_rank[key],
            "count": count,
        }
        for key, count in sorted(
            shape_counts.items(),
            key=lambda kv: (shape_rank[kv[0]], -kv[1], kv[0]),
        )
    ]
    totals = {
        "total": total,
        "kahler_favorable": kahler_favorable,
        "with_coxeter": with_coxeter,
        "infinite_order": infinite_order,
    }
    return {
        "totals": totals,
        "shape_options": shape_options,
        "hodge_scatter": hodge_scatter,
        "rank_h11_table": rank_h11_table,
    }


def write_chart_data(records: list[Record], out_path: Path) -> None:
    data = build_chart_data(records)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


# Per-shape display labels used in the summary header of each per-model page.
# Keys are the internal `ShapeLayout.name` strings; values render the paper's
# classification in a reader-friendly form. Fallback shapes (not hand-laid-out)
# fall through to `unclassified (rank N)`.
SHAPE_DISPLAY: dict[str, str] = {
    "dot": "\u2124\u2082 (single reflection)",  # Z₂
    "A2": "A\u2082",                              # A₂
    "B2": "B\u2082",                              # B₂
    "Atilde1-P": "\u00c3\u2081 \u2014 parabolic \u221e",   # Ã₁ parabolic
    "Atilde1-H": "\u00c3\u2081 \u2014 hyperbolic \u221e",  # Ã₁ hyperbolic
    "A1+A1": "A\u2081 + A\u2081",
    "A1+A1+A1": "A\u2081 + A\u2081 + A\u2081",
    "A1+A2": "A\u2081 + A\u2082",
    "A1+B2": "A\u2081 + B\u2082",
    "VPH": "V-shape (P, H)",
    "VPP": "V-shape (P, P)",
    "TriangleAPP": "triangle (3, P, P)",
    "TrianglePPH": "triangle (P, P, H)",
    "TrianglePPP": "triangle (P, P, P)",
    "A1+A1+A2": "A\u2081 + A\u2081 + A\u2082",
    "A2+A2": "A\u2082 + A\u2082",
    "B2+B2": "B\u2082 + B\u2082",
    "StarThreeLegP": "3-leg star (all P)",
    "PStarATwoEdge": "P-star with A\u2082 arm",
    "KFourAllP": "K\u2084 (all P)",
    "StarFourLegFour": "4-leg star (all 4)",
    "KFiveAllThree": "K\u2085 (all 3)",
}


def _shape_display(layout_name: str, rank: int) -> str:
    """Reader-friendly display label for a canonical shape."""
    if layout_name in SHAPE_DISPLAY:
        return SHAPE_DISPLAY[layout_name]
    return f"unclassified (rank {rank})"


def compute_page_meta(records: list[Record]) -> dict:
    """Sidecar metadata for per-model page layouts: navigation neighbours,
    Coxeter kind / rank / display label, shape-siblings list, ambient dims.
    Keyed by stringified `Num` so Hugo can index it from TOML front-matter."""
    from collections import defaultdict

    by_shape: dict[tuple, list[int]] = defaultdict(list)
    shape_layout_name: dict[tuple, str] = {}
    for r in records:
        if not r.KahlerPos or not r.CoxeterMat:
            continue
        shape_key, _ = _canonical_shape_key(r.CoxeterMat)
        by_shape[shape_key].append(r.Num)
        if shape_key not in shape_layout_name:
            layout = SHAPE_LAYOUTS.get(shape_key)
            shape_layout_name[shape_key] = (
                layout.name if layout else f"fallback-rank{len(r.CoxeterMat)}"
            )

    total = len(records)
    meta: dict[str, dict] = {}
    for r in records:
        mat = r.CoxeterMat
        if not r.KahlerPos:
            kind = "sentinel"
            rank: int | None = None
            type_label: str | None = None
            type_display: str | None = None
            siblings: list[int] = []
        elif not mat:
            kind = "trivial"
            rank = 0
            type_label = None
            type_display = None
            siblings = []
        else:
            rank = len(mat)
            kind = _classify_coxeter_kind(mat)
            shape_key, _ = _canonical_shape_key(mat)
            type_label = shape_layout_name[shape_key]
            type_display = _shape_display(type_label, rank)
            siblings = sorted(n for n in by_shape[shape_key] if n != r.Num)

        prev_num = r.Num - 1 if r.Num > 1 else total
        next_num = r.Num + 1 if r.Num < total else 1

        iso_flop_count = (
            len(r.IsoFlopRows) if r.KahlerPos and r.IsoFlopRows is not None else None
        )
        meta[str(r.Num)] = {
            "num": r.Num,
            "h11": r.H11,
            "h21": r.H21,
            "chi": 2 * (r.H11 - r.H21),
            "rank": rank,
            "coxeter_kind": kind,
            "type_label": type_label,
            "type_display": type_display,
            "is_favour": r.Favour,
            "is_kahler_pos": r.KahlerPos,
            "is_product": r.IsProduct,
            "iso_flop_count": iso_flop_count,
            "ambient_rows": len(r.Conf),
            "conf_cols": len(r.Conf[0]) if r.Conf else 0,
            "siblings": siblings,
            "prev": prev_num,
            "next": next_num,
        }
    return meta


def write_page_meta(records: list[Record], out_path: Path) -> None:
    _write_json(compute_page_meta(records), out_path)


def _write_json(data: dict, out_path: Path) -> None:
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


# ---------------------------------------------------------------------------
# Coxeter-diagram rendering
# ---------------------------------------------------------------------------
#
# Layouts mirror the paper *Kaleidoscopes, Waves and the Prepotential*
# (`draft/figures/Coxeter-diagrams.tex`). We canonicalise each input Coxeter
# matrix to an abstract-graph key (invariant under node relabeling), look up a
# hand-tuned layout for the 22 shapes enumerated in paper §3 (21 rank-\u22652
# shapes + the rank-1 dot for W=Z_2), then render. Typography uses KaTeX's
# upright Roman face so labels match the KaTeX-rendered matrices on the same
# page — `\mathrm{P}`, `\mathrm{H}`, upright numerals.
#
# Shape keys are `tuple[component_key, ...]`, sorted by (size, edge_tuple).
# Each component_key is `(size, edge_tuple)` where edge_tuple is the sorted
# list of `(slot_i, slot_j, label)` triples (with slot_i<slot_j) under the
# lex-smallest permutation of the component's nodes.


_EDGE_PX = 60.0     # pixels per unit edge length
_NODE_R = 4.0       # node radius (pixels)
_LABEL_FONT_PX = 13  # label text size (SVG units)
_LABEL_OFFSET = 10.0  # pixel offset from edge midpoint to label anchor
_MARGIN_PX = 14.0   # viewBox margin on all sides
_LABEL_FONT_FAMILY = "KaTeX_Main, 'Latin Modern Math', 'Cambria Math', serif"

# Handy offset constants for tuple-valued label hints, in edge-length units.
_D = _LABEL_OFFSET / _EDGE_PX       # full perpendicular offset (~0.167)
_D_HALF = _D / 2                    # half offset (~0.083)
_D_QUARTER = _D / 4                 # quarter offset (~0.042)


@dataclass(frozen=True)
class ShapeLayout:
    """A hand-tuned layout for one canonical Coxeter-diagram shape.

    `nodes` are coordinates in an edge-length=1 frame with the TikZ convention
    (y axis points up); they get flipped and scaled at SVG-emission time.
    `edges` are `(slot_i, slot_j, hint)`. `hint` is either a named direction
    (`"auto"`, `"above"`, `"below"`, `"left"`, `"right"`, `"above-left"`,
    `"above-right"`, `"below-left"`, `"below-right"`, `"perp-ccw"`, or
    `"perp-cw"`) or a raw `(dx, dy)` offset in edge-length units for a
    hand-tuned anchor that no named direction expresses cleanly.
    """

    name: str
    nodes: tuple[tuple[float, float], ...]
    edges: tuple[tuple[int, int, "str | tuple[float, float]"], ...]


def _connected_components(mat: list[list[str]]) -> list[list[int]]:
    """Return connected components of the Coxeter graph (m=2 ⇒ no edge).
    Each component is the sorted list of its original node indices."""
    rank = len(mat)
    adj: dict[int, set[int]] = {i: set() for i in range(rank)}
    for i in range(rank):
        for j in range(i + 1, rank):
            if mat[i][j] != "2":
                adj[i].add(j)
                adj[j].add(i)
    visited: set[int] = set()
    components: list[list[int]] = []
    for start in range(rank):
        if start in visited:
            continue
        stack = [start]
        comp: list[int] = []
        while stack:
            u = stack.pop()
            if u in visited:
                continue
            visited.add(u)
            comp.append(u)
            stack.extend(v for v in adj[u] if v not in visited)
        components.append(sorted(comp))
    return components


def _component_canonical(
    mat: list[list[str]], comp: list[int]
) -> tuple[int, tuple[tuple[int, int, str], ...], tuple[int, ...]]:
    """Return `(size, canonical_edge_tuple, best_perm)` for one component.

    `best_perm[slot] = comp-local index` — i.e. the permutation that, when
    applied to `comp`, produces the lex-smallest edge-tuple in slot space.
    For n ≤ 5 we brute-force all n! permutations; the database keeps component
    sizes well within that bound.
    """
    from itertools import permutations

    n = len(comp)
    comp_edges: list[tuple[int, int, str]] = []
    for a in range(n):
        for b in range(a + 1, n):
            label = mat[comp[a]][comp[b]]
            if label != "2":
                comp_edges.append((a, b, label))

    best_tuple: tuple[tuple[int, int, str], ...] | None = None
    best_perm: tuple[int, ...] | None = None
    for perm in permutations(range(n)):
        inv = [0] * n
        for slot, p in enumerate(perm):
            inv[p] = slot
        relabelled = []
        for a, b, label in comp_edges:
            s1, s2 = inv[a], inv[b]
            if s1 > s2:
                s1, s2 = s2, s1
            relabelled.append((s1, s2, label))
        relabelled.sort()
        tup = tuple(relabelled)
        if best_tuple is None or tup < best_tuple:
            best_tuple = tup
            best_perm = perm
    assert best_tuple is not None and best_perm is not None
    return n, best_tuple, best_perm


def _canonical_shape_key(
    mat: list[list[str]],
) -> tuple[tuple[tuple[int, tuple[tuple[int, int, str], ...]], ...], tuple[int, ...]]:
    """Return `(shape_key, slot_to_original)`.

    `shape_key` is an isomorphism-invariant description of the Coxeter graph:
    a tuple of `(component_size, canonical_edge_tuple)` per connected
    component, sorted. `slot_to_original[slot_k] = original matrix index` tells
    the renderer which input node goes at each canonical slot.
    """
    components = _connected_components(mat)
    per_component = []
    for comp in components:
        n, etuple, perm = _component_canonical(mat, comp)
        per_component.append((n, etuple, perm, comp))
    per_component.sort(key=lambda x: (x[0], x[1]))
    shape_key = tuple((n, etuple) for n, etuple, _, _ in per_component)
    slot_to_original: list[int] = []
    for _, _, perm, comp in per_component:
        for slot_local in range(len(comp)):
            slot_to_original.append(comp[perm[slot_local]])
    return shape_key, tuple(slot_to_original)


# ---------------------------------------------------------------------------
# Canonical layouts (22 shapes)
# ---------------------------------------------------------------------------

_R3 = math.sqrt(3) / 2
_PENTAGON_R = 1.0 / (2.0 * math.sin(math.radians(36)))  # ≈ 0.851


def _pentagon_nodes() -> tuple[tuple[float, float], ...]:
    return tuple(
        (
            _PENTAGON_R * math.cos(math.radians(90 - 72 * k)),
            _PENTAGON_R * math.sin(math.radians(90 - 72 * k)),
        )
        for k in range(5)
    )


_EDGES_RANK2 = ((0, 1, "above"),)
_TRIANGLE_NODES = ((1.0, 0.0), (0.0, 1.0), (0.0, 0.0))  # east, north, hub
_TRIANGLE_EDGES_CONNECTED_VIA_THIRD = (
    (0, 2, "below"),         # east–hub horizontal, label below (outside)
    (1, 2, "left"),          # north–hub vertical, label west (outside)
    (0, 1, "above-right"),   # hypotenuse, label outside the triangle (NE)
)


def _complete_key(n: int, label: str) -> tuple[int, tuple[tuple[int, int, str], ...]]:
    return n, tuple((i, j, label) for i in range(n) for j in range(i + 1, n))


SHAPE_LAYOUTS: dict[tuple, ShapeLayout] = {
    # Rank 1: single dot (W = Z_2).
    ((1, ()),): ShapeLayout(
        name="dot",
        nodes=((0.0, 0.0),),
        edges=(),
    ),
    # Rank 2 connected: A_2, B_2, affine \tilde A_1 (P / H).
    ((2, ((0, 1, "3"),)),): ShapeLayout(
        name="A2", nodes=((0.0, 0.0), (1.0, 0.0)), edges=_EDGES_RANK2,
    ),
    ((2, ((0, 1, "4"),)),): ShapeLayout(
        name="B2", nodes=((0.0, 0.0), (1.0, 0.0)), edges=_EDGES_RANK2,
    ),
    ((2, ((0, 1, "P"),)),): ShapeLayout(
        name="Atilde1-P", nodes=((0.0, 0.0), (1.0, 0.0)), edges=_EDGES_RANK2,
    ),
    ((2, ((0, 1, "H"),)),): ShapeLayout(
        name="Atilde1-H", nodes=((0.0, 0.0), (1.0, 0.0)), edges=_EDGES_RANK2,
    ),
    # Rank 2 disjoint: A_1 ⊔ A_1.
    ((1, ()), (1, ())): ShapeLayout(
        name="A1+A1", nodes=((0.0, 0.0), (1.0, 0.0)), edges=(),
    ),
    # Rank 3 disjoint unions.
    ((1, ()), (1, ()), (1, ())): ShapeLayout(
        name="A1+A1+A1",
        nodes=((0.0, 0.0), (1.0, 0.0), (2.0, 0.0)),
        edges=(),
    ),
    ((1, ()), (2, ((0, 1, "3"),))): ShapeLayout(
        name="A1+A2",
        nodes=((0.0, 0.0), (1.0, 0.0), (2.0, 0.0)),
        edges=((1, 2, "above"),),
    ),
    ((1, ()), (2, ((0, 1, "4"),))): ShapeLayout(
        name="A1+B2",
        nodes=((0.0, 0.0), (1.0, 0.0), (2.0, 0.0)),
        edges=((1, 2, "above"),),
    ),
    # Rank 3 connected: V-shapes and triangles. Canonical slot layout is an
    # L with hub at origin, "east" at (1,0), "north" at (0,1). For Triangle*,
    # slots 0,1 are the pair connected by the paper's hypotenuse edge and
    # slot 2 is the hub.
    ((3, ((0, 1, "H"), (0, 2, "P"))),): ShapeLayout(
        name="VPH",
        nodes=((0.0, 0.0), (1.0, 0.0), (0.0, 1.0)),
        edges=((0, 1, "below"), (0, 2, "left")),
    ),
    ((3, ((0, 1, "P"), (0, 2, "P"))),): ShapeLayout(
        name="VPP",
        nodes=((0.0, 0.0), (1.0, 0.0), (0.0, 1.0)),
        edges=((0, 1, "below"), (0, 2, "left")),
    ),
    ((3, ((0, 1, "3"), (0, 2, "P"), (1, 2, "P"))),): ShapeLayout(
        name="TriangleAPP",
        nodes=_TRIANGLE_NODES,
        edges=_TRIANGLE_EDGES_CONNECTED_VIA_THIRD,
    ),
    ((3, ((0, 1, "H"), (0, 2, "P"), (1, 2, "P"))),): ShapeLayout(
        name="TrianglePPH",
        nodes=_TRIANGLE_NODES,
        edges=_TRIANGLE_EDGES_CONNECTED_VIA_THIRD,
    ),
    ((3, ((0, 1, "P"), (0, 2, "P"), (1, 2, "P"))),): ShapeLayout(
        name="TrianglePPP",
        nodes=_TRIANGLE_NODES,
        edges=_TRIANGLE_EDGES_CONNECTED_VIA_THIRD,
    ),
    # Rank 4 disjoint unions.
    ((1, ()), (1, ()), (2, ((0, 1, "3"),))): ShapeLayout(
        name="A1+A1+A2",
        nodes=((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)),
        edges=((2, 3, "above"),),
    ),
    ((2, ((0, 1, "3"),)), (2, ((0, 1, "3"),))): ShapeLayout(
        name="A2+A2",
        nodes=((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)),
        edges=((0, 1, "above"), (2, 3, "above")),
    ),
    ((2, ((0, 1, "4"),)), (2, ((0, 1, "4"),))): ShapeLayout(
        name="B2+B2",
        nodes=((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)),
        edges=((0, 1, "above"), (2, 3, "above")),
    ),
    # Rank 4 connected: star, star-with-extra-edge, K_4.
    ((4, ((0, 1, "P"), (0, 2, "P"), (0, 3, "P"))),): ShapeLayout(
        name="StarThreeLegP",
        # Hub at origin; 3 legs at 90° (N), 210° (SW), 330° (SE). Matches paper
        # \CoxDiagramStarThreeLegP layout. Hub-N label west of the vertical
        # edge (dynkin's default side); lower-leg labels on true perpendiculars
        # to avoid grazing the diagonal edge lines.
        nodes=(
            (0.0, 0.0),
            (0.0, 1.0),
            (-_R3, -0.5),
            (_R3, -0.5),
        ),
        edges=(
            (0, 1, "left"),
            (0, 2, "perp-ccw"),   # hub-SW: perpendicular on SE side, 10 px
            (0, 3, "perp-cw"),    # hub-SE: perpendicular on SW side, 10 px
        ),
    ),
    ((4, ((0, 1, "3"), (0, 2, "P"), (1, 2, "P"), (2, 3, "P"))),): ShapeLayout(
        name="PStarATwoEdge",
        # Hub at slot 2; isolated P-arm at slot 3 east. Inner triangle
        # NW-SW-hub is equilateral (all three sides length 1): NW and SW sit
        # on x = -√3/2, symmetric about the x axis with |y| = 1/2.
        nodes=(
            (-_R3,  0.5),   # slot 0: NW
            (-_R3, -0.5),   # slot 1: SW
            (0.0,  0.0),    # slot 2: hub
            (1.0,  0.0),    # slot 3: east arm
        ),
        edges=(
            (0, 1, "left"),           # A_2 pair vertical edge, label west of it
            (0, 2, "above-right"),    # NW–hub diagonal, label above (NE side)
            (1, 2, "below-right"),    # SW–hub diagonal, label below (SE side)
            (2, 3, "above"),          # hub–east horizontal, label on top
        ),
    ),
    (_complete_key(4, "P"),): ShapeLayout(
        name="KFourAllP",
        # Paper \CoxDiagramKFourAllP: hub + 3 outer at 90°, 210°, 330°, all 6
        # edges drawn. Hub-N uses a hand-tuned half-west + small down-shift to
        # mirror the paper's `\PTriTop` raisebox — keeps the P snug against
        # the internal vertical edge and clear of the N-SW diagonal that would
        # otherwise crowd a full-offset label. Hub-SW / hub-SE use true
        # perpendiculars (SE and SW respectively) so the labels sit exactly
        # 10 px clear of the diagonal edges. Outer-outer edges label outward.
        nodes=(
            (0.0, 0.0),
            (0.0, 1.0),
            (-_R3, -0.5),
            (_R3, -0.5),
        ),
        edges=(
            (0, 1, (-_D * 0.6, -_D_QUARTER)),  # hub-N: ~6 px west + small down
            (0, 2, "perp-ccw"),                # hub-SW: perpendicular SE, 10 px
            (0, 3, "perp-cw"),                 # hub-SE: perpendicular SW, 10 px
            (1, 2, "above-left"),              # N-SW outer, label NW outward
            (1, 3, "above-right"),             # N-SE outer, label NE outward
            (2, 3, "below"),                   # SW-SE bottom, label below
        ),
    ),
    # Rank 5 connected: 4-leg star and K_5.
    ((5, ((0, 1, "4"), (0, 2, "4"), (0, 3, "4"), (0, 4, "4"))),): ShapeLayout(
        name="StarFourLegFour",
        # Paper rotate=45: hub + 4 legs at NE/NW/SW/SE. Paper alternates
        # \CoxEdge / \CoxEdgeFlipLabel so each leg's `4` label lands in the
        # gap between that leg and its adjacent neighbour — two labels in the
        # upper gap between the two top legs, two in the lower gap between
        # the two bottom legs.
        nodes=(
            (0.0, 0.0),
            ( 1.0 / math.sqrt(2),  1.0 / math.sqrt(2)),   # slot 1: NE
            (-1.0 / math.sqrt(2),  1.0 / math.sqrt(2)),   # slot 2: NW
            (-1.0 / math.sqrt(2), -1.0 / math.sqrt(2)),   # slot 3: SW
            ( 1.0 / math.sqrt(2), -1.0 / math.sqrt(2)),   # slot 4: SE
        ),
        edges=(
            (0, 1, "above-left"),     # hub-NE, label NW of midpoint
            (0, 2, "above-right"),    # hub-NW, label NE of midpoint
            (0, 3, "below-right"),    # hub-SW, label SE of midpoint
            (0, 4, "below-left"),     # hub-SE, label SW of midpoint
        ),
    ),
    (_complete_key(5, "3"),): ShapeLayout(
        name="KFiveAllThree",
        nodes=_pentagon_nodes(),
        edges=tuple((i, j, "auto") for i in range(5) for j in range(i + 1, 5)),
    ),
}


def _fallback_layout(mat: list[list[str]]) -> ShapeLayout:
    """Regular-polygon layout for shapes not in `SHAPE_LAYOUTS`. Keeps the
    pre-refactor behaviour as a safety net. Canonical slot i = original
    matrix node i (identity permutation); labels lift straight from `mat`."""
    rank = len(mat)
    if rank == 1:
        nodes = ((0.0, 0.0),)
    elif rank == 2:
        nodes = ((0.0, 0.0), (1.0, 0.0))
    else:
        nodes = tuple(
            (math.cos(2 * math.pi * i / rank - math.pi / 2),
             math.sin(2 * math.pi * i / rank - math.pi / 2))
            for i in range(rank)
        )
    edges: list[tuple[int, int, str]] = []
    for i in range(rank):
        for j in range(i + 1, rank):
            if mat[i][j] != "2":
                edges.append((i, j, "auto"))
    return ShapeLayout(name=f"fallback-rank{rank}", nodes=nodes, edges=tuple(edges))


def _label_anchor(
    p1: tuple[float, float],
    p2: tuple[float, float],
    hint: "str | tuple[float, float]",
    centroid: tuple[float, float],
) -> tuple[float, float]:
    """Return the label-anchor point (TikZ y-up, edge-length=1 frame) offset
    by ~LABEL_OFFSET/EDGE_PX from the edge midpoint.

    Hints:
      (dx, dy) tuple                             — raw offset in edge-length
                                                   units, added to midpoint
      above / below / left / right               — cardinal offsets
      above-left / above-right /
      below-left / below-right                   — diagonal (NW/NE/SW/SE)
      perp-ccw / perp-cw                         — perpendicular to the edge,
                                                   CCW / CW side respectively
      auto                                       — perpendicular to the edge,
                                                   on the side away from the
                                                   component centroid. Falls
                                                   back to CCW perpendicular
                                                   when the centroid lies on
                                                   the edge's line.
    """
    mx = 0.5 * (p1[0] + p2[0])
    my = 0.5 * (p1[1] + p2[1])
    if isinstance(hint, tuple):
        return (mx + hint[0], my + hint[1])
    d = _LABEL_OFFSET / _EDGE_PX
    if hint == "above":
        return (mx, my + d)
    if hint == "below":
        return (mx, my - d)
    if hint == "left":
        return (mx - d, my)
    if hint == "right":
        return (mx + d, my)
    k = d / math.sqrt(2)
    if hint == "above-left":
        return (mx - k, my + k)
    if hint == "above-right":
        return (mx + k, my + k)
    if hint == "below-left":
        return (mx - k, my - k)
    if hint == "below-right":
        return (mx + k, my - k)
    ex, ey = p2[0] - p1[0], p2[1] - p1[1]
    elen = math.hypot(ex, ey) or 1.0
    nccw_x, nccw_y = -ey / elen, ex / elen
    if hint == "perp-ccw":
        return (mx + d * nccw_x, my + d * nccw_y)
    if hint == "perp-cw":
        return (mx - d * nccw_x, my - d * nccw_y)
    # "auto" — perpendicular on the side away from centroid.
    mc_x, mc_y = mx - centroid[0], my - centroid[1]
    dot = nccw_x * mc_x + nccw_y * mc_y
    if abs(dot) > 1e-6:
        sign = 1.0 if dot > 0 else -1.0
        return (mx + d * sign * nccw_x, my + d * sign * nccw_y)
    return (mx + d * nccw_x, my + d * nccw_y)


def coxeter_diagram_svg(mat: list[list[str]], num: int) -> str:
    """Render a Coxeter diagram as inline SVG. Matches the paper's per-shape
    layouts for the 22 canonical shapes enumerated in paper §3 (21 rank-\u22652
    shapes + the rank-1 dot). Standard conventions: no edge for m=2,
    unlabeled edge for m=3, literal label otherwise (4, 5, …, P, H)."""
    rank = len(mat)
    shape_key, slot_to_original = _canonical_shape_key(mat)
    layout = SHAPE_LAYOUTS.get(shape_key)
    if layout is None:
        layout = _fallback_layout(mat)
        slot_to_original = tuple(range(rank))

    assert len(layout.nodes) == rank == len(slot_to_original)

    def mat_label(slot_i: int, slot_j: int) -> str:
        oi = slot_to_original[slot_i]
        oj = slot_to_original[slot_j]
        return mat[oi][oj]

    xs = [n[0] for n in layout.nodes]
    ys = [n[1] for n in layout.nodes]
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    centroid = (cx, cy)

    pts_px: list[tuple[float, float]] = [
        (x * _EDGE_PX, y * _EDGE_PX) for x, y in layout.nodes
    ]
    min_x = min(p[0] for p in pts_px)
    max_x = max(p[0] for p in pts_px)
    min_y = min(p[1] for p in pts_px)
    max_y = max(p[1] for p in pts_px)

    label_anchors: list[tuple[tuple[float, float], str]] = []
    for si, sj, hint in layout.edges:
        m = mat_label(si, sj)
        if m in ("2", "3"):
            continue
        anchor = _label_anchor(layout.nodes[si], layout.nodes[sj], hint, centroid)
        ax_px = anchor[0] * _EDGE_PX
        ay_px = anchor[1] * _EDGE_PX
        label_anchors.append(((ax_px, ay_px), m))
        min_x = min(min_x, ax_px - _LABEL_FONT_PX)
        max_x = max(max_x, ax_px + _LABEL_FONT_PX)
        min_y = min(min_y, ay_px - _LABEL_FONT_PX * 0.75)
        max_y = max(max_y, ay_px + _LABEL_FONT_PX * 0.75)

    ox = -min_x + _MARGIN_PX
    oy = -min_y + _MARGIN_PX
    width = (max_x - min_x) + 2 * _MARGIN_PX
    height = (max_y - min_y) + 2 * _MARGIN_PX

    def _tx(x: float) -> float:
        return x + ox

    def _ty(y: float) -> float:
        return height - (y + oy)  # flip TikZ y-up to SVG y-down

    parts: list[str] = []
    for si, sj, _hint in layout.edges:
        m = mat_label(si, sj)
        if m == "2":
            continue
        x1, y1 = pts_px[si]
        x2, y2 = pts_px[sj]
        parts.append(
            f'<line x1="{_svg_coord(_tx(x1))}" y1="{_svg_coord(_ty(y1))}" '
            f'x2="{_svg_coord(_tx(x2))}" y2="{_svg_coord(_ty(y2))}" '
            'stroke="currentColor" stroke-width="1.2"/>'
        )
    for (ax, ay), m in label_anchors:
        parts.append(
            f'<text x="{_svg_coord(_tx(ax))}" y="{_svg_coord(_ty(ay))}" '
            'text-anchor="middle" dominant-baseline="central" '
            f'font-family="{_LABEL_FONT_FAMILY}" font-style="normal" '
            f'font-size="{_LABEL_FONT_PX}" fill="currentColor">{m}</text>'
        )
    for px, py in pts_px:
        parts.append(
            f'<circle cx="{_svg_coord(_tx(px))}" cy="{_svg_coord(_ty(py))}" '
            f'r="{_NODE_R:g}" fill="currentColor"/>'
        )

    aria = (
        f"Coxeter diagram for CICY {num}: rank 1 (single node)"
        if rank == 1
        else f"Coxeter diagram for CICY {num}: rank {rank} ({layout.name})"
    )
    w_str = _svg_coord(width)
    h_str = _svg_coord(height)
    return (
        f'<svg class="cicy-entry__diagram" '
        f'width="{w_str}" height="{h_str}" viewBox="0 0 {w_str} {h_str}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img" '
        f'aria-label="{aria}">'
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


def _matrix_shortcode(
    latex: str,
    *,
    fold: str = "",
    summary: str = "",
    summary_math: str = "",
    extra_class: str = "",
) -> list[str]:
    """Wrap LaTeX in the {{< matrix >}} shortcode.

    `fold` controls collapsing:
      ""        no wrapper (default)
      "open"    wrapped in <details open>   — collapsible but starts expanded
      "closed"  wrapped in <details>        — collapsed by default
    `summary` is the visible <summary> text when folded.
    `summary_math` is an optional inline-LaTeX fragment rendered through the
      same KaTeX pipeline as the matrix body and prepended to `summary`, so the
      symbol (e.g. "M_1") matches the matrix typography rather than the UI font.
    `extra_class` adds an extra CSS class on the <details>, used to target a
      subset of collapsibles with bulk controls (e.g. the "expand all
      generators" button only toggles generator matrices, not the config one).
    """
    opener = "{{< matrix >}}"
    if fold:
        # Keep shortcode attributes on the same line for deterministic output.
        attrs = [f'fold="{fold}"', f'summary="{summary}"']
        if summary_math:
            attrs.append(f'summaryMath="{summary_math}"')
        if extra_class:
            attrs.append(f'class="{extra_class}"')
        opener = "{{< matrix " + " ".join(attrs) + " >}}"
    return [opener, latex, "{{< /matrix >}}", ""]


CONFIG_COLLAPSE_H11_THRESHOLD = 6   # collapse config matrix when h11 > this
GENERATOR_COLLAPSE_RANK_THRESHOLD = 2  # collapse each generator when rank > this


def _mma_assoc(r: "Record") -> str:
    """Re-serialise a record as a Mathematica association literal (as used in
    the .m download), matching the flat-line format the paper uses."""
    parts = [
        f"Num -> {r.Num}",
        f"H11 -> {r.H11}",
        f"H21 -> {r.H21}",
        f"C2 -> {serialise_field('C2', r.C2)}",
        f"Conf -> {serialise_field('Conf', r.Conf)}",
        f"Favour -> {serialise_field('Favour', r.Favour)}",
        f"KahlerPos -> {serialise_field('KahlerPos', r.KahlerPos)}",
        f"IsProduct -> {serialise_field('IsProduct', r.IsProduct)}",
        f"IsoFlopRows -> {serialise_field('IsoFlopRows', r.IsoFlopRows)}",
        f"KahlerRefGens -> {serialise_field('KahlerRefGens', r.KahlerRefGens)}",
        f"CoxeterMat -> {serialise_field('CoxeterMat', r.CoxeterMat)}",
    ]
    return "<|" + ", ".join(parts) + "|>"


def _record_json(r: "Record") -> str:
    """One-row JSON projection of the Parquet schema — suitable for pasting
    into scripts that consume the database per-row."""
    iso_flop_rows = (
        None
        if r.IsoFlopRows is None
        else [{"row": item["row"], "type": item["type"]} for item in r.IsoFlopRows]
    )
    obj = {
        "Num": r.Num,
        "H11": r.H11,
        "H21": r.H21,
        "C2": r.C2,
        "Conf": r.Conf,
        "Favour": r.Favour,
        "KahlerPos": r.KahlerPos,
        "IsProduct": r.IsProduct,
        "IsoFlopRows": iso_flop_rows,
        "KahlerRefGens": r.KahlerRefGens,
        "CoxeterMat": r.CoxeterMat,
    }
    return json.dumps(obj, ensure_ascii=False)


def _iso_flop_reflections_section(r: Record) -> list[str]:
    rank = len(r.KahlerRefGens)
    # Always wrap every generator in <details>; rank ≤ threshold starts open,
    # higher ranks start closed so a rank-5 page doesn't overwhelm the reader.
    # Summary typography matches the matrix body via KaTeX-rendered `M_k`.
    fold = "open" if rank <= GENERATOR_COLLAPSE_RANK_THRESHOLD else "closed"
    # "Expand/collapse all" toggle renders inside the same flex row as the h2
    # via `cicy-entry__section-head`, so the button adds zero vertical space
    # and the heading-to-matrices spacing matches the other sections. Scoped
    # to the iso-flop generators only (class `is-generator`) so the config
    # matrix's own collapsing state is unaffected.
    starts_expanded = fold == "open"
    initial_label = "Collapse all" if starts_expanded else "Expand all"
    aria = "true" if starts_expanded else "false"
    lines: list[str] = [
        (
            '<div class="cicy-entry__section-head">'
            '<h2 id="iso-flop-reflections">Iso-flop reflections</h2>'
            f'<button type="button" class="cicy-entry__toggle-all" '
            f'data-role="cicy-toggle-generators" aria-expanded="{aria}">'
            f'{initial_label}</button>'
            '</div>'
        ),
        "",
    ]
    for idx, (mat, iso) in enumerate(zip(r.KahlerRefGens, r.IsoFlopRows), start=1):
        summary = f" — iso-flop row {iso['row']}, {iso['type']}"
        lines.extend(
            _matrix_shortcode(
                f"M_{idx} = {latex_pmatrix(mat)}",
                fold=fold,
                summary=summary,
                summary_math=f"M_{idx}",
                extra_class="is-generator",
            )
        )
    return lines


def _coxeter_diagram_section(r: Record, meta: dict) -> list[str]:
    svg = coxeter_diagram_svg(r.CoxeterMat, r.Num)
    type_display = meta.get("type_display") or ""
    type_label = meta.get("type_label") or ""
    kind = meta.get("coxeter_kind") or ""
    caption_bits: list[str] = []
    if type_display:
        caption_bits.append(f"<strong>{type_display}</strong>")
    if kind:
        caption_bits.append(f"<em>{kind}</em>")
    if type_label:
        caption_bits.append(
            f'<a href="/cicy-coxeter/#shape-{type_label}">see in gallery</a>'
        )
    caption = (
        f'<p class="cicy-entry__diagram-caption">{" &middot; ".join(caption_bits)}</p>'
        if caption_bits
        else ""
    )
    lines = [
        "## Coxeter diagram",
        "",
        f'<div class="cicy-entry__diagram-wrap">{svg}</div>',
    ]
    if caption:
        lines.append(caption)
    lines.append("")
    return lines


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


def render_markdown_stub(r: Record, meta: dict | None = None) -> str:
    lines: list[str] = []
    lines.append("+++")
    lines.append(f'title = "CICY {r.Num}"')
    lines.append(f"num = {r.Num}")
    lines.append(f"h11 = {r.H11}")
    lines.append(f"h21 = {r.H21}")
    lines.append("+++")
    lines.append("")

    lines.append("## Second Chern class")
    lines.append("")
    lines.append("Intersections \\\\(c_2(X)\\cdot D_i\\\\) in the favorable divisor basis:")
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
    rows = len(r.Conf)
    cols = len(r.Conf[0]) if r.Conf else 0
    if r.H11 > CONFIG_COLLAPSE_H11_THRESHOLD:
        conf_fold = "closed"
        conf_summary = f"Configuration matrix ({rows}×{cols}, h¹¹={r.H11})"
    else:
        conf_fold = ""
        conf_summary = ""
    lines.extend(_matrix_shortcode(
        latex_configuration_matrix(r.Conf, r.H11, r.H21, r.Num),
        fold=conf_fold,
        summary=conf_summary,
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
            lines.extend(_coxeter_diagram_section(r, meta or {}))
            lines.extend(_coxeter_matrix_section(r))

    lines.append("## Database record")
    lines.append("")
    lines.append(
        "Three equivalent serialisations of this entry. Use the <em>Copy</em> "
        "button on each block to grab the text verbatim."
    )
    lines.append("")

    plain_text_lines = [
        f"Num           : {r.Num}",
        f"H11           : {r.H11}",
        f"H21           : {r.H21}",
        f"C2            : {serialise_field('C2', r.C2)}",
        f"Conf          : {serialise_field('Conf', r.Conf)}",
        f"Favour        : {serialise_field('Favour', r.Favour)}",
        f"KahlerPos     : {serialise_field('KahlerPos', r.KahlerPos)}",
        f"IsProduct     : {serialise_field('IsProduct', r.IsProduct)}",
        f"IsoFlopRows   : {serialise_field('IsoFlopRows', r.IsoFlopRows)}",
        f"KahlerRefGens : {serialise_field('KahlerRefGens', r.KahlerRefGens)}",
        f"CoxeterMat    : {serialise_field('CoxeterMat', r.CoxeterMat)}",
    ]
    lines.append(
        '{{< copyable label="Plain text (.txt source format)" lang="text" >}}'
    )
    lines.extend(plain_text_lines)
    lines.append("{{< /copyable >}}")
    lines.append("")

    lines.append(
        '{{< copyable label="Mathematica association" lang="mathematica" >}}'
    )
    lines.append(_mma_assoc(r))
    lines.append("{{< /copyable >}}")
    lines.append("")

    lines.append('{{< copyable label="JSON (one-row)" lang="json" >}}')
    lines.append(_record_json(r))
    lines.append("{{< /copyable >}}")
    lines.append("")

    return "\n".join(lines)


def write_markdown_stubs(
    records: list[Record], out_dir: Path, page_meta: dict | None = None
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in out_dir.glob("*.md") if p.name != "_index.md"}
    written: set[str] = set()
    for r in records:
        target = out_dir / f"{r.Num}.md"
        meta = page_meta.get(str(r.Num)) if page_meta is not None else None
        target.write_text(
            render_markdown_stub(r, meta), encoding="utf-8", newline="\n"
        )
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
    page_meta = target_root / PAGE_META_OUT.relative_to(ROOT)
    # Compute page_meta up-front so the markdown stubs can embed
    # per-model metadata (type label, gallery link, etc.) that the layout
    # also surfaces from the same JSON sidecar.
    meta_map = compute_page_meta(records)
    write_parquet(records, parquet)
    write_schema(schema)
    write_markdown_stubs(records, content, page_meta=meta_map)
    write_gallery(records, gallery)
    write_chart_data(records, chart_data)
    _write_json(meta_map, page_meta)


def check_mode() -> int:
    if not PARQUET_OUT.exists() or not SCHEMA_OUT.exists() or not GALLERY_OUT.exists() or not CHART_DATA_OUT.exists() or not PAGE_META_OUT.exists():
        print("ERROR: expected outputs are missing; run the script without --check first.")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        (tmp_root / "static" / "cicy-coxeter").mkdir(parents=True)
        (tmp_root / "content" / "english" / "cicy-coxeter").mkdir(parents=True)
        (tmp_root / "data" / "cicy_coxeter").mkdir(parents=True, exist_ok=True)
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
            PAGE_META_OUT.relative_to(ROOT),
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
    print(f"Wrote {PAGE_META_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
