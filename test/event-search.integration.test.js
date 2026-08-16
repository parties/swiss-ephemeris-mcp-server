import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { resolveChartPoint, resolveAspectSettings, orbAllowedFor, MAJOR_ASPECTS } from '../lib/aspects.js';
import { jdFromDate, seriesFor, positionAt, samplesFrom, eclipsesFor } from '../lib/ephemeris-series.js';
import {
  memoizeProvider,
  scanTransitingBody,
  findContacts,
  findStations,
  findCrossings,
  findLunations,
  annotateEclipses,
  natalContactsFor,
} from '../lib/event-search.js';
import { DAY_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const jd = (iso) => jdFromDate(new Date(iso));

// Deliberately WITHOUT samplesFrom, so every test below drives the scalar seam - the same
// fallback path index.js's progressed Ascendant and moving-cusp providers take. The batched
// seam gets its own equivalence test at the bottom of this file (SUP-390).
function providerFor(body) {
  return {
    seriesFor: (startJd, endJd, stepDays) => seriesFor(body, startJd, endJd, stepDays),
    positionAt: (atJd) => positionAt(body, atJd),
  };
}

function batchedProviderFor(body) {
  return {
    ...providerFor(body),
    samplesFrom: (startJd, stepDays, count) => samplesFrom(body, startJd, stepDays, count),
  };
}

// SUP-387. No swetest needed: the whole contract is "same JD, one call underneath", and a
// counting stub states that more precisely than any timing measurement could.
test('memoizeProvider: samples each JD once, passes distinct JDs through, and never rounds', () => {
  let calls = 0;
  const provider = memoizeProvider({
    positionAt: (atJd) => { calls++; return { longitude: atJd * 2, speed: 1 }; },
    seriesFor: () => [{ jd: 1, longitude: 2, speed: 1 }],
  });

  assert.equal(provider.positionAt(100).longitude, 200);
  assert.equal(provider.positionAt(100).longitude, 200);
  assert.equal(calls, 1, 'the second read of the same JD must not reach the provider');

  provider.positionAt(101);
  assert.equal(calls, 2);

  // Adjacent JDs a rounding cache would collapse: 1e-9 days is ~0.1ms, far below any
  // tolerance in this engine, and they still have to be two distinct samples - collapsing
  // them would silently change an output value rather than just save a spawn.
  provider.positionAt(100 + 1e-9);
  assert.equal(calls, 3);

  // seriesFor is passed through untouched.
  assert.deepEqual(provider.seriesFor(0, 1, 1), [{ jd: 1, longitude: 2, speed: 1 }]);
});

test('memoizeProvider: prime fills the cache for a batched caller, and never overwrites a real sample', () => {
  let calls = 0;
  const provider = memoizeProvider({
    positionAt: (atJd) => { calls++; return { longitude: atJd, speed: 0 }; },
    seriesFor: () => [],
  });

  assert.equal(provider.isPrimed(50), false);
  provider.prime(50, { longitude: 123, speed: 4 });
  assert.equal(provider.isPrimed(50), true);
  assert.deepEqual(provider.positionAt(50), { longitude: 123, speed: 4 });
  assert.equal(calls, 0, 'a primed JD must not spawn anything');

  provider.positionAt(60);
  provider.prime(60, { longitude: 999, speed: 9 });
  assert.equal(provider.positionAt(60).longitude, 60, 'prime must not clobber an already-sampled JD');
  assert.equal(calls, 1);
});

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
  const contacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Lilith, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 3.5,
    ...WINDOW_2026_2029,
  });

  assert.equal(contacts.length, 1);
  const contact = contacts[0];
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
  const contacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Venus, aspectAngle: MAJOR_ASPECTS.conjunction, orbAllowed: 6,
    ...WINDOW_2026_2029,
  });

  assert.equal(contacts.length, 1);
  const contact = contacts[0];
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
  const contacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Venus, aspectAngle: MAJOR_ASPECTS.sextile, orbAllowed: 6,
    ...WINDOW_2026_2029,
  });

  assert.equal(contacts.length, 1);
  const contact = contacts[0];
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
  const contacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Lilith, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 3.5,
    ...WINDOW_2026_2029,
  });
  const firstPass = contacts[0].passes[0];

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
// approach. Verified independently against the vendored ephemeris (2026-08-08) - the
// exact pass is 2026-03-14T22:57:21Z, not the spec table's approximate "(2026-02)"
// annotation (see the corrected §4.2 note in docs/SUP-349-find-events-spec.md).
//
// The window also turns out to hold a SECOND episode: after the March 2026 pass, Neptune
// genuinely leaves 3.5deg orb (gap peaks ~5deg around mid-2027, verified against the
// vendored ephemeris) and comes back for a later approach that never perfects either -
// two real episodes, not one. Every digit-precise assertion below (the station's
// timestamp/longitude/gap, the first episode's single pass) still matches the spec.
test('§4.2 Neptune conjunct natal Pallas: station within orb that never perfects (2 real episodes)', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Neptune');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);
  const pallasContacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Pallas, aspectAngle: MAJOR_ASPECTS.conjunction, orbAllowed: 3.5,
    ...WINDOW_2026_2029,
  });

  assert.equal(pallasContacts.length, 2, 'Neptune genuinely leaves and re-enters 3.5deg orb of Pallas within this window');
  const [contact, secondApproach] = pallasContacts;

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
  const stationNatalContacts = natalContactsFor(directStation.longitude, targets, MAJOR_ASPECTS, (targetName, aspectName) =>
    orbAllowedFor(settings, 'Neptune', targetName, aspectName));
  assert.equal(stationNatalContacts.length, 1);
  assert.equal(stationNatalContacts[0].natal_point, 'Pallas');
  assert.equal(stationNatalContacts[0].aspect, 'conjunction');
  assert.ok(Math.abs(stationNatalContacts[0].orb - 0.0533879) < 1e-6);

  // closest_approach is computed from {exact passes} ∪ {stations in period} ∪ {window
  // boundaries} (spec Q4) - with a real exact pass in the period (orb 0), it always wins
  // over a station that only gets to within 0.053deg, regardless of which one reads as
  // astrologically "stronger".
  assert.equal(contact.closest_approach.orb, 0);
  assert.equal(contact.closest_approach.stationary, false);

  // The second episode is the direct station on the OTHER side of the Dec-2026
  // retrograde-to-direct cycle - it also never perfects.
  assert.deepEqual(secondApproach.passes, []);
  assert.equal(secondApproach.closest_approach.stationary, true);
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
  const contacts = findContacts({
    provider, segments, stations,
    natalLongitude: target, aspectAngle: 0, orbAllowed: 0.5,
    startJd: start, endJd: end,
  });

  assert.equal(contacts.length, 1);
  const contact = contacts[0];
  assert.deepEqual(contact.passes, []);
  assert.equal(contact.closest_approach.stationary, true);
  assert.ok(contact.closest_approach.orb > 0);
});

