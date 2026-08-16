import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { jdFromDate } from '../lib/ephemeris-series.js';
import { progressedBodyProvider, progressedMcProvider } from '../lib/progressed-provider.js';
import { TROPICAL_YEAR_DAYS } from '../lib/progressions.js';
import { DAY_CHART, SOUTHERN_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

// SUP-385: opt-in, because these are the most expensive tests in the repo - every one of
// them searches a 90-year progressed window, and each position sample is its own
// synchronous `swetest` process spawn (lib/ephemeris-series.js, via lib/swetest-exec.js).
//
// SUP-387 cut this file to ~11 minutes end to end, and it now finishes - which it had never
// once been observed to do. That is still far too long a wall clock to gate `npm test` on
// (36s today), so the quarantine stays: run it with `npm run test:slow`, or RUN_SLOW_TESTS=1.
// Closing the remaining gap means removing the process spawn itself (a persistent swetest,
// or libswe bindings), which is its own ticket - not a shorter window here.
//
// Correcting what this comment used to claim, because the numbers were attributed to the
// wrong thing and someone will otherwise optimise the wrong code. It said "61,150 swetest
// spawns ... for a single pair" and "the cost is driven by the WINDOW, not the pair count".
// The 61,150 was the whole find_events call: measured against an `include_pair_aspects:
// false` baseline, the pair branch is ~8% of it at the progressed rate and ~12% at the
// transit rate, and the rest is the ordinary moving-to-natal contacts[] search - which runs
// identically whether pairs are on or off, and which none of the tests below assert on.
// Cost is the sample count of the WHOLE aspect search: window x moving bodies x natal
// targets x aspect angles. Extra pairs looked free because pairs were never the expensive
// part.
//
// This is a quarantine, not a diagnosis of a broken test - nothing here hangs, it is
// arithmetically that slow. Per-test timings and provenance: CONTRIBUTING.md.
const RUN_SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1';
const slow = !HAS_SWETEST
  ? { skip: 'swetest unavailable' }
  : RUN_SLOW_TESTS
    ? {}
    : { skip: 'slow pair search quarantined by SUP-385 - run with RUN_SLOW_TESTS=1' };

const Y = TROPICAL_YEAR_DAYS;

function assertCloseIso(actual, expected, toleranceSec = 2) {
  const diff = Math.abs(new Date(actual).getTime() - new Date(expected).getTime()) / 1000;
  assert.ok(diff <= toleranceSec, `expected ${actual} to be within ${toleranceSec}s of ${expected}`);
}

function passCount(pairContacts) {
  return pairContacts.reduce((sum, c) => sum + c.passes.length, 0);
}

function pairName(row) {
  return [row.body_a, row.body_b].sort().join('-');
}

function findEpisodeNear(contacts, key, aspect, entersOrbIso, toleranceSec = 2) {
  return contacts.find((c) => pairName(c) === key && c.aspect === aspect
    && Math.abs(new Date(c.enters_orb).getTime() - new Date(entersOrbIso).getTime()) / 1000 <= toleranceSec);
}

// Undirected aspect -> lunation phase (SUP-360's eight-phase scheme, LUNATION_PHASE_ANGLES
// in lib/event-search.js). Several phases share one aspect name because an aspect row is
// undirected and cannot distinguish waxing from waning (spec §6.2) - crescent/balsamic both
// read as semisquare, gibbous/disseminating both read as sesquiquadrate.
const PHASE_TO_ASPECT = {
  new: 'conjunction',
  crescent: 'semisquare',
  first_quarter: 'square',
  gibbous: 'sesquiquadrate',
  full: 'opposition',
  disseminating: 'sesquiquadrate',
  last_quarter: 'square',
  balsamic: 'semisquare',
};

// --- §9.1 The lunation identity - the headline test --------------------------------------

test('§9.1 pair_contacts (Sun, Moon) majors reproduce every quarters lunation datetime to the second with the correct aspect mapping, 25 episodes / 25 passes', slow, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression',
  };

  const lunations = await server.handleToolCall('find_events', {
    ...window, event_types: ['lunation'], lunation_phases: 'quarters',
  });
  const pairs = await server.handleToolCall('find_events', {
    ...window, event_types: ['aspect'], include_pair_aspects: true, pair_bodies: ['Sun', 'Moon'], include_angles: false,
  });

  assert.equal(pairs.pair_contacts.length > 0, true);
  assert.ok(pairs.pair_contacts.every((c) => pairName(c) === 'Moon-Sun'));

  const pairAspectByDatetime = new Map();
  for (const c of pairs.pair_contacts) {
    for (const p of c.passes) pairAspectByDatetime.set(p.datetime, c.aspect);
  }

  assert.equal(lunations.events.length, 12, 'expected 12 quarters lunation events in this 90yr window');
  for (const lunation of lunations.events) {
    assert.ok(pairAspectByDatetime.has(lunation.datetime), `expected pair_contacts to reproduce ${lunation.phase}@${lunation.datetime}`);
    assert.equal(
      pairAspectByDatetime.get(lunation.datetime), PHASE_TO_ASPECT[lunation.phase],
      `expected ${lunation.phase} to map to ${PHASE_TO_ASPECT[lunation.phase]}, got ${pairAspectByDatetime.get(lunation.datetime)}`
    );
  }

  // Declared spec departure: SUP-361 §9.1 claims 26 orb episodes / 25 exact passes, with a
  // 26th episode entering orb 2079-11-19 at closest_approach.orb 11.9918deg. That figure is
  // wrong: 11.9918 is the progressed Sun-Moon RELATIVE RATE in deg/yr (not an orb) recorded
  // into the closest_approach.orb slot, it violates the 1deg fixed major-orb model (11.99deg
  // is 12x the allowed orb - no row can be emitted at all), and it contradicts the spec's
  // own §9.2 total (109 = 27+26+25+25 requires Moon-Sun at 25, not 26). Measured directly
  // against this implementation (bb9fb07, DAY_CHART, 1990-01-01T12:00Z to 2080-01-01,
  // Sun-Moon majors): 25 orb episodes, 25 exact passes, every episode fully perfected
  // (enters_orb_truncated=false, leaves_orb_truncated=false on all 25), nothing touches the
  // window past the last leave-orb at 2078-09-19T02:58:01Z. The truncated-no-pass guard this
  // assertion originally wanted is real but belongs to §9.4 (Mercury-Venus, 2 episodes / 1
  // pass, leaves_orb_truncated) below, which already exercises it.
  const majorEpisodes = pairs.pair_contacts.filter((c) => c.category === 'major');
  assert.equal(majorEpisodes.length, 25);
  assert.equal(passCount(majorEpisodes), 25);
  assert.ok(majorEpisodes.every((c) => !c.enters_orb_truncated && !c.leaves_orb_truncated));
});

