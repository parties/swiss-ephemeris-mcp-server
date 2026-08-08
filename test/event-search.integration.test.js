import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { resolveChartPoint, resolveAspectSettings, orbAllowedFor, MAJOR_ASPECTS } from '../lib/aspects.js';
import { jdFromDate, seriesFor, positionAt, eclipsesFor } from '../lib/ephemeris-series.js';
import {
  scanTransitingBody,
  findContact,
  findStations,
  findLunations,
  annotateEclipses,
  natalContactsFor,
} from '../lib/event-search.js';
import { DAY_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const jd = (iso) => jdFromDate(new Date(iso));

function providerFor(body) {
  return {
    seriesFor: (startJd, endJd, stepDays) => seriesFor(body, startJd, endJd, stepDays),
    positionAt: (atJd) => positionAt(body, atJd),
  };
}

// Datetimes are refined to well past the spec's +-1 minute accuracy floor, but a root
// landing within a fraction of a second of a whole-second boundary can legitimately round
// either way - assert agreement to within a couple of seconds rather than exact strings.
function assertCloseIso(actual, expected, toleranceSec = 2) {
  const diff = Math.abs(new Date(actual).getTime() - new Date(expected).getTime()) / 1000;
  assert.ok(diff <= toleranceSec, `expected ${actual} to be within ${toleranceSec}s of ${expected}`);
}

const STATION_BODIES = [
  'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
  'Chiron', 'Ceres', 'Pallas', 'Juno', 'Vesta',
];

let natal;
test('setup: fetch DAY_CHART natal positions once', { skip: !HAS_SWETEST }, () => {
  const server = new SwissEphemerisServer();
  const chart = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude, 'P');
  natal = {
    Sun: resolveChartPoint(chart, 'Sun').longitude,
    Venus: resolveChartPoint(chart, 'Venus').longitude,
    Lilith: resolveChartPoint(chart, 'Lilith').longitude,
    Pallas: resolveChartPoint(chart, 'Pallas').longitude,
  };
  // Pinned against the spec's own verified constants (§4.1/§4.2/§4.4) - if these ever
  // drift, every timestamp below drifts with them, so catch it here first.
  assert.ok(Math.abs(natal.Sun - 280.8142608) < 1e-6);
  assert.ok(Math.abs(natal.Venus - 306.2219606) < 1e-6);
  assert.ok(Math.abs(natal.Lilith - 216.4639894) < 1e-6);
  assert.ok(Math.abs(natal.Pallas - 1.5595393) < 1e-6);
});

const WINDOW_2026_2029 = { startJd: jd('2026-01-01T00:00:00Z'), endJd: jd('2029-01-01T00:00:00Z') };

// Spec §4.1 - the core multi-pass claim: pass count is arithmetic from station
// segmentation, not a step-size heuristic, and is not required to be odd.
test('§4.1 Pluto square natal Lilith: 5 passes, timestamps match the spec exactly', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Pluto');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);
  const contact = findContact({
    provider, segments, stations,
    natalLongitude: natal.Lilith, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 3.5,
    ...WINDOW_2026_2029,
  });

  assert.equal(contact.passes.length, 5);
  assert.equal(contact.passes.length, DAY_CHART.expected.plutoSquareLilithPasses);

  const expected = [
    ['2027-03-12T21:56:55Z', false],
    ['2027-07-06T22:59:00Z', true],
    ['2028-01-17T11:40:56Z', false],
    ['2028-10-03T10:44:26Z', true],
    ['2028-11-03T16:49:02Z', false],
  ];
  contact.passes.forEach((pass, i) => {
    assertCloseIso(pass.datetime, expected[i][0]);
    assert.equal(pass.retrograde, expected[i][1]);
  });
});

test('§4.1 Pluto conjunct natal Venus: 3 passes', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Pluto');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);
  const contact = findContact({
    provider, segments, stations,
    natalLongitude: natal.Venus, aspectAngle: MAJOR_ASPECTS.conjunction, orbAllowed: 6,
    ...WINDOW_2026_2029,
  });

  assert.equal(contact.passes.length, 3);
  assert.equal(contact.passes.length, DAY_CHART.expected.plutoConjunctVenusPasses);

  const expected = ['2027-03-03T08:49:49Z', '2027-07-17T22:09:25Z', '2028-01-09T15:22:28Z'];
  contact.passes.forEach((pass, i) => assertCloseIso(pass.datetime, expected[i]));
});