// Spec §4.4 - orb model changes the envelope, not the passes. Verified independently
// against the vendored ephemeris (2026-08-08): under the wider moiety orb (12deg) Saturn
// genuinely leaves orb after the first episode (gap peaks ~17deg around 2027-08) and comes
// back for a second, later approach that gets to within 10.2deg but never perfects - two
// real episodes, not the single 734.3-day envelope the original spec table claimed. That
// figure was itself an artifact of the pre-fix first-crossing/last-crossing bug, which
// silently bridged these same two episodes into one. The narrower class orb (8deg) never
// reaches the second approach, so it stays a single 402.8-day episode exactly as before.
// Assert the identical-passes part explicitly for the shared first episode - it's what
// makes the days-apart difference legible rather than an artifact of a different search.
test('§4.4 Saturn square natal Sun: moiety (12°) is 2 episodes, class (8°) is 1, identical first-episode passes', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Saturn');
  const { segments, stations } = scanTransitingBody(provider, WINDOW_2026_2029.startJd, WINDOW_2026_2029.endJd, 1);

  const moietyContacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Sun, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 12,
    ...WINDOW_2026_2029,
  });
  const classContacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Sun, aspectAngle: MAJOR_ASPECTS.square, orbAllowed: 8,
    ...WINDOW_2026_2029,
  });

  assert.equal(moietyContacts.length, 2, 'moiety orb genuinely re-enters and exits a second time');
  assert.equal(classContacts.length, 1);
  const [moietyFirst, moietySecond] = moietyContacts;
  const classModel = classContacts[0];

  assertCloseIso(moietyFirst.enters_orb, '2026-02-02T17:55:52Z');
  assertCloseIso(moietyFirst.leaves_orb, '2027-05-20T07:39:16Z');
  assertCloseIso(classModel.enters_orb, '2026-03-10T00:14:51Z');
  assertCloseIso(classModel.leaves_orb, '2027-04-16T19:44:33Z');

  const moietyFirstDays = (new Date(moietyFirst.leaves_orb) - new Date(moietyFirst.enters_orb)) / 86400000;
  const classDays = (new Date(classModel.leaves_orb) - new Date(classModel.enters_orb)) / 86400000;
  assert.ok(Math.abs(moietyFirstDays - 471.6) < 0.5);
  assert.ok(Math.abs(classDays - 402.8) < 0.5);

  assert.equal(moietyFirst.passes.length, 3);
  assert.equal(classModel.passes.length, 3);
  moietyFirst.passes.forEach((pass, i) => assertCloseIso(pass.datetime, classModel.passes[i].datetime));

  // The second moiety episode is real (Saturn's gap peaks ~17deg between the two, verified
  // against the vendored ephemeris) but never perfects - closest_approach is a station.
  assertCloseIso(moietySecond.enters_orb, '2027-11-07T21:39:59Z');
  assertCloseIso(moietySecond.leaves_orb, '2028-02-07T00:32:27Z');
  assert.deepEqual(moietySecond.passes, []);
  assert.equal(moietySecond.closest_approach.stationary, true);
});

