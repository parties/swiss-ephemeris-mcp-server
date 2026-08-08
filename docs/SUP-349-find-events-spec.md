---
type: spec
target_repo: swiss-ephemeris-mcp-server
status: ready-for-implementation
raised: 2026-08-08
author: Astrology Advisor
implements: docs/SUP-344-top-five-missing-features.md §1
ephemeris_version_tested: swiss-ephemeris-mcp-server@1.0.2 (worktree issue/SUP-344, 99ed67d)
swetest_version: 2.10.03
scope: Western tropical astrology only
---

# SUP-349 — time-domain event search: `find_events`

Implementation-ready spec. Every number below was produced on 2026-08-08 against the vendored
Swiss Ephemeris in this worktree, using only the synthetic fixtures in `test/fixtures/charts.js`.

Part 1 of the issue (stepped scanning, the interleaved-row parser, direct eclipse enumeration, the
ΔT trap, houses needing `-ut`) is verified and taken as given; it is not restated. §1 below adds
what that survey did not cover — including two traps that would each have shipped a silently wrong
feature.

---

## 0. One-paragraph summary

`find_events` searches a caller-supplied UTC window and returns **when**, in two arrays:
`contacts[]` (aspect periods — every pass, plus the orb envelope) and `events[]` (instants —
stations, sign and house ingresses, lunations with eclipse annotation). Correctness does not come
from a small scan step. It comes from **segmenting the window at the transiting body's stations, on
which its longitude is monotone, then enumerating the target longitudes crossed in each segment**;
the pass count is arithmetic before any refinement runs, so no pass can be missed. The coarse scan's
only job is to bracket stations, and a flat **1-day step** does that with ~20× margin for the
fastest-stationing body. Default transiting set is **Mars → Pluto plus Chiron** — excluding the
transiting Moon, which is 21.7× the entire rest of the output. The engine takes a position provider
rather than calling `swetest` directly, so progressions and solar arc reuse it unchanged (Q10).

---

## 1. Verified mechanics, beyond the issue's Part 1

### 1.1 Decimal output removes the DMS parser entirely

`swetest -hform` exposes decimal columns that the existing code does not use: `l` (longitude
decimal), `s` (speed decimal), `J` (absolute Julian day), `j` (house number), `-` (illuminated
fraction), `*` (elongation).

```
$ swetest -b01.01.2026 -ut00:00:00 -p46 -fJPls -g, -head -n2 -s1
2461041.50,Mars           , 282.6881579,  0.7663630
2461041.50,Saturn         , 356.1672418,  0.0583277
2461042.50,Mars           , 283.4548555,  0.7670312
2461042.50,Saturn         , 356.2263460,  0.0598757
```

`-fJPls` is self-describing: JD identifies the timestep, name identifies the body, so the
interleaving the issue flagged is harmless. **The search engine should use `-fJPls` and never parse
DMS.** `lib/swetest-parse.js` keeps its DMS parsers for the existing chart tools; the third parser
this ticket adds is a four-column decimal CSV parser, which is materially simpler than the two that
exist. `-hor` (all bodies on one line) is an alternative but produces variable-width rows for no
gain.

### 1.2 TRAP — `-fj` gives the house of the *transiting* chart, not the natal chart

`swetest` will emit a house number directly, and it looks exactly like the tool for `house_ingress`:

```
$ swetest -b03.01.2026 -ut00:00:00 -p1 -fJlj -g, -head -n8 -s120m -hsyW -geopos0,51.4769,0
2461043.50,  96.7826273, 10.2260876
2461043.75, 100.5190862,  8.3506362
2461044.00, 104.2421764,  4.4747392
2461044.25, 107.9495557, 12.5983185
2461044.50, 111.6390205, 10.7213007
```

The Moon runs 10 → 8 → 4 → 12 → 10 in eight hours. That is the house frame **of the moment**, whose
Ascendant sweeps the zodiac daily — not the natal house frame. Transit house ingress means entering
a *natal* house, and `-fj` cannot express it.

**Do not use `-fj`.** Compare the transiting longitude against the natal chart's fixed cusps;
`findHouseForLongitude` (`lib/aspects.js:339`) is already the right machinery. This is the same trap
class as SUP-345 §1.1 — a column that is available, correct-looking, and silently the wrong
quantity — and it is worse here because the output is plausible rather than malformed.

The useful consequence: natal cusps are **fixed longitudes**, so house ingress and sign ingress are
the *same* root-find against different target sets. One solver covers both.

### 1.3 TRAP — the Sun–Moon differential wraps at ±180°, so Full Moons are not zero crossings

```
$ swetest -b01.01.2026 -ut00:00:00 -p1 -d0 -fTl -g, -head -n5 -s1
02.01.2026, 160.1659417
03.01.2026, 174.1763195
04.01.2026,-171.9861353     ← Full Moon is a discontinuity, not a sign change
05.01.2026,-158.4644003
```

A sign-change scan over `-d0` finds every New Moon and **no** Full Moon. Use the same
`wrap180(λ_Moon − λ_Sun − α)` form the aspect engine already uses (`normalizeSeparation`,
`lib/aspects.js:180`) with α ∈ {0, 90, 180, 270}, and the wrap disappears.

### 1.4 TRAP — `*` (elongation) is not the astrological Sun–Moon separation

```
$ swetest -b01.01.2026 -ut00:00:00 -p1 '-fPl+-*' -g, -head
Moon           , 66.7155992, 34.1040082,     0.914010556, 145.8169524
                 └ longitude └ phase angle   └ illum. frac └ elongation
```

Elongation here is **145.8170°**; the ecliptic-longitude difference at the same instant is
**146.1470°**. They differ by 19.8′ because elongation is the true geocentric angular separation and
includes the Moon's ecliptic latitude. Astrological phase is defined on **ecliptic longitude**.
Near a phase boundary 19.8′ is about half an hour of clock time, so this is not a rounding
difference — it can name the wrong phase.

Use `-` (illuminated fraction) as a reported datum if wanted; compute phase from longitudes.

### 1.5 TRAP — eclipse line 1 is tab-delimited but lunar and solar have different field counts

```
total lunar eclipse<TAB> 3.03.2026<TAB>  11:33:41.2<TAB>1.1507/2.1839<TAB>saros 133/27<TAB>2461102.981727
annular solar<TAB>17.02.2026<TAB>  12:11:53.3<TAB>131.068478 km<TAB>0.9638/0.9797/0.9288<TAB>saros 121/61<TAB>2461089.008255
```

Six fields for lunar, **seven for solar** — solar inserts core-shadow-width. Lines 2 and 3 diverge
further (lunar has six contact times with `-` placeholders for absent phases, solar has four).
Splitting on tab is right; a positional parse tuned on one type misreads the other. Type names are
multi-token and include `penumb. lunar eclipse` — match on substring, not token count.