test('§9.1/§6.1 eight_phase identity: all 24 phase datetimes and aspect mappings reproduced to the second by pair_contacts with include_minor', slow, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression',
  };

  const lunations = await server.handleToolCall('find_events', {
    ...window, event_types: ['lunation'], lunation_phases: 'eight_phase',
  });
  const pairs = await server.handleToolCall('find_events', {
    ...window, event_types: ['aspect'], include_pair_aspects: true, pair_bodies: ['Sun', 'Moon'], include_angles: false, include_minor: true,
  });

  assert.equal(lunations.events.length, 24);

  const pairAspectByDatetime = new Map();
  for (const c of pairs.pair_contacts) {
    for (const p of c.passes) pairAspectByDatetime.set(p.datetime, c.aspect);
  }
  for (const lunation of lunations.events) {
    assert.ok(pairAspectByDatetime.has(lunation.datetime), `expected pair_contacts (with include_minor) to reproduce ${lunation.phase}@${lunation.datetime}`);
    assert.equal(
      pairAspectByDatetime.get(lunation.datetime), PHASE_TO_ASPECT[lunation.phase],
      `expected ${lunation.phase} to map to ${PHASE_TO_ASPECT[lunation.phase]}, got ${pairAspectByDatetime.get(lunation.datetime)}`
    );
  }
});

// --- §9.2 Default progressed pair set counts ----------------------------------------------

