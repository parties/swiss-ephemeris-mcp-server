import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { jdFromDate, dateFromJd } from '../lib/ephemeris-series.js';
import { progressedBodyProvider, progressedMcProvider, ephemerisJdForTarget } from '../lib/progressed-provider.js';
import { TROPICAL_YEAR_DAYS, computeFictitiousLongitude } from '../lib/progressions.js';
import { resolveChartPoint } from '../lib/aspects.js';
import { DAY_CHART, PARTNER_CHART, SOUTHERN_CHART, POLAR_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const Y = TROPICAL_YEAR_DAYS;

function assertCloseIso(actual, expected, toleranceSec = 2) {
  const diff = Math.abs(new Date(actual).getTime() - new Date(expected).getTime()) / 1000;
  assert.ok(diff <= toleranceSec, `expected ${actual} to be within ${toleranceSec}s of ${expected}`);
}

// Chosen so calculate_secondary_progressions' whole-second truncation of progressed_datetime
// (formatProgressedDatetime rounds progressed_datetime to the nearest second before it's fed
// back into calculateEphemeris) is a no-op: every fixture's birth_datetime already sits on a
// whole second, and elapsedYears * Y days (added as milliseconds) stays an exact integer
// whenever elapsedYears is an integer, so progressedDate = birth + elapsedYears days lands
// back on that same whole second with zero rounding error. This is what makes a direct
// float-precision (1e-6 deg) comparison between find_events' engine and
// calculate_secondary_progressions meaningful instead of comparing apples to
// truncated-apples - see test/secondary-progressions.integration.test.js's own targetDateFor
// for the same trick used the other direction (reproducing a known progressed_datetime).
function targetDateForIntegerYears(birthDatetime, elapsedYears) {
  if (!Number.isInteger(elapsedYears)) throw new Error('targetDateForIntegerYears requires an integer elapsedYears');
  const birthMs = new Date(birthDatetime).getTime();
  return new Date(birthMs + elapsedYears * Y * 86400000).toISOString();
}

function wrap180(deg) {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

// Mirrors findEvents' own progressedFrameAt construction (index.js) - the progressed
// Ascendant needs an actual swetest -house lookup (obliquity + ARMC + the
// fictitious-longitude trick), so unlike the pure body/MC providers there's no lib/ export
// to call directly. Duplicated here (not exported from index.js) rather than reaching into
// the class's private closures - this is the same computation calculate_secondary_progressions
// itself does, and the test is exactly what should hold both implementations to it.
function progressedAscendantLongitude(server, chart, targetDate, angleMethod, houseSystem = 'P') {
  const birthJd = jdFromDate(new Date(chart.datetime));
  const targetJd = jdFromDate(new Date(targetDate));
  const natalChart = server.calculateEphemeris(chart.datetime, chart.latitude, chart.longitude, houseSystem);
  const sunProvider = progressedBodyProvider('Sun', { birthJd, yearLengthDays: Y });
  const mcProvider = progressedMcProvider({
    angleMethod,
    natalMcLongitude: natalChart.chart_points.Midheaven.longitude,
    natalSunLongitude: natalChart.planets.Sun.longitude,
    birthJd, yearLengthDays: Y, sunProvider,
  });
  const mcLongitude = mcProvider.positionAt(targetJd).longitude;
  const ephJd = ephemerisJdForTarget(targetJd, birthJd, Y);
  const progressedDatetimeIso = dateFromJd(ephJd).toISOString();
  const progressedRaw = server.calculateEphemeris(progressedDatetimeIso, chart.latitude, chart.longitude, houseSystem);
  const fictitiousLongitude = computeFictitiousLongitude({
    progressedMcLongitude: mcLongitude,
    obliquityDeg: progressedRaw.obliquity,
    baseArmc: progressedRaw.chart_points.ARMC.longitude,
    natalLongitude: chart.longitude,
  });
  const progressedFrame = server.calculateEphemeris(progressedDatetimeIso, chart.latitude, fictitiousLongitude, houseSystem);
  return progressedFrame.chart_points.Ascendant.longitude;
}

const PROGRESSED_BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

// --- §6.1 Cross-tool identity - the headline test ---------------------------------------

test('§6.1 progressed body positions match calculate_secondary_progressions to 1e-6deg (DAY_CHART, 3 dates x 2 angle_methods)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const birthJd = jdFromDate(new Date(DAY_CHART.datetime));

  for (const elapsedYears of [10, 32, 60]) {
    for (const angleMethod of ['solar_arc', 'naibod']) {
      const targetDate = targetDateForIntegerYears(DAY_CHART.datetime, elapsedYears);
      const targetJd = jdFromDate(new Date(targetDate));

      const secProg = await server.handleToolCall('calculate_secondary_progressions', {
        birth_datetime: DAY_CHART.datetime, birth_latitude: DAY_CHART.latitude, birth_longitude: DAY_CHART.longitude,
        target_date: targetDate, angle_method: angleMethod,
      });

      for (const body of PROGRESSED_BODIES) {
        const provider = progressedBodyProvider(body, { birthJd, yearLengthDays: Y });
        const got = provider.positionAt(targetJd).longitude;
        const expected = secProg.progressed_planets[body].longitude;
        assert.ok(Math.abs(wrap180(got - expected)) < 1e-6, `${body} at ${elapsedYears}yr/${angleMethod}: ${got} vs ${expected}`);
      }

      const natalChart = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude, 'P');
      const sunProvider = progressedBodyProvider('Sun', { birthJd, yearLengthDays: Y });
      const mcProvider = progressedMcProvider({
        angleMethod,
        natalMcLongitude: natalChart.chart_points.Midheaven.longitude,
        natalSunLongitude: natalChart.planets.Sun.longitude,
        birthJd, yearLengthDays: Y, sunProvider,
      });
      const gotMc = mcProvider.positionAt(targetJd).longitude;
      const expectedMc = secProg.progressed_angles.Midheaven.longitude;
      assert.ok(Math.abs(wrap180(gotMc - expectedMc)) < 1e-6, `Midheaven at ${elapsedYears}yr/${angleMethod}: ${gotMc} vs ${expectedMc}`);

      const gotAsc = progressedAscendantLongitude(server, DAY_CHART, targetDate, angleMethod);
      const expectedAsc = secProg.progressed_angles.Ascendant.longitude;
      assert.ok(Math.abs(wrap180(gotAsc - expectedAsc)) < 1e-6, `Ascendant at ${elapsedYears}yr/${angleMethod}: ${gotAsc} vs ${expectedAsc}`);
    }
  }
});

