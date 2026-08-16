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
import { execSwetest, swetestBinary, ephePath as resolveEphePath } from './lib/swetest-exec.js';
import { moonPhase, PHASE_SCHEME } from './lib/moon-phase.js';
import {
  DEFAULT_ASPECT_BODIES,
  DECLINATION_ASPECT_BODIES,
  ANGLE_BODIES,
  ASPECTABLE_ANGLES,
  MAJOR_ASPECTS,
  calculateNatalAspects,
  calculateCrossChartAspects,
  calculateDeclinationAspects,
  calculateCrossChartDeclinationAspects,
  resolveDeclinationOrbs,
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
import { jdFromDate, dateFromJd, seriesFor as ephemerisSeriesFor, positionAt as ephemerisPositionAt, positionsAt as ephemerisPositionsAt, eclipsesFor } from './lib/ephemeris-series.js';
import {
  memoizeProvider,
  scanTransitingBody,
  findContacts,
  findStations,
  findCrossings,
  findLunations,
  annotateEclipses,
  natalContactsFor,
  wrap180,
  mod360,
  signAndDegree,
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

// find_events lunation phase set (SUP-360 §3): which band starts of the eight-phase
// soli-lunar cycle to emit as `lunation` events. Ordinal, not two independent booleans -
// "quarters" and "eight_phase" both include New/Full, so there is no coherent state that
// wants quarters excluded but the eight-phase set (which contains quarters) included. No
// baked-in default here (unlike validateRate) - the default depends on `rate`, resolved
// alongside `include_quarter_moons` in findEvents.
const LUNATION_PHASES = ['syzygy', 'quarters', 'eight_phase'];

function validateLunationPhases(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !LUNATION_PHASES.includes(value)) {
    throw new McpError(ErrorCode.InvalidParams, `lunation_phases must be one of: ${LUNATION_PHASES.join(', ')}`);
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
// target it was solved for (the refinement converges on time, not longitude, but even the
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
    // See lib/progressed-provider.js's progressedBodyProvider for what this is: at the
    // transit rate a provider's JD already IS the ephemeris JD and speed is already in
    // degrees per day, so both maps are the identity.
    batchSource: { body, ephemerisJdFor: (atJd) => atJd, scaleSpeed: (speed) => speed },
    seriesFor: (startJd, endJd, stepDays) => ephemerisSeriesFor(body, startJd, endJd, stepDays),
    positionAt: (atJd) => ephemerisPositionAt(body, atJd),
  };
}

// One swetest spawn for both sides of a two-body pair instead of one each (SUP-387):
// `-p` takes several body codes and prints a row per code at the same instant, and the two
// sides of a real-body pair are sampled at the same instant by construction. The fetched
// positions are primed into each provider's own memo (lib/event-search.js's
// memoizeProvider), so the individual re-reads downstream - the per-pass absolute
// longitude lookups in the pair block below, say - are cache hits rather than fresh spawns.
//
// Returns null unless both sides are plain real bodies memoized by the same search, which
// is the caller's signal to just compose positionAt as before: a progressed Ascendant or
// moving cusp is a house computation, not a `-p` body, and has no batched form.
function pairPrefetchFor(providerA, providerB) {
  const a = providerA.batchSource;
  const b = providerB.batchSource;
  if (!a || !b || !providerA.prime || !providerB.prime) return null;

  return (jd) => {
    // One side already sampled means the batch would save nothing - the other side alone
    // is a single spawn either way.
    if (providerA.isPrimed(jd) || providerB.isPrimed(jd)) return;
    const ephemerisJd = a.ephemerisJdFor(jd);
    if (ephemerisJd !== b.ephemerisJdFor(jd)) return;

    const [rowA, rowB] = ephemerisPositionsAt([a.body, b.body], ephemerisJd);
    providerA.prime(jd, { longitude: rowA.longitude, speed: a.scaleSpeed(rowA.speed) });
    providerB.prime(jd, { longitude: rowB.longitude, speed: b.scaleSpeed(rowB.speed) });
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
  // Memoized like every other provider the search engine sees (SUP-387). progressedFrameAt
  // has a cache of its own, but it is keyed per whole ephemeris SECOND and a sample here is
  // three lookups into it (jd, jd+1, jd-1 for the central difference) - so a repeated
  // positionAt at one instant still costs three bucket misses' worth of work in the worst
  // case, and two of those buckets are a day of target time away from any the other lookups
  // touch.
  return memoizeProvider({
    positionAt: (targetJd) => ({ longitude: lonAt(targetJd), speed: speedAt(targetJd) }),
    seriesFor(startJd, endJd, stepDays) {
      const jds = adaptiveJdGrid(startJd, endJd, stepDays, lonAt);
      return jds.map((jd) => ({ jd, longitude: lonAt(jd), speed: speedAt(jd) }));
    },
  });
}

// A single progressed house cusp as a provider, same shape/precision tradeoffs as the
// Ascendant provider above (and sharing its progressedFrameAt cache - a house computation
// yields all 12 cusps at once, so querying cusp 3 after cusp 7 at the same instant costs
// nothing extra).
function cuspProviderFor(progressedFrameAt, house) {
  const lonAt = (jd) => progressedFrameAt(jd).houses[house].longitude;
  const speedAt = (targetJd) => wrap180(lonAt(targetJd + 1) - lonAt(targetJd - 1)) / 2;
  return memoizeProvider({
    positionAt: (targetJd) => ({ longitude: lonAt(targetJd), speed: speedAt(targetJd) }),
    seriesFor(startJd, endJd, stepDays) {
      const jds = adaptiveJdGrid(startJd, endJd, stepDays, lonAt);
      return jds.map((jd) => ({ jd, longitude: lonAt(jd), speed: speedAt(jd) }));
    },
  });
}

// house_frame: "progressed" composition (spec §1.1.1): the cusps move too, so house_ingress
// becomes a two-moving-point search over lambda_body(t) - cusp_i(t), the same pattern
// relativeLunarProvider (lib/event-search.js) uses for the Sun-Moon relative longitude -
// scanTransitingBody then segments at the stationary points of the DIFFERENCE, and
// `direction` on the resulting crossings reflects the relative rate's sign rather than the
// body's own (a body can be direct while what's actually closing the gap is the cusp).
// The coarse series is a ZIP of the two sides' own rows, not a re-sample of the union grid
// (SUP-387): each side's seriesFor already returns longitude and speed for every row and
// costs one swetest spawn to do it, so re-reading each row through positionAt threw that
// away and paid two more spawns per row - 732 of them on a 1-year transit pair. The union
// grid still earns its keep, just not the re-sampling: a cusp/Ascendant provider's grid can
// be adaptively subdivided finer than the body's plain one, so unlike Sun/Moon's identical
// non-adaptive grids in relativeLunarProvider, the two row sets aren't guaranteed to line
// up and neither alone is safe to segment on. Rows one side is missing fall back to its
// positionAt - one spawn, not two - instead of discarding both sides' rows to get there.
//
// `prefetch` is optional and purely a cost hint (see pairPrefetchFor): it fills the two
// providers' memos from one batched swetest call before the composition reads them, and
// composing is identical with or without it.
function relativeMovingProvider(bodyProvider, cuspProvider, prefetch = null) {
  const compose = (b, c) => ({ longitude: mod360(b.longitude - c.longitude), speed: b.speed - c.speed });
  const composeAt = (jd) => {
    if (prefetch) prefetch(jd);
    return compose(bodyProvider.positionAt(jd), cuspProvider.positionAt(jd));
  };
  return {
    positionAt: composeAt,
    seriesFor(startJd, endJd, stepDays) {
      const bodyRows = new Map(bodyProvider.seriesFor(startJd, endJd, stepDays).map((r) => [r.jd, r]));
      const cuspRows = new Map(cuspProvider.seriesFor(startJd, endJd, stepDays).map((r) => [r.jd, r]));
      const jds = [...new Set([...bodyRows.keys(), ...cuspRows.keys()])].sort((a, b) => a - b);
      return jds.map((jd) => {
        const b = bodyRows.get(jd) ?? bodyProvider.positionAt(jd);
        const c = cuspRows.get(jd) ?? cuspProvider.positionAt(jd);
        return { jd, ...compose(b, c) };
      });
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
                include_declination_aspects: {
                  type: 'boolean',
                  description: 'Include parallel and contraparallel contacts by declination (default: false) in `declination_aspects`. Parallels and contraparallels are read with roughly conjunction and opposition force respectively, and are invisible in ecliptic longitude.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Accepts a `declination` key for `declination_aspects`, e.g. {"declination": {"parallel": 1.5, "contraparallel": 1}}. No other orb overrides apply to this tool.',
                  additionalProperties: { type: ['number', 'object'] },
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
                include_declination_aspects: {
                  type: 'boolean',
                  description: 'Include parallel and contraparallel contacts by declination (default: false) in `declination_aspects`, transiting body vs natal point. Parallels and contraparallels are read with roughly conjunction and opposition force respectively, and are invisible in ecliptic longitude.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list for transit_aspects. Must be names known to the server. Angle bodies are always excluded from the transiting side, even if listed here.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees for transit_aspects, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets. Also accepts a `declination` key, e.g. {"declination": {"parallel": 1.5, "contraparallel": 1}}, for `declination_aspects` - valid under either `orb_model` and independent of it (moiety-vs-class is a longitude concept).',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model for transit_aspects. "moiety" (default) sums each body\'s half-orb (e.g. Sun 7.5°, Moon 6°) and scales by the aspect\'s multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. There is no single canonical orb table — see calculate_aspects\' orb_model description (or README) for moiety provenance and why sextile stays a major aspect despite its narrower 0.75 multiplier. `declination_aspects` orbs are unaffected by this setting either way - see `orb_overrides`.',
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
                include_declination_aspects: {
                  type: 'boolean',
                  description: 'Include parallel and contraparallel contacts by declination (default: false) in `declination_aspects`, person1 planet vs person2 planet. Parallels and contraparallels are read with roughly conjunction and opposition force respectively, and are invisible in ecliptic longitude.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list (defaults to the full 17-body list: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Applies to the aspect grid, angle-aspect planet side, and `declination_aspects` — the house overlay always uses the 10 traditional planets.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets. Also accepts a `declination` key, e.g. {"declination": {"parallel": 1.5, "contraparallel": 1}}, for `declination_aspects` - valid under either `orb_model` and independent of it (moiety-vs-class is a longitude concept).',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model. "moiety" (default) sums each body\'s half-orb and scales by the aspect\'s multiplier — see calculate_aspects for the formula and an example. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. There is no single canonical orb table — see calculate_aspects\' orb_model description (or README) for moiety provenance and why sextile stays a major aspect despite its narrower 0.75 multiplier. `declination_aspects` orbs are unaffected by this setting either way - see `orb_overrides`.',
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
                include_declination_aspects: {
                  type: 'boolean',
                  description: 'Include parallel and contraparallel contacts by declination (default: false) in `declination_aspects`. Parallels and contraparallels are read with roughly conjunction and opposition force respectively, and are invisible in ecliptic longitude.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list. Must be names known to the server.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets. Also accepts a `declination` key, e.g. {"declination": {"parallel": 1.5, "contraparallel": 1}}, for `declination_aspects` - valid under either `orb_model` and independent of it (moiety-vs-class is a longitude concept, and declination orbs are model-independent).',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model. "moiety" (default) sums each body\'s half-orb (per-body table, e.g. Sun 7.5°, Moon 6°, Ascendant 2.5°) and scales by the aspect\'s multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. Provenance: there is no single canonical orb table in the tradition — the Sun..Saturn moieties are sourced (halved from a classical full-orb table), everything past Saturn plus angles and lots is a team-constructed, non-traditional convention (see README). Note sextile\'s 0.75 multiplier is a narrower orb, not a demotion: sextile is still returned with category "major" (it is a Ptolemaic aspect) under either orb_model. `declination_aspects` orbs are unaffected by this setting either way - see `orb_overrides`.',
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
                  description: 'Per-aspect orb overrides in degrees for aspects_to_natal. The accepted SHAPE depends on `orb_model`. Under the default "fixed" (and under "class"), flat aspect-name keys, e.g. {"conjunction": 10}. Under "class" only, also a per-class shape to move a single orb class, e.g. {"orb_model": "class", "orb_overrides": {"angle": {"square": 4}}} or {"derived": {"square": 2}} - "fixed" has no per-class concept to nest under, so the nested form errors there. Under "moiety", the disjoint two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. The default table is already the tight 1 degree / 0.5 degree progressed-scale one, so overrides here are usually about a specific aspect rather than about rescaling the whole chart.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety', 'fixed'],
                  description: 'Orb resolution model for aspects_to_natal. "fixed" (default) is a flat 1 degree for major aspects / 0.5 degrees for minors, independent of which bodies/points are involved - matching find_events at rate "secondary_progression", and tighter than every other tool here, whose defaults are transit-scaled. At the progressed rate a transit-scaled orb keeps an outer-planet contact "in orb" for centuries, which is not a tuning preference but meaningless output. "moiety" (the pre-2.0.0 behaviour of this tool) sums each body\'s half-orb and scales by the aspect\'s multiplier; "class" uses the fixed per-class tables. See calculate_transits\' orb_model description for those two formulas. Echoed back as `orb_model_used`, and it also selects which `orb_overrides` shape is accepted.',
                },
              },
              required: ['birth_datetime', 'birth_latitude', 'birth_longitude', 'target_date'],
            },
          },
          {
            name: 'find_events',
            description: 'Search a UTC window for time-domain astrological events: aspect contacts (`contacts[]`, grouped into orb episodes with every exact pass), optional two-moving-body aspect contacts (`pair_contacts[]`, same episode shape, opt in via `include_pair_aspects` - SUP-361), and instants (`events[]`) - planetary stations, sign/house ingresses, and lunations (New/Full Moon by default, optionally the quarter or full eight-phase soli-lunar cycle via `lunation_phases`). At `rate: "transit"` (default) the moving side is transiting bodies, houses are the NATAL chart\'s own, and lunations carry eclipse annotation. At `rate: "secondary_progression"` the moving side is the day-for-a-year progressed chart instead (feeding calculate_secondary_progressions\' own arc/house math into the same search engine): progressed angles become searchable, houses can move with the progressed chart, defaults invert (see `bodies`/`orb_model`/`include_*`/`lunation_phases` below), and eclipse annotation is structurally absent (progressions have no eclipse analogue). Correctness comes from segmenting the window at the moving side\'s own stations and enumerating every target crossing in each monotone segment, not from a scan step - no pass can be skipped between samples.',
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
                  description: '"transit" (default): the moving side is transiting bodies at their real ephemeris position, matching calculate_transits. "secondary_progression": the moving side is the day-for-a-year progressed chart instead - progressed positions here match calculate_secondary_progressions exactly (same angle_method/house_frame semantics), and several defaults invert relative to "transit" (see `bodies`, `orb_model`, `include_angles`, `lunation_phases`). `angle_method`/`house_frame` require this to be "secondary_progression" and error otherwise.',
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
                  description: 'MOVING side. Default depends on `rate`. At "transit" (default): Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron - the bodies slow enough to define forecasting "chapters" rather than trigger them; the transiting Moon is excluded (it alone is 21.7x the rest of the output) but reachable by explicit request, as are Sun/Mercury/Venus/asteroids/Lilith/North Node. At "secondary_progression": Sun, Moon, Mercury, Venus, Mars - inverted, since the progressed Moon (13.29 deg/yr) IS the technique and an outer planet moves only a few degrees in a lifetime; the rest are still reachable by explicit request. Angle bodies and Vertex can never appear here - progressed Ascendant/Midheaven are reached via `include_angles` instead, not `bodies`. Governs `contacts[]` and `sign_ingress`/`house_ingress` events; `station` events at rate "secondary_progression" always search the fixed 13-body station-capable set regardless of this parameter, but at rate "transit" stay narrowed to bodies also in that set, unchanged from before this rate parameter existed - see `events[].type === "station"`.',
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
                  description: 'DEPRECATED - use `lunation_phases` instead. Alias: true maps to lunation_phases: "quarters", false maps to lunation_phases: "syzygy". Supplying both include_quarter_moons and lunation_phases is an error, not a silent precedence rule. Kept indefinitely for backward compatibility - not scheduled for removal.',
                },
                lunation_phases: {
                  type: 'string',
                  enum: ['syzygy', 'quarters', 'eight_phase'],
                  description: 'Which band starts of the Sun-Moon soli-lunar cycle to emit as `lunation` events in `events[]`, each a strict superset of the last: "syzygy" (New, Full - 2/cycle), "quarters" (+ First Quarter, Last Quarter - 4/cycle), "eight_phase" (+ Crescent, Gibbous, Disseminating, Balsamic - 8/cycle, the full Rudhyar-lineage cycle already used by calculate_planetary_positions\' phase field). Every event kept from one set to the next carries an identical `phase` and `datetime` - the wider sets add events, they never rename or re-time one. Default depends on `rate`: "syzygy" at "transit" (New/Full alone already run ~25/yr; the full cycle would run ~99/yr with comparatively little added signal for a forecasting scan), "eight_phase" at "secondary_progression" (the progressed lunation cycle is conventionally read by phase - including Balsamic, among the most-cited progressed phase readings - and even at eight phases a 90-year window yields only ~24 total). Independent of `include_minor`: these are exact crossings with no orb, not aspect contacts, even though 45deg/135deg also happen to be minor aspect angles. Errors if `include_quarter_moons` is also supplied.',
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
                include_pair_aspects: {
                  type: 'boolean',
                  description: 'Opt in to two-moving-body aspect search (SUP-361): aspects between two members of `pair_bodies` - e.g. progressed Venus conjunct progressed Mars, or transiting Jupiter square transiting Saturn - reported in a separate top-level `pair_contacts[]`, never mixed into `contacts[]` (a pair has no natal point). Default false at either rate. Requires `event_types` to include "aspect" - there is no separate event category for these, same reasoning as `lunation_phases` not being its own category. The progressed Sun-Moon pair is deliberately included, not suppressed for overlapping with `lunation`: the lunation event carries the directed phase (which of Crescent/Balsamic, First/Last Quarter) that an undirected aspect row structurally cannot distinguish, while the aspect row carries the orb envelope (`enters_orb`/`leaves_orb`/`closest_approach`) the lunation event has no field for - see README.',
                },
                pair_bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Which bodies\' unordered pairs to search when `include_pair_aspects` is true - e.g. ["Sun","Moon","Mars"] searches Sun-Moon, Sun-Mars, and Moon-Mars. Independent of `bodies`: `bodies` is the moving-to-natal set and also drives sign_ingress/house_ingress, so narrowing it (e.g. to ["Moon"] for a clean ingress timeline) must not silently zero out pairs, and widening it (e.g. to the outer planets) must not silently add 21 frozen pair rows. Default depends on `rate`, matching `bodies`\' own rate-keyed default regardless of what `bodies` was actually set to: Sun, Moon, Mercury, Venus, Mars (10 pairs) at "secondary_progression"; Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron (21 pairs) at "transit". Ascendant/Midheaven are valid members (reachable the same way calculate_aspects can emit Ascendant-Midheaven under include_angles), but only produce pairs at rate "secondary_progression" with `include_angles` true - pairs inherit that gate, and are silently dropped (not an error) otherwise, same as the other exclusions below. They are deliberately excluded from the default set: each Ascendant/Midheaven sample is far more expensive than a real body\'s, so an explicit request is required. Two pairs are always excluded regardless of `pair_bodies`, silently rather than as an error - the excluded pairs are visible via `settings_used.pairs_searched`, the list actually run after exclusions: (1) (Sun, Midheaven) whenever both are progressed, at either `angle_method` - under "solar_arc" the progressed Midheaven is defined as natalMC + (progressedSun - natalSun), so their relative separation is a lifelong-constant natal fact, not a progressed event; under "naibod" it is not exactly constant but changes so slowly (~0.02deg/yr) it is not meaningfully better; (2) the lunar nodes, unconditionally - the true Node (this tool\'s only node_type) reverses direction from orbital wobble roughly once a year of progressed life, and a pair\'s rate is a difference, so that jitter shreds segmentation. Progressed Part of Fortune is never reachable here at all (same as `bodies`) - it is not a valid `pair_bodies` name, so requesting it errors rather than silently doing nothing.',
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
      // Only read here for the missing-data warning below - execSwetest resolves it
      // itself and passes it to the child through the environment.
      const ephePath = resolveEphePath();

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
      const planetArgs = [
        `-b${swissDate}`,
        `-ut${swissTime}`,
        `-p0123456789${nodeCode}ADFGHIo`,
        '-fPZSBDl-',
        '-g,',
        '-head',
      ];
      let planetOutput;
      try {
        planetOutput = execSwetest(planetArgs);
      } catch (error) {
        throw new Error(`Failed to execute swetest for planets: ${error.message}`);
      }

      // Execute swetest for houses
      const houseArgs = [
        `-b${swissDate}`,
        `-ut${swissTime}`,
        `-house${longitude},${latitude},${houseSystem}`,
        '-fPZSBD',
        '-g,',
        '-head',
      ];
      let houseOutput;
      try {
        houseOutput = execSwetest(houseArgs);
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

  // Declination-aspect body resolution (SUP-347): DECLINATION_ASPECT_BODIES intersected with
  // whichever body list is actually in play (default or `bodies` override). North Node and
  // every angle are never in DECLINATION_ASPECT_BODIES, so they drop out here unconditionally,
  // independent of include_angles/include_south_node/include_vertex - a correctness rule
  // (docs/SUP-345-declination-layer-spec.md §Q2/§Q3), not something those flags can override.
  declinationBodyNames(requestedBodies) {
    return requestedBodies.filter((name) => DECLINATION_ASPECT_BODIES.includes(name));
  }

  // Resolves declination body names to {name, declination} pairs from a chart's `planets`
  // bucket - the only bucket DECLINATION_ASPECT_BODIES members live in. Missing declinations
  // (e.g. a body dropped by the missing-ephemeris path) are filtered out rather than passed
  // through as NaN.
  toDeclinationBodies(chart, names) {
    return names
      .map((name) => ({ name, declination: chart.planets?.[name]?.declination }))
      .filter((b) => b.declination !== undefined);
  }

  calculateChartAspects(ephemerisResult, options = {}) {
    const {
      includeMinor = false,
      includeAngles = false,
      includeSouthNode = false,
      includeVertex = false,
      includeDeclinationAspects = false,
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

    const declinationBodyNames = this.declinationBodyNames(requestedBodies);
    const declinationAspects = includeDeclinationAspects
      ? calculateDeclinationAspects(this.toDeclinationBodies(ephemerisResult, declinationBodyNames), orbOverrides)
      : undefined;

    return {
      aspects,
      ...(includeDeclinationAspects ? { declination_aspects: declinationAspects } : {}),
      settings_used: {
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        include_vertex: includeVertex,
        include_declination_aspects: includeDeclinationAspects,
        declination_orbs: resolveDeclinationOrbs(orbOverrides),
        declination_bodies: declinationBodyNames,
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
      includeDeclinationAspects = false,
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

    // Transiting body -> natal point, mirroring the row-key rename above. Unlike `aspects`,
    // the transiting and natal declination values are read directly off each chart's own
    // `planets` bucket - there's no "frozen speed" concept here since declination aspects
    // never have a speed-derived `applying` to protect (always null - see
    // calculateCrossChartDeclinationAspects).
    const declinationBodyNames = this.declinationBodyNames(requestedBodies);
    const declinationAspects = includeDeclinationAspects
      ? calculateCrossChartDeclinationAspects(
        this.toDeclinationBodies(transitChart, declinationBodyNames),
        this.toDeclinationBodies(natalChart, declinationBodyNames),
        orbOverrides
      ).map((a) => ({
        transiting_body: a.body_a,
        natal_body: a.body_b,
        aspect: a.aspect,
        declination_a: a.declination_a,
        declination_b: a.declination_b,
        orb: a.orb,
        orb_allowed: a.orb_allowed,
        applying: a.applying,
      }))
      : undefined;

    return {
      aspects,
      ...(includeDeclinationAspects ? { declination_aspects: declinationAspects } : {}),
      settings_used: {
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        include_vertex: includeVertex,
        include_declination_aspects: includeDeclinationAspects,
        declination_orbs: resolveDeclinationOrbs(orbOverrides),
        declination_bodies: declinationBodyNames,
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

  // Cross-chart parallels/contraparallels between the two charts' planet sides (SUP-347).
  // Same body-list resolution as calculateSynastryAspects (DECLINATION_ASPECT_BODIES
  // intersected with the requested/default list), but its own pairing pass and row shape -
  // declination aspects have no category/exact_angle/position fields (§3.4).
  calculateSynastryDeclinationAspects(person1Planets, person2Planets, options = {}) {
    const requestedBodies = this.resolveSynastryBodies(options.bodies);
    const declinationBodyNames = this.declinationBodyNames(requestedBodies);

    const toBodiesWithDeclination = (planets) => declinationBodyNames
      .filter((name) => planets[name]?.declination !== undefined)
      .map((name) => ({ name, declination: planets[name].declination }));

    const bodiesA = toBodiesWithDeclination(person1Planets);
    const bodiesB = toBodiesWithDeclination(person2Planets);

    return calculateCrossChartDeclinationAspects(bodiesA, bodiesB, options.orbOverrides).map((a) => ({
      person1_planet: a.body_a,
      person2_planet: a.body_b,
      aspect: a.aspect,
      declination_a: a.declination_a,
      declination_b: a.declination_b,
      orb: a.orb,
      orb_allowed: a.orb_allowed,
      applying: a.applying,
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
      orb_model,
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
    validateOrbModel(orb_model);
    // 'fixed' rather than the aspect engine's own 'moiety' default (SUP-383), matching
    // find_events at rate "secondary_progression": the moiety/class tables are transit-scaled,
    // and at the progressed rate a 12-degree moiety orb keeps a progressed Jupiter contact
    // "in orb" for centuries - see docs/SUP-357-progressed-events-spec.md and the Orb Models
    // section of the README. Which model is resolved also decides which orb_overrides SHAPE is
    // accepted (flat aspect names under 'fixed', + per-class nesting under 'class', the
    // two-knob {moieties, multipliers} form under 'moiety'), so it has to be settled before
    // any override key is validated.
    const orbModel = orb_model ?? 'fixed';
    const orbOverrides = orb_overrides ?? {};

    // Validated here rather than left to resolveAspectBodies below, which runs after all three
    // calculateEphemeris calls - a rejected override should not cost a full ephemeris run. The
    // check inside resolveAspectBodies stays as the shared backstop for its other callers.
    const invalidOrbKeys = invalidOrbOverrideKeys(orbOverrides, orbModel);
    if (invalidOrbKeys.length) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${invalidOrbKeys[0]}`);
    }

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
      orbOverrides,
      orbModel,
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
      orbOverrides,
      orbModel,
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
      orb_model_used: orbModel,
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
      lunation_phases,
      orb_overrides,
      orb_model,
      include_pair_aspects,
      pair_bodies,
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
    const validatedLunationPhases = validateLunationPhases(lunation_phases);
    // No silent precedence rule between the deprecated boolean and its replacement (spec
    // §3) - the eight-phase set strictly contains the quarters, so
    // "include_quarter_moons: false, lunation_phases: 'eight_phase'" would otherwise say
    // both "no quarters" and "all eight phases including the quarters" at once.
    if (include_quarter_moons !== undefined && validatedLunationPhases !== undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'Supply either include_quarter_moons or lunation_phases, not both - include_quarter_moons is a deprecated alias for lunation_phases');
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
    if (include_pair_aspects !== undefined && typeof include_pair_aspects !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'include_pair_aspects must be a boolean');
    }
    if (pair_bodies !== undefined && (!Array.isArray(pair_bodies) || !pair_bodies.every((b) => typeof b === 'string'))) {
      throw new McpError(ErrorCode.InvalidParams, 'pair_bodies must be an array of strings');
    }

    const validatedHouseSystem = validateHouseSystem(house_system);
    const validatedEventTypes = validateEventTypes(event_types);

    const defaultTransitingBodies = DEFAULT_TRANSITING_BODIES_BY_RATE[validatedRate];
    const requestedTransitingBodies = Array.isArray(bodies) && bodies.length ? [...new Set(bodies)] : defaultTransitingBodies;
    for (const b of requestedTransitingBodies) {
      if (!EVENT_TRANSITING_BODIES.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown transiting body: ${b}`);
      }
    }

    // pair_bodies (SUP-361 §3) is deliberately independent of `bodies` - its own rate-keyed
    // default, not derived from whatever `bodies` was actually set to (spec ruling B item
    // 1). Ascendant/Midheaven are valid names here (unlike `bodies`, which never accepts
    // them) since an explicit pair request can reach them at rate "secondary_progression" -
    // see the includeAngles-gated eligibility filter below, which drops them silently
    // (rather than erroring) when that gate isn't open, same treatment as the other
    // structural exclusions (§4).
    const requestedPairBodies = Array.isArray(pair_bodies) && pair_bodies.length ? [...new Set(pair_bodies)] : defaultTransitingBodies;
    for (const b of requestedPairBodies) {
      if (!EVENT_TRANSITING_BODIES.has(b) && !ANGLE_SOURCE_NAMES.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown pair body: ${b}`);
      }
    }

    const includeMinor = include_minor ?? false;
    const includeAngles = include_angles ?? isProgressed;
    const includeSouthNode = include_south_node ?? false;
    const includeVertex = include_vertex ?? false;
    const includePairAspects = include_pair_aspects ?? false;
    // Resolution order: lunation_phases, then the deprecated include_quarter_moons alias
    // (true -> "quarters", false -> "syzygy"), then the rate-keyed default - "syzygy" at
    // "transit" (bit-for-bit the shipped behaviour), "eight_phase" at
    // "secondary_progression" (SUP-360 ruling D, superseding SUP-357 ruling #6's
    // "quarters"; every "quarters" event this used to default to keeps an identical phase
    // and datetime under "eight_phase" - see lib/event-search.js's LUNATION_PHASE_SETS).
    const lunationPhases = validatedLunationPhases
      ?? (include_quarter_moons !== undefined ? (include_quarter_moons ? 'quarters' : 'syzygy') : undefined)
      ?? (isProgressed ? 'eight_phase' : 'syzygy');
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

    // One memoized provider per body for the whole call, not one per call site (SUP-387).
    // Both halves matter: memoizeProvider stops the same instant being re-spawned, and
    // handing back the SAME provider object every time is what lets the aspect search, the
    // ingress search, the pair search and the lunation search share one cache instead of
    // three-plus disjoint ones. The caches die with this request - see memoizeProvider.
    const bodyProviders = new Map();
    const providerFor = (body) => {
      const cached = bodyProviders.get(body);
      if (cached) return cached;
      const provider = memoizeProvider(isProgressed
        ? progressedBodyProvider(body, { birthJd, yearLengthDays })
        : transitProviderFor(body));
      bodyProviders.set(body, provider);
      return provider;
    };

    // Progressed Midheaven/Ascendant/moving-cusp machinery (SUP-357/SUP-359 §4) - built
    // only when needed. mcProvider is pure arithmetic (lib/progressed-provider.js, reusing
    // the progressed Sun's own speed under solar_arc); the Ascendant and moving cusps need
    // an actual swetest -house lookup (obliquity + ARMC + the fictitious-longitude trick
    // computeFictitiousLongitude derives - see calculate_secondary_progressions, which
    // this mirrors exactly), memoized per whole EPHEMERIS second since calculateEphemeris
    // truncates to that resolution internally regardless (formatTimeToSwiss reads whole
    // UTC seconds), so caching at that granularity loses no precision it didn't already
    // have and collapses the nearby queries root refinement performs into a handful of
    // actual swetest spawns.
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

    // Provider lookup for a pair_bodies member (SUP-361): a real body goes through
    // providerFor same as `bodies`/`targets` do; Ascendant/Midheaven reuse the same
    // pseudo-source providers the progressed-angle contacts block below builds (only
    // non-null when isProgressed, which is also the only case the eligibility filter lets
    // an angle name reach this far).
    const pairProviderFor = (name) => (name === 'Midheaven' ? mcProvider : name === 'Ascendant' ? ascProvider : providerFor(name));

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
    const pairContacts = [];

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

    // Two-moving-body aspect search (SUP-361): unordered pairs of pair_bodies, structurally
    // excluded per spec §4 - computed regardless of include_pair_aspects (cheap
    // combinatorics, no provider calls) so settings_used.pairs_searched can preview what a
    // request would run before the feature is switched on; only actually searched when
    // include_pair_aspects is true and "aspect" is requested (ruling B item 3 - no separate
    // event category for these).
    const isAnglePairName = (name) => ANGLE_SOURCE_NAMES.has(name);
    const anglePairGateOpen = isProgressed && includeAngles;
    const eligiblePairs = [];
    for (let i = 0; i < requestedPairBodies.length; i++) {
      for (let j = i + 1; j < requestedPairBodies.length; j++) {
        const bodyA = requestedPairBodies[i];
        const bodyB = requestedPairBodies[j];
        if (bodyA === 'North Node' || bodyB === 'North Node') continue; // §4.1
        if ((isAnglePairName(bodyA) || isAnglePairName(bodyB)) && !anglePairGateOpen) continue; // §4.4/§4.5
        if (isProgressed && ((bodyA === 'Sun' && bodyB === 'Midheaven') || (bodyA === 'Midheaven' && bodyB === 'Sun'))) continue; // §4.2 - constant under solar_arc for every chart
        eligiblePairs.push([bodyA, bodyB]);
      }
    }

    if (includePairAspects && validatedEventTypes.includes('aspect')) {
      // Per-body scan, cached across pairs sharing a body (e.g. every progressed Moon
      // pair) - reused both to compose the relative provider below and to pick which side
      // of a pair is "faster" (spec §8.3).
      const pairBodyScans = new Map();
      const scanPairBody = (name) => {
        if (pairBodyScans.has(name)) return pairBodyScans.get(name);
        const provider = pairProviderFor(name);
        const { segments } = scanTransitingBody(provider, startJd, endJd, scanStepDays);
        // Mean rate over the whole window, not instantaneous (§8.3: Mercury and Venus trade
        // places by progression, so a single-instant speed comparison can pick the wrong
        // side). segments[0].uLo / the last segment's uHi are the unwrapped cumulative
        // longitude scanTransitingBody already tracked internally, so net arc traveled
        // falls out for free instead of needing a second pass over the series.
        const netArc = segments.length ? segments[segments.length - 1].uHi - segments[0].uLo : 0;
        const entry = { provider, meanRate: netArc / (endJd - startJd) };
        pairBodyScans.set(name, entry);
        return entry;
      };

      for (const [bodyA, bodyB] of eligiblePairs) {
        const scanA = scanPairBody(bodyA);
        const scanB = scanPairBody(bodyB);
        const fasterName = Math.abs(scanA.meanRate) >= Math.abs(scanB.meanRate) ? bodyA : bodyB;
        const fastScan = fasterName === bodyA ? scanA : scanB;
        const slowScan = fasterName === bodyA ? scanB : scanA;

        // Composed the same way house_frame "progressed"'s relativeMovingProvider is
        // (fast.longitude - slow.longitude): directed separation comes out faster-minus-
        // slower (spec §8.3) - Sun-Moon lands as Moon-Sun, matching findLunations and
        // lib/moon-phase.js with no special case. Segmenting THIS provider's own stations
        // (rather than reusing either body's individual scan) is what finds relative
        // stations - real for a general pair, unlike the Sun-Moon relative rate lunations
        // compose, which never reaches zero (spec §8.4).
        const relativeProvider = relativeMovingProvider(
          fastScan.provider, slowScan.provider,
          pairPrefetchFor(fastScan.provider, slowScan.provider), // one spawn for both bodies (SUP-387)
        );
        const { segments: relativeSegments, stations: relativeStations } = scanTransitingBody(relativeProvider, startJd, endJd, scanStepDays);

        for (const [aspectName, aspectAngle] of Object.entries(aspectDefs)) {
          const orbAllowed = orbAllowedFor(aspectSettings, bodyA, bodyB, aspectName);
          const category = Object.hasOwn(MAJOR_ASPECTS, aspectName) ? 'major' : 'minor';
          const searchAngles = (aspectAngle === 0 || aspectAngle === 180) ? [aspectAngle] : [aspectAngle, 360 - aspectAngle];

          for (const searchAngle of searchAngles) {
            for (const contact of findContacts({
              provider: relativeProvider, segments: relativeSegments, stations: relativeStations,
              natalLongitude: 0, aspectAngle: searchAngle, orbAllowed,
              startJd, endJd,
            })) {
              const aSensitive = isAnglePairName(bodyA);
              const bSensitive = isAnglePairName(bodyB);
              const birthTimeSensitive = aSensitive || bSensitive;
              const row = {
                body_a: bodyA,
                body_b: bodyB,
                faster_body: fasterName,
                aspect: aspectName,
                category,
                aspect_angle: aspectAngle,
                orb_allowed: contact.orb_allowed,
                enters_orb: contact.enters_orb,
                leaves_orb: contact.leaves_orb,
                // Re-read each body's OWN absolute longitude/speed at the pass instant
                // (spec §8.1/§8.2) - contact.passes' own longitude/sign/degree/retrograde
                // are the RELATIVE separation's, which would be a well-formed but
                // meaningless position/direction for either body, so they're discarded here
                // rather than spread through.
                passes: contact.passes.map(({ jd, datetime }) => {
                  const posA = scanA.provider.positionAt(jd);
                  const posB = scanB.provider.positionAt(jd);
                  return {
                    datetime,
                    body_a: { longitude: mod360(posA.longitude), ...signAndDegree(posA.longitude), speed: posA.speed, retrograde: posA.speed < 0 },
                    body_b: { longitude: mod360(posB.longitude), ...signAndDegree(posB.longitude), speed: posB.speed, retrograde: posB.speed < 0 },
                  };
                }),
                closest_approach: contact.closest_approach,
                birth_time_sensitive: birthTimeSensitive,
                enters_orb_truncated: contact.enters_orb_truncated,
                leaves_orb_truncated: contact.leaves_orb_truncated,
              };
              if (isProgressed && birthTimeSensitive) {
                const shiftDeg = (aSensitive ? (angleShiftPerMinute[bodyA] ?? 0) : 0)
                  + (bSensitive ? (angleShiftPerMinute[bodyB] ?? 0) : 0);
                // Evaluated at the contact's own instant, off the RELATIVE rate (spec
                // ruling #9) - a pair's date sensitivity depends on how fast the gap
                // between the two points is closing, not either body's absolute speed.
                const contactRate = Math.abs(relativeProvider.positionAt(jdFromDate(new Date(contact.closest_approach.datetime))).speed);
                if (shiftDeg > 0 && contactRate > RATE_EPSILON) row.date_uncertainty_days_per_birth_minute = shiftDeg / contactRate;
              }
              pairContacts.push(row);
            }
          }
        }
      }

      pairContacts.sort((a, b) => new Date(a.enters_orb) - new Date(b.enters_orb));
    }

    if (validatedEventTypes.includes('lunation')) {
      const sunProvider = providerFor('Sun');
      const moonProvider = providerFor('Moon');
      const rawLunations = findLunations({ sunProvider, moonProvider, startJd, endJd, lunationPhases, stepDays: scanStepDays });
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
      pair_contacts: pairContacts,
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
        include_quarter_moons: lunationPhases !== 'syzygy',
        lunation_phases: lunationPhases,
        lunation_phase_scheme: PHASE_SCHEME,
        node_type: 'true',
        include_pair_aspects: includePairAspects,
        pair_bodies: requestedPairBodies,
        // The pair list actually eligible after §4's exclusions - visible regardless of
        // include_pair_aspects (spec ruling B: "so a caller cannot tell an excluded pair
        // from a pair that produced nothing"), so this is populated even when the feature
        // itself is off.
        pairs_searched: eligiblePairs.map(([body_a, body_b]) => ({ body_a, body_b })),
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
        const {
          datetime,
          latitude,
          longitude,
          house_system,
          node_type: pp_node_type,
          include_declination_aspects: pp_include_declination_aspects,
          orb_overrides: pp_orb_overrides,
        } = args;

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

        if (pp_include_declination_aspects !== undefined && typeof pp_include_declination_aspects !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_declination_aspects must be a boolean');
        }

        if (pp_orb_overrides !== undefined && (typeof pp_orb_overrides !== 'object' || pp_orb_overrides === null || Array.isArray(pp_orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        // No orb_model concept on this tool - only orb_overrides.declination applies here, and
        // invalidOrbOverrideKeys validates that key identically under either mode (SUP-347 §Q1).
        const ppInvalidOrbKeys = invalidOrbOverrideKeys(pp_orb_overrides ?? {}, 'moiety');
        if (ppInvalidOrbKeys.length) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${ppInvalidOrbKeys[0]}`);
        }

        const positionsResult = this.calculateEphemeris(datetime, latitude, longitude, validateHouseSystem(house_system), validateNodeType(pp_node_type));

        if (!pp_include_declination_aspects) {
          return positionsResult;
        }

        return {
          ...positionsResult,
          declination_aspects: calculateDeclinationAspects(
            this.toDeclinationBodies(positionsResult, DECLINATION_ASPECT_BODIES),
            pp_orb_overrides ?? {}
          ),
        };

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
          include_declination_aspects: transit_include_declination_aspects,
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

        if (transit_include_declination_aspects !== undefined && typeof transit_include_declination_aspects !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_declination_aspects must be a boolean');
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

         const { aspects: transitAspects, declination_aspects: transitDeclinationAspects, settings_used: transitSettingsUsed } = this.calculateTransitAspects(natalChart, currentEphemeris, {
           includeMinor: transit_include_minor,
           includeAngles: transit_include_angles,
           includeSouthNode: transit_include_south_node,
           includeVertex: transit_include_vertex,
           includeDeclinationAspects: transit_include_declination_aspects,
           bodies: transit_bodies,
           orbOverrides: transit_orb_overrides,
           orbModel: transit_orb_model,
         });

         return {
           natal_chart: natalChart,
           current_transits: currentEphemeris,
           transit_aspects: transitAspects,
           ...(transit_include_declination_aspects ? { declination_aspects: transitDeclinationAspects } : {}),
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
        const { person1_datetime, person1_latitude, person1_longitude, person2_datetime, person2_latitude, person2_longitude, include_minor: synastry_include_minor, include_angles: synastry_include_angles, include_vertex: synastry_include_vertex, include_declination_aspects: synastry_include_declination_aspects, bodies: synastry_bodies, orb_overrides: synastry_orb_overrides, orb_model: synastry_orb_model, person1_house_system, person2_house_system, node_type: synastry_node_type } = args;

        if (synastry_include_minor !== undefined && typeof synastry_include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (synastry_include_angles !== undefined && typeof synastry_include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (synastry_include_vertex !== undefined && typeof synastry_include_vertex !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_vertex must be a boolean');
        }

        if (synastry_include_declination_aspects !== undefined && typeof synastry_include_declination_aspects !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_declination_aspects must be a boolean');
        }

        if (synastry_bodies !== undefined && (!Array.isArray(synastry_bodies) || !synastry_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (synastry_orb_overrides !== undefined && (typeof synastry_orb_overrides !== 'object' || synastry_orb_overrides === null || Array.isArray(synastry_orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        // Before the override keys, not after: which model is in force decides which
        // override SHAPE is legal, so an unrecognised orb_model falls through
        // invalidOrbOverrideKeys' class-mode branch and reports a valid override as the
        // bad parameter (SUP-384). Same order as find_events.
        validateOrbModel(synastry_orb_model);

        if (synastry_orb_overrides !== undefined) {
          const invalidSynastryOrbKeys = invalidOrbOverrideKeys(synastry_orb_overrides, synastry_orb_model);
          if (invalidSynastryOrbKeys.length) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${invalidSynastryOrbKeys[0]}`);
          }
        }

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

        // Optional cross-chart parallels/contraparallels (SUP-347), planet side only - the
        // Node and angles are never in DECLINATION_ASPECT_BODIES, so this is independent of
        // include_angles/include_vertex.
        let synastryDeclinationAspects;
        if (synastry_include_declination_aspects) {
          synastryDeclinationAspects = this.calculateSynastryDeclinationAspects(person1NatalChart.planets, person2NatalChart.planets, {
            bodies: synastry_bodies,
            orbOverrides: synastry_orb_overrides,
          });
        }

        return {
          person1_chart: person1NatalChart,
          person2_chart: person2NatalChart,
          synastry_aspects: aspects,
          house_overlay: houseOverlay,
          ...((synastry_include_angles || synastry_include_vertex) ? { angle_aspects: angleAspects } : {}),
          ...(synastry_include_declination_aspects ? { declination_aspects: synastryDeclinationAspects } : {}),
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
          include_declination_aspects,
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

        if (include_declination_aspects !== undefined && typeof include_declination_aspects !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_declination_aspects must be a boolean');
        }

        if (aspects_bodies !== undefined && (!Array.isArray(aspects_bodies) || !aspects_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (orb_overrides !== undefined && (typeof orb_overrides !== 'object' || orb_overrides === null || Array.isArray(orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        validateOrbModel(orb_model);

        const aspectsEphemerisResult = this.calculateEphemeris(aspects_datetime, aspects_latitude, aspects_longitude, validateHouseSystem(aspects_house_system), validateNodeType(aspects_node_type));
        const { aspects: chartAspects, declination_aspects: chartDeclinationAspects, settings_used } = this.calculateChartAspects(aspectsEphemerisResult, {
          includeMinor: include_minor,
          includeAngles: include_angles,
          includeSouthNode: include_south_node,
          includeVertex: include_vertex,
          includeDeclinationAspects: include_declination_aspects,
          bodies: aspects_bodies,
          orbOverrides: orb_overrides,
          orbModel: orb_model,
        });

        return {
          ...aspectsEphemerisResult,
          aspects: chartAspects,
          ...(include_declination_aspects ? { declination_aspects: chartDeclinationAspects } : {}),
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
    // Locate swetest before accepting a single request. Every tool here needs it, so a
    // missing install is a broken deployment, not a bad request - discovering it on the
    // first tool call instead surfaces it as a per-call "Failed to execute swetest"
    // buried in a tool response, once per request, forever.
    swetestBinary();

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

export { SwissEphemerisServer, adaptiveJdGrid };

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new SwissEphemerisServer();
  // Exit non-zero rather than logging and lingering: run() failing means no transport was
  // ever connected, and a process that stays up in that state looks healthy to whatever
  // supervises it (Claude Desktop, Docker's restart policy) while serving nothing.
  server.run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
