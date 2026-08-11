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
- **Declination Aspects**: Opt-in parallel/contraparallel contacts by declination — see [Declination Aspects](#declination-aspects)

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
- `include_declination_aspects` (boolean, optional): Include parallel/contraparallel contacts by declination in `declination_aspects`. Default `false`. See [Declination Aspects](#declination-aspects).
- `orb_overrides` (object, optional): Accepts a `declination` key for `declination_aspects`, e.g. `{"declination": {"parallel": 1.5, "contraparallel": 1}}` — see [Declination Aspects](#declination-aspects). No other orb overrides apply to this tool.

**Returns:**
- `planets`: Positions of all planets and celestial bodies. Each entry has `longitude`, `sign`, `degree`, `speed`, `ecliptic_latitude` (decimal degrees, + = north of the ecliptic), `declination` (decimal degrees, + = north of the celestial equator), `out_of_bounds` (`true` when `|declination|` exceeds the obliquity of the date), and `out_of_bounds_by` (decimal degrees past the boundary when out of bounds, `null` otherwise). All 17 bodies carry all four fields uniformly, including North Node (`ecliptic_latitude: 0`, always in bounds). The Sun is hard-coded `out_of_bounds: false`: its ~0.5″ apparent ecliptic latitude (light-time and aberration) can push its apparent declination a fraction of an arcsecond past true obliquity right at a solstice, which would otherwise flag the body that defines the boundary as having left it.
- `houses`: 12 astrological houses, each with `declination` in addition to `longitude`/`sign`/`degree`. No `ecliptic_latitude` or out-of-bounds fields — impossible for a latitude-0 point.
- `chart_points`: Ascendant, Midheaven, IC, Descendant, Vertex, ARMC. All carry `declination` except ARMC — its declination column is a right ascension printed in zodiacal notation, not a real declination, so it's omitted rather than reported as a misleading `0`. IC and Descendant declinations are exact negations of Midheaven and Ascendant, matching how their longitudes are derived.
- `additional_points`: South Node, Part of Fortune. South Node's `declination` is the exact negation of North Node's, and follows the same `node_type`. Part of Fortune gets neither `ecliptic_latitude` nor `declination` — it's a longitude construct with no physical position, computed with the traditional day-chart formula (`Ascendant + Moon - Sun`) when the Sun is in houses 7-12, or the night-chart formula (`Ascendant + Sun - Moon`) when the Sun is in houses 1-6.
- `obliquity`: True obliquity of the ecliptic for the moment (mean obliquity plus nutation), in decimal degrees. Required to audit any `out_of_bounds` flag independently.
- `obliquity_type`: Always `"true"` — the audit trail for every `out_of_bounds` flag, distinguishing it from the mean obliquity (differs by up to a few arcseconds).
- `house_system`: The house system code actually used
- `node_type`: The Lunar Node type actually used (`"true"` or `"mean"`) — labels `planets['North Node']` and `additional_points['South Node']`.
- `declination_aspects` (only present when `include_declination_aspects` is `true`): Array of parallel/contraparallel contacts by declination, `body_a`/`body_b` naming — see [Declination Aspects](#declination-aspects).
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
- `include_declination_aspects` (boolean, optional): Include parallel/contraparallel contacts by declination in `declination_aspects`, transiting body vs natal point. Default `false`. See [Declination Aspects](#declination-aspects).
- `bodies` (array of strings, optional): Override the default body list for `transit_aspects` and `declination_aspects`. Angle bodies are always excluded from the transiting side, even if listed here.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `transit_aspects`. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults. Also accepts a `declination` key for `declination_aspects`, e.g. `{"declination": {"parallel": 1.5, "contraparallel": 1}}` — see [Declination Aspects](#declination-aspects).
- `orb_model` (string, optional): Orb resolution model for `transit_aspects`. `"moiety"` (default) sums each body's half-orb (e.g. Sun 7.5°, Moon 6°) and scales by the aspect's multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}`. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect. `declination_aspects` orbs are unaffected by this setting either way.

**Returns:**
- `natal_chart`: Complete birth chart data
- `current_transits`: Current planetary positions
- `transit_aspects`: Array of aspects from transiting bodies to the natal chart, sorted by orb ascending. Each entry has `transiting_body`, `natal_body`, `aspect`, `category`, `orb`, `exact_angle`, `applying`.
- `declination_aspects` (only present when `include_declination_aspects` is `true`): Array of parallel/contraparallel contacts, transiting body vs natal point — see [Declination Aspects](#declination-aspects).
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
- `include_declination_aspects` (boolean, optional): Include parallel/contraparallel contacts by declination in `declination_aspects`, person1 planet vs person2 planet. Default `false`. See [Declination Aspects](#declination-aspects).
- `bodies` (array of strings, optional): Override the default body list for `synastry_aspects`, the planet side of `angle_aspects`, and `declination_aspects` (defaults to the full 17-body list: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Must be names known to the server; an unknown name throws `InvalidParams`. `house_overlay` is unaffected by this override — it always reports the same 13 points (10 major bodies plus Ascendant, Midheaven, and Part of Fortune).
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults. Also accepts a `declination` key for `declination_aspects`, e.g. `{"declination": {"parallel": 1.5, "contraparallel": 1}}` — see [Declination Aspects](#declination-aspects).
- `orb_model` (string, optional): Orb resolution model. `"moiety"` (default) sums each body's half-orb and scales by the aspect's multiplier — see `calculate_aspects` below for the formula and an example. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}`. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect. `declination_aspects` orbs are unaffected by this setting either way.

**Returns:**
- `person1_chart`: Complete birth chart for person 1
- `person2_chart`: Complete birth chart for person 2
- `synastry_aspects`: Array of planetary aspects between the charts. Defaults to the full 17-body list (Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta); override with `bodies`.
- `house_overlay`: `{ person1_planets_in_person2_houses, person2_planets_in_person1_houses }` — for each of the 10 major bodies plus Ascendant, Midheaven, and Part of Fortune (13 points total; Descendant and IC are not included), which house (1-12) of the other person's chart it falls into. These 13 points are fixed regardless of `bodies` — the override only affects `synastry_aspects` and the planet side of `angle_aspects`.
- `angle_aspects` (only present when `include_angles` or `include_vertex` is `true`): Array of aspects involving Ascendant/Midheaven/Part of Fortune (when `include_angles`) and/or the Vertex (when `include_vertex`) across the two charts. Same shape as `synastry_aspects` — `aspect`, `category`, `orb`, `exact_angle`, `applying`, and `person1_position`/`person2_position` (`{longitude, sign, degree}`) — but with `person1_point`/`person2_point` naming the point instead of `person1_planet`/`person2_planet`. The planet side defaults to the same full 17-body list as `synastry_aspects` (also overridable via `bodies`). IC, Descendant, and the anti-Vertex are not separately aspected — see [Angle Aspects](#angle-aspects) for why, and how to derive their contacts from this array.
- `declination_aspects` (only present when `include_declination_aspects` is `true`): Array of parallel/contraparallel contacts, person1 planet vs person2 planet — see [Declination Aspects](#declination-aspects).
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
- `include_declination_aspects` (boolean, optional): Include parallel/contraparallel contacts by declination in `declination_aspects`. Default `false`. See [Declination Aspects](#declination-aspects).
- `bodies` (array of strings, optional): Override the default aspect body list. Must be names known to the server. Also filters `declination_aspects`.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees, e.g. `{"conjunction": 10}`. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults. Also accepts a `declination` key for `declination_aspects`, e.g. `{"declination": {"parallel": 1.5, "contraparallel": 1}}` — see [Declination Aspects](#declination-aspects).
- `orb_model` (string, optional): Orb resolution model. `"moiety"` (default) sums each body's half-orb (per-body table, e.g. Sun 7.5°, Moon 6°, Ascendant 2.5°) and scales by the aspect's multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}` — `moieties` keys are body/point names, `multipliers` keys are aspect names. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect. `declination_aspects` orbs are unaffected by this setting either way.
- `house_system` (string, optional): House system code. Default `P`. See [House Systems](#house-systems).
- `node_type` (string, optional): `"true"` (default) or `"mean"` Lunar Node. See [Lunar Node Type](#lunar-node-type).

**Returns:**
- All fields from `calculate_planetary_positions` (`planets`, `houses`, `chart_points`, `additional_points`, `obliquity`, `obliquity_type`, `datetime`, `coordinates`, `house_system`, `node_type`)
- `aspects`: Array of qualifying aspects, sorted by orb ascending. Each entry has `body_a`, `body_b`, `aspect`, `category` (`major`/`minor`), `aspect_angle`, `separation`, `orb`, `orb_allowed`, and `applying` (`true`/`false`/`null` — `null` when applying/separating cannot be determined, e.g. angle points with no speed, near-stationary bodies, or an exact hit).
- `declination_aspects` (only present when `include_declination_aspects` is `true`): Array of parallel/contraparallel contacts by declination — see [Declination Aspects](#declination-aspects).
- `settings_used`: The resolved settings (`include_minor_aspects`, `include_angles`, `include_south_node`, `include_vertex`, `include_declination_aspects`, `declination_orbs`, `declination_bodies`, `bodies`, `orb_overrides`, `orb_model`, `node_type`) actually applied to the calculation.

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

Search a UTC window for time-domain astrological events: aspect contacts, planetary stations, sign and house ingresses, and lunations. Where `calculate_transits`/`calculate_secondary_progressions` answer "is this happening right now/at this instant," `find_events` answers "when."

Correctness comes from segmenting the search window at the moving side's own stations (points where its longitude stops being monotone) and then enumerating every target longitude crossed within each resulting monotone segment. That guarantees every exact pass is found — missing one would require missing a station, not missing a sample between two scan points. A coarse step only has to bracket those stations, which it does with wide margin even for the fastest-stationing body (Mercury, ~21-day retrograde periods at the transit rate).

**`rate`** (string, optional): `"transit"` (default) or `"secondary_progression"`.

- `"transit"`: the moving side is transiting bodies at their real ephemeris position — everything below describes this rate unless a row says otherwise.
- `"secondary_progression"`: the moving side is the day-for-a-year progressed chart instead, feeding the exact same search engine `calculate_secondary_progressions` computes from — progressed positions here match that tool exactly for the same `(birth_datetime, latitude, longitude, angle_method, house_frame)`, at every body and angle, to within floating-point precision. Several defaults invert relative to `"transit"` because the volume/orb arguments that produced the transit-rate defaults flip at a day-for-a-year pace — see the per-parameter notes below. `angle_method`/`house_frame` require this rate and error otherwise. `window_start` earlier than `birth_datetime` also errors (that's arithmetically a *converse* progression — a distinct technique this server doesn't offer yet, not something to compute silently).

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `latitude` (number): Birth latitude in decimal degrees
- `longitude` (number): Birth longitude in decimal degrees, positive east
- `window_start` (string): Start of the UTC search window, ISO8601
- `window_end` (string): End of the UTC search window, ISO8601. Must be after `window_start`. A request longer than the per-rate cap is clamped rather than rejected — see `window.truncated` on the result. Cap is 10 years at `"transit"`, 120 years at `"secondary_progression"` (a progressed query is inherently lifetime-scale — 10 years of window is 10 degrees of progressed Sun motion, nowhere near enough to answer anything the technique is used for).
- `event_types` (array of strings, optional): Which categories to search — `"aspect"`, `"station"`, `"sign_ingress"`, `"house_ingress"`, `"lunation"`. Default: all five, at either rate. `"aspect"` populates `contacts[]`; the rest populate `events[]`. Eclipse annotation is the one thing without a progressed analogue, and that's a field on `"lunation"`, not a category of its own — see below.
- `angle_method` (string, optional): Requires `rate: "secondary_progression"`. Same meaning/default (`"solar_arc"`) as `calculate_secondary_progressions`. Echoed as `settings_used.angle_method_used`.
- `house_frame` (string, optional): Requires `rate: "secondary_progression"`. Same meaning/default (`"progressed"`) as `calculate_secondary_progressions`. Under `"progressed"`, `house_ingress` cusps move with the progressed chart too, and the search is composed as a relative provider over `body(t) - cusp(t)` (the same pattern lunations use for the Sun-Moon relative longitude) — `direction` reflects the sign of that *relative* rate, not the body's own speed, since a body can be direct while what's actually closing the gap is the cusp. Under `"natal"`, `house_ingress` uses the fixed birth chart cusps, same as `"transit"`. Echoed as `settings_used.house_frame_used`.
- `house_system` (string, optional): House system code applied to the natal chart and to `house_ingress`. Default `P`. See [House Systems](#house-systems).
- `bodies` (array of strings, optional): The MOVING side. Default depends on `rate`. At `"transit"`: Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron — the bodies slow enough to define forecasting "chapters" rather than trigger them. **The transiting Moon is excluded from the default** because it alone accounts for over 70% of a full year's output (roughly 21.7x the rest of the default scope combined). At `"secondary_progression"`: Sun, Moon, Mercury, Venus, Mars — inverted, because the progressed Moon (~13.29°/yr) *is* the technique, while an outer planet moves only a few degrees across an entire lifetime by progression. Either way the rest are still reachable by explicit request. Angle bodies and the Vertex can never appear here at either rate — at `"secondary_progression"` the progressed Ascendant/Midheaven are reached via `include_angles` instead (see below), not `bodies`. This list governs `contacts[]` and `sign_ingress`/`house_ingress` events. `station` events are the one exception: at `rate: "secondary_progression"` they always search the fixed 13-body station-capable set (Sun, Moon, Lilith and North Node never emit one — the Sun and Moon never reverse, Lilith is always direct by construction, and the true Node reverses direction roughly 350 times a year from orbital wobble, which is jitter, not a station) **independent of `bodies`** — a body stations at most 0-2 times in a lifetime by progression, so volume was never the constraint that shaped `bodies`' default, and this is what lets the progressed default (which excludes every outer planet) coexist with real outer-planet progressed stations. At `rate: "transit"` station search is narrowed to `bodies ∩` the station-capable set, same as before this PR.
- `targets` (array of strings, optional): The NATAL side. Default: the same 17-body list as `calculate_transits` (Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta), at either rate. Ascendant/Midheaven/Part of Fortune behind `include_angles`, Vertex behind `include_vertex`, South Node behind `include_south_node` — same gating as `calculate_transits`/`calculate_aspects`.
- `include_minor` (boolean, optional): Include minor aspects in `contacts[]`. Default `false` at either rate — deliberately identical to `calculate_aspects`/`calculate_transits`, so an aspect visible in a snapshot tool is never unsearchable here.
- `include_angles` (boolean, optional): Default depends on `rate`: `false` at `"transit"`, `true` at `"secondary_progression"` (matching `calculate_secondary_progressions` — progressed angle contacts are this rate's headline output). At `"transit"`, adds natal Ascendant/Midheaven/Part of Fortune as targets. At `"secondary_progression"`, **also** adds progressed Ascendant/Midheaven as MOVING-side sources for `contacts[]` (never as `bodies`/station/ingress sources) alongside the natal-side addition — matching `calculate_secondary_progressions`' own asymmetry, including that progressed Part of Fortune is never a source (which day/night formula applies to a progressed sect is unsettled).
- `include_south_node` (boolean, optional): Include natal South Node as a target. Default `false`.
- `include_vertex` (boolean, optional): Include natal Vertex as a target. Default `false`, independent of `include_angles`.
- `lunation_phases` (string, optional): Which band starts of the Sun-Moon soli-lunar cycle to emit as `lunation` events, each a strict superset of the last — `"syzygy"` (New, Full — 2/cycle), `"quarters"` (+ First Quarter, Last Quarter — 4/cycle), `"eight_phase"` (+ Crescent, Gibbous, Disseminating, Balsamic — 8/cycle, the full Rudhyar-lineage cycle `calculate_planetary_positions`' phase field already names). Every event kept from one set to the next carries an identical `phase` **and** `datetime` — the wider sets only add events, they never rename or re-time one. Default depends on `rate`: `"syzygy"` at `"transit"` (New/Full alone already run ~25/yr; the full cycle runs ~99/yr with comparatively little added signal for a forecasting scan), `"eight_phase"` at `"secondary_progression"` (the progressed lunation cycle is conventionally read by phase — including Balsamic, among the most-cited progressed phase readings — and even at eight phases a 90-year window yields only ~24 total, up from SUP-357's original `"quarters"` default of ~12). Independent of `include_minor`: phase events are exact crossings with no orb, not aspect contacts, even though 45°/135° also happen to be minor aspect angles. Echoed as `settings_used.lunation_phases`, alongside `settings_used.lunation_phase_scheme` (the banding convention — see `lib/moon-phase.js`'s `PHASE_SCHEME`).
- `include_quarter_moons` (boolean, optional, **deprecated** — use `lunation_phases`): Include First/Last Quarter alongside New/Full Moon in `lunation` events. `true` aliases to `lunation_phases: "quarters"`, `false` aliases to `lunation_phases: "syzygy"`. Supplying both `include_quarter_moons` and `lunation_phases` is an error rather than a silent precedence rule. Kept indefinitely for backward compatibility.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `contacts[]`. Same flat/per-class/moiety shapes as `calculate_transits` (see its `orb_overrides`/`orb_model` description above). `orb_model: "fixed"` takes flat aspect-name keys only — same shape as `"class"` minus the per-class nesting.
- `orb_model` (string, optional): `"class"`, `"moiety"`, or `"fixed"`. Default depends on `rate`: `"moiety"` at `"transit"`, `"fixed"` at `"secondary_progression"`. `"fixed"` is a flat 1° for major aspects / 0.5° for minors, independent of which bodies/points are involved — the progressed default inverts because a transit-scaled orb table leaves an outer-planet progressed contact "in orb" for centuries (a moiety-orb progressed Jupiter contact can span the entire search window with room to spare). See [Orb Models](#orb-models).
- `include_pair_aspects` (boolean, optional, SUP-361): Opt in to two-moving-body aspect search — e.g. progressed Venus conjunct progressed Mars, or transiting Jupiter square transiting Saturn — reported in `pair_contacts[]` (see below). Default `false` at either rate. Requires `event_types` to include `"aspect"`; there is no separate event category for these (same reasoning as `lunation_phases` not being its own category).
- `pair_bodies` (array of strings, optional, SUP-361): Which bodies' **unordered pairs** to search when `include_pair_aspects` is `true` — e.g. `["Sun","Moon","Mars"]` searches Sun-Moon, Sun-Mars, and Moon-Mars (3 pairs from 3 bodies). **Independent of `bodies`**: `bodies` is the moving-to-natal set and also drives `sign_ingress`/`house_ingress`, so narrowing it (e.g. to `["Moon"]` for a clean ingress timeline) must not silently zero out pairs, and widening it (e.g. to the outer planets) must not silently add 21 frozen pair rows. Default matches `bodies`' own rate-keyed default regardless of what `bodies` was actually set to: Sun, Moon, Mercury, Venus, Mars (10 pairs) at `"secondary_progression"`, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron (21 pairs) at `"transit"`. Ascendant/Midheaven are valid members — reachable the same way `calculate_aspects` can emit an Ascendant-Midheaven contact under `include_angles` — but only produce a pair at `rate: "secondary_progression"` with `include_angles` true; pairs inherit that gate and are silently dropped otherwise (not an error), same as the exclusions below. They're deliberately left out of the default set: each Ascendant/Midheaven sample is far more expensive than a real body's (a `swetest -house` spawn per query through `progressedFrameAt`), so reaching them takes an explicit request. Two pairs are always excluded regardless of `pair_bodies`, silently rather than as an error — visible via `settings_used.pairs_searched`, the pair list actually eligible after exclusions:
  - **(Sun, Midheaven) whenever both are progressed**, at either `angle_method`. Under `"solar_arc"` the progressed Midheaven is *defined* as `natalMC + (progressedSun − natalSun)`, so their relative separation is `natalSun − natalMC` — a lifelong constant, for every chart. Under `"naibod"` it isn't exactly constant but changes only ~0.02°/yr, not meaningfully better. Either way this would report a *natal* fact as a lifelong progressed event, not a real progression.
  - **The lunar nodes, unconditionally.** The true Node (this tool's only `node_type`) reverses direction from orbital wobble roughly once a year of progressed life, and a pair's rate is a *difference* of two rates — that jitter flips the relative rate's sign against any slower partner and shreds segmentation into a burst of spurious passes.

  Progressed Part of Fortune is never reachable at all here (same as `bodies`) — it isn't a valid `pair_bodies` name, so requesting it errors rather than silently doing nothing; which day/night formula applies to a progressed sect is unsettled, and a pair search must not become the back door that reintroduces it.

**Returns:**
- `window`: `{ start, end, truncated }` — the search window actually used. `truncated` is `true` when the request exceeded the per-rate cap and `end` was clamped.
- `contacts[]`: Aspect **periods**, one row per orb episode of a (moving body, natal point, aspect) triple, sorted by `enters_orb` ascending. A moving body can enter and leave a natal point's orb more than once within a wide window (an outer planet's retrograde loop is the common transit-rate case), so the same triple can appear as more than one row — each with its own `enters_orb`/`leaves_orb`/`passes`/`closest_approach`. Fields: `transiting_body` (the progressed body/angle name at `rate: "secondary_progression"` — one key at either rate, disambiguated by `settings_used.rate`, not a per-mode rename), `natal_point`, `aspect`, `category`, `aspect_angle`, `orb_allowed`, `enters_orb`, `leaves_orb`, `enters_orb_truncated`/`leaves_orb_truncated` (`true` when that boundary is the window edge rather than a found crossing), `passes[]` (every exact hit within the episode — `datetime`, `longitude`, `sign`, `degree`, `speed`, `retrograde`; may legitimately be empty when a body stations within orb and never perfects), `closest_approach` (`{ datetime, orb, stationary }`), `birth_time_sensitive` (see below), and — only at `rate: "secondary_progression"`, and only when `birth_time_sensitive` is `true` — `date_uncertainty_days_per_birth_minute` (see below). Unlike `calculate_transits`/`calculate_synastry`, `orb`/`orb_allowed`/`aspect_angle`/longitude values here are numbers, not `.toFixed(2)` strings.
- `pair_contacts[]` (SUP-361): Two-moving-body aspect **periods** — e.g. progressed Venus conjunct progressed Mars — populated only when `include_pair_aspects` is `true` (otherwise always `[]`, distinguishable from "the feature ran and found nothing" via `settings_used.include_pair_aspects`). Same episode shape as `contacts[]` (`aspect`, `category`, `aspect_angle`, `orb_allowed`, `enters_orb`, `leaves_orb`, `enters_orb_truncated`/`leaves_orb_truncated`, `passes[]`, `closest_approach`, `birth_time_sensitive`), sorted by `enters_orb` ascending, with three differences because a pair contact has **no natal point**:
  - Keyed `body_a`/`body_b` instead of `transiting_body`/`natal_point` — the repo's existing vocabulary for a same-chart pair (`calculate_aspects`' own `body_a`/`body_b`). Reflects `pair_bodies`' list order (whichever member came first), not which body is moving faster.
  - `faster_body`: which of `body_a`/`body_b` was treated as the faster body when composing the directed relative separation (see below) — by *mean* rate over the whole window, not instantaneous, since two bodies can trade relative speed mid-window (Mercury and Venus do, by progression). Sun-Moon always comes out as Moon faster, matching `lunation`/`lib/moon-phase.js`'s own Moon-minus-Sun convention with no special case — this is what makes the identity in the next section hold exactly.
  - Each `passes[]` entry carries `datetime`, `body_a` and `body_b` (each `{ longitude, sign, degree, speed, retrograde }`) — **each body's own** absolute position/speed/direction at the pass instant, re-read from that body's own provider, never the relative separation's. A relative provider's longitude is a *separation*, not a position, and its speed sign says only whether the gap is opening or closing, not either body's own direction — reporting those directly would be a well-formed but meaningless position (a Venus-Mars contact at 46.89° of separation is not "Taurus 16.89°"), and a coin-flip `retrograde` decided purely by which name happened to be subtracted first (composing Moon−Sun makes every Sun-Moon pass `retrograde: false`; composing Sun−Moon makes the same twelve passes `retrograde: true`).

  `birth_time_sensitive` is `true` only when `body_a` or `body_b` is the progressed Ascendant/Midheaven — **a pair of two real bodies is never birth-time sensitive** (neither position depends on the birth clock, only the birth *date* through the day-for-a-year map), unlike a `contacts[]` row against a natal Ascendant/Midheaven/Part of Fortune/Vertex target. When it is sensitive, `date_uncertainty_days_per_birth_minute` is computed off the pair's own *relative* rate at the contact (see below), not either body's absolute speed — a pair's date sensitivity depends on how fast the gap between the two points is closing.
- `events[]`: Everything else — stations, ingresses, and lunations — sorted by `datetime` ascending. Every entry has `type` and `datetime`:
  - `station`: `body`, `direction` (`"direct"`/`"retrograde"`), `longitude`, `sign`, `degree`, `speed`, and `natal_contacts[]` (`{ natal_point, aspect, orb }` for every natal point within orb of the station's degree at that instant — reported unconditionally). At `rate: "secondary_progression"`, `speed` is degrees per day of *target* (life) time, not ephemeris time — consistent units with `"transit"`, so a consumer never has to branch on rate to interpret it.
  - `sign_ingress`: `body`, `direction`, `from_sign`, `to_sign`, `longitude`. Every crossing of a 30° boundary is reported, including retrograde re-ingress.
  - `house_ingress`: `body`, `direction`, `from_house`, `to_house`, `cusp_longitude`, `house_system`, `coincides_with_sign_ingress`, and `birth_time_sensitive: true` (unconditionally, at either rate — natal cusps are as birth-time-derived as the Ascendant is). At `rate: "secondary_progression"` it also carries `date_uncertainty_days_per_birth_minute`. Computed against the natal chart's own house cusps at `rate: "transit"` (never the transiting moment's own, which rotates roughly once every 24 hours and answers a different question) or under `house_frame: "natal"`; against the *moving* progressed cusps under the default `house_frame: "progressed"` at the progressed rate. Under Whole Sign every house cusp sits exactly on a sign boundary, so every `house_ingress` coincides with a `sign_ingress` for the same body at the same instant; `coincides_with_sign_ingress` makes that explicit.
  - `lunation`: `phase` — one of `"new"`, `"crescent"`, `"first_quarter"`, `"gibbous"`, `"full"`, `"disseminating"`, `"last_quarter"`, `"balsamic"`, gated by `lunation_phases` (see above) — `longitude`, `sign`, `degree`, `natal_contacts[]` (same shape as a station's), and — **at `rate: "transit"` only** — an optional `eclipse` block, absent (not `null`) on a non-eclipse lunation (and structurally absent on every phase besides `"new"`/`"full"` — a quarter or eighth-phase event is not a syzygy and has no eclipse analogue). At `rate: "secondary_progression"` the `eclipse` key never appears on any lunation, structurally rather than by always being empty: there is no progressed analogue of a physical eclipse shadow, so eclipse annotation isn't run at all rather than run and found to match nothing. When present (transit rate), `eclipse` carries `eclipse_type`, `magnitudes`, `saros_series`, `saros_number`, and `maximum_datetime` (the moment of greatest eclipse — a different instant from the lunation's own `datetime`, the exact syzygy). `lunation` covers the whole soli-lunar cycle, not just syzygies — a quarter or eighth-phase event is still a `type: "lunation"` row, not a separate `event_types` category (see `lunation_phases` above).
- `settings_used`: The resolved settings actually applied — `event_types`, `rate`, `bodies`, `targets`, `house_system`, `orb_model`, `orb_overrides`, `include_minor_aspects`, `include_angles`, `include_south_node`, `include_vertex`, `include_quarter_moons` (deprecated, derived: `true` whenever `lunation_phases` resolved to `"quarters"` or `"eight_phase"`), `lunation_phases`, `lunation_phase_scheme` (the banding convention that produced the phase names — see `lib/moon-phase.js`'s `PHASE_SCHEME`), `node_type` (always `"true"` — this tool's engine has no `node_type` parameter of its own yet), `include_pair_aspects`, `pair_bodies` (the resolved list, whether defaulted or requested), and `pairs_searched` (SUP-361: the unordered pairs of `pair_bodies` actually eligible after §4's exclusions, `{ body_a, body_b }` each — populated regardless of `include_pair_aspects`, so a caller can tell an excluded pair from a pair that ran and produced nothing before ever turning the feature on). At `rate: "secondary_progression"` it additionally carries `angle_method_used`, `house_frame_used`, and `year_length_days` (the tropical year length, 365.2422, used to derive the day-for-a-year mapping — matching `calculate_secondary_progressions`).

**`birth_time_sensitive`:** every contact whose `natal_point` is Ascendant, Midheaven, Part of Fortune or Vertex carries `birth_time_sensitive: true` at either rate; at `rate: "secondary_progression"` a contact whose *moving* side is the progressed Ascendant/Midheaven also carries it (both sides can be sensitive at once — e.g. progressed Ascendant to natal Midheaven — in which case the uncertainty below reflects both). These are the class of point whose *dates* (not just positions) carry meaningful birth-time error: the Ascendant advances roughly 1° every 4 minutes of clock time.

**`date_uncertainty_days_per_birth_minute`** (`rate: "secondary_progression"` only, on `contacts[]`, `pair_contacts[]`, and `house_ingress` events, only when `birth_time_sensitive` is `true`): a quantified version of the same idea, needed because the flat boolean understates it badly at this rate — roughly three orders of magnitude worse than at `"transit"`. A 10-minute birth-time uncertainty is on the order of 2.5° of Ascendant either way, but at the transit rate that shifts an outer-planet contact date by months, while at the progressed rate **one degree of angle error is about one year of date error** (measured: a 4-minute birth-time shift moves the progressed Ascendant/Midheaven date by 83-120 days per minute of birth-time uncertainty, depending on the point and where in the chart it's evaluated). The field is `(degrees that point shifts per minute of birth time) / |relative rate at the contact, °/day of target time|`, evaluated at the contact's own instant — not a single fixed reference — because a progressed point's rate is not constant over a lifetime (the progressed Ascendant's rate in particular can vary by a factor of two or more from birth to old age, unlike the progressed Sun/Midheaven, whose rate barely moves). On a `pair_contacts[]` row, "relative rate" means the pair's own relative rate at the contact — how fast the gap between `body_a` and `body_b` is closing — not either body's absolute speed.

**The progressed Sun-Moon overlap with `lunation` is deliberate, not a duplicate to prune (SUP-361 §6).** With `include_pair_aspects` and `event_types` including both `"aspect"` and `"lunation"` at `rate: "secondary_progression"`, progressed Sun conjunct progressed Moon appears in *both* `pair_contacts[]` and as a `lunation` event with `phase: "new"` — and every conjunction/opposition/square pass in the Sun-Moon `pair_contacts[]` row reproduces a `lunation` event's `datetime` to the second (with `lunation_phases: "eight_phase"` and `include_minor: true`, the identity extends to all eight phases: semisquare passes reproduce `crescent`/`balsamic`, sesquiquadrate passes reproduce `gibbous`/`disseminating`). Neither view subsumes the other:
- `lunation` carries the *directed* phase — a pair aspect is undirected, and `find_events` searches both sides of every non-0/180° angle under one canonical label, so a single `square` row cannot distinguish `first_quarter` (waxing) from `last_quarter` (waning), and a single `semisquare` row cannot distinguish `crescent` from `balsamic` — exactly the waxing/waning collapse the eight-phase cycle exists to prevent.
- `pair_contacts[]` carries the *orb envelope* — `enters_orb`/`leaves_orb`/`closest_approach` — which a `lunation` event has no field for. "How long is my progressed Full Moon in effect" is only answerable from the aspect row.
- The pair search also returns sextile, trine, semisextile, quincunx, quintile, and biquintile Sun-Moon contacts, none of which have lunation-phase vocabulary at all.

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

### Declination Aspects

A **parallel** (both bodies at the same declination) reads with roughly conjunction force; a **contraparallel** (equal declination, opposite hemispheres) reads with roughly opposition force. Both are invisible in ecliptic longitude — two bodies can be a parallel with no longitude aspect between them at all, which is the entire reason this feature exists (see the worked example below).

Opt in with `include_declination_aspects: true` on `calculate_planetary_positions`, `calculate_aspects`, `calculate_transits`, and `calculate_synastry`. Default `false`; when unset, `declination_aspects` is simply absent from the result. On the three aspect tools, `settings_used` still echoes the resolved settings unconditionally, matching `include_vertex`; `calculate_planetary_positions` has no `settings_used` block to echo into.

**Orb: a flat 1° for both parallel and contraparallel** — the mainstream Western default (Solar Fire, Astro Gold, astro.com). Contraparallel intentionally takes the same orb as parallel, matching how this server already treats conjunction/opposition as equal-orb pairs in every longitude orb class. The 1°30′ luminary widening some schools use is a real minority convention, not the default here — reach it via `orb_overrides: {"declination": {"parallel": 1.5, "contraparallel": 1}}`. This is its own orb table, independent of `orb_model` (`"moiety"` vs `"class"` is a longitude concept and never changes a declination orb) and independent of every longitude orb class (`body`/`angle`/`derived`) — an override to one never touches the other.

**Bodies: 16, not the full 17** — every body in the default aspect list except the **North Node**:

> Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Lilith, Chiron, Ceres, Pallas, Juno, Vesta

The rule: a declination contact is only reported between points whose declination is an independently computed physical datum. The Node's ecliptic latitude is exactly zero by definition, so its declination is fully determined by its longitude (`declination = arcsin(sin(obliquity) × sin(longitude))`) — a "parallel" to it would just restate a longitude fact under a declination label, not report a real contact. Its declination is still reported on the body itself (see [Features](#features)); it simply never participates in `declination_aspects`. `bodies` filters this 16-body set the same way it filters the longitude set (the Node drop is unconditional and not overridable); the resolved set is always echoed as `settings_used.declination_bodies`.

**Angles never form declination aspects** — Ascendant, Midheaven, IC, Descendant, Vertex, and Part of Fortune still carry a `declination` field (positional output), but never appear in `declination_aspects`, with or without `include_angles`/`include_vertex`. Every angle sits on the ecliptic by construction (latitude 0), so the same restatement-of-longitude problem as the Node applies — and it's worse: `IC = Midheaven + 180°` and `Descendant = Ascendant + 180°` means their declinations are exact negations, so aspecting all four would report `Ascendant contraparallel Descendant` and `Midheaven contraparallel IC` at orb exactly 0°, a mirror double-count with no astrological meaning.

**`applying` is always `null`.** Declination rate is not longitude rate — a body direct in longitude can be moving north or south in declination depending on where it sits relative to the solstices, and its declination rate passes through zero at the solstitial points regardless of its longitude speed. Deriving applying/separating from longitude speed would therefore be confidently wrong rather than merely approximate, so this server doesn't do it. Computing a real declination-based `applying` would need a second ephemeris sample and is a documented future improvement, not implemented here.

**Row shape** (`calculate_aspects`; `calculate_transits`/`calculate_synastry` rename the body keys, see below):

```jsonc
{
  "body_a": "Mercury",
  "body_b": "Vesta",
  "aspect": "parallel",       // "parallel" | "contraparallel"
  "declination_a": -20.3919084,
  "declination_b": -19.4967293,
  "orb": 0.8951791,           // |δa − δb| for parallel, |δa + δb| for contraparallel
  "orb_allowed": 1,
  "applying": null            // always null - see above
}
```

No `category` (major/minor has no declination analogue) and no `separation`/`exact_angle` (the separation *is* the orb). `calculate_transits` uses `transiting_body`/`natal_body`; `calculate_synastry` uses `person1_planet`/`person2_planet`. Unlike `aspects`/`transit_aspects`/`synastry_aspects`, `orb`/`declination_a`/`declination_b` are always numbers, never `.toFixed(2)` strings.

A pair can report *both* a parallel and a contraparallel at once — that happens only when both bodies sit within about half the orb of the celestial equator, and it's correct, not a bug (e.g. two bodies each within half a degree of 0° declination are simultaneously ~parallel to each other and ~contraparallel to each other's mirror across the equator).

**Worked example:** on a reference chart, Mercury and Vesta sit 21.77° apart in longitude — no longitude aspect at all, at any orb this server offers. But Mercury's declination is −20.39° and Vesta's is −19.50°, a difference of 0.90° — well inside the 1° parallel orb. `include_declination_aspects: true` surfaces that contact; without it, this server would report these two bodies as unrelated.

### Orb Models

`orb_model` selects how a pair's allowed orb (the maximum separation from exact still counted as an aspect) is derived. There is **no single canonical orb table** in the astrological tradition — different schools and authors disagree, sometimes widely. This server offers three internally-consistent conventions rather than presenting any one as definitive:

- **`moiety` (default for most tools):** each body/point has its own half-orb ("moiety"). A pair's orb is `(moietyA + moietyB) * multiplier[aspect]` — e.g. Sun (7.5°) conjunct Moon (6°) allows (7.5+6)×1.0 = 13.5°. `orb_overrides` in this mode takes a different two-knob shape instead of the `class`-mode shape: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}` — `moieties` keys are body/point names, `multipliers` keys are aspect names.
- **`class`:** a fixed per-class orb table (`body`/`angle`/`derived`, shown per-tool above), independent of which two bodies are involved. `orb_overrides` in this mode takes the flat (`{"conjunction": 10}`) or per-class (`{"angle": {"square": 4}}`) shape.
- **`fixed`** (`find_events` only, default there at `rate: "secondary_progression"`): a single flat orb per aspect — 1° for conjunction/opposition/trine/square/sextile, 0.5° for the minors — independent of which bodies/points are involved, no per-class distinction at all. `orb_overrides` in this mode takes only the flat shape (`{"conjunction": 0.5}`), since there's no class to nest under. This exists because `moiety`/`class` are both scaled for transit-speed volume: a moiety-orb progressed Jupiter contact to a natal point can stay "in orb" for centuries, which isn't a tuning preference at the progressed rate, it's meaningless output.

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