test('§6.1/§6.6 PARTNER_CHART: progressed MC/Ascendant match calculate_secondary_progressions (nonzero natal longitude, the computeFictitiousLongitude + natalLongitude path)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const targetDate = targetDateForIntegerYears(PARTNER_CHART.datetime, 20);

  const secProg = await server.handleToolCall('calculate_secondary_progressions', {
    birth_datetime: PARTNER_CHART.datetime, birth_latitude: PARTNER_CHART.latitude, birth_longitude: PARTNER_CHART.longitude,
    target_date: targetDate,
  });

  const gotAsc = progressedAscendantLongitude(server, PARTNER_CHART, targetDate, 'solar_arc');
  assert.ok(Math.abs(wrap180(gotAsc - secProg.progressed_angles.Ascendant.longitude)) < 1e-6);
});

test('§6.1/§6.6 SOUTHERN_CHART: progressed Sun/Moon match calculate_secondary_progressions at a southern latitude', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const birthJd = jdFromDate(new Date(SOUTHERN_CHART.datetime));
  const targetDate = targetDateForIntegerYears(SOUTHERN_CHART.datetime, 15);
  const targetJd = jdFromDate(new Date(targetDate));

  const secProg = await server.handleToolCall('calculate_secondary_progressions', {
    birth_datetime: SOUTHERN_CHART.datetime, birth_latitude: SOUTHERN_CHART.latitude, birth_longitude: SOUTHERN_CHART.longitude,
    target_date: targetDate,
  });

  for (const body of ['Sun', 'Moon']) {
    const provider = progressedBodyProvider(body, { birthJd, yearLengthDays: Y });
    const got = provider.positionAt(targetJd).longitude;
    assert.ok(Math.abs(wrap180(got - secProg.progressed_planets[body].longitude)) < 1e-6);
  }
});

