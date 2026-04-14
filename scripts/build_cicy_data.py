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
    lines.append(f"- Hodge numbers: $h^{{1,1}} = {r.H11}$, $h^{{2,1}} = {r.H21}$")
    lines.append(f"- Favourable presentation: `{r.Favour}`")
    lines.append(f"- Kahler-favourable: `{r.KahlerPos}`")
    lines.append(f"- Direct product: `{r.IsProduct}`")
    lines.append("")
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
        parsed = render_parsed_block(by_num[num])
        match = "match" if src.strip() == parsed.strip() else "DIFFERS"
        parts.append(f"\n## CICY #{num} — {match}\n")
        parts.append("### Source (raw .txt)\n")
        parts.append("```\n" + src + "```\n")
        parts.append("### Parsed (re-serialised from Parquet row)\n")
        parts.append("```\n" + parsed + "```\n")
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
    write_parquet(records, parquet)
    write_schema(schema)
    write_markdown_stubs(records, content)


def check_mode() -> int:
    if not PARQUET_OUT.exists() or not SCHEMA_OUT.exists():
        print("ERROR: expected outputs are missing; run the script without --check first.")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        (tmp_root / "static" / "cicy-coxeter").mkdir(parents=True)
        (tmp_root / "content" / "english" / "cicy-coxeter").mkdir(parents=True)
        # Make source reachable relative to tmp_root without copying 4 MB.
        (tmp_root / "static" / "cicy-coxeter" / SOURCE_TXT.name).write_bytes(
            SOURCE_TXT.read_bytes()
        )
        run_build(tmp_root)
        diffs: list[str] = []
        for rel in (
            PARQUET_OUT.relative_to(ROOT),
            SCHEMA_OUT.relative_to(ROOT),
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