// The trap the spec calls out explicitly: this is a 5-pass contact truncated by the
// window, so 4 (an even count) is correct, and leaves_orb_truncated must say so.
// "Direct/retrograde/direct, therefore odd" is wrong at any window boundary.
test('§4.1 Neptune sextile natal Venus: 4 passes (window-truncated 5th), not required to be odd', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Neptune');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);
  const contact = findContact({
    provider, segments, stations,
    natalLongitude: natal.Venus, aspectAngle: MAJOR_ASPECTS.sextile, orbAllowed: 6,
    ...WINDOW_2026_2029,
  });

  assert.equal(contact.passes.length, 4);
  assert.equal(contact.leaves_orb_truncated, true);

  const expected = ['2027-05-30T13:35:34Z', '2027-08-20T10:31:16Z', '2028-03-23T18:26:23Z', '2028-11-25T10:59:56Z'];
  contact.passes.forEach((pass, i) => assertCloseIso(pass.datetime, expected[i]));
});

// Spec Q1 - "require a test asserting agreement with brute-force bisection to 1s". This
// bisects independently of lib/event-search.js (a dumb loop over positionAt, not the
// segmented enumeration under test) to catch a bug the same algorithm reused as its own
// check would not.
test('refinement agrees with an independent brute-force bisection to within 1 second', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Pluto');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);
  const contact = findContact({
    provider, segments, stations,
    natalLongitude: natal.Lilith, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 3.5,
    ...WINDOW_2026_2029,
  });
  const firstPass = contact.passes[0];

  const target = natal.Lilith + MAJOR_ASPECTS.square;
  function wrap180(deg) {
    const d = ((deg % 360) + 360) % 360;
    return d > 180 ? d - 360 : d;
  }

  let lo = firstPass.jd - 5;
  let hi = firstPass.jd + 5;
  let gLo = wrap180(positionAt('Pluto', lo).longitude - target);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const gMid = wrap180(positionAt('Pluto', mid).longitude - target);
    if (Math.sign(gMid) === Math.sign(gLo)) { lo = mid; gLo = gMid; } else { hi = mid; }
  }
  const bruteForceJd = (lo + hi) / 2;

  assert.ok(Math.abs(bruteForceJd - firstPass.jd) * 86400 < 1, 'expected agreement to within 1 second');
});

// Spec §4.2 - the Q4 regression test. A retrograding outer planet inside orb does NOT
// imply three passes: it can station short of the degree and never perfect on that
// approach. Verified independently against the vendored ephemeris (see PR description) -
// the exact pass is 2026-03-14T22:57Z, not the spec table's approximate "(2026-02)"
// annotation; every digit-precise assertion below (the station's timestamp/longitude/gap)
// matches the spec exactly.
test('§4.2 Neptune conjunct natal Pallas: station within orb that never perfects', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Neptune');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);
  const contact = findContact({
    provider, segments, stations,
    natalLongitude: natal.Pallas, aspectAngle: MAJOR_ASPECTS.conjunction, orbAllowed: 3.5,
    ...WINDOW_2026_2029,
  });

  // Exactly 1 exact pass, not 3 - the case that fails if an implementation assumes
  // "outer planet + retrograde + inside orb" always yields three crossings.
  assert.equal(contact.passes.length, 1);
  assert.equal(contact.passes[0].retrograde, false);

  const directStation = stations.find((s) => s.direction === 'direct'
    && Math.abs(s.jd - jd('2026-12-12T22:17:19Z')) < 1);
  assert.ok(directStation, 'expected the 2026-12-12 direct station to be found');
  assert.ok(Math.abs(directStation.longitude - 1.6129272) < 1e-6);
  assertCloseIso(new Date((directStation.jd - 2440587.5) * 86400000).toISOString(), DAY_CHART.expected.neptuneStationDirect2026);

  const gap = Math.abs(directStation.longitude - natal.Pallas);
  assert.ok(Math.abs(gap - 0.0533879) < 1e-6);

  const settings = resolveAspectSettings({ orbModel: 'moiety' });
  const targets = [{ name: 'Pallas', longitude: natal.Pallas }];
  const contacts = natalContactsFor(directStation.longitude, targets, MAJOR_ASPECTS, (targetName, aspectName) =>
    orbAllowedFor(settings, 'Neptune', targetName, aspectName));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].natal_point, 'Pallas');
  assert.equal(contacts[0].aspect, 'conjunction');
  assert.ok(Math.abs(contacts[0].orb - 0.0533879) < 1e-6);

  // closest_approach is computed from {exact passes} ∪ {stations in period} ∪ {window
  // boundaries} (spec Q4) - with a real exact pass in the period (orb 0), it always wins
  // over a station that only gets to within 0.053deg, regardless of which one reads as
  // astrologically "stronger".
  assert.equal(contact.closest_approach.orb, 0);
  assert.equal(contact.closest_approach.stationary, false);
});