`-nN` returns exactly N events regardless of the window (verified), so the implementation must
over-request and trim to the window rather than trusting `-n`.

### 1.6 The eclipse maximum and the exact syzygy are different instants

This is the one that changes an output decision, not just a parser.

| Event | Eclipse maximum (`-lunecl`/`-solecl`) | Exact syzygy (longitude) | Δ |
|---|---|---|---|
| 2026-03-03 total lunar | 11:33:41.2 UT | 11:37:54.0 UT | **+4.21 min** |
| 2026-02-17 annular solar | 12:11:53.3 UT | 12:01:09.4 UT | **−10.73 min** |

Eclipse maximum is minimum *geocentric angular* separation (three-dimensional, latitude included);
the syzygy is exact conjunction/opposition in longitude. They cannot coincide except by accident.
Ten minutes moves the Ascendant ~2.5°, which changes the rising degree of an eclipse chart and can
change the rising sign. See Q7 — both timestamps must be carried, and neither may be silently
labelled "the eclipse time."

### 1.7 The true Node's speed sign flips are jitter, not stations

Over 2026, sampled 6-hourly, the **true** Node reverses direction **352 times**; the mean direct
excursion is 0.0014° (5″) and the largest is 0.101° (6′). The **mean** Node reverses zero times, as
does mean Apogee (Lilith). Real planetary stations over the same year: Mercury 6, Venus 2, Mars 0,
Jupiter/Saturn/Uranus/Neptune/Pluto/Chiron/Pallas/Juno/Vesta 2 each, Ceres 1 — **~25 total**.

The same wobble makes the true Node **re-cross sign boundaries**. Scanning 2024–2030 6-hourly:

```
JD 2484478.50  180.17211 -> 179.91518   (Libra -> Virgo)
JD 2484484.50  179.91518 -> 180.00548   (Virgo -> Libra)
JD 2484490.50  180.00548 -> 179.94770   (Libra -> Virgo)      ← three ingresses in 12 days
```

The mean Node crosses each boundary exactly once. Also: **max |true − mean| Node separation in 2026
is 1.762°** — for transiting Pluto (+0.0267°/day at its 2027 pass) that is 66 days of difference in
a contact date, purely from a node-type choice the server currently does not expose or label
(SUP-344 correctness flag #1). Consequences in Q5 and Q9.

### 1.8 Retrograde re-ingress is real and common

Transiting Pluto crossed 0° Aquarius **five times**:

```
2023-03-23 direct   2023-06-11 RETRO   2024-01-21 direct   2024-09-02 RETRO   2024-11-19 direct
```

"Return every pass" is not an aspect-only rule. It applies identically to sign and house ingress.

---

## 2. The ten decisions

### Q1 — Scan step: the guarantee comes from monotonicity, not from step size

**Decision: segment the window at the transiting body's stations, enumerate target longitudes
crossed in each segment, then refine. Coarse step is a flat 1 day for every body, and its only job
is to bracket stations.**

For a transiting body T against a *fixed* natal longitude λ_N and aspect angle α, define

```
g(t) = wrap180( λ_T(t) − λ_N − α )
```

An exact pass is a root of g, and `g′ = λ′_T`. So **g is strictly monotone on any interval where
λ′_T does not change sign** — that is, between consecutive stations of T. Therefore:

1. Locate every station of T in the window (roots of λ′_T).
2. Cut the window at them. On each segment λ_T sweeps monotonically from λ₁ to λ₂ (unwrapped, may
   exceed 360°).
3. **Enumerate**, don't sample: every target longitude of the form `λ_N + α + 360k` lying in
   [λ₁, λ₂] is crossed exactly once. Bisect/Newton for its time.

**The guarantee this gives:** the number of passes in each segment is known by arithmetic before any
refinement runs. Missing a pass would require missing a station, not missing a sample. This is
strictly stronger than any step-size heuristic, and it makes the "fast body steps over a tight orb"
failure mode structurally impossible rather than improbable.

The same enumeration produces `enters_orb` and `leaves_orb` for free: those are the crossings of
`λ_N + α ± orb`, drawn from the same monotone segments. No separate search.

**Why 1 day is the right coarse step, and what it must satisfy:**

| Constraint | Requirement | Margin at h = 1 day |
|---|---|---|
| Bracket every station pair | h ≪ shortest retrograde period. Shortest is **Mercury, ~21 days** | **~20×** |
| Unambiguous 360° unwrapping | `v_max · h < 180°`. Fastest body is the **Moon at 15.383°/day** (measured max, 2020–2030 daily) | **11.7×** |

Both hold for every body with large margin, so no per-body step table is needed. Cost is one
`swetest -nN -s1` spawn per body per window; 365 rows returns in ~12 ms.

**Refinement accuracy requirement: ±1 minute UTC.** Not a numerical preference — an astrological
one. Ingress, lunation, eclipse and station charts are cast and read, and the Ascendant advances
roughly 1° per 4 minutes of clock time, so ±1 minute keeps an event chart's Ascendant within ~15′.
Method is engineering's call (Newton using the exact `s` column converges in 3–5 calls; plain
bisection from a 1-day bracket needs ~17). Require a test asserting agreement with brute-force
bisection to 1 s.

**Scope note.** The monotonicity argument uses a *fixed* target, so it holds for transit-to-natal
and for progressed-to-natal. For two moving bodies (mundane Saturn–Neptune, and lunations) the
segmentation must be at the stationary points of the *difference*, where the speeds are equal. For
lunations this is trivially unnecessary — the Moon–Sun relative speed ranges roughly 11.8–14.6°/day
and never reaches zero, so g is monotone across the whole window with no segmentation at all.

### Q2 — Natal targets: exactly what `calculate_transits` already uses, plus a confidence flag

**Decision: resolve targets through the existing `resolveAspectBodies` (`index.js:613`) with no new
rules.** That yields `DEFAULT_ASPECT_BODIES` (17, including North Node), plus Ascendant / Midheaven /
Part of Fortune behind `include_angles`, South Node behind `include_south_node`, Vertex behind
`include_vertex`; IC and Descendant dropped unconditionally.

Ruling on each point the ticket named:

- **Angles (ASC/MC): valid targets, and among the most important ones.** SUP-344 §1 rules out
  transiting angles as *sources* because an angle event would fire daily. Natal angles are the
  opposite case — fixed points, and transiting Pluto crossing the natal Ascendant or Saturn reaching
  the natal MC are chapter-defining contacts. There is no tension between the two rules.
- **Part of Fortune: valid target.** Already in `ASPECTABLE_ANGLES`, gated by `include_angles`.
- **Vertex: valid target**, gated by `include_vertex`, matching #45.
- **Lilith (mean Apogee): valid target.** Already in `DEFAULT_ASPECT_BODIES`; no reason to differ.
- **Nodes: valid targets.** Transits to the natal nodal axis are standard. North Node in the default
  set, South Node behind its flag.