// Regression test for the PR #51 review finding: findContact took orbCrossings[0]/[last]
// as a single envelope, which is only valid for one entry/exit. Mars is in the default
// transiting set (§4.3) and returns to a natal point roughly every 2 years, so on this
// 6-year window the old code welded unrelated visits into one fabricated envelope
// (`enters_orb: 2026-01-01` / `leaves_orb: 2031-11-05` for what the reviewer counted as
// 3 real passes). Verified directly against the vendored ephemeris (2026-08-08): Mars is
// only 1.87deg from natal Sun at the window's own start (a conjunction that already
// happened just before 2026-01-01), so the correct output is 4 episodes - one truncated
// leading episode with 0 passes (the approach that already perfected before the window
// opened) plus the 3 full episodes the reviewer counted, one pass each. Total passes
// across episodes must equal 3; no episode may span more than a plausible single Mars
// approach (weeks, not years).
test('regression: Mars conjunct natal Sun over 6 years is 4 episodes (1 truncated + 3 full), never a multi-year envelope', { skip: !HAS_SWETEST }, () => {
  const provider = providerFor('Mars');
  const start = jd('2026-01-01T00:00:00Z');
  const end = jd('2032-01-01T00:00:00Z');
  const { segments, stations } = scanTransitingBody(provider, start, end, 1);

  const settings = resolveAspectSettings({ orbModel: 'moiety' });
  const orbAllowed = orbAllowedFor(settings, 'Mars', 'Sun', 'conjunction');

  const contacts = findContacts({
    provider, segments, stations,
    natalLongitude: natal.Sun, aspectAngle: MAJOR_ASPECTS.conjunction, orbAllowed,
    startJd: start, endJd: end,
  });

  assert.equal(contacts.length, 4, `expected 4 Mars-Sun conjunction episodes, got ${contacts.length}`);

  const totalPasses = contacts.reduce((sum, c) => sum + c.passes.length, 0);
  assert.equal(totalPasses, 3, 'expected 3 real exact passes total, matching the reviewer\'s count');

  const MAX_PLAUSIBLE_EPISODE_DAYS = 60; // a single Mars approach is weeks, not years
  for (const contact of contacts) {
    const days = (new Date(contact.leaves_orb) - new Date(contact.enters_orb)) / 86400000;
    assert.ok(days < MAX_PLAUSIBLE_EPISODE_DAYS, `episode ${contact.enters_orb} spans ${days} days - looks like a fabricated multi-visit envelope`);
  }

  const [leading, ...full] = contacts;
  assert.equal(leading.enters_orb_truncated, true, 'the leading episode was already in orb when the window opened');
  assert.equal(leading.passes.length, 0);
  for (const contact of full) {
    assert.equal(contact.passes.length, 1);
    assert.equal(contact.enters_orb_truncated, false);
    assert.equal(contact.leaves_orb_truncated, false);
  }

  // Episodes are sorted and never overlap - each one's start is strictly after the
  // previous one's end.
  for (let i = 1; i < contacts.length; i++) {
    assert.ok(new Date(contacts[i].enters_orb) > new Date(contacts[i - 1].leaves_orb));
  }
});