// SUP-359 review follow-up: the progressed Ascendant's adaptive coarse-step subdivision
// (index.js adaptiveJdGrid, unit-tested directly against synthetic curves in
// test/adaptive-jd-grid.test.js) exists because its rate is unbounded near the poles - no
// fixture before POLAR_CHART got anywhere close (the previous highest, DAY_CHART/
// NIGHT_CHART, is 51.4769deg). This is the same §6.1 cross-tool-identity check as the other
// fixtures, run at that latitude: it doesn't exercise adaptiveJdGrid itself (positionAt, not
// a seriesFor scan), but it does prove the progressed-Ascendant formula (computeFictitiousLongitude
// + the swetest -house lookup) that seriesFor's grid points are sampling stays correct there.
test('§6.1/SUP-359 review POLAR_CHART: progressed Ascendant matches calculate_secondary_progressions at a latitude where its rate is unbounded', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();

  const cases = [
    [10, POLAR_CHART.expected.progressions.ascendant10yr],
    [32, POLAR_CHART.expected.progressions.ascendant32yr],
    [60, POLAR_CHART.expected.progressions.ascendant60yr],
  ];

  for (const [elapsedYears, expectedBaked] of cases) {
    const targetDate = targetDateForIntegerYears(POLAR_CHART.datetime, elapsedYears);

    const secProg = await server.handleToolCall('calculate_secondary_progressions', {
      birth_datetime: POLAR_CHART.datetime, birth_latitude: POLAR_CHART.latitude, birth_longitude: POLAR_CHART.longitude,
      target_date: targetDate,
    });

    const gotAsc = progressedAscendantLongitude(server, POLAR_CHART, targetDate, 'solar_arc');
    assert.ok(Math.abs(wrap180(gotAsc - secProg.progressed_angles.Ascendant.longitude)) < 1e-6,
      `${elapsedYears}yr: ${gotAsc} vs calculate_secondary_progressions' ${secProg.progressed_angles.Ascendant.longitude}`);
    assert.ok(Math.abs(wrap180(gotAsc - expectedBaked)) < 1e-6,
      `${elapsedYears}yr: ${gotAsc} vs baked fixture expectation ${expectedBaked}`);
  }
});

// --- §6.2 Progressed stations -------------------------------------------------------------

test('§6.2 DAY_CHART progressed stations 1990-2080: Mercury/Venus/Jupiter match the spec to ~1s and station search is independent of the default `bodies` list', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['station'],
  });

  // Progressed default bodies are Sun/Moon/Mercury/Venus/Mars (none of which include
  // Jupiter or Pluto) - finding their stations anyway is the point of ruling #4/§8: station
  // search covers the full 13-body STATION_CAPABLE_BODIES set regardless of `bodies`.
  const byBody = (name, direction) => result.events.find((e) => e.body === name && e.direction === direction);

  const mercury = byBody('Mercury', 'direct');
  assert.ok(mercury);
  assertCloseIso(mercury.datetime, '2008-09-09T08:08:53Z', 2);
  assert.ok(Math.abs(mercury.longitude - 279.6972) < 1e-3);

  const venus = byBody('Venus', 'direct');
  assert.ok(venus);
  assertCloseIso(venus.datetime, '2027-11-21T04:40:35Z', 2);
  assert.ok(Math.abs(venus.longitude - 290.9210) < 1e-3);

  const jupiter = byBody('Jupiter', 'direct');
  assert.ok(jupiter);
  assertCloseIso(jupiter.datetime, '2044-04-20T18:24:52Z', 2);
  assert.ok(Math.abs(jupiter.longitude - 90.8081) < 1e-3);

  // Pluto's station longitude matches the spec closely (its progressed motion crosses a
  // near-zero-derivative point there - real, not jitter, and outer planets genuinely
  // stationing by progression is ruling #4's whole point), but the exact TARGET-TIME
  // instant is amplified by year_length_days (~365x) from whatever residual imprecision
  // exists in resolving the EPHEMERIS-time root of an extremely flat speed curve (Pluto's
  // total progressed arc here is a few thousandths of a degree per year) - independently
  // re-derived against vendored swetest at sub-second ephemeris resolution during this
  // ticket's implementation, this lands within roughly an hour of the spec's quoted
  // timestamp, not the same ±1s window Mercury/Venus/Jupiter hit. Longitude and age are
  // the load-bearing assertions for this one, not the timestamp to the second.
  const pluto = byBody('Pluto', 'retrograde');
  assert.ok(pluto);
  assert.ok(Math.abs(pluto.longitude - 227.7875) < 1e-3);
  const plutoAgeYears = (new Date(pluto.datetime) - new Date(DAY_CHART.datetime)) / (Y * 86400000);
  assert.ok(Math.abs(plutoAgeYears - 48.771) < 0.01, `expected Pluto station age ~48.771yr, got ${plutoAgeYears}`);

  // Independently re-verified against vendored swetest (raw daily Ceres/Juno/Chiron speed
  // over the same real ~90-day ephemeris span this 90-year progressed window maps to): all
  // three DO have a genuine speed sign change there, so this is a verified departure from
  // the spec's "exactly four stations" claim, not a bug - see CONTRIBUTING/CLAUDE.md's
  // "verify spec departures independently" precedent (SUP-350/SUP-274). Asserted present
  // rather than silently excluded.
  assert.ok(byBody('Ceres', 'direct'), 'expected a genuine Ceres station in this window (verified against raw swetest)');
  assert.ok(byBody('Juno', 'retrograde'), 'expected a genuine Juno station in this window (verified against raw swetest)');
  assert.ok(byBody('Chiron', 'direct'), 'expected a genuine Chiron station in this window (verified against raw swetest)');
});

