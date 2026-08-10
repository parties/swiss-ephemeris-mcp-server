<!--
  Astrology Advisor spec pass for SUP-357. Advisory: the rulings below are recommendations to
  engineering, not final decisions. Western tropical convention only.

  Every measured figure in this document was produced on 2026-08-10 against the vendored
  ephemeris (vendor/swisseph) using only test/fixtures/charts.js. No new fixture is required.
-->

# SUP-357 — `find_events` at the secondary-progression rate

## 0. Status

**Both blockers are done.** SUP-356 (`calculate_secondary_progressions`, PR #52, `4972a9f`) and
SUP-351 (the `find_events` MCP tool surface, PR #53, `5ae27f2`) are both merged to `main`. This
ticket is unblocked; the spec pass below has been re-verified against the actual shipped code
(2026-08-10, after both merges) rather than against SUP-349's proposal alone.

The parameter names below were originally written against **SUP-349 §3.1** while SUP-351 was still
backlog. They have since been checked line-by-line against the shipped `find_events` tool
(`index.js`) and `calculate_secondary_progressions` (`index.js` + `lib/progressions.js`). One
drift was found and corrected (§3, `year_length_days`). Everything else held up: engine primitives
(`scanTransitingBody`, `findStations`, `findCrossings`, `natalContactsFor`, `relativeLunarProvider`,
`annotateEclipses`, `eclipsesFor`), the `angle_method`/`house_frame` names and defaults, the orb
resolver injection pattern, and the `DEFAULT_TRANSITING_BODIES` baseline all match what this
document assumed.

**§8 has been rewritten.** It was framed as "get SUP-351 to build this before it starts" — SUP-351
already shipped without a `rate` concept (unsurprising; it wasn't asked to have one), so all five
items are retrofit work inside `find_events` for *this* ticket's implementer, not a prerequisite on
someone else's finished PR.

**Confirmed: no new tool.** The event vocabulary — ingress, station, aspect, lunation — is
identical at both rates; only the clock differs. A separate `find_progressed_event` would duplicate
that vocabulary and let the two drift, which is the same argument SUP-349 Q3 used to force the
aspect set to match `calculate_aspects`. A `rate` parameter on `find_events` is right.

---

## 1. The three open questions

### 1.1 Which event types carry over

The issue's premise that "lunations and eclipses have no progressed analogue" is **half wrong, and
the wrong half is the important one.** The **progressed lunation cycle is a major technique** — the
progressed Sun–Moon syzygy, ~29.5 years, read in phases from progressed New Moon to progressed
Balsamic. Measured for `DAY_CHART`: **29.31 years**. Excluding it would drop one of the two or three
things practitioners actually run progressions for.

Eclipses are the part with no analogue, and that is an *annotation*, not an event type.

| Event type | Progressed? | Ruling |
|---|---|---|
| `aspect` (+ orb envelope) | **Yes** | Progressed-to-natal. The main deliverable. |
| `station` | **Yes** | A natal planet turning direct/retrograde by progression. Rare, and read as a life-turning marker precisely because it happens once. |
| `sign_ingress` | **Yes** | Progressed Sun (~30 yr/sign) and progressed Moon (~2.3 yr/sign) sign changes are canonical. |
| `house_ingress` | **Yes** | Progressed Moon through the houses is the single most-used secondary-progression technique. See §1.1.1 for the frame. |
| `lunation` | **Yes** | The progressed lunation cycle. Same Sun–Moon search at the progressed rate. |
| `lunation.eclipse` | **No** | An eclipse is a physical shadow event. There is no progressed eclipse. |

**Eclipse exclusion must be structural, not empty.** In progressed mode `annotateEclipses` is simply
not called and no `eclipse` key appears on any lunation. Do not call it and let it find nothing —
`eclipsesFor` would still spawn `swetest -solecl` for a window in the 2050s and return real
eclipses whose JDs happen to land near a progressed syzygy, and the 1-day tolerance in
`annotateEclipses` would attach them. That is a silent wrong answer, not an empty one. Require a
test asserting no lunation in progressed mode carries an `eclipse` key.

#### 1.1.1 House frame — match SUP-356, but fix `direction`

SUP-356 shipped `house_frame: "progressed" | "natal"`, default `"progressed"`. **Inherit both the
parameter and the default**, echoed as `house_frame_used`.

Astrologically I would lean `"natal"` — the canonical "progressed Moon through the houses" reading
is against the birth chart's cusps — but that is "more common," not "the standard," and both frames
are in mainstream use. Cross-tool consistency decides it: a user whose snapshot says "progressed
Mars in the 5th" and whose search says it entered the 6th two years ago has hit a bug from their
side of the boundary. Document `"natal"` as the frame the classic reading uses.

Two consequences the implementer must handle:

1. **Under `"progressed"` the cusps move, so this is a two-moving-body search.** SUP-349 Q1's
   monotonicity proof assumes a *fixed* target. Compose a relative provider over
   `λ_body(t) − cusp_i(t)`, exactly as `relativeLunarProvider` (`lib/event-search.js:320`) does for
   lunations — `scanTransitingBody` then segments at the stationary points of the *difference*,
   which is what Q1's scope note prescribes. No new code in the engine.

2. **`direction` must come from the sign of the relative rate, not the body's own speed.** Measured
   for `DAY_CHART`, progressed motion over 90 years of life:

   | Body | °/yr of life | Progressed cusp rate |
   |---|---|---|
   | Moon | 13.2917 | ~1.0–1.7 °/yr |
   | Pluto | 0.0025 | ~1.0–1.7 °/yr |

   Under a progressed house frame, "progressed Pluto enters your 8th house" is 99.75% *the cusp
   arriving at Pluto*. Labelling it `direction: "direct"` off Pluto's own speed sign is a
   misstatement of what happened. Compute `direction` from `sign(λ'_body − cusp')`.

   **Recommended (not required):** a `driven_by: "body" | "cusp"` field from comparing the two
   speed magnitudes at the crossing. Both are already in hand and it costs nothing.

`sign_ingress` has no frame problem — tropical sign boundaries are fixed multiples of 30° by
definition. (Sidereal/ayanamsa handling is out of scope for this server.)

### 1.2 Scan step

**Ruling: coarse step = `year_length_days` of target time (i.e. exactly 1.0 day of ephemeris time).
The rule is not re-derived; it is the same rule, and it transfers because the progressed rate is a
uniform time dilation.**

Secondary progression maps target time to ephemeris time by a constant factor
`Y = year_length_days = 365.2422`. Every rate in SUP-349 Q1's margin table divides by `Y`, so
expressing the step in *years of life* instead of *days* leaves both constraints and both margins
identical:

| Constraint | Transit form | Progressed form | Margin at h = 1 yr of life |
|---|---|---|---|
| Bracket every station pair | h ≪ 21 days (Mercury) | h ≪ **21 years of life** | **~20×** (unchanged) |
| Unambiguous 360° unwrap | v·h < 180°, Moon 15.383 °/day | Moon **15.383 °/yr of life** | **11.7×** (unchanged) |

A target step of exactly `Y` maps to an ephemeris step of exactly 1.0 day, so the provider issues
the same `swetest -s1` call the transit path already makes.

**Correction to the issue text.** The issue says the transit-derived step is "wildly wrong in both
directions." It is wrong in *one* direction only. Progressed motion is strictly slower than
transiting motion for every body, so a 1-day target step never misses anything — it is
365× finer than required. The cost is real (a 90-year window is 32,872 rows instead of 90, one
spawn either way) but there is **no correctness risk** in the conservative direction, and the
implementer should not treat this as a trap. Any step `≤ Y` is safe.

**One genuine exception: the progressed Ascendant as a source.** The Ascendant's rate of change
per degree of ARMC is unbounded near the poles — above ~66° latitude it can sweep most of a
quadrant for a small ARMC change. A fixed step cannot be proven safe for it. Require the
progressed-ASC provider to **subdivide adaptively**: if `|wrap180(λ(t+h) − λ(t))| > 90°`, halve and
re-sample. This is self-verifying, mode-agnostic, and cheap because it triggers almost never below
60°. The progressed MC has no such problem — it is `natal MC + arc(t)`, monotone at ~1 °/yr.

**Refinement tolerance: leave `JD_TOLERANCE` alone; fix the honesty instead.** The engine's
tolerance is 0.05 s, which in target time means bisecting from a 1-year bracket — ~30 iterations
instead of the transit path's ~21, each a `swetest` spawn. Two notes:

- SUP-349's ±1-minute floor was justified by *casting a chart for the event instant* (the ASC moves
  1° per 4 minutes). Nobody casts a chart for the instant of a progressed Moon ingress; the
  technique's own resolution is days at best. The second-level precision in progressed output is
  **arithmetic, not astrological**, and the README must say so.
- Do not add a mode-dependent tolerance to buy back the iterations — that is a correctness knob
  traded for a small win. If refinement cost measures badly, the fix is Q1's own "method is
  engineering's call": Newton on the speed column converges in 3–5 calls at either rate.

### 1.3 Do progressed angles participate

**Yes — they are the headline, and `include_angles` defaults to `true` in progressed mode**,
matching SUP-356. Carry SUP-356's asymmetry exactly: `include_angles` puts progressed ASC/MC on the
moving side and natal ASC/MC/Part of Fortune on the natal side; **progressed Part of Fortune is
never a source**, because which day/night formula applies to a progressed sect is unsettled. That
was the right call in SUP-356 and nothing here changes it.

But `birth_time_sensitive: true` — the flat boolean SUP-351 inherits from SUP-349 Q2 — is **not
sufficient at this rate**, and the gap is about three orders of magnitude.

Measured, `DAY_CHART` (51.4769°N), 4 minutes of birth time:

| Point | Shift per 4 min of birth time | Progressed rate | **Date error per minute of birth time** |
|---|---|---|---|
| Midheaven | 0.9257° | 1.0178 °/yr | **83 days** |
| Ascendant | 2.1577° | 1.6459 °/yr | **120 days** |

So a 10-minute birth-time rounding puts a progressed-Ascendant contact date **3.3 years** out.
SUP-349 Q2's worked transit case — the same 10 minutes producing ~94 days of Pluto — is **13×
better**. `SOUTHERN_CHART` measures the same order (1.2999° ASC / 0.9584° MC per 4 min).

The rule of thumb, and it is worth putting in the README verbatim: **at the progressed rate, one
degree of angle error is about one year of date error.**

**Required:** progressed-mode output must convey this **quantitatively**, not as a boolean. The
cheap shape:

```
date_uncertainty_days_per_birth_minute
  = (degrees that point shifts per minute of birth time) / |relative rate at the contact, °/day of target time|
```

Both terms are already available. The numerator needs **one** extra house computation at
`birth + 1 minute`, once per request, which yields all four angles and all twelve cusps at once.
Field name and exact shape are engineering's call; the requirement is that the number is present.

This applies to more than the angles:

- **Every `house_ingress` is birth-time sensitive in both frames** — natal cusps are birth-time
  derived too. SUP-349 §3.3's `house_ingress` shape carries no such flag. That is a gap in
  transit mode as well; this ticket's implementer should fix it directly (§8, item 5) since
  SUP-351 already shipped without it.
- The magnitude is rate-dependent and much smaller for fast bodies: 1° of cusp error against the
  progressed Moon's 13.29 °/yr is only ~27 days. The formula handles this; a boolean does not.

---

## 2. Defaults that must change, and why

This is the substance of the ticket. Several SUP-349 defaults were chosen on volume arguments that
**invert** at the progressed rate. Inheriting them silently is the main failure mode here.

Measured progressed motion for `DAY_CHART`, over 90 years of life:

| Body | Arc over 90 yr | °/yr of life | Envelope at 1° orb | Envelope at 12° moiety orb |
|---|---|---|---|---|
| Moon | 1196.25° | 13.2917 | 0.15 yr | 1.8 yr |
| Sun | 90.69° | 1.0076 | 1.98 yr | 23.8 yr |
| Mercury | 89.23° | 0.9914 | 2.02 yr | 24.2 yr |
| Mars | 65.49° | 0.7276 | 2.75 yr | 33.0 yr |
| Venus | 18.83° | 0.2092 | 9.56 yr | 114.7 yr |
| Saturn | 8.78° | 0.0975 | 20.5 yr | 246 yr |
| Uranus | 3.74° | 0.0415 | 48.2 yr | 578 yr |
| Chiron | −3.02° | −0.0336 | 59.6 yr | 715 yr |
| Neptune | 2.47° | 0.0275 | 72.8 yr | 873 yr |
| Jupiter | −2.34° | −0.0260 | 77.0 yr | **924 yr** |
| North Node | −2.09° | −0.0232 | 86.1 yr | 1033 yr |
| Pluto | 0.23° | 0.0025 | 798 yr | **9573 yr** |

| # | SUP-349 default | Progressed-mode ruling | Why it inverts |
|---|---|---|---|
| 1 | **Q4** orb model: moiety / class, 6–12° | **Flat table: 1° majors, 0.5° minors.** `orb_model: "fixed"` echoed. `orb_overrides` still applies. | The table above is the whole argument. A progressed Jupiter contact at a 12° moiety orb is "in orb" for **924 years**. This is not a tuning preference — inheriting the transit table makes the output meaningless. 1° is the near-universal progression orb; minors are conventionally read tighter still, and 0.5° preserves the repo-wide majors ≥ minors ordering. A flat 1° across the board is also defensible; a caller gets it with `orb_overrides`. |
| 2 | **Q9** moving set: Mars…Pluto + Chiron, **Moon excluded** | **Sun, Moon, Mercury, Venus, Mars.** | Exactly inverted. The progressed Moon *is* the technique. Jupiter outward move under 4° in a lifetime — at a 1° orb they are in orb at birth for life or never, so they generate no aspect events, only a scan cost. Still available by name. |
| 3 | **Q6** ingress bodies: default set **minus the Moon** | **Moon included.** | Q6 excluded the Moon at ~161 sign ingresses/year. Progressed: **39.9 sign ingresses in 90 years** (measured), ~2.3 years per sign. This is the canonical progressed-Moon timeline, not noise. |
| 4 | **Q5** station bodies: fixed list of 13, independent of `bodies` | **Unchanged — keep all 13.** | A body stations at most 0–2 times per lifetime by progression. `DAY_CHART` has exactly four across all 13. Volume is a non-issue and outer-planet progressed stations are read. Keeping Q5's list independent of `bodies` (which now excludes the outers) is what makes this work with no schema change. |
| 5 | **Q5** true Node produces no stations | **Unchanged, and more necessary.** | §1.7's true-Node jitter is ~352 reversals per *year* of real time — i.e. per *day* of ephemeris — so at the progressed rate it would emit roughly one bogus station per year of life. The exclusion is unconditional and needs no `node_type` branch. |
| 6 | **Q7** `include_quarter_moons: false` | **Default `true` in progressed mode.** | The stated rationale was volume: "~25 lunations/year rather than ~50." At a 29.31-year progressed cycle, 90 years yields ~3 New + ~3 Full; with quarters, ~12. The volume argument is void, and the progressed lunation cycle is conventionally read *by phase*, not just at syzygy. |
| 7 | **Q9** window: default 1 yr, **max 10 yr** | **Default 10 yr, max 120 yr.** | A progressed query is inherently lifetime-scale. At the 10-year cap the progressed Sun moves 10°, which cannot answer any question the technique is used for. 120 years is a life bound, not an ephemeris one. |
| 8 | **Q2** `include_angles: false` | **Default `true`**, matching SUP-356. | Progressed ASC/MC contacts are the headline output. Paired with the mandatory §1.3 sensitivity number so the honesty burden sits on data, not omission. |

**Volume sanity check** at these defaults — `DAY_CHART`, 90 years, 17 natal targets, 5 major
aspects, 1° orb: ~282 progressed-Moon contacts, ~21 each from Sun and Mercury, ~15 from Mars,
~20–30 each from progressed ASC and MC; 39 Moon sign ingresses, 3 Sun; ~39 Moon house
ingresses; 4 stations; ~12 lunations with quarters. **≈ 450 items over 90 years, ~5 per year.**
Comfortable — no truncation logic is expected to fire, but Q9's `truncated` block still applies.

---

## 3. Parameter surface

Additions to SUP-349 §3.1, checked against the shipped `find_events` schema (`index.js`, PR #53).
`find_events` currently has no `rate`, `angle_method`, or `house_frame` parameter at all — house
ingress is unconditionally computed against natal cusps, and there is no progression concept yet.
This is new surface, not a rename of anything that exists.

```jsonc
{
  "rate": "secondary_progression",   // "transit" (default) | "secondary_progression"
  "angle_method": "solar_arc",       // "solar_arc" (default) | "naibod" — same as SUP-356
  "house_frame": "progressed"        // "progressed" (default) | "natal" — same as SUP-356
}
```

- `rate`, not `mode` — `mode` is overloaded, and `rate` is SUP-349 Q10's own word. Leaves room for
  `"solar_arc"` and `"converse"` later.
- `angle_method` / `house_frame` **must accept the same values and produce the same results as
  `calculate_secondary_progressions`.** See §6.1 — that cross-tool identity is the single most
  important acceptance test in this ticket.
- **`year_length_days` is not a request parameter — correction from the previous revision.**
  Checked against the shipped `calculate_secondary_progressions` (`index.js`/`lib/progressions.js`):
  it is `TROPICAL_YEAR_DAYS = 365.2422`, a fixed constant, merely *echoed back* as
  `year_length_days` in the response. SUP-356 does not let a caller override it, and nothing in
  this spec needs a non-tropical year — the earlier draft listing it as a fourth peer input
  alongside `rate`/`angle_method`/`house_frame` misstated that precedent. `find_events` should do
  the same: echo `year_length_days: TROPICAL_YEAR_DAYS` in `settings_used` for
  `rate: "secondary_progression"`, and not accept it as input.
- All three real inputs (`rate`, `angle_method`, `house_frame`) echoed in `settings_used`, alongside
  `angle_method_used` / `house_frame_used` to match SUP-356's naming.
- Passing `angle_method` or `house_frame` with `rate: "transit"` (or omitted, since `"transit"` is
  the default) must **error**, not be silently ignored.

**Window before birth: reject it.** `window_start` earlier than `birth_datetime` yields a negative
elapsed-years value, and `birth + N days` with negative `N` is *the converse progressed chart* — a
real and distinct technique. The arithmetic produces it silently and correctly, which is the trap.
Error in v1 and reserve `rate: "converse"` for it.

---

## 4. Provider contract

A `secondary_progression` provider wrapping `lib/ephemeris-series.js`. Four things to get right:

1. **Return target-date JDs, not ephemeris JDs.** `seriesFor` maps `[startJd, endJd]` and
   `stepDays` into ephemeris time, calls through, then maps every returned `jd` **back** to target
   time before handing rows to the engine. Miss this and every `datetime` in the response is a date
   in early 1990 instead of a date in the subject's life.
2. **Rescale `speed` by `1 / year_length_days`** — degrees per day *of target time*. swetest returns
   °/ephemeris-day; emitting that unrescaled reports the progressed Moon at 13.29 °/day, off by
   365×. SUP-349 §3.2 makes `speed` load-bearing ("what tells the reader whether a contact sits for
   months or passes in days"), so this is a defect, not cosmetics. Keeping the unit consistent
   across rates means consumers need no branch; `settings_used.rate` plus `year_length_days` lets
   anyone convert. Sign is preserved, so `retrograde` is unaffected.
3. **The progressed-MC provider is `natal MC + arc(t)`**, with `arc` from
   `computeArcDegrees` (`lib/progressions.js:39`) — never the raw clock-moment MC at the progressed
   instant. That is the error SUP-356's tool description calls out explicitly ("off by hundreds of
   degrees and mean nothing"). The progressed-ASC provider goes through
   `computeFictitiousLongitude` (`lib/progressions.js:76`) per sample; do not drop its
   `+ natalLongitude` term (see the comment there — it only passes for Greenwich fixtures without it).
4. **Eclipse annotation is routed off, not called and discarded** (§1.1).

---

## 5. Schema deltas

Everything in SUP-349 §3.2/§3.3 stays. Changes for `rate: "secondary_progression"`:

- `contacts[]`: `transiting_body` reads as the *progressed* body. Either rename per-mode or, better,
  keep one key and let `settings_used.rate` disambiguate — a per-mode key rename forces every
  consumer to branch. **Recommend keeping `transiting_body`** and documenting it.
- `contacts[]` and angle-involving events gain the §1.3 quantified sensitivity number.
- `house_ingress` gains `birth_time_sensitive: true` unconditionally (and should in transit mode
  too — §8).
- `house_ingress.direction` computed from the relative rate (§1.1.1). Optional `driven_by`.
- `lunation` never carries `eclipse` in this mode.
- `settings_used` gains `rate`, `year_length_days`, `angle_method_used`, `house_frame_used`; and
  `orb_model` reads `"fixed"`.

---

## 6. Test expectations

All values measured 2026-08-10 against `vendor/swisseph` using only `test/fixtures/charts.js`.
`DAY_CHART` = 1990-01-01T12:00:00Z, 51.4769°N, 0.0°E; `Y = 365.2422`; life date =
`birth + (ephemeris_jd − birth_jd) × Y`.

### 6.1 Cross-tool identity — the headline test

For the same `(birth_datetime, latitude, longitude, target_date, angle_method, house_frame)` —
`year_length_days` is fixed at `TROPICAL_YEAR_DAYS` on both tools, not a variable to control for —
the progressed positions `find_events` uses at instant *t* must match
`calculate_secondary_progressions` at target date *t* to **1e-6°** for every body and angle. If
these two tools disagree, the feature is wrong regardless of what else passes. Assert it at three
dates against both `angle_method` values.

### 6.2 Progressed stations — `DAY_CHART`, window 1990-01-01 → 2080-01-01

Exactly **four** stations across Q5's 13 bodies. Assert dates to ±1 s:

| Body | Direction | Life date | Age | Longitude |
|---|---|---|---|---|
| Mercury | direct | 2008-09-09T08:08:53Z | 18.689 | 279.6972 |
| Venus | direct | 2027-11-21T04:40:35Z | 37.886 | 290.9210 |
| Pluto | retrograde | 2038-10-09T16:41:04Z | 48.771 | 227.7875 |
| Jupiter | direct | 2044-04-20T18:24:52Z | 54.302 | 90.8081 |

`DAY_CHART` is natally Mercury-retrograde and progressed Mercury turns direct at 18.7 — a textbook
reading, and a good regression anchor because it exercises a genuine sign change rather than a
near-zero wobble. The Pluto station (speed 0.00046 → −0.00014 °/day) is real, not jitter, and is the
case that proves outer planets must stay in the station list (ruling #4).

### 6.3 Rates and cycle lengths — `DAY_CHART`, 90 years

| Quantity | Expected |
|---|---|
| Progressed Sun arc | 90.686° → 1.0076 °/yr |
| Progressed Moon arc | 1196.25° → 13.2917 °/yr (1.108 °/month) |
| Progressed lunation cycle | 29.31 yr |
| Progressed Moon sign ingresses | **39** (Moon never retrogrades — no re-ingresses) |

### 6.4 Orb model — the ruling-#1 regression test

Same progressed Jupiter → natal-point contact under both settings. At the transit moiety orb the
envelope must measure in the **hundreds of years**; at the progressed default it must not exist as an
event at all (in orb at birth for life, or never). A test that only checks the 1° path will not
catch an inherited orb table.

### 6.5 Birth-time sensitivity

`DAY_CHART` 4 minutes later: ASC +2.1577°, MC +0.9257°. `SOUTHERN_CHART` 4 minutes later:
ASC +1.2999°, MC +0.9584°. Assert the emitted sensitivity number lands within 5% of
`(shift per minute) / (relative rate)` — 83 days/min for MC, 120 days/min for ASC on `DAY_CHART`.

### 6.6 Structural

- No lunation in progressed mode carries an `eclipse` key (§1.1).
- `window_start` before `birth_datetime` errors (§3).
- A progression parameter with `rate: "transit"` errors (§3).
- `SOUTHERN_CHART` for hemisphere sign errors; `PARTNER_CHART` for the non-zero-longitude
  `computeFictitiousLongitude` path (§4.3).

---

## 7. Out of scope — named so nobody assumes they were forgotten

| Deferred | Why |
|---|---|
| **Progressed-to-progressed aspects** (other than the lunation) | Two moving bodies. The engine supports it by composition, but it is a distinct search and a distinct reading. The progressed lunation is in scope only because `relativeLunarProvider` already exists. File separately. |
| **Eight-phase progressed lunation cycle** (crescent / gibbous / disseminating / balsamic) | This is the conventional reading of the cycle and `lib/moon-phase.js` already has the eight-phase vocabulary, but it needs a flag name and a decision for transit mode too. File separately — it is the highest-value follow-on here. |
| **Solar arc directions** (`rate: "solar_arc"`) | Trivial once this lands — `λ(t) = natal λ + arc(t)`, one rate for every body, no stations ever — and `computeArcDegrees` already exists. Deliberately not bundled. |
| **Converse progressions** (`rate: "converse"`) | See §3. Must not fall out silently. |
| **Tertiary / minor progressions** | Different rates, different technique, no request on file. |
| **`solar_arc_ra` / `naibod_ra` angle variants** | Already deferred by the SUP-356 ruling. Unchanged. |

---

## 8. Retrofit required in `find_events` — was "feed back into SUP-351," now this ticket's own work

SUP-351 shipped (PR #53, `5ae27f2`) before this spec pass reached it, with no `rate` concept, so
none of the five items below made it in — expected, since nothing asked for one at the time. They
are no longer a request to another ticket's owner; they are `find_events` changes this ticket's
implementer makes directly. Verified against `index.js` on `main` post-#53:

1. **Orb resolver injection — already in place, no rework needed.** `find_events` builds
   `aspectSettings` via `resolveAspectSettings({ includeMinor, orbOverrides, orbModel })` and reads
   orbs through `orbAllowedFor(aspectSettings, ...)` (`index.js` ~1546-1549); the search path never
   reaches for `MOIETIES`/`ORB_CLASSES` directly. Adding the ruling-#1 flat table is scoped to
   extending `ORB_MODELS` (currently `['class', 'moiety']`, `lib/aspects.js:135`) and
   `resolveAspectSettings`/`orbAllowedFor` with a third `"fixed"` model — the injection seam this
   item asked for is already there.
2. **Body and target defaults are still module constants, not rate-aware — needs a change.**
   `DEFAULT_TRANSITING_BODIES` (`index.js:179`) is read directly at the `bodies` resolution site
   (`index.js` ~1511); there is no per-rate branch. Ruling #2/#3's inverted defaults require this to
   become a lookup keyed on `rate`.
3. **Eclipse annotation is still unconditional — needs a rate gate.** `findEvents`'s lunation block
   calls `eclipsesFor('solar', ...)`, `eclipsesFor('lunar', ...)`, then `annotateEclipses(...)`
   unconditionally (`index.js` ~1675-1679). For `rate: "secondary_progression"` this must be skipped
   entirely (§1.1), not called and left to find nothing near-term real eclipses.
4. **Window cap is still a single constant — needs a per-rate value.** `MAX_EVENT_WINDOW_DAYS = 3653`
   (`index.js:223`) is unconditional. Ruling #7's 10 yr default / 120 yr max for progressed mode
   needs its own branch alongside the existing transit-mode cap.
5. **`house_ingress` still carries no `birth_time_sensitive` field, in transit mode either —
   confirmed absent.** The `house_ingress` event object (`index.js` ~1656-1665) has no such key.
   Fixing this is in scope for both modes, not just progressed (§1.3): natal cusps are as
   birth-time-derived as the Ascendant, and SUP-349 §3.3 never carried the flag.

---

## 9. Conventions

Repo `CLAUDE.md`: no real birth data — every figure above comes from `test/fixtures/charts.js`.
PR title must independently satisfy Conventional Commits. Never hand-edit `CHANGELOG.md` or the
`version` field in `package.json`.

Western tropical only. No sidereal, ayanamsa, Vedic or Hellenistic variants are in scope for this
server, and nothing above depends on one.