// Reverse direction so the envelope test can't pass by assuming moiety is always wider
// (Pluto-Venus: moiety 6° is narrower than class 8°).
test('§4.4 orb model direction reverses for a different pair (Pluto-Venus: moiety 6° < class 8°)', { skip: !HAS_SWETEST }, () => {
  const moietySettings = resolveAspectSettings({ orbModel: 'moiety' });
  const classSettings = resolveAspectSettings({ orbModel: 'class' });
  assert.equal(orbAllowedFor(moietySettings, 'Pluto', 'Venus', 'conjunction'), 6);
  assert.equal(orbAllowedFor(classSettings, 'Pluto', 'Venus', 'conjunction'), 8);
});

// Regression guard (PR #51 review): seriesFor's old floor-based row count undershot
// whenever the window wasn't an exact multiple of stepDays, so the coarse series never
// reached a sample after this station and it was silently dropped from the result - not
// flagged as truncated, just absent. This window ends well inside the final partial day
// after Neptune's verified 2026-12-12T22:17:19Z direct station (§4.5), non-aligned to a
// day boundary, so it exercises exactly the undershoot the old code missed.
test('regression: a station in the final partial day of a non-aligned window is found, not dropped', { skip: !HAS_SWETEST }, () => {
  const start = jd('2026-12-01T00:00:00Z');
  const end = jd('2026-12-12T23:00:00Z'); // ~43 min after the verified direct station
  const stations = findStations(providerFor('Neptune'), start, end, 1);

  const found = stations.find((s) => s.direction === 'direct' && Math.abs(s.jd - jd('2026-12-12T22:17:19Z')) < 1);
  assert.ok(found, 'expected the Dec 12 direct station to be found even though the window ends mid-day');
  assert.ok(Math.abs(found.longitude - 1.6129272) < 1e-6);
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
    sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd, lunationPhases: 'quarters',
  });

  const firstQuarter = withQuarters.find((l) => l.phase === 'first_quarter');
  const lastQuarter = withQuarters.find((l) => l.phase === 'last_quarter');
  assert.ok(firstQuarter);
  assert.ok(lastQuarter);
  assertCloseIso(firstQuarter.datetime, '2026-01-26T04:47:24Z');
  assertCloseIso(lastQuarter.datetime, '2026-01-10T15:48:24Z');
});