- **IC / Descendant: excluded**, consistent with `ASPECTABLE_ANGLES`. Worth stating in the README
  because a user will ask: the 180° recovery mapping is **lossless for events**, because
  `ANGLE_ORBS` is mirror-symmetric by construction (`lib/aspects.js:106-113`). "Transiting Saturn
  conjunct natal IC" is exactly "transiting Saturn opposition natal MC" — same dates, same orb
  envelope, no information lost.

**One thing SUP-344 §1 did not flag and should have: angle contacts inherit birth-time error, and
in the time domain that error is enormous.** The Ascendant advances ~1° per 4 minutes, so a
10-minute birth-time uncertainty is ~2.5° of Ascendant. Transiting Pluto moved +0.0267°/day at its
2027-03-03 pass over DAY_CHART's natal Venus; 2.5° at that rate is **~94 days**. A date for
"Pluto conjunct your Ascendant" from a rounded birth time is uncertain by a season, while a date for
"Pluto conjunct your Venus" is uncertain by seconds.

**Required:** every contact whose natal target is Ascendant, Midheaven, Part of Fortune or Vertex
carries `birth_time_sensitive: true`. A consumer that renders exact dates for these without saying
so is overstating what the ephemeris knows. Same flag, same reason, for Part of Fortune (derived
from the Ascendant).

### Q3 — Default aspect set: match `calculate_aspects` exactly

**Decision: majors only by default; `include_minor` opt-in, same flag name, same six minors.**

Consistency is the whole argument, and it is decisive: a user who sees "Saturn quincunx natal Sun"
in `calculate_transits` and cannot find its dates in `find_events` has hit a bug from their side of
the boundary, whatever the docs say. The two tools answer "is it happening" and "when," and the set
they answer over must be identical.

The volume argument points the same way — minors take the aspect count from 5 to 11 and roughly
double the event count — so there is no tension to resolve. A narrower time-domain default is not
warranted.

Noted but not acted on: the quincunx arguably earns its keep *more* in the time domain than in a
snapshot, since it is read as a transition marker and its date is the point. That is an argument for
callers to set `include_minor: true` on forecasting queries, not for moving the default.

### Q4 — Orb model: both, echoed; and the station-in-orb case is real

**Both models supported and echoed as `orb_model` in `settings_used`, same as everywhere else.**

The eval doc said moiety and class "disagree by several degrees and therefore by *weeks*." Measured,
it is **months**. Transiting Saturn square DAY_CHART's natal Sun, same three exact passes under
both models:

| Model | Orb | enters_orb | leaves_orb | Period |
|---|---|---|---|---|
| moiety — (Saturn 4.5 + Sun 7.5) × 1.0 | 12° | 2026-02-02T17:55:52Z | 2028-02-07T00:32:27Z | **734.3 days** |
| class — body/body square | 8° | 2026-03-10T00:14:51Z | 2027-04-16T19:44:33Z | **402.8 days** |

**331 days apart — the moiety period is 1.8× the class period for the identical contact.** And the
disagreement is not one-directional: for Pluto–Venus the moiety orb is (2.5 + 3.5) × 1.0 = 6°,
*narrower* than the class 8°. Which model is wider depends on the pair, so a consumer cannot
mentally correct for it. Echoing `orb_model` is not a nicety here.

Note also that at 12° the Saturn envelope swallows the following year's approach, merging what a
reader would call two visits. That is a property of the orb choice, not a bug — but see Q9 on
`closest_approach` making it legible.

**The stationing-without-perfecting case: yes, it is an event, and it is often the strongest form a
transit takes.** A body that stations within orb sits on the contact for months — "Saturn stationing
on your Sun" is read as heavier than a clean fast pass, not lighter.

Verified instance, using only repository fixtures: transiting Neptune stations direct on
**2026-12-12T22:17:19Z at 1°36′46.5″ Aries**, which is **3.20 arcminutes** from DAY_CHART's natal
Pallas at 1°33′34.3″ Aries. It never perfects on that approach and retreats. Over 2026–2028 that
contact has **exactly one** exact pass, where "outer planet, retrograde, inside orb" would suggest
three.

**Shape: do not invent a fourth pass type.** Two existing structures carry it:

1. `station` events already exist (Q5) and carry `natal_contacts[]` — the natal points within orb at
   the station instant. That is the reading, expressed once.
2. Every contact period carries **`closest_approach`** — `{ datetime, orb, stationary }` — which
   equals the exact hit (orb 0) when there is one and is the only anchor when there is not.

`closest_approach` is cheap and exact rather than searched: on a monotone segment g is monotone, so
|g| is minimised at a segment endpoint or at a root. The candidate set is therefore
`{exact passes} ∪ {stations inside the period} ∪ {window boundaries}` — all already computed.

`passes[]` may legitimately be empty. A test must cover that.

### Q5 — Stations: instant *and* degree, unconditional, 13 bodies

**Both.** The station *time* is the event timestamp; the station *degree* is the payload, because
the degree stays sensitised for months afterwards — "Mars stations at 27° Cancer" is a statement
about a place in the chart, and it is used long after the date passes. Emit `datetime`, `longitude`,
`sign`, `degree`, and `direction: "retrograde" | "direct"`.

**Reported unconditionally over the window, not gated on natal contact.** Station degrees are read
in their own right, including mundanely with no natal chart in play; gating them on a natal hit
loses that reading. And there is nothing to save — measured volume is **~25 stations per year across
all bodies**, against 118 exact aspect passes at default scope (§4.3). Each station additionally
carries `natal_contacts[]`, which is what makes Q4's case readable at zero extra cost.

**Station bodies (13):** Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron,
Ceres, Pallas, Juno, Vesta.

**Excluded, with reasons:**

