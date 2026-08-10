# Swiss Ephemeris MCP Server

A Model Context Protocol (MCP) server that provides astronomical calculations using the Swiss Ephemeris library. Calculate planetary positions, houses, chart points, and asteroids for any date and location.

## Features

- **Planetary Positions**: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto
- **Lunar Nodes**: True Node by default, Mean Node available via `node_type` - see [Lunar Node Type](#lunar-node-type)
- **Asteroids**: Chiron, Ceres, Pallas, Juno, Vesta, Lilith
- **Houses**: 12-house system using Placidus
- **Chart Points**: Ascendant, Midheaven, IC, Descendant
- **Additional Points**: South Node, Part of Fortune
- **Speed**: Every planet now includes a `speed` field (deg/day, signed, negative = retrograde)
- **Declination**: Every planet includes `ecliptic_latitude`, `declination`, and out-of-bounds status; angles, cusps, and Vertex include `declination`
- **Aspects**: Natal chart aspect calculation with applying/separating status

## Installation

#### Prerequisites for Local Development

For local use with Claude Desktop, you need to install the Swiss Ephemeris `swetest` command:

```bash
# Install swetest (required for Claude Desktop usage)
git clone https://github.com/aloistr/swisseph.git /tmp/swisseph && \
    cd /tmp/swisseph && \
    make && \
    cp swetest /usr/local/bin/ && \
    rm -rf /tmp/swisseph
```

`SE_EPHE_PATH` (the directory holding the `.se1` ephemeris data files) defaults to the `vendor/swisseph/` directory shipped alongside this package, so it works out of the box for both Docker and local/npx installs. Set the `SE_EPHE_PATH` environment variable to override it.


### Claude Desktop

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "swissEphemeris": {
      "command": "npx",
      "args": ["github:dm0lz/swiss-ephemeris-mcp-server"]
    }
  }
}
```

### Manual Installation

```bash
git clone https://github.com/dm0lz/swiss-ephemeris-mcp-server.git
cd swiss-ephemeris-mcp-server
npm install
npm start
```

## Usage

The server provides seven main tools:

### `calculate_planetary_positions`

Calculate astronomical data for a specific date, time, and location.

**Parameters:**
- `datetime` (string): ISO8601 format, e.g., "1985-04-12T23:20:50Z"
- `latitude` (number): Latitude in decimal degrees (-90 to 90)
- `longitude` (number): Longitude in decimal degrees (-180 to 180)
- `house_system` (string, optional): House system code. Default `P`. See [House Systems](#house-systems).
- `node_type` (string, optional): `"true"` (default) or `"mean"` Lunar Node. See [Lunar Node Type](#lunar-node-type).

**Returns:**
- `planets`: Positions of all planets and celestial bodies. Each entry has `longitude`, `sign`, `degree`, `speed`, `ecliptic_latitude` (decimal degrees, + = north of the ecliptic), `declination` (decimal degrees, + = north of the celestial equator), `out_of_bounds` (`true` when `|declination|` exceeds the obliquity of the date), and `out_of_bounds_by` (decimal degrees past the boundary when out of bounds, `null` otherwise). All 17 bodies carry all four fields uniformly, including North Node (`ecliptic_latitude: 0`, always in bounds). The Sun is hard-coded `out_of_bounds: false`: its ~0.5″ apparent ecliptic latitude (light-time and aberration) can push its apparent declination a fraction of an arcsecond past true obliquity right at a solstice, which would otherwise flag the body that defines the boundary as having left it.
- `houses`: 12 astrological houses, each with `declination` in addition to `longitude`/`sign`/`degree`. No `ecliptic_latitude` or out-of-bounds fields — impossible for a latitude-0 point.
- `chart_points`: Ascendant, Midheaven, IC, Descendant, Vertex, ARMC. All carry `declination` except ARMC — its declination column is a right ascension printed in zodiacal notation, not a real declination, so it's omitted rather than reported as a misleading `0`. IC and Descendant declinations are exact negations of Midheaven and Ascendant, matching how their longitudes are derived.
- `additional_points`: South Node, Part of Fortune. South Node's `declination` is the exact negation of North Node's, and follows the same `node_type`. Part of Fortune gets neither `ecliptic_latitude` nor `declination` — it's a longitude construct with no physical position, computed with the traditional day-chart formula (`Ascendant + Moon - Sun`) when the Sun is in houses 7-12, or the night-chart formula (`Ascendant + Sun - Moon`) when the Sun is in houses 1-6.
- `obliquity`: True obliquity of the ecliptic for the moment (mean obliquity plus nutation), in decimal degrees. Required to audit any `out_of_bounds` flag independently.
- `obliquity_type`: Always `"true"` — the audit trail for every `out_of_bounds` flag, distinguishing it from the mean obliquity (differs by up to a few arcseconds).
- `house_system`: The house system code actually used
- `node_type`: The Lunar Node type actually used (`"true"` or `"mean"`) — labels `planets['North Node']` and `additional_points['South Node']`.
- `warnings` (only present if something's missing): if an ephemeris data file needed for a body isn't found under `SE_EPHE_PATH`, that body is omitted from `planets` entirely rather than reported at a fabricated 0° Aries position, and a message naming the missing file is added here.

### `calculate_transits`

Calculate birth chart positions and current transits for comparison, including aspects from transiting bodies to the natal chart.

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `latitude` (number): Birth latitude in decimal degrees
- `longitude` (number): Birth longitude in decimal degrees
- `house_system` (string, optional): House system code applied to both charts. Default `P`. See [House Systems](#house-systems).
- `node_type` (string, optional): `"true"` (default) or `"mean"` Lunar Node, applied to both the natal chart and current transits. See [Lunar Node Type](#lunar-node-type).
- `include_minor` (boolean, optional): Include minor aspects in `transit_aspects`. Default `false`.
- `include_angles` (boolean, optional): Include the NATAL chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in `transit_aspects`. Transiting angles are always excluded, even if requested via `bodies`: they are artifacts of the moment's location and time of day (the transiting Ascendant sweeps the whole zodiac daily), so transit-side angle contacts change minute to minute and carry no meaning. Default `false`.
- `include_south_node` (boolean, optional): Include South Node in `transit_aspects`. Default `false`.
- `include_vertex` (boolean, optional): Include the NATAL Vertex in `transit_aspects`. Default `false`, independent of `include_angles`. The transiting Vertex is always excluded from the transiting side, even if requested via `bodies` — like the transiting angles, it's an artifact of the moment's location/time, so transit-side Vertex contacts carry no meaning.
- `bodies` (array of strings, optional): Override the default body list for `transit_aspects`. Angle bodies are always excluded from the transiting side, even if listed here.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `transit_aspects`. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults.
- `orb_model` (string, optional): Orb resolution model for `transit_aspects`. `"moiety"` (default) sums each body's half-orb (e.g. Sun 7.5°, Moon 6°) and scales by the aspect's multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}`. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect.

