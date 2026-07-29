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
- `include_angles` (boolean, optional): Include the NATAL chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in `transit_aspects`. Transiting angles are always excluded, even if requested via `bodies`: they are artifacts of the moment's location and time of day (the transiting Ascendant sweeps the whole zodiac daily), so transit-side angle contacts change minute to minute and carry no meaning. Default `false`.
- `include_south_node` (boolean, optional): Include South Node in `transit_aspects`. Default `false`.
- `bodies` (array of strings, optional): Override the default body list for `transit_aspects`. Angle bodies are always excluded from the transiting side, even if listed here.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees for `transit_aspects`. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults.
- `orb_model` (string, optional): Orb resolution model for `transit_aspects`. `"moiety"` (default) sums each body's half-orb (e.g. Sun 7.5°, Moon 6°) and scales by the aspect's multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}`. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect.

**Returns:**
- `natal_chart`: Complete birth chart data
- `current_transits`: Current planetary positions
- `transit_aspects`: Array of aspects from transiting bodies to the natal chart, sorted by orb ascending. Each entry has `transiting_body`, `natal_body`, `aspect`, `category`, `orb`, `exact_angle`, `applying`.
- `settings_used`: The resolved settings (including `orb_model`) actually applied to `transit_aspects`.
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
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults.
- `orb_model` (string, optional): Orb resolution model. `"moiety"` (default) sums each body's half-orb and scales by the aspect's multiplier — see `calculate_aspects` below for the formula and an example. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}`. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect.

**Returns:**
- `person1_chart`: Complete birth chart for person 1
- `person2_chart`: Complete birth chart for person 2
- `synastry_aspects`: Array of planetary aspects between the charts
- `house_overlay`: `{ person1_planets_in_person2_houses, person2_planets_in_person1_houses }` — for each of the 10 major bodies, which house (1-12) of the other person's chart it falls into
- `angle_aspects` (only present when `include_angles` is `true`): Array of aspects involving Ascendant/Midheaven/Part of Fortune across the two charts, same shape as `synastry_aspects` but with `person1_point`/`person2_point` instead of `_planet`. IC and Descendant are not separately aspected — see [Angle Aspects](#angle-aspects) for why, and how to derive their contacts from this array.
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
- `bodies` (array of strings, optional): Override the default aspect body list. Must be names known to the server.
- `orb_overrides` (object, optional): Per-aspect orb overrides in degrees, e.g. `{"conjunction": 10}`. Also accepts a per-class shape, e.g. `{"angle": {"square": 4}}` or `{"derived": {"square": 2}}`, to move only the `angle` class (Ascendant/Midheaven/IC/Descendant) or `derived` class (Part of Fortune, Vertex) without touching `body`. `angle` defaults to 5/4/3/1.5/1.5/1 deg (conjunction-opposition/square/trine-sextile/semisextile-quincunx/semisquare-sesquiquadrate/quintile-biquintile); `derived` defaults to 3/2/2/1 deg (conjunction-opposition/square/trine-sextile/all minors) — both tighter than `body`'s defaults.
- `orb_model` (string, optional): Orb resolution model. `"moiety"` (default) sums each body's half-orb (per-body table, e.g. Sun 7.5°, Moon 6°, Ascendant 2.5°) and scales by the aspect's multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under `"moiety"`, `orb_overrides` takes a different two-knob shape instead: `{"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}` — `moieties` keys are body/point names, `multipliers` keys are aspect names. `"class"` instead uses the fixed per-class tables above and honors `orb_overrides`. See [Orb Models](#orb-models) for moiety provenance and why sextile stays a major aspect.
- `house_system` (string, optional): House system code. Default `P`. See [House Systems](#house-systems).

**Returns:**
- All fields from `calculate_planetary_positions` (`planets`, `houses`, `chart_points`, `additional_points`, `datetime`, `coordinates`, `house_system`)
- `aspects`: Array of qualifying aspects, sorted by orb ascending. Each entry has `body_a`, `body_b`, `aspect`, `category` (`major`/`minor`), `aspect_angle`, `separation`, `orb`, `orb_allowed`, and `applying` (`true`/`false`/`null` — `null` when applying/separating cannot be determined, e.g. angle points with no speed, near-stationary bodies, or an exact hit).
- `settings_used`: The resolved settings (`include_minor_aspects`, `include_angles`, `include_south_node`, `bodies`, `orb_overrides`, `orb_model`) actually applied to the calculation.

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