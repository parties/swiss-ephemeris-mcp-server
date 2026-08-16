// The rate-agnostic search engine (SUP-349 spec Q1/Q10). Knows nothing about transits,
// swetest, or MCP: every function here takes a position provider - `{ seriesFor(startJd,
// endJd, stepDays), positionAt(jd) }`, already bound to one body - and, where an orb
// matters, a plain `orbAllowed` number already resolved by the caller (see
// lib/aspects.js's resolveAspectSettings/orbAllowedFor). That's what makes a
// progressions or solar-arc provider a drop-in swap later instead of a rewrite.
//
// Core argument (spec Q1): for a fixed target longitude, g(t) = wrap180(lambda(t) -
// target) is strictly monotone between the body's stations, because g' = lambda'. So:
// find stations (roots of speed) -> cut the window there -> on each monotone segment,
// every `target + 360k` in range is crossed exactly once -> refine each crossing to sub-
// second precision. The pass count is arithmetic before any refinement runs; missing a
// pass would require missing a station, not missing a sample.
//
// The one exception is lunations (Q7): the Sun-Moon relative speed (11.8-14.6 deg/day)
// never reaches zero, so the same machinery runs on a relative-longitude provider with
// zero stations found and therefore zero segmentation - not a special case, a natural
// consequence of the station search finding nothing to split on.

import { dateFromJd } from './ephemeris-series.js';

// Refinement tolerance (spec: "±1 minute UTC" is the accuracy floor; the spec's own worked
// timestamps are precise to the second - so refine well past that floor, tight enough that
// rounding to the nearest second is never ambiguous).
//
// SUP-387 left this figure alone deliberately, even though the Astrology Advisor cleared
// relaxing it to ~2s: refineSegmentCrossing converges quadratically, so the sample count
// depends on the tolerance only logarithmically-of-logarithmically - going from 0.05s to 2s
// would have saved about one sample per root out of five. What cost 30 samples was the
// bisection ladder getting here, not the target itself. So the resolution stays, and no
// figure quoted in docs/tool_requests/ has to move.
const JD_TOLERANCE = 0.05 / 86400;

// Ceiling on samples per crossing refinement. refineSegmentCrossing keeps a bracket and
// falls back to bisection whenever its Newton step leaves it, so this is a backstop against
// a pathological function (a discontinuity inside the bracket), not the expected exit - a
// normal crossing converges in 4-6 samples. Set at roughly twice the ~30 halvings a pure
// bisection fallback needs from a segment a tropical year wide (the progressed rate's
// coarse step), so even an input that wastes every Newton step still converges inside
// JD_TOLERANCE rather than returning early at some arbitrary point.
const MAX_REFINE_SAMPLES = 64;

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

export function mod360(deg) {
  return ((deg % 360) + 360) % 360;
}

// Signed shortest angular difference, in (-180, 180]. The wrap that makes a Full Moon a
// crossing instead of a discontinuity (spec §1.3).
export function wrap180(deg) {
  const d = mod360(deg);
  return d > 180 ? d - 360 : d;
}

export function signAndDegree(longitude) {
  const lon = mod360(longitude);
  const index = Math.floor(lon / 30);
  return { sign: SIGNS[index], degree: Math.round((lon - index * 30) * 100) / 100 };
}