test('§9.2 default progressed pair_bodies (10 pairs) over 90yr: per-pair episode/pass counts', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  });

  assert.equal(result.settings_used.pair_bodies.length, 5);
  assert.equal(result.settings_used.pairs_searched.length, 10);

  const byPair = {};
  for (const c of result.pair_contacts) {
    const key = pairName(c);
    if (!byPair[key]) byPair[key] = { episodes: 0, passes: 0 };
    byPair[key].episodes += 1;
    byPair[key].passes += c.passes.length;
  }

  // Exact per-pair table from SUP-361 §9.2, measured against this implementation (bb9fb07).
  const expected = {
    'Moon-Venus': { episodes: 27, passes: 27 },
    'Mars-Moon': { episodes: 26, passes: 26 },
    'Moon-Sun': { episodes: 25, passes: 25 },
    'Mercury-Moon': { episodes: 25, passes: 25 },
    'Mercury-Sun': { episodes: 2, passes: 2 },
    'Mercury-Venus': { episodes: 2, passes: 1 },
    'Sun-Venus': { episodes: 1, passes: 1 },
    'Mars-Mercury': { episodes: 1, passes: 1 },
  };
  for (const [key, counts] of Object.entries(expected)) {
    assert.deepEqual(byPair[key], counts, `expected ${key} episodes/passes to match §9.2`);
  }
  assert.equal(byPair['Mars-Sun'], undefined, 'Sun-Mars has zero major episodes (§9.3)');
  assert.equal(byPair['Mars-Venus'], undefined, 'Venus-Mars has zero major episodes (§9.3)');

  const totalEpisodes = result.pair_contacts.length;
  const totalPasses = passCount(result.pair_contacts);
  assert.equal(totalEpisodes, 109);
  assert.equal(totalPasses, 108);

  const moonPairs = ['Moon-Sun', 'Mercury-Moon', 'Moon-Venus', 'Mars-Moon'];
  const moonEpisodes = moonPairs.reduce((sum, key) => sum + (byPair[key]?.episodes || 0), 0);
  assert.equal(moonEpisodes, 103, 'expected the four Moon pairs to sum to 103 of the 109 total episodes');
});

// --- §9.3 Empty is a correct answer ---------------------------------------------------------

test('§9.3 Sun-Mars and Venus-Mars: zero major-aspect episodes over 90yr; nonzero with include_minor', slow, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  };

  const majors = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Sun', 'Venus', 'Mars'] });
  assert.deepEqual(majors.pair_contacts.filter((c) => pairName(c) === 'Mars-Sun'), []);
  assert.deepEqual(majors.pair_contacts.filter((c) => pairName(c) === 'Mars-Venus'), []);

  const minors = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Sun', 'Venus', 'Mars'], include_minor: true });

  // Exact table from SUP-361 §9.3, measured against this implementation (bb9fb07).
  //
  // Declared spec departure on the datetime figures: these three pairs are the slowest
  // relative rates this suite exercises (Sun-Mars, Venus-Mars), where the separation steps
  // by exactly swetest's own longitude quantum (1e-7deg) every ~5s of clock time - roughly
  // 2.5s of clock time per quantum. Every crossing - orb boundary and exact perfection
  // alike, both resolved at the same relative rate - can only be pinned to the nearest
  // quantum step, so any figure within that band is equally correct, and a 2s tolerance
  // asks the ephemeris to resolve finer than its own data carries. Measured directly:
  // venusMarsSemisquare.leaves_orb crosses at 06:37:57Z here vs the spec table's 06:38:02Z
  // (both ~2.5s from the true ~06:37:59.5Z crossing), and venusMarsSemisextile's exact pass
  // lands at 06:04:53Z vs the table's 06:04:56Z - one quantum apart. All datetime
  // assertions on these three episodes therefore carry 10s. Contrast §9.1's Sun-Moon
  // identity, where the ~12deg/yr relative rate makes one quantum a small fraction of a
  // second, so "to the second" holds there.
  const sunMars = findEpisodeNear(minors.pair_contacts, 'Mars-Sun', 'semisquare', '2035-09-29T11:59:57Z', 10);
  assert.ok(sunMars, 'expected Sun-Mars semisquare episode with include_minor');
  assertCloseIso(sunMars.enters_orb, '2035-09-29T11:59:57Z', 10);
  assertCloseIso(sunMars.passes[0].datetime, '2037-07-14T04:39:52Z', 10);
  assertCloseIso(sunMars.leaves_orb, '2039-05-02T13:29:39Z', 10);

  const venusMarsSemisquare = findEpisodeNear(minors.pair_contacts, 'Mars-Venus', 'semisquare', '2000-04-14T03:35:03Z', 10);
  assert.ok(venusMarsSemisquare, 'expected Venus-Mars semisquare episode with include_minor');
  assertCloseIso(venusMarsSemisquare.enters_orb, '2000-04-14T03:35:03Z', 10);
  assertCloseIso(venusMarsSemisquare.passes[0].datetime, '2000-09-09T08:29:31Z', 10);
  assertCloseIso(venusMarsSemisquare.leaves_orb, '2001-02-03T06:38:02Z', 10);

  const venusMarsSemisextile = findEpisodeNear(minors.pair_contacts, 'Mars-Venus', 'semisextile', '2011-10-18T03:21:29Z', 10);
  assert.ok(venusMarsSemisextile, 'expected Venus-Mars semisextile episode with include_minor');
  assertCloseIso(venusMarsSemisextile.enters_orb, '2011-10-18T03:21:29Z', 10);
  assertCloseIso(venusMarsSemisextile.passes[0].datetime, '2012-03-08T06:04:56Z', 10);
  assertCloseIso(venusMarsSemisextile.leaves_orb, '2012-07-29T05:14:24Z', 10);
});

