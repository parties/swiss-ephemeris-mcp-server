#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  formatDateToSwiss,
  formatTimeToSwiss,
  parsePlanetLine,
  parseHouseLine,
  parseChartPointLine,
} from './lib/swetest-parse.js';
import { moonPhase } from './lib/moon-phase.js';
import {
  DEFAULT_ASPECT_BODIES,
  ANGLE_BODIES,
  ASPECTABLE_ANGLES,
  MAJOR_ASPECTS,
  calculateNatalAspects,
  calculateCrossChartAspects,
  calculateHouseOverlay,
  toAspectBody,
  toPointPosition,
  resolveChartPoint,
  findHouseForLongitude,
  invalidOrbOverrideKeys,
  resolveAspectSettings,
  orbAllowedFor,
  ORB_MODELS,
} from './lib/aspects.js';
import {
  TROPICAL_YEAR_DAYS,
  computeElapsedYears,
  computeProgressedDate,
  formatProgressedDatetime,
  computeArcDegrees,
  computeFictitiousLongitude,
} from './lib/progressions.js';
import { jdFromDate, dateFromJd, seriesFor as ephemerisSeriesFor, positionAt as ephemerisPositionAt, eclipsesFor } from './lib/ephemeris-series.js';
import {
  scanTransitingBody,
  findContacts,
  findStations,
  findCrossings,
  findLunations,
  annotateEclipses,
  natalContactsFor,
  wrap180,
  mod360,
} from './lib/event-search.js';
import { progressedBodyProvider, progressedMcProvider, ephemerisJdForTarget } from './lib/progressed-provider.js';

function validateOrbModel(orbModel) {
  if (orbModel !== undefined && !ORB_MODELS.includes(orbModel)) {
    throw new McpError(ErrorCode.InvalidParams, `orb_model must be one of: ${ORB_MODELS.join(', ')}`);
  }
}

// Lunar Node type requested from swetest: "true" (default) is the osculating node, which
// wobbles and can reverse direction; "mean" is smoothed and moves monotonically retrograde.
// They differ by roughly 1-2 degrees at any given moment (SUP-352). One value applies per
// call, never per-chart - which node you use is definitional (like which body you're
// tracking), not a display choice, so synastry/transits must match on both sides.
const NODE_TYPE_CODES = { true: 't', mean: 'm' };

function validateNodeType(nodeType) {
  if (nodeType === undefined) return 'true';
  if (typeof nodeType !== 'string' || !Object.hasOwn(NODE_TYPE_CODES, nodeType)) {
    throw new McpError(ErrorCode.InvalidParams, `node_type must be one of: ${Object.keys(NODE_TYPE_CODES).join(', ')}`);
  }
  return nodeType;
}

// House-overlay only (SUP-263) - the aspect grid and angle-aspect planet side use the wider
// DEFAULT_ASPECT_BODIES list instead; overlaying 17 bodies into 12 houses is noisier.
const SYNASTRY_BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

// Synastry overlay set: the 10 planets plus the aspectable angles (Ascendant, Midheaven,
// Part of Fortune). Descendant/IC are excluded - they're exact mirrors of ASC/MC for house
// placement and the codebase already treats them as non-first-class (ASPECTABLE_ANGLES).
const SYNASTRY_OVERLAY_BODIES = [...SYNASTRY_BODIES, ...ASPECTABLE_ANGLES];

// Falls back to the vendor/ dir shipped alongside this file (works both in the
// Docker image, where it's copied to /app/vendor/swisseph, and in local/npx
// installs, where /app doesn't exist). SE_EPHE_PATH still overrides it.
const DEFAULT_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'swisseph');

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

// `<name>@<version>+<short sha>` per docs/tool_requests/2026-07-27_secondary-progressions.md's
// own provenance line - the sha is best-effort (an npm/npx install has no .git dir) and
// omitted rather than faked when unavailable. Computed once per process, not per request:
// neither the package version nor the checked-out commit changes while the server is running.
let cachedEphemerisVersion;
function getEphemerisVersion() {
  if (cachedEphemerisVersion) return cachedEphemerisVersion;
  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    // Not a git checkout - version string omits the build hash.
  }
  cachedEphemerisVersion = sha ? `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}+${sha}` : `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`;
  return cachedEphemerisVersion;
}

// swetest house system codes: https://www.astro.com/swisseph/swephprg.htm#_Toc112948996
const HOUSE_SYSTEMS = {
  P: 'Placidus',
  K: 'Koch',
  O: 'Porphyry',
  R: 'Regiomontanus',
  C: 'Campanus',
  E: 'Equal',
  W: 'Whole Sign',
  B: 'Alcabitus',
  M: 'Morinus',
  T: 'Polich/Page (Topocentric)',
};