function toISODateSeconds(date) {
  const rounded = new Date(Math.round(date.getTime() / 1000) * 1000);
  return rounded.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoFromJd(jd) {
  return toISODateSeconds(dateFromJd(jd));
}

// Refine a station bracket (speed sign change between jdLo and jdHi, <=1 day apart) down
// to JD_TOLERANCE.
//
// This one stays a plain bisection, unlike the crossing refiner below, and SUP-387
// deliberately left it that way after measuring the alternative. A station's root is not a
// smooth zero of speed at the resolution swetest reports: speed prints to 7 decimals, so
// around the station there is a PLATEAU where it reads exactly 0.0000000 - ~30 seconds
// wide for Neptune at the transit rate, and ~13 MINUTES wide for progressed Jupiter, where
// the 1/yearLengthDays rescaling stretches it by 365x. What the search actually converges
// on is the edge of that plateau, a step, and interpolation has nothing to interpolate
// across a step: an Illinois-safeguarded regula falsi measured at 30/26/22/21 samples for
// the progressed Jupiter/Mercury/Venus/Pluto stations against bisection's 31, i.e. no
// saving, while landing on the far side of the edge and moving spec §6.2's published
// station timestamps by ~8 seconds. Not a trade worth making. The cost that mattered is in
// refineSegmentCrossing, where the root IS smooth and the derivative IS free.
//
// `speedLo` comes from the caller's coarse series row - the same value it already tested
// the sign of to decide a station is in this bracket at all. Re-sampling it would be a
// spawn for a number in hand and could, in principle, disagree with the decision that got
// us here.
function refineStationJd(provider, jdLo, jdHi, speedLo) {
  let lo = jdLo;
  let hi = jdHi;
  let speedAtLo = speedLo;
  while (hi - lo > JD_TOLERANCE) {
    const mid = (lo + hi) / 2;
    const speedMid = provider.positionAt(mid).speed;
    if (Math.sign(speedMid) === Math.sign(speedAtLo)) {
      lo = mid;
      speedAtLo = speedMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// One swetest spawn (via provider.seriesFor) plus a handful more for station refinement:
// the coarse daily series, its stations refined to sub-second precision, and the
// resulting monotone sub-intervals ("segments") crossing enumeration runs against.
//
// Segmentation happens at DAY-STEP granularity, not just at stations: consecutive coarse
// samples are safe to unwrap and scan directly (Q1's margins guarantee at most one
// station and less than 180 degrees of travel per day-step, for every body up to the
// Moon), *except* the one day-step that contains a station, which is non-monotone within
// itself and is split into two segments at the refined station JD so nothing crossed
// during that day's excursion is missed.
export function scanTransitingBody(provider, startJd, endJd, stepDays = 1) {
  const series = provider.seriesFor(startJd, endJd, stepDays);
  if (series.length < 2) return { series, stations: [], segments: [] };

  const stations = [];
  const segments = [];
  let cum = series[0].longitude;

  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    const rowCum = cum + wrap180(curr.longitude - prev.longitude);
    const stationed = prev.speed !== 0 && curr.speed !== 0 && Math.sign(prev.speed) !== Math.sign(curr.speed);

    if (stationed) {
      const stationJd = refineStationJd(provider, prev.jd, curr.jd, prev.speed);
      const stationPos = provider.positionAt(stationJd);
      const stationCum = cum + wrap180(stationPos.longitude - prev.longitude);
      stations.push({
        jd: stationJd,
        longitude: mod360(stationPos.longitude),
        speed: stationPos.speed,
        direction: curr.speed > 0 ? 'direct' : 'retrograde',
      });
      segments.push({ jdLo: prev.jd, jdHi: stationJd, uLo: cum, uHi: stationCum });
      segments.push({ jdLo: stationJd, jdHi: curr.jd, uLo: stationCum, uHi: rowCum });
    } else {
      segments.push({ jdLo: prev.jd, jdHi: curr.jd, uLo: cum, uHi: rowCum });
    }

    cum = rowCum;
  }

  return { series, stations, segments };
}

// Public station search: same as scanTransitingBody, formatted for standalone use/output
// (spec §3.3 station event shape, minus natal_contacts - see natalContactsFor below for
// composing that in, since the engine has no natal chart of its own to check against).
export function findStations(provider, startJd, endJd, stepDays = 1) {
  const { stations } = scanTransitingBody(provider, startJd, endJd, stepDays);
  return stations.map((s) => ({
    type: 'station',
    datetime: isoFromJd(s.jd),
    jd: s.jd,
    direction: s.direction,
    longitude: s.longitude,
    speed: s.speed,
    ...signAndDegree(s.longitude),
  }));
}

// Refine the single crossing of `targetU` on a monotone segment, returning the position
// there as well - the caller needs longitude/speed at the crossing and this already has
// them, so handing back only a JD would cost an extra spawn to re-read what was just read.
//
// Safeguarded Newton (SUP-387), not bisection: every positionAt returns `speed` alongside
// `longitude`, and speed IS du/dt for the segment's unwrapped longitude u, so the
// derivative is free and the step is `residual / speed`. Convergence is quadratic - 4-6
// samples, against the 21 halvings a bisection needed to take a day-wide segment down to
// JD_TOLERANCE and the 30 it needed at the progressed rate, where a segment is a whole
// tropical year of target time (log2(365.24 / 5.8e-7)).
//
// The bracket is kept and narrowed on every sample, exactly as the bisection did, and any
// Newton step landing outside it falls back to that bisection - so a segment whose speed
// misleads (near a station the segment boundary didn't catch, or an ephemeris glitch)
// degrades to the old algorithm's behaviour instead of running away. The first guess is a
// linear interpolation across the segment rather than its midpoint: uLo/uHi are already
// known, so it costs nothing and starts closer.
function refineSegmentCrossing(provider, segment, targetU) {
  const { jdLo, jdHi, uLo, uHi } = segment;
  const increasing = uHi > uLo;
  const refLon = mod360(uLo);

  let lo = jdLo;
  let hi = jdHi;
  const fraction = (targetU - uLo) / (uHi - uLo);
  const guess = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0.01), 0.99) : 0.5;
  let jd = jdLo + (jdHi - jdLo) * guess;
  let sample = provider.positionAt(jd);

  for (let i = 0; i < MAX_REFINE_SAMPLES; i++) {
    const u = uLo + wrap180(sample.longitude - refLon);
    const residual = u - targetU;
    if (increasing === (residual < 0)) lo = jd; else hi = jd;

    // The Newton correction is also the error estimate: residual/speed is how far in time
    // this sample sits from the root. Once that is inside tolerance the sample in hand IS
    // the answer, so stop before paying for another one.
    const correction = sample.speed !== 0 ? residual / sample.speed : NaN;
    if (Math.abs(correction) <= JD_TOLERANCE || hi - lo <= JD_TOLERANCE) break;

    const next = jd - correction;
    jd = Number.isFinite(next) && next > lo && next < hi ? next : (lo + hi) / 2;
    sample = provider.positionAt(jd);
  }

  return { jd, sample };
}

// Every crossing of `targetBase + 360k` across all `segments`, sorted ascending by time.
// This is the "enumerate, don't sample" step (Q1): each segment is monotone by
// construction, so the number of crossings is known by arithmetic (how many multiples of
// 360 fit between its endpoints) before any bisection runs.
function enumerateCrossings(provider, segments, targetBase) {
  const crossings = [];

  for (const segment of segments) {
    const { uLo, uHi } = segment;
    if (uLo === uHi) continue;

    const lo = Math.min(uLo, uHi);
    const hi = Math.max(uLo, uHi);
    const kLo = Math.ceil((lo - targetBase) / 360);
    const kHi = Math.floor((hi - targetBase) / 360);

    for (let k = kLo; k <= kHi; k++) {
      const { jd, sample } = refineSegmentCrossing(provider, segment, targetBase + 360 * k);
      crossings.push({ jd, longitude: sample.longitude, speed: sample.speed });
    }
  }

  crossings.sort((a, b) => a.jd - b.jd);
  return crossings;
}

// Every aspect contact (spec §3.2) between `provider` and `natalLongitude + aspectAngle`
// within [startJd, endJd]: one entry per orb EPISODE, not per (target, aspect) pair. A
// transiting body can enter and leave orb of the same natal point more than once in a
// wide window (Mars returns to a point roughly every 2 years), and each visit is a
// separate row with its own enters_orb/leaves_orb/passes/closest_approach - so spec
// §3.2's "one row per (transiting body x natal point x aspect)" is really "one row per
// orb episode of that triple"; multiple episodes just sort together by `enters_orb`.
// `segments`/`stations` come from scanTransitingBody for this same provider/window -
// callers reuse one scan across every (target, aspect) pair for a given transiting body
// rather than rescanning per pair.
//
// Returns [] when the body never comes within orb during the window at all (as opposed
// to a contact with an empty `passes` array, which is a real result - see spec Q4: a
// station that gets close without perfecting still has an orb envelope, just no exact
// pass).
export function findContacts({ provider, segments, stations, natalLongitude, aspectAngle, orbAllowed, startJd, endJd }) {
  const targetBase = natalLongitude + aspectAngle;
  const targetMod = mod360(targetBase);

  const exactCrossings = enumerateCrossings(provider, segments, targetBase);
  const allPasses = exactCrossings.map((c) => ({
    datetime: isoFromJd(c.jd),
    jd: c.jd,
    longitude: mod360(c.longitude),
    ...signAndDegree(c.longitude),
    speed: c.speed,
    retrograde: c.speed < 0,
  }));

  const startPos = provider.positionAt(startJd);
  const endPos = provider.positionAt(endJd);
  const gStart = Math.abs(wrap180(startPos.longitude - targetMod));
  const gEnd = Math.abs(wrap180(endPos.longitude - targetMod));

  // Every boundary crossing of orbAllowed on either side of the target, regardless of
  // whether the window's own endpoints happen to already be in orb - unlike the prior
  // first/last-crossing approach, multiple episodes require the full crossing list.
  const orbCrossings = [
    ...enumerateCrossings(provider, segments, targetBase - orbAllowed),
    ...enumerateCrossings(provider, segments, targetBase + orbAllowed),
  ].sort((a, b) => a.jd - b.jd);

  // In-orb state timeline: the window cut at every orb-boundary crossing. Each interval's
  // in/out state is determined by evaluating |g| at its MIDPOINT rather than trusting
  // crossing parity - self-verifying against a missed or duplicated crossing. Adjacent
  // in-orb intervals merge into one episode as the loop runs, since boundaries are
  // contiguous and sorted.
  const boundaries = [startJd, ...orbCrossings.map((c) => c.jd), endJd];
  const episodes = [];
  let open = null;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    if (hi - lo < JD_TOLERANCE) continue; // degenerate interval (coincident crossings)

    const mid = (lo + hi) / 2;
    const midLongitude = provider.positionAt(mid).longitude;
    const inOrb = Math.abs(wrap180(midLongitude - targetMod)) <= orbAllowed;

    if (inOrb) {
      if (open) {
        open.leavesOrbJd = hi;
      } else {
        open = { entersOrbJd: lo, leavesOrbJd: hi };
        episodes.push(open);
      }
    } else {
      open = null;
    }
  }

  return episodes.map((episode) => {
    const entersOrbTruncated = episode.entersOrbJd === startJd;
    const leavesOrbTruncated = episode.leavesOrbJd === endJd;
    const passes = allPasses.filter((p) => p.jd >= episode.entersOrbJd && p.jd <= episode.leavesOrbJd);

    // closest_approach is computed, not searched (spec Q4): on a monotone segment |g| is
    // minimised at a segment endpoint or a root, so the candidate set is exactly this
    // episode's exact passes (orb 0), the stations inside it, and its own two endpoints -
    // a found orb boundary (orb = orbAllowed) or, only when truncated, the window edge
    // (gStart/gEnd). A global startJd/endJd candidate must not leak into an episode that
    // doesn't touch the window edge.
    const candidates = [
      ...passes.map((p) => ({ jd: p.jd, orb: 0, stationary: false })),
      ...stations
        .filter((s) => s.jd >= episode.entersOrbJd && s.jd <= episode.leavesOrbJd)
        .map((s) => ({ jd: s.jd, orb: Math.abs(wrap180(s.longitude - targetMod)), stationary: true })),
      entersOrbTruncated
        ? { jd: startJd, orb: gStart, stationary: false }
        : { jd: episode.entersOrbJd, orb: orbAllowed, stationary: false },
      leavesOrbTruncated
        ? { jd: endJd, orb: gEnd, stationary: false }
        : { jd: episode.leavesOrbJd, orb: orbAllowed, stationary: false },
    ];
    const closest = candidates.reduce((best, c) => (c.orb < best.orb ? c : best));

    return {
      aspect_angle: mod360(aspectAngle),
      orb_allowed: orbAllowed,
      enters_orb: isoFromJd(episode.entersOrbJd),
      leaves_orb: isoFromJd(episode.leavesOrbJd),
      enters_orb_truncated: entersOrbTruncated,
      leaves_orb_truncated: leavesOrbTruncated,
      passes,
      closest_approach: {
        datetime: isoFromJd(closest.jd),
        orb: closest.orb,
        stationary: closest.stationary,
      },
    };
  });
}