// --- §6.3 Rates and cycle lengths ----------------------------------------------------------

test('§6.3 DAY_CHART 90yr: Moon sign ingresses = 39, Sun sign ingresses = 3, no re-ingress (Moon never retrogrades)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Sun', 'Moon'], event_types: ['sign_ingress'],
  });

  const moonIngresses = result.events.filter((e) => e.body === 'Moon');
  assert.equal(moonIngresses.length, 39);
  assert.ok(moonIngresses.every((e) => e.direction === 'direct'));

  const sunIngresses = result.events.filter((e) => e.body === 'Sun');
  assert.equal(sunIngresses.length, 3);
});

test('§6.3 DAY_CHART 90yr: progressed lunation cycle is ~29.3yr, and no lunation ever carries an eclipse key', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['lunation'], include_quarter_moons: true,
  });

  const news = result.events.filter((e) => e.phase === 'new');
  assert.ok(news.length >= 2, 'expected at least two progressed New Moons over 90 years');
  const cycleYears = (new Date(news[1].datetime) - new Date(news[0].datetime)) / (Y * 86400000);
  assert.ok(Math.abs(cycleYears - 29.31) < 1, `expected a ~29.31yr progressed lunation cycle, got ${cycleYears}`);

  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((e) => !('eclipse' in e)), 'no progressed lunation may carry an eclipse key');
});

// --- SUP-360 §7: eight-phase progressed lunation cycle ----------------------------------------