// Spec Q4/§4.2 - "passes may legitimately be empty": a station-in-orb approach that
// never reaches an exact pass. Saturn's Dec-2026 direct station (7.9310379, spec §4.5)
// turns around before reaching a target just past it, so this contact has zero exact
// passes and closest_approach must be the station itself.
test('passes[] may be empty: a station-in-orb approach with no exact pass', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Saturn');
  const start = jd('2026-06-01T00:00:00Z');
  const end = jd('2027-06-01T00:00:00Z');
  const { segments, stations } = scanTransitingBody(provider, start, end, 1);

  const target = 7.9310379 - 0.3; // just past the direct station's turning longitude
  const contact = findContact({
    provider, segments, stations,
    natalLongitude: target, aspectAngle: 0, orbAllowed: 0.5,
    startJd: start, endJd: end,
  });

  assert.ok(contact);
  assert.deepEqual(contact.passes, []);
  assert.equal(contact.closest_approach.stationary, true);
  assert.ok(contact.closest_approach.orb > 0);
});

// Spec §4.4 - orb model changes the envelope, not the passes. Assert the identical-passes
// part explicitly: it's what makes the days-apart difference legible rather than an
// artifact of a different search.
test('§4.4 Saturn square natal Sun: moiety (12°, 734.3d) vs class (8°, 402.8d), identical passes', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Saturn');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);

  const moiety = findContact({
    provider, segments, stations,
    natalLongitude: natal.Sun, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 12,
    ...WINDOW_2026_2029,
  });
  const classModel = findContact({
    provider, segments, stations,
    natalLongitude: natal.Sun, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 8,
    ...WINDOW_2026_2029,
  });

  assertCloseIso(moiety.enters_orb, '2026-02-02T17:55:52Z');
  assertCloseIso(moiety.leaves_orb, '2028-02-07T00:32:27Z');
  assertCloseIso(classModel.enters_orb, '2026-03-10T00:14:51Z');
  assertCloseIso(classModel.leaves_orb, '2027-04-16T19:44:33Z');

  const moietyDays = (new Date(moiety.leaves_orb) - new Date(moiety.enters_orb)) / 86400000;
  const classDays = (new Date(classModel.leaves_orb) - new Date(classModel.enters_orb)) / 86400000;
  assert.ok(Math.abs(moietyDays - 734.3) < 0.5);
  assert.ok(Math.abs(classDays - 402.8) < 0.5);

  assert.equal(moiety.passes.length, 3);
  assert.equal(classModel.passes.length, 3);
  moiety.passes.forEach((pass, i) => assertCloseIso(pass.datetime, classModel.passes[i].datetime));
});