**Returns:**
- `natal_chart`: Complete birth chart data
- `current_transits`: Current planetary positions
- `transit_aspects`: Array of aspects from transiting bodies to the natal chart, sorted by orb ascending. Each entry has `transiting_body`, `natal_body`, `aspect`, `category`, `orb`, `exact_angle`, `applying`.
- `settings_used`: The resolved settings (including `orb_model` and `node_type`) actually applied to `transit_aspects`.
- `calculation_time`: Timestamp of transit calculation

### `calculate_solar_revolution`

Calculate solar return chart for a specific year (when Sun returns to natal position).

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `birth_latitude` (number): Birth latitude in decimal degrees
- `birth_longitude` (number): Birth longitude in decimal degrees
- `return_year` (number): Year for solar return calculation (e.g., 2024)
- `return_latitude` (number, optional): Solar return location latitude
- `return_longitude` (number, optional): Solar return location longitude
- `house_system` (string, optional): House system code applied to both natal and solar return charts. Default `P`. See [House Systems](#house-systems).
- `node_type` (string, optional): `"true"` (default) or `"mean"` Lunar Node, applied to both the natal and solar return charts. See [Lunar Node Type](#lunar-node-type).

**Returns:**
- `natal_chart`: Original birth chart data
- `solar_return_chart`: Solar return chart for the specified year
- `natal_sun_longitude`: Original Sun position in degrees
- `return_sun_longitude`: Solar return Sun position in degrees
- `calculation_time`: Timestamp of calculation

### `calculate_synastry`

Calculate synastry chart between two people for relationship compatibility analysis.

**Parameters:**
- `person1_datetime` (string): Person 1 birth datetime in ISO8601 format
- `person1_latitude` (number): Person 1 birth latitude in decimal degrees
- `person1_longitude` (number): Person 1 birth longitude in decimal degrees
- `person2_datetime` (string): Person 2 birth datetime in ISO8601 format
- `person2_latitude` (number): Person 2 birth latitude in decimal degrees
- `person2_longitude` (number): Person 2 birth longitude in decimal degrees
- `person1_house_system` (string, optional): House system code for person 1. Default `P`. See [House Systems](#house-systems).
- `person2_house_system` (string, optional): House system code for person 2. Default `P`.
- `node_type` (string, optional): `"true"` (default) or `"mean"` Lunar Node, applied to both charts. Unlike `person1_house_system`/`person2_house_system`, this is a single value for both people — which node you use is definitional, not a per-chart display choice, so it must match on both sides of the comparison. See [Lunar Node Type](#lunar-node-type).
- `include_minor` (boolean, optional): Include minor aspects. Default `false`.
- `include_angles` (boolean, optional): Also compute `angle_aspects` (planet-to-angle and angle-to-angle contacts). Default `false`.
- `include_vertex` (boolean, optional): Include the Vertex in `angle_aspects` (planet-to-Vertex and Vertex-to-Vertex contacts across the two charts). Default `false`, independent of `include_angles` — setting this alone still produces an `angle_aspects` array, containing only Vertex contacts.
- `bodies` (array of strings, optional): Override the default body list for `synastry_aspects` and the planet side of `angle_aspects` (defaults to the full 17-body list: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Must be names known to the server; an unknown name throws `InvalidParams`. `house_overlay` is unaffected by this override — it always reports the same 13 points (10 major bodies plus Ascendant, Midheaven, and Part of Fortune).
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults.
- `orb_model` (string, optional): Orb resolution model. `"moiety"` (default) sums each body's half-orb and scales by the aspect's multiplier — see `calculate_aspects` below for the formula and an example. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}`. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect.

**Returns:**
- `person1_chart`: Complete birth chart for person 1
- `person2_chart`: Complete birth chart for person 2
- `synastry_aspects`: Array of planetary aspects between the charts. Defaults to the full 17-body list (Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta); override with `bodies`.
- `house_overlay`: `{ person1_planets_in_person2_houses, person2_planets_in_person1_houses }` — for each of the 10 major bodies plus Ascendant, Midheaven, and Part of Fortune (13 points total; Descendant and IC are not included), which house (1-12) of the other person's chart it falls into. These 13 points are fixed regardless of `bodies` — the override only affects `synastry_aspects` and the planet side of `angle_aspects`.
- `angle_aspects` (only present when `include_angles` or `include_vertex` is `true`): Array of aspects involving Ascendant/Midheaven/Part of Fortune (when `include_angles`) and/or the Vertex (when `include_vertex`) across the two charts. Same shape as `synastry_aspects` — `aspect`, `category`, `orb`, `exact_angle`, `applying`, and `person1_position`/`person2_position` (`{longitude, sign, degree}`) — but with `person1_point`/`person2_point` naming the point instead of `person1_planet`/`person2_planet`. The planet side defaults to the same full 17-body list as `synastry_aspects` (also overridable via `bodies`). IC, Descendant, and the anti-Vertex are not separately aspected — see [Angle Aspects](#angle-aspects) for why, and how to derive their contacts from this array.
- `calculation_time`: Timestamp of calculation

### `calculate_aspects`

Calculate natal chart aspects for a given datetime and coordinates. Returns planetary positions plus all qualifying aspects with orb, applying/separating status, and category.

**Parameters:**
- `datetime` (string): ISO8601 format, e.g., "1985-04-12T23:20:50Z"
- `latitude` (number): Latitude in decimal degrees (-90 to 90)
- `longitude` (number): Longitude in decimal degrees (-180 to 180)
- `include_minor` (boolean, optional): Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile). Default `false`.
- `include_angles` (boolean, optional): Include chart angles in aspect calculations — Ascendant, Midheaven, and Part of Fortune are aspected; IC and Descendant are computed but never aspected (see [Angle Aspects](#angle-aspects)). Default `false`.
- `include_south_node` (boolean, optional): Include South Node in aspect calculations. Default `false`.
- `include_vertex` (boolean, optional): Include the Vertex in aspect calculations. Default `false`. Independent of `include_angles` — the Vertex is contested and highly sensitive to birth-time precision (more so than the Ascendant), so it's opt-in on its own. The anti-Vertex (Vertex + 180°) is never separately aspected, for the same double-counting reason IC/Descendant are excluded (see [Angle Aspects](#angle-aspects)).
- `bodies` (array of strings, optional): Override the default aspect body list. Must be names known to the server.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees, e.g. `{"conjunction": 10}`. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults.
- `orb_model` (string, optional): Orb resolution model. `"moiety"` (default) sums each body's half-orb (per-body table, e.g. Sun 7.5°, Moon 6°, Ascendant 2.5°) and scales by the aspect's multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}` — `moieties` keys are body/point names, `multipliers` keys are aspect names. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect.
- `house_system` (string, optional): House system code. Default `P`. See [House Systems](#house-systems).
- `node_type` (string, optional): `"true"` (default) or `"mean"` Lunar Node. See [Lunar Node Type](#lunar-node-type).

**Returns:**
- All fields from `calculate_planetary_positions` (`planets`, `houses`, `chart_points`, `additional_points`, `obliquity`, `obliquity_type`, `datetime`, `coordinates`, `house_system`, `node_type`)
- `aspects`: Array of qualifying aspects, sorted by orb ascending. Each entry has `body_a`, `body_b`, `aspect`, `category` (`major`/`minor`), `aspect_angle`, `separation`, `orb`, `orb_allowed`, and `applying` (`true`/`false`/`null` — `null` when applying/separating cannot be determined, e.g. angle points with no speed, near-stationary bodies, or an exact hit).
- `settings_used`: The resolved settings (`include_minor_aspects`, `include_angles`, `include_south_node`, `include_vertex`, `bodies`, `orb_overrides`, `orb_model`, `node_type`) actually applied to the calculation.

### `calculate_secondary_progressions`

Calculate secondary progressions (the "day for a year" technique): progressed planetary positions, a correctly-derived progressed Ascendant/Midheaven/IC/Descendant, progressed houses, and aspects from the progressed bodies to the natal chart.

This exists because the angles of a plain `calculate_planetary_positions` call at the progressed clock instant are not progressed angles under any convention — they're the angles of a real moment days after birth, off by hundreds of degrees from either progression convention. This tool instead directs the natal Midheaven along the ecliptic by the chosen arc and converts that to a right ascension (ARMC) before deriving houses, which is the piece that needs the house-cusp machinery and can't be done from outside the server.

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `birth_latitude` (number): Birth latitude in decimal degrees
- `birth_longitude` (number): Birth longitude in decimal degrees
- `target_date` (string): ISO8601 datetime to progress to. The real elapsed time between `birth_datetime` and this date, expressed in tropical years (`year_length_days` = 365.2422), is converted 1 year = 1 day and added to `birth_datetime` to get the progressed instant, returned as `progressed_datetime`.
- `house_system` (string, optional): House system code, applied to both the natal chart and the progressed houses. Default `P`. See [House Systems](#house-systems).
- `angle_method` (string, optional): `"solar_arc"` (default) directs the Midheaven by (progressed Sun longitude − natal Sun longitude), which self-corrects for the Sun's actual non-mean motion. `"naibod"` uses a mean rate of 360/`year_length_days` degrees per elapsed year instead. Both direct the *ecliptic* Midheaven, not the ARMC/right ascension directly — the two conventions diverge from each other by roughly a degree per few decades of age. An unrecognized value throws `InvalidParams` rather than silently defaulting; `"ephemeris_time"` (the raw clock-time angles) is deliberately not offered, since naming it invites the exact bug this tool exists to fix.
- `house_frame` (string, optional): `"progressed"` (default) or `"natal"` — which house cusps to report as `progressed_houses` and use for house placement of progressed bodies. `progressed_angles` are always the arc-directed progressed values regardless of this setting.
- `bodies` (array of strings, optional): Override the default body list (defaults to the same list as `calculate_transits`: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Applies to `progressed_planets` and the progressed side of `aspects_to_natal`.
- `include_minor` (boolean, optional): Include minor aspects in `aspects_to_natal`. Default `false`.
- `include_angles` (boolean, optional): Include progressed Ascendant/Midheaven as aspectable bodies on the progressed side of `aspects_to_natal`, and natal Ascendant/Midheaven/Part of Fortune on the natal side. Default `true` — unlike `calculate_transits`/`calculate_synastry`, this defaults on: progressed angle contacts are this tool's headline output, and unlike a transiting Ascendant (which sweeps the whole zodiac daily and means nothing), the progressed Ascendant/Midheaven stay meaningful. Progressed Part of Fortune is never included on the progressed side regardless of this flag — which day/night formula applies to a progressed sect is unsettled.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `aspects_to_natal`, e.g. `{"conjunction": 10}`. Also accepts the per-class shape (`{"angle": {...}}` / `{"derived": {...}}`) described under `calculate_transits` above. The default orb tables are transit-scaled; the conventional orb for progressed aspects is tighter, around 1 degree, so callers doing serious progressions work will usually want to tighten these.

**Returns:**
- `progressed_datetime`: The birth-plus-elapsed-years instant actually used
- `elapsed_years`: Fractional tropical years between `birth_datetime` and `target_date`
- `year_length_days`: The year length used to derive `elapsed_years` and the Naibod rate (365.2422)
- `progressed_planets`: `{ <body>: { longitude, sign, degree, speed, retrograde } }` for the requested bodies. `retrograde` is surfaced explicitly rather than left for callers to infer from the sign of `speed`.
- `progressed_houses`: The 12 house cusps selected by `house_frame`
- `progressed_angles`: `{ Ascendant, Midheaven, IC, Descendant }`, always the arc-directed progressed values
- `angle_method_used`, `house_frame_used`: The resolved settings actually applied
- `aspects_to_natal`: Array of aspects from the progressed bodies to the natal chart. Each entry has `progressed_body`, `natal_body`, `aspect`, `category`, `orb`, `exact_angle`, `applying`. Unlike `calculate_transits`/`calculate_synastry`, `orb` and `exact_angle` are numbers, not `.toFixed(2)` strings.
- `natal_chart`: Complete birth chart data, same shape as `calculate_transits`' `natal_chart`, for diffing
- `ephemeris_version`: `<package name>@<version>[+<git short sha>]` of the server that produced the result

### `find_events`

Search a UTC window for time-domain astrological events: transiting-to-natal aspect contacts, planetary stations, sign and house ingresses, and lunations. Where `calculate_transits` answers "is this happening right now," `find_events` answers "when."

Correctness comes from segmenting the search window at the transiting body's own stations (points where its longitude stops being monotone) and then enumerating every target longitude crossed within each resulting monotone segment. That guarantees every exact pass is found — missing one would require missing a station, not missing a sample between two scan points. A coarse 1-day step only has to bracket those stations, which it does with wide margin even for the fastest-stationing body (Mercury, ~21-day retrograde periods).

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `latitude` (number): Birth latitude in decimal degrees
- `longitude` (number): Birth longitude in decimal degrees, positive east
- `window_start` (string): Start of the UTC search window, ISO8601
- `window_end` (string): End of the UTC search window, ISO8601. Must be after `window_start`. A request longer than 10 years is clamped to 10 years from `window_start` rather than rejected — see `window.truncated` on the result.
- `event_types` (array of strings, optional): Which categories to search — `"aspect"`, `"station"`, `"sign_ingress"`, `"house_ingress"`, `"lunation"`. Default: all five. `"aspect"` populates `contacts[]`; the rest populate `events[]`.
- `house_system` (string, optional): House system code applied to the natal chart and to `house_ingress`. Default `P`. See [House Systems](#house-systems).
- `bodies` (array of strings, optional): The TRANSITING side. Default: Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron — the bodies slow enough to define forecasting "chapters" rather than trigger them. **The transiting Moon is excluded from the default** because it alone accounts for over 70% of a full year's output (roughly 21.7x the rest of the default scope combined) and a transiting-Moon aspect lasts hours — a trigger for electional/horary work over a short window, not the answer to "is this a good year." It's still reachable by explicit request, as are Sun, Mercury, Venus, the asteroids, Lilith and North Node. Angle bodies (Ascendant/Midheaven/IC/Descendant) and the Vertex can never transit — they're artifacts of the moment's location and time of day, not moving points, and are rejected as unknown bodies. This same list governs `station` events (further narrowed to the 13 bodies that can actually station — Sun, Moon, Lilith and North Node never emit one, even if listed here: the Sun and Moon never reverse, Lilith is always direct by construction, and the true Node reverses direction roughly 350 times a year from orbital wobble, which is jitter, not a station) and `sign_ingress`/`house_ingress` events.
- `targets` (array of strings, optional): The NATAL side. Default: the same 17-body list as `calculate_transits` (Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Ascendant/Midheaven/Part of Fortune behind `include_angles`, Vertex behind `include_vertex`, South Node behind `include_south_node` — same gating as `calculate_transits`/`calculate_aspects`.
- `include_minor` (boolean, optional): Include minor aspects in `contacts[]`. Default `false` — deliberately identical to `calculate_aspects`/`calculate_transits`, so an aspect visible in a snapshot tool is never unsearchable here.
- `include_angles` (boolean, optional): Include natal Ascendant, Midheaven and Part of Fortune as targets. Default `false`.
- `include_south_node` (boolean, optional): Include natal South Node as a target. Default `false`.
- `include_vertex` (boolean, optional): Include natal Vertex as a target. Default `false`, independent of `include_angles`.
- `include_quarter_moons` (boolean, optional): Include First/Last Quarter alongside New/Full Moon in `lunation` events. Default `false` — New and Full carry the overwhelming majority of the reading, and the default aims for ~25 lunations/year rather than ~50.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `contacts[]`. Same flat/per-class/moiety shapes as `calculate_transits` (see its `orb_overrides`/`orb_model` description above).
- `orb_model` (string, optional): `"moiety"` (default) or `"class"`. Same formula as every other tool — see [Orb Models](#orb-models). The choice can move a contact's orb-episode boundaries by months for the same pair, not just its width.

**Returns:**
- `window`: `{ start, end, truncated }` — the search window actually used. `truncated` is `true` when the request exceeded the 10-year cap and `end` was clamped.
- `contacts[]`: Aspect **periods**, one row per orb episode of a (transiting body, natal point, aspect) triple, sorted by `enters_orb` ascending. A transiting body can enter and leave a natal point's orb more than once within a wide window (an outer planet's retrograde loop is the common case), so the same triple can appear as more than one row — each with its own `enters_orb`/`leaves_orb`/`passes`/`closest_approach`. Fields: `transiting_body`, `natal_point`, `aspect`, `category`, `aspect_angle`, `orb_allowed`, `enters_orb`, `leaves_orb`, `enters_orb_truncated`/`leaves_orb_truncated` (`true` when that boundary is the window edge rather than a found crossing — an episode already underway at `window_start` would otherwise read as beginning there), `passes[]` (every exact hit within the episode — `datetime`, `longitude`, `sign`, `degree`, `speed`, `retrograde`; may legitimately be empty when a body stations within orb and never perfects), `closest_approach` (`{ datetime, orb, stationary }` — the nearest point reached, which is an exact pass when there is one and a station or window edge otherwise), and `birth_time_sensitive` (see below). Unlike `calculate_transits`/`calculate_synastry`, `orb`/`orb_allowed`/`aspect_angle`/longitude values here are numbers, not `.toFixed(2)` strings.
- `events[]`: Everything else — stations, ingresses, and lunations — sorted by `datetime` ascending. Every entry has `type` and `datetime`:
  - `station`: `body`, `direction` (`"direct"`/`"retrograde"`), `longitude`, `sign`, `degree`, `speed`, and `natal_contacts[]` (`{ natal_point, aspect, orb }` for every natal point within orb of the station's degree at that instant — reported unconditionally, not gated on there being one, since the station's degree stays sensitised for months afterwards regardless).
  - `sign_ingress`: `body`, `direction`, `from_sign`, `to_sign`, `longitude`. Every crossing of a 30° boundary is reported, including retrograde re-ingress — a body can cross the same boundary multiple times around a retrograde station, and a retrograde crossing moves *backwards* into the preceding sign, labelled accordingly (`direction: "retrograde"`, `to_sign` is the sign being re-entered, not the one being left).
  - `house_ingress`: `body`, `direction`, `from_house`, `to_house`, `cusp_longitude`, `house_system`, `coincides_with_sign_ingress`. Computed against the **natal chart's own house cusps**, never against the transiting moment's own houses — a transiting-moment house column rotates with the moment's own Ascendant (roughly once every 24 hours) and answers a different, meaningless question. Under Whole Sign every house cusp sits exactly on a sign boundary, so every `house_ingress` coincides with a `sign_ingress` for the same body at the same instant; both are still reported (suppressing one would make the response's shape depend on `house_system`, and a consumer filtering `type: "house_ingress"` would silently get an empty array). `coincides_with_sign_ingress` makes that coincidence explicit and is computed from the cusp longitude itself (within 1″ of a 30° multiple), not from `house_system === 'W'` — so it also catches an Equal-house chart that happens to land a cusp on a sign boundary.
  - `lunation`: `phase` (`"new"`/`"full"`, plus `"first_quarter"`/`"last_quarter"` when `include_quarter_moons`), `longitude`, `sign`, `degree`, `natal_contacts[]` (same shape as a station's), and an optional `eclipse` block. `eclipse` is **absent, not `null`,** on a non-eclipse lunation. When present it carries `eclipse_type`, `magnitudes` (three values for solar — NASA/diameter-fraction/obscuration — two for lunar — umbral/penumbral — never forced into one shape), `saros_series`, `saros_number`, and **`maximum_datetime`** — the moment of greatest eclipse, which is a *different instant* from the lunation's own `datetime` (the exact syzygy), typically several minutes apart and occasionally over ten. Neither name is allowed to silently stand in for the other: `datetime` is always the exact New/Full Moon; `maximum_datetime` is always the eclipse maximum. A ten-minute gap moves the Ascendant roughly 2.5°, which can change the rising sign of a chart cast for the event — practice is genuinely split on which instant to cast for, so both are reported and the caller chooses.
- `settings_used`: The resolved settings actually applied — `event_types`, `bodies`, `targets`, `house_system`, `orb_model`, `orb_overrides`, `include_minor_aspects`, `include_angles`, `include_south_node`, `include_vertex`, `include_quarter_moons`, and `node_type`. `node_type` is always `"true"`: this tool's engine has no `node_type` parameter of its own yet (it always requests the true/osculating Node from `swetest`), so the literal is stated explicitly rather than left for a caller to assume it matches the other tools' default. A Node event is not interpretable without knowing which Node it is — true-vs-mean differs by up to ~1.8° in 2026, which at an outer planet's speed can be months of date uncertainty.

**`birth_time_sensitive`:** every contact whose `natal_point` is Ascendant, Midheaven, Part of Fortune or Vertex carries `birth_time_sensitive: true`. These are the one class of target whose *dates* (not just positions) carry meaningful birth-time error: the Ascendant advances roughly 1° every 4 minutes of clock time, so a 10-minute birth-time uncertainty is on the order of 2.5° of Ascendant — which at an outer planet's speed can shift a contact date by months. A date list that doesn't say so overstates what the ephemeris actually knows.

### Angle Aspects

When `include_angles` is set, only the Ascendant, Midheaven, and Part of Fortune are matched against other bodies for aspects (in `aspects` for `calculate_aspects`, or `angle_aspects` for `calculate_synastry`). The IC and Descendant are still computed and returned as chart points (`chart_points` / `include_angles` positional output), but are excluded from aspect pair-matching.

This is because IC and Descendant are mathematical mirrors of Midheaven and Ascendant — `IC = Midheaven + 180°` and `Descendant = Ascendant + 180°`. Aspecting all four would double-count every axis contact under two labels (e.g. a body square the Ascendant is, by definition, also square the Descendant).

If you need a body's aspect to IC or Descendant, derive it from the returned Midheaven/Ascendant aspect using the 180° shift:

| Aspect to MC / ASC | Aspect to IC / DSC |
|---|---|
| Conjunction | Opposition |
| Opposition | Conjunction |
| Sextile | Trine |
| Trine | Sextile |
| Square | Square (unchanged) |
| Semisextile | Quincunx |
| Quincunx | Semisextile |
| Semisquare | Sesquiquadrate |
| Sesquiquadrate | Semisquare |
| Quintile | **not derivable** — no mirror partner (180° − 72° = 108° is not an aspect) |
| Biquintile | **not derivable** — no mirror partner (180° − 144° = 36° is not an aspect) |

The orb and applying/separating values carry over unchanged; only the aspect label and its complementary body name change. This is lossless **because** the `angle` orb class (which governs ASC/MC/IC/DSC) is mirror-symmetric by construction — every mirror pair (conjunction/opposition, sextile/trine, semisextile/quincunx, semisquare/sesquiquadrate) carries an equal orb, enforced by a unit test. A body's IC or Descendant contact reached only via a quintile or biquintile to MC/ASC has no mirror partner and is simply absent from the derivation — there is no way to recover it from the returned aspect array.

The Vertex works the same way, gated separately by `include_vertex`: the anti-Vertex (its 180° opposite point) is not a computed chart point and is never separately aspected, for the same double-counting reason IC/Descendant are excluded. It's simply `(vertex_longitude + 180) % 360`, and its aspect to any body is the 180°-shifted mirror of that body's Vertex aspect (same table as above, since the Vertex uses the `derived` orb class, which is symmetric).

### Orb Models

`orb_model` selects how a pair's allowed orb (the maximum separation from exact still counted as an aspect) is derived. There is **no single canonical orb table** in the astrological tradition — different schools and authors disagree, sometimes widely. This server offers two internally-consistent conventions rather than presenting either as definitive:

- **`moiety` (default):** each body/point has its own half-orb ("moiety"). A pair's orb is `(moietyA + moietyB) * multiplier[aspect]` — e.g. Sun (7.5°) conjunct Moon (6°) allows (7.5+6)×1.0 = 13.5°. `orb_overrides` in this mode takes a different two-knob shape instead of the `class`-mode shape: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}` — `moieties` keys are body/point names, `multipliers` keys are aspect names.
- **`class`:** a fixed per-class orb table (`body`/`angle`/`derived`, shown per-tool above), independent of which two bodies are involved. `orb_overrides` in this mode takes the flat (`{"conjunction": 10}`) or per-class (`{"angle": {"square": 4}}`) shape.

Under `moiety`, luminary-to-angle conjunctions widen noticeably versus `class` — e.g. Sun opposition Sun in synastry goes from an 8° orb to 15°. This is expected under the moiety formula (Sun's 7.5° moiety on both sides, ×1.0 multiplier), not a bug.

**Moiety provenance.** The per-body moieties are not uniformly sourced:

| Tier | Bodies | Source |
|---|---|---|
| Sourced | Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn | Halved from a classical full-orb table (15/12/7/7/8/9/9°) |
| Non-traditional | Uranus, Neptune, Pluto, Chiron, North/South Node, Lilith, Ceres, Pallas, Juno, Vesta, Ascendant, Midheaven, IC, Descendant, Part of Fortune, Vertex | Team-constructed by analogy to the sourced tier — there is no classical precedent for orbs on these bodies/points |

Treat the non-traditional tier as an implementation choice, not an authoritative claim. IC/Descendant mirror Midheaven/Ascendant (2.5°) structurally, matching the `angle`-class mirror symmetry described in [Angle Aspects](#angle-aspects).

**Aspect multipliers:** conjunction/opposition/trine/square = 1.0, sextile = 0.75, semisextile/semisquare/sesquiquadrate/quincunx/quintile/biquintile = 0.375. The sextile multiplier is *narrower*, not a demotion — sextile is still a major (Ptolemaic) aspect and is returned with `category: "major"` under either `orb_model`. The multiplier only scales its allowed orb; it does not move it into the minor-aspect set (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile), which are `category: "minor"` regardless of `orb_model`.

## House Systems

Any tool that computes houses accepts an optional `house_system` code (default `P`):

| Code | System |
|------|--------|
| `P` | Placidus (default) |
| `K` | Koch |
| `O` | Porphyry |
| `R` | Regiomontanus |
| `C` | Campanus |
| `E` | Equal |
| `W` | Whole Sign |
| `B` | Alcabitus |
| `M` | Morinus |
| `T` | Polich/Page (Topocentric) |

An unknown code returns an `InvalidParams` error listing the valid codes.

## Lunar Node Type

Every tool that returns a Node accepts an optional `node_type` code (default `"true"`):

| Code | Node | Behavior |
|------|------|----------|
| `true` (default) | True (osculating) Node | Follows the Moon's actual, instantaneous orbital plane. Oscillates and can briefly reverse direction (go "direct") before resuming its normal retrograde motion. |
| `mean` | Mean Node | The smoothed, secular position with the periodic oscillation averaged out. Moves monotonically retrograde, roughly -3′11″/day, with no reversals. |

`true` is the default because it matches what most modern Western tools (astro.com, Solar Fire) return when a caller doesn't specify — the *default* is not in question, only its label was missing. The two differ by roughly 1-2° at any given moment, which is enough to shift the Node's sign or move a Node aspect in or out of orb; they are not interchangeable. `node_type` also determines South Node (its exact opposite) and any Node-derived aspect.

Reach for `mean` when you want a monotonic, non-oscillating reference point — for example, tracking Node ingresses or stations over time. The true Node's wobble means it can cross a sign boundary, reverse, and cross back within days, which reads as noise rather than a real ingress in most time-domain use cases.

The resolved value is echoed back: as `node_type` directly on any returned chart (`calculate_planetary_positions`, `calculate_solar_revolution`'s `natal_chart`/`solar_return_chart`, `calculate_synastry`'s `person1_chart`/`person2_chart`), and as `settings_used.node_type` wherever the tool already returns a `settings_used` block (`calculate_aspects`, `calculate_transits`). `calculate_synastry`/`calculate_transits` take a single `node_type` for the whole call rather than one per chart — which node you're using is definitional, not a per-chart display choice, so both sides of a comparison must agree.

An unknown value returns an `InvalidParams` error listing the valid codes.

## Contributing

Commit messages are linted against [Conventional Commits](https://www.conventionalcommits.org/) (`@commitlint/config-conventional`) via a husky `commit-msg` hook, e.g. `fix: ...`, `feat: ...`, `chore: ...`, `docs: ...`. The hook installs automatically on `npm install`/`npm ci` (`prepare: husky`) and runs `pnpm exec commitlint --edit` against each commit message.

For WIP or otherwise non-conforming commits, bypass the hook with `git commit --no-verify`.

PR titles are also checked in CI against Conventional Commits (`.github/workflows/pr-title-lint.yml`, via `amannn/action-semantic-pull-request`), since this repo squash-merges with the PR title as the resulting commit message — a non-conforming title will fail the check even if the individual commits are fine.

This is what makes releases automatic (see [Releases](#releases) below): every commit that lands on `main` has a Conventional Commits type, and [semantic-release](https://semantic-release.gitbook.io/) reads that history to decide the next version.

## Releases

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/) (`.releaserc.json`, `.github/workflows/release.yml`). Every push to `main` runs `npx semantic-release`, which:

1. Reads the Conventional Commits since the last release tag to decide the version bump — `fix:` → patch, `feat:` → minor, a `BREAKING CHANGE:` footer (or `!` after the type) → major. If nothing on `main` warrants a release, it's a no-op.
2. Generates release notes and prepends them to `CHANGELOG.md`.
3. Bumps `version` in `package.json`.
4. Commits `CHANGELOG.md` and `package.json` back to `main` as `chore(release): <version> [skip ci]`, tags the commit, and publishes a GitHub Release.

`npm` publishing is disabled (`@semantic-release/npm` runs with `npmPublish: false`) — this project isn't published to a registry; the plugin is only used for the local version bump/tag bookkeeping. The release history starts from the `v1.0.2` baseline tag seeded on this repo; earlier changes aren't retroactively versioned.

`CHANGELOG.md` currently has a hand-written "Unreleased" section predating this automation (see its own history) — semantic-release will prepend future entries above it rather than merge with it, so expect the top of the file to have both a manual and a generated section until that's reconciled.

## Docker

```bash
# Build and run
docker build -t swiss-ephemeris-mcp .
docker run -p 8000:8000 -e MCP_HTTP_MODE=true swiss-ephemeris-mcp

# Health check
curl http://localhost:8000/health
```

## Transport Modes

- **Stdio**: Default mode for Claude Desktop integration
- **HTTP**: Use `MCP_HTTP_MODE=true` for web integration via ngrok

## Links

- **MCP URL**: https://www.theme-astral.me/mcp
- **Repository**: https://github.com/dm0lz/swiss-ephemeris-mcp-server
- **Swiss Ephemeris**: https://www.astro.com/swisseph/

## License

MIT 