// --- §9.4 An episode with no pass, and a truncated one --------------------------------------

test('§9.4 Mercury-Venus majors over 90yr: 2 episodes, 1 pass; the second is truncated with no exact pass', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Mercury', 'Venus'], include_angles: false,
  });

  const mercuryVenus = result.pair_contacts.filter((c) => pairName(c) === 'Mercury-Venus' && c.category === 'major');
  assert.equal(mercuryVenus.length, 2);
  assert.equal(passCount(mercuryVenus), 1);

  const perfected = mercuryVenus.find((c) => c.passes.length === 1);
  assert.ok(perfected);
  assert.equal(perfected.aspect, 'conjunction');
  assertCloseIso(perfected.enters_orb, '2023-10-13T11:47:24Z');
  assertCloseIso(perfected.passes[0].datetime, '2024-07-19T03:04:39Z');
  assertCloseIso(perfected.leaves_orb, '2025-04-26T04:25:49Z');

  const truncated = mercuryVenus.find((c) => c.passes.length === 0);
  assert.ok(truncated);
  assert.equal(truncated.leaves_orb_truncated, true);
  // 10s, not the default 2s, for the same reason §9.3's assertions carry 10s: this
  // particular boundary is below the ephemeris's own resolution. Probed directly at this
  // instant, the progressed Mercury-Venus separation is 0.002527 deg/day of target time,
  // so one 1e-7 deg swetest print quantum is 3.4 SECONDS wide - the separation crosses the
  // orb boundary as a staircase with 3.4-second treads, and which instant inside a tread
  // gets reported is the root-finder's arbitrary tiebreak, not an astronomical fact.
  // SUP-387's refiner picks a different point in that tread than SUP-361's bisection did
  // (2079-01-23T03:10:00Z vs 03:09:55Z, 1.5 treads); the Astrology Advisor cleared exactly
  // this class of divergence for exactly this pair in advance. Everything asserted around
  // it - 2 episodes, 1 pass, the closest-approach orb, the truncation flag - is unchanged.
  assertCloseIso(truncated.enters_orb, '2079-01-23T03:09:55Z', 10);
  assert.ok(
    Math.abs(truncated.closest_approach.orb - 0.1523) < 1e-3,
    `expected closest_approach.orb ~0.1523, got ${truncated.closest_approach.orb}`
  );
});

// --- §9.5 Structural rules -------------------------------------------------------------------

test('§9.5 (Sun, Midheaven) never appears even when explicitly requested, at either angle_method; the solar_arc invariant holds', slow, async () => {
  const server = new SwissEphemerisServer();
  for (const angle_method of ['solar_arc', 'naibod']) {
    const result = await server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
      rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
      pair_bodies: ['Sun', 'Midheaven'], include_angles: true, angle_method,
    });
    assert.deepEqual(result.pair_contacts, []);
    assert.deepEqual(result.settings_used.pairs_searched, []);
  }

  // §4.2/§9.5: assert the underlying invariant directly, not just the exclusion. Under
  // solar_arc, MC(t) = natalMC + (pSun(t) - natalSun) by construction (progressedMcProvider,
  // lib/progressed-provider.js) - so lambda(pSun) - lambda(pMC) = natalSun - natalMC for
  // every t, a true mathematical constant. Exercised directly on the pure providers the pair
  // path composes (not through calculate_secondary_progressions' swetest house-cusp
  // roundtrip, which is only approximately equal to this analytic value) so the 1e-9
  // tolerance the spec asks for is meaningful rather than swetest noise.
  const birthJd = jdFromDate(new Date(DAY_CHART.datetime));
  const natalChart = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude, 'P');
  const sunProvider = progressedBodyProvider('Sun', { birthJd, yearLengthDays: Y });
  const mcProvider = progressedMcProvider({
    angleMethod: 'solar_arc',
    natalMcLongitude: natalChart.chart_points.Midheaven.longitude,
    natalSunLongitude: natalChart.planets.Sun.longitude,
    birthJd, yearLengthDays: Y, sunProvider,
  });

  const sampleJds = [birthJd, birthJd + 10 * Y, birthJd + 50 * Y, birthJd + 89 * Y];
  const diffs = sampleJds.map((jd) => {
    const sunLon = sunProvider.positionAt(jd).longitude;
    const mcLon = mcProvider.positionAt(jd).longitude;
    return ((sunLon - mcLon) % 360 + 360) % 360;
  });
  for (let i = 1; i < diffs.length; i++) {
    assert.ok(
      Math.abs(diffs[i] - diffs[0]) < 1e-9,
      `expected lambda(pSun)-lambda(pMC) constant across the window, got ${diffs[0]} vs ${diffs[i]}`
    );
  }
});