// Reverse direction so the envelope test can't pass by assuming moiety is always wider
// (Pluto-Venus: moiety 6° is narrower than class 8°).
test('§4.4 orb model direction reverses for a different pair (Pluto-Venus: moiety 6° < class 8°)', { skip: !HAS_SWETEST }, () => {
  const moietySettings = resolveAspectSettings({ orbModel: 'moiety' });
  const classSettings = resolveAspectSettings({ orbModel: 'class' });
  assert.equal(orbAllowedFor(moietySettings, 'Pluto', 'Venus', 'conjunction'), 6);
  assert.equal(orbAllowedFor(classSettings, 'Pluto', 'Venus', 'conjunction'), 8);
});

// Spec §4.5 - stations to the second, plus the negative assertions that catch a
// regressed true-Node exclusion (352 jitter reversals/year vs ~25 real stations/year).
test('§4.5 Neptune/Saturn stations over 730 days match the spec exactly', { skip: !HAS_SWETEST }, () => {
  const start = jd('2026-01-01T00:00:00Z');
  const end = jd('2028-01-01T00:00:00Z'); // 2026-01-01 + 730 days
  const neptuneStations = findStations(providerFor('Neptune'), start, end, 1);
  const saturnStations = findStations(providerFor('Saturn'), start, end, 1);

  const expectFound = (stations, direction, datetime, longitude) => {
    const found = stations.find((s) => s.direction === direction && Math.abs(new Date(s.datetime) - new Date(datetime)) < 2000);
    assert.ok(found, `expected a ${direction} station near ${datetime}`);
    assert.ok(Math.abs(found.longitude - longitude) < 1e-6);
  };

  expectFound(neptuneStations, 'retrograde', '2026-07-07T10:54:29Z', 4.4180692);
  expectFound(neptuneStations, 'direct', '2026-12-12T22:17:19Z', 1.6129272);
  expectFound(saturnStations, 'retrograde', '2026-07-26T19:56:27Z', 14.7499589);
  expectFound(saturnStations, 'direct', '2026-12-10T23:31:04Z', 7.9310379);
});

test('§4.5 negative: Sun, Moon and Lilith never station', { skip: !HAS_SWETEST }, () => {
  const start = jd('2026-01-01T00:00:00Z');
  const end = jd('2028-01-01T00:00:00Z');
  for (const body of ['Sun', 'Moon', 'Lilith']) {
    assert.deepEqual(findStations(providerFor(body), start, end, 1), [], `expected no stations for ${body}`);
  }
});

// A count in the hundreds means the true-Node exclusion (via body-list scoping, since the
// engine has no node-specific special case) has regressed - real stations across all 13
// station bodies run about 25/year, so ~50 over this 2-year window.
test('§4.5 ~25 stations per year across all 13 station bodies (regression guard, not the Node)', { skip: !HAS_SWETEST }, () => {
  const start = jd('2026-01-01T00:00:00Z');
  const end = jd('2028-01-01T00:00:00Z');
  const total = STATION_BODIES.reduce((sum, body) => sum + findStations(providerFor(body), start, end, 1).length, 0);
  assert.ok(total >= 30 && total <= 70, `expected ~50 stations over 2 years across 13 bodies, got ${total}`);
});

// Spec §4.7 - lunations at engine level.
test('§4.7 first Full Moon and New Moon of 2026, ~25 lunations/year by default', { skip: !HAS_SWETEST }, () => {
  const startJd = jd('2026-01-01T00:00:00Z');
  const endJd = jd('2027-01-01T00:00:00Z');
  const lunations = findLunations({ sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd });

  assert.ok(lunations.length >= 24 && lunations.length <= 26, `expected ~25 lunations, got ${lunations.length}`);
  assert.ok(!lunations.some((l) => l.phase === 'first_quarter' || l.phase === 'last_quarter'));

  const firstFull = lunations.find((l) => l.phase === 'full');
  assertCloseIso(firstFull.datetime, '2026-01-03T10:02:55Z');
  assert.ok(Math.abs(firstFull.longitude - 103.032890) < 1e-4);

  const firstNew = lunations.find((l) => l.phase === 'new');
  assertCloseIso(firstNew.datetime, '2026-01-18T19:51:59Z');
  assert.ok(Math.abs(firstNew.longitude - 298.732110) < 1e-4);
});