// Complete, verified 24-row expected-event table from the SUP-360 plan (§7), measured
// through the shipped engine, docs/SUP-360-eight-phase-lunation-spec.md. `longitude` is
// the progressed Moon's absolute ecliptic longitude at each phase crossing.
const EXPECTED_EIGHT_PHASE_TABLE = [
  { phase: 'first_quarter', datetime: '1992-12-12T00:26:00Z', longitude: 13.8160 },
  { phase: 'gibbous', datetime: '1996-04-29T03:52:26Z', longitude: 62.2594 },
  { phase: 'full', datetime: '1999-09-16T14:07:28Z', longitude: 110.7054 },
  { phase: 'disseminating', datetime: '2003-05-12T14:08:09Z', longitude: 159.4250 },
  { phase: 'last_quarter', datetime: '2007-05-22T23:06:56Z', longitude: 208.5266 },
  { phase: 'balsamic', datetime: '2011-06-28T10:31:00Z', longitude: 257.6996 },
  { phase: 'new', datetime: '2015-04-23T03:58:13Z', longitude: 306.5840 },
  { phase: 'crescent', datetime: '2018-11-06T19:44:10Z', longitude: 355.1837 },
  { phase: 'first_quarter', datetime: '2022-04-10T18:47:49Z', longitude: 43.6606 },
  { phase: 'gibbous', datetime: '2025-09-19T01:10:07Z', longitude: 92.1506 },
  { phase: 'full', datetime: '2029-04-21T11:11:47Z', longitude: 140.7832 },
  { phase: 'disseminating', datetime: '2033-03-04T15:23:32Z', longitude: 189.6952 },
  { phase: 'last_quarter', datetime: '2037-04-14T06:34:25Z', longitude: 238.8465 },
  { phase: 'balsamic', datetime: '2041-04-09T18:09:24Z', longitude: 287.8675 },
  { phase: 'new', datetime: '2044-11-14T17:53:55Z', longitude: 336.4924 },
  { phase: 'crescent', datetime: '2048-03-21T07:08:09Z', longitude: 24.8570 },
  { phase: 'first_quarter', datetime: '2051-08-03T14:44:40Z', longitude: 73.2368 },
  { phase: 'gibbous', datetime: '2055-02-26T09:23:09Z', longitude: 121.8085 },
  { phase: 'full', datetime: '2058-12-16T14:43:47Z', longitude: 170.6089 },
  { phase: 'disseminating', datetime: '2062-12-28T14:15:05Z', longitude: 219.6300 },
  { phase: 'last_quarter', datetime: '2067-02-08T07:17:25Z', longitude: 268.7241 },
  { phase: 'balsamic', datetime: '2070-12-06T14:42:04Z', longitude: 317.5236 },
  { phase: 'new', datetime: '2074-04-29T15:07:30Z', longitude: 5.8892 },
  { phase: 'crescent', datetime: '2077-07-18T10:04:08Z', longitude: 54.0745 },
];

test('§7 SUP-360 spec table: DAY_CHART eight_phase 1990-2080 is exactly 24 events, matching the verified table', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['lunation'], lunation_phases: 'eight_phase',
  });

  assert.equal(result.events.length, EXPECTED_EIGHT_PHASE_TABLE.length);
  result.events.forEach((e, i) => {
    const expected = EXPECTED_EIGHT_PHASE_TABLE[i];
    assert.equal(e.phase, expected.phase, `row ${i + 1}: expected phase ${expected.phase}, got ${e.phase}`);
    assertCloseIso(e.datetime, expected.datetime);
    assert.ok(Math.abs(e.longitude - expected.longitude) < 1e-2, `row ${i + 1}: expected longitude ~${expected.longitude}, got ${e.longitude}`);
  });
});

test('§7.1 superset invariant: every progressed "quarters" event appears unchanged in "eight_phase"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['lunation'],
  };
  const quarters = await server.handleToolCall('find_events', { ...window, lunation_phases: 'quarters' });
  const eightPhase = await server.handleToolCall('find_events', { ...window, lunation_phases: 'eight_phase' });

  assert.equal(quarters.events.length, 12);
  assert.equal(eightPhase.events.length, 24);
  for (const q of quarters.events) {
    const match = eightPhase.events.find((e) => e.phase === q.phase && e.datetime === q.datetime);
    assert.ok(match, `expected quarters event ${q.phase}@${q.datetime} to appear unchanged in eight_phase`);
  }
});

test('§7.5 successive eight-phase step intervals span 3.219-4.114yr, not a uniform 3.66yr', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['lunation'], lunation_phases: 'eight_phase',
  });

  const steps = [];
  for (let i = 1; i < result.events.length; i++) {
    steps.push((new Date(result.events[i].datetime) - new Date(result.events[i - 1].datetime)) / (Y * 86400000));
  }
  const min = Math.min(...steps);
  const max = Math.max(...steps);
  assert.ok(min > 3.0 && min < 3.3, `expected min step ~3.219yr, got ${min}`);
  assert.ok(max > 4.0 && max < 4.2, `expected max step ~4.114yr, got ${max}`);
  assert.ok(!steps.every((s) => Math.abs(s - 3.66) < 0.05), 'steps must not be uniformly ~3.66yr');
});

test('§7.6 no progressed lunation carries an eclipse key at any lunation_phases setting', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['lunation'],
  };
  for (const lunation_phases of ['syzygy', 'quarters', 'eight_phase']) {
    const result = await server.handleToolCall('find_events', { ...window, lunation_phases });
    assert.ok(result.events.length > 0);
    assert.ok(result.events.every((e) => !('eclipse' in e)), `lunation_phases: "${lunation_phases}" must never carry an eclipse key`);
  }
});

