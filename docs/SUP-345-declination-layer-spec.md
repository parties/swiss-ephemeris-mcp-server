---
type: spec
target_repo: swiss-ephemeris-mcp-server
status: ready-for-implementation
raised: 2026-08-08
author: Astrology Advisor
implements: docs/SUP-344-top-five-missing-features.md §2
ephemeris_version_tested: swiss-ephemeris-mcp-server@1.0.2 (worktree issue/SUP-344, 9d42a34)
swetest_version: 2.10.03
scope: Western tropical astrology only
---

# SUP-345 — declination layer: ecliptic latitude, declination, parallels, out-of-bounds

Implementation-ready spec. Every number below was produced on 2026-08-08 against the vendored
Swiss Ephemeris in this worktree, using only the synthetic fixtures in `test/fixtures/charts.js`.

---

## 0. One-paragraph summary

Change two `swetest` format strings (`-fPZS` → `-fPZSBD`, `-fPZ` → `-fPZSBD`) and append `o` to the
planet `-p` list. That yields ecliptic latitude, declination, and the obliquity of the date from
calls the server already makes. Surface latitude/declination/out-of-bounds on every body
unconditionally (purely additive), and a new `declination_aspects[]` array — parallel and
contraparallel at a flat **1° orb** over **16 bodies** — behind a new opt-in flag
`include_declination_aspects`, default `false`, on `calculate_planetary_positions`,
`calculate_aspects`, `calculate_transits`, and `calculate_synastry`.

---

## 1. Four verified parsing traps

These are the whole risk surface of the ticket. Three of the four are silent — they produce
plausible wrong numbers rather than errors.

### 1.1 House/angle lines have no latitude column (already flagged on the issue — confirmed)

Planet lines under `-fPZSBD` emit **five** fields; house, angle, and Vertex lines emit **four**.
The latitude column is omitted for cusps (their latitude is 0 by definition), so field 4 is the
**declination**, not the latitude.

```
$ swetest -b01.01.1990 -ut12:00:00 -p0123456789tADFGHI -fPZSBD -g, -head
Sun            ,10 cp 48'51.3388,   1° 1'10.1129,   0° 0' 0.0460, -23° 0' 6.6992
                └ name            └ longitude     └ speed       └ latitude   └ declination

$ swetest -b01.01.1990 -ut12:00:00 -house0.0,51.4769,P -fPZSBD -g, -head
Ascendant      ,25 ar 11'30.7789, 783°25'21.2571,   9°44'57.0155
                └ name            └ longitude     └ "speed"     └ DECLINATION (no latitude column)
```

A positional parse of house lines that assumes the planet layout reads declination into `latitude`
and leaves `declination` undefined. `parsePlanetLine`, `parseHouseLine`, and `parseChartPointLine`
need distinct column maps. The signed-DMS parse currently inlined for `speed` in `parsePlanetLine`
(`lib/swetest-parse.js:60-66`) should be extracted to a shared helper and reused for latitude and
declination — all three are the same signed `D°MM'SS.ssss` form.

### 1.2 The cusp "speed" column is not a planetary speed — do not store it as `speed`

Field 3 on a house/angle line is `783°25'21"` — the cusp's diurnal rotation rate, not a body's
motion. Today `chart_points` entries carry no `speed`, so `toAspectBody` (`lib/aspects.js:170`)
resolves `speed ?? null` and `computeApplying` correctly returns `null` for every angle contact.

**If the new `-fPZSBD` house output causes anyone to parse field 3 into `chart_points.*.speed`,
every ASC/MC/Vertex aspect in the server silently acquires a bogus `applying` flag computed from a
783°/day rate.** That is a regression in existing, tested behaviour, introduced by a change that
looks unrelated. Do not parse the S column on house lines at all; if it is parsed for
completeness, it must not be named `speed` and must not reach `toAspectBody`.

### 1.3 ARMC's declination column is meaningless

```
ARMC           ,10 cp 52'46.0866, 360°59' 8.3304,   0° 0' 0.0000
```

ARMC is a right ascension printed in zodiacal notation, not an ecliptic longitude. swetest emits
`0° 0' 0.0000` in the declination slot. Verified: the identity in §1.5 holds to 0.0001″ for every
cusp, ASC, MC and Vertex, and fails by 82787″ for ARMC.

**Do not add `declination` to `chart_points.ARMC`.** A literal `0` there would read as "on the
celestial equator," which is false.

### 1.4 `Ecl. Obl.` is a pseudo-body and must never enter `planets`

Appending `o` to `-p` adds an obliquity row that parses cleanly as a body at 23°26′ Aries:

```
Ecl. Obl.      ,23 ar 26'32.5178,   0° 0' 0.0000,  23°26'26.0890,   0° 0' 0.0000
                └ TRUE obliquity                   └ MEAN obliquity
```

The name falls through `planetNames` (`index.js:428-447`) to `planet.name`, so without an explicit
exclusion the server would report a body called `Ecl. Obl.` at 23.44° Aries, and it would enter
aspect matching. The existing missing-ephemeris placeholder guard (`longitude === 0 && speed === 0`)
does not catch it. Exclude by name before the `planets` assignment.

