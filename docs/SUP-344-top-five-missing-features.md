---
type: evaluation
target_repo: swiss-ephemeris-mcp-server
status: proposed
raised: 2026-08-08
author: Astrology Advisor
ephemeris_version_tested: swiss-ephemeris-mcp-server@1.0.2 (worktree issue/SUP-344, 8c5cc3b)
scope: Western tropical astrology only
---

# Top five missing features

> **Update (SUP-353):** the `moon_phase at an instant` row below has since shipped — see
> [`calculate_planetary_positions`](../README.md#calculate_planetary_positions) in `README.md` for
> the current `moon_phase` output. The rest of this evaluation, including the `find_events` gap it
> was originally scoped under, reflects the state *at the time this report was generated*, not the
> present state.

## What the server does today

Five tools — `calculate_planetary_positions`, `calculate_aspects`, `calculate_transits`,
`calculate_synastry`, `calculate_solar_revolution` — over 17 bodies, 10 house systems, two orb
models, angles/Vertex/Part of Fortune, house overlay, and applying/separating flags. That is a
solid, well-tested *positional* core. The orb work (moiety vs class), the sect fix for Part of
Fortune, and the angle-aspect mirror rules are all correct and better-documented than most
commercial software.

The gaps are not in position accuracy. They are structural:

1. **The server has no time axis.** Every tool answers "what is the sky at this one instant." No
   tool answers "*when*." That is the shape of most real questions.
2. **The server has no third dimension.** Output is ecliptic longitude only. Latitude and
   declination are computed by `swetest` and then discarded.
3. **The server has no derived-chart layer.** Progressions, directions, composites — the charts a
   professional builds *from* a natal chart — do not exist.
4. **The server has no synthesis layer.** It returns a flat aspect list, never the patterns that
   list forms.

The five recommendations below map onto those gaps, ranked by (impact on a reading) × (how
impossible it is to work around from outside the server).

---

## 1. Time-domain event search — `find_events`

**Gap class:** no time axis. **Priority: highest.**

Every transit question a client actually asks is a *when* question. "Is this a good year." "When
does the Saturn thing let up." "When should I sign." The server can tell you Saturn is 2°14′ from
your natal Sun right now. It cannot tell you the three exact-hit dates, or when the contact
entered and leaves orb.

Today the only way to get a date is to sample `calculate_transits` and bisect by hand. A single
retrograde-triple-pass Saturn contact needs roughly 12–20 calls to bracket three exact hits plus
the in-orb/out-of-orb boundaries — per aspect. A full year-ahead reading has dozens. In practice
this means timing gets estimated rather than computed, which is exactly the part a client will
check against their own calendar.

This is also the single most-requested follow-on already noted in
`docs/tool_requests/2026-07-27_secondary-progressions.md` ("the server has no date-range search at
all, so transit exactness dates are also found by manual sampling today").

**What it should find, over a caller-supplied window:**

| Event | Why it matters |
|---|---|
| `aspect_exact` — transiting body to natal point | The core deliverable. Must return **all** passes (direct/retro/direct), plus `enters_orb` / `leaves_orb` |
| `station` — retrograde and direct turns | Station degrees are read as sensitive points; the station *date* is the event |
| `sign_ingress` | "Pluto enters Aquarius" framing; also outer-planet chapter boundaries |
| `house_ingress` (natal house frame) | Where the transit lands in the life |
| `lunation` — New/Full Moon, and eclipses with type + saros | Eclipse dates and degrees drive a huge share of forecasting |
| `moon_phase` at an instant | Trivial to add alongside; currently absent entirely |

**Astrological requirements — these are the parts that get built wrong:**

- **Return every pass, not the first.** An outer planet crossing a natal point retrogrades over it
  one to five times. Returning only the first hit is the classic bug and it silently truncates the
  most important reading in the set.
- **Report `enters_orb` and `leaves_orb`, not just exact.** A transit is read as a period. Which
  orb model produced those boundaries must be echoed back (`orb_model`, same as the aspect tools),
  because moiety and class disagree by several degrees and therefore by *weeks*.
- **Dates in UTC, with the body's speed at the hit.** Speed near a station is what tells the reader
  the contact will sit there for months rather than days.
- **Do not include transiting angles.** Already correctly excluded from `calculate_transits`; the
  same reasoning applies here and more strongly, since an angle "event" would fire daily.
- Progressed-event search is the same machinery at a different rate — build the search generic
  enough to serve both (see #3).

---

## 2. Declination — latitude, declination, parallels, out-of-bounds

**Gap class:** no third dimension. **Priority: high. Lowest cost of the five.**

The server invokes `swetest` with `-fPZS` — name, zodiacal longitude, speed. `swetest` will emit
ecliptic latitude and equatorial declination from the same call with `-fPZSBD`. Verified in this
worktree against the vendored ephemeris:

```
$ swetest -b01.01.1990 -ut12:00:00 -p0123456789tADFGHI -fPZBD -g, -head
Sun            ,10 cp 48'51.3388,   0° 0' 0.0460, -23° 0' 6.6992
Moon           , 3 pi 16' 3.5563,   1°28'14.4283,  -8°56'12.6510
Mercury        ,25 cp 40'22.1708,   0°37'49.0862, -20°23'30.8703
...
Ceres          ,25 ge 33'13.1504,   3° 5'29.1308,  26°27'26.1042
```

No new dependency, no new ephemeris file, one format-string character. The data is already being
computed and thrown away.

**What this unlocks:**

**Parallels and contraparallels.** Two bodies at the same declination (parallel) or equal-and-
opposite declination (contraparallel) are read with roughly conjunction/opposition force. They are
standard in modern Western practice — Solar Fire, Astro Gold, and astro.com all report them — and
they are *invisible in longitude*. Using `DAY_CHART` (`1990-01-01T12:00:00Z`, Greenwich), the
server's own reference fixture:

| Contact | Declinations | Declination orb | Longitude separation | Reported today? |
|---|---|---|---|---|
| Mercury ∥ Vesta | −20°23′31″ / −19°29′48″ | 0°53′43″ | 21.77° | **No — not an aspect in longitude at all** |
| Venus ∥ Pallas | −16°52′39″ / −17°46′49″ | 0°54′10″ | 55.34° (sextile misses by 4.66°) | **No** |
| Saturn ∥ Neptune | −22°13′56″ / −22°03′12″ | 0°10′44″ | 3.62° (conjunction) | Partially — as a conjunction only |

The first two are genuine chart contacts that the server is structurally incapable of reporting.
The third shows the other half of the point: a conjunction that is *also* parallel is materially
stronger than one that isn't, and a reader currently has no way to know.

Standard orb for parallel/contraparallel is **1°**, with some authors widening to 1°30′ for the
luminaries. Recommend 1° as the default and expose it under the existing `orb_overrides` mechanism
as its own class rather than folding it into the moiety table — moieties are longitude half-orbs
and have no declination meaning.

**Out-of-bounds.** A body past the Sun's maximum declination (±23°26′ — obliquity, which varies
slowly and should be computed, not hardcoded) is "out of bounds," read as operating outside normal
limits. The out-of-bounds Moon in particular is a heavily used modern technique. `DAY_CHART` has
Ceres at +26°27′26″ — out of bounds. The transiting Moon goes out of bounds at +27°24′06″ on
1990-01-09. Neither is visible today.

**Recommendation:** add `latitude` and `declination` to every body in `planets` and to the angles;
add a `declination_aspects` array (opt-in, same shape as `aspects`) with `parallel` /
`contraparallel`; add `out_of_bounds: boolean` per body plus the obliquity actually used.

**Caution:** report declination for the angles too (ASC/MC have declinations), but do **not**
compute parallels to the Part of Fortune or other lots — a lot is a longitude construct with no
physical declination, and assigning it one is not a convention any school uses.

---

## 3. Secondary progressions and solar arc directions

**Gap class:** no derived charts. **Priority: high. Already specified — shovel-ready.**

A full spec exists at `docs/tool_requests/2026-07-27_secondary-progressions.md` and has not been
built. Restating why it belongs in a top-five list rather than being treated as already handled:

- Progressed planets can be faked from outside by calling `calculate_planetary_positions` at a
  hand-computed date. Progressed **angles cannot be obtained at all** — the angles the server
  returns for a progressed datetime are off by 200+° (documented with worked figures in that spec).
- Progressed Moon (≈1°/month, a ~27-year cycle through the chart) and progressed ASC/MC are the
  backbone of long-arc timing. Dropping them drops most of what progressions are for.

**One addition to that spec.** It covers secondary progressions only. **Solar arc directions**
should ship in the same tool or a sibling: every natal point advanced by the solar arc, aspected
back to the natal chart. Solar arc is at least as widely used as secondary progressions in modern
Western practice, it reuses the arc the spec already computes for `angle_method: "solar_arc"`, and
it is the technique that puts a date on outer-planet-to-angle contacts.

**Convention flags for whoever implements it:**

- `angle_method: "solar_arc"` is the right default. Naibod must remain selectable, and the choice
  must be echoed as `angle_method_used` — the two disagree by ~1° (roughly a year of arc) at midlife
  ages, which is a real difference in a timing reading, not a rounding detail.
- `year_length_days` must be in the output. Tropical year (365.2422) vs Julian year (365.25) shifts
  the progressed date, and the caller cannot audit the result without knowing which was used.
- Surface `retrograde: boolean` on progressed planets explicitly. Progressed stations are a
  technique in their own right and should not require inferring the sign of `speed`.

---

## 4. Aspect patterns and chart signature

**Gap class:** no synthesis layer. **Priority: medium-high. Best value-to-effort ratio.**

`calculate_aspects` returns a flat, orb-sorted list. Every reading a professional writes opens with
what that list *forms* — "you have a T-square in cardinal signs," "there's a grand trine in water" —
and the current output makes the consumer reconstruct that combinatorially from 40–80 aspect rows.
Pattern detection done by hand or by a language model over a flat list is unreliable in a specific
and embarrassing way: it produces confident, plausible patterns that are not in the chart.

This is pure post-processing on data the server already has. No new ephemeris calls.

**Patterns to detect** (mainstream Western set):

| Pattern | Definition |
|---|---|
| T-square | Opposition + both ends square a third point (the apex) |
| Grand trine | Three points in mutual trine |
| Grand cross | Two oppositions square each other |
| Yod | Two points sextile, both quincunx a third (apex) — requires `include_minor` |
| Kite | Grand trine + one point opposed, sextile the other two |
| Mystic rectangle | Two oppositions joined by sextiles and trines |
| Stellium | 3+ (configurable) bodies in one sign or one house |

Each hit should return its member bodies, the apex where the pattern has one, the widest orb in the
configuration, and — for T-square/grand trine/grand cross — the **modality or element**, since
"cardinal T-square" and "mutable T-square" are read differently.

**Also worth returning as a `chart_signature` block:**

- Element and modality counts, with the weighting scheme stated. There is no single standard here —
  some count all bodies equally, some weight luminaries and personal planets, some include the ASC.
  Pick one, document it, echo it in `settings_used`. Do not present a weighted count as if it were
  canonical.
- Hemisphere and quadrant emphasis.
- Final dispositor / dispositor chains under modern rulerships, with mutual receptions surfaced.
- Chart shape (Jones patterns: bundle, bowl, bucket, locomotive, seesaw, splash, splay).

**Convention caution:** dispositor chains need a stated rulership scheme. Modern Western uses
Uranus–Aquarius, Neptune–Pisces, Pluto–Scorpio; traditional uses Saturn, Jupiter, Mars. Both are
legitimate but they produce *different chains*. Make it a parameter with modern as the default
(consistent with the rest of this server's modern-Western posture) rather than silently choosing.

---

## 5. Composite and Davison relationship charts

**Gap class:** no derived charts. **Priority: medium-high for relationship work.**

`calculate_synastry` covers cross-aspects and house overlay well. It is missing the other half of
standard relationship practice: the chart *of the relationship itself*.

- **Composite (midpoint method)** — every point is the midpoint of the two natal equivalents.
- **Davison (time-space midpoint)** — a real chart cast for the midpoint in time and the
  geographic midpoint. Unlike the composite it is an actual ephemeris moment, so it has real
  planetary speeds and can itself be progressed and transited.

Both are non-trivial to derive externally, which is why they belong in the server:

- Composite midpoints must use the **shorter arc** of the two possible midpoints. Naive averaging
  of longitudes is wrong whenever the pair straddles 0° Aries, and it fails silently — the result
  is a plausible-looking chart that is 180° off.
- **Composite houses are a genuine convention split** and must be a parameter, not a guess:
  - *Midpoint MC* — take the midpoint of the two MCs, derive the ASC from it at the midpoint
    latitude.
  - *Derived/reference-place* — take the midpoint ASC and build houses from there.
  These give different house placements for the same pair. Default to **midpoint MC**, expose the
  alternative, and echo which was used.
- Davison needs the **great-circle midpoint** of the two birthplaces, not the arithmetic mean of
  latitude/longitude. The arithmetic mean is wrong for widely separated locations and wrong across
  the antimeridian.
- Composite Part of Fortune should be the **midpoint of the two natal Parts**, not recomputed from
  composite ASC/Sun/Moon — the composite has no sect, so the day/night formula has nothing to
  select on. This is a common implementation error.

Should also return composite-to-natal and composite-to-transit aspects, since a composite chart is
read under transit like any other.

---

## Honorable mentions

Real gaps, below the line for this round:

- **Fixed stars.** `sefstars.txt` is already vendored and unused. Verified working:
  `swetest -b01.01.1990 -ut12:00:00 -pf -xfRegulus -fPZ` → `Regulus, 29 le 41'49.9882`. Conjunctions
  to Regulus, Algol, Spica, Aldebaran, Antares, Fomalhaut with tight orbs (1° is typical, some use
  30′) are used by a substantial minority of Western practitioners. Cheap, since the data ships.
- **Lunar returns and other returns.** Solar return exists; lunar return (monthly) is the common
  companion. Also: `calculate_solar_revolution` has no precession-correction option — precessed vs
  non-precessed solar returns is a live convention split and the tool currently makes the choice
  silently.
- **Midpoints.** Full midpoint tree with 90°-dial contacts. Widely used in the Ebertin/Uranian
  lineage; mechanically simple but combinatorially tedious by hand.
- **Harmonics and antiscia.** Harmonic charts (5th, 7th, 9th) and antiscia/contra-antiscia (mirror
  points about the 0° Cancer–0° Capricorn axis). Both are pure longitude arithmetic.
- **Essential dignity table.** Domicile, exaltation, detriment, fall are mainstream Western and
  worth returning. Triplicity, terms and decans lean traditional — if added, gate them and name the
  table (Ptolemaic vs Egyptian terms differ), and do not present them as default modern practice.

## Correctness flags found while surveying (small, independent of the above)

These are cheap fixes and should not wait on any of the five.

1. **Node type is undocumented in output and the README is wrong.** `index.js` requests `-pt` —
   **true node** only. The README claims "Lunar Nodes: True and Mean Node calculations," and the
   name map at `index.js:439-440` maps both `mean Node` and `true Node` onto the same output key
   `North Node`, so a consumer cannot tell which they got. True node is a defensible modern-Western
   default (it matches astro.com and Solar Fire), so the *default is right* — but it must be
   labeled. Recommend: add `node_type: "true" | "mean"` as a parameter, echo it in `settings_used`,
   and fix the README. The difference is real: on `DAY_CHART` the true Node is 16°52′ Aquarius and
   the mean Node is 18°26′ Aquarius — 1°34′ apart, enough to change a sign at the boundary and
   enough to move a node aspect in or out of orb.
2. **No `retrograde` flag.** Inferable from the sign of `speed`, but there is no `stationary` band,
   so a body one day off a station reads as ordinary direct motion. Recommend an explicit
   `retrograde: boolean` plus `stationary: boolean` with a documented speed threshold.
3. **No lunar phase.** Sun–Moon angular separation is already derivable from returned data, but the
   named phase (and the eight-phase lunation-cycle position, used in Dane Rudhyar-lineage work) is a
   standard chart datum and should be returned rather than left to the consumer.

## Recommended order

| # | Feature | Impact | Cost | Can it be worked around externally? |
|---|---|---|---|---|
| 1 | Time-domain event search | Highest — most questions are *when* | High | Only by 12–20 bisection calls per contact |
| 2 | Declination layer | High — whole class of contacts invisible | **Lowest** — one format-string change | **No** — data is discarded before it leaves the server |
| 3 | Progressions + solar arc | High | Medium (spec written) | Planets yes, **angles no** |
| 4 | Aspect patterns + signature | High — opens every reading | Low — pure post-processing | Yes, but unreliably |
| 5 | Composite + Davison | Medium-high for relationship work | Medium | Not safely — midpoint and house conventions are error-prone |

If only one ships this cycle, ship **#2** — it is the smallest change on the list and it is the only
one whose absence makes a class of chart contacts structurally unreachable. If only one *large*
thing ships, ship **#1**.

---

*Chart data in this document uses the repository's synthetic `DAY_CHART` fixture
(`test/fixtures/charts.js`, `1990-01-01T12:00:00Z`, Greenwich). Figures were produced on 2026-08-08
against the vendored Swiss Ephemeris in this worktree. Scope is Western tropical throughout; Vedic,
sidereal and Hellenistic techniques are out of scope for this server.*