// Public crossing search: every exact crossing of `targetLongitude` (mod 360, repeating
// every 360 degrees) across `segments`, with no orb envelope - the primitive that ingress
// (spec §1.2: sign and house ingress are "the same root-find against different target
// sets") needs, as opposed to findContacts' orb-episode grouping for aspects. Same
// formatting as a findContacts pass (minus jd), same public-wrapper pattern as
// findStations above: this exposes enumerateCrossings, it doesn't reimplement it.
export function findCrossings(provider, segments, targetLongitude) {
  return enumerateCrossings(provider, segments, targetLongitude).map((c) => ({
    datetime: isoFromJd(c.jd),
    jd: c.jd,
    longitude: mod360(c.longitude),
    ...signAndDegree(c.longitude),
    speed: c.speed,
    retrograde: c.speed < 0,
  }));
}

// Natal contacts for a single longitude (a station or a lunation) against a list of
// natal targets. `aspectAngles` is a plain `{ name: degrees }` map (e.g. MAJOR_ASPECTS,
// optionally spread with minors) and `orbAllowedFor(targetName, aspectName)` is a
// caller-supplied closure over an already-resolved orb table (lib/aspects.js) - the
// engine never reaches for MOIETIES/ORB_CLASSES itself.
//
// Uses absolute separation (matching lib/aspects.js's normalizeSeparation/
// matchAspectsForPair), not a signed offset from one side: a square, sextile or trine has
// two target longitudes 180 degrees apart (natal+angle and natal-angle) that are equally
// "square"/"sextile"/"trine" - conjunction (0) and opposition (180) are the only angles
// where those two longitudes coincide. A signed `longitude - target.longitude - angle`
// check only ever matches one of the two and silently misses the other.
export function natalContactsFor(longitude, targets, aspectAngles, orbAllowedFor) {
  const contacts = [];
  for (const target of targets) {
    const separation = Math.abs(wrap180(longitude - target.longitude));
    for (const [aspectName, angle] of Object.entries(aspectAngles)) {
      const orb = Math.abs(separation - angle);
      if (orb <= orbAllowedFor(target.name, aspectName)) {
        contacts.push({ natal_point: target.name, aspect: aspectName, orb });
      }
    }
  }
  return contacts;
}

