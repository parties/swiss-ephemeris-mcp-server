<!--
  Astrology Advisor spec pass for SUP-361, the follow-on named in SUP-357 §7 ("Two moving
  bodies... a distinct search and a distinct reading. File separately."). Advisory: the
  rulings below are recommendations to engineering, not final decisions. Western tropical
  astrology only.

  Every measured figure in this document was produced on 2026-08-11 against the vendored
  ephemeris (vendor/swisseph) through the shipped lib/event-search.js engine and
  lib/progressed-provider.js, using only test/fixtures/charts.js (DAY_CHART). No new
  fixture is required.
-->

# SUP-361 — Progressed-to-progressed (and transit-to-transit) pair aspects for `find_events`

## 0. What this rules on

Everything shipped so far searches **one moving point against one fixed point**: `contacts[]` is
moving body → *natal* point. SUP-361 asks for the other shape — **two moving points** — for
aspects other than the progressed Sun–Moon lunation.

The issue's own framing is right and worth confirming before anything else: **no new engine
primitive is needed.** Two-moving-body composition already ships twice — `relativeLunarProvider`
(`lib/event-search.js:345`) for lunations, and `relativeMovingProvider` (`index.js:363`) for
`house_frame: "progressed"`. Everything below was measured by composing the *shipped* providers
exactly the way an implementation would, so this is a surface/defaults/semantics ruling, not a
feasibility study.

Four questions have to be answered, and the first one is the whole ticket:

1. **Which pairs are even eligible** — most of them are astrologically dead, and the ones that are
   dead are dead *structurally*, not just quietly.
2. **Parameter surface and defaults.**
3. **Output shape** — a P-P row has no natal point, so it cannot reuse `contacts[]`' keys.
4. **What happens to the progressed Sun–Moon pair**, which the lunation search already covers.

---

## 1. The convention

Progressed-to-progressed aspects are ordinary Western secondary-progression practice — "progressed
Venus conjunct progressed Mars," "progressed Mercury square progressed Saturn" — and they are read
as a distinct layer from progressed-to-natal contacts: a progressed-to-natal contact says the
life has arrived at a birth promise, a progressed-to-progressed contact says two currently-unfolding
strands have met. The progressed Sun–Moon cycle (already shipped as `lunation` at
`rate: "secondary_progression"`) is the best-known member of the family, not an exception to it.

The transit-rate analogue is equally mainstream and is what mundane astrology is largely made of:
the Jupiter–Saturn conjunction, the Saturn–Pluto cycle, the Uranus–Pluto square. Those are
transit-to-transit aspects, involving no natal chart at all. §6 rules on them.

So the technique is real at both rates. **What is not conventional is searching every pair** — and
that is where this ticket's substance is.

---

## 2. Ruling A — eligibility is a *relative rate* question, and it splits cleanly into three tiers

An aspect between two moving points changes only at the **difference** of their rates. At the
progressed rate, that difference collapses to near zero for most pairs: the two bodies keep their
natal separation for the whole life, so the pair either sits in orb from birth to death without
ever perfecting, or never comes near. Neither is an event.

Measured, `DAY_CHART`, 90 years of life, all 66 pairs of the 12 aspectable movers (mean relative
rate = relative arc ÷ 90 yr; "1° envelope" = how long the pair takes to cross a ±1° orb):

| Tier | Pairs | Relative rate (°/yr of life) | 1° orb envelope |
|---|---|---|---|
| **Moving** | every pair containing the **Moon** (11) | 12.28 – 13.33 | **0.2 yr** |
| **Slow but alive** | Sun/Mercury/Venus/Mars pairs, and those against outers (30) | 0.016 – 1.04 | 1.9 – 123 yr |
| **Structurally frozen** | every outer × outer pair (25) | 0.0027 – 0.13 | **15 – 735 yr** |

Worked extremes from the frozen tier: Uranus–Neptune 0.0140 °/yr (143-year envelope),
Jupiter–Chiron 0.0076 °/yr (263 years), Jupiter–North Node 0.0027 °/yr (735 years). A search over
those returns one row per aspect they happen to be near at birth, with `enters_orb` and
`leaves_orb` both pinned to the window edges and `passes: []` — a natal fact reported as a
lifelong event.

Exact contact counts for the ten pairs of the progressed default moving set
(`Sun, Moon, Mercury, Venus, Mars`), measured through `scanTransitingBody` + `findContacts`,
major aspects at the shipped progressed orb (`orb_model: "fixed"`, 1°), 90-year window:

| Pair | Rel. rate °/yr | Folded separation range | Rel. stations | Orb episodes | Exact passes |
|---|---|---|---|---|---|
| Sun–Moon | 12.2841 | 1.69 – 179.51 | 0 | 25 | 25 |
| Moon–Mercury | 12.3003 | 0.85 – 176.69 | 0 | 25 | 25 |
| Moon–Venus | 13.0825 | 2.14 – 178.94 | 0 | 27 | 27 |
| Moon–Mars | 12.5640 | 1.58 – 179.60 | 0 | 26 | 26 |
| Sun–Venus | 0.7984 | 0.73 – **46.46** | 1 | 1 | 1 |
| Mercury–Venus | 0.7822 | 0.59 – 59.85 | 1 | 2 | 1 |
| Sun–Mars | 0.2800 | 30.81 – 56.01 | 0 | **0** | 0 |
| Mercury–Mars | 0.2638 | 14.24 – 69.41 | 1 | 1 | 1 |
| Venus–Mars | −0.5184 | 5.77 – 56.22 | 1 | **0** | 0 |
| Sun–Mercury | 0.0162 | 0.38 – **25.13** | 1 | 2 | 2 |

**109 orb episodes and 108 exact passes over 90 years — about 1.2 per year, and 103 of the 109 come
from the four Moon pairs.** That is a comfortable default, and it is comfortable *because* the set
is small.

Two facts in that table are permanent geometry, not this chart's luck, and must not be filed later
as missing-aspect bugs:

- **Progressed Sun–Mercury can only ever be a conjunction.** Mercury's maximum elongation from the
  Sun is ~18–28° (25.13° measured here), and the smallest non-zero aspect this server knows is the
  semisextile at 30°. Every other Sun–Mercury aspect is geometrically unreachable, at any rate, for
  anyone.
- **Progressed Sun–Venus can reach the semisextile (30°) and semisquare (45°) but never the
  sextile (60°)** — Venus's maximum elongation is ~45–47° (46.46° measured).

**Recommended ruling: do not filter pairs by a rate threshold in code.** A numeric cut-off would be
an invented convention, it would be chart-dependent (`Venus–Mars` runs at −0.52 °/yr here and
would be faster or slower elsewhere), and it would make output silently depend on a number no
caller can see. Handle it through the **default pair set** (§3) plus the **hard exclusions** (§4),
both of which are visible in `settings_used`, and let an explicit request for Neptune–Pluto return
its honest frozen row.

---

## 3. Ruling B — parameter surface: opt-in, with its own body list

**Recommended:**

```jsonc
{
  "include_pair_aspects": false,          // opt-in at BOTH rates
  "pair_bodies": ["Sun", "Moon", "Mercury", "Venus", "Mars"]   // default = the rate's own moving set
}
```

All unordered pairs of `pair_bodies` are searched (10 pairs from a 5-body list). Both values echo
in `settings_used`, and `settings_used` should also echo the **expanded pair list actually
searched**, after §4's exclusions — otherwise a caller cannot tell an excluded pair from a pair
that simply produced nothing.

Three requirements, in decreasing order of how much they are astrology rather than taste:

1. **`pair_bodies` must be independent of `bodies`.** Crossing `bodies` with itself looks free and
   is wrong: `bodies` is the *moving-to-natal* set and is also what drives `sign_ingress` /
   `house_ingress`. A caller who narrows `bodies` to `["Moon"]` to get a clean progressed-Moon
   ingress timeline would silently get zero pairs; a caller who widens it to the outer planets for
   progressed stations would silently get 21 frozen rows. The two lists answer different questions.
2. **Default off, at both rates.** The moving-to-natal search is what "progressions" means to most
   callers, the output shape is new (§5), and the single most-read progressed pair — Sun–Moon — is
   *already* delivered as `lunation` (§6). Nothing is lost by default and one new array is avoided.
3. **Gated by `event_types` containing `"aspect"`**, and **not** given an `event_types` member of
   its own. These are aspects; a sixth event category for "aspects, but between two moving points"
   would split one idea across two switches. (Same reasoning as SUP-360 §3's refusal to add a
   category for lunation phases.)

> **Scope note.** The astrological content is the *independence of the two body lists*, the
> *opt-in*, and the default set. The spelling — `include_pair_aspects` vs `include_mutual_aspects`,
> `pair_bodies` vs `pair_set` — is engineering's call. `include_pair_aspects` follows the shipped
> `include_minor` / `include_angles` / `include_vertex` / `include_quarter_moons` style.

**Explicit pair lists (`pairs: [["Venus","Mars"]]`) are not recommended for v1.** `pair_bodies`
already narrows to any set a practitioner asks about, and a two-level array is a validation surface
with no astrological content. If a real request appears, add it later.

---

## 4. Ruling C — three exclusions, one of which is a silent-wrong-answer trap

### 4.1 The lunar nodes are excluded unconditionally

Same reason `station` excludes them (SUP-349 Q5, reaffirmed by SUP-357 ruling #5): the true Node —
which is what `find_events` uses, unconditionally (`settings_used.node_type` is hard-coded
`'true'`, `index.js:2197`) — reverses direction from orbital wobble roughly **once per year of
life** at the progressed rate. A pair provider's speed is a *difference*, so that jitter flips the
relative rate's sign against any slow partner, shredding segmentation and emitting the same aspect
as a burst of passes. Visible even at the 1-sample-per-year coarse grid: Pluto–North Node shows 10
relative-speed sign changes across 90 years and Chiron–North Node 7, against 0–1 for every
non-Node pair in the table.

This is unconditional, like the station exclusion — not a `node_type` branch, since there is no
`node_type` parameter here to branch on.

### 4.2 Progressed Sun × progressed Midheaven is **exactly** frozen under `angle_method: "solar_arc"`

This is the trap. Under the default angle method, the progressed MC is *defined* as
`natalMC + (progressedSun − natalSun)` — read `progressedMcProvider` (`lib/progressed-provider.js:71-83`):
under `solar_arc` it returns `speed: sun.speed`, the Sun's own speed, reused rather than
re-derived.

So `λ(pSun) − λ(pMC) ≡ natalSun − natalMC`, a **constant**, with a relative rate of **exactly
zero, forever, for every chart**. If the natal Sun–MC separation happens to sit within 1° of an
aspect, the pair search reports a lifelong in-orb episode with no pass; otherwise it reports
nothing. In both cases it is reporting a *natal* fact — the birth Sun–MC angle — dressed as a
progressed search result. Under `naibod` it is not identically zero but is not meaningfully better:
|1.0076 − 0.98565| ≈ **0.022 °/yr**, a 91-year envelope.

**Exclude the (Sun, Midheaven) pair whenever both are progressed**, at either angle method, and say
why in the schema description. Every *other* MC pair is fine and some are excellent: because the
progressed MC moves at exactly the progressed Sun's rate under `solar_arc`, **progressed Moon ×
progressed MC has precisely the progressed lunation cycle's relative rate (12.28 °/yr)** and
delivers the same ~25 episodes per 90 years. That one is a genuine reading.

### 4.3 Progressed Part of Fortune is never a participant

Unchanged from SUP-356 and SUP-357 §1.3: which day/night formula applies to a progressed sect is
unsettled, so progressed Part of Fortune is never a moving source. A pair search must not become
the back door that reintroduces it.

### 4.4 Ascendant × Midheaven: eligible, but not in the default set

The mutual aspect of the two angles is a statement about quadrant geometry at that latitude, not a
reading — no Western practitioner reads "Ascendant square Midheaven." But note that shipped
`calculate_aspects` **does** emit it when `include_angles` is set (`matchAspects` is all-pairs over
`bodiesWithLonSpeed`, `lib/aspects.js:410`), so excluding it outright here would make a pair
unsearchable that a snapshot tool displays — the exact asymmetry the repo has avoided elsewhere
(see `include_minor`'s "an aspect visible in a snapshot tool is never unsearchable here"). Leave it
reachable by explicit `pair_bodies`; keep it out of the default.

### 4.5 The angles in general: eligible via `include_angles`, but not defaulted

Progressed ASC/MC are already moving-side sources for `contacts[]` at
`rate: "secondary_progression"` (`index.js:2140-2146`), gated by `include_angles`, which defaults
`true` at that rate. Pairs should inherit exactly that gate — but the **default `pair_bodies`
should stay the five real bodies**, because each Ascendant sample costs two `swetest -house`
spawns through `progressedFrameAt` and a Moon–ASC pair needs on the order of 10³ of them for a
90-year window's bisections. That is a cost ruling, not an astrological one, and it has a real
astrological cost: progressed Moon conjunct progressed Ascendant is a reading a practitioner
would expect. It stays one parameter away rather than absent. **If cost forces a cut, cut here and
say so in the output — do not silently cap the window or loosen refinement.**

---

## 5. Ruling D — output shape: a separate array, and never `natal_point`

A pair contact has **no natal point**. Emitting it into `contacts[]` with the second body's name in
`natal_point` would be a silent corruption of a shipped field — any consumer that looks
`natal_point` up in the natal chart (the obvious thing to do with it) gets a plausible position for
the wrong thing.

**Recommended: a separate top-level `pair_contacts[]`, keyed `body_a` / `body_b`.** That is already
the repo's vocabulary for same-chart pairs (`calculate_aspects` emits `body_a`/`body_b`;
`calculate_transits` keeps cross-chart rows in a separate `transit_aspects` array rather than
mixing shapes). Same episode shape otherwise — `aspect`, `category`, `aspect_angle`, `orb_allowed`,
`enters_orb`, `leaves_orb`, `enters_orb_truncated`, `leaves_orb_truncated`, `passes[]`,
`closest_approach` — so nothing new has to be learned.

This is the opposite call from SUP-360 §3 (which refused a second array for lunation phases), and
deliberately: there the rows were the *same relation* at a finer granularity, here they are a
different relation with a disjoint key set.

Per-pass fields need three changes from the moving-to-natal shape, all covered in §7.

**Birth-time sensitivity.** A pair of two real bodies is *not* birth-time sensitive — neither
position depends on the birth clock, only on the birth date through the day-for-a-year map. Do not
set `birth_time_sensitive: true` reflexively at this rate. A pair involving progressed ASC or MC
is, and carries the same `date_uncertainty_days_per_birth_minute` treatment as §1.3 of SUP-357,
computed off the **relative** rate at the contact.

---

## 6. Ruling E — the Sun–Moon overlap is real, correct, and the best test in the ticket

Turning on pairs at the progressed rate makes progressed Sun conjunct progressed Moon appear in
`pair_contacts[]` *and* as a `lunation` event with `phase: "new"`. **Keep both.** Verified through
the shipped engine (uncached, window 1990-01-01 → 2080-01-01, `DAY_CHART`), the pair search's
conjunction/opposition/square passes reproduce `findLunations`' New/Full/quarter datetimes **to the
second, all twelve**, and reproduce `docs/SUP-360-eight-phase-lunation-spec.md` §7's published
table exactly:

| Pair-aspect pass | Lunation | Datetime |
|---|---|---|
| square @ 90 | `first_quarter` | 1992-12-12T00:26:00Z |
| opposition @ 180 | `full` | 1999-09-16T14:07:28Z |
| square @ 270 | `last_quarter` | 2007-05-22T23:06:56Z |
| conjunction @ 0 | `new` | 2015-04-23T03:58:13Z |
| square @ 90 | `first_quarter` | 2022-04-10T18:47:49Z |
| opposition @ 180 | `full` | 2029-04-21T11:11:47Z |
| square @ 270 | `last_quarter` | 2037-04-14T06:34:25Z |
| conjunction @ 0 | `new` | 2044-11-14T17:53:55Z |
| square @ 90 | `first_quarter` | 2051-08-03T14:44:40Z |
| opposition @ 180 | `full` | 2058-12-16T14:43:47Z |
| square @ 270 | `last_quarter` | 2067-02-08T07:17:25Z |
| conjunction @ 0 | `new` | 2074-04-29T15:07:30Z |

Neither view subsumes the other, which is why suppressing either one would lose information:

- The **lunation event** carries the *directed* phase — it can say `first_quarter` vs
  `last_quarter`. The **aspect row structurally cannot**: an aspect is undirected, so both quarters
  come back labelled `square` (visible above as `@90` vs `@270`, which is a search-target artifact,
  not a phase name).
- The **aspect row** carries the *orb envelope* — `enters_orb` / `leaves_orb` /
  `closest_approach` — which the lunation event has no field for. "How long is my progressed Full
  Moon in effect" is only answerable from the aspect row.

Also note the pair search returns **25** Sun–Moon episodes per 90 years against the lunation
search's 12 at quarters: the extra 13 are the trines and sextiles, which have no lunation
vocabulary at all. Suppressing the pair would delete them.

Document the overlap in the README, and make the identity above an assertion (§8.1).

---

## 7. Ruling F — enable at `rate: "transit"` too; the cost is small and the reading is real

Transit-to-transit pairs are the mundane cycles: Jupiter–Saturn, Saturn–Pluto, Uranus–Pluto. The
same composition works unchanged, and — unlike the progressed frozen tier — the **default transit
moving set is exactly the right pair set for it**, because slow bodies are what mundane astrology
watches.

Measured, all 21 pairs of the transit default set (Mars, Jupiter, Saturn, Uranus, Neptune, Pluto,
Chiron), 1-year window (2026), shipped `moiety` orbs:

| | |
|---|---|
| Orb episodes | **52** |
| Exact passes | **46** |
| Full-window in-orb rows with no pass | **0** |
| Relative stations per outer pair | 2 |

Examples: Jupiter–Saturn 2 episodes / 1 pass; Neptune–Pluto 1 episode / 2 passes; each Mars pair
5–6 passes. Roughly one pair contact per week across the whole set — comparable to what the
moving-to-natal search already returns, and with no frozen rows even at transit-width moiety orbs,
because at the transit rate an outer planet really does move.

**Ruling: same parameter, same default (off), rate-keyed `pair_bodies` default** — the transit
default set at `"transit"`, the progressed default set at `"secondary_progression"`. Do not make
this parameter progressed-only; the mundane reading is at least as established as the progressed
one.

**Orb model: inherit, do not special-case.** `moiety` at the transit rate, `fixed` (1° / 0.5°) at
the progressed rate, both unchanged and both already correct here — the measured zero frozen rows
at transit and the ~1.2 contacts/year at progressed are with the shipped tables. The
majors-wider-than-minors ordering is untouched (`FIXED_ORBS`: 1 vs 0.5, `lib/aspects.js:162`).

---

## 8. Implementation traps

A pair provider returns a **separation**, not a position. Four shipped output fields silently
misinterpret it.

### 8.1 `sign` / `degree` on a pass would be nonsense

`findContacts` builds each pass with `...signAndDegree(c.longitude)` (`lib/event-search.js:204-211`),
and for a relative provider `c.longitude` is the *separation*. A Venus–Mars contact at 46.89° of
separation would be emitted as `sign: "Taurus", degree: 16.89` — a well-formed zodiacal position
that is not any body's position.

`findLunations` already solves this and is the pattern to copy: it re-reads
`moonProvider.positionAt(crossing.jd)` and reports the Moon's absolute longitude
(`lib/event-search.js:382-389`). A pair pass must report **each body's own** longitude/sign/degree
at the pass instant.

### 8.2 `retrograde` would be a coin flip decided by pair order

`retrograde: c.speed < 0` off a relative provider means "the relative rate is negative," which says
nothing about either body's direction. Concretely: composing Moon−Sun gives an always-positive
relative rate, so **every** Sun–Moon pass reports `retrograde: false`; composing Sun−Moon gives an
always-negative one, so **every** pass reports `retrograde: true`. Same twelve events, same twelve
datetimes, opposite flag — decided purely by which name was written first.

Report per-body retrograde state instead, from each body's own speed. It matters astrologically:
progressed retrograde Mercury conjunct progressed Venus is a different reading from the direct-motion
version, and a progressed retrograde station is a once-in-a-lifetime marker (SUP-357 §6.2).

The sign of the *relative* rate does have an honest home — it is what applying vs separating means
for two moving bodies, and it is exactly `computeApplying`'s `speedA - speedB`
(`lib/aspects.js:229-241`). `find_events` `contacts[]` carries no `applying` field today, so
introducing one here is optional; if `speed` is emitted on a pair pass at all it must be labelled
as the **relative** rate, not `speed`.

(Note that `direction` on a `house_frame: "progressed"` `house_ingress` deliberately *does* read
off the relative rate — SUP-357 §1.1.1, because there the question is "did the gap close." Same
field name, different correct answer. Don't unify them.)

### 8.3 Fix the direction of the difference by convention: faster minus slower

The relative provider works in directed `[0, 360)` space, so the directed separation is free and
worth emitting — it is the only thing that can distinguish a waxing from a waning aspect, and it is
the hook the deferred non-lunar phase work (SUP-360 §8) would need.

But its meaning depends on which body is subtracted, so fix it: **directed separation = faster
minus slower**, by *mean* rate over the window (not instantaneous — Mercury and Venus trade places
by progression). This makes the Sun–Moon pair come out as Moon − Sun, matching `lib/moon-phase.js`
and `findLunations` exactly rather than by 360° complement, which is what makes §6's identity hold
without a special case. Echo which body was treated as faster.

### 8.4 Scan step: unchanged, but relative stations are now load-bearing

No re-derivation needed for the unwrap margin. The fastest relative rate measured across all 66
progressed pairs is **15.805 °/yr of life** (Moon–Mercury, instantaneous max), against the 180°
per 1-year-of-life step the unwrap requires — an **11.4× margin**, matching SUP-357 §1.2's 11.7×
for the Moon alone. At the transit rate the bound is the Moon plus a retrograde Mercury, ~17.6
°/day against 180 — 10.2×.

What *does* change: unlike lunations, a general pair **does** have relative stations, so
segmentation is doing real work here rather than trivially finding nothing. Measured: 0 for every
Moon pair (the Moon always outruns its partner), 1 per 90 years for the Mercury/Venus pairs, 2 per
year for the transit-rate outer pairs. All comfortably bracketed. The one case worth a test is a
pair whose relative stations can be closest together — Mercury–Venus at the **transit** rate, where
Mercury crosses Venus's speed twice inside its ~21-day retrograde loop. That is not in either
default set, so it is reachable only by explicit request; measure it before promising it.

### 8.5 Do not memoize the progressed provider at whole-ephemeris-second granularity

`index.js`'s `progressedFrameAt` caches per whole ephemeris second, correctly, because
`calculateEphemeris` truncates its input to whole seconds anyway. **That reasoning does not
transfer to `lib/ephemeris-series.js`'s `positionAt`**, which passes the raw float JD to
`swetest -j` and is not quantized.

Applying the same cache to a real-body progressed provider quantizes its longitude into steps of
one ephemeris second — **365 seconds of life** — and bisection then converges anywhere inside that
step. Measured directly: the same twelve Sun–Moon syzygies came out up to **22 seconds** off their
true values with such a cache in place, versus exact to the second without it. Harmless for
reading a chart, fatal for a test asserting §6's table. If pair search needs caching for the
Ascendant path, keep it on the frame provider (where it is already sound) and off the body
providers.

---

## 9. Test expectations

`DAY_CHART` (1990-01-01T12:00:00Z, Greenwich). Progressed figures use `Y = 365.2422`, window
1990-01-01 → 2080-01-01 for §9.1 and birth → birth + 90 tropical years elsewhere. Measured
2026-08-11 through the shipped engine.

### 9.1 The lunation identity — the headline test

Every `pair_contacts` pass for (Sun, Moon) at conjunction / opposition / square must equal a
`lunation` event's `datetime` **to the second**, with conjunction ↔ `new`, opposition ↔ `full`,
and the two squares ↔ `first_quarter` / `last_quarter` — all twelve rows of §6's table, in that
order. This single assertion exercises the relative composition, the directed-difference convention
(§8.3), the segmentation, and the refinement at once; nothing else in the ticket fails as
informatively.

### 9.2 Counts for the default progressed pair set

The ten-row table in §2: 109 orb episodes, 108 exact passes over 90 years, of which 103 episodes
come from the four Moon pairs. Assert per-pair episode counts, not just the total.

### 9.3 Empty is a correct answer — assert it

- **Sun–Mars: zero major-aspect episodes over 90 years.** Its separation stays between 30.81° and
  56.01°, never within 1° of 0/60/90/120/180.
- **Venus–Mars: zero major-aspect episodes** (separation 5.77°–56.22°).
- With `include_minor: true` those two stop being empty, which is the test that `include_minor` is
  wired through the pair path at all:

  | Pair | Aspect | Enters orb | Exact | Leaves orb |
  |---|---|---|---|---|
  | Sun–Mars | semisquare | 2035-09-29T11:59:57Z | 2037-07-14T04:39:52Z | 2039-05-02T13:29:39Z |
  | Venus–Mars | semisquare | 2000-04-14T03:35:03Z | 2000-09-09T08:29:31Z | 2001-02-03T06:38:02Z |
  | Venus–Mars | semisextile | 2011-10-18T03:21:29Z | 2012-03-08T06:04:56Z | 2012-07-29T05:14:24Z |

### 9.4 An episode with no pass, and a truncated one

Mercury–Venus, majors, 90 years: **2 episodes, 1 pass.** The conjunction perfects
(2024-07-19T03:04:39Z, in orb 2023-10-13T11:47:24Z → 2025-04-26T04:25:49Z); the sextile enters orb
at 2079-01-23T03:09:55Z and is still in orb at the window edge with `closest_approach.orb`
**0.1523°** and `passes: []`. Assert `leaves_orb_truncated: true` on it. This is the shape SUP-349
Q4 defined `passes: []` for, and the pair path must preserve it rather than dropping the row.

### 9.5 Structural rules from §4 and §8

- **(Sun, Midheaven)** never appears in `pair_contacts[]` at either `angle_method`, even when
  explicitly listed in `pair_bodies` (§4.2). Additionally assert the underlying invariant directly:
  under `solar_arc`, `λ(pSun) − λ(pMC)` is constant to within 1e-9° across the whole window.
- **North Node** never appears in a pair at any setting (§4.1).
- **Progressed Part of Fortune** never appears (§4.3).
- **`retrograde` per body, not per relative rate** (§8.2): assert that the Sun–Moon passes report
  the Sun and Moon as direct, and that reversing the pair order changes no flag.
- **`sign`/`degree` are each body's own** (§8.1): for one known pass, assert the reported sign
  matches that body's absolute longitude from `calculate_secondary_progressions` at the same
  instant — not the separation's sign.
- **`pair_bodies` is independent of `bodies`**: a request with `bodies: ["Moon"]` and default
  `pair_bodies` still returns all ten pairs.
- **Off by default**: no `pair_contacts` key (or an empty array — pick one and test it) without
  `include_pair_aspects`.

### 9.6 Transit rate

21 pairs of the transit default set, 2026 window, moiety orbs: **52 episodes, 46 exact passes,
zero full-window-in-orb-without-a-pass rows** (§7).

### 9.7 Southern hemisphere

Re-run §9.2's counts against `SOUTHERN_CHART`. The counts will differ (they are chart-dependent);
what must hold is that no pair returns a *negative-longitude* or `NaN` separation, which is the
failure mode a hemisphere sign error produces here.

---

## 10. Out of scope

| Deferred | Why |
|---|---|
| **Progressed-to-progressed aspects in `calculate_secondary_progressions`** | The snapshot tool returns `aspects_to_natal` only — it has no progressed-to-progressed section, so this ticket would make an aspect *searchable* that is not *displayable*, the mirror of the gap `include_minor`'s default exists to avoid. Worth a small companion ticket; not this one's scope, and not a blocker. |
| **Planetary phase for non-lunar pairs** (Rudhyar's eight phases applied to e.g. progressed Sun–Saturn) | Already deferred by SUP-360 §8. §8.3's directed separation is deliberately the hook it would need. |
| **`applying` / `separating` on `find_events` rows** | The tool has never carried it at either rate; adding it for pairs only would be a lopsided surface. `computeApplying` is already two-body-correct if it is ever wanted. |
| **Explicit `pairs: [[a, b], ...]` input** | `pair_bodies` covers every request on file (§3). |
| **Pairs across rates** (progressed Venus to *transiting* Saturn) | A third relation again — and a real technique — but it needs a two-rate request shape, not a pair list. No request on file. |
| **Declination parallels between two moving bodies** | `include_declination_aspects` (SUP-347) is a snapshot-only concept today; the event engine searches longitude. Distinct ticket. |
| **Midpoint and antiscia contacts** | Not requested, and each is its own convention argument. |

---

## 11. Conventions

Repo `CLAUDE.md`: no real birth data — every figure above comes from `test/fixtures/charts.js`
(`DAY_CHART`). PR title must independently satisfy Conventional Commits. Never hand-edit
`CHANGELOG.md` or the `version` field in `package.json`.

Western tropical only. Nothing above depends on a sidereal, ayanamsa, Vedic or Hellenistic variant,
and none are in scope for this server.
