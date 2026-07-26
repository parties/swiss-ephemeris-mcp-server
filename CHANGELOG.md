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