test('§9.5 North Node never appears in a pair at any setting', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Sun', 'Moon', 'North Node'], include_angles: false, include_minor: true,
  });
  assert.ok(result.pair_contacts.every((c) => c.body_a !== 'North Node' && c.body_b !== 'North Node'));
  assert.ok(result.settings_used.pairs_searched.every((p) => p.body_a !== 'North Node' && p.body_b !== 'North Node'));
});

// Not gated by `slow`: this one rejects in parameter validation, before any pair search
// runs, so it costs nothing and keeps one assertion from this file in the default gate.
test('§9.5 Part of Fortune is not a valid pair_bodies member (errors rather than silently doing nothing)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
      rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
      pair_bodies: ['Sun', 'Part of Fortune'],
    }),
    /Unknown pair body/
  );
});

test('§9.5 retrograde is per body, not per relative rate: reversing pair order changes no flag', slow, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  };

  const forward = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Sun', 'Moon'] });
  const reversed = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Moon', 'Sun'] });

  assert.ok(forward.pair_contacts.length > 0);

  const passesByDatetime = (result) => {
    const map = new Map();
    for (const c of result.pair_contacts) {
      for (const p of c.passes) map.set(p.datetime, p);
    }
    return map;
  };
  const fwdPasses = passesByDatetime(forward);
  const revPasses = passesByDatetime(reversed);
  assert.equal(fwdPasses.size, revPasses.size);

  for (const [datetime, fwdPass] of fwdPasses) {
    const revPass = revPasses.get(datetime);
    assert.ok(revPass, `expected reversed pair_bodies to still produce a pass at ${datetime}`);
    assert.equal(fwdPass.body_a.retrograde, false, 'progressed Sun never retrogrades');
    assert.equal(revPass.body_a.retrograde, false);
    assert.equal(fwdPass.body_b.retrograde, false, 'progressed Moon never retrogrades');
    assert.equal(revPass.body_b.retrograde, false);
  }
});

test('§9.5/§8.1 sign/degree on a pair pass match each body\'s own absolute longitude, not the separation\'s', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Sun', 'Moon'], include_angles: false,
  });

  const conjunction = result.pair_contacts.find((c) => pairName(c) === 'Moon-Sun' && c.aspect === 'conjunction' && c.passes.length > 0);
  assert.ok(conjunction);
  const pass = conjunction.passes[0];

  const secProg = await server.handleToolCall('calculate_secondary_progressions', {
    birth_datetime: DAY_CHART.datetime, birth_latitude: DAY_CHART.latitude, birth_longitude: DAY_CHART.longitude,
    target_date: pass.datetime,
  });

  const bySun = pass.body_a.longitude === secProg.progressed_planets.Sun.longitude ? pass.body_a : pass.body_b;
  const byMoon = pass.body_a === bySun ? pass.body_b : pass.body_a;
  assert.ok(Math.abs(bySun.longitude - secProg.progressed_planets.Sun.longitude) < 1e-2);
  assert.equal(bySun.sign, secProg.progressed_planets.Sun.sign);
  assert.ok(Math.abs(byMoon.longitude - secProg.progressed_planets.Moon.longitude) < 1e-2);
  assert.equal(byMoon.sign, secProg.progressed_planets.Moon.sign);

  // Neither reported longitude should equal the RELATIVE separation (the bug §8.1 warns
  // against) - a conjunction's separation is near 0, which is nowhere near either body's
  // actual progressed longitude at this instant in a 1990-2080 window.
  assert.ok(Math.abs(pass.body_a.longitude) > 1);
  assert.ok(Math.abs(pass.body_b.longitude) > 1);
});

