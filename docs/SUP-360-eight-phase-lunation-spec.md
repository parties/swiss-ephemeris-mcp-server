<!--
  Astrology Advisor spec pass for SUP-360, the follow-on named in SUP-357 §7 as "the
  highest-value follow-on here". Advisory: the rulings below are recommendations to
  engineering, not final decisions. Western tropical astrology only.

  Every measured figure in this document was produced on 2026-08-10 against the vendored
  ephemeris (vendor/swisseph) through the shipped lib/event-search.js engine, using only
  test/fixtures/charts.js. No new fixture is required.
-->

# SUP-360 — Eight-phase lunation cycle for `find_events`

## 0. What this rules on

SUP-360 asks for three decisions, all of which SUP-357 §7 deferred:

1. A **flag name and schema** for the eight-phase cycle.
2. Whether **transit-mode** `find_events` lunations get the same treatment (SUP-357 explicitly
   did not rule on this and asked for Astrology Advisor's call).
3. What the **per-rate defaults** should be.

**Prerequisite is clear.** SUP-359 shipped (PR #55, `c5361e3`, merged to `main`), so the
progressed lunation search this builds on exists. The issue text said to wire
`blockedByIssueIds` to SUP-359 "if SUP-359 hasn't shipped by then" — it has, so no blocker is
needed.

**Scale of the change: small.** Every phase boundary is already an exact crossing of the
Sun–Moon relative longitude at a multiple of 45°, and `findLunations` already searches exactly
that quantity via `relativeLunarProvider` + `enumerateCrossings`. The engine change is
extending a two-entry table (`LUNATION_PHASE_ANGLES`, `lib/event-search.js:363`) to eight. The
substance of this ticket is the **parameter surface, the defaults, and four traps in §6** — not
search logic.

---

## 1. The convention, and whether the repo already matches it

The eight-phase soli-lunar cycle is Dane Rudhyar's formulation (*The Lunation Cycle*, 1967,
developing Marc Edmund Jones). It is mainstream Western practice, not a fringe scheme, and it is
the conventional way the progressed Sun–Moon cycle is read. Phases are 45° bands of Moon-minus-Sun
elongation, **each band starting at its exact aspect**:

| Band start | Phase | Aspect at the boundary |
|---|---|---|
| 0° | New | conjunction |
| 45° | Crescent | waxing semisquare |
| 90° | First Quarter | waxing square |
| 135° | Gibbous | waxing sesquiquadrate |
| 180° | Full | opposition |
| 225° | Disseminating | waning sesquiquadrate |
| 270° | Last Quarter | waning square |
| 315° | Balsamic | waning semisquare |

`lib/moon-phase.js` already implements exactly this, with the band-start convention chosen
deliberately over the almanac (band-*centred*) form and documented in its own comment. That is the
right call and nothing here changes it. `PHASE_SCHEME` already reads
`'8-phase, bands start at exact aspect'`.

**This vocabulary is already shipped at the transit rate**, not just conceptually available:
`calculate_planetary_positions` calls `moonPhase(...)` (`index.js:1151`) for an ordinary chart and
returns all eight names. Any ruling that made the eight phases progressed-only would contradict a
tool this server already ships. That settles §4 before we get there.

---

## 2. Ruling A — the four existing event names *are* band starts, so extending to eight is coherent

This needs stating because it is the one thing that could have made the extension a semantic
mixture, and it turns out it doesn't.

There are two ways to name a phase event, and they are not the same idea:

- **Event semantics** — the crossing at 90° *is* "the First Quarter Moon," a named moment.
  This is what `find_events` currently does (`LUNATION_PHASE_ANGLES` / `QUARTER_PHASE_ANGLES`).
- **Ingress semantics** — the crossing at 45° is "the Moon *enters* the Crescent phase." The
  phase named is the one *beginning*.

Under Rudhyar's band-start convention these **coincide exactly at 0/90/180/270**. Verified against
the shipped `phaseFromElongation`:

```
  0deg -> New          45deg -> Crescent       90deg -> First Quarter  135deg -> Gibbous
180deg -> Full        225deg -> Disseminating 270deg -> Last Quarter   315deg -> Balsamic
```

So `find_events`' shipped `new` / `first_quarter` / `full` / `last_quarter` are already precisely
the band starts at 0/90/180/270. Adding the other four extends one consistent scheme; it does not
mix two. **The eight-phase set is a strict superset of the shipped four** — same names, same
datetimes, four new event objects — which is what makes the default change in §3 cheap.

(This coincidence is a property of the band-start convention. Had `lib/moon-phase.js` used the
almanac centred-band form, the exact square at 90° would sit in the *middle* of the First Quarter
band and these two readings would disagree at every boundary. The existing comment in that file is
load-bearing, not decorative.)

---

## 3. Ruling B — parameter surface

**Recommended: a `lunation_phases` enum that supersedes `include_quarter_moons`.**

```jsonc
{
  "lunation_phases": "syzygy" | "quarters" | "eight_phase"
}
```

| Value | Emits | Count |
|---|---|---|
| `"syzygy"` | New, Full | 2 per cycle |
| `"quarters"` | + First Quarter, Last Quarter | 4 per cycle |
| `"eight_phase"` | + Crescent, Gibbous, Disseminating, Balsamic | 8 per cycle |

**Why an enum and not a second boolean.** The obvious cheaper move is to add
`include_eighth_phases: boolean` alongside the shipped `include_quarter_moons`. Two booleans encode
four states, and one of them — `include_quarter_moons: false, include_eighth_phases: true` — is
incoherent: the eight-phase set *contains* the quarters, so the request says "no quarters" and "all
eight phases including the quarters" at once. That forces a silent precedence rule, which is the
exact shape this repo has ruled against twice (SUP-357 §3 made a progression parameter at
`rate: "transit"` an *error* rather than silently ignored). The three states are genuinely ordinal;
an enum says so.

**Back-compat.** `include_quarter_moons` is shipped and documented. Keep it as a deprecated alias
(`true` → `"quarters"`, `false` → `"syzygy"`), and **error if both are supplied**, rather than
defining precedence. Removing it outright is a breaking change and semantic-release would major-bump
for no user benefit.

> **Scope note.** The astrological content here is the three-way *set* distinction and the
> superset relationship. The spelling — `lunation_phases` vs `lunation_phase_set`, `"eight_phase"`
> vs `"eightfold"` — is engineering's call. `lunation_phases` follows the repo's existing
> `orb_model` / `angle_method` / `house_frame` noun-enum style, and `"eight_phase"` echoes the
> `PHASE_SCHEME` string already in `lib/moon-phase.js`.

**Do not add a new `event_types` member.** These stay `lunation` events in `events[]`. A separate
category would split one cycle across two arrays and force consumers to merge them to read it in
order, and it would break anyone passing `event_types: ['lunation']` expecting the whole cycle. The
term `lunation` is already stretched in this tool — a quarter Moon is a quadrature, not a syzygy —
so widening it to the full cycle is consistent with what shipped. Document the widening in the
README.

---

## 4. Ruling C — transit mode: yes to the capability, no to the default

**This is the question SUP-357 §7 flagged as unresolved and asked for. The answer is that the
eight phases are not a progressed-only technique, so the parameter must work at both rates — but
the volume argument that set `include_quarter_moons: false` at the transit rate applies with more
force here, so the transit default stays at syzygy.**

The eight-phase cycle is the ordinary monthly soli-lunar cycle first; the progressed application is
derived from it by analogy. Rudhyar's own presentation is the monthly cycle. Withholding it from
transit-mode `find_events` would also contradict `calculate_planetary_positions`, which already
returns all eight names for an ordinary chart (§1). One server should not claim the Balsamic phase
exists in a natal snapshot but not in a transit search.

Measured for a 1-year transit window (2026), through the shipped engine:

| Setting | Lunation events per year |
|---|---|
| `"syzygy"` | **25** |
| `"quarters"` | **50** |
| `"eight_phase"` | **99** |

The 25 and 50 figures reproduce the README's own shipped claims exactly, and the First/Last Quarter
datetimes reproduce `docs/SUP-349-find-events-spec.md:865-866` to the second — so this measurement
is the shipped engine's own arithmetic, not a parallel implementation.

SUP-349 Q7 set `include_quarter_moons: false` on volume ("~25/yr rather than ~50", "comparatively
little added signal"). At 99 events in a 1-year default window that rationale is stronger, not
weaker. Nobody scans a transit window to be told the Moon entered its Gibbous phase 99 times. **Transit
default: `"syzygy"`** — bit-for-bit the shipped behaviour.

---

## 5. Ruling D — progressed mode defaults to `"eight_phase"`

**Recommended default at `rate: "secondary_progression"`: `"eight_phase"`** (changing SUP-357
ruling #6's `include_quarter_moons: true`, i.e. `"quarters"`).

Measured, `DAY_CHART`, through the shipped engine:

| Window | `"syzygy"` | `"quarters"` | `"eight_phase"` |
|---|---|---|---|
| 90 years | 6 | 12 | **24** |
| 120 years (the spec max) | 8 | 16 | **32** |

The 6 and 12 confirm SUP-357 ruling #6's "~3 New + ~3 Full; with quarters, ~12".

Three reasons the default should move:

1. **The phase reading is the entire point of the progressed lunation cycle.** SUP-357 ruling #6
   already accepted this ("conventionally read *by phase*, not just at syzygy") and then stopped at
   four phases, which delivers half the argument it made. Reading the cycle at quadratures only is a
   truncation of the technique, not a lighter version of it.
2. **Balsamic is the phase practitioners most want dated.** The ~3–4 year pre-New-Moon Balsamic
   phase is among the most-cited progressed phase readings in the literature. It is currently
   unreachable at any setting — there is no parameter that produces it. A progressed lunation search
   whose default output cannot answer "when am I in my Balsamic phase" is missing the headline case.
3. **There is no volume argument.** 24 events over 90 years is ~1 event every 3.75 years. The cost
   is 6 extra `enumerateCrossings` passes over segments that are already computed.

**Migration cost is near zero** because the change is a strict superset (§2): all 12 currently-emitted
events keep identical `phase` values and identical datetimes; 12 new objects appear. Nothing is
renamed, moved, or re-timed. SUP-359 shipped one day before this ruling and nothing external depends
on it yet.

If CEO/engineering prefers not to move a just-shipped default, `"quarters"` remains a defensible
progressed default and `"eight_phase"` is one parameter away. Flagging the preference, not blocking
on it.

---

## 6. Implementation traps

These are the part of this ticket that can produce a silently wrong answer.

### 6.1 Use directed elongation crossings — **never** the aspect matcher

45° and 135° are already in the repo's `MINOR_ASPECTS` (`semisquare`, `sesquiquadrate`,
`lib/aspects.js:13-14`), which makes routing phase detection through `calculate_aspects`/
`matchAspectsForPair` look attractive. **It is wrong**, and wrong in a way that returns
plausible output:

The aspect matcher folds separations to ≤180°, because an aspect is undirected. That collapses
**Crescent (45°) with Balsamic (315°)**, and **Gibbous (135°) with Disseminating (225°)** — it
cannot tell waxing from waning. Four phases would come back as two, each firing twice per cycle
with the wrong name half the time. This is the same failure `lib/moon-phase.js` already warns about
for swetest's `*` column ("folds at 180deg and cannot distinguish waxing from waning").

The correct path is the one `findLunations` already takes: `relativeLunarProvider` works in
directed `[0, 360)` space via `mod360`, and `enumerateCrossings` targets an absolute longitude.
Extending `LUNATION_PHASE_ANGLES` to eight 45° multiples is correct by construction and needs no
new primitive.

**Corollary: `include_minor` must not gate the phase set.** A consumer could reasonably infer
"Crescent is a semisquare, so I need `include_minor: true`". Phase events are not aspect events:
they do not enter `contacts[]`, they carry no orb, and they are exact crossings. The two parameters
must be fully independent. Worth an explicit test.

### 6.2 Two phase vocabularies exist — don't put the display one on the wire

`lib/moon-phase.js` returns Title Case with spaces (`'First Quarter'`). `find_events` emits
lowercase snake_case (`'first_quarter'`). Reusing `phaseFromElongation` directly to label events
would silently flip shipped `find_events` output from `first_quarter` to `First Quarter` — a
breaking change to an existing field, and one no existing test would catch since no test asserts
`find_events` phase strings against `moon-phase.js`.

Keep `find_events`' snake_case on the wire. If the two are wired together, put a mapping at the
seam. Recommend echoing `PHASE_SCHEME` in `settings_used` so consumers can tell which banding
convention produced the names.

### 6.3 Eclipse annotation is already safe — don't "fix" it

`annotateEclipses` (`lib/event-search.js:405`) selects candidates with
`phase === 'new' ? solar : phase === 'full' ? lunar : []`. The `: []` catch-all already covers the
quarters and will cover the four new phases with no change. Adding new phase names to that
conditional would be a bug. (At `rate: "secondary_progression"` the whole call is skipped anyway,
per SUP-357 §1.1.)

### 6.4 The eight phases are **not** evenly spaced in time

`29.31 / 8 = 3.66` years per phase is a *mean*, and asserting it will fail. Measured successive
phase-step intervals for `DAY_CHART` range **3.219 to 4.114 years** — a 24% spread — because the
progressed Moon inherits the real Moon's anomalistic speed variation (11.8–14.6 °/day of ephemeris
time becomes the same range per year of life).

Related, and worth recording so nobody files it as a defect: **SUP-357 §6.3's "progressed lunation
cycle 29.31 yr" is a mean-*rate* figure, not a syzygy-to-syzygy interval.** It is
`360 / (13.2917 − 1.0076) = 360 / 12.284 = 29.306`. The actual measured New-to-New intervals for
`DAY_CHART` are **29.566** and **29.454** years (mean 29.51). Both numbers are correct for their
own estimator and SUP-357 is not wrong; but a SUP-360 test asserting successive New Moons are
29.31 years apart will fail. Assert the arc-derived figure against the arc, or assert the observed
intervals against the observed values below.

### 6.5 Scan step and segmentation are unchanged

No re-derivation needed. Verified at both rates: the Sun–Moon relative provider yields **zero
stations** over a 90-year progressed window and over a 1-year transit window, confirming
`relativeLunarProvider`'s claim that its speed never reaches zero, so lunations need no
segmentation at either rate. The coarse step stays SUP-357 §1.2's ruling — `yearLengthDays` of
target time in progressed mode (`index.js:1846`), 1 day in transit mode. Extending the target-angle
table from 2 to 8 does not touch the scan: the segments are the same segments, and
`enumerateCrossings` simply runs 8 times instead of 2.

---

## 7. Test expectations

`DAY_CHART` (1990-01-01T12:00:00Z, Greenwich), `rate: "secondary_progression"`,
`lunation_phases: "eight_phase"`, window 1990-01-01 → 2080-01-01. Measured through the shipped
engine, 2026-08-10. Complete and exhaustive — exactly 24 events, in this order:

| # | phase | elongation | life date | age | progressed Moon λ |
|---|---|---|---|---|---|
| 1 | `first_quarter` | 90° | 1992-12-12T00:26:00Z | 2.945 | 13.8160 |
| 2 | `gibbous` | 135° | 1996-04-29T03:52:26Z | 6.324 | 62.2594 |
| 3 | `full` | 180° | 1999-09-16T14:07:28Z | 9.706 | 110.7054 |
| 4 | `disseminating` | 225° | 2003-05-12T14:08:09Z | 13.359 | 159.4250 |
| 5 | `last_quarter` | 270° | 2007-05-22T23:06:56Z | 17.387 | 208.5266 |
| 6 | `balsamic` | 315° | 2011-06-28T10:31:00Z | 21.487 | 257.6996 |
| 7 | `new` | 0° | 2015-04-23T03:58:13Z | 25.306 | 306.5840 |
| 8 | `crescent` | 45° | 2018-11-06T19:44:10Z | 28.847 | 355.1837 |
| 9 | `first_quarter` | 90° | 2022-04-10T18:47:49Z | 32.273 | 43.6606 |
| 10 | `gibbous` | 135° | 2025-09-19T01:10:07Z | 35.715 | 92.1506 |
| 11 | `full` | 180° | 2029-04-21T11:11:47Z | 39.303 | 140.7832 |
| 12 | `disseminating` | 225° | 2033-03-04T15:23:32Z | 43.172 | 189.6952 |
| 13 | `last_quarter` | 270° | 2037-04-14T06:34:25Z | 47.283 | 238.8465 |
| 14 | `balsamic` | 315° | 2041-04-09T18:09:24Z | 51.271 | 287.8675 |
| 15 | `new` | 0° | 2044-11-14T17:53:55Z | 54.871 | 336.4924 |
| 16 | `crescent` | 45° | 2048-03-21T07:08:09Z | 58.218 | 24.8570 |
| 17 | `first_quarter` | 90° | 2051-08-03T14:44:40Z | 61.587 | 73.2368 |
| 18 | `gibbous` | 135° | 2055-02-26T09:23:09Z | 65.154 | 121.8085 |
| 19 | `full` | 180° | 2058-12-16T14:43:47Z | 68.957 | 170.6089 |
| 20 | `disseminating` | 225° | 2062-12-28T14:15:05Z | 72.990 | 219.6300 |
| 21 | `last_quarter` | 270° | 2067-02-08T07:17:25Z | 77.104 | 268.7241 |
| 22 | `balsamic` | 315° | 2070-12-06T14:42:04Z | 80.930 | 317.5236 |
| 23 | `new` | 0° | 2074-04-29T15:07:30Z | 84.325 | 5.8892 |
| 24 | `crescent` | 45° | 2077-07-18T10:04:08Z | 87.544 | 54.0745 |

Required assertions beyond the table:

- **§7.1 Superset invariant (the headline test).** For the same request at `"quarters"` and
  `"eight_phase"`, every event the `"quarters"` run returns must appear in the `"eight_phase"` run
  with an identical `phase` **and an identical `datetime`**. This is what proves the extension did
  not re-time or rename anything, and it is the test that would catch a regression from any future
  banding-convention change.
- **§7.2 Waxing/waning distinction (guards §6.1).** Assert `crescent` (45°) and `balsamic` (315°)
  are distinct events at distinct dates, and likewise `gibbous` (135°) and `disseminating` (225°).
  A folded-aspect implementation passes every count test and fails this one. Rows 6 vs 8 and 4 vs 2
  above are the concrete pairs.
- **§7.3 `include_minor` independence (guards §6.1 corollary).** Identical lunation output at
  `include_minor: true` and `false`, for all three `lunation_phases` values.
- **§7.4 Transit-rate counts and default.** 1-year 2026 window: 25 / 50 / 99 events at
  `"syzygy"` / `"quarters"` / `"eight_phase"`. Default with no parameter must be 25 (unchanged
  shipped behaviour, §4).
- **§7.5 Uneven spacing (guards §6.4).** Successive phase-step intervals span 3.219–4.114 years;
  assert min and max rather than a uniform 3.66.
- **§7.6 Structural.** No progressed lunation carries an `eclipse` key at any
  `lunation_phases` value (extends SUP-357 §6.6 to the four new phases). Supplying both
  `include_quarter_moons` and `lunation_phases` errors (§3).
- **§7.7 Wire vocabulary (guards §6.2).** Assert `find_events` emits `first_quarter`, not
  `First Quarter`, at every setting.

---

## 8. Out of scope

| Deferred | Why |
|---|---|
| **Phase of an arbitrary moment** (i.e. "what phase is the progressed Moon in *now*") | This ticket dates phase *boundaries*. A point-in-time progressed phase belongs on `calculate_secondary_progressions`, which already has the natural home for it and already imports the vocabulary. File separately if wanted. |
| **Almanac (band-centred) phase scheme as an option** | `lib/moon-phase.js` deliberately rejected it. Offering both would let two conventions disagree inside one server for no astrological gain. |
| **Phase applied to non-lunar pairs** (e.g. Sun–Saturn phase cycles) | A real Rudhyar-lineage technique, but a distinct search and a distinct reading. No request on file. |
| **Progressed-to-progressed aspects beyond the lunation** | Already filed as SUP-361. |

---

## 9. Conventions

Repo `CLAUDE.md`: no real birth data — every figure above comes from `test/fixtures/charts.js`
(`DAY_CHART`). PR title must independently satisfy Conventional Commits. Never hand-edit
`CHANGELOG.md` or the `version` field in `package.json`.

Western tropical only. Nothing above depends on a sidereal, ayanamsa, Vedic or Hellenistic variant,
and none are in scope for this server.
