+++
title = "CICY Coxeter Database"
description = "An interactive explorer for the Coxeter symmetries of Kähler-favorable complete intersection Calabi–Yau threefolds."
math = true

# Emit every per-model page twice: the canonical /cicy-coxeter/<N>/ (polished
# template) and /cicy-coxeter/<N>/legacy/ (frozen previous style) so results
# can be compared side-by-side during polishing rounds. Temporary — remove
# this block together with the `legacy` output format and the legacy layouts
# (see CLAUDE.md §"Legacy style — scheduled for removal").
[[cascade]]
  outputs = ["html", "legacy"]
  [cascade._target]
    kind = "page"
+++

Companion database to the paper *Kaleidoscopes, Waves and the Prepotential* by
Rafael Álvarez-García and Fabian Ruehle. It extends the favorable-CICY dataset
of [Anderson–Gray–Lukas–Palti](https://arxiv.org/abs/1707.01214) with the
Coxeter-group data arising from **isomorphic flops**, surfacing the 4874
Kähler-favorable entries as a browseable explorer.

{{< cicy-stats >}}

<aside class="cicy-featured" aria-label="Featured examples from the paper">
<p><strong>From the paper.</strong> Jump to
<a href="/cicy-coxeter/6771/">CICY 6771</a>
(hyperbolic \(I_2(\infty)\) — §3 running example),
<a href="/cicy-coxeter/6971/">CICY 6971</a>
(parabolic \(I_2(\infty)\)), or
<a href="/cicy-coxeter/5528/">CICY 5528</a>
(elliptic \(I_2(4)\)).</p>
</aside>

<nav class="cicy-jumpnav" aria-label="On this page">
  <a href="#downloads">Downloads</a>
  <a href="#charts">Charts</a>
  <a href="#gallery">Gallery</a>
  <a href="#explorer">Explorer</a>
</nav>

## Downloads

The full database is available in three formats:

- [Wolfram Mathematica](CICY-Coxeter-Database.m) — association list; the
  canonical form used in the companion paper.
- [Plain text](CICY-Coxeter-Database.txt) — one record per block, one
  `Key : Value` per line.
- [Parquet](cicy-coxeter.parquet) — derived columnar artefact that powers the
  Explorer below; the
  [schema](cicy-coxeter.schema.json) lists all columns.

Indices run \\(1,\dots,7890\\), matching the original CICY list of
Candelas–Dale–Lütken–Schimmrigk; the \\(4874\\) Kähler-favorable entries carry
a full Coxeter-data record, and the rest hold `NonKahlerPos` sentinels.

### Citing this database

If you use the database or the explorer, please cite the companion paper:

<p class="cicy-cite__plain">
Álvarez-García, R. &amp; Ruehle, F.
<em>Kaleidoscopes, Waves and the Prepotential.</em>
<a href="/publications/kaleidoscopes-waves-prepotential/">Preprint, 2026</a>
(arXiv:<code>TBA</code>).
</p>

<details class="cicy-cite__bibtex">
<summary>BibTeX</summary>

```bibtex
@article{AlvarezGarciaRuehle2026Kaleidoscopes,
  author  = {\'Alvarez-Garc\'ia, Rafael and Ruehle, Fabian},
  title   = {Kaleidoscopes, Waves and the Prepotential},
  year    = {2026},
  eprint  = {TBA},
  archivePrefix = {arXiv},
  url     = {https://algarafa.com/publications/kaleidoscopes-waves-prepotential/}
}
```

</details>
