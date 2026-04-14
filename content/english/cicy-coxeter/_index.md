+++
title = "CICY Coxeter Database"
description = "An interactive explorer for the Coxeter symmetries of Kähler-favourable complete intersection Calabi–Yau threefolds."
math = true
+++

Companion database to the paper *Kaleidoscopes, Waves and the Prepotential* by
Rafael Álvarez-García and Fabian Ruehle. It augments the favourable-CICY
dataset of [Anderson–Gray–Lukas–Palti](https://arxiv.org/abs/1707.01214) with
Coxeter-group data arising from **isomorphic flops**.

Indices run $1,\dots,7890$, matching the original CICY list of
Candelas–Dale–Lütken–Schimmrigk; the $4874$ Kähler-favourable entries carry a
full Coxeter-data record, and the rest hold `NonKahlerPos` sentinels.

The explorer below streams a Parquet view of the database into your browser
via [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview); filtering runs
entirely client-side. Each matching row links to the dedicated page for that
CICY, where the raw database record is displayed verbatim.

**Downloads.** The full database is available as
[Wolfram Mathematica](CICY-Coxeter-Database.m) and
[plain text](CICY-Coxeter-Database.txt), and as the derived
[Parquet artefact](cicy-coxeter.parquet) this page uses
(see also the [schema](cicy-coxeter.schema.json)).