function validateHouseSystem(value, paramName = 'house_system') {
  if (value === undefined) return 'P';
  if (typeof value !== 'string' || !HOUSE_SYSTEMS[value]) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${paramName} must be one of: ${Object.keys(HOUSE_SYSTEMS).join(', ')}`
    );
  }
  return value;
}

// SUP-356: only solar_arc and naibod - "ephemeris_time" (the raw clock-time angles) is
// deliberately not offered, since naming it invites the exact bug this tool exists to fix
// (see docs/tool_requests/2026-07-27_secondary-progressions.md §4). Unknown values error
// rather than silently defaulting (acceptance criterion #6).
const ANGLE_METHODS = ['solar_arc', 'naibod'];

function validateAngleMethod(value) {
  if (value === undefined) return 'solar_arc';
  if (typeof value !== 'string' || !ANGLE_METHODS.includes(value)) {
    throw new McpError(ErrorCode.InvalidParams, `angle_method must be one of: ${ANGLE_METHODS.join(', ')}`);
  }
  return value;
}

const HOUSE_FRAMES = ['progressed', 'natal'];

function validateHouseFrame(value) {
  if (value === undefined) return 'progressed';
  if (typeof value !== 'string' || !HOUSE_FRAMES.includes(value)) {
    throw new McpError(ErrorCode.InvalidParams, `house_frame must be one of: ${HOUSE_FRAMES.join(', ')}`);
  }
  return value;
}

// find_events rate (SUP-357/SUP-359): "transit" (default, unchanged) or
// "secondary_progression", which swaps in a position provider over the day-for-a-year
// technique (lib/progressed-provider.js) feeding the same rate-agnostic engine. "converse"
// (birth-ward progressions) is deliberately not offered yet - see the window_start/
// birth_datetime check in findEvents, which reserves it rather than silently computing it.
const RATES = ['transit', 'secondary_progression'];

function validateRate(value) {
  if (value === undefined) return 'transit';
  if (typeof value !== 'string' || !RATES.includes(value)) {
    throw new McpError(ErrorCode.InvalidParams, `rate must be one of: ${RATES.join(', ')}`);
  }
  return value;
}

// find_events (SUP-349/SUP-351) --------------------------------------------------------

// Valid transiting-side bodies: exactly DEFAULT_ASPECT_BODIES (17) - the set
// lib/ephemeris-series.js's BODY_CODES can look up a position/speed for. Angle bodies
// and Vertex can never transit (spec Q9): they're artifacts of the moment's location and
// time of day, not moving points, so they're excluded from validity entirely rather than
// gated behind a flag the way they are on the natal side.
const EVENT_TRANSITING_BODIES = new Set(DEFAULT_ASPECT_BODIES);

// Default transiting set (spec Q9), rate-keyed (SUP-357/SUP-359 §2/§8 retrofit item 2):
// at the transit rate, the bodies slow enough to define forecasting "chapters" rather
// than trigger them - the Moon is 21.7x the rest of the output alone (spec §4.3) and is
// excluded along with Sun/Mercury/Venus/asteroids/Lilith/North Node, all still reachable
// via an explicit `bodies` request. At the progressed rate the ruling inverts: the
// progressed Moon IS the technique (13.29 deg/yr vs. an outer planet's few degrees over a
// lifetime), so the default is the fast/personal set instead.
const DEFAULT_TRANSITING_BODIES_BY_RATE = {
  transit: ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Chiron'],
  secondary_progression: ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars'],
};

// Bodies that can station (spec Q5), 13 total. Sun/Moon never station (zero measured
// speed-sign changes) and mean Apogee (Lilith) is always direct by construction, so no
// explicit filtering is needed for them - scanTransitingBody just never finds a sign
// change. The true Node is different: it reverses ~350 times/year from orbital wobble
// (spec §1.7), which is jitter, not stations, so it's unconditionally excluded here even
// when North Node is explicitly requested via `bodies`.
const STATION_CAPABLE_BODIES = new Set([
  'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
  'Chiron', 'Ceres', 'Pallas', 'Juno', 'Vesta',
]);

const EVENT_TYPES = ['aspect', 'station', 'sign_ingress', 'house_ingress', 'lunation'];

// Natal targets whose contact dates carry birth-time error, not just an aspect orb (spec
// Q2/§6.3): the Ascendant moves ~1deg/4min of clock time, so a 10-minute birth-time
// uncertainty is ~2.5deg of Ascendant - which at an outer planet's speed can be on the
// order of months of date uncertainty. Part of Fortune inherits this because it's
// derived from the Ascendant.
const BIRTH_TIME_SENSITIVE_TARGETS = new Set(['Ascendant', 'Midheaven', 'Part of Fortune', 'Vertex']);

// Progressed-mode-only moving-side pseudo-sources (spec §1.3/§4): never real `bodies`
// (EVENT_TRANSITING_BODIES excludes them, same as the natal-side ANGLE_BODIES/Vertex
// gating), reached only via include_angles, and only for aspect contacts.
const ANGLE_SOURCE_NAMES = new Set(['Ascendant', 'Midheaven']);

// Guards the birth-time-sensitivity division (progressed mode) against a near-zero
// relative rate blowing up into an absurd days-per-minute figure - a body/cusp pairing
// that's essentially stationary at the reference instant has no meaningful answer to
// "how many days does a birth-time-minute cost", so the field is omitted there instead.
const RATE_EPSILON = 1e-9;

const EVENT_SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

// A crossing's solved longitude sits within a fraction of an arcsecond of the exact
// target it was solved for (bisection converges on time, not longitude, but even the
// fastest body - the Moon - moves only ~1e-6 deg over the remaining time tolerance). That
// residual can fall on either side of a sign/house boundary, so which side floating point
// happens to land on is not reliable for labelling. Nudging by a fixed, much larger
// epsilon in the direction of travel (or against it) resolves the sign/house unambiguously
// instead - still negligible next to any real sign (30deg) or house width.
const INGRESS_EPSILON_DEG = 1e-4;

function signIndexForLongitude(longitude) {
  return Math.floor((((longitude % 360) + 360) % 360) / 30);
}

// Max window (spec Q9), rate-keyed (SUP-357/SUP-359 §2/§8 retrofit item 4): at the
// transit rate, 10 years, chosen because it's still cheap (3653 daily rows per body, one
// swetest spawn each). A longer request is clamped rather than rejected, and the clamp is
// surfaced via `window.truncated` - "no silent truncation" means the caller can tell, not
// that the window can never be shortened. At the progressed rate a query is inherently
// lifetime-scale (10 years of window is 10 degrees of progressed Sun motion, nowhere near
// enough to answer anything the technique is used for), so the cap is a life bound - 120
// years - instead of an ephemeris-cost one.
const MAX_EVENT_WINDOW_DAYS_BY_RATE = {
  transit: 3653,
  secondary_progression: Math.round(120 * TROPICAL_YEAR_DAYS),
};

function validateEventTypes(value) {
  if (value === undefined) return EVENT_TYPES;
  if (!Array.isArray(value) || value.length === 0 || !value.every((t) => EVENT_TYPES.includes(t))) {
    throw new McpError(ErrorCode.InvalidParams, `event_types must be a non-empty array from: ${EVENT_TYPES.join(', ')}`);
  }
  return value;
}

// Position provider (spec Q10) over lib/ephemeris-series.js's swetest-backed functions -
// the transiting-side (rate: "transit") provider. The progressed-rate real-body/MC
// providers live in lib/progressed-provider.js (pure, no swetest call of their own beyond
// what ephemeris-series.js already does); the progressed Ascendant/moving-cusp providers
// below need an actual swetest -house lookup and so stay next to calculateEphemeris.
function transitProviderFor(body) {
  return {
    seriesFor: (startJd, endJd, stepDays) => ephemerisSeriesFor(body, startJd, endJd, stepDays),
    positionAt: (atJd) => ephemerisPositionAt(body, atJd),
  };
}

// Adaptive coarse grid (SUP-357/SUP-359 §1.2 exception): start from the same
// ceiling-based row generation lib/ephemeris-series.js's seriesFor uses, then recursively
// halve any adjacent pair whose longitude jumps more than 90 degrees. Only the progressed
// Ascendant and moving house cusps need this - their rate per degree of ARMC is unbounded
// near the poles, so a fixed step can't be proven safe the way it can for every real body
// (spec's own margin-table argument, which assumes bounded speed). `MIN_SPAN_JD` is a
// floor against runaway recursion at a genuine discontinuity (e.g. exactly at a pole);
// well below it a jump is presumed real, not under-sampled.
const MIN_ADAPTIVE_SPAN_JD = 1 / 1440; // 1 minute of target time

function adaptiveJdGrid(startJd, endJd, stepDays, longitudeAt) {
  const steps = Math.max(0, Math.ceil((endJd - startJd) / stepDays - 1e-9));
  const base = [];
  for (let i = 0; i <= steps; i++) base.push(i === steps ? endJd : Math.min(startJd + i * stepDays, endJd));

  const result = [base[0]];
  const subdivide = (loJd, hiJd) => {
    const jump = Math.abs(wrap180(longitudeAt(hiJd) - longitudeAt(loJd)));
    if (jump > 90 && hiJd - loJd > MIN_ADAPTIVE_SPAN_JD) {
      const midJd = (loJd + hiJd) / 2;
      subdivide(loJd, midJd);
      subdivide(midJd, hiJd);
    } else {
      result.push(hiJd);
    }
  };
  for (let i = 1; i < base.length; i++) subdivide(base[i - 1], base[i]);
  return result;
}

// Progressed Ascendant provider: goes through progressedFrameAt (computeFictitiousLongitude
// under the hood, keeping its `+ natalLongitude` term) for longitude; speed is a central
// numeric difference (h = 1 day of target time - safely larger than the ~6-minute plateau
// calculateEphemeris's whole-second time truncation creates, so the difference is never
// spuriously zero). No analytic ASC speed formula exists the way MC has one via the Sun.
function ascendantProviderFor(progressedFrameAt) {
  const lonAt = (jd) => progressedFrameAt(jd).ascendant;
  const speedAt = (targetJd) => wrap180(lonAt(targetJd + 1) - lonAt(targetJd - 1)) / 2;
  return {
    positionAt: (targetJd) => ({ longitude: lonAt(targetJd), speed: speedAt(targetJd) }),
    seriesFor(startJd, endJd, stepDays) {
      const jds = adaptiveJdGrid(startJd, endJd, stepDays, lonAt);
      return jds.map((jd) => ({ jd, longitude: lonAt(jd), speed: speedAt(jd) }));
    },
  };
}

// A single progressed house cusp as a provider, same shape/precision tradeoffs as the
// Ascendant provider above (and sharing its progressedFrameAt cache - a house computation
// yields all 12 cusps at once, so querying cusp 3 after cusp 7 at the same instant costs
// nothing extra).
function cuspProviderFor(progressedFrameAt, house) {
  const lonAt = (jd) => progressedFrameAt(jd).houses[house].longitude;
  const speedAt = (targetJd) => wrap180(lonAt(targetJd + 1) - lonAt(targetJd - 1)) / 2;
  return {
    positionAt: (targetJd) => ({ longitude: lonAt(targetJd), speed: speedAt(targetJd) }),
    seriesFor(startJd, endJd, stepDays) {
      const jds = adaptiveJdGrid(startJd, endJd, stepDays, lonAt);
      return jds.map((jd) => ({ jd, longitude: lonAt(jd), speed: speedAt(jd) }));
    },
  };
}

// house_frame: "progressed" composition (spec §1.1.1): the cusps move too, so house_ingress
// becomes a two-moving-point search over lambda_body(t) - cusp_i(t), the same pattern
// relativeLunarProvider (lib/event-search.js) uses for the Sun-Moon relative longitude -
// scanTransitingBody then segments at the stationary points of the DIFFERENCE, and
// `direction` on the resulting crossings reflects the relative rate's sign rather than the
// body's own (a body can be direct while what's actually closing the gap is the cusp).
// Composed via positionAt rather than zipping seriesFor rows index-for-index the way
// relativeLunarProvider does: a cusp/Ascendant provider's grid can be adaptively
// subdivided (finer than the body's plain grid), so the two sides' rows aren't guaranteed
// to line up positionally the way Sun/Moon's identical, non-adaptive grids do.
function relativeMovingProvider(bodyProvider, cuspProvider) {
  const composeAt = (jd) => {
    const b = bodyProvider.positionAt(jd);
    const c = cuspProvider.positionAt(jd);
    return { longitude: mod360(b.longitude - c.longitude), speed: b.speed - c.speed };
  };
  return {
    positionAt: composeAt,
    seriesFor(startJd, endJd, stepDays) {
      const bodyJds = bodyProvider.seriesFor(startJd, endJd, stepDays).map((r) => r.jd);
      const cuspJds = cuspProvider.seriesFor(startJd, endJd, stepDays).map((r) => r.jd);
      const jds = [...new Set([...bodyJds, ...cuspJds])].sort((a, b) => a - b);
      return jds.map((jd) => ({ jd, ...composeAt(jd) }));
    },
  };
}

class SwissEphemerisServer {
  constructor() {
    this.server = new Server(
      {
        name: 'swiss-ephemeris-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'calculate_planetary_positions',
            description: 'Calculate planetary positions, houses, chart points and asteroids for a given datetime and coordinates',
            inputSchema: {
              type: 'object',
              properties: {
                datetime: {
                  type: 'string',
                  description: 'ISO8601 datetime, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Longitude in decimal degrees, positive east',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                node_type: {
                  type: 'string',
                  enum: ['true', 'mean'],
                  description: 'Lunar Node type: "true" (default) is the true/osculating Node, which wobbles and can reverse direction. "mean" is the smoothed mean Node, which moves monotonically retrograde. The two differ by roughly 1-2 degrees at any given time - enough to change a sign or move a node aspect in or out of orb. Applies to North Node, South Node, and any node-derived aspect. Echoed back as `node_type` on the result.',
                },
              },
              required: ['datetime', 'latitude', 'longitude'],
            },
          },
          {
            name: 'calculate_transits',
            description: 'Calculate birth chart positions and current transits for comparison, including aspects from transiting bodies to the natal chart. `applying` is computed from the transiting body\'s motion only; the natal position is treated as fixed.',
            inputSchema: {
              type: 'object',
              properties: {
                birth_datetime: {
                  type: 'string',
                  description: 'Birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Birth latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Birth longitude in decimal degrees, positive east',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                node_type: {
                  type: 'string',
                  enum: ['true', 'mean'],
                  description: 'Lunar Node type applied to both the natal chart and current transits: "true" (default) is the true/osculating Node, which wobbles and can reverse direction. "mean" is the smoothed mean Node, which moves monotonically retrograde. The two differ by roughly 1-2 degrees at any given time. One value applies to both charts - it is definitional, not a per-chart display choice, so a natal Node and a transiting Node must be the same kind to compare meaningfully. Echoed back as `settings_used.node_type`.',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile) in transit_aspects. Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include the NATAL chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in transit_aspects. Transiting angles are always excluded, even if requested via `bodies`: they are artifacts of the moment\'s location and time of day (the transiting Ascendant sweeps the whole zodiac daily), so transit-side angle contacts change minute to minute and carry no meaning. Default false.',
                },
                include_south_node: {
                  type: 'boolean',
                  description: 'Include South Node in transit_aspects. Default false.',
                },
                include_vertex: {
                  type: 'boolean',
                  description: 'Include the NATAL Vertex in `transit_aspects`. Default false, independent of `include_angles`. The transiting Vertex is always excluded from the transiting side, even if requested via `bodies`: like the transiting angles, it\'s an artifact of the moment\'s location/time and changes continuously, so transit-side Vertex contacts carry no meaning.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list for transit_aspects. Must be names known to the server. Angle bodies are always excluded from the transiting side, even if listed here.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees for transit_aspects, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model for transit_aspects. "moiety" (default) sums each body\'s half-orb (e.g. Sun 7.5°, Moon 6°) and scales by the aspect\'s multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. There is no single canonical orb table — see calculate_aspects\' orb_model description (or README) for moiety provenance and why sextile stays a major aspect despite its narrower 0.75 multiplier.',
                },
              },
              required: ['birth_datetime', 'latitude', 'longitude'],
            },
          },
          {
            name: 'calculate_solar_revolution',
            description: 'Calculate solar return chart for a specific year. The solar return occurs when the Sun returns to the exact same position as at birth.',
            inputSchema: {
              type: 'object',
              properties: {
                birth_datetime: {
                  type: 'string',
                  description: 'Birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                birth_latitude: {
                  type: 'number',
                  description: 'Birth latitude in decimal degrees',
                },
                birth_longitude: {
                  type: 'number',
                  description: 'Birth longitude in decimal degrees, positive east',
                },
                return_year: {
                  type: 'number',
                  description: 'Year for the solar return calculation, e.g., 2024',
                },
                return_latitude: {
                  type: 'number',
                  description: 'Latitude for solar return location (optional, defaults to birth location)',
                },
                return_longitude: {
                  type: 'number',
                  description: 'Longitude for solar return location (optional, defaults to birth location)',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code applied to both natal and solar return charts: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                node_type: {
                  type: 'string',
                  enum: ['true', 'mean'],
                  description: 'Lunar Node type applied to both the natal and solar return charts: "true" (default) is the true/osculating Node, which wobbles and can reverse direction. "mean" is the smoothed mean Node, which moves monotonically retrograde. The two differ by roughly 1-2 degrees at any given time. Echoed back as `node_type` on each chart.',
                },
              },
              required: ['birth_datetime', 'birth_latitude', 'birth_longitude', 'return_year'],
            },
          },
          {
            name: 'calculate_synastry',
            description: 'Calculate synastry chart between two people for relationship compatibility analysis. Compares planetary positions and calculates aspects between the charts.',
            inputSchema: {
              type: 'object',
              properties: {
                person1_datetime: {
                  type: 'string',
                  description: 'Person 1 birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                person1_latitude: {
                  type: 'number',
                  description: 'Person 1 birth latitude in decimal degrees',
                },
                person1_longitude: {
                  type: 'number',
                  description: 'Person 1 birth longitude in decimal degrees, positive east',
                },
                person2_datetime: {
                  type: 'string',
                  description: 'Person 2 birth datetime in ISO8601 format, e.g., 1990-08-25T14:30:00Z',
                },
                person2_latitude: {
                  type: 'number',
                  description: 'Person 2 birth latitude in decimal degrees',
                },
                person2_longitude: {
                  type: 'number',
                  description: 'Person 2 birth longitude in decimal degrees, positive east',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile). Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include cross-chart aspects to chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in addition to planet-planet aspects. Default false.',
                },
                include_vertex: {
                  type: 'boolean',
                  description: 'Include the Vertex in `angle_aspects` (planet-to-Vertex and Vertex-to-Vertex contacts across the two charts). Default false, independent of `include_angles` — setting this alone still produces an `angle_aspects` array, containing only Vertex contacts.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list (defaults to the full 17-body list: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Applies to the aspect grid and angle-aspect planet side only — the house overlay always uses the 10 traditional planets.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model. "moiety" (default) sums each body\'s half-orb and scales by the aspect\'s multiplier — see calculate_aspects for the formula and an example. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. There is no single canonical orb table — see calculate_aspects\' orb_model description (or README) for moiety provenance and why sextile stays a major aspect despite its narrower 0.75 multiplier.',
                },
                person1_house_system: {
                  type: 'string',
                  description: 'House system code for person 1: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                person2_house_system: {
                  type: 'string',
                  description: 'House system code for person 2: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                node_type: {
                  type: 'string',
                  enum: ['true', 'mean'],
                  description: 'Lunar Node type applied to both charts: "true" (default) is the true/osculating Node, which wobbles and can reverse direction. "mean" is the smoothed mean Node, which moves monotonically retrograde. The two differ by roughly 1-2 degrees at any given time. Unlike `person1_house_system`/`person2_house_system`, there is a single `node_type` for both people, not one per person - which node you use is definitional, not a display choice, so it must match on both sides of the comparison. Echoed back as `node_type` on each chart.',
                },
              },
              required: ['person1_datetime', 'person1_latitude', 'person1_longitude', 'person2_datetime', 'person2_latitude', 'person2_longitude'],
            },
          },
          {
            name: 'calculate_aspects',
            description: 'Calculate natal chart aspects for a given datetime and coordinates. Returns planetary positions plus all qualifying aspects with orb, applying/separating status, and category.',
            inputSchema: {
              type: 'object',
              properties: {
                datetime: {
                  type: 'string',
                  description: 'ISO8601 datetime, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Longitude in decimal degrees, positive east',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile). Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in aspect calculations. Default false.',
                },
                include_south_node: {
                  type: 'boolean',
                  description: 'Include South Node in aspect calculations. Default false.',
                },
                include_vertex: {
                  type: 'boolean',
                  description: 'Include the Vertex in aspect calculations. Default false. Independent of `include_angles` — the Vertex is contested and highly sensitive to birth-time precision (more so than the Ascendant), so it\'s opt-in on its own. The anti-Vertex (Vertex + 180°) is never separately aspected, for the same double-counting reason IC/Descendant are excluded (see README Angle Aspects).',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list. Must be names known to the server.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model. "moiety" (default) sums each body\'s half-orb (per-body table, e.g. Sun 7.5°, Moon 6°, Ascendant 2.5°) and scales by the aspect\'s multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. Provenance: there is no single canonical orb table in the tradition — the Sun..Saturn moieties are sourced (halved from a classical full-orb table), everything past Saturn plus angles and lots is a team-constructed, non-traditional convention (see README). Note sextile\'s 0.75 multiplier is a narrower orb, not a demotion: sextile is still returned with category "major" (it is a Ptolemaic aspect) under either orb_model.',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                node_type: {
                  type: 'string',
                  enum: ['true', 'mean'],
                  description: 'Lunar Node type: "true" (default) is the true/osculating Node, which wobbles and can reverse direction. "mean" is the smoothed mean Node, which moves monotonically retrograde. The two differ by roughly 1-2 degrees at any given time - enough to change a sign or move a node aspect in or out of orb. Applies to North Node, South Node, and any node-derived aspect. Echoed back as `settings_used.node_type`.',
                },
              },
              required: ['datetime', 'latitude', 'longitude'],
            },
          },
          {
            name: 'calculate_secondary_progressions',
            description: 'Calculate secondary progressions (the "day for a year" technique) for a birth chart, progressed to a target date: progressed planetary positions, progressed Ascendant/Midheaven/IC/Descendant, progressed houses, and aspects from the progressed bodies to the natal chart. Progressed angles are derived by directing the natal Midheaven along the ecliptic by the chosen arc and converting to a right ascension (ARMC) before deriving houses - NOT by reading the angles of the raw clock moment `progressed_datetime` falls on, which are off by hundreds of degrees and mean nothing (see `natal_chart` for the birth chart, returned alongside for diffing).',
            inputSchema: {
              type: 'object',
              properties: {
                birth_datetime: {
                  type: 'string',
                  description: 'Birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                birth_latitude: {
                  type: 'number',
                  description: 'Birth latitude in decimal degrees',
                },
                birth_longitude: {
                  type: 'number',
                  description: 'Birth longitude in decimal degrees, positive east',
                },
                target_date: {
                  type: 'string',
                  description: 'ISO8601 datetime to progress to. The real elapsed time between birth_datetime and this date, expressed in tropical years (year_length_days), is converted 1 year = 1 day and added to birth_datetime to get the progressed instant, returned as `progressed_datetime`.',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code, applied to both the natal chart and the progressed houses: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                angle_method: {
                  type: 'string',
                  enum: ['solar_arc', 'naibod'],
                  description: 'Convention for the arc the natal Midheaven is directed by. "solar_arc" (default) uses (progressed Sun longitude - natal Sun longitude), which self-corrects for the Sun\'s actual non-mean motion. "naibod" uses a mean rate of 360/year_length_days degrees per elapsed year instead. Both direct the ecliptic Midheaven, not the ARMC/right ascension directly - the two conventions diverge by roughly a degree per few decades of age, which is why the method used is echoed back as `angle_method_used`. An unrecognized value errors rather than silently defaulting.',
                },
                house_frame: {
                  type: 'string',
                  enum: ['progressed', 'natal'],
                  description: 'Which house cusps to report as `progressed_houses` and use for house placement of progressed bodies: "progressed" (default) uses the arc-directed progressed cusps computed by this tool; "natal" reuses the birth chart\'s own house cusps. Echoed back as `house_frame_used`. Progressed Ascendant/Midheaven/IC/Descendant (`progressed_angles`) are always the arc-directed progressed values regardless of this setting.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list (defaults to the same list as calculate_transits: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Applies to `progressed_planets` and the progressed side of `aspects_to_natal`.',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile) in aspects_to_natal. Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include progressed Ascendant and Midheaven as aspectable bodies on the progressed side of aspects_to_natal, and natal Ascendant/Midheaven/Part of Fortune on the natal side. Default true, unlike calculate_transits/calculate_synastry - progressed angle contacts are this tool\'s headline output, so unlike a transiting Ascendant (which sweeps the whole zodiac daily and means nothing), the progressed Ascendant/Midheaven stay aspectable here. Progressed Part of Fortune is never included on the progressed side regardless of this flag - which day/night formula applies to a progressed sect is unsettled.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees for aspects_to_natal, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}}. The default orb tables (see calculate_transits\' orb_model description) are transit-scaled; the conventional orb for progressed aspects is tighter, around 1 degree, so callers doing serious progressions work will usually want to tighten these rather than use the defaults as-is.',
                  additionalProperties: { type: ['number', 'object'] },
                },
              },
              required: ['birth_datetime', 'birth_latitude', 'birth_longitude', 'target_date'],
            },
          },
          {
            name: 'find_events',
            description: 'Search a UTC window for time-domain astrological events: aspect contacts (`contacts[]`, grouped into orb episodes with every exact pass), and instants (`events[]`) - planetary stations, sign/house ingresses, and lunations (New/Full Moon, optionally quarters). At `rate: "transit"` (default) the moving side is transiting bodies, houses are the NATAL chart\'s own, and lunations carry eclipse annotation. At `rate: "secondary_progression"` the moving side is the day-for-a-year progressed chart instead (feeding calculate_secondary_progressions\' own arc/house math into the same search engine): progressed angles become searchable, houses can move with the progressed chart, defaults invert (see `bodies`/`orb_model`/`include_*` below), and eclipse annotation is structurally absent (progressions have no eclipse analogue). Correctness comes from segmenting the window at the moving side\'s own stations and enumerating every target crossing in each monotone segment, not from a scan step - no pass can be skipped between samples.',
            inputSchema: {
              type: 'object',
              properties: {
                birth_datetime: {
                  type: 'string',
                  description: 'Birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Birth latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Birth longitude in decimal degrees, positive east',
                },
                window_start: {
                  type: 'string',
                  description: 'Start of the UTC search window, ISO8601, e.g., 2026-01-01T00:00:00Z. Must not be earlier than birth_datetime when rate is "secondary_progression" (that would be a converse progression, a distinct technique not offered yet).',
                },
                window_end: {
                  type: 'string',
                  description: 'End of the UTC search window, ISO8601. Must be after window_start. A window longer than the per-rate cap is clamped rather than rejected - see `window.truncated` on the result. Cap is 10 years at rate "transit", 120 years at rate "secondary_progression" (a progressed query is inherently lifetime-scale; 10 years of window is 10 degrees of progressed Sun motion).',
                },
                event_types: {
                  type: 'array',
                  items: { type: 'string', enum: ['aspect', 'station', 'sign_ingress', 'house_ingress', 'lunation'] },
                  description: 'Which event categories to search. Default: all five. "aspect" populates `contacts[]`; the other four populate `events[]`. All five carry over at rate "secondary_progression" - eclipse annotation is the only thing without a progressed analogue, and that is an annotation on "lunation", not a category of its own.',
                },
                rate: {
                  type: 'string',
                  enum: ['transit', 'secondary_progression'],
                  description: '"transit" (default): the moving side is transiting bodies at their real ephemeris position, matching calculate_transits. "secondary_progression": the moving side is the day-for-a-year progressed chart instead - progressed positions here match calculate_secondary_progressions exactly (same angle_method/house_frame semantics), and several defaults invert relative to "transit" (see `bodies`, `orb_model`, `include_angles`, `include_quarter_moons`). `angle_method`/`house_frame` require this to be "secondary_progression" and error otherwise.',
                },
                angle_method: {
                  type: 'string',
                  enum: ['solar_arc', 'naibod'],
                  description: 'Requires rate "secondary_progression" (errors otherwise). Same meaning and default ("solar_arc") as calculate_secondary_progressions - the convention the progressed Midheaven/Ascendant are directed by. Echoed as `settings_used.angle_method_used`.',
                },
                house_frame: {
                  type: 'string',
                  enum: ['progressed', 'natal'],
                  description: 'Requires rate "secondary_progression" (errors otherwise). Same meaning and default ("progressed") as calculate_secondary_progressions. Under "progressed", house_ingress cusps move with the progressed chart too - `direction` on those events reflects the sign of the body-relative-to-cusp rate, not the body\'s own speed, since a body can be direct while a moving cusp is what\'s actually closing the gap. Under "natal", house_ingress uses the fixed birth chart cusps, same as rate "transit". Echoed as `settings_used.house_frame_used`.',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code applied to the natal chart and to house_ingress. Default P=Placidus, K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'MOVING side. Default depends on `rate`. At "transit" (default): Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron - the bodies slow enough to define forecasting "chapters" rather than trigger them; the transiting Moon is excluded (it alone is 21.7x the rest of the output) but reachable by explicit request, as are Sun/Mercury/Venus/asteroids/Lilith/North Node. At "secondary_progression": Sun, Moon, Mercury, Venus, Mars - inverted, since the progressed Moon (13.29 deg/yr) IS the technique and an outer planet moves only a few degrees in a lifetime; the rest are still reachable by explicit request. Angle bodies and Vertex can never appear here - progressed Ascendant/Midheaven are reached via `include_angles` instead, not `bodies`. Governs `contacts[]` and `sign_ingress`/`house_ingress` events; `station` events always search the fixed 13-body station-capable set regardless of this parameter (unaffected by either default) - see `events[].type === "station"`.',
                },
                targets: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'NATAL side. Default: the same 17-body list as calculate_transits (Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Ascendant/Midheaven/Part of Fortune behind include_angles, Vertex behind include_vertex, South Node behind include_south_node - same gating as calculate_transits/calculate_aspects. Every contact whose natal_point is Ascendant, Midheaven, Part of Fortune or Vertex carries `birth_time_sensitive: true`.',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile) in contacts[]. Default false - matches calculate_aspects/calculate_transits exactly, so an aspect visible in a snapshot tool is never unsearchable here.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Default depends on `rate`: false at "transit", true at "secondary_progression" (matching calculate_secondary_progressions - progressed angle contacts are this rate\'s headline output). At "transit", adds natal Ascendant/Midheaven/Part of Fortune as targets. At "secondary_progression", ALSO adds progressed Ascendant/Midheaven as moving-side sources for `contacts[]` (never as `bodies`/station/ingress sources) alongside the natal-side addition - matching calculate_secondary_progressions\' asymmetry, including that progressed Part of Fortune is never a source (which day/night formula applies to a progressed sect is unsettled). Contacts and house_ingress events carry a `date_uncertainty_days_per_birth_minute` figure at this rate whenever a birth-time-sensitive point is involved, since a degree of angle error there is roughly a year of date error - about 13x worse than at "transit".',
                },
                include_south_node: {
                  type: 'boolean',
                  description: 'Include natal South Node as a target. Default false.',
                },
                include_vertex: {
                  type: 'boolean',
                  description: 'Include natal Vertex as a target. Default false, independent of include_angles.',
                },
                include_quarter_moons: {
                  type: 'boolean',
                  description: 'Include First/Last Quarter alongside New/Full Moon in lunation events. Default depends on `rate`: false at "transit" (New/Full alone already run ~25/yr; quarters would double that with comparatively little added signal), true at "secondary_progression" (the ~29.31-year progressed lunation cycle is conventionally read by phase, and even with quarters a 90-year window yields only ~12 total).',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees for contacts[], e.g. {"conjunction": 10}. Also accepts the per-class shape ({"angle": {"square": 4}}, {"derived": {"square": 2}}) under orb_model "class", or the {"moieties": {...}, "multipliers": {...}} shape under "moiety" - same as calculate_transits. orb_model "fixed" takes flat aspect-name keys only (no class/moiety nesting), same shape as "class" minus the nested form.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety', 'fixed'],
                  description: 'Orb resolution model for contacts[]. Default depends on `rate`: "moiety" at "transit" (sums each body\'s half-orb and scales by the aspect\'s multiplier), "fixed" at "secondary_progression" (a flat 1° for major aspects / 0.5° for minors, independent of which bodies/points are involved). "class" is also available at either rate, using the fixed per-class tables. The progressed default inverts because a transit-scaled orb table leaves an outer-planet progressed contact "in orb" for centuries - see calculate_transits\' orb_model description for the moiety/class formulas.',
                },
              },
              required: ['birth_datetime', 'latitude', 'longitude', 'window_start', 'window_end'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleToolCall(name, args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error.message}`
        );
      }
    });
  }

  calculateEphemeris(datetime, latitude, longitude, houseSystem = 'P', nodeType = 'true') {
    try {
      const date = new Date(datetime);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid datetime format. Use ISO8601 format like 1985-04-12T23:20:50Z');
      }

      const swissDate = formatDateToSwiss(date);
      const swissTime = formatTimeToSwiss(date);
      const ephePath = process.env.SE_EPHE_PATH || DEFAULT_EPHE_PATH;

      // Execute swetest for planets, including asteroids and additional points
      // 0123456789 = Sun through Pluto, t/m = true/mean Node (node_type param, see
      // NODE_TYPE_CODES), A = mean Apogee (Lilith), D = Chiron, F = Ceres, G = Pallas, H = Juno,
      // I = Vesta, o = obliquity (Ecl. Obl. pseudo-body)
      // -fPZSBD adds ecliptic latitude and declination; -l appends a decimal field, used to
      // read the true obliquity off the Ecl. Obl. row without relying on its zodiacal
      // encoding landing in Aries by luck (docs/SUP-345-declination-layer-spec.md §1.4).
      const nodeCode = Object.hasOwn(NODE_TYPE_CODES, nodeType) ? NODE_TYPE_CODES[nodeType] : NODE_TYPE_CODES.true;
      // -fPZSBDl- (trailing -) appends illuminated fraction of the disc at the end, after
      // every existing column, so none of the positional indices above shift.
      const planetCmd = `SE_EPHE_PATH=${ephePath} swetest -b${swissDate} -ut${swissTime} -p0123456789${nodeCode}ADFGHIo -fPZSBDl- -g, -head`;
      let planetOutput;
      try {
        planetOutput = execSync(planetCmd, { encoding: 'utf8' });
      } catch (error) {
        throw new Error(`Failed to execute swetest for planets: ${error.message}`);
      }

      // Execute swetest for houses
      const houseCmd = `SE_EPHE_PATH=${ephePath} swetest -b${swissDate} -ut${swissTime} -house${longitude},${latitude},${houseSystem} -fPZSBD -g, -head`;
      let houseOutput;
      try {
        houseOutput = execSync(houseCmd, { encoding: 'utf8' });
      } catch (error) {
        throw new Error(`Failed to execute swetest for houses: ${error.message}`);
      }

      // swetest prints these to stdout (not stderr) when an ephemeris data file for a
      // body is missing, then still emits a "0 ar 0' 0.0000" placeholder row for that
      // body instead of failing the whole command. Without this check that placeholder
      // is indistinguishable from a real 0deg-Aries position and gets reported as fact.
      const missingEphemerisFiles = [...planetOutput.matchAll(/error: SwissEph file '([^']+)' not found/g)]
        .map((m) => m[1]);

      // The true obliquity of the ecliptic for the moment, read off the Ecl. Obl. pseudo-body
      // row (see planetCmd comment above). Needed before planets are parsed so out-of-bounds
      // can be computed inline.
      const obliquityLine = planetOutput.split('\n').find(line => line.trim().startsWith('Ecl. Obl.'));
      const obliquity = obliquityLine ? parsePlanetLine(obliquityLine)?.obliquity : undefined;

      // Parse planets
      const planets = {};
      const planetLines = planetOutput.split('\n').filter(line => line.trim() && !line.includes('error:') && !line.includes('warning:'));

      planetLines.forEach(line => {
        const planet = parsePlanetLine(line);
        if (!planet) return;
        // Ecl. Obl. is a pseudo-body (§1.4 above), not a real position - it must never enter
        // `planets` or aspect matching. Its data was already captured above.
        if (planet.name === 'Ecl. Obl.') return;
        if (missingEphemerisFiles.length > 0 && planet.longitude === 0 && planet.speed === 0) {
          // Placeholder row from a missing ephemeris file, not a real position - drop it.
          return;
        }

        // Map swetest planet codes to readable names
        const planetNames = {
          'Sun': 'Sun',
          'Moon': 'Moon',
          'Mercury': 'Mercury',
          'Venus': 'Venus',
          'Mars': 'Mars',
          'Jupiter': 'Jupiter',
          'Saturn': 'Saturn',
          'Uranus': 'Uranus',
          'Neptune': 'Neptune',
          'Pluto': 'Pluto',
          'mean Node': 'North Node',
          'true Node': 'North Node',
          'Chiron': 'Chiron',
          'mean Apogee': 'Lilith',
          'Ceres': 'Ceres',
          'Pallas': 'Pallas',
          'Juno': 'Juno',
          'Vesta': 'Vesta'
        };

        const name = planetNames[planet.name] || planet.name;

        // Out-of-bounds: |declination| > true obliquity of the date. The Sun is suppressed
        // unconditionally - its ~0.5" apparent ecliptic latitude (light-time/aberration) can
        // push its apparent declination a fraction of an arcsecond past true obliquity right
        // at a solstice, which would flag the body that *defines* the bound as having left
        // it. This is a real, reproducible false positive, not a hypothetical - see
        // docs/SUP-345-declination-layer-spec.md §Q4. Do not "fix" this back to a plain
        // comparison; the MOIETIES halving comment in lib/aspects.js is the house precedent
        // for guarding a deliberate-looking-wrong constant.
        let outOfBounds = false;
        let outOfBoundsBy = null;
        if (name !== 'Sun' && obliquity !== undefined && planet.declination !== undefined) {
          const diff = Math.abs(planet.declination) - obliquity;
          if (diff > 0) {
            outOfBounds = true;
            outOfBoundsBy = diff;
          }
        }

        planets[name] = {
          longitude: planet.longitude,
          sign: planet.sign,
          degree: planet.degree,
          speed: planet.speed,
          ecliptic_latitude: planet.ecliptic_latitude,
          declination: planet.declination,
          out_of_bounds: outOfBounds,
          out_of_bounds_by: outOfBoundsBy,
          illuminated_fraction: planet.illuminated_fraction
        };
      });

      // Parse houses and chart points from house output
      const houses = {};
      const chartPoints = {};
      const houseLines = houseOutput.split('\n').filter(line => line.trim() && !line.includes('error:') && !line.includes('warning:'));
      
      houseLines.forEach(line => {
        // Try parsing as house
        if (line.includes('house ')) {
          const house = parseHouseLine(line);
          if (house && house.house >= 1 && house.house <= 12) {
            houses[house.house] = {
              longitude: house.longitude,
              sign: house.sign,
              degree: house.degree,
              declination: house.declination
            };
          }
        }
        // Try parsing as chart point
        else if (line.includes('Ascendant') || line.includes('MC') || line.includes('ARMC') || line.includes('Vertex')) {
          const chartPoint = parseChartPointLine(line);
          if (chartPoint) {
            const pointNames = {
              'Ascendant': 'Ascendant',
              'MC': 'Midheaven',
              'ARMC': 'ARMC',
              'Vertex': 'Vertex'
            };

            const name = pointNames[chartPoint.name] || chartPoint.name;
            chartPoints[name] = {
              longitude: chartPoint.longitude,
              sign: chartPoint.sign,
              degree: chartPoint.degree
            };
            // ARMC's declination column is a meaningless right-ascension artifact, not a
            // real declination (§1.3) - a literal 0 there would read as "on the celestial
            // equator," which is false. Omit the field entirely rather than emit it.
            if (name !== 'ARMC') {
              chartPoints[name].declination = chartPoint.declination;
            }
          }
        }
      });

      // Calculate additional points
      const additionalPoints = {};

      // Add South Node (opposite of North Node)
      if (planets['North Node']) {
        const northNodeLon = planets['North Node'].longitude;
        const southNodeLon = (northNodeLon + 180) % 360;
        const signIndex = Math.floor(southNodeLon / 30);
        const degree = southNodeLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        additionalPoints['South Node'] = {
          longitude: southNodeLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100,
          declination: -planets['North Node'].declination
        };
      }

      // Calculate Part of Fortune: ASC + Moon - Sun for a day chart (Sun above the
      // horizon), ASC + Sun - Moon for a night chart (Sun below the horizon) - the
      // traditional day/night distinction. Sect is a property of the ASC/DSC horizon
      // axis, so it's derived directly from longitudes rather than from `houses`,
      // which is display-house-system-dependent (e.g. Whole Sign widens house 1 to
      // 0° of the Ascendant's sign, decoupling it from the true Ascendant degree).
      if (chartPoints.Ascendant && planets.Sun && planets.Moon) {
        const ascLon = chartPoints.Ascendant.longitude;
        const sunLon = planets.Sun.longitude;
        const moonLon = planets.Moon.longitude;
        const offsetFromAsc = ((sunLon - ascLon) % 360 + 360) % 360;
        const isNightChart = offsetFromAsc < 180;
        let fortuneLon = isNightChart
          ? (ascLon + sunLon - moonLon) % 360
          : (ascLon + moonLon - sunLon) % 360;
        if (fortuneLon < 0) fortuneLon += 360;
        
        const signIndex = Math.floor(fortuneLon / 30);
        const degree = fortuneLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        additionalPoints['Part of Fortune'] = {
          longitude: fortuneLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100
        };
      }

      // Add IC and Descendant based on Ascendant and Midheaven
      if (chartPoints.Ascendant) {
        const ascLon = chartPoints.Ascendant.longitude;
        const descLon = (ascLon + 180) % 360;
        const signIndex = Math.floor(descLon / 30);
        const degree = descLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        chartPoints.Descendant = {
          longitude: descLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100,
          declination: -chartPoints.Ascendant.declination
        };
      }

      if (chartPoints.Midheaven) {
        const mcLon = chartPoints.Midheaven.longitude;
        const icLon = (mcLon + 180) % 360;
        const signIndex = Math.floor(icLon / 30);
        const degree = icLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        chartPoints.IC = {
          longitude: icLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100,
          declination: -chartPoints.Midheaven.declination
        };
      }

      const result = {
        planets,
        houses,
        chart_points: chartPoints,
        additional_points: additionalPoints,
        obliquity,
        obliquity_type: 'true',
        datetime: datetime,
        coordinates: {
          latitude,
          longitude
        },
        house_system: houseSystem,
        node_type: nodeType
      };

      // Instantaneous chart datum, not a time-domain event (SUP-353) - omitted rather than
      // fabricated when Sun/Moon are unavailable (e.g. the missing-ephemeris path), same
      // precedent as the ARMC declination omission and the placeholder-row drop above.
      if (planets.Sun && planets.Moon) {
        const phaseInfo = moonPhase(planets.Sun.longitude, planets.Moon.longitude);
        result.moon_phase = {
          phase: phaseInfo.phase,
          elongation: phaseInfo.elongation,
          illuminated_fraction: planets.Moon.illuminated_fraction,
          phase_scheme: phaseInfo.phase_scheme
        };
      }

      if (missingEphemerisFiles.length > 0) {
        result.warnings = missingEphemerisFiles.map(
          (file) => `Ephemeris data file '${file}' not found under SE_EPHE_PATH (${ephePath}) - bodies depending on it were omitted from 'planets' rather than reported at a false position.`
        );
      }

      return result;

    } catch (error) {
      throw new Error(`Swiss Ephemeris calculation failed: ${error.message}`);
    }
  }

  // Shared by calculate_aspects and calculate_transits: validate the requested
  // bodies/orb_overrides against an ephemeris result and resolve them to
  // {name, longitude, speed} entries for the aspect engine.
  resolveAspectBodies(ephemerisResult, options = {}) {
    const {
      includeAngles = false,
      includeSouthNode = false,
      includeVertex = false,
      bodies,
      orbOverrides = {},
      orbModel = 'moiety',
    } = options;

    const knownBodies = new Set([...DEFAULT_ASPECT_BODIES, ...ANGLE_BODIES, 'South Node', 'Vertex']);

    const requestedBodies = Array.isArray(bodies) && bodies.length ? bodies : DEFAULT_ASPECT_BODIES;

    for (const b of requestedBodies) {
      if (!knownBodies.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown body: ${b}`);
      }
    }

    const invalidOrbKeys = invalidOrbOverrideKeys(orbOverrides, orbModel);
    if (invalidOrbKeys.length) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${invalidOrbKeys[0]}`);
    }

    const bodySet = new Set(requestedBodies);
    if (includeAngles) {
      // DSC/IC are mirrors of ASC/MC and are never aspected - see ASPECTABLE_ANGLES.
      ASPECTABLE_ANGLES.forEach((b) => bodySet.add(b));
    }
    if (includeSouthNode) {
      bodySet.add('South Node');
    }
    if (includeVertex) {
      bodySet.add('Vertex');
    }

    // include_angles/include_south_node/include_vertex gate which bodies enter aspect matching,
    // and that gate applies uniformly whether a body came from the default set or an explicit
    // `bodies` array (SUP-224) - both the natal path (calculate_aspects) and the cross-chart path
    // (calculate_transits/synastry) resolve bodies through here, so they can never disagree.
    // DSC/IC are legitimate computed points but never enter aspect pair-matching - see
    // ASPECTABLE_ANGLES - so they're dropped unconditionally, independent of include_angles.
    const aspectableAngleSet = new Set(ASPECTABLE_ANGLES);
    const nonAspectableAngleSet = new Set(ANGLE_BODIES.filter((b) => !aspectableAngleSet.has(b)));
    for (const name of Array.from(bodySet)) {
      if (name === 'South Node') {
        if (!includeSouthNode) bodySet.delete(name);
      } else if (name === 'Vertex') {
        if (!includeVertex) bodySet.delete(name);
      } else if (nonAspectableAngleSet.has(name)) {
        bodySet.delete(name);
      } else if (aspectableAngleSet.has(name) && !includeAngles) {
        bodySet.delete(name);
      }
    }

    const bodiesWithLonSpeed = [];

    for (const name of bodySet) {
      const body = toAspectBody(ephemerisResult, name);
      if (body) bodiesWithLonSpeed.push(body);
    }

    return { bodiesWithLonSpeed, requestedBodies };
  }

  calculateChartAspects(ephemerisResult, options = {}) {
    const {
      includeMinor = false,
      includeAngles = false,
      includeSouthNode = false,
      includeVertex = false,
      orbOverrides = {},
      orbModel = 'moiety',
    } = options;

    const { bodiesWithLonSpeed, requestedBodies } = this.resolveAspectBodies(ephemerisResult, options);

    const aspects = calculateNatalAspects(bodiesWithLonSpeed, {
      includeMinor,
      orbOverrides,
      orbModel,
      includeAngles,
      includeSouthNode,
    });

    return {
      aspects,
      settings_used: {
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        include_vertex: includeVertex,
        bodies: requestedBodies,
        orb_overrides: orbOverrides,
        orb_model: orbModel,
        node_type: ephemerisResult.node_type,
      },
    };
  }

  // Transit-to-natal aspects: current transiting bodies against the natal chart,
  // sharing the same body resolution/validation as calculate_aspects but pairing
  // across two charts via calculateCrossChartAspects (same engine as synastry).
  calculateTransitAspects(natalChart, transitChart, options = {}) {
    const {
      includeMinor = false,
      includeAngles = false,
      includeSouthNode = false,
      includeVertex = false,
      orbOverrides = {},
      orbModel = 'moiety',
    } = options;

    const { bodiesWithLonSpeed: natalBodies, requestedBodies } = this.resolveAspectBodies(natalChart, options);

    // Angles, Part of Fortune, and the Vertex are artifacts of the moment's location and time of
    // day: the transiting Ascendant sweeps the whole zodiac daily, and the transiting Vertex is
    // exactly as time-of-moment-dependent (and per the GH #6 issue, even more birth-time-sensitive
    // than the Ascendant) - so transit-side contacts to any of them change minute to minute and
    // mean nothing. include_angles/include_vertex add these to the natal side only, never as
    // transiting_body. This drop is unconditional (SUP-154) and sits *after* resolveAspectBodies's
    // shared include_angles/include_south_node/include_vertex gate (SUP-224) - it is
    // transit-side-only and must not be merged into that shared gate, which natal callers also go
    // through.
    const angleSet = new Set([...ANGLE_BODIES, 'Vertex']);
    const { bodiesWithLonSpeed: allTransitBodies } = this.resolveAspectBodies(transitChart, options);
    const transitBodies = allTransitBodies.filter((b) => !angleSet.has(b.name));

    // Natal body is a frozen snapshot for transit purposes — only the transiting body's
    // motion should drive `applying`. Zero natal speed here (never in lib/aspects.js),
    // preserving null so angles/Part of Fortune keep applying: null. See lib/aspects.js:24-25
    // for the sibling precedent (MOIETIES halving) of a comment guarding against "cleanup".
    const frozenNatalBodies = natalBodies.map((b) => ({ ...b, speed: b.speed == null ? null : 0 }));

    const aspects = calculateCrossChartAspects(transitBodies, frozenNatalBodies, {
      includeMinor,
      orbOverrides,
      orbModel,
    }).map((a) => ({
      transiting_body: a.body_a,
      natal_body: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: a.orb.toFixed(2),
      exact_angle: a.separation.toFixed(2),
      applying: a.applying,
    }));

    return {
      aspects,
      settings_used: {
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        include_vertex: includeVertex,
        bodies: requestedBodies,
        orb_overrides: orbOverrides,
        orb_model: orbModel,
        node_type: natalChart.node_type,
      },
    };
  }

  // Synastry-specific body list resolution, scoped to DEFAULT_ASPECT_BODIES only - unlike
  // resolveAspectBodies, ANGLE_BODIES/South Node don't apply here: synastry's planet-side
  // bodies come from a plain `planets` dict (not a full ephemeris result), and angle contacts
  // already go through the separate ASPECTABLE_ANGLES path gated by include_angles.
  resolveSynastryBodies(bodies) {
    const requestedBodies = Array.isArray(bodies) && bodies.length ? bodies : DEFAULT_ASPECT_BODIES;
    const knownBodies = new Set(DEFAULT_ASPECT_BODIES);
    for (const b of requestedBodies) {
      if (!knownBodies.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown body: ${b}`);
      }
    }
    return requestedBodies;
  }

  calculateSynastryAspects(person1Planets, person2Planets, options = {}) {
    const requestedBodies = this.resolveSynastryBodies(options.bodies);

    const toBodiesWithLonSpeed = (planets) => requestedBodies
      .filter((name) => planets[name])
      .map((name) => ({ name, longitude: planets[name].longitude, speed: planets[name].speed ?? null }));

    const bodiesA = toBodiesWithLonSpeed(person1Planets);
    const bodiesB = toBodiesWithLonSpeed(person2Planets);

    const aspects = calculateCrossChartAspects(bodiesA, bodiesB, options);

    return aspects.map((a) => ({
      person1_planet: a.body_a,
      person2_planet: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: a.orb.toFixed(2),
      exact_angle: a.separation.toFixed(2),
      applying: a.applying,
      person1_position: {
        longitude: person1Planets[a.body_a].longitude,
        sign: person1Planets[a.body_a].sign,
        degree: person1Planets[a.body_a].degree,
      },
      person2_position: {
        longitude: person2Planets[a.body_b].longitude,
        sign: person2Planets[a.body_b].sign,
        degree: person2Planets[a.body_b].degree,
      },
    }));
  }

  // Cross-chart aspects involving ASPECTABLE_ANGLES (Ascendant/Midheaven/Part of Fortune):
  // person1 planets -> person2 angles, person2 planets -> person1 angles, and angle-to-angle.
  // DSC/IC are excluded here - they mirror ASC/MC, so aspecting them would double-count
  // every axis contact under two labels. They remain available as computed chart points.
  calculateSynastryAngleAspects(person1Chart, person2Chart, options = {}) {
    const { includeAngles = false, includeVertex = false } = options;

    const toBodies = (chart, names) => names
      .map((name) => toAspectBody(chart, name))
      .filter(Boolean);

    const requestedBodies = this.resolveSynastryBodies(options.bodies);

    const angleBodyNames = [
      ...(includeAngles ? ASPECTABLE_ANGLES : []),
      ...(includeVertex ? ['Vertex'] : []),
    ];

    const toPlanetBodies = (chart) => toBodies(chart, requestedBodies);
    const toAngleBodies = (chart) => toBodies(chart, angleBodyNames);

    const person1Planets = toPlanetBodies(person1Chart);
    const person2Planets = toPlanetBodies(person2Chart);
    const person1Angles = toAngleBodies(person1Chart);
    const person2Angles = toAngleBodies(person2Chart);

    const crossed = [
      ...calculateCrossChartAspects(person1Planets, person2Angles, options),
      ...calculateCrossChartAspects(person1Angles, person2Planets, options),
      ...calculateCrossChartAspects(person1Angles, person2Angles, options),
    ];

    crossed.sort((a, b) => a.orb - b.orb);

    return crossed.map((a) => ({
      person1_point: a.body_a,
      person2_point: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: a.orb.toFixed(2),
      exact_angle: a.separation.toFixed(2),
      applying: a.applying,
      person1_position: toPointPosition(person1Chart, a.body_a),
      person2_position: toPointPosition(person2Chart, a.body_b),
    }));
  }

  // SUP-356: secondary progressions. See docs/tool_requests/2026-07-27_secondary-progressions.md
  // for the algorithm and lib/progressions.js for the pure angle math this orchestrates.
  //
  // Three swetest-backed ephemeris calls, all via the existing calculateEphemeris:
  //   1. natalChart      - the birth chart (also the source of natal Sun/MC for the arc).
  //   2. progressedRaw    - calculateEphemeris at progressed_datetime, but still at the
  //      NATAL coordinates. Its chart_points.Midheaven/Ascendant are the "raw" angles this
  //      tool exists to replace (spec §2) and are never surfaced, but its `planets` are the
  //      real progressed planetary positions (geocentric longitude doesn't depend on
  //      observer location), and its chart_points.ARMC is `base_ARMC` - the reference point
  //      the fictitious-longitude trick solves relative to.
  //   3. progressedFrame - calculateEphemeris at progressed_datetime again, this time with
  //      the fictitious longitude in place of birth_longitude. Its houses/chart_points are
  //      the real progressed angles/houses - see computeFictitiousLongitude for why this
  //      works (swetest's house routine only ever consumes ARMC/latitude/obliquity/system).
  calculateSecondaryProgressions(args) {
    const {
      birth_datetime,
      birth_latitude,
      birth_longitude,
      target_date,
      house_system,
      angle_method,
      house_frame,
      bodies,
      include_minor,
      include_angles,
      orb_overrides,
    } = args;

    if (!birth_datetime || typeof birth_datetime !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'birth_datetime parameter is required and must be a string');
    }
    if (typeof birth_latitude !== 'number' || birth_latitude < -90 || birth_latitude > 90) {
      throw new McpError(ErrorCode.InvalidParams, 'birth_latitude must be a number between -90 and 90');
    }
    if (typeof birth_longitude !== 'number' || birth_longitude < -180 || birth_longitude > 180) {
      throw new McpError(ErrorCode.InvalidParams, 'birth_longitude must be a number between -180 and 180');
    }
    if (!target_date || typeof target_date !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'target_date parameter is required and must be a string');
    }

    const birthDate = new Date(birth_datetime);
    if (isNaN(birthDate.getTime())) {
      throw new McpError(ErrorCode.InvalidParams, 'birth_datetime must be a valid ISO8601 datetime');
    }
    const targetDate = new Date(target_date);
    if (isNaN(targetDate.getTime())) {
      throw new McpError(ErrorCode.InvalidParams, 'target_date must be a valid ISO8601 datetime');
    }

    if (include_minor !== undefined && typeof include_minor !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
    }
    if (include_angles !== undefined && typeof include_angles !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
    }
    if (bodies !== undefined && (!Array.isArray(bodies) || !bodies.every((b) => typeof b === 'string'))) {
      throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
    }
    if (orb_overrides !== undefined && (typeof orb_overrides !== 'object' || orb_overrides === null || Array.isArray(orb_overrides))) {
      throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
    }

    const validatedHouseSystem = validateHouseSystem(house_system);
    const validatedAngleMethod = validateAngleMethod(angle_method);
    const validatedHouseFrame = validateHouseFrame(house_frame);
    const includeMinor = include_minor ?? false;
    const includeAngles = include_angles ?? true;
    const requestedBodies = this.resolveSynastryBodies(bodies);

    const natalChart = this.calculateEphemeris(birth_datetime, birth_latitude, birth_longitude, validatedHouseSystem);

    const elapsedYears = computeElapsedYears(birthDate, targetDate);
    const progressedDate = computeProgressedDate(birthDate, elapsedYears);
    const progressedDatetime = formatProgressedDatetime(progressedDate);

    const progressedRaw = this.calculateEphemeris(progressedDatetime, birth_latitude, birth_longitude, validatedHouseSystem);

    const arcDegrees = computeArcDegrees(validatedAngleMethod, {
      natalSunLongitude: natalChart.planets.Sun.longitude,
      progressedSunLongitude: progressedRaw.planets.Sun.longitude,
      elapsedYears,
    });
    const progressedMcLongitude = (natalChart.chart_points.Midheaven.longitude + arcDegrees) % 360;
    const fictitiousLongitude = computeFictitiousLongitude({
      progressedMcLongitude,
      obliquityDeg: progressedRaw.obliquity,
      baseArmc: progressedRaw.chart_points.ARMC.longitude,
      natalLongitude: birth_longitude,
    });

    const progressedFrame = this.calculateEphemeris(progressedDatetime, birth_latitude, fictitiousLongitude, validatedHouseSystem);

    const progressedPlanets = {};
    for (const name of requestedBodies) {
      const planet = progressedRaw.planets[name];
      if (!planet) continue;
      progressedPlanets[name] = {
        longitude: planet.longitude,
        sign: planet.sign,
        degree: planet.degree,
        speed: planet.speed,
        retrograde: (planet.speed ?? 0) < 0,
      };
    }

    const progressedHouses = validatedHouseFrame === 'natal' ? natalChart.houses : progressedFrame.houses;
    const progressedAngles = {
      Ascendant: toPointPosition(progressedFrame, 'Ascendant'),
      Midheaven: toPointPosition(progressedFrame, 'Midheaven'),
      IC: toPointPosition(progressedFrame, 'IC'),
      Descendant: toPointPosition(progressedFrame, 'Descendant'),
    };

    // Natal side reuses the shared gate (natal Ascendant/Midheaven/Part of Fortune when
    // includeAngles) - same as calculate_transits. Progressed side is built by hand below:
    // unlike calculateTransitAspects, progressed Ascendant/Midheaven must stay aspectable
    // (SUP-356 advisory comment #2) - and progressed Part of Fortune is deliberately never
    // included, sect convention for a progressed chart being unsettled.
    const { bodiesWithLonSpeed: natalBodies } = this.resolveAspectBodies(natalChart, {
      includeAngles,
      bodies: requestedBodies,
      orbOverrides: orb_overrides,
    });
    const frozenNatalBodies = natalBodies.map((b) => ({ ...b, speed: b.speed == null ? null : 0 }));

    const progressedPlanetBodies = requestedBodies
      .filter((name) => progressedRaw.planets[name])
      .map((name) => ({ name, longitude: progressedRaw.planets[name].longitude, speed: progressedRaw.planets[name].speed ?? null }));
    const progressedAngleBodies = includeAngles
      ? ['Ascendant', 'Midheaven']
        .filter((name) => progressedFrame.chart_points[name])
        .map((name) => ({ name, longitude: progressedFrame.chart_points[name].longitude, speed: null }))
      : [];
    const progressedBodies = [...progressedPlanetBodies, ...progressedAngleBodies];

    const aspectsToNatal = calculateCrossChartAspects(progressedBodies, frozenNatalBodies, {
      includeMinor,
      orbOverrides: orb_overrides,
    }).map((a) => ({
      progressed_body: a.body_a,
      natal_body: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: Math.round(a.orb * 100) / 100,
      exact_angle: Math.round(a.separation * 100) / 100,
      applying: a.applying,
    }));

    return {
      progressed_datetime: progressedDatetime,
      elapsed_years: elapsedYears,
      year_length_days: TROPICAL_YEAR_DAYS,
      progressed_planets: progressedPlanets,
      progressed_houses: progressedHouses,
      progressed_angles: progressedAngles,
      angle_method_used: validatedAngleMethod,
      house_frame_used: validatedHouseFrame,
      aspects_to_natal: aspectsToNatal,
      natal_chart: natalChart,
      ephemeris_version: getEphemerisVersion(),
    };
  }

  // find_events (SUP-349 §3/§5 steps 5-6, extended by SUP-357/SUP-359 for `rate`): the MCP
  // surface over lib/event-search.js's rate-agnostic engine (SUP-350). Adds no search logic
  // of its own - every date comes from
  // scanTransitingBody/findContacts/findStations/findCrossings/findLunations, called once
  // per moving body (the coarse scan and its stations/segments are reused across that
  // body's contacts and ingresses) and once overall for lunations. `rate:
  // "secondary_progression"` swaps in a position provider over the day-for-a-year
  // technique (lib/progressed-provider.js plus the progressed-frame helpers below) feeding
  // the exact same engine - see the SUP-357 spec for the full ruling this implements.
  findEvents(args) {
    const {
      birth_datetime,
      latitude,
      longitude,
      window_start,
      window_end,
      event_types,
      rate,
      angle_method,
      house_frame,
      house_system,
      bodies,
      targets,
      include_minor,
      include_angles,
      include_south_node,
      include_vertex,
      include_quarter_moons,
      orb_overrides,
      orb_model,
    } = args;

    if (!birth_datetime || typeof birth_datetime !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'birth_datetime parameter is required and must be a string');
    }
    const birthDate = new Date(birth_datetime);
    if (isNaN(birthDate.getTime())) {
      throw new McpError(ErrorCode.InvalidParams, 'birth_datetime must be a valid ISO8601 datetime');
    }
    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
      throw new McpError(ErrorCode.InvalidParams, 'latitude must be a number between -90 and 90');
    }
    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
      throw new McpError(ErrorCode.InvalidParams, 'longitude must be a number between -180 and 180');
    }
    if (!window_start || typeof window_start !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'window_start parameter is required and must be a string');
    }
    if (!window_end || typeof window_end !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'window_end parameter is required and must be a string');
    }

    const windowStartDate = new Date(window_start);
    if (isNaN(windowStartDate.getTime())) {
      throw new McpError(ErrorCode.InvalidParams, 'window_start must be a valid ISO8601 datetime');
    }
    const windowEndDate = new Date(window_end);
    if (isNaN(windowEndDate.getTime())) {
      throw new McpError(ErrorCode.InvalidParams, 'window_end must be a valid ISO8601 datetime');
    }
    if (windowEndDate <= windowStartDate) {
      throw new McpError(ErrorCode.InvalidParams, 'window_end must be after window_start');
    }

    const validatedRate = validateRate(rate);
    const isProgressed = validatedRate === 'secondary_progression';
    // angle_method/house_frame are SUP-356 concepts - meaningless (and silently ignorable)
    // at the transit rate, so reject rather than ignore (spec §3).
    if (!isProgressed && (angle_method !== undefined || house_frame !== undefined)) {
      throw new McpError(ErrorCode.InvalidParams, 'angle_method and house_frame require rate: "secondary_progression"');
    }
    const validatedAngleMethod = isProgressed ? validateAngleMethod(angle_method) : undefined;
    const validatedHouseFrame = isProgressed ? validateHouseFrame(house_frame) : undefined;
    // A window starting before birth is arithmetically a CONVERSE progression (birth-ward
    // rather than forward), a distinct technique this ticket doesn't offer - reject it
    // rather than silently computing negative elapsed years (spec §3).
    if (isProgressed && windowStartDate < birthDate) {
      throw new McpError(ErrorCode.InvalidParams, 'window_start must not precede birth_datetime at rate: "secondary_progression" (that would be a converse progression, not offered yet)');
    }

    if (include_minor !== undefined && typeof include_minor !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
    }
    if (include_angles !== undefined && typeof include_angles !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
    }
    if (include_south_node !== undefined && typeof include_south_node !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_south_node must be a boolean');
    }
    if (include_vertex !== undefined && typeof include_vertex !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_vertex must be a boolean');
    }
    if (include_quarter_moons !== undefined && typeof include_quarter_moons !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_quarter_moons must be a boolean');
    }
    if (bodies !== undefined && (!Array.isArray(bodies) || !bodies.every((b) => typeof b === 'string'))) {
      throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
    }
    if (targets !== undefined && (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string'))) {
      throw new McpError(ErrorCode.InvalidParams, 'targets must be an array of strings');
    }
    if (orb_overrides !== undefined && (typeof orb_overrides !== 'object' || orb_overrides === null || Array.isArray(orb_overrides))) {
      throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
    }
    validateOrbModel(orb_model);

    const validatedHouseSystem = validateHouseSystem(house_system);
    const validatedEventTypes = validateEventTypes(event_types);

    const defaultTransitingBodies = DEFAULT_TRANSITING_BODIES_BY_RATE[validatedRate];
    const requestedTransitingBodies = Array.isArray(bodies) && bodies.length ? [...new Set(bodies)] : defaultTransitingBodies;
    for (const b of requestedTransitingBodies) {
      if (!EVENT_TRANSITING_BODIES.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown transiting body: ${b}`);
      }
    }

    const includeMinor = include_minor ?? false;
    const includeAngles = include_angles ?? isProgressed;
    const includeSouthNode = include_south_node ?? false;
    const includeVertex = include_vertex ?? false;
    const includeQuarterMoons = include_quarter_moons ?? isProgressed;
    const orbOverrides = orb_overrides ?? {};
    const orbModel = orb_model ?? (isProgressed ? 'fixed' : 'moiety');

    // Window cap (spec Q9, rate-keyed by SUP-357/SUP-359 §2/§8) - clamp rather than
    // reject, but say so (window.truncated) rather than silently searching a shorter span
    // than what was asked for.
    const maxWindowDays = MAX_EVENT_WINDOW_DAYS_BY_RATE[validatedRate];
    let effectiveEndDate = windowEndDate;
    let windowTruncated = false;
    const requestedWindowDays = (windowEndDate - windowStartDate) / 86400000;
    if (requestedWindowDays > maxWindowDays) {
      effectiveEndDate = new Date(windowStartDate.getTime() + maxWindowDays * 86400000);
      windowTruncated = true;
    }

    const natalChart = this.calculateEphemeris(birth_datetime, latitude, longitude, validatedHouseSystem);
    const { bodiesWithLonSpeed: natalTargets, requestedBodies: requestedTargets } = this.resolveAspectBodies(natalChart, {
      includeAngles,
      includeSouthNode,
      includeVertex,
      bodies: targets,
      orbOverrides,
      orbModel,
    });

    const aspectSettings = resolveAspectSettings({ includeMinor, orbOverrides, orbModel });
    const aspectDefs = aspectSettings.aspectDefs;
    const natalOrbAllowedFor = (transitingBody) => (targetName, aspectName) =>
      orbAllowedFor(aspectSettings, transitingBody, targetName, aspectName);

    const startJd = jdFromDate(windowStartDate);
    const endJd = jdFromDate(effectiveEndDate);
    const birthJd = jdFromDate(birthDate);
    const yearLengthDays = TROPICAL_YEAR_DAYS;
    // 1.0 day of ephemeris time (spec §1.2 - the rule transfers unchanged from the
    // transit rate because progression is a uniform time dilation), expressed as a
    // target-time step: at the transit rate that's just 1 day; at the progressed rate a
    // step of `yearLengthDays` target-days maps back to exactly 1 ephemeris day.
    const scanStepDays = isProgressed ? yearLengthDays : 1;

    // Natal cusps, resolved once - house_ingress targets (under house_frame "natal", the
    // only frame the transit rate has) and the Whole Sign coincidence flag (spec Q6) both
    // key off these, never off the house_system code directly.
    const cusps = [];
    for (let house = 1; house <= 12; house++) {
      const cuspLongitude = natalChart.houses[house].longitude;
      const nearestSignBoundary = Math.round(cuspLongitude / 30) * 30;
      const coincidesWithSignIngress = Math.abs(wrap180(cuspLongitude - nearestSignBoundary)) < 1 / 3600;
      cusps.push({ house, longitude: cuspLongitude, coincidesWithSignIngress });
    }

    const providerFor = (body) => (isProgressed
      ? progressedBodyProvider(body, { birthJd, yearLengthDays })
      : transitProviderFor(body));

    // Progressed Midheaven/Ascendant/moving-cusp machinery (SUP-357/SUP-359 §4) - built
    // only when needed. mcProvider is pure arithmetic (lib/progressed-provider.js, reusing
    // the progressed Sun's own speed under solar_arc); the Ascendant and moving cusps need
    // an actual swetest -house lookup (obliquity + ARMC + the fictitious-longitude trick
    // computeFictitiousLongitude derives - see calculate_secondary_progressions, which
    // this mirrors exactly), memoized per whole EPHEMERIS second since calculateEphemeris
    // truncates to that resolution internally regardless (formatTimeToSwiss reads whole
    // UTC seconds), so caching at that granularity loses no precision it didn't already
    // have and collapses the many nearby bisection queries refinement performs into a
    // handful of actual swetest spawns.
    let mcProvider = null;
    let ascProvider = null;
    let progressedFrameAt = null;
    if (isProgressed) {
      const progressedSunProvider = providerFor('Sun');
      mcProvider = progressedMcProvider({
        angleMethod: validatedAngleMethod,
        natalMcLongitude: natalChart.chart_points.Midheaven.longitude,
        natalSunLongitude: natalChart.planets.Sun.longitude,
        birthJd, yearLengthDays,
        sunProvider: progressedSunProvider,
      });

      const frameCache = new Map();
      progressedFrameAt = (targetJd) => {
        const ephJd = ephemerisJdForTarget(targetJd, birthJd, yearLengthDays);
        const bucketKey = Math.round(ephJd * 86400);
        if (frameCache.has(bucketKey)) return frameCache.get(bucketKey);

        const progressedDatetimeIso = dateFromJd(ephJd).toISOString();
        const mcLongitude = mcProvider.positionAt(targetJd).longitude;
        const progressedRaw = this.calculateEphemeris(progressedDatetimeIso, latitude, longitude, validatedHouseSystem);
        const fictitiousLongitude = computeFictitiousLongitude({
          progressedMcLongitude: mcLongitude,
          obliquityDeg: progressedRaw.obliquity,
          baseArmc: progressedRaw.chart_points.ARMC.longitude,
          natalLongitude: longitude,
        });
        const progressedFrame = this.calculateEphemeris(progressedDatetimeIso, latitude, fictitiousLongitude, validatedHouseSystem);
        const frame = { ascendant: progressedFrame.chart_points.Ascendant.longitude, houses: progressedFrame.houses };
        frameCache.set(bucketKey, frame);
        return frame;
      };
      ascProvider = ascendantProviderFor(progressedFrameAt);
    }

    // Birth-time sensitivity, quantified (spec §1.3) - progressed mode only. One extra
    // natal chart at birth + 1 minute yields the degrees-per-birth-minute shift for all
    // four angles and all twelve cusps at once; `elapsedYears`/arc's own dependence on
    // birth TIME (as opposed to birth DATE) is negligible (~1 part in 5*10^5), so this
    // natal-chart shift stands in for the progressed angles' shift too rather than needing
    // a second progressed-frame computation.
    const angleShiftPerMinute = {};
    const cuspShiftPerMinute = {};
    if (isProgressed) {
      const shiftedBirthDate = new Date(birthDate.getTime() + 60000);
      const shiftedChart = this.calculateEphemeris(shiftedBirthDate.toISOString(), latitude, longitude, validatedHouseSystem);
      for (const name of BIRTH_TIME_SENSITIVE_TARGETS) {
        const before = resolveChartPoint(natalChart, name);
        const after = resolveChartPoint(shiftedChart, name);
        if (before && after) angleShiftPerMinute[name] = Math.abs(wrap180(after.longitude - before.longitude));
      }
      for (let house = 1; house <= 12; house++) {
        cuspShiftPerMinute[house] = Math.abs(wrap180(shiftedChart.houses[house].longitude - natalChart.houses[house].longitude));
      }
    }

    const contacts = [];
    const events = [];

    // Shared aspect-episode builder for both real moving bodies and (progressed-mode only)
    // the Ascendant/Midheaven pseudo-sources below - same output shape either way,
    // `settings_used.rate` is what tells a caller which one produced a given row (spec §5:
    // one `transiting_body` key, not a per-mode rename, so no consumer has to branch).
    const buildAspectContacts = (bodyName, provider, segments, stations) => {
      const rows = [];
      for (const target of natalTargets) {
        for (const [aspectName, aspectAngle] of Object.entries(aspectDefs)) {
          const orbAllowed = orbAllowedFor(aspectSettings, bodyName, target.name, aspectName);
          const category = Object.hasOwn(MAJOR_ASPECTS, aspectName) ? 'major' : 'minor';

          // A square/sextile/trine (and their minor-aspect equivalents) has TWO target
          // longitudes 180deg apart - natal+angle and natal-angle - that are equally
          // "square"/"sextile"/"trine"; conjunction (0) and opposition (180) are the
          // only angles where those coincide. findContacts searches one fixed target
          // per call, so both must be searched for every other angle or a fast body
          // (e.g. Mars, which can reach both sides within a single-year window) would
          // silently lose whichever side isn't natal+angle. `aspect_angle` on the
          // output always reports the canonical dict value (e.g. 90 for square), never
          // 270, matching how calculate_aspects/calculate_transits label both sides.
          const searchAngles = (aspectAngle === 0 || aspectAngle === 180)
            ? [aspectAngle]
            : [aspectAngle, 360 - aspectAngle];

          for (const searchAngle of searchAngles) {
            for (const contact of findContacts({
              provider, segments, stations,
              natalLongitude: target.longitude, aspectAngle: searchAngle, orbAllowed,
              startJd, endJd,
            })) {
              const targetSensitive = BIRTH_TIME_SENSITIVE_TARGETS.has(target.name);
              const bodySensitive = ANGLE_SOURCE_NAMES.has(bodyName);
              const row = {
                transiting_body: bodyName,
                natal_point: target.name,
                aspect: aspectName,
                category,
                aspect_angle: aspectAngle,
                orb_allowed: contact.orb_allowed,
                enters_orb: contact.enters_orb,
                leaves_orb: contact.leaves_orb,
                passes: contact.passes.map(({ jd, ...pass }) => pass),
                closest_approach: contact.closest_approach,
                birth_time_sensitive: targetSensitive || bodySensitive,
                enters_orb_truncated: contact.enters_orb_truncated,
                leaves_orb_truncated: contact.leaves_orb_truncated,
              };
              if (isProgressed && (targetSensitive || bodySensitive)) {
                const shiftDeg = (targetSensitive ? (angleShiftPerMinute[target.name] ?? 0) : 0)
                  + (bodySensitive ? (angleShiftPerMinute[bodyName] ?? 0) : 0);
                // Evaluated AT THE CONTACT, not at window start or some fixed reference -
                // the spec's own formula says "relative rate at the contact", and for a
                // point like the progressed Ascendant that matters: its rate is far from
                // constant across a lifetime (2.4 deg/yr near birth, ~1.1 deg/yr by age
                // 32.5 for DAY_CHART - unlike the Sun/Midheaven, whose progressed rate
                // barely moves), so a single per-body reference would misstate it for
                // most of the search window.
                const contactRate = Math.abs(provider.positionAt(jdFromDate(new Date(contact.closest_approach.datetime))).speed);
                if (shiftDeg > 0 && contactRate > RATE_EPSILON) row.date_uncertainty_days_per_birth_minute = shiftDeg / contactRate;
              }
              rows.push(row);
            }
          }
        }
      }
      return rows;
    };

    // Station search (spec ruling #4/§8): at the transit rate, unchanged - only bodies
    // both requested and station-capable. At the progressed rate, independent of `bodies`
    // entirely - a body stations at most 0-2 times per lifetime by progression, so volume
    // is a non-issue, and this is what lets the narrowed progressed moving-set default
    // (Sun/Moon/Mercury/Venus/Mars) coexist with real outer-planet progressed stations
    // (Jupiter, Pluto - see spec §6.2) without a schema change.
    const stationBodies = isProgressed
      ? STATION_CAPABLE_BODIES
      : new Set(requestedTransitingBodies.filter((b) => STATION_CAPABLE_BODIES.has(b)));
    const needsStations = validatedEventTypes.includes('station');
    const allScanBodies = needsStations
      ? [...new Set([...requestedTransitingBodies, ...stationBodies])]
      : requestedTransitingBodies;

    // Lunations are Sun-Moon relative and don't depend on the per-body loop below, so
    // their scan is skipped entirely when both are excluded from event_types. Likewise the
    // per-body coarse scan itself (segments/stations) is only needed for aspect/ingress -
    // a station-only search has no use for it (findStations below re-scans on its own),
    // so skipping it here matters more than it did pre-SUP-359: station search is now
    // independent of `bodies` and can cover many more bodies than were actually requested.
    const needsMovingSideScan = validatedEventTypes.includes('aspect')
      || validatedEventTypes.includes('sign_ingress')
      || validatedEventTypes.includes('house_ingress');
    const needsBodyScan = needsMovingSideScan || needsStations;

    if (needsBodyScan) {
      for (const body of allScanBodies) {
        const provider = providerFor(body);
        const isRequested = needsMovingSideScan && requestedTransitingBodies.includes(body);

        if (isRequested) {
          const { segments, stations } = scanTransitingBody(provider, startJd, endJd, scanStepDays);

          if (validatedEventTypes.includes('aspect')) {
            contacts.push(...buildAspectContacts(body, provider, segments, stations));
          }

          if (validatedEventTypes.includes('sign_ingress')) {
            for (let k = 0; k < 12; k++) {
              for (const crossing of findCrossings(provider, segments, k * 30)) {
                const direct = !crossing.retrograde;
                const nudge = direct ? INGRESS_EPSILON_DEG : -INGRESS_EPSILON_DEG;
                events.push({
                  type: 'sign_ingress',
                  datetime: crossing.datetime,
                  body,
                  direction: direct ? 'direct' : 'retrograde',
                  from_sign: EVENT_SIGNS[signIndexForLongitude(crossing.longitude - nudge)],
                  to_sign: EVENT_SIGNS[signIndexForLongitude(crossing.longitude + nudge)],
                  longitude: crossing.longitude,
                });
              }
            }
          }

          if (validatedEventTypes.includes('house_ingress')) {
            if (!isProgressed || validatedHouseFrame === 'natal') {
              // Fixed natal cusps - same search either way; house_ingress is birth-time
              // derived in both modes (spec §1.3/§8 retrofit item 5 - natal cusps are as
              // birth-time-sensitive as the Ascendant, a gap that existed in transit mode
              // too), so the boolean is unconditional and the quantified figure is added
              // only where it's required (progressed mode).
              for (const cusp of cusps) {
                for (const crossing of findCrossings(provider, segments, cusp.longitude)) {
                  const direct = !crossing.retrograde;
                  const nudge = direct ? INGRESS_EPSILON_DEG : -INGRESS_EPSILON_DEG;
                  const event = {
                    type: 'house_ingress',
                    datetime: crossing.datetime,
                    body,
                    direction: direct ? 'direct' : 'retrograde',
                    from_house: findHouseForLongitude(crossing.longitude - nudge, natalChart.houses),
                    to_house: findHouseForLongitude(crossing.longitude + nudge, natalChart.houses),
                    cusp_longitude: cusp.longitude,
                    house_system: validatedHouseSystem,
                    coincides_with_sign_ingress: cusp.coincidesWithSignIngress,
                    birth_time_sensitive: true,
                  };
                  if (isProgressed) {
                    const eventRate = Math.abs(crossing.speed);
                    if (eventRate > RATE_EPSILON) event.date_uncertainty_days_per_birth_minute = cuspShiftPerMinute[cusp.house] / eventRate;
                  }
                  events.push(event);
                }
              }
            } else {
              // house_frame: "progressed" - the cusps move too (spec §1.1.1): a relative
              // provider over body(t) - cusp_i(t), segmented at ITS OWN stationary points,
              // so `direction` reflects the relative rate's sign rather than the body's own.
              for (let house = 1; house <= 12; house++) {
                const cuspProvider = cuspProviderFor(progressedFrameAt, house);
                const relative = relativeMovingProvider(provider, cuspProvider);
                const { segments: relativeSegments } = scanTransitingBody(relative, startJd, endJd, scanStepDays);

                for (const crossing of findCrossings(relative, relativeSegments, 0)) {
                  const direct = !crossing.retrograde;
                  const nudge = direct ? INGRESS_EPSILON_DEG : -INGRESS_EPSILON_DEG;
                  const bodyLongitude = provider.positionAt(crossing.jd).longitude;
                  const housesAtCrossing = progressedFrameAt(crossing.jd).houses;
                  const cuspLongitude = cuspProvider.positionAt(crossing.jd).longitude;
                  const nearestSignBoundary = Math.round(cuspLongitude / 30) * 30;
                  const eventRate = Math.abs(crossing.speed);
                  const event = {
                    type: 'house_ingress',
                    datetime: crossing.datetime,
                    body,
                    direction: direct ? 'direct' : 'retrograde',
                    from_house: findHouseForLongitude(bodyLongitude - nudge, housesAtCrossing),
                    to_house: findHouseForLongitude(bodyLongitude + nudge, housesAtCrossing),
                    cusp_longitude: cuspLongitude,
                    house_system: validatedHouseSystem,
                    coincides_with_sign_ingress: Math.abs(wrap180(cuspLongitude - nearestSignBoundary)) < 1 / 3600,
                    birth_time_sensitive: true,
                  };
                  if (eventRate > RATE_EPSILON) event.date_uncertainty_days_per_birth_minute = cuspShiftPerMinute[house] / eventRate;
                  events.push(event);
                }
              }
            }
          }
        }

        if (needsStations && stationBodies.has(body)) {
          for (const { jd, ...station } of findStations(provider, startJd, endJd, scanStepDays)) {
            events.push({
              ...station,
              body,
              natal_contacts: natalContactsFor(station.longitude, natalTargets, aspectDefs, natalOrbAllowedFor(body)),
            });
          }
        }
      }
    }

    // Progressed Ascendant/Midheaven as moving-side aspect sources (spec §1.3/§4): the
    // headline output at this rate, matching calculate_secondary_progressions'
    // aspects_to_natal asymmetry exactly - never sources for station/ingress (they're not
    // real bodies to begin with), and progressed Part of Fortune is never a source either
    // (which day/night formula applies to a progressed sect is unsettled).
    if (isProgressed && includeAngles && validatedEventTypes.includes('aspect')) {
      for (const name of ANGLE_SOURCE_NAMES) {
        const provider = name === 'Midheaven' ? mcProvider : ascProvider;
        const { segments, stations } = scanTransitingBody(provider, startJd, endJd, scanStepDays);
        contacts.push(...buildAspectContacts(name, provider, segments, stations));
      }
    }

    if (validatedEventTypes.includes('lunation')) {
      const sunProvider = providerFor('Sun');
      const moonProvider = providerFor('Moon');
      const rawLunations = findLunations({ sunProvider, moonProvider, startJd, endJd, includeQuarterMoons, stepDays: scanStepDays });
      // Eclipse annotation is routed off entirely at the progressed rate, not called and
      // discarded (spec §1.1): eclipsesFor would still spawn a real solar/lunar eclipse
      // search for whatever near-term calendar window the progressed instants happen to
      // fall in, and annotateEclipses' tolerance-based matching could silently attach one
      // of those real eclipses to an unrelated progressed syzygy. No progressed lunation
      // may ever carry an `eclipse` key - structurally absent, not just unpopulated.
      const lunations = isProgressed
        ? rawLunations
        : annotateEclipses(rawLunations, {
          solarEclipses: eclipsesFor('solar', startJd, endJd),
          lunarEclipses: eclipsesFor('lunar', startJd, endJd),
        });

      for (const { jd, ...lunation } of lunations) {
        events.push({
          ...lunation,
          natal_contacts: natalContactsFor(lunation.longitude, natalTargets, aspectDefs, natalOrbAllowedFor('Moon')),
        });
      }
    }

    contacts.sort((a, b) => new Date(a.enters_orb) - new Date(b.enters_orb));
    events.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    return {
      window: {
        start: window_start,
        end: windowTruncated ? effectiveEndDate.toISOString().replace(/\.\d{3}Z$/, 'Z') : window_end,
        truncated: windowTruncated,
      },
      contacts,
      events,
      settings_used: {
        event_types: validatedEventTypes,
        rate: validatedRate,
        bodies: requestedTransitingBodies,
        targets: requestedTargets,
        house_system: validatedHouseSystem,
        orb_model: orbModel,
        orb_overrides: orbOverrides,
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        include_vertex: includeVertex,
        include_quarter_moons: includeQuarterMoons,
        node_type: 'true',
        ...(isProgressed ? {
          angle_method_used: validatedAngleMethod,
          house_frame_used: validatedHouseFrame,
          year_length_days: yearLengthDays,
        } : {}),
      },
    };
  }

  async handleToolCall(name, args) {
    switch (name) {
      case 'calculate_planetary_positions':
        const { datetime, latitude, longitude, house_system, node_type: pp_node_type } = args;

        if (!datetime || typeof datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'datetime parameter is required and must be a string'
          );
        }
        
        if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'latitude must be a number between -90 and 90'
          );
        }
        
        if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'longitude must be a number between -180 and 180'
          );
        }

        return this.calculateEphemeris(datetime, latitude, longitude, validateHouseSystem(house_system), validateNodeType(pp_node_type));

      case 'calculate_transits':
        const {
          birth_datetime,
          latitude: birth_latitude,
          longitude: birth_longitude,
          house_system: transit_house_system,
          node_type: transit_node_type,
          include_minor: transit_include_minor,
          include_angles: transit_include_angles,
          include_south_node: transit_include_south_node,
          include_vertex: transit_include_vertex,
          bodies: transit_bodies,
          orb_overrides: transit_orb_overrides,
          orb_model: transit_orb_model,
        } = args;

        if (!birth_datetime || typeof birth_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_datetime parameter is required and must be a string'
          );
        }

        if (typeof birth_latitude !== 'number' || birth_latitude < -90 || birth_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_latitude must be a number between -90 and 90'
          );
        }

        if (typeof birth_longitude !== 'number' || birth_longitude < -180 || birth_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_longitude must be a number between -180 and 180'
          );
        }

        if (transit_include_minor !== undefined && typeof transit_include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (transit_include_angles !== undefined && typeof transit_include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (transit_include_south_node !== undefined && typeof transit_include_south_node !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_south_node must be a boolean');
        }

        if (transit_include_vertex !== undefined && typeof transit_include_vertex !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_vertex must be a boolean');
        }

        if (transit_bodies !== undefined && (!Array.isArray(transit_bodies) || !transit_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (transit_orb_overrides !== undefined && (typeof transit_orb_overrides !== 'object' || transit_orb_overrides === null || Array.isArray(transit_orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        validateOrbModel(transit_orb_model);

        const validatedTransitHouseSystem = validateHouseSystem(transit_house_system);
        const validatedTransitNodeType = validateNodeType(transit_node_type);

        // Calculate birth chart
        const natalChart = this.calculateEphemeris(birth_datetime, birth_latitude, birth_longitude, validatedTransitHouseSystem, validatedTransitNodeType);

         // Calculate current transits
         const currentDate = new Date();
         const currentISOString = currentDate.toISOString();
         const currentEphemeris = this.calculateEphemeris(currentISOString, birth_latitude, birth_longitude, validatedTransitHouseSystem, validatedTransitNodeType);

         const { aspects: transitAspects, settings_used: transitSettingsUsed } = this.calculateTransitAspects(natalChart, currentEphemeris, {
           includeMinor: transit_include_minor,
           includeAngles: transit_include_angles,
           includeSouthNode: transit_include_south_node,
           includeVertex: transit_include_vertex,
           bodies: transit_bodies,
           orbOverrides: transit_orb_overrides,
           orbModel: transit_orb_model,
         });

         return {
           natal_chart: natalChart,
           current_transits: currentEphemeris,
           transit_aspects: transitAspects,
           settings_used: transitSettingsUsed,
           calculation_time: currentISOString
         };

      case 'calculate_solar_revolution':
        const { birth_datetime: sr_birth_datetime, birth_latitude: sr_birth_latitude, birth_longitude: sr_birth_longitude, return_year, return_latitude, return_longitude, house_system: sr_house_system, node_type: sr_node_type } = args;

        if (!sr_birth_datetime || typeof sr_birth_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_datetime parameter is required and must be a string'
          );
        }

        if (typeof sr_birth_latitude !== 'number' || sr_birth_latitude < -90 || sr_birth_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_latitude must be a number between -90 and 90'
          );
        }

        if (typeof sr_birth_longitude !== 'number' || sr_birth_longitude < -180 || sr_birth_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_longitude must be a number between -180 and 180'
          );
        }

        if (typeof return_year !== 'number' || return_year < 1900 || return_year > 2100) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'return_year must be a number between 1900 and 2100'
          );
        }

        const validatedSrHouseSystem = validateHouseSystem(sr_house_system);
        const validatedSrNodeType = validateNodeType(sr_node_type);

        // Calculate birth chart to get natal Sun position
        const srNatalChart = this.calculateEphemeris(sr_birth_datetime, sr_birth_latitude, sr_birth_longitude, validatedSrHouseSystem, validatedSrNodeType);
        const natalSunLongitude = srNatalChart.planets.Sun.longitude;

        // Calculate solar return chart for the given year
        // Use the birthday in the return year as a starting point
        const birthDate = new Date(sr_birth_datetime);
        const returnDate = new Date(return_year, birthDate.getMonth(), birthDate.getDate(), birthDate.getHours(), birthDate.getMinutes(), birthDate.getSeconds());

        // Use return location if provided, otherwise use birth location
        const returnLat = return_latitude !== undefined ? return_latitude : sr_birth_latitude;
        const returnLon = return_longitude !== undefined ? return_longitude : sr_birth_longitude;

        // Calculate the solar return chart at the approximate return date
        const solarReturnChart = this.calculateEphemeris(returnDate.toISOString(), returnLat, returnLon, validatedSrHouseSystem, validatedSrNodeType);

        return {
          natal_chart: srNatalChart,
          solar_return_chart: {
            planets: solarReturnChart.planets,
            houses: solarReturnChart.houses,
            chart_points: solarReturnChart.chart_points,
            additional_points: solarReturnChart.additional_points,
            datetime: returnDate.toISOString(),
            coordinates: {
              latitude: returnLat,
              longitude: returnLon
            },
            house_system: validatedSrHouseSystem,
            node_type: validatedSrNodeType
          },
          natal_sun_longitude: natalSunLongitude,
          return_sun_longitude: solarReturnChart.planets.Sun.longitude,
          calculation_time: new Date().toISOString()
        };

      case 'calculate_synastry':
        const { person1_datetime, person1_latitude, person1_longitude, person2_datetime, person2_latitude, person2_longitude, include_minor: synastry_include_minor, include_angles: synastry_include_angles, include_vertex: synastry_include_vertex, bodies: synastry_bodies, orb_overrides: synastry_orb_overrides, orb_model: synastry_orb_model, person1_house_system, person2_house_system, node_type: synastry_node_type } = args;

        if (synastry_include_minor !== undefined && typeof synastry_include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (synastry_include_angles !== undefined && typeof synastry_include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (synastry_include_vertex !== undefined && typeof synastry_include_vertex !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_vertex must be a boolean');
        }

        if (synastry_bodies !== undefined && (!Array.isArray(synastry_bodies) || !synastry_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (synastry_orb_overrides !== undefined && (typeof synastry_orb_overrides !== 'object' || synastry_orb_overrides === null || Array.isArray(synastry_orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        if (synastry_orb_overrides !== undefined) {
          const invalidSynastryOrbKeys = invalidOrbOverrideKeys(synastry_orb_overrides, synastry_orb_model);
          if (invalidSynastryOrbKeys.length) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${invalidSynastryOrbKeys[0]}`);
          }
        }

        validateOrbModel(synastry_orb_model);
        const validatedSynastryNodeType = validateNodeType(synastry_node_type);

        if (!person1_datetime || typeof person1_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person1_datetime parameter is required and must be a string'
          );
        }

        if (typeof person1_latitude !== 'number' || person1_latitude < -90 || person1_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person1_latitude must be a number between -90 and 90'
          );
        }

        if (typeof person1_longitude !== 'number' || person1_longitude < -180 || person1_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person1_longitude must be a number between -180 and 180'
          );
        }

        if (!person2_datetime || typeof person2_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person2_datetime parameter is required and must be a string'
          );
        }

        if (typeof person2_latitude !== 'number' || person2_latitude < -90 || person2_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person2_latitude must be a number between -90 and 90'
          );
        }

        if (typeof person2_longitude !== 'number' || person2_longitude < -180 || person2_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person2_longitude must be a number between -180 and 180'
          );
        }

        // Calculate person 1's natal chart
        const person1NatalChart = this.calculateEphemeris(person1_datetime, person1_latitude, person1_longitude, validateHouseSystem(person1_house_system, 'person1_house_system'), validatedSynastryNodeType);

        // Calculate person 2's natal chart
        const person2NatalChart = this.calculateEphemeris(person2_datetime, person2_latitude, person2_longitude, validateHouseSystem(person2_house_system, 'person2_house_system'), validatedSynastryNodeType);

        // Calculate aspects between the two charts
        const aspects = this.calculateSynastryAspects(person1NatalChart.planets, person2NatalChart.planets, {
          includeMinor: synastry_include_minor,
          bodies: synastry_bodies,
          orbOverrides: synastry_orb_overrides,
          orbModel: synastry_orb_model,
        });

        // House overlay: which of the other person's houses each planet/angle falls into
        const person1PlanetBodies = SYNASTRY_OVERLAY_BODIES
          .filter((n) => resolveChartPoint(person1NatalChart, n))
          .map((n) => ({ name: n, longitude: resolveChartPoint(person1NatalChart, n).longitude }));
        const person2PlanetBodies = SYNASTRY_OVERLAY_BODIES
          .filter((n) => resolveChartPoint(person2NatalChart, n))
          .map((n) => ({ name: n, longitude: resolveChartPoint(person2NatalChart, n).longitude }));

        const houseOverlay = {
          person1_planets_in_person2_houses: calculateHouseOverlay(person1PlanetBodies, person2NatalChart.houses),
          person2_planets_in_person1_houses: calculateHouseOverlay(person2PlanetBodies, person1NatalChart.houses),
        };

        // Optional angle aspects: planet-to-angle and angle-to-angle contacts across the two charts.
        // include_vertex alone (without include_angles) still produces angle_aspects, containing
        // only Vertex contacts.
        let angleAspects;
        if (synastry_include_angles || synastry_include_vertex) {
          angleAspects = this.calculateSynastryAngleAspects(person1NatalChart, person2NatalChart, {
            includeMinor: synastry_include_minor,
            includeAngles: synastry_include_angles,
            includeVertex: synastry_include_vertex,
            bodies: synastry_bodies,
            orbOverrides: synastry_orb_overrides,
            orbModel: synastry_orb_model,
          });
        }

        return {
          person1_chart: person1NatalChart,
          person2_chart: person2NatalChart,
          synastry_aspects: aspects,
          house_overlay: houseOverlay,
          ...((synastry_include_angles || synastry_include_vertex) ? { angle_aspects: angleAspects } : {}),
          calculation_time: new Date().toISOString()
        };

      case 'calculate_aspects':
        const {
          datetime: aspects_datetime,
          latitude: aspects_latitude,
          longitude: aspects_longitude,
          include_minor,
          include_angles,
          include_south_node,
          include_vertex,
          bodies: aspects_bodies,
          orb_overrides,
          orb_model,
          house_system: aspects_house_system,
          node_type: aspects_node_type,
        } = args;

        if (!aspects_datetime || typeof aspects_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'datetime parameter is required and must be a string'
          );
        }

        if (typeof aspects_latitude !== 'number' || aspects_latitude < -90 || aspects_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'latitude must be a number between -90 and 90'
          );
        }

        if (typeof aspects_longitude !== 'number' || aspects_longitude < -180 || aspects_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'longitude must be a number between -180 and 180'
          );
        }

        if (include_minor !== undefined && typeof include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (include_angles !== undefined && typeof include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (include_south_node !== undefined && typeof include_south_node !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_south_node must be a boolean');
        }

        if (include_vertex !== undefined && typeof include_vertex !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_vertex must be a boolean');
        }

        if (aspects_bodies !== undefined && (!Array.isArray(aspects_bodies) || !aspects_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (orb_overrides !== undefined && (typeof orb_overrides !== 'object' || orb_overrides === null || Array.isArray(orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        validateOrbModel(orb_model);

        const aspectsEphemerisResult = this.calculateEphemeris(aspects_datetime, aspects_latitude, aspects_longitude, validateHouseSystem(aspects_house_system), validateNodeType(aspects_node_type));
        const { aspects: chartAspects, settings_used } = this.calculateChartAspects(aspectsEphemerisResult, {
          includeMinor: include_minor,
          includeAngles: include_angles,
          includeSouthNode: include_south_node,
          includeVertex: include_vertex,
          bodies: aspects_bodies,
          orbOverrides: orb_overrides,
          orbModel: orb_model,
        });

        return {
          ...aspectsEphemerisResult,
          aspects: chartAspects,
          settings_used,
        };

      case 'calculate_secondary_progressions':
        return this.calculateSecondaryProgressions(args);

      case 'find_events':
        return this.findEvents(args);

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  }

  async run() {
    // Check if we should run as HTTP server (for ngrok) or stdio
    const useHttp = process.env.MCP_HTTP_MODE === 'true';
    
    if (useHttp) {
      // HTTP mode for ngrok
      const port = process.env.PORT || 8000;

      console.log('Starting HTTP server for ngrok...');
      console.log(`Port: ${port}`);

      const app = express();
      app.use(express.json());

      // Map to store transports by session ID
      const transports = {};

      // SSE endpoint for Claude MCP Connector
      app.all('/mcp', async (req, res) => {
        try {
          console.log(`Received ${req.method} MCP request from Claude via ngrok`);
          
          // Check for existing session ID
          const sessionId = req.headers['mcp-session-id'];
          let transport;

          if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
          } else if (!sessionId && this.isInitializeRequest(req.body)) {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => Math.random().toString(36).substring(2, 15),
            });

            // Connect to the MCP server
            await this.server.connect(transport);
            
            // Handle the request first, then store the transport
            await transport.handleRequest(req, res, req.body);
            
            // Store the transport by session ID after handling the request
            if (transport.sessionId) {
              transports[transport.sessionId] = transport;
              console.log(`✅ New session created and stored: ${transport.sessionId}`);
            }
            
            return; // Exit early since we already handled the request
          } else {
            // Invalid request
            return res.status(400).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
              },
              id: null,
            });
          }

          // Handle the request using the transport (for existing sessions)
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error('Error handling MCP request:', error);
          if (!res.headersSent) {
            res.status(500).json({ 
              error: 'Internal server error', 
              details: error.message 
            });
          }
        }
      });

      // Health check endpoint
      app.get('/health', (req, res) => {
        res.json({ 
          status: 'ok', 
          server: 'swiss-ephemeris-mcp-server',
          version: '1.0.0',
          transport: 'StreamableHTTP',
          protocol: 'http',
          port: port,
          note: 'Use ngrok for HTTPS tunneling',
          endpoint: '/mcp - StreamableHTTP transport for Claude MCP Connector'
        });
      });

      // Root endpoint with info
      app.get('/', (req, res) => {
        res.json({
          name: 'Swiss Ephemeris MCP Server',
          version: '1.0.0',
          description: 'MCP server for Swiss Ephemeris calculations with HTTP transport for ngrok tunneling',
          protocol: 'http',
          port: port,
          endpoints: {
            mcp: `/mcp - StreamableHTTP transport for Claude MCP Connector`,
            health: `/health - Health check`
          },
          usage: 'Use ngrok to create HTTPS tunnel, then connect Claude to the ngrok URL + /mcp',
          note: 'Start with: ngrok http ' + port
        });
      });

      app.listen(port, () => {
        console.log(`\n✅ HTTP server listening on port ${port}`);
        console.log(`🚇 Ready for ngrok tunneling`);
        console.log(`💡 Start ngrok with: ngrok http ${port}`);
        console.log(`MCP endpoint: http://localhost:${port}/mcp`);
        console.log(`Health check: http://localhost:${port}/health`);
        console.log('\nReady for Claude MCP Connector integration via ngrok\n');
      });
    } else {
      // Stdio mode (default) - for Claude Desktop
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Swiss Ephemeris MCP server running on stdio');
    }
  }

  // Helper method to check if request is an initialize request
  isInitializeRequest(body) {
    if (Array.isArray(body)) {
      return body.some(request => request.method === 'initialize');
    }
    return body && body.method === 'initialize';
  }
}

export { SwissEphemerisServer };

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new SwissEphemerisServer();
  server.run().catch(console.error);
}