// Wraps a provider so the same (body, jd) is never sampled twice (SUP-387). The engine
// re-reads a handful of instants relentlessly - findContacts alone re-reads the window's
// two endpoints once per (natal target x aspect x search angle), 136 times per body on a
// default request - and every one of those was its own synchronous swetest spawn. Measured
// duplicate rate before this wrapper: 53% of all samples at the progressed rate over a
// 3-year window, 25% at the transit rate over a year.
//
// Keyed on the exact JD float, so it only ever collapses samples that were literally the
// same instant - it does not round, and therefore cannot change a single output value.
// Callers hold one of these per body for the length of one search and drop it after, which
// is what bounds the memory: the cache is per-request, not a module-level singleton that
// would grow for the life of the server process.
//
// `prime`/`isPrimed` let a caller that fetched a position some cheaper way (index.js's
// two-body batched swetest call for pair aspects) fill this same cache instead of keeping
// a second one alongside it.
export function memoizeProvider(provider) {
  const samples = new Map();
  return {
    ...provider,
    positionAt(jd) {
      const hit = samples.get(jd);
      if (hit !== undefined) return hit;
      const sample = provider.positionAt(jd);
      samples.set(jd, sample);
      return sample;
    },
    prime(jd, sample) {
      if (!samples.has(jd)) samples.set(jd, sample);
    },
    isPrimed(jd) {
      return samples.has(jd);
    },
  };
}