test('§4.7 quarters are absent by default, present opt-in, matching the spec timestamps', { skip: !HAS_SWETEST }, () => {
  const startJd = jd('2026-01-01T00:00:00Z');
  const endJd = jd('2027-01-01T00:00:00Z');
  const withQuarters = findLunations({
    sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd, includeQuarterMoons: true,
  });

  const firstQuarter = withQuarters.find((l) => l.phase === 'first_quarter');
  const lastQuarter = withQuarters.find((l) => l.phase === 'last_quarter');
  assert.ok(firstQuarter);
  assert.ok(lastQuarter);
  assertCloseIso(firstQuarter.datetime, '2026-01-26T04:47:24Z');
  assertCloseIso(lastQuarter.datetime, '2026-01-10T15:48:24Z');
});

// Spec §1.6/Q7 - the eclipse maximum and the exact syzygy are different instants (up to
// ~10 min), and the sign of the difference is opposite between the solar and lunar case.
// `eclipse` is absent (not null) on every non-eclipse lunation, and a penumbral lunar
// eclipse is still emitted rather than filtered for being too faint to matter visually.
test('§4.7 eclipse annotation carries both timestamps, absent (not null) elsewhere', { skip: !HAS_SWETEST }, () => {
  const startJd = jd('2026-01-01T00:00:00Z');
  const endJd = jd('2027-01-01T00:00:00Z');
  const lunations = findLunations({ sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd });
  const solarEclipses = eclipsesFor('solar', startJd, endJd);
  const lunarEclipses = eclipsesFor('lunar', startJd, endJd);
  const annotated = annotateEclipses(lunations, { solarEclipses, lunarEclipses });

  const solar = annotated.find((l) => l.phase === 'new' && l.eclipse?.eclipse_type === 'annular solar');
  assert.ok(solar);
  assertCloseIso(solar.datetime, '2026-02-17T12:01:09Z');
  assertCloseIso(solar.eclipse.maximum_datetime, '2026-02-17T12:11:53Z');
  assert.notEqual(solar.datetime, solar.eclipse.maximum_datetime);
  const solarDiffMin = (new Date(solar.eclipse.maximum_datetime) - new Date(solar.datetime)) / 60000;
  assert.ok(solarDiffMin > 0, 'solar syzygy must be BEFORE the eclipse maximum');
  assert.ok(Math.abs(solarDiffMin - 10.73) < 0.5);

  const lunar = annotated.find((l) => l.phase === 'full' && l.eclipse?.eclipse_type === 'total lunar eclipse');
  assert.ok(lunar);
  assertCloseIso(lunar.datetime, '2026-03-03T11:37:54Z');
  assertCloseIso(lunar.eclipse.maximum_datetime, '2026-03-03T11:33:41Z');
  const lunarDiffMin = (new Date(lunar.datetime) - new Date(lunar.eclipse.maximum_datetime)) / 60000;
  assert.ok(lunarDiffMin > 0, 'lunar syzygy must be AFTER the eclipse maximum');
  assert.ok(Math.abs(lunarDiffMin - 4.21) < 0.5);

  // non-eclipse lunations never carry the key at all
  const plainLunation = annotated.find((l) => !l.eclipse);
  assert.ok(plainLunation);
  assert.equal('eclipse' in plainLunation, false);
});

test('§4.7 penumbral lunar eclipse is annotated, not filtered', { skip: !HAS_SWETEST }, () => {
  const startJd = jd('2027-01-01T00:00:00Z');
  const endJd = jd('2028-01-01T00:00:00Z');
  const lunations = findLunations({ sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd });
  const lunarEclipses = eclipsesFor('lunar', startJd, endJd);
  const annotated = annotateEclipses(lunations, { lunarEclipses });

  const penumbral = annotated.find((l) => l.eclipse?.eclipse_type?.includes('penumb') && Math.abs(l.eclipse.magnitudes[1] - 0.0018) < 1e-4);
  assert.ok(penumbral, 'expected the faint 2027-07-18 penumbral lunar eclipse to be emitted');
  assert.deepEqual(penumbral.eclipse.magnitudes, [0, 0.0018]);
});
