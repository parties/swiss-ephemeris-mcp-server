# Changelog

## Unreleased

### Breaking changes

This project has no published version tags yet, so the changes below are recorded plainly by
date rather than as a SemVer release. (`package.json` currently reads `1.0.2`; no SemVer bump is
implied by this entry.)

- **2026-07-26 — Tighter point-class orbs.** Derived/sensitive points (Ascendant, Midheaven, IC,
  Descendant, Part of Fortune, Vertex) now use narrower default orbs for major aspects: 3° for
  conjunction/opposition/trine/square and 2° for sextile, down from the `body` class's 8°/6°.
  Minor-aspect orbs are unchanged. This affects `calculate_aspects`, `calculate_synastry`, and
  `calculate_transits` — any client relying on the old wider defaults for these points should pass
  an explicit `orb_overrides.point` to restore prior behavior. See the [Angle Aspects](README.md#angle-aspects)
  and per-tool `orb_overrides` docs in `README.md`.

- **2026-07-26 — Single-axis angle aspecting.** `angle_aspects` (`calculate_synastry`) and
  `aspects` with `include_angles` (`calculate_aspects`) now only ever aspect the Ascendant,
  Midheaven, and Part of Fortune. IC and Descendant are excluded from aspect pair-matching because
  they are mathematical mirrors of Midheaven and Ascendant (`IC = MC + 180°`,
  `Descendant = Ascendant + 180°`); aspecting all four double-counted every axis contact under two
  labels. IC and Descendant are still returned as computed chart points (`chart_points` /
  `include_angles` positional output) — they are just never aspected. See
  [Angle Aspects](README.md#angle-aspects) in `README.md` for the derivation mapping (conjunction
  ↔ opposition, sextile ↔ trine, square stays square) if you need a body's IC/Descendant aspect.

- **2026-07-26 — `point` orb class split into `angle` and `derived` (corrects the same-day
  point-class entry above, SUP-168).** The single `point` orb class combined two categories with
  opposite orb rationales and, combined with the single-axis angle aspecting above, made
  IC/DSC-derivable contacts lossy: `point` sextile (2°) ≠ trine (3°), so a body 2.5° off a
  sextile-to-Ascendant was dropped even though the identical contact as a trine-to-Descendant
  (3°) would have qualified before DSC was excluded from aspecting. `point` also let minors
  (quincunx 3°) outrank majors (sextile 2°) on the same point. `point` is now two classes:
  `angle` (Ascendant, Midheaven, IC, Descendant — 5°/4°/3°/1.5°/1.5°/1° for
  conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/
  quintile-biquintile, mirror-symmetric by construction and enforced by a unit test) and
  `derived` (Part of Fortune, Vertex — 3°/2°/2°/1° for conjunction-opposition/square/
  trine-sextile/all minors). Minors were swept down with majors in both classes to restore
  major-wider-than-minor ordering everywhere. **`orb_overrides.point` no longer exists — callers
  must use `orb_overrides.angle` and/or `orb_overrides.derived`.** This is the third breaking
  change to these defaults (after the two entries above) and is caller-visible. See
  [Angle Aspects](README.md#angle-aspects) and the per-tool `orb_overrides` docs in `README.md`,
  and `docs/decisions/SUP-156-angle-aspect-noise.md` for the full defect writeup.
