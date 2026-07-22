# Swiss Ephemeris MCP Server

A Model Context Protocol (MCP) server that provides astronomical calculations using the Swiss Ephemeris library. Calculate planetary positions, houses, chart points, and asteroids for any date and location.

## Features

- **Planetary Positions**: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto
- **Lunar Nodes**: True and Mean Node calculations
- **Asteroids**: Chiron, Ceres, Pallas, Juno, Vesta, Lilith
- **Houses**: 12-house system using Placidus
- **Chart Points**: Ascendant, Midheaven, IC, Descendant
- **Additional Points**: South Node, Part of Fortune
- **Speed**: Planetary position output (`calculate_planetary_positions`, `calculate_transits`, `calculate_solar_revolution`, `calculate_synastry`, `calculate_aspects`) now includes a `speed` field per planet (degrees/day, signed, negative = retrograde)
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

The server provides six main tools:

### `calculate_planetary_positions`

Calculate astronomical data for a specific date, time, and location.

**Parameters:**
- `datetime` (string): ISO8601 format, e.g., "1985-04-12T23:20:50Z"
- `latitude` (number): Latitude in decimal degrees (-90 to 90)
- `longitude` (number): Longitude in decimal degrees (-180 to 180)

**Returns:**
- `planets`: Positions of all planets and celestial bodies
- `houses`: 12 astrological houses
- `chart_points`: Ascendant, Midheaven, IC, Descendant
- `additional_points`: South Node, Part of Fortune

### `calculate_transits`

Calculate birth chart positions and current transits for comparison.

**Parameters:**
- `birth_datetime` (string): Birth datetime in ISO8601 format
- `latitude` (number): Birth latitude in decimal degrees
- `longitude` (number): Birth longitude in decimal degrees

**Returns:**
- `natal_chart`: Complete birth chart data
- `current_transits`: Current planetary positions
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

**Returns:**
- `person1_chart`: Complete birth chart for person 1
- `person2_chart`: Complete birth chart for person 2
- `synastry_aspects`: Array of planetary aspects between the charts
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
- `bodies` (array of strings, optional): Override the default aspect body list. Must be names known to the server. Default body set: `Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta`.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees, e.g. `{"conjunction": 10}`. Default orbs (degrees):

  | Aspect | Angle | Orb |
  |---|---|---|
  | conjunction | 0 | 8 |
  | opposition | 180 | 8 |
  | trine | 120 | 8 |
  | square | 90 | 8 |
  | sextile | 60 | 6 |
  | quincunx | 150 | 3 |
  | semisextile | 30 | 2 |
  | semisquare | 45 | 2 |
  | sesquiquadrate | 135 | 2 |
  | quintile | 72 | 2 |
  | biquintile | 144 | 2 |

**Returns:**
- All fields from `calculate_planetary_positions` (`planets`, `houses`, `chart_points`, `additional_points`, `datetime`, `coordinates`)
- `aspects`: Array of qualifying aspects, sorted by orb ascending. Each entry has `body_a`, `body_b`, `aspect`, `category` (`major`/`minor`), `aspect_angle`, `separation`, `orb`, `orb_allowed`, and `applying` (`true`/`false`/`null` — `null` when applying/separating cannot be determined, e.g. angle points with no speed, near-stationary bodies, or an exact hit).
- `settings_used`: The resolved settings (`include_minor_aspects`, `include_angles`, `include_south_node`, `bodies`, `orb_overrides`) actually applied to the calculation.

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