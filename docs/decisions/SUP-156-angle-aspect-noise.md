# SUP-156: Angle aspect noise — reasoning and decisions

## Problem

`include_angles` (and `angle_aspects` in synastry) treated Ascendant, Midheaven, IC, and
Descendant as four independent bodies for aspect matching, all using the same wide `body`-class
orbs (8° major / 6° sextile) as planets. This produced two kinds of noise in `aspects` /
`synastry_aspects` output:

1. **Mirrored double-counting.** IC and Descendant are not independent chart points — they are
   defined as `IC = Midheaven + 180°` and `Descendant = Ascendant + 180°`. Any body square the
   Ascendant is, by the same separation, also square the Descendant; any body conjunct the
   Midheaven is also opposite the IC. Aspecting all four angles therefore reported every genuine
   axis contact twice, under two different labels, inflating aspect counts and confusing anything
   downstream that counted or scored aspects per point.
2. **Overly wide default orbs on sensitive points.** Angles, Part of Fortune, and (in anticipation
   of GH #6) Vertex are derived/sensitive points, not luminaries or planets. Giving them the same
   8°/6° orb as a planet-to-planet aspect is not standard practice and produced marginal,
   low-significance "aspects" that a working astrologer would not read as active.

Two PRs landed against this ticket, in this order:

- `0a3526c` — introduced an orb-class engine seam (`ORB_CLASSES`, `BODY_ORB_CLASS`) with `body`
  and `point` classes. `point` started as a byte-identical copy of `body`'s orbs — this commit
  changed no output, only added the seam so the next commit could populate real numbers without a
  structural change landing in the same diff as a behavioral one.
- `c5463af` — gave the `point` class real, tighter numbers and assigned Ascendant, Midheaven, IC,
  Descendant, Part of Fortune, and Vertex to it. Also fixed `orb_overrides` key validation at the
  tool boundary, which had been rejecting the per-class `{point: {...}}` shape before it ever
  reached the engine.
- `5402e87` (SUP-159, filed as a follow-on once the orb work surfaced the double-counting) —
  scoped aspect pair-matching (`ASPECTABLE_ANGLES`) to Ascendant, Midheaven, and Part of Fortune
  only. IC and Descendant remain in `ANGLE_BODIES` and are still returned as computed chart points
  by `include_angles`; they are simply excluded from ever entering aspect matching.

All three merged together as PR #17 ("SUP-156"), plus `3bc2f0d` documenting both as breaking
changes in `CHANGELOG.md` and `README.md`.

## Decision 1 — Point-class orbs: 3° major / 2° sextile

**What changed:** Ascendant, Midheaven, IC, Descendant, Part of Fortune, and Vertex now resolve
orbs from a `point` class (3° for conjunction/opposition/trine/square, 2° for sextile) instead of
the `body` class (8°/6°). Minor-aspect orbs are unchanged for both classes.

**Astrological justification:**

- There is no single universally-published orb table — orb size is one of the more
  practitioner-dependent parameters in the field — but mainstream Western tropical sources
  (Lilly-derived tables via modern software conventions: Solar Fire, Astro-Databank orb defaults,
  most contemporary teaching texts) consistently draw a line between **luminary/planet-to-planet**
  orbs (routinely 6–10° for conjunction/opposition/square/trine with the Sun and Moon, 4–8° for
  planet pairs) and **angle/derived-point** orbs, which are conventionally tighter — commonly cited
  in the 1–3° range for Ascendant/Midheaven contacts, and Part of Fortune is near-universally
  treated as tight (often ≤3°) because it is itself a computed/sensitive degree rather than a body
  with physical presence.
- The prior 8°/6° default was simply the planetary `body` default applied unchanged to angles —
  not a deliberate choice for those points, an artifact of the angles being bolted onto the
  existing body list without their own orb treatment. That is the "sensible default that's
  actually wrong" pattern: reusing the planet orb table for angles is not standard tropical
  practice, and 3°/2° is a defensible, conservative middle of the ranges practitioners actually
  use, not an invented number.
- Including Vertex in the `point` class ahead of its own opt-in flag (tracked separately in
  GH #6) was a forward-compatibility choice: Vertex is astrologically the same category of point
  as the angles (a derived sensitive point, not a body), so when it ships it should not silently
  inherit the wrong orb class by omission.
- **Caveat for future readers:** orb width is genuinely a matter of practitioner convention, not a
  single settled standard the way the Part of Fortune day/night formula is. If a future ticket
  wants to move these numbers, that's a legitimate discussion — but it should stay a `point`-class
  discussion, not a reversion to reusing `body`'s numbers for angles.

**Engineering justification:** landing the orb-class seam (`0a3526c`) as a no-op before the
numbers changed (`c5463af`) isolates the structural risk (new resolution path, `orb_overrides`
per-class shape) from the behavioral risk (different orbs → different aspect sets in existing
integration tests) into two reviewable, bisectable commits.

## Decision 2 — Aspect only ASC/MC/PoF; exclude DSC/IC as axis mirrors

**What changed:** `ASPECTABLE_ANGLES` narrows aspect pair-matching to Ascendant, Midheaven, and
Part of Fortune. `ANGLE_BODIES` still includes IC and Descendant, so they remain in positional
output (`chart_points`, `include_angles` output) — they just never appear in `aspects` /
`angle_aspects` / `synastry_aspects` entries.

**Astrological justification:**

- This is not a convention judgment call, it's arithmetic: `IC = Midheaven + 180°` and
  `Descendant = Ascendant + 180°` by definition, in every house system this server supports (the
  four angles are always two axis pairs, regardless of Placidus/Koch/Whole Sign/etc — the axis
  geometry doesn't depend on house division method). A body's separation from the Descendant is
  therefore always exactly `180° − (separation from Ascendant)`, and aspect angles map through that
  180° shift in a fixed way: conjunction ↔ opposition, sextile ↔ trine, square ↔ square (square is
  self-complementary at 180° shift since 180 − 90 = 90).
- Reporting a body's contact to both ends of the same axis under different aspect labels
  (e.g. "square Ascendant" and "square Descendant" for the same body at the same moment) is not
  two findings, it's one finding stated twice. No mainstream aspect-table convention treats
  IC/Descendant as independent aspectable points distinct from MC/Ascendant for this reason —
  where software does report all four, it's typically clearly presenting them as the same axis
  contact restated, not as four independent nodes competing for orb budget.
- Choosing to keep ASC/MC/PoF (not, say, MC/IC) as the "aspected" representatives follows the more
  common convention of leading with Ascendant and Midheaven as the primary angle labels in aspect
  tables and orb discussions; Part of Fortune isn't part of that axis-mirror pair at all (it has no
  antiscion-style mirror body among the four), so it was never in question — it just needed the
  tighter point-class orb from Decision 1.
- The 180°-shift derivation table published in the README (Conjunction↔Opposition,
  Sextile↔Trine, Square unchanged) is exact, not approximate, given the axis identities above — a
  client that needs a body's IC or Descendant contact can always recover it losslessly from the
  returned MC/Ascendant aspect.

**Engineering justification:** keeping IC/Descendant in `ANGLE_BODIES` (positional output) while
removing them from `ASPECTABLE_ANGLES` (aspect matching) avoids a breaking change to
`chart_points`/`include_angles` positional data — only the aspect arrays change shape. This was
filed as its own ticket (SUP-159) once the orb-class work in this ticket surfaced the
double-counting, rather than folded silently into the orb change, so the two behavioral changes
each have their own rationale and their own CHANGELOG entry.

## Where this judgement comes from

The orb-class split (Decision 1) draws on general Western tropical practitioner convention around
angle/derived-point orbs being tighter than planet-to-planet orbs — there is no single canonical
source, and the specific degree values (3°/2°) are a defensible choice within observed practice
ranges, not a citation from one authority. Treat the exact numbers as revisitable if a future
ticket brings a specific, better-sourced convention.

The axis-mirror exclusion (Decision 2) is not a convention call at all — it follows directly from
the fixed geometric identities `IC = MC + 180°` and `Descendant = Ascendant + 180°`, which hold
regardless of house system. Any future change here would need a reason to *want* duplicate
same-axis reporting, not a different astrological convention.

## Pointers

- Astrological review: Astrology Advisor agent (SUP-167 parent context), Western tropical scope
  only — see `AGENTS.md` for the advisory role and mandate.
- Code: `lib/aspects.js` (`ORB_CLASSES`, `BODY_ORB_CLASS`, `ANGLE_BODIES`, `ASPECTABLE_ANGLES`).
- Docs: `README.md` → [Angle Aspects](../../README.md#angle-aspects), `CHANGELOG.md` →
  "2026-07-26" entries.
- History: commits `0a3526c`, `c5463af`, `5402e87`, `3bc2f0d`, merged as PR #17
  (`fix: tighter point-class orbs and single-axis angle aspecting (SUP-156)`); the axis-mirror
  exclusion was tracked as a follow-on ticket, SUP-159.