- **Sun and Moon** — never station. Verified: zero speed sign changes.
- **Mean Apogee (Lilith)** — always direct by construction. Verified: zero.
- **True Node — excluded, and this is not a taste call.** 352 speed reversals in 2026 at 6-hourly
  sampling, mean excursion 5″ of arc (§1.7). These are oscillation jitter; no school reads them as
  stations, and emitting them would produce an order of magnitude more "station" events than all
  real stations combined. If `node_type` becomes selectable (SUP-344 flag #1), **the true Node must
  still produce no stations** — the mean Node has none to produce, so the exclusion is unconditional
  and needs no branch.

**Retrograde periods are deliberately not a separate event type.** Pairing consecutive
retrograde→direct stations of the same body reconstructs the period exactly, so a `retrograde_period`
type would duplicate data. Required instead: when a window boundary orphans a station (a direct
station whose retrograde partner precedes the window), the station still emits, and the response's
`window` block states the truncation so a consumer does not read an orphan as a full period.

### Q6 — Ingresses: same house system, both reported under Whole Sign

**Sign ingress** — crossings of multiples of 30°. **Every** crossing, including retrograde
re-ingress (§1.8: Pluto crossed 0° Aquarius five times). Payload carries
`direction: "direct" | "retrograde"`, `from_sign`, `to_sign`; a retrograde ingress moves *backwards*
into the preceding sign and must be labelled so, not rendered as "enters Capricorn" with no
qualifier.

**House ingress** — crossings of the **natal chart's** cusp longitudes, using **the same
`house_system` parameter as the rest of the server**, validated by `validateHouseSystem`
(`index.js:71`, ten systems) and echoed in `settings_used`. Location comes from the natal chart, not
a separate parameter. Do not use `-fj` (§1.2).

**Whole Sign degeneracy — report both, never suppress.** Verified: under `house_system: 'W'` the
natal cusps are exactly `0.0, 30.0, 60.0 … 330.0`, so every house ingress coincides with a sign
ingress to the arcsecond.

Both are still emitted, for three reasons:

1. They answer different questions and produce different sentences. "Saturn enters Aries" and
   "Saturn enters your 7th house" are both things a reader writes, and under Whole Sign they are
   both still true.
2. Suppression would make the *shape* of the response depend on the house system. A consumer
   filtering `type: "house_ingress"` would get an empty list purely because of a display choice —
   a silent, confusing failure.
3. That the two coincide is the defining property of Whole Sign, not an artifact to hide.

**But make the coincidence explicit, and compute it from the cusp, not from the system code.** Each
`house_ingress` carries `coincides_with_sign_ingress: true` when its cusp is within 1″ of a 30°
multiple. This must be a longitude test: Equal (`E`) or any other system can incidentally place a
cusp on a sign boundary, and hard-coding `house_system === 'W'` would miss those and would also miss
`N` if Whole-Sign-Aries is ever added. A consumer that wants to dedupe then can, on data rather than
on a guess.

**Ingress bodies: the transiting default set, minus the Moon, unless the Moon is explicitly
requested.** The Moon changes sign every ~2.3 days — **~161 sign ingresses per year, plus ~161 house
ingresses** — which alone exceeds every other event type combined. Moon sign ingress is a real
electional and mundane datum, so it stays reachable via an explicit `bodies` request over a short
window; it is simply not what a year-ahead query is asking for.

### Q7 — Lunations: same machinery, own event type; eclipse as annotation with both timestamps

**Same machinery, separate event type.** New and Full Moon are Sun–Moon exact aspects at α = 0° and
180°, found by the identical `wrap180` root-finder (§1.3 — and *not* by sign-testing the `-d0`
differential, which makes every Full Moon a discontinuity). They get their own type because they are
transiting-to-transiting: they do not fall out of a natal-target search at all, and the two-moving-
body path has to exist for them regardless. As noted in Q1, lunations need no station segmentation —
the relative speed never reaches zero.

**Quarters: included, opt-in — `include_quarter_moons`, default `false`.** The quarters are standard
and used in mundane and electional work, but New and Full carry the overwhelming majority of the
reading, and the default should produce ~25 lunations per year rather than ~50. Flag name matches
the existing `include_*` family.

**Reported for their own sake, and annotated with natal contact.** New and Full Moon dates are read
as a calendar independent of any natal chart. Each lunation additionally carries `natal_contacts[]`
— same shape as stations — so "the Full Moon falls on your Ascendant" needs no second query.

**Eclipses: annotation on the lunation, never a separate event.** An eclipse *is* a New or Full Moon;
emitting both would double-count the same moment. Source is `-lunecl` / `-solecl` with `-nN`, which
enumerates directly with no search, trimmed to the window (§1.5), matched to the lunation it
annotates.

**The timestamp decision — carry both, name both, pick neither.** Eclipse maximum and exact syzygy
differ by 4–11 minutes (§1.6), and ~10 minutes moves the Ascendant ~2.5°, enough to change the
rising degree of an eclipse chart and sometimes the rising sign. **Practice is genuinely split on
which moment an eclipse chart is cast for**, and I am not going to assert one as the standard when
both are in current use. So:

```jsonc
"datetime":  "2026-02-17T12:01:09Z",          // exact syzygy — the lunation itself
"eclipse": {
  "maximum_datetime": "2026-02-17T12:11:53Z", // greatest eclipse, from swetest
  ...
}
```

Both named unambiguously, both present, consumer chooses. What must *not* happen is one field called
`datetime` that is sometimes one and sometimes the other. Note the degree conventionally quoted —
"the eclipse at 28°50′ Aquarius" — is the syzygy degree, and here both moments round to 28°50′
Aquarius, so the degree is not what is at stake; the chart cast on it is.

**Penumbral lunar eclipses: annotate, do not filter.** The window contains one with penumbral
magnitude **0.0018** (2027-07-18) — astronomically real, visually undetectable, astrologically
marginal. A meaningful minority of practitioners read penumbrals, and in any case the underlying
Full Moon is emitted regardless, so filtering would only drop the annotation. Report
`eclipse_type` verbatim enough to distinguish penumbral, and report the magnitudes, so a consumer
filtering on significance has the numbers to do it. Do not build the judgment into the server.

### Q8 — Moon phase: eight phases on ecliptic longitude — and it does not belong in this tool

**First, the scoping call: `moon_phase` should not be an event type in `find_events`.** It is an
instantaneous chart datum, not a time-domain event — there is no "when" to answer. It belongs on
`calculate_planetary_positions`, which is exactly what SUP-344's own correctness flag #3 already
recommends. Listing it in §1's event table puts the same datum in two tools and attaches a
few-line change to the largest ticket on the list. **Recommend splitting it out as its own small
issue.** This is one of the four revisions in §6.

The convention rulings still apply wherever it lands, and the phase vocabulary is also what the
progressed lunation cycle needs (Q10):

**Vocabulary: the eight-phase scheme, on Moon − Sun ecliptic longitude difference.**

| # | Phase | Band (Moon − Sun) |
|---|---|---|
| 1 | New | 0° – 45° |
| 2 | Crescent | 45° – 90° |
| 3 | First Quarter | 90° – 135° |
| 4 | Gibbous | 135° – 180° |
| 5 | Full | 180° – 225° |
| 6 | Disseminating | 225° – 270° |
| 7 | Last Quarter | 270° – 315° |
| 8 | Balsamic | 315° – 360° |

Why eight rather than four quarters or waxing/waning: the eight-phase scheme **subsumes both**.
Quarters are four of its eight boundaries; waxing is phases 1–4 and waning 5–8. Choosing four or
waxing/waning discards information a consumer cannot recover, while eight loses nothing. It is also
the vocabulary an astrologer actually uses for a natal datum — "born on a Balsamic Moon" is a
standard phrase; "born waning" is not.

**State the boundary convention explicitly and echo it.** The bands above **start at** the exact
aspect (New = 0–45°). This is the Rudhyar-lineage form and is the astrological standard. The almanac
form **centres** bands on the exact aspects (New = 337.5°–22.5°) and gives different names near
boundaries. Echo `phase_scheme: "8-phase, bands start at exact aspect"` rather than leaving a reader
to infer which was used.

**Report alongside the name:** `elongation` (Moon − Sun, 0–360, signed the same way as the bands) and
`illuminated_fraction` (swetest `-`). Compute the elongation from longitudes; do **not** use the `*`
column (§1.4).

### Q9 — Volume: exclude the transiting Moon; group aspects by contact, keep instants chronological

**The measured problem.** DAY_CHART natal, 1 year, 17 natal targets, 5 major aspects, moiety orbs:

| Transiting set | Exact passes / yr | Contact periods / yr |
|---|---|---|
| **Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron** (proposed default) | **118** | **152** |
| All 17 bodies including the Moon | 2565 | 2593 |

**21.7×.** The Moon alone is over 70% of the second row.

**Default transiting set: Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron (7 bodies).**

- **Moon excluded.** A transiting-Moon aspect lasts hours. It is a trigger, read in electional and
  horary work over a deliberately short window — never the answer to "is this a good year." Still
  reachable via explicit `bodies`, where the caller has asked for it knowingly.
- **Sun, Mercury, Venus excluded from the default.** The standard forecasting split is slow bodies
  define chapters, fast bodies trigger them. All three remain available by name; the Sun in
  particular is a reasonable addition for annual work (12 sign ingresses a year, the cardinal ingress
  charts) and costs only ~1 circuit of hits.
- **Asteroids, Lilith excluded from the transiting default**, available by name. They are in
  `DEFAULT_ASPECT_BODIES` for snapshots, which is right — a snapshot row is nearly free — but each
  adds roughly a circuit per year of transit hits for what is minority practice in timing work.
- **North Node excluded from the transiting default, for a specific reason worth recording.** The
  server requests `-pt` (true node). Its wobble (§1.7) generates artifact multi-passes on every
  aspect and multi-ingress on every sign boundary, so transiting-Node events would arrive with pass
  counts that are numerically correct and astrologically meaningless. **The mean Node is monotone**
  (verified: zero reversals), which for a *when* question makes it the better choice — one ingress
  date instead of three. Recommend `node_type` selection (SUP-344 flag #1) lands before the Node
  joins the transiting default. Until then it is available by name with the caveat documented.

**Ordering: aspects grouped by contact; instants chronological. Two arrays, no duplication.**

An aspect event is inherently a *period* — the eval doc's own core requirement, "return every pass
plus enters/leaves orb," only reads correctly if the passes are grouped. Flattened chronologically,
a five-pass Pluto contact interleaves with four other transits and the consumer has to reassemble
what the server already knew. So `contacts[]` is the unit: one row per (transiting body × natal
point × aspect), sorted by `enters_orb`, holding `passes[]`, `closest_approach`, and the envelope.

Stations, ingresses and lunations are inherently *instants* with no envelope, so they go in
`events[]` sorted by datetime.

The cost of this split is that "what is happening in March" requires merging two arrays. That is
accepted, and it is why every item in both arrays carries a top-level UTC datetime. The alternative —
emitting both a grouped and a flat view — duplicates the entire payload to save a merge.

**No silent truncation.** Default window 1 year; maximum 10 years (still cheap — 3653 daily rows per
body, one spawn each). If a result exceeds the cap, truncate and report what was dropped in a
`truncated` block with the count and the criterion. A capped list that looks complete is worse than
an error.

### Q10 — Build it generic now. Explicitly.

**Yes — and the seam is one function.** Everything downstream of position lookup is rate-agnostic:
station segmentation, target enumeration, bisection, orb envelopes, contact grouping, ingress and
lunation solving. The only rate-dependent part is:

```
positionProvider(bodyName, t) -> { longitude, speed }
```

- **Transits:** `swetest` at `t`.
- **Secondary progressions:** `swetest` at `birth + (t − birth) / year_length_days`.
- **Solar arc:** natal longitude + arc(t); speed is the arc rate.

If the implementation instead calls `swetest` inline at the event time, retrofitting progressions
means rewriting the engine. **The implementation ticket must scope for the provider seam**, even
though only the transit provider ships in v1.

Vocabulary carry-over, per type:

| Event | Progressed? | Note |
|---|---|---|
| `aspect_exact` + orb envelope | **Yes** — the main deliverable | Orbs differ, see below |
| `station` | **Yes**, and it is a technique in its own right | Progressed stations are rare, which makes them *more* significant |
| `sign_ingress` | **Yes** | Progressed Sun (~30 yr) and progressed Moon (~2.5 yr) sign changes are canonical |
| `house_ingress` | **Yes** | Progressed Moon through the natal houses is the single most-used progression technique |
| `lunation` (syzygy) | **Yes** | The progressed lunation cycle (~29.5 yr) is a major technique — same Sun–Moon search at the progressed rate |
| `lunation.eclipse` | **No** | An eclipse is a physical shadow event. There is no progressed eclipse |

**Two things must be parameters, not constants, or the generic engine is generic in name only:**

1. **The orb table.** Standard progression orb is about **1°**, against 6–12° for transits. A
   progressed Moon aspect at a transit orb would be "in orb" for years and mean nothing. If the orb
   tables are reached for directly rather than injected, progressions will inherit transit orbs and
   the output will be unreadable.
2. **The eclipse annotation**, which is transit-only.

---

## 3. Output schema

### 3.1 Parameters

```jsonc
{
  "birth_datetime": "1985-04-12T23:20:50Z",   // required
  "latitude": 51.4769,                        // required
  "longitude": 0.0,                           // required
  "window_start": "2026-01-01T00:00:00Z",     // required, UTC
  "window_end":   "2027-01-01T00:00:00Z",     // required, UTC; max 10 years from start
  "event_types": ["aspect", "station", "sign_ingress", "house_ingress", "lunation"],
  "house_system": "P",                        // same codes/validator as every other tool
  "bodies": ["Saturn", "Pluto"],              // TRANSITING side; default Mars..Pluto + Chiron
  "targets": ["Sun", "Moon"],                 // NATAL side; default DEFAULT_ASPECT_BODIES
  "include_minor": false,
  "include_angles": false,
  "include_south_node": false,
  "include_vertex": false,
  "include_quarter_moons": false,
  "orb_overrides": {},
  "orb_model": "moiety"
}
```

`bodies` and `targets` are separate because the two sides have genuinely different defaults (Q9) —
reusing one `bodies` parameter for both would force the natal target list to shrink with the
transiting list.

### 3.2 `contacts[]` — aspect periods

Sorted by `enters_orb` ascending.

```jsonc
{
  "transiting_body": "Saturn",
  "natal_point": "Sun",
  "aspect": "square",
  "category": "major",
  "aspect_angle": 90,
  "orb_allowed": 12,
  "enters_orb": "2026-02-02T17:55:52Z",
  "leaves_orb": "2028-02-07T00:32:27Z",
  "passes": [
    { "datetime": "2026-05-16T14:04:26Z", "longitude": 10.814261, "sign": "Aries", "degree": 10.81,
      "speed":  0.100581, "retrograde": false },
    { "datetime": "2026-10-10T17:44:22Z", "longitude": 10.814261, "sign": "Aries", "degree": 10.81,
      "speed": -0.077910, "retrograde": true  },
    { "datetime": "2027-02-07T02:42:05Z", "longitude": 10.814261, "sign": "Aries", "degree": 10.81,
      "speed":  0.092286, "retrograde": false }
  ],
  "closest_approach": { "datetime": "2026-05-16T14:04:26Z", "orb": 0, "stationary": false },
  "birth_time_sensitive": false,
  "enters_orb_truncated": false,
  "leaves_orb_truncated": false
}
```

- **`speed` on every pass is required** — SUP-344 §1 calls it out, and it is what tells the reader
  whether a contact sits for months or passes in days. Signed, decimal degrees/day, full precision.
- **`retrograde` is explicit**, not left to the sign of `speed` (SUP-344 correctness flag #2).
- **Datetimes are UTC, to the second.**
- **`orb` values are numbers, not strings.** `calculate_transits` and `calculate_synastry` stringify
  orbs with `.toFixed(2)` (`index.js:757`, `index.js:808`). Do not propagate that here — SUP-345
  §3.1 made the same call for the same reason.
- **`*_truncated`** marks an envelope boundary clipped by the window rather than found. Without it a
  contact already underway at `window_start` reads as beginning there.
- `passes` **may be empty** (Q4).

### 3.3 `events[]` — instants

Sorted by `datetime` ascending. Every entry has `type` and `datetime`.

```jsonc
// station
{ "type": "station", "datetime": "2026-12-12T22:17:19Z", "body": "Neptune",
  "direction": "direct", "longitude": 1.6129272, "sign": "Aries", "degree": 1.61,
  "natal_contacts": [ { "natal_point": "Pallas", "aspect": "conjunction", "orb": 0.0533879 } ] }

// sign_ingress  (retrograde ingress moves BACKWARDS into the preceding sign)
{ "type": "sign_ingress", "datetime": "2024-09-02T...Z", "body": "Pluto",
  "direction": "retrograde", "from_sign": "Aquarius", "to_sign": "Capricorn",
  "longitude": 300.0 }

// house_ingress  (natal house frame; NOT swetest -fj)
{ "type": "house_ingress", "datetime": "...", "body": "Saturn",
  "direction": "direct", "from_house": 6, "to_house": 7,
  "cusp_longitude": 205.1918830, "house_system": "P",
  "coincides_with_sign_ingress": false }

// lunation, with eclipse annotation
{ "type": "lunation", "phase": "new", "datetime": "2026-02-17T12:01:09Z",
  "longitude": 328.828887, "sign": "Aquarius", "degree": 28.83,
  "eclipse": {
    "eclipse_type": "annular solar",
    "maximum_datetime": "2026-02-17T12:11:53Z",
    "magnitudes": [0.9638, 0.9797, 0.9288],
    "saros_series": 121, "saros_number": 61
  },
  "natal_contacts": [ ... ] }
```

`eclipse` is absent, not null, when the lunation is not an eclipse. `magnitudes` is three values for
solar (NASA / diameter fraction / obscuration) and two for lunar (umbral / penumbral) — do not force
one shape onto the other (§1.5).

### 3.4 `settings_used` and `window`

```jsonc
"window": { "start": "...", "end": "...", "truncated": false },
"settings_used": {
  "event_types": [...],
  "bodies": [...],            // transiting side actually used
  "targets": [...],           // natal side actually used
  "house_system": "P",
  "orb_model": "moiety",
  "orb_overrides": {},
  "include_minor_aspects": false,
  "include_angles": false,
  "include_south_node": false,
  "include_vertex": false,
  "include_quarter_moons": false,
  "node_type": "true"          // see §6.3 — must be stated, the server uses -pt
}
```

`node_type` is echoed as a literal `"true"` even before it becomes settable. A transiting or natal
Node event is not interpretable without it (§1.7: 1.762° = 66 days of Pluto).

---

## 4. Test expectations

All values below were produced on 2026-08-08 against the vendored ephemeris using only
`test/fixtures/charts.js`. No new fixture is required.

### 4.1 Multi-pass — the core claim of the ticket

Transiting body → **DAY_CHART** natal point, window 2026-01-01 → 2029-01-01.

**Five passes — transiting Pluto square natal Lilith** (target longitude 306.4639894):

| # | Datetime (UTC) | Longitude | Speed | Direction |
|---|---|---|---|---|
| 1 | 2027-03-12T21:56:55Z | 306.4639894 | +0.0239122 | direct |
| 2 | 2027-07-06T22:59:00Z | 306.4639895 | −0.0212389 | retrograde |
| 3 | 2028-01-17T11:40:56Z | 306.4639893 | +0.0311870 | direct |
| 4 | 2028-10-03T10:44:26Z | 306.4639894 | −0.0071862 | retrograde |
| 5 | 2028-11-03T16:49:02Z | 306.4639893 | +0.0073476 | direct |

**Three passes — transiting Pluto conjunct natal Venus** (306.2219606):

| # | Datetime (UTC) | Speed | Direction |
|---|---|---|---|
| 1 | 2027-03-03T08:49:49Z | +0.0267487 | direct |
| 2 | 2027-07-17T22:09:25Z | −0.0227313 | retrograde |
| 3 | 2028-01-09T15:22:28Z | +0.0304325 | direct |

**Four passes — transiting Neptune sextile natal Venus** (6.2219606): 2027-05-30T13:35:34Z (D),
2027-08-20T10:31:16Z (R), 2028-03-23T18:26:23Z (D), 2028-11-25T10:59:56Z (R).

**Assert the pass count is not required to be odd.** Four is correct here: this is a five-pass
contact whose final direct pass falls outside the window, and `leaves_orb_truncated` must be `true`.
"Passes alternate direct/retrograde/direct and therefore come in odd numbers" is a natural-looking
invariant that is wrong at any window boundary.

### 4.2 Station within orb, never perfecting — the Q4 regression test

Transiting Neptune, DAY_CHART natal Pallas at **1.5595393** (1°33′34.3″ Aries), window 2026-01-01 →
2029-01-01:

| Assertion | Expected |
|---|---|
| Station direct | **2026-12-12T22:17:19Z** at longitude **1.6129272** (1°36′46.5″ Aries) |
| Gap to natal Pallas at that station | **0.0533879° = 3′12.2″** |
| Station's `natal_contacts` | contains `Pallas / conjunction`, orb 0.0533879 |
| Exact passes in the conjunction contact | **exactly 1** (2026-02, direct) — not 3 |
| `closest_approach.stationary` | `true` for the second approach |

This is the case that fails if the implementation assumes an outer planet inside orb across a
retrograde produces three passes.

### 4.3 Volume and default scope

DAY_CHART natal, window 2026-01-01 + 366 days, 17 natal targets, 5 major aspects, moiety orbs:

| Transiting set | Exact passes | Contact periods |
|---|---|---|
| Default (Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron) | **118** | **152** |
| All 17 bodies including the Moon | **2565** | **2593** |

Assert the default response contains no `transiting_body: "Moon"` row, and that
`bodies: ["Moon"]` explicitly requested does return them. The 21.7× ratio is the justification for
the default and should be recorded in the test as a comment, not asserted numerically (it will drift
with ephemeris updates); assert the Moon's absence and presence instead.

### 4.4 Orb model changes the period, in both directions

Transiting Saturn square DAY_CHART natal Sun (target 10.8142608). **Identical passes under both
models** — assert this explicitly, since it is what makes the envelope difference legible:

| Model | Orb | enters_orb | leaves_orb | Days |
|---|---|---|---|---|
| moiety | 12 | 2026-02-02T17:55:52Z | 2028-02-07T00:32:27Z | 734.3 |
| class | 8 | 2026-03-10T00:14:51Z | 2027-04-16T19:44:33Z | 402.8 |

Passes under both: 2026-05-16T14:04:26Z (D), 2026-10-10T17:44:22Z (R), 2027-02-07T02:42:05Z (D).

Also assert the reverse direction on a different pair, so a test cannot pass by assuming moiety is
always wider: Pluto conjunct natal Venus is 6° under moiety and 8° under class.

### 4.5 Stations

Window 2026-01-01 + 730 days:

| Body | Station | Datetime (UTC) | Longitude |
|---|---|---|---|
| Neptune | retrograde | 2026-07-07T10:54:29Z | 4.4180692 (4°25′05.0″ Aries) |
| Neptune | direct | 2026-12-12T22:17:19Z | 1.6129272 (1°36′46.5″ Aries) |
| Saturn | retrograde | 2026-07-26T19:56:27Z | 14.7499589 (14°44′59.9″ Aries) |
| Saturn | direct | 2026-12-10T23:31:04Z | 7.9310379 (7°55′51.7″ Aries) |

Negative assertions on the same call:

- **No station event for the true Node**, Sun, Moon, or Lilith. The Node is the one that matters: at
  6-hourly resolution it reverses 352 times in 2026. Assert by body name.
- **~25 station events per calendar year across all bodies.** A result in the hundreds means the
  Node exclusion regressed.

### 4.6 Ingresses

- **Retrograde re-ingress.** Transiting Pluto, window 2023-01-01 → 2025-06-01, crossings of 300°:
  **five** — 2023-03-23 (D), 2023-06-11 (R), 2024-01-21 (D), 2024-09-02 (R), 2024-11-19 (D). Assert
  the count and that the two retrograde rows carry `to_sign: "Capricorn"`, not `"Aquarius"`.
- **Whole Sign degeneracy.** DAY_CHART natal with `house_system: 'W'`: assert the natal cusps are
  exactly `0, 30, 60 … 330`; assert every `house_ingress` has a `sign_ingress` for the same body at
  the same datetime (within 1 s); assert every `house_ingress` carries
  `coincides_with_sign_ingress: true`; assert **neither array is empty**.
- **Placidus non-degeneracy.** Same chart with `house_system: 'P'` (cusps 25.1918830, 61.6595009,
  82.4248898, 100.0003985, …): assert `coincides_with_sign_ingress` is `false` on every row.
- **The `-fj` regression guard.** For a body in the default set over a 30-day window, assert the
  count of `house_ingress` events is single-digit. If someone wires up swetest's `j` column, the
  transiting house frame rotates daily and the count jumps by roughly 12× — a loud, unambiguous
  failure.

### 4.7 Lunations and eclipses

Window 2026-01-01 + 366 days:

| Assertion | Expected |
|---|---|
| First Full Moon of 2026 | 2026-01-03T10:02:55Z, Moon 103.032890 |
| First New Moon of 2026 | 2026-01-18T19:51:59Z, Moon 298.732110 |
| First Quarter | 2026-01-26T04:47:24Z — absent unless `include_quarter_moons` |
| Last Quarter | 2026-01-10T15:48:24Z — absent unless `include_quarter_moons` |
| Lunation count, default | ~25/yr (New + Full only) |
| Solar eclipse annotation | lunation at **2026-02-17T12:01:09Z**, `eclipse.maximum_datetime` **2026-02-17T12:11:53Z**, `eclipse_type` "annular solar", saros 121/61 |
| Lunar eclipse annotation | lunation at **2026-03-03T11:37:54Z**, `eclipse.maximum_datetime` **2026-03-03T11:33:41Z**, `eclipse_type` "total lunar eclipse", saros 133/27 |

**Assert `datetime !== eclipse.maximum_datetime` on both**, with the sign of the difference opposite
between them (syzygy is 4.21 min *after* the lunar maximum and 10.73 min *before* the solar
maximum). One test, and it pins §1.6 permanently — a future refactor that collapses the two fields
fails immediately.

Also assert `eclipse` is **absent** (not `null`) on non-eclipse lunations, and that a penumbral
lunar eclipse with `magnitudes: [0.0000, 0.0018]` is still emitted rather than filtered.

### 4.8 ΔT regression guard

Every JD handed between calls must carry `-ut`. Assert that resolving the eclipse JD
`2461102.981727` yields Moon longitude **162.8592488** (12°51′33.3″ Virgo). Without `-ut` swetest
reads it as ET and returns 12°50′55.1″ — **38.2″ off**. A single assertion on that longitude catches
every dropped `-ut` in the JD handoff path.

### 4.9 Fixture coverage

- **DAY_CHART** carries every case in §4.1–4.6. Nothing else is needed for the aspect and station
  work.
- **SOUTHERN_CHART** is required for house ingress: its natal cusps come from a southern latitude, so
  a cusp-ordering or sign-wrap error in `findHouseForLongitude` shows up there and not at Greenwich.
- **PARTNER_CHART** is the second natal chart for a targets-parameter test.
- **NIGHT_CHART is not needed.** Nothing in this feature is sect-dependent — worth stating, since the
  CLAUDE.md guidance to exercise the DAY/NIGHT pair exists for sect-dependent logic. The one
  exception: if Part of Fortune is used as a natal target (`include_angles`), its position *is*
  sect-dependent, so a single contact test against natal Part of Fortune should run on both.

Add to `test/fixtures/charts.js` under `DAY_CHART.expected`:

```js
expected: {
  sect: 'day',
  sunHouse: 10,
  partOfFortune: 77.6453,
  // NEW — window 2026-01-01 .. 2029-01-01, default transiting set, moiety orbs
  plutoSquareLilithPasses: 5,
  plutoConjunctVenusPasses: 3,
  neptuneStationDirect2026: '2026-12-12T22:17:19Z',
}
```

---

## 5. Suggested implementation order

Steps 1–3 are the engine and are independently testable without any MCP surface. That is the seam if
the ticket has to be split.

1. **`lib/swetest-parse.js`** — add `parseStepRow` for the four-column decimal `-fJPls` CSV, and
   `parseEclipseBlock` for the tab-delimited three-line eclipse format with its differing lunar and
   solar field counts (§1.5). Unit tests against captured swetest output for both. This is where
   §1.5 is pinned.
2. **`lib/ephemeris-series.js` (new)** — the position provider seam (Q10) and the stepped-scan
   wrapper. `seriesFor(body, start, end, stepDays)` → `[{jd, longitude, speed}]`, plus
   `positionAt(body, jd)` which **always passes `-ut`** (§4.8).
3. **`lib/event-search.js` (new)** — the rate-agnostic engine: station detection, monotone
   segmentation, target-longitude enumeration, refinement to ±1 min, orb envelopes,
   `closest_approach`, contact grouping. Takes a position provider and an orb table; knows nothing
   about transits, `swetest`, or MCP.
4. **`lib/aspects.js`** — reuse `normalizeSeparation` and the resolved orb tables; export the orb
   resolution so step 3 can be handed a table rather than reaching for one. No new orb class and no
   change to `DEFAULT_ORBS` / `ANGLE_ORBS` / `DERIVED_ORBS` — this ticket adds no aspect and moves no
   orb, so the major-wider-than-minor ordering in all three classes is untouched. Assert that it
   still holds, since the standing check is cheap.
5. **`index.js`** — the `find_events` tool: schema, validation (reuse `validateHouseSystem`,
   `validateOrbModel`, `invalidOrbOverrideKeys`), natal chart via `calculateEphemeris`, targets via
   `resolveAspectBodies` (Q2), house ingress against natal cusps via `findHouseForLongitude` (§1.2),
   `settings_used` echoes including `node_type`.
6. **README** — the tool, the default transiting set and why the Moon is excluded, the contacts/events
   split, `birth_time_sensitive`, the two eclipse timestamps, and the Whole Sign coincidence flag.

---

## 6. Revisions to SUP-344 §1

Four items, from my own evaluation document, that the verified mechanics change.

### 6.1 The cost assumption is obsolete, and it changes the output shape

§1 was written on the assumption of per-instant sampling — "12–20 calls to bracket three exact hits
plus the in-orb/out-of-orb boundaries, per aspect." With stepped scanning and monotone segmentation
a full year over the default body set is ~7 subprocess spawns for the scan plus 3–5 per refined
event.

This is not just a cheaper number. §1 framed `enters_orb` / `leaves_orb` as an *additional*
requirement layered on top of exact hits. On the revised cost they fall out of the same enumeration
for free, which makes the **period** the natural primary unit of output rather than the hit list.
That is the reasoning behind `contacts[]` in Q9, and I would not have proposed it under the original
cost model.

### 6.2 `moon_phase` does not belong in this tool

§1's event table lists `moon_phase` at an instant as the sixth event type. It is not an event — there
is no "when" to answer — and SUP-344's own correctness flag #3 already recommends returning it from
`calculate_planetary_positions`, which is where it belongs. Keeping it here duplicates a datum across
two tools and attaches a few-line change to the largest ticket on the list.

**Recommend: split into its own issue** against `calculate_planetary_positions`, with the Q8
conventions (eight phases, ecliptic longitude not elongation, bands starting at the exact aspect,
scheme echoed).

### 6.3 §1 ruled on transiting angles but said nothing about natal angles, and the omission matters

§1 says "do not include transiting angles" and that is right. But targets were left unstated, and
natal angles are both high-value targets *and* the one class of target whose event dates are
materially less certain than the rest: a 10-minute birth-time error is ~2.5° of Ascendant, which at
Pluto's speed is **~94 days**. §1 should have flagged that. Q2 adds `birth_time_sensitive` as a
required output field.

Related, and also missing from §1: the server requests `-pt` (true node) and does not label it
(SUP-344 correctness flag #1). In the time domain that unlabelled choice is worse than in a snapshot
— the true Node's wobble produces artifact multi-passes and **triple sign ingresses** (§1.7), and
true-vs-mean is 1.762° apart in 2026, which is 66 days of Pluto. Q9 keeps the Node out of the
transiting default because of it.

### 6.4 "One to five times" is right; "therefore an odd number" is not

§1 says an outer planet crosses a natal point "one to five times," which is correct. Worth adding
explicitly, because it is where a reasonable implementation will add a wrong assertion: **the count
returned for a window can be even.** Verified both failure directions —

- Transiting Neptune sextile DAY_CHART natal Venus returns **4** passes over 2026–2029, because the
  window truncates a five-pass contact.
- Transiting Neptune conjunct natal Pallas returns **1** pass where an outer planet retrograding
  inside orb suggests 3, because it stations 3′12″ short (§4.2).

---

## 7. Follow-ups to file separately

| Item | Why not here |
|---|---|
| **`moon_phase` on `calculate_planetary_positions`** | Not a time-domain event (§6.2). Few lines; should not wait on this ticket |
| **`node_type: "true" \| "mean"` + README fix** | SUP-344 correctness flag #1. Blocks the Node joining the transiting default (Q9); small and independent |
| **`retrograde` / `stationary` flags on chart bodies** | SUP-344 correctness flag #2. `find_events` needs the same speed threshold; agree it once, in that ticket |
| **Progressed and solar-arc events** | Blocked on SUP-344 §3 shipping. The provider seam (Q10) is built here so this is a provider, not a rewrite |
| **Two-moving-body (mundane) aspect search** | Saturn–Neptune and similar. Needs segmentation at equal-speed points, not stations (Q1). Lunations are the special case that ships in v1 |
| **`out_of_bounds` periods** | SUP-345 §6 already routes this here. It is a declination crossing of the obliquity — same solver, different quantity. File once both have landed |
| **Void-of-course Moon** | The natural companion to Moon sign ingress, and the reason a caller would request the Moon explicitly. Its own conventions (which aspects count, Lilly vs modern) — do not smuggle it in |
| **Fixed-star and Arabic-part contacts** | Honourable-mention tier in SUP-344 |

---

*Chart data throughout uses the repository's synthetic fixtures in `test/fixtures/charts.js`.
Figures were produced on 2026-08-08 against the vendored Swiss Ephemeris 2.10.03 in worktree
`issue/SUP-344`. Scope is Western tropical throughout; Vedic, sidereal and Hellenistic techniques are
out of scope for this server.*