// Wraps a (sunProvider, moonProvider) pair as a single provider over the Sun-Moon
// relative longitude, so lunations can reuse scanTransitingBody/enumerateCrossings
// unchanged. Its "speed" (11.8-14.6 deg/day, always positive) never reaches zero, so
// scanTransitingBody finds zero stations here - lunations need no segmentation (spec
// Q1 scope note), which falls out of this composition rather than being special-cased.
function relativeLunarProvider(sunProvider, moonProvider) {
  return {
    seriesFor(startJd, endJd, stepDays) {
      const sunRows = sunProvider.seriesFor(startJd, endJd, stepDays);
      const moonRows = moonProvider.seriesFor(startJd, endJd, stepDays);
      return sunRows.map((s, i) => {
        const m = moonRows[i];
        return { jd: s.jd, longitude: mod360(m.longitude - s.longitude), speed: m.speed - s.speed };
      });
    },
    positionAt(jd) {
      const s = sunProvider.positionAt(jd);
      const m = moonProvider.positionAt(jd);
      return { longitude: mod360(m.longitude - s.longitude), speed: m.speed - s.speed };
    },
  };
}

// All eight Rudhyar-lineage band starts (SUP-360 §1/§2), each 45deg apart - the shipped
// `new`/`full` (0/180) and `first_quarter`/`last_quarter` (90/270) are already exactly the
// band starts at those angles, so extending to eight is one consistent scheme, not a mix
// of two (spec §2).
const LUNATION_PHASE_ANGLES = {
  new: 0,
  crescent: 45,
  first_quarter: 90,
  gibbous: 135,
  full: 180,
  disseminating: 225,
  last_quarter: 270,
  balsamic: 315,
};

