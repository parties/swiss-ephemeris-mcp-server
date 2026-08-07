---
type: tool_request
target_repo: swiss-ephemeris-mcp-server
status: proposed
raised: 2026-07-27
ephemeris_version_tested: swiss-ephemeris-mcp-server@1.0.2+c01d22d
---

# Add `calculate_secondary_progressions`

## Summary

The MCP server has no secondary-progression tool. Progressed **planets** can be obtained
today by calling `calculate_planetary_positions` at a hand-computed datetime, so that half
is merely inconvenient. Progressed **angles** cannot be obtained at all — the angles the
server returns for a progressed datetime are not progressed angles under any convention,
and using them produces errors of hundreds of degrees.

Progressed Ascendant and progressed Midheaven are among the most-used points in
progression work. This is a real hole, not a nice-to-have.

## Background: what the workaround currently is

Secondary progressions use day-for-a-year. To read someone at age *N*:

```
progressed_datetime = birth_datetime + N days     // N = elapsed tropical years, fractional
```

Then call `calculate_planetary_positions(progressed_datetime, natal_lat, natal_lon)` and
diff every returned longitude against the natal cache by hand.

That works for planets. It costs one call plus manual longitude differencing per body, and
any ingress or station date has to be found by bisection — 3–5 extra calls each.

## The actual defect: angles

`calculate_planetary_positions` returns `chart_points` for the datetime it was given. For a
progressed datetime that includes a fractional-day offset, the angles have spun with the
clock. They are the angles of a real moment in the days after birth, which is not a
meaningful quantity.

Worked examples, both computed 2026-08-07 against `@1.0.2+c01d22d`, using this repo's
`DAY_CHART` and `PARTNER_CHART` synthetic fixtures (`test/fixtures/charts.js`):

**DAY_CHART** — natal 1990-01-01T12:00:00Z, 51.4769 N, 0.0 E. Elapsed 32.500 yr →
progressed datetime 1990-02-03T00:00:00Z.

| Progressed MC by | Value | Delta from natal MC (10°00′01″ Capricorn) |
|---|---|---|
| Server `chart_points.Midheaven` at progressed datetime | 10°27′45″ Leo | **+210.46°** |
| Solar arc (natal MC + prog Sun − natal Sun) | 13°04′39″ Aquarius | +33.08° |
| Naibod (natal MC + 0.9856°/yr × elapsed) | 12°01′57″ Aquarius | +32.03° |

**PARTNER_CHART** — natal 1995-07-04T00:00:00Z, 40.7128 N, −74.0060 E. Elapsed 27.500 yr →
progressed datetime 1995-07-31T12:00:00Z.

| Progressed MC by | Value | Delta from natal MC (29°36′09″ Libra) |
|---|---|---|
| Server `chart_points.Midheaven` at progressed datetime | 26°55′48″ Taurus | **+207.33°** |
| Solar arc | 25°50′43″ Scorpio | +26.24° |
| Naibod | 26°42′23″ Scorpio | +27.10° |

So: the two *legitimate* conventions disagree with each other by ~1° at these ages — close
enough that either is defensible, far enough that the caller must know which one was used.
The server's raw output disagrees with both by **200+°**, which is not a convention choice,
it's just wrong for this purpose.

Because of this, any hand-written reading using the current workaround has to omit
progressed angles entirely, or flag them as unreliable — that drops progressed ASC/MC
contacts, a significant chunk of what progressions are for.

## What blocks without it

- Progressed Ascendant and Midheaven, and any aspect to them.
- Progressed-Moon **house** ingresses (needs progressed angles if the house frame is the
  progressed one; natal-frame houses are computable by hand, but the choice should be
  explicit rather than forced).
- Progressed **station** dates (e.g. progressed Venus turning retrograde) require manual
  bisection — several extra `calculate_planetary_positions` calls per station to bracket it.
- Progressed-to-natal aspect lists, currently produced by hand.

## Proposed tool