test('§9.5 pair_bodies is independent of bodies: bodies:["Moon"] with default pair_bodies still returns all 10 pairs', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    bodies: ['Moon'], include_angles: false,
  });
  assert.deepEqual(result.settings_used.bodies, ['Moon']);
  assert.equal(result.settings_used.pair_bodies.length, 5);
  assert.equal(result.settings_used.pairs_searched.length, 10);
});

test('§9.5 off by default: pair_contacts is empty without include_pair_aspects', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression',
  });
  assert.deepEqual(result.pair_contacts, []);
  assert.equal(result.settings_used.include_pair_aspects, false);
  // pairs_searched previews eligibility regardless of include_pair_aspects.
  assert.equal(result.settings_used.pairs_searched.length, 10);
});

test('§9.5 gated by event_types: include_pair_aspects true but event_types excludes "aspect" produces no pair_contacts', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['station'], include_pair_aspects: true,
  });
  assert.deepEqual(result.pair_contacts, []);
});

// --- §9.6 Transit rate -----------------------------------------------------------------------

test('§9.6 transit rate: default pair_bodies (21 pairs), 2026 window, moiety orbs', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['aspect'], include_pair_aspects: true,
  });

  assert.equal(result.settings_used.rate, 'transit');
  assert.equal(result.settings_used.orb_model, 'moiety');
  assert.deepEqual(result.settings_used.pair_bodies, ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Chiron']);
  assert.equal(result.settings_used.pairs_searched.length, 21);

  assert.equal(result.pair_contacts.length, 52, 'expected 52 orb episodes for 21 transit pairs in 2026');
  const totalPasses = result.pair_contacts.reduce((s, c) => s + c.passes.length, 0);
  assert.equal(totalPasses, 46, 'expected 46 exact passes for 21 transit pairs in 2026');
  // "full-window-in-orb" means the pair was in orb for the ENTIRE year and never reached
  // exact (both ends truncated, no pass). Spec §7 measures zero of these because at the
  // transit rate the outer planets actually move. There CAN be zero-pass episodes where
  // the approach reverses mid-window (Saturn-Uranus approaching a sextile then backing
  // off) - those are not full-window-in-orb because at least one orb edge is untruncated.
  const fullWindowInOrb = result.pair_contacts.filter((c) => c.enters_orb_truncated && c.leaves_orb_truncated && c.passes.length === 0);
  assert.equal(fullWindowInOrb.length, 0, 'expected zero full-window-in-orb-without-a-pass rows at the transit rate');
});

// --- §9.7 Southern hemisphere ------------------------------------------------------------------

test('§9.7 SOUTHERN_CHART: default progressed pair set produces no negative-longitude or NaN separations', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: SOUTHERN_CHART.datetime, latitude: SOUTHERN_CHART.latitude, longitude: SOUTHERN_CHART.longitude,
    window_start: SOUTHERN_CHART.datetime, window_end: '2090-03-20T06:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  });

  assert.ok(result.pair_contacts.length > 0);
  for (const c of result.pair_contacts) {
    assert.ok(Number.isFinite(c.aspect_angle) && c.aspect_angle >= 0);
    for (const p of c.passes) {
      assert.ok(Number.isFinite(p.body_a.longitude) && p.body_a.longitude >= 0 && p.body_a.longitude < 360);
      assert.ok(Number.isFinite(p.body_b.longitude) && p.body_b.longitude >= 0 && p.body_b.longitude < 360);
    }
  }
});

// --- Ruling F: transit-rate pairs, orb model inheritance --------------------------------------

test('faster_body is echoed and matches the pair with the larger mean rate (Moon faster than Sun)', slow, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Sun', 'Moon'], include_angles: false,
  });
  assert.ok(result.pair_contacts.length > 0);
  assert.ok(result.pair_contacts.every((c) => c.faster_body === 'Moon'));
});

test('Ascendant x Midheaven is eligible via explicit pair_bodies but excluded from the default set', slow, async () => {
  const server = new SwissEphemerisServer();
  const withoutAngles = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
  });
  assert.ok(!withoutAngles.settings_used.pairs_searched.some((p) => p.body_a === 'Ascendant' || p.body_b === 'Ascendant'));

  const explicit = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2020-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Ascendant', 'Midheaven'], include_angles: true,
  });
  assert.equal(explicit.settings_used.pairs_searched.length, 1);
  assert.deepEqual(explicit.settings_used.pairs_searched[0], { body_a: 'Ascendant', body_b: 'Midheaven' });

  const gated = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2020-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Ascendant', 'Midheaven'], include_angles: false,
  });
  assert.deepEqual(gated.settings_used.pairs_searched, []);
});