// Three selectable emission sets (SUP-360 §3), each a strict superset of the one before:
// "syzygy" (New/Full) -> "quarters" (+ First/Last Quarter) -> "eight_phase" (+ Crescent/
// Gibbous/Disseminating/Balsamic). Every phase kept from one set to the next carries an
// identical name and, since the underlying crossing search never changes, an identical
// datetime - see the plan's §7.1 superset invariant.
const LUNATION_PHASE_SETS = {
  syzygy: ['new', 'full'],
  quarters: ['new', 'first_quarter', 'full', 'last_quarter'],
  eight_phase: Object.keys(LUNATION_PHASE_ANGLES),
};

// New/Full Moon by default, or the wider quarter/eight-phase sets on request, within
// [startJd, endJd]: Sun-Moon exact aspects at 45deg multiples, found via the directed
// relativeLunarProvider + enumerateCrossings path (spec §6.1) rather than the aspect
// matcher, which folds separations to <=180deg and cannot tell Crescent (45deg) from
// Balsamic (315deg) or Gibbous (135deg) from Disseminating (225deg). `longitude` on each
// result is the Moon's absolute ecliptic longitude at the lunation, not the (already-
// zero-crossed) relative one.
export function findLunations({ sunProvider, moonProvider, startJd, endJd, lunationPhases = 'syzygy', stepDays = 1 }) {
  const relativeProvider = relativeLunarProvider(sunProvider, moonProvider);
  const { segments } = scanTransitingBody(relativeProvider, startJd, endJd, stepDays);

  const phaseNames = LUNATION_PHASE_SETS[lunationPhases];

  const lunations = [];
  for (const phase of phaseNames) {
    const angle = LUNATION_PHASE_ANGLES[phase];
    for (const crossing of enumerateCrossings(relativeProvider, segments, angle)) {
      const moonPos = moonProvider.positionAt(crossing.jd);
      lunations.push({
        type: 'lunation',
        phase,
        datetime: isoFromJd(crossing.jd),
        jd: crossing.jd,
        longitude: mod360(moonPos.longitude),
        ...signAndDegree(moonPos.longitude),
      });
    }
  }

  lunations.sort((a, b) => a.jd - b.jd);
  return lunations;
}

// Attaches an `eclipse` annotation (absent, never null, when there isn't one) to New/Full
// Moon lunations whose JD is within `toleranceDays` of an eclipse maximum of the matching
// kind (New <-> solar, Full <-> lunar). `datetime` stays the lunation's own exact syzygy
// throughout - the eclipse's `maximum_datetime` is a separate field, never a substitute
// (spec §1.6/Q7: the two differ by minutes and neither may silently stand in for the other).
export function annotateEclipses(lunations, { solarEclipses = [], lunarEclipses = [] } = {}, toleranceDays = 1) {
  return lunations.map((lunation) => {
    const candidates = lunation.phase === 'new' ? solarEclipses : lunation.phase === 'full' ? lunarEclipses : [];
    if (candidates.length === 0) return lunation;

    let best = null;
    let bestDist = Infinity;
    for (const eclipse of candidates) {
      const dist = Math.abs(eclipse.jd - lunation.jd);
      if (dist < bestDist) {
        bestDist = dist;
        best = eclipse;
      }
    }
    if (!best || bestDist > toleranceDays) return lunation;

    return {
      ...lunation,
      eclipse: {
        eclipse_type: best.eclipse_type,
        maximum_datetime: isoFromJd(best.jd),
        magnitudes: best.magnitudes,
        saros_series: best.saros_series,
        saros_number: best.saros_number,
      },
    };
  });
}