Note that the true obliquity arrives encoded as a zodiacal position that happens to land in Aries,
so sign-map arithmetic yields the right number by luck. Two ways to avoid relying on that:

- **Recommended:** extend the planet format to `-fPZSBDl` and read the obliquity row's decimal
  `l` field (`23.4423661`). One extra ignored column on every row, no extra subprocess.
- Alternative: a third `swetest -po -fPl -g, -head` call. Correct but adds ~50% to the per-chart
  subprocess count, and `calculate_synastry` already spawns four.

### 1.5 The identity that drives §2 and §3

For any point with ecliptic latitude 0:

```
δ = arcsin( sin ε · sin λ )
```

Verified against swetest on DAY_CHART (ε = 23.4423661°) for all 12 Placidus cusps, Ascendant, MC,
Vertex, and the true Node — **agreement better than 0.0001″ in every case**. This is not an
approximation; it is what "latitude 0" means. Everything in §2 and §3 about the Nodes and the
angles follows from it.

---

## 2. The seven open questions, answered

### Q1 — Orb

| Setting | Value |
|---|---|
| `parallel` default orb | **1°00′** |
| `contraparallel` default orb | **1°00′** — same as parallel |
| Luminary widening to 1°30′ | **Not the default.** Available via override only |
| Where it lives | Its **own top-level class**, `orb_overrides.declination`, accepted under **both** orb models |
| Moiety table | **Not touched.** No declination entries in `MOIETIES` |

**1° is the mainstream Western default** — Solar Fire, Astro Gold, and astro.com all default to 1°
for parallel and contraparallel, and the modern declination literature (Boehrer and successors)
teaches 1°. The 1°30′ luminary widening is a real minority refinement, not the default; expose it,
don't assume it.

**Contraparallel takes the same orb as parallel.** Parallel reads as conjunction-force and
contraparallel as opposition-force, and this server already gives conjunction and opposition equal
orbs in *every* existing class (`DEFAULT_ORBS` 8/8, `ANGLE_ORBS` 5/5, `DERIVED_ORBS` 3/3).
Splitting them here would break a parity the rest of the codebase maintains.

**Confirmed: this is its own orb class, not a moiety entry.** A moiety is a longitudinal half-orb;
summing two bodies' longitudinal half-orbs to bound a declination difference is a category error.

Three implementation constraints follow, and all three are easy to get wrong:

1. **`orb_overrides.declination` must be accepted under both `orb_model: 'moiety'` and
   `orb_model: 'class'`.** `invalidOrbOverrideKeys` (`lib/aspects.js:258`) currently rejects any key
   that isn't valid for the active mode: in moiety mode only `moieties`/`multipliers`, in class mode
   only aspect names plus `body`/`angle`/`derived`. A new `declination` key falls into `invalid` in
   **both** branches unless whitelisted in both. Declination orbs are orb-model-independent —
   moiety-vs-class is a longitude concept and must not silently change a declination orb.
2. **Do not add `declination` to `ORB_CLASSES`.** `resolveOrbsForClass` spreads every
   non-class-name override key into every class. If `declination` became a class, a flat aspect-name
   override would leak into the declination table and a `declination` override would be pulled out of
   the global spread in a way that reads correct but couples the two systems. Give declination its
   own small resolver: `{ ...DECLINATION_ORBS, ...orbOverrides.declination }`.
3. **Nested key validation:** `orb_overrides.declination` accepts only `parallel` and
   `contraparallel`. Anything else goes into `invalid` with the existing error shape.

**Standing check — major-wider-than-minor ordering.** Adding a declination class does not modify
`DEFAULT_ORBS`, `ANGLE_ORBS`, or `DERIVED_ORBS`, so the major > minor ordering in all three
longitude classes is untouched. Require a test asserting the two tables are **disjoint in both
directions**: a `declination` override must not alter any longitude orb, and a flat aspect-name
override (e.g. `{ conjunction: 12 }`) must not alter `parallel`/`contraparallel`.

### Q2 — Participating bodies: 16, not 17

**The rule: a declination contact is reported only between points whose declination is an
independently computed physical datum. Points that lie on the ecliptic by construction are
excluded, because for them declination is a restatement of longitude (§1.5).**

```js
export const DECLINATION_ASPECT_BODIES = [
  'Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn',
  'Uranus', 'Neptune', 'Pluto', 'Lilith', 'Chiron',
  'Ceres', 'Pallas', 'Juno', 'Vesta',
];  // DEFAULT_ASPECT_BODIES minus 'North Node'
```