// SUP-360 §7.1/§7.2 at engine level - the eight-phase set is a strict superset of
// "quarters" (identical phase AND datetime for every kept event) and correctly
// distinguishes waxing from waning, which a folded-aspect implementation could not do
// (§6.1: 45deg Crescent and 315deg Balsamic would otherwise collapse to one event).
test('§7.1/§7.2 eight_phase is a superset of quarters, and Crescent/Balsamic + Gibbous/Disseminating are distinct', { skip: !HAS_SWETEST }, () => {
  const startJd = jd('2026-01-01T00:00:00Z');
  const endJd = jd('2027-01-01T00:00:00Z');
  const quarters = findLunations({
    sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd, lunationPhases: 'quarters',
  });
  const eightPhase = findLunations({
    sunProvider: providerFor('Sun'), moonProvider: providerFor('Moon'), startJd, endJd, lunationPhases: 'eight_phase',
  });

  // Not an exact x2: a bounded window's partial cycle at the edge can contribute fewer
  // than 8 phase starts while still contributing 2 quarters (spec §7.4 pins 99, not 100,
  // for this exact 2026 window). The superset loop below carries the real invariant.
  assert.ok(eightPhase.length > quarters.length);
  for (const q of quarters) {
    const match = eightPhase.find((e) => e.phase === q.phase && e.datetime === q.datetime);
    assert.ok(match, `expected quarters event ${q.phase}@${q.datetime} to appear unchanged in eight_phase`);
  }

  const crescents = eightPhase.filter((e) => e.phase === 'crescent');
  const balsamics = eightPhase.filter((e) => e.phase === 'balsamic');
  const gibbouses = eightPhase.filter((e) => e.phase === 'gibbous');
  const disseminatings = eightPhase.filter((e) => e.phase === 'disseminating');
  assert.ok(crescents.length > 0 && balsamics.length > 0);
  assert.ok(gibbouses.length > 0 && disseminatings.length > 0);
  for (const c of crescents) assert.ok(!balsamics.some((b) => b.datetime === c.datetime));
  for (const g of gibbouses) assert.ok(!disseminatings.some((d) => d.datetime === g.datetime));
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

// findCrossings (SUP-351): the ingress primitive - every crossing of a fixed longitude,
// no orb envelope. Spec §1.8/§4.6 - Pluto crossed 0deg Aquarius five times, retrograde
// re-ingress included, over this window. Verified independently at engine level so a
// find_events-tool-level regression and an engine-level regression can't both hide behind
// the same bug.
test('findCrossings: Pluto crosses 300° five times 2023-2025 (retrograde re-ingress)', { skip: !HAS_SWETEST }, () => {
  const start = jd('2023-01-01T00:00:00Z');
  const end = jd('2025-06-01T00:00:00Z');
  const provider = providerFor('Pluto');
  const { segments } = scanTransitingBody(provider, start, end, 1);

  const crossings = findCrossings(provider, segments, 300);
  assert.equal(crossings.length, 5);

  const expectedDirect = [true, false, true, false, true]; // D, R, D, R, D
  crossings.forEach((c, i) => {
    assert.equal(c.retrograde, !expectedDirect[i]);
    assert.ok(Math.abs(c.longitude - 300) < 1e-4);
  });
});

// SUP-390: the batched station refinement is a spawn-count change and nothing else, so the
// gate is that a provider offering `samplesFrom` and one offering only `positionAt` return
// the SAME station - to the last bit, not to a tolerance. Pluto's dithering printed speed
// near a station (see test/station-refinement.test.js) is exactly what makes that a real
// assertion rather than a formality: a sampling rule that picks a different flip in the
// dither band shows up here as a station seconds away.
test('station refinement: batched and scalar providers agree bit-for-bit on real stations', { skip: !HAS_SWETEST }, () => {
  const start = jd('2026-01-01T00:00:00Z');
  const end = jd('2027-01-01T00:00:00Z');

  for (const body of ['Mercury', 'Pluto', 'Neptune']) {
    const scalar = findStations(providerFor(body), start, end, 1);
    const batched = findStations(batchedProviderFor(body), start, end, 1);
    assert.ok(scalar.length > 0, `expected at least one ${body} station in 2026`);
    assert.deepEqual(batched, scalar, `${body}: batched station refinement diverged from scalar bisection`);
  }
});

// The other half of the same claim: it is cheaper. Counted rather than timed - a spawn count
// is the thing the change is actually about, and it does not drift with machine load.
test('station refinement: batching cuts spawns per station about fourfold', { skip: !HAS_SWETEST }, () => {
  const start = jd('2026-01-01T00:00:00Z');
  const end = jd('2027-01-01T00:00:00Z');

  const count = (provider) => {
    const spawns = { n: 0 };
    const counted = {
      seriesFor: (...args) => { spawns.n += 1; return provider.seriesFor(...args); },
      positionAt: (...args) => { spawns.n += 1; return provider.positionAt(...args); },
      ...(provider.samplesFrom ? { samplesFrom: (...args) => { spawns.n += 1; return provider.samplesFrom(...args); } } : {}),
    };
    findStations(counted, start, end, 1);
    return spawns.n;
  };

  const scalarSpawns = count(providerFor('Pluto'));
  const batchedSpawns = count(batchedProviderFor('Pluto'));
  assert.ok(
    batchedSpawns * 3 < scalarSpawns,
    `expected batching to cut spawns by more than 3x, got ${scalarSpawns} -> ${batchedSpawns}`,
  );
});