```
calculate_secondary_progressions(
  birth_datetime: string,                     // ISO8601 UTC, required
  birth_latitude: number,                     // required
  birth_longitude: number,                    // required, positive east
  target_date: string,                        // ISO8601 UTC — the date to progress to, required
  house_system?: string,                      // default "P"
  angle_method?: "solar_arc" | "naibod" | "ephemeris_time",   // default "solar_arc"
  house_frame?: "progressed" | "natal",       // which cusps to assign progressed bodies to; default "progressed"
  bodies?: string[],                          // default: same list as calculate_transits
  include_minor?: boolean,                    // default false
  include_angles?: boolean,                   // default true — include prog angles in aspects_to_natal
  orb_overrides?: object                      // same shape as calculate_aspects
) -> {
  progressed_datetime: string,                // the birth + N days instant actually used
  elapsed_years: number,                      // fractional, and state the year length used
  year_length_days: number,                   // e.g. 365.2422 — make the convention auditable
  progressed_planets: { <body>: { longitude, sign, degree, speed, retrograde: boolean } },
  progressed_houses: { "1".."12": { longitude, sign, degree } },
  progressed_angles: { Ascendant, Midheaven, IC, Descendant },
  angle_method_used: string,
  house_frame_used: string,
  aspects_to_natal: [
    { progressed_body, natal_body, aspect, category, orb, exact_angle, applying }
  ],
  natal_chart: { ... },                       // same shape calculate_transits returns, for diffing
  ephemeris_version: string
}
```

### Notes on the parameters

- **`angle_method` must be echoed back as `angle_method_used`.** The whole problem this
  ticket describes is a silent convention mismatch; the fix is not just correctness, it's
  that the output states which convention produced it. Same for `house_frame` and
  `year_length_days`.
- **`solar_arc` as the default** — it's the most widely used and it's the one that
  self-corrects for the Sun's actual (non-mean) motion. `naibod` for callers who want the
  mean-rate variant. `ephemeris_time` should only exist so the current behaviour has a name;
  if it's implemented, implement it *properly* (advance sidereal time), not as "whatever the
  clock says."
- Deriving the progressed Ascendant from a solar-arc-directed MC at the **natal latitude**
  is the piece that can't be done from outside the server — it needs the house-cusp
  machinery. That is the core of the ask.
- `retrograde: boolean` on progressed planets is worth surfacing explicitly. Progressed
  retrogrades are a real technique and the caller currently has to infer them from the sign
  of `speed`.

## Nice-to-have follow-on (separate ticket, not this one)

`find_progressed_event(birth_*, body, event: "sign_ingress" | "house_ingress" | "station" |
"aspect_to_natal", ...)` returning dated hits over a search window. Every progression
question in practice is "*when* does this change," and bisection-by-hand is the bulk of the
work. Same argument applies to transits — the server has no date-range search at all, so
transit exactness dates are also found by manual sampling today.

## Acceptance criteria

1. `angle_method: "solar_arc"` for `DAY_CHART` above returns progressed MC = 13°04′39″
   Aquarius ±2′, and a progressed Ascendant computed at latitude 51.4769 from that MC.
2. `angle_method: "naibod"` for the same input returns progressed MC = 12°01′57″ Aquarius
   ±2′.
3. `PARTNER_CHART`, `solar_arc`: progressed MC = 25°50′43″ Scorpio ±2′.
4. `progressed_planets` for `DAY_CHART` matches the current manual workaround exactly —
   e.g. Moon 16°53′21″ Taurus, Venus 21°31′01″ Capricorn, Sun 13°53′29″ Aquarius.
5. `angle_method_used`, `house_frame_used`, `year_length_days` and `progressed_datetime`
   are always present in the response.
6. Requesting an unknown `angle_method` errors rather than silently defaulting.

## Provenance

Figures above were computed on 2026-08-07 using this server's own
`calculate_planetary_positions` tool against `swiss-ephemeris-mcp-server@1.0.2+c01d22d`,
using this repo's `DAY_CHART` and `PARTNER_CHART` synthetic fixtures
(`test/fixtures/charts.js`). The solar-arc and Naibod columns are derived from those
returned longitudes by the standard formulas and are the *expected* values the tool should
produce, not server output.