test('§7.7 progressed eight_phase wire vocabulary is snake_case, never Title Case', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['lunation'], lunation_phases: 'eight_phase',
  });

  const expectedPhases = new Set(['new', 'crescent', 'first_quarter', 'gibbous', 'full', 'disseminating', 'last_quarter', 'balsamic']);
  assert.ok(result.events.length > 0);
  for (const e of result.events) {
    assert.ok(expectedPhases.has(e.phase), `unexpected phase value: ${e.phase}`);
  }
});

// --- §6.4 Orb model regression --------------------------------------------------------------

test('§6.4 progressed Jupiter->natal Sun: absent under the fixed default, a lifetime-spanning envelope under moiety', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Jupiter'], targets: ['Sun'], include_angles: false, event_types: ['aspect'],
  };

  const fixed = await server.handleToolCall('find_events', { ...window, orb_model: 'fixed' });
  assert.deepEqual(fixed.contacts, [], 'progressed Jupiter must not aspect natal Sun at all under the 1deg default');

  const moiety = await server.handleToolCall('find_events', { ...window, orb_model: 'moiety' });
  assert.equal(moiety.contacts.length, 1);
  assert.equal(moiety.contacts[0].orb_allowed, 12);
  assert.equal(moiety.contacts[0].enters_orb_truncated, true);
  assert.equal(moiety.contacts[0].leaves_orb_truncated, true);
});

// SUP-383: 'fixed' takes its own early-return branch in invalidOrbOverrideKeys (flat aspect
// names only, no class/moiety nesting), and until now nothing exercised orb_overrides against
// it at a tool boundary at all - the two tests below close that gap on the surface that has
// shipped 'fixed' the longest. They deliberately reuse §6.4's window: progressed Jupiter has
// no contact to natal Sun under the 1-degree default, so any contact here is the override's.
test('§6.4 orb_model "fixed" honors a flat orb_overrides widening at the find_events boundary', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Jupiter'], targets: ['Sun'], include_angles: false, event_types: ['aspect'],
    orb_model: 'fixed',
  };

  const baseline = await server.handleToolCall('find_events', window);
  assert.deepEqual(baseline.contacts, [], 'sanity: nothing at all survives the unmodified 1-deg fixed table here');

  const widened = await server.handleToolCall('find_events', {
    ...window,
    orb_overrides: { conjunction: 10, opposition: 10, trine: 10, square: 10, sextile: 10 },
  });
  assert.ok(widened.contacts.length > 0, 'a flat orb_overrides widening must reach the fixed table');
  assert.ok(
    widened.contacts.every((c) => c.orb_allowed === 10),
    'a flat override under "fixed" applies one orb to every pair - there is no per-body or per-class resolution to fall back to'
  );
  assert.equal(widened.settings_used.orb_model, 'fixed');
});

test('§6.4 orb_model "fixed" rejects both an unknown flat aspect name and the per-class nested shape', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Jupiter'], targets: ['Sun'], include_angles: false, event_types: ['aspect'],
    orb_model: 'fixed',
  };

  await assert.rejects(
    () => server.handleToolCall('find_events', { ...window, orb_overrides: { notAnAspect: 1 } }),
    /Unknown aspect in orb_overrides: notAnAspect/
  );
  // 'fixed' has no orb class to nest under, so the shape 'class' accepts is an error here
  // rather than a silently-ignored key.
  await assert.rejects(
    () => server.handleToolCall('find_events', { ...window, orb_overrides: { angle: { square: 4 } } }),
    /Unknown aspect in orb_overrides: angle/
  );
});

// --- §6.5 Birth-time sensitivity -------------------------------------------------------------