**Nodes — excluded.** The lunar Node's ecliptic latitude is exactly `0° 0' 0.0000` by definition
(both mean and true), so its declination is fully determined by its longitude via §1.5. "X parallel
the Node" therefore states only that X's declination equals the declination *of that ecliptic
degree* — a fact about X's own longitude and latitude, not a contact with the Node. On DAY_CHART
including the Node adds exactly one row, and it is an artifact:

```
Chiron contraparallel North Node   orb 0°19'28"
```

That row means "Chiron's declination matches the ecliptic degree opposite the Node." No school
reads that as a Chiron–Node contact. Same reasoning applies to the South Node (latitude 0 by the
same construction). The Node's *declination* is still a real ephemeris output and **is reported**
in `planets` — only aspect participation is dropped.

**Lilith (mean Apogee) — included.** Unlike the Nodes, mean Apogee carries genuine ecliptic
latitude (−5°02′02.69″ on DAY_CHART), so its declination is non-degenerate and a parallel to it is
not an artifact. It is already in `DEFAULT_ASPECT_BODIES` for longitude; excluding it from
declination alone would require a second, weaker rule. This is the one judgment call in the list —
the argument for it is geometric, not a claim that declination practice has an established Lilith
convention. It doesn't.

**Chiron and the four asteroids — included.** Real bodies, independently computed declinations,
and high inclinations, which is exactly where declination carries information longitude cannot:
Pallas sits at −20°06′57″ *latitude* on DAY_CHART, nowhere near where its longitude suggests in the
actual sky. The consistency argument is decisive — the server already aspects all five in longitude
by default, and "Ceres square is reportable but Ceres parallel is not" is incoherent.

**Part of Fortune and lots — excluded, and they get no `declination` field at all.** A lot is a
longitude construct with no physical position; assigning it a declination is not a convention any
school uses. Unlike the Node — whose declination is a real number the ephemeris emits — a lot's
would have to be fabricated. Omit the field rather than emit `null`, so a consumer cannot compute
with it by accident.

**Interaction with the existing `bodies` parameter.** `bodies` filters the declination set the same
way it filters the longitude set, then latitude-0 points are dropped unconditionally. Passing
`bodies: ['Sun', 'Moon', 'North Node']` yields declination aspects over `['Sun', 'Moon']`. The drop
is not overridable in v1 — it is a correctness rule, not a taste rule — and must be **visible**:
echo `declination_bodies` in `settings_used` showing what was actually used. If demand appears
later, an `include_node_declination_aspects` flag is the additive escape hatch.

**Flat 1° orb for all pairs — accepted limitation.** An asteroid parallel is not read with the
weight of a Sun–Moon parallel, and the moiety machinery that encodes that in longitude has no
declination analogue. Mainstream declination software uses a flat orb; inventing a declination
moiety table would be a team-constructed convention with no source behind it. Document the
limitation, don't paper over it.

### Q3 — Angles: report declination, do not form declination aspects

**ASC, MC, IC, DSC, Vertex, and all 12 house cusps get a `declination` field. None of them
participates in `declination_aspects`.** Two independent reasons, both verified:

**(a) Their declination is a restatement of their longitude.** All are ecliptic points with latitude
0, so §1.5 applies exactly. Worked out: for two zero-latitude points, `sin λ₁ = sin λ₂` gives
`λ₁ = λ₂` **or** `λ₁ = 180° − λ₂`. So *parallel ≡ conjunction or antiscion*, and *contraparallel ≡
opposition or contra-antiscion*. Reporting these as "parallels" would double-count conjunctions the
server already reports and smuggle antiscia in under the wrong label with the wrong orb. If antiscia
are wanted, ship antiscia honestly (Q7).

**(b) The mirror rule does not carry over — it gets worse.** `DSC declination = −(ASC declination)`
and `IC declination = −(MC declination)` **exactly**, because the axis points are 180° apart on the
ecliptic. So every angle contact appears twice under two labels at identical orb. Measured on
DAY_CHART with angles included:

```
Sun     ∥ Midheaven  0°03'48.84"      Sun     # IC          0°03'48.84"
Moon    # Ascendant  0°48'44.36"      Moon    ∥ Descendant  0°48'44.36"
Jupiter # Midheaven  0°09'35.37"      Jupiter ∥ IC          0°09'35.37"
Saturn  ∥ Midheaven  0°49'59.35"      Saturn  # IC          0°49'59.35"
Uranus  ∥ Midheaven  0°31'13.05"      Uranus  # IC          0°31'13.05"
Juno    # Ascendant  0°37'50.51"      Juno    ∥ Descendant  0°37'50.51"
Ascendant # Descendant  0°00'00.00"   Midheaven # IC        0°00'00.00"
```

`ASPECTABLE_ANGLES` solves this in longitude by dropping IC/DSC and recovering their contacts via a
180° mapping documented in the README. That mapping **is not lossless in declination**: it flips
parallel to contraparallel, so the recovery rule would differ from the longitude one, and the two
degenerate self-contacts at the bottom (ASC contraparallel DSC at orb 0°00′00″, MC contraparallel
IC likewise) would sort to the top of the list as the tightest "aspects" in the chart. Also note
`Sun ∥ Midheaven` above is simply "the Sun is conjunct the MC" (0.81° in longitude, already
reported) restated at a tighter-looking orb.

Excluding angles avoids all of it, and it falls out of the same one-line rule as Q2. No angle-side
gating, no `include_angles` interaction, nothing to test beyond "angles never appear in
`declination_aspects`."

### Q4 — Out-of-bounds: true obliquity of the date, Sun suppressed

| Decision | Value |
|---|---|
| Boundary | **True obliquity of the ecliptic for the chart moment** (mean + nutation in obliquity) |
| Source | swetest `-po`, true value; echoed as `obliquity` + `obliquity_type: "true"` |
| Test | `\|declination\| > obliquity` |
| Reported | `out_of_bounds: boolean` **and** `out_of_bounds_by` (decimal degrees when true, `null` when false) |
| Applies to | Bodies in `planets` only. **Not** angles, cusps, Vertex, or lots |
| Sun | **`out_of_bounds: false` unconditionally** |

**Why true obliquity and not the Sun's actual maximum declination that year.** The latter is what
"out of bounds" means informally, but as a specification it is ambiguous (which year for a late-
December chart? calendar year or tropical year?), it needs an extra solstice search, no mainstream
program does it, and it differs from the obliquity by well under an arcsecond. True obliquity is
what the Sun actually reaches at that moment; that is the boundary. Mean obliquity is defensible but
is a smoothed value the Sun demonstrably exceeds — the true-mean gap reaches 9.2″ and on DAY_CHART
is 6.43″ (true 23°26′32.52″, mean 23°26′26.09″). Too small to flip a verdict in practice, which is
exactly why it must be stated and echoed rather than left implicit.

**Why the Sun must be hard-coded false — this is a real, reproducible false positive, not a
hypothetical.** The Sun's *apparent* ecliptic latitude is ~0.5″ (light-time and aberration), so its
apparent declination can exceed the true obliquity by a fraction of an arcsecond near a solstice.
Measured:

```
1990-06-21 09:00 UT   Sun δ +23°26'30.678"   ε +23°26'31.060"   δ−ε = −0.38"   ok
1990-06-21 12:00 UT   Sun δ +23°26'31.316"   ε +23°26'31.054"   δ−ε = +0.26"   ← flags Sun OOB
1990-06-21 15:00 UT   Sun δ +23°26'31.566"   ε +23°26'31.050"   δ−ε = +0.52"   ← flags Sun OOB
```

A naive `|δ| > ε` test reports the Sun out of bounds. Astrologically that is nonsense — the Sun
*defines* the bounds. Suppress it explicitly with a comment (the `MOIETIES` halving comment at
`lib/aspects.js:20-30` is the house precedent for guarding a deliberate-looking-wrong constant), and
emit `out_of_bounds: false` rather than omitting the field, so consumers don't special-case the Sun.

**Why not angles/cusps/Vertex.** Latitude-0 points satisfy `|δ| ≤ ε` identically (§1.5), so
out-of-bounds is not merely false, it is impossible. Emitting `out_of_bounds: false` there implies a
test was performed. Omit the fields; `chart_points` and `houses` already have a different shape from
`planets`.

**The Node is the one place uniformity wins over that argument.** North Node lives in `planets`, and
keeping `planets` entries shape-uniform is worth more than suppressing an always-false field —
especially since `out_of_bounds: false` for the Node is a *true* statement, unlike synthesizing a
latitude swetest never emitted. So all 17 `planets` entries carry all four new fields.

### Q5 — Opt-in surface

Confirmed as proposed, with names:

| Surface | Gating |
|---|---|
| `ecliptic_latitude`, `declination`, `out_of_bounds`, `out_of_bounds_by` on bodies | **Always present.** Purely additive |
| `declination` on angles / cusps / Vertex / South Node | **Always present.** Purely additive |
| `obliquity`, `obliquity_type` at chart top level | **Always present** |
| `declination_aspects[]` | **Opt-in.** `include_declination_aspects`, default `false` |

**Flag name: `include_declination_aspects`.** Matches the existing `include_*` family
(`include_minor`, `include_angles`, `include_south_node`, `include_vertex` — #45 precedent) and
names exactly what it gates. Rejected: `include_parallels` (reads as excluding contraparallels),
`declination: true` (ambiguous against the always-present position fields).

**Field name: `ecliptic_latitude`, not `latitude`.** `latitude` is already taken in these tools — it
is the required geographic-latitude *input parameter*, and it is echoed in the output as
`coordinates.latitude`. A body-level `latitude` in the same document that means something else is a
live confusion for consumers (`body.latitude` vs `chart.coordinates.latitude`). `declination` needs
no qualifier. This is a naming call, not an astrological one, so it is cheap for engineering to
override — but the ambiguity is real and the verbosity is worth it.

`settings_used` gains, on every tool that has one:

```json
"include_declination_aspects": false,
"declination_orbs": { "parallel": 1, "contraparallel": 1 },
"declination_bodies": ["Sun", "Moon", "..."]
```

Echo all three unconditionally, matching how `include_vertex` is echoed whether or not it is set.

### Q6 — Which tools: all four, with `applying` deliberately null

| Tool | v1 | Notes |
|---|---|---|
| `calculate_planetary_positions` | **Yes** | Positions, OOB, obliquity. The additive half |
| `calculate_aspects` | **Yes** | `declination_aspects[]` behind the flag |
| `calculate_transits` | **Yes** | Transiting body → natal body. Load-bearing |
| `calculate_synastry` | **Yes** | Cross-chart parallels. Load-bearing |
| `calculate_solar_revolution` | Positions only | Its `planets`/`chart_points` come from `calculateEphemeris`, so the new fields arrive free. It returns no aspect array today; don't add one here |

**Both transits and synastry are load-bearing enough for v1, and for the same reason the ticket
exists.** A transiting body parallel a natal point, and a Venus–Mars parallel between two charts,
are both standard readings *and* both are the "invisible in longitude" case — the pair can have no
longitude aspect at all. Shipping the natal layer alone would leave the two contexts where a
practitioner most often reaches for declination unserved, and the machinery is identical
(`calculateCrossChartAspects` has a direct declination analogue). Cost is a few lines per call site,
not a second pass.

Transiting angles are already dropped from `calculate_transits` (`index.js:737-746`), and angles
never form declination aspects anyway (Q3), so the two rules agree with no extra gating.

**`applying` is `null` for every declination aspect in v1. This is the highest-risk item in the
ticket.** Declination rate is *not* longitude rate: a body moving direct in longitude may be moving
north or south in declination depending on where it sits relative to the solstitial axis, and its
declination rate goes to zero at the solstitial points while longitude rate is unremarkable there.
Passing declination values with longitude speeds into `computeApplying` produces confidently wrong
applying/separating flags — the kind of bug that survives review because the output looks fine.
`-fPZSBD` gives no declination rate, so computing one honestly needs a second ephemeris call at
t+1d. Out of scope here.

Required: emit `applying: null` (present, not omitted, so the row shape matches `aspects`), with a
code comment stating why, and a test asserting every declination row has `applying === null`.
The comment matters — a future contributor will otherwise "fix" the null. File the declination-rate
work as a follow-up (see §6).

### Q7 — Antiscia: explicitly OUT of this ticket

**Out.** Not deferred by omission — decided out, for three reasons:

1. It needs **no ephemeris change at all** — it is pure longitude arithmetic about the 0° Cancer /
   0° Capricorn axis — so it shares none of this ticket's work. The whole virtue of SUP-345 is being
   the cheapest item on the SUP-344 list; bundling doubles its review surface for zero shared code.
2. Its orbs are **longitude** orbs on a different scale (1° or 30′ is typical for antiscia, tighter
   than any longitude class here) and would need their own class and their own validation path.
3. It sits under honourable mentions in the SUP-344 evaluation, below the line for this round.

One thing to record now so the follow-up starts from it: **antiscia and declination aspects are the
same geometry in two coordinate systems.** For zero-latitude points, parallel ≡ conjunction-or-
antiscion and contraparallel ≡ opposition-or-contra-antiscion (Q3(a)). For real bodies with latitude
they diverge, and mainstream practice reports both separately with separate orbs.

**Recommendation for the follow-up: do not dedupe antiscia against `declination_aspects`.** They are
distinct conventions with distinct orbs, both conventionally reported, and a consumer who asked for
both wants both. File as its own issue.

---

## 3. Output schema

### 3.1 `planets` — every entry, all 17, uniform

```jsonc
"Sun": {
  "longitude": 280.8142608,      // existing
  "sign": "Capricorn",           // existing
  "degree": 10.81,               // existing
  "speed": 1.0194758,            // existing
  "ecliptic_latitude": 0.0000128,   // NEW  decimal degrees, + = north of ecliptic
  "declination": -23.0018609,       // NEW  decimal degrees, + = north of equator
  "out_of_bounds": false,           // NEW  |declination| > obliquity; always false for the Sun
  "out_of_bounds_by": null          // NEW  |declination| - obliquity when true, else null
}
```

- All four fields present on all 17 bodies including North Node (`ecliptic_latitude: 0`,
  `out_of_bounds: false`).
- Decimal degrees, signed, full precision — **numbers, not strings.** Note that
  `calculate_transits` and `calculate_synastry` currently stringify orbs with `.toFixed(2)`
  (`index.js:757`, `index.js:808`). That is a pre-existing inconsistency; **do not propagate it
  here.** 2 dp on a 1° declination orb discards to 36″, which is a third of a tight parallel.

### 3.2 Chart-level

```jsonc
{
  "planets": { ... },
  "houses": { ... },
  "chart_points": { ... },
  "additional_points": { ... },
  "obliquity": 23.4423661,        // NEW  true obliquity of the ecliptic for the moment
  "obliquity_type": "true",       // NEW  literal "true" — the audit trail for every OOB flag
  "datetime": "...",
  "coordinates": { ... },
  "house_system": "P"
}
```

`obliquity` is required for a consumer to audit any `out_of_bounds` flag independently. Without it
the boolean is unverifiable.

### 3.3 `chart_points` and `houses` — declination only

```jsonc
"chart_points": {
  "Ascendant":  { "longitude": 25.1918830,  "sign": "Aries",     "degree": 25.19, "declination": 9.7491710 },
  "Midheaven":  { "longitude": 280.0003985, "sign": "Capricorn", "degree": 10.00, "declination": -23.0654285 },
  "IC":         { "longitude": 100.0003985, "sign": "Cancer",    "degree": 10.00, "declination": 23.0654285 },
  "Descendant": { "longitude": 205.1918830, "sign": "Libra",     "degree": 25.19, "declination": -9.7491710 },
  "Vertex":     { "longitude": 188.8108920, "sign": "Libra",     "degree":  8.81, "declination": -3.4935709 },
  "ARMC":       { "longitude": 280.8794690, "sign": "Capricorn", "degree": 10.88 }   // NO declination — §1.3
},
"houses": {
  "1": { "longitude": 25.1918830, "sign": "Aries", "degree": 25.19, "declination": 9.7491710 },
  ...
}
```

- **No `ecliptic_latitude`.** It is 0 by definition but swetest does not emit it on these lines;
  synthesizing it would mean reporting a value that was never parsed. Omitting it also keeps trap
  §1.1 visible in the output shape — if `ecliptic_latitude` ever appears on an angle, something
  read the wrong column.
- **No `out_of_bounds` fields** — impossible for latitude-0 points (Q4).
- IC and DSC declinations are derived as the exact negation of MC and ASC, matching how their
  longitudes are already derived (`index.js:549-582`).
- `additional_points`: **South Node** gets `declination` = −(North Node declination), exact.
  **Part of Fortune** gets neither field (Q2).

### 3.4 `declination_aspects[]`

Present only when `include_declination_aspects` is `true`. Sorted by `orb` ascending, matching
`aspects`.

```jsonc
{
  "body_a": "Mercury",
  "body_b": "Vesta",
  "aspect": "parallel",              // "parallel" | "contraparallel"
  "declination_a": -20.3919084,
  "declination_b": -19.4967293,
  "orb": 0.8951791,                  // |δa − δb| for parallel, |δa + δb| for contraparallel
  "orb_allowed": 1,
  "applying": null                   // always null in v1 — Q6
}
```

- No `category` field. The major/minor vocabulary does not apply to declination aspects; forcing it
  would invent a distinction that has no source.
- No `separation`/`aspect_angle`. For declination, the separation *is* the orb.
- `declination_a`/`declination_b` are included so a consumer can verify the orb without re-deriving
  it from `planets`.
- Both a parallel and a contraparallel can be reported for the same pair only when both
  declinations are within 0.5° of zero; that is correct, not a bug.

Per-tool row key naming follows each tool's existing convention:

| Tool | Array key | Row keys |
|---|---|---|
| `calculate_aspects` | `declination_aspects` | `body_a` / `body_b` |
| `calculate_transits` | `declination_aspects` | `transiting_body` / `natal_body` |
| `calculate_synastry` | `declination_aspects` | `person1_planet` / `person2_planet` |

### 3.5 Parameter schema additions

On `calculate_planetary_positions`, `calculate_aspects`, `calculate_transits`,
`calculate_synastry`:

```jsonc
"include_declination_aspects": {
  "type": "boolean",
  "description": "Include parallel and contraparallel contacts by declination (default: false). Parallels and contraparallels are read with roughly conjunction and opposition force respectively, and are invisible in ecliptic longitude."
}
```

`orb_overrides` gains an optional `declination` key, valid under both orb models:

```jsonc
"orb_overrides": { "declination": { "parallel": 1.5, "contraparallel": 1 } }
```

Validation: boolean check on the flag mirroring `include_vertex` (`index.js:1230-1232`); nested
`declination` keys restricted to `parallel`/`contraparallel` via `invalidOrbOverrideKeys`.

---

## 4. Test expectations

All values below were computed on 2026-08-08 against the vendored ephemeris and use only
`test/fixtures/charts.js`. No new fixture is required — see §4.5.

### 4.1 DAY_CHART — obliquity and the three headline contacts

`obliquity` = **23.4423661** (23°26′32.52″), `obliquity_type` = `"true"`.

| Contact | Type | Orb (decimal) | Orb (DMS) |
|---|---|---|---|
| Mercury – Vesta | parallel | 0.895179 | 0°53′42.64″ |
| Venus – Pallas | parallel | 0.902725 | 0°54′09.81″ |
| Saturn – Neptune | parallel | 0.179061 | 0°10′44.62″ |

Assert also that Mercury–Vesta and Venus–Pallas appear in **no** longitude aspect (21.77° and
55.34° apart respectively) — that is the claim the whole ticket rests on, and it should be asserted,
not assumed.

### 4.2 DAY_CHART — the complete 1° / 16-body list

Exactly **13** rows, in this orb order. A full-list assertion is worth more than three spot checks:
it catches an over-inclusive body list (a 14th row) and an accidental angle or Node inclusion.

| # | Contact | Type | Orb (decimal) | Orb (DMS) |
|---|---|---|---|---|
| 1 | Mars – Neptune | parallel | 0.068323 | 0°04′05.96″ |
| 2 | Saturn – Neptune | parallel | 0.179061 | 0°10′44.62″ |
| 3 | Moon – Juno | parallel | 0.181626 | 0°10′53.85″ |
| 4 | Sun – Jupiter | contraparallel | 0.223394 | 0°13′24.22″ |
| 5 | Mars – Saturn | parallel | 0.247384 | 0°14′50.58″ |
| 6 | Jupiter – Uranus | contraparallel | 0.360466 | 0°21′37.68″ |
| 7 | Sun – Uranus | parallel | 0.583860 | 0°35′01.89″ |
| 8 | Lilith – Pallas | parallel | 0.642716 | 0°38′33.78″ |
| 9 | Sun – Saturn | parallel | 0.769586 | 0°46′10.51″ |
| 10 | Mercury – Vesta | parallel | 0.895179 | 0°53′42.64″ |
| 11 | Venus – Pallas | parallel | 0.902725 | 0°54′09.81″ |
| 12 | Sun – Neptune | parallel | 0.948647 | 0°56′55.13″ |
| 13 | Jupiter – Saturn | contraparallel | 0.992980 | 0°59′34.73″ |

Negative assertions on the same call:

- **No row contains `North Node`.** With the Node included, `Chiron contraparallel North Node` at
  0°19′28.43″ appears — it would sort to position 6. Assert its absence by name.
- **No row contains `Ascendant`, `Midheaven`, `IC`, `Descendant`, `Vertex`, `Part of Fortune`,
  or any house cusp.** With angles included, 14 further rows appear (listed in Q3), including
  `Ascendant contraparallel Descendant` and `Midheaven contraparallel IC` at orb exactly 0.
  Assert the absence of those two by name — they are the signature of a mirror-double-count bug.
- **Every row has `applying === null`.**

### 4.3 Out-of-bounds

| Case | Chart | Expected |
|---|---|---|
| Ceres OOB | DAY_CHART | `out_of_bounds: true`, δ = +26.4572512 (+26°27′26.10″), `out_of_bounds_by` = 3.0148851 (3°00′53.59″) |
| **Uranus OOB** | DAY_CHART | `out_of_bounds: true`, δ = −23.5857206 (−23°35′08.59″), `out_of_bounds_by` = 0.1433545 (0°08′36.08″) |
| In bounds | DAY_CHART | Every other body `out_of_bounds: false`, `out_of_bounds_by: null` |
| Moon OOB (transit) | 1990-01-09T12:00:00Z | δ = +27.4015972 (+27°24′05.75″), `out_of_bounds: true`, `out_of_bounds_by` = 3.9592824 (3°57′33.42″) |
| **Sun at solstice** | 1990-06-21T12:00:00Z | `out_of_bounds: false` — δ = +23°26′31.316″ *exceeds* ε = +23°26′31.054″ by 0.26″. This is the regression test for Q4; without the Sun suppression it fails |
| Node never OOB | DAY_CHART | North Node `out_of_bounds: false`, `ecliptic_latitude: 0` |

Uranus is not mentioned in the SUP-344 evaluation or the SUP-345 issue but is a second OOB body on
DAY_CHART, and a much better test than Ceres: at 8′36″ past the boundary it is tight enough that a
wrong obliquity source (mean instead of true, a 6.43″ difference on this chart) still passes, while
a *hardcoded* ±23°26′00″ boundary would misreport `out_of_bounds_by` by 32″. Assert
`out_of_bounds_by` numerically, not just the boolean.

### 4.4 Latitude-0 identity — the structural test

For every house cusp, ASC, MC, IC, DSC, Vertex, and North Node on DAY_CHART, assert:

```
declination == arcsin( sin(obliquity) * sin(longitude) )   within 0.001"
```

Verified to better than 0.0001″ for all 17 points. This one test catches the §1.1 column-order
trap directly: if declination were read from the latitude column the identity fails immediately, and
it fails for the *right* reason with a readable diff. Exclude ARMC — it fails by 82787″ (§1.3), so
also assert `chart_points.ARMC.declination === undefined`.

### 4.5 Fixture coverage — no new fixture needed

`SOUTHERN_CHART` (Sydney, 2000-03-20T06:00:00Z) already provides the declination-sign case, and it
is a genuinely good one — computed there:

- Sun δ = −0°01′33.83″. **Within 2 arcminutes of zero, one hour after the equinox.** Any sign
  error, or a sign-map fallthrough, moves this by degrees. It is a sharper sign probe than the
  southern *geographic* latitude is.
- Pallas ecliptic latitude −26°42′40″ against declination −5°52′21″ — a 21° gap between the two
  numbers, so swapping the latitude and declination columns (§1.1) cannot pass silently.
- 8 declination aspects at 1° over 16 bodies; tightest is `Saturn parallel Ceres` at 0.314272
  (0°18′51.38″), and it contains a contraparallel pair (`Mars – Pluto`, 0.592604) so the
  contraparallel branch is exercised outside DAY_CHART.
- Different obliquity (23.4381391) from DAY_CHART, so a hardcoded obliquity constant fails here.

`PARTNER_CHART` gives the richest cross-chart material — 16 rows on its own, tightest
`Mercury contraparallel Neptune` at 0.025838 (0°01′33.02″) — and is the natural second chart for the
synastry and transit declination tests.

`NIGHT_CHART` produces 12 rows and is not needed for this feature: **declination has no sect
dependence**, so the DAY/NIGHT pair adds nothing here. Worth stating explicitly, since the CLAUDE.md
guidance to always exercise both fixtures exists for sect-dependent logic and does not apply.

Add to `test/fixtures/charts.js` under each fixture's `expected` block, rather than inlining:

```js
expected: {
  sect: 'day',
  sunHouse: 10,
  partOfFortune: 77.6453,
  obliquity: 23.4423661,             // NEW
  declinationAspectCount: 13,        // NEW  1° orb, 16 bodies
  outOfBounds: ['Uranus', 'Ceres'],  // NEW
}
```

### 4.6 Orb-class isolation (the standing check)

- `orb_overrides: { declination: { parallel: 2 } }` changes the parallel orb and leaves every
  longitude orb in `body`, `angle`, and `derived` untouched — assert against a longitude aspect
  count that is unchanged.
- `orb_overrides: { conjunction: 12 }` (class mode) and `orb_overrides: { moieties: { Sun: 10 } }`
  (moiety mode) leave `declination_orbs` at `{ parallel: 1, contraparallel: 1 }`.
- `orb_overrides: { declination: { parallel: 2 } }` is **accepted under both** `orb_model: 'moiety'`
  and `orb_model: 'class'` — the mode-crossing rejection in `invalidOrbOverrideKeys` must not fire.
- `orb_overrides: { declination: { conjunction: 2 } }` is **rejected** with the existing
  unknown-key error shape.
- Existing major-wider-than-minor assertions in `test/aspects.test.js` continue to pass unchanged —
  this ticket adds a class, it does not move any longitude orb.

### 4.7 Regression guard for trap §1.2

Assert `chart_points.Ascendant.speed === undefined` and that every ASC/MC aspect in `aspects` still
has `applying === null`. That is the test that fails if the cusp rotation-rate column leaks into
`speed`.

---

## 5. Suggested implementation order

1. `lib/swetest-parse.js` — extract the signed-DMS helper; add `ecliptic_latitude`/`declination` to
   `parsePlanetLine`; add `declination` (field 4, not field 3) to `parseHouseLine` and
   `parseChartPointLine`; add an `Ecl. Obl.` branch. Unit tests against captured swetest output for
   both column layouts — this is where §1.1–1.4 are pinned.
2. `index.js` `calculateEphemeris` — format strings, `o` in the `-p` list, `Ecl. Obl.` exclusion,
   obliquity plumbing, OOB computation with the Sun suppression, derived declinations for IC / DSC /
   South Node, ARMC exclusion.
3. `lib/aspects.js` — `DECLINATION_ORBS`, `DECLINATION_ASPECT_BODIES`, its own resolver (**not** in
   `ORB_CLASSES`), `calculateDeclinationAspects` and its cross-chart sibling,
   `invalidOrbOverrideKeys` accepting `declination` in both branches.
4. Wire the flag through the four tools; `settings_used` echoes.
5. README: new fields, the flag, the 1° default, the 16-body list with the Node exclusion stated,
   and the `applying: null` limitation.

Steps 1 and 2 are independently shippable and non-breaking — if the ticket has to be split, that is
the seam.

---

## 6. Follow-ups to file separately

| Item | Why not here |
|---|---|
| **Declination rate → real `applying`** | Needs a second ephemeris call at t+1d. Wrong-by-default if faked from longitude speed (Q6) |
| **Antiscia / contra-antiscia** | No shared code, different orb class, honourable-mention tier (Q7). Do not dedupe against declination aspects |
| **Declination for progressed / solar-arc charts** | Blocked on SUP-344 §3 existing at all |
| **`out_of_bounds` periods (when did it enter/leave)** | A time-domain question — belongs to SUP-344 §1 `find_events` |
| **Per-body declination orbs / luminary 1°30′** | Only if asked for. Flat 1° is the mainstream default and there is no sourced declination moiety table (Q2) |

---

*Chart data throughout uses the repository's synthetic fixtures in `test/fixtures/charts.js`. Figures
were produced on 2026-08-08 against the vendored Swiss Ephemeris 2.10.03 in worktree
`issue/SUP-344`. Scope is Western tropical throughout; Vedic, sidereal and Hellenistic techniques are
out of scope for this server.*
