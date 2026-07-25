# Swiss Ephemeris MCP Server

A Model Context Protocol (MCP) server that provides astronomical calculations using the Swiss Ephemeris library. Calculate planetary positions, houses, chart points, and asteroids for any date and location.

## Features

- **Planetary Positions**: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto
- **Lunar Nodes**: True and Mean Node calculations
- **Asteroids**: Chiron, Ceres, Pallas, Juno, Vesta, Lilith
- **Houses**: 12-house system using Placidus
- **Chart Points**: Ascendant, Midheaven, IC, Descendant
- **Additional Points**: South Node, Part of Fortune
- **Speed**: Every planet now includes a `speed` field (deg/day, signed, negative = retrograde)
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

The server provides five main tools:

### `calculate_planetary_positions`

Calculate astronomical data for a specific date, time, and location.

**Parameters:**
- `datetime` (string): ISO8601 format, e.g., "1985-04-12T23:20:50Z"
- `latitude` (number): Latitude in decimal degrees (-90 to 90)
- `longitude` (number): Longitude in decimal degrees (-180 to 180)
- `house_system` (string, optional): House system code. Default `P`. See [House Systems](#house-systems).

**Returns:**
- `planets`: Positions of all planets and celestial bodies
- `houses`: 12 astrological houses
- `chart_points`: Ascendant, Midheaven, IC, Descendant
- `additional_points`: South Node, Part of Fortune — computed with the traditional day-chart formula (`Ascendant + Moon - Sun`) when the Sun is in houses 7-12, or the night-chart formula (`Ascendant + Sun - Moon`) when the Sun is in houses 1-6.
- `house_system`: The house system code actually used
- `warnings` (only present if something's missing): if an ephemeris data file needed for a body isn't found under `SE_EPHE_PATH`, that body is omitted from `planets` entirely rather than reported at a fabricated 0° Aries position, and a message naming the missing file is added here.

### `calculate_transits`

Calculate birth chart positions and current transits for comparison, including aspects from transiting bodies to the natal chart.

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `latitude` (number): Birth latitude in decimal degrees
- `longitude` (number): Birth longitude in decimal degrees
- `house_system` (string, optional): House system code applied to both charts. Default `P`. See [House Systems](#house-systems).
- `include_minor` (boolean, optional): Include minor aspects in `transit_aspects`. Default `false`.
- `include_angles` (boolean, optional): Include chart angles in `transit_aspects`. Default `false`.
- `include_south_node` (boolean, optional): Include South Node in `transit_aspects`. Default `false`.
- `bodies` (array of strings, optional): Override the default body list for `transit_aspects`.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `transit_aspects`.

**Returns:**
- `natal_chart`: Complete birth chart data
- `current_transits`: Current planetary positions
- `transit_aspects`: Array of aspects from transiting bodies to the natal chart, sorted by orb ascending. Each entry has `transiting_body`, `natal_body`, `aspect`, `category`, `orb`, `exact_angle`, `applying`.
- `settings_used`: The resolved settings actually applied to `transit_aspects`.
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
- `include_minor` (boolean, optional): Include minor aspects. Default `false`.
- `include_angles` (boolean, optional): Also compute `angle_aspects` (planet-to-angle and angle-to-angle contacts). Default `false`.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees.

**Returns:**
- `person1_chart`: Complete birth chart for person 1
- `person2_chart`: Complete birth chart for person 2
- `synastry_aspects`: Array of planetary aspects between the charts
- `house_overlay`: `{ person1_planets_in_person2_houses, person2_planets_in_person1_houses }` — for each of the 10 major bodies, which house (1-12) of the other person's chart it falls into
- `angle_aspects` (only present when `include_angles` is `true`): Array of aspects involving Ascendant/Midheaven/IC/Descendant across the two charts, same shape as `synastry_aspects` but with `person1_point`/`person2_point` instead of `_planet`
- `calculation_time`: Timestamp of calculation

### `calculate_aspects`

Calculate natal chart aspects for a given datetime and coordinates. Returns planetary positions plus all qualifying aspects with orb, applying/separating status, and category.

**Parameters:**
- `datetime` (string): ISO8601 format, e.g., "1985-04-12T23:20:50Z"
- `latitude` (number): Latitude in decimal degrees (-90 to 90)
- `longitude` (number): Longitude in decimal degrees (-180 to 180)
- `include_minor` (boolean, optional): Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile). Default `false`.
- `include_angles` (boolean, optional): Include chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in aspect calculations. Default `false`.
- `include_south_node` (boolean, optional): Include South Node in aspect calculations. Default `false`.
- `bodies` (array of strings, optional): Override the default aspect body list. Must be names known to the server.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees, e.g. `{"conjunction": 10}`.
- `house_system` (string, optional): House system code. Default `P`. See [House Systems](#house-systems).

**Returns:**
- All fields from `calculate_planetary_positions` (`planets`, `houses`, `chart_points`, `additional_points`, `datetime`, `coordinates`, `house_system`)
- `aspects`: Array of qualifying aspects, sorted by orb ascending. Each entry has `body_a`, `body_b`, `aspect`, `category` (`major`/`minor`), `aspect_angle`, `separation`, `orb`, `orb_allowed`, and `applying` (`true`/`false`/`null` — `null` when applying/separating cannot be determined, e.g. angle points with no speed, near-stationary bodies, or an exact hit).
- `settings_used`: The resolved settings (`include_minor_aspects`, `include_angles`, `include_south_node`, `bodies`, `orb_overrides`) actually applied to the calculation.

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