test('§6.5 DAY_CHART/SOUTHERN_CHART: 4-minute Ascendant/Midheaven shift matches the spec', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  for (const [chart, expectedAsc, expectedMc] of [[DAY_CHART, 2.1577, 0.9257], [SOUTHERN_CHART, 1.2999, 0.9584]]) {
    const natal = server.calculateEphemeris(chart.datetime, chart.latitude, chart.longitude, 'P');
    const shiftedDate = new Date(new Date(chart.datetime).getTime() + 4 * 60000).toISOString();
    const shifted = server.calculateEphemeris(shiftedDate, chart.latitude, chart.longitude, 'P');
    const ascShift = Math.abs(wrap180(shifted.chart_points.Ascendant.longitude - natal.chart_points.Ascendant.longitude));
    const mcShift = Math.abs(wrap180(shifted.chart_points.Midheaven.longitude - natal.chart_points.Midheaven.longitude));
    assert.ok(Math.abs(ascShift - expectedAsc) < expectedAsc * 0.01, `${chart.label} ASC shift ${ascShift} vs ${expectedAsc}`);
    assert.ok(Math.abs(mcShift - expectedMc) < expectedMc * 0.01, `${chart.label} MC shift ${mcShift} vs ${expectedMc}`);
  }
});

// Progressed Midheaven's rate is nearly constant across a lifetime (it moves in lockstep
// with the progressed Sun, ~0.99-1.02deg/yr), so a single reference figure generalizes -
// the spec's own worked 83 days/min holds regardless of which contact produced it. The
// progressed Ascendant's rate does NOT generalize the same way (independently verified:
// ~2.4deg/yr near birth vs ~1.1deg/yr by age 32.5 for DAY_CHART - a >2x swing), so rather
// than pin a single ASC figure this test verifies the FORMULA (shift-per-minute / relative
// rate AT THE CONTACT'S OWN INSTANT, matching the spec's literal wording) by independently
// re-deriving "relative rate at the contact" via calculate_secondary_progressions at that
// exact instant and checking find_events' emitted number against it.
test('§6.5 date_uncertainty_days_per_birth_minute: Midheaven matches the spec\'s ~83 days/min; Ascendant matches an independently re-derived local rate', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2010-01-01T00:00:00Z',
    rate: 'secondary_progression', targets: ['Sun'], include_angles: true, event_types: ['aspect'],
  });

  const mc = result.contacts.find((c) => c.transiting_body === 'Midheaven' && c.natal_point === 'Sun');
  assert.ok(mc);
  assert.ok(mc.date_uncertainty_days_per_birth_minute !== undefined);
  assert.ok(Math.abs(mc.date_uncertainty_days_per_birth_minute - 83) < 83 * 0.05, `MC sensitivity ${mc.date_uncertainty_days_per_birth_minute} not within 5% of 83`);

  const asc = result.contacts.find((c) => c.transiting_body === 'Ascendant' && c.natal_point === 'Sun');
  assert.ok(asc);
  assert.ok(asc.date_uncertainty_days_per_birth_minute !== undefined);

  const contactDate = asc.closest_approach.datetime;
  const dtYears = 0.05;
  const before = await server.handleToolCall('calculate_secondary_progressions', {
    birth_datetime: DAY_CHART.datetime, birth_latitude: DAY_CHART.latitude, birth_longitude: DAY_CHART.longitude,
    target_date: new Date(new Date(contactDate).getTime() - dtYears * Y * 86400000).toISOString(),
  });
  const after = await server.handleToolCall('calculate_secondary_progressions', {
    birth_datetime: DAY_CHART.datetime, birth_latitude: DAY_CHART.latitude, birth_longitude: DAY_CHART.longitude,
    target_date: new Date(new Date(contactDate).getTime() + dtYears * Y * 86400000).toISOString(),
  });
  const localRate = Math.abs(wrap180(after.progressed_angles.Ascendant.longitude - before.progressed_angles.Ascendant.longitude)) / (2 * dtYears * Y);
  const natal = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude, 'P');
  const shifted = server.calculateEphemeris(new Date(new Date(DAY_CHART.datetime).getTime() + 60000).toISOString(), DAY_CHART.latitude, DAY_CHART.longitude, 'P');
  const ascShiftPerMinute = Math.abs(wrap180(shifted.chart_points.Ascendant.longitude - natal.chart_points.Ascendant.longitude));
  const expected = ascShiftPerMinute / localRate;
  assert.ok(Math.abs(asc.date_uncertainty_days_per_birth_minute - expected) < expected * 0.05,
    `ASC sensitivity ${asc.date_uncertainty_days_per_birth_minute} not within 5% of independently re-derived ${expected}`);
});

test('§6.5/§8 retrofit item 5: house_ingress carries birth_time_sensitive:true in BOTH rate modes', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();

  const transit = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['house_ingress'],
  });
  assert.ok(transit.events.length > 0);
  assert.ok(transit.events.every((e) => e.birth_time_sensitive === true));

  const progressed = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2020-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Moon'], event_types: ['house_ingress'], house_frame: 'natal',
  });
  assert.ok(progressed.events.length > 0);
  assert.ok(progressed.events.every((e) => e.birth_time_sensitive === true));
  assert.ok(progressed.events.every((e) => typeof e.date_uncertainty_days_per_birth_minute === 'number'));
});

test('house_frame "progressed": moving-cusp house_ingress runs without crashing and direction/houses are well-formed', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2030-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Moon'], event_types: ['house_ingress'], house_frame: 'progressed',
  });
  assert.ok(result.events.length > 0);
  for (const e of result.events) {
    assert.ok(e.from_house >= 1 && e.from_house <= 12);
    assert.ok(e.to_house >= 1 && e.to_house <= 12);
    assert.ok(['direct', 'retrograde'].includes(e.direction));
    assert.equal(e.birth_time_sensitive, true);
  }
});

// --- §6.6 Structural -------------------------------------------------------------------------

test('§6.6 window_start before birth_datetime errors at rate secondary_progression', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: '1980-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
      rate: 'secondary_progression',
    }),
    /window_start must not precede birth_datetime/
  );
});

test('§6.6 window_start before birth_datetime does NOT error at rate transit (default)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: '1980-01-01T00:00:00Z', window_end: '1981-01-01T00:00:00Z',
    bodies: ['Saturn'], targets: ['Sun'],
  });
  assert.equal(result.settings_used.rate, 'transit');
});

test('§6.6 angle_method/house_frame require rate: "secondary_progression"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
      angle_method: 'naibod',
    }),
    /angle_method and house_frame require rate/
  );
  await assert.rejects(
    () => server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
      rate: 'transit', house_frame: 'natal',
    }),
    /angle_method and house_frame require rate/
  );
});

test('§6.6 an unknown rate is rejected', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
      rate: 'solar_arc',
    }),
    /rate must be one of/
  );
});

// --- Rate-inverted defaults (spec §2) ---------------------------------------------------------

test('rate-inverted defaults: bodies, orb_model, include_angles, lunation_phases, window cap', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2011-01-01T00:00:00Z',
    rate: 'secondary_progression', targets: ['Sun'], event_types: ['aspect'],
  });
  assert.deepEqual(result.settings_used.bodies, ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars']);
  assert.equal(result.settings_used.orb_model, 'fixed');
  assert.equal(result.settings_used.include_angles, true);
  // SUP-360 ruling D: the progressed default is "eight_phase", not "quarters" - the
  // deprecated include_quarter_moons boolean still reads true since eight_phase is a
  // superset of quarters, but lunation_phases is where the actual default now lives.
  assert.equal(result.settings_used.include_quarter_moons, true);
  assert.equal(result.settings_used.lunation_phases, 'eight_phase');
  assert.equal(result.settings_used.angle_method_used, 'solar_arc');
  assert.equal(result.settings_used.house_frame_used, 'progressed');
  assert.equal(result.settings_used.year_length_days, Y);
});

test('progressed window cap is 120 years, not 10', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2200-01-01T00:00:00Z',
    rate: 'secondary_progression', bodies: ['Sun'], targets: ['Moon'], include_angles: false, event_types: ['aspect'],
  });
  assert.equal(result.window.truncated, true);
  const clampedYears = (new Date(result.window.end) - new Date(result.window.start)) / (Y * 86400000);
  assert.ok(Math.abs(clampedYears - 120) < 1, `expected ~120yr cap, got ${clampedYears}`);
});

test('transit window cap is still 10 years (unchanged)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: '2026-01-01T00:00:00Z', window_end: '2040-01-01T00:00:00Z',
    bodies: ['Pluto'], targets: ['Sun'], event_types: ['aspect'],
  });
  assert.equal(result.window.truncated, true);
  const clampedDays = (new Date(result.window.end) - new Date(result.window.start)) / 86400000;
  assert.ok(Math.abs(clampedDays - 3653) < 1);
});
