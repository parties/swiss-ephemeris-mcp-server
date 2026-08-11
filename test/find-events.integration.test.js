import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, NIGHT_CHART, PARTNER_CHART, SOUTHERN_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const DAY_INPUT = { birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude };
const NIGHT_INPUT = { birth_datetime: NIGHT_CHART.datetime, latitude: NIGHT_CHART.latitude, longitude: NIGHT_CHART.longitude };

function assertCloseIso(actual, expected, toleranceSec = 2) {
  const diff = Math.abs(new Date(actual).getTime() - new Date(expected).getTime()) / 1000;
  assert.ok(diff <= toleranceSec, `expected ${actual} to be within ${toleranceSec}s of ${expected}`);
}

// --- Validation -------------------------------------------------------------------------

test('find_events rejects window_end before window_start', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', { ...DAY_INPUT, window_start: '2027-01-01T00:00:00Z', window_end: '2026-01-01T00:00:00Z' }),
    /window_end must be after window_start/
  );
});

test('find_events rejects an unknown event_types entry', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', { ...DAY_INPUT, window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z', event_types: ['bogus'] }),
    /event_types must be a non-empty array/
  );
});

test('find_events rejects an unknown transiting body', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', { ...DAY_INPUT, window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z', bodies: ['Ascendant'] }),
    /Unknown transiting body: Ascendant/
  );
});

test('find_events dedupes duplicate bodies entries', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = { window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z' };
  const [single, duplicated] = await Promise.all([
    server.handleToolCall('find_events', { ...DAY_INPUT, ...window, bodies: ['Mars'], event_types: ['sign_ingress'] }),
    server.handleToolCall('find_events', { ...DAY_INPUT, ...window, bodies: ['Mars', 'Mars'], event_types: ['sign_ingress'] }),
  ]);
  assert.ok(single.events.length > 0, 'expected at least one Mars sign_ingress in the window');
  assert.deepEqual(duplicated.events, single.events);
  assert.deepEqual(duplicated.settings_used.bodies, ['Mars']);
});

test('find_events rejects a malformed orb_overrides value', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', { ...DAY_INPUT, window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z', orb_overrides: 'nope' }),
    /orb_overrides must be an object/
  );
});

// spec Q9: max 10 years - clamp and flag rather than reject, so a caller can tell a
// truncated result apart from a complete one.
test('find_events clamps a window over 10 years and sets window.truncated', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2040-01-01T00:00:00Z',
    bodies: ['Pluto'], targets: ['Sun'], event_types: ['aspect'],
  });
  assert.equal(result.window.start, '2026-01-01T00:00:00Z');
  assert.equal(result.window.truncated, true);
  const clampedDays = (new Date(result.window.end) - new Date(result.window.start)) / 86400000;
  assert.ok(Math.abs(clampedDays - 3653) < 1);
});

test('find_events window.truncated is false for a window within the cap', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    bodies: ['Pluto'], targets: ['Sun'], event_types: ['aspect'],
  });
  assert.equal(result.window.truncated, false);
  assert.equal(result.window.end, '2027-01-01T00:00:00Z');
});

// --- settings_used --------------------------------------------------------------------

// spec §3.4/§6.3: the event engine has no node_type parameter of its own (lib/ephemeris-
// series.js hardcodes true Node) - this must be stated as a literal even though the
// snapshot tools already have a settable node_type.
test('find_events settings_used echoes node_type "true" as a literal, no param accepted', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2026-02-01T00:00:00Z',
    bodies: ['Saturn'], targets: ['Sun'],
  });
  assert.equal(result.settings_used.node_type, 'true');
});

test('find_events settings_used echoes the resolved bodies/targets/house_system/orb settings', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2026-02-01T00:00:00Z',
    bodies: ['Saturn'], targets: ['Sun', 'Moon'], house_system: 'K', orb_model: 'class', include_minor: true,
  });
  assert.deepEqual(result.settings_used.bodies, ['Saturn']);
  assert.deepEqual(result.settings_used.targets, ['Sun', 'Moon']);
  assert.equal(result.settings_used.house_system, 'K');
  assert.equal(result.settings_used.orb_model, 'class');
  assert.equal(result.settings_used.include_minor_aspects, true);
});

// --- §4.1 multi-pass, wired end to end through the tool --------------------------------

test('§4.1 Pluto square natal Lilith through find_events: 5 passes matching the fixture', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Pluto'], targets: ['Lilith'], event_types: ['aspect'],
  });

  const squares = result.contacts.filter((c) => c.transiting_body === 'Pluto' && c.natal_point === 'Lilith' && c.aspect === 'square');
  assert.equal(squares.length, 1);
  assert.equal(squares[0].passes.length, DAY_CHART.expected.plutoSquareLilithPasses);
  assert.equal(squares[0].category, 'major');
  assert.equal(squares[0].birth_time_sensitive, false);
  // orbs/aspect_angle are numbers, not calculate_transits'/calculate_synastry's .toFixed(2) strings.
  assert.equal(typeof squares[0].orb_allowed, 'number');
  assert.equal(typeof squares[0].aspect_angle, 'number');
  squares[0].passes.forEach((p) => {
    assert.equal(typeof p.longitude, 'number');
    assert.equal(typeof p.speed, 'number');
    assert.equal('jd' in p, false, 'internal jd must not leak into pass output');
  });
});

// The bug this ticket's own review caught: square/sextile/trine have two target
// longitudes 180deg apart (natal+angle, natal-angle) that are equally valid. Mars sweeps
// enough sky in a year to hit both, so a single-sided search silently drops half of them.
test('regression: two-sided aspect search finds both sides of a square within one window', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2028-01-01T00:00:00Z',
    bodies: ['Mars'], targets: ['Sun'], event_types: ['aspect'],
  });

  const squares = result.contacts.filter((c) => c.aspect === 'square');
  assert.ok(squares.length >= 2, 'expected Mars to square natal Sun from both sides within 2 years');
  // Every square is labelled with the canonical dict angle (90), never 270, regardless of
  // which of the two target longitudes it was actually found against.
  assert.ok(squares.every((c) => c.aspect_angle === 90));
  const passLongitudes = squares.flatMap((c) => c.passes.map((p) => Math.round(p.longitude * 100) / 100));
  assert.ok(passLongitudes.some((l) => Math.abs(l - 10.81) < 0.1), 'expected a pass near natal Sun + 90');
  assert.ok(passLongitudes.some((l) => Math.abs(l - 190.81) < 0.1), 'expected a pass near natal Sun - 90 (270)');
});

// --- §4.2 station-in-orb-never-perfects, through the tool -------------------------------

test('§4.2 Neptune conjunct natal Pallas through find_events: station-in-orb regression case', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Neptune'], targets: ['Pallas'], event_types: ['aspect', 'station'],
  });

  const conjunctions = result.contacts.filter((c) => c.transiting_body === 'Neptune' && c.natal_point === 'Pallas' && c.aspect === 'conjunction');
  assert.equal(conjunctions.length, 2, 'Neptune leaves and re-enters orb of Pallas within this window');
  const firstEpisode = conjunctions[0];
  assert.equal(firstEpisode.passes.length, 1);
  assert.equal(firstEpisode.closest_approach.orb, 0);
  assert.equal(firstEpisode.closest_approach.stationary, false);

  const station = result.events.find((e) => e.type === 'station' && e.body === 'Neptune' && e.direction === 'direct');
  assert.ok(station);
  assertCloseIso(station.datetime, DAY_CHART.expected.neptuneStationDirect2026);
  assert.ok(Math.abs(station.longitude - 1.6129272) < 1e-6);
  const pallasContact = station.natal_contacts.find((nc) => nc.natal_point === 'Pallas');
  assert.ok(pallasContact);
  assert.equal(pallasContact.aspect, 'conjunction');
  assert.ok(Math.abs(pallasContact.orb - 0.0533879) < 1e-6);
});

// --- §4.3 default scope and volume ------------------------------------------------------

// The one full-default-scope test in this file (17 targets x 5 aspects x 7 bodies) - kept
// to a single instance since it is the slow one (a few minutes).
test('§4.3 default scope: ~118 exact passes, Moon excluded by default, included on request', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-02T00:00:00Z', // + 366 days
    event_types: ['aspect'],
  });

  assert.equal(result.settings_used.bodies.includes('Moon'), false);
  assert.ok(!result.contacts.some((c) => c.transiting_body === 'Moon'), 'default scope must not include transiting Moon');

  const exactPasses = result.contacts.reduce((sum, c) => sum + c.passes.length, 0);
  assert.equal(exactPasses, 118, 'spec §4.3: 118 exact passes for the default scope over this window');
  // Contact-period count is asserted structurally rather than pinned to the spec's stated
  // 152: the two-sided aspect fix above (verified independently, see the regression test)
  // finds real episodes a single-sided search misses, which nudges this specific figure by
  // a handful. The 21.7x ratio below is the load-bearing claim, not this exact count.
  assert.ok(result.contacts.length >= 150 && result.contacts.length <= 160, `expected ~152 contact periods, got ${result.contacts.length}`);
}, { timeout: 180000 });

test('§4.3 explicit bodies: ["Moon"] does return transiting Moon contacts', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2026-02-01T00:00:00Z',
    bodies: ['Moon'], targets: ['Sun'], event_types: ['aspect'],
  });
  assert.ok(result.contacts.some((c) => c.transiting_body === 'Moon'), 'explicit Moon request must return Moon contacts');
});

// --- §4.4 orb model changes the episode, in both directions -----------------------------

test('§4.4 Saturn square natal Sun: moiety (12°) is 2 episodes, class (8°) is 1, matching the corrected spec figures', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const moiety = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Saturn'], targets: ['Sun'], event_types: ['aspect'], orb_model: 'moiety',
  });
  const cls = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Saturn'], targets: ['Sun'], event_types: ['aspect'], orb_model: 'class',
  });

  const moietySquares = moiety.contacts.filter((c) => c.aspect === 'square');
  const classSquares = cls.contacts.filter((c) => c.aspect === 'square');
  assert.equal(moietySquares.length, 2, 'moiety orb genuinely re-enters and exits a second time');
  assert.equal(classSquares.length, 1);

  assert.equal(moietySquares[0].orb_allowed, 12);
  assert.equal(classSquares[0].orb_allowed, 8);
  assertCloseIso(moietySquares[0].enters_orb, '2026-02-02T17:55:52Z');
  assertCloseIso(moietySquares[0].leaves_orb, '2027-05-20T07:39:16Z');
  assertCloseIso(classSquares[0].enters_orb, '2026-03-10T00:14:51Z');
  assertCloseIso(classSquares[0].leaves_orb, '2027-04-16T19:44:33Z');

  assert.equal(moietySquares[0].passes.length, 3);
  assert.equal(classSquares[0].passes.length, 3);
  moietySquares[0].passes.forEach((p, i) => assertCloseIso(p.datetime, classSquares[0].passes[i].datetime));

  assert.deepEqual(moietySquares[1].passes, []);
  assert.equal(moietySquares[1].closest_approach.stationary, true);
});

// Reverse direction so the envelope test can't pass by assuming moiety is always wider.
test('§4.4 orb model direction reverses for Pluto conjunct Venus (moiety 6° < class 8°)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const moiety = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Pluto'], targets: ['Venus'], event_types: ['aspect'], orb_model: 'moiety',
  });
  const cls = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Pluto'], targets: ['Venus'], event_types: ['aspect'], orb_model: 'class',
  });

  const moietyConj = moiety.contacts.find((c) => c.aspect === 'conjunction');
  const classConj = cls.contacts.find((c) => c.aspect === 'conjunction');
  assert.equal(moietyConj.orb_allowed, 6);
  assert.equal(classConj.orb_allowed, 8);
  assert.equal(moietyConj.passes.length, DAY_CHART.expected.plutoConjunctVenusPasses);
});

// --- §4.5 stations, through the tool -----------------------------------------------------

test('§4.5 Neptune/Saturn stations over 730 days match the spec, negative-body assertions hold', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2028-01-01T00:00:00Z',
    bodies: ['Neptune', 'Saturn', 'Sun', 'Moon', 'Lilith'], event_types: ['station'],
  });

  const expectFound = (direction, body, datetime, longitude) => {
    const found = result.events.find((e) => e.type === 'station' && e.body === body && e.direction === direction
      && Math.abs(new Date(e.datetime) - new Date(datetime)) < 2000);
    assert.ok(found, `expected a ${direction} ${body} station near ${datetime}`);
    assert.ok(Math.abs(found.longitude - longitude) < 1e-6);
  };
  expectFound('retrograde', 'Neptune', '2026-07-07T10:54:29Z', 4.4180692);
  expectFound('direct', 'Neptune', '2026-12-12T22:17:19Z', 1.6129272);
  expectFound('retrograde', 'Saturn', '2026-07-26T19:56:27Z', 14.7499589);
  expectFound('direct', 'Saturn', '2026-12-10T23:31:04Z', 7.9310379);

  // Sun/Moon/Lilith never station, even though explicitly requested via `bodies` above -
  // and the true Node must never emit one either, even explicitly requested (§1.7 jitter).
  assert.ok(!result.events.some((e) => e.type === 'station' && ['Sun', 'Moon', 'Lilith'].includes(e.body)));
});

test('§4.5/SUP-359 review: at rate "transit" station search stays narrowed to `bodies`, unlike rate "secondary_progression"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2028-01-01T00:00:00Z',
    bodies: ['Mars'], event_types: ['station'],
  });

  // Neptune and Saturn both genuinely station within this exact window (see the previous
  // test) - if station search ever stopped narrowing to `bodies` at the transit rate the
  // way it does at the progressed rate, they'd leak into this Mars-only request.
  assert.ok(result.events.every((e) => e.body === 'Mars'));
  assert.ok(!result.events.some((e) => ['Neptune', 'Saturn'].includes(e.body)));
});

test('§4.5 negative: North Node never stations even when explicitly requested (jitter, not real stations)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    bodies: ['North Node'], event_types: ['station'],
  });
  assert.deepEqual(result.events, []);
});

// --- §4.6 ingresses ------------------------------------------------------------------

test('§4.6 retrograde re-ingress: Pluto crosses 0° Aquarius 5 times, retrograde rows carry to_sign Capricorn', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2023-01-01T00:00:00Z', window_end: '2025-06-01T00:00:00Z',
    bodies: ['Pluto'], event_types: ['sign_ingress'],
  });

  const crossings = result.events.filter((e) => e.type === 'sign_ingress' && Math.abs(e.longitude - 300) < 1e-3);
  assert.equal(crossings.length, 5);
  const directions = crossings.map((c) => c.direction);
  assert.deepEqual(directions, ['direct', 'retrograde', 'direct', 'retrograde', 'direct']);
  crossings.filter((c) => c.direction === 'retrograde').forEach((c) => {
    assert.equal(c.to_sign, 'Capricorn');
    assert.equal(c.from_sign, 'Aquarius');
  });
  crossings.filter((c) => c.direction === 'direct').forEach((c) => {
    assert.equal(c.to_sign, 'Aquarius');
    assert.equal(c.from_sign, 'Capricorn');
  });
});

test('§4.6 Whole Sign: cusps are exact multiples of 30°, house_ingress and sign_ingress coincide, neither array empty', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    house_system: 'W', event_types: ['sign_ingress', 'house_ingress'],
  });

  const houseIngresses = result.events.filter((e) => e.type === 'house_ingress');
  const signIngresses = result.events.filter((e) => e.type === 'sign_ingress');
  assert.ok(houseIngresses.length > 0, 'house_ingress must not be empty under Whole Sign');
  assert.ok(signIngresses.length > 0, 'sign_ingress must not be empty under Whole Sign');
  assert.equal(houseIngresses.length, signIngresses.length);
  assert.ok(houseIngresses.every((e) => e.coincides_with_sign_ingress === true));

  for (const hi of houseIngresses) {
    const match = signIngresses.find((si) => si.body === hi.body && Math.abs(new Date(si.datetime) - new Date(hi.datetime)) < 1000);
    assert.ok(match, `expected a matching sign_ingress for ${hi.body} at ${hi.datetime}`);
  }
});

test('§4.6 Placidus: coincides_with_sign_ingress is false on every house_ingress row', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    house_system: 'P', event_types: ['house_ingress'],
  });
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((e) => e.coincides_with_sign_ingress === false));
  assert.ok(result.events.every((e) => e.house_system === 'P'));
});

// The -fj regression guard: house_ingress via natal cusps (never swetest's transiting-
// moment -fj house column) gives a single-digit count over a short window. Wiring up -fj
// would rotate the transiting Ascendant daily and inflate this by roughly 12x.
test('§4.6 -fj regression guard: default-set house_ingress count is single-digit over 30 days', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2026-01-31T00:00:00Z',
    event_types: ['house_ingress'],
  });
  assert.ok(result.events.length < 10, `expected a single-digit house_ingress count, got ${result.events.length}`);
});

test('SOUTHERN_CHART: house ingress is well-formed at a southern latitude', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: SOUTHERN_CHART.datetime, latitude: SOUTHERN_CHART.latitude, longitude: SOUTHERN_CHART.longitude,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['house_ingress'],
  });
  assert.ok(result.events.length > 0);
  for (const e of result.events) {
    assert.ok(e.from_house >= 1 && e.from_house <= 12);
    assert.ok(e.to_house >= 1 && e.to_house <= 12);
    assert.ok(['direct', 'retrograde'].includes(e.direction));
  }
});

// --- §4.7 lunations and eclipses --------------------------------------------------------

test('§4.7 first Full/New Moon of 2026 through find_events, quarters absent by default', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['lunation'],
  });

  const lunations = result.events.filter((e) => e.type === 'lunation');
  assert.ok(lunations.length >= 24 && lunations.length <= 26);
  assert.ok(!lunations.some((l) => l.phase === 'first_quarter' || l.phase === 'last_quarter'));

  const firstFull = lunations.find((l) => l.phase === 'full');
  assertCloseIso(firstFull.datetime, '2026-01-03T10:02:55Z');
  const firstNew = lunations.find((l) => l.phase === 'new');
  assertCloseIso(firstNew.datetime, '2026-01-18T19:51:59Z');

  lunations.forEach((l) => assert.equal('jd' in l, false));
});

test('§4.7 quarters appear opt-in via include_quarter_moons', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['lunation'], include_quarter_moons: true,
  });

  const firstQuarter = result.events.find((e) => e.phase === 'first_quarter');
  const lastQuarter = result.events.find((e) => e.phase === 'last_quarter');
  assert.ok(firstQuarter);
  assert.ok(lastQuarter);
  assertCloseIso(firstQuarter.datetime, '2026-01-26T04:47:24Z');
  assertCloseIso(lastQuarter.datetime, '2026-01-10T15:48:24Z');
  assert.equal(result.settings_used.include_quarter_moons, true);
});

test('§4.7 eclipse annotation carries both timestamps and is absent (not null) elsewhere', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['lunation'],
  });

  const solar = result.events.find((e) => e.eclipse?.eclipse_type === 'annular solar');
  assert.ok(solar);
  assertCloseIso(solar.datetime, '2026-02-17T12:01:09Z');
  assertCloseIso(solar.eclipse.maximum_datetime, '2026-02-17T12:11:53Z');
  assert.notEqual(solar.datetime, solar.eclipse.maximum_datetime);
  assert.equal(solar.eclipse.saros_series, 121);
  assert.equal(solar.eclipse.saros_number, 61);

  const lunar = result.events.find((e) => e.eclipse?.eclipse_type === 'total lunar eclipse');
  assert.ok(lunar);
  assertCloseIso(lunar.datetime, '2026-03-03T11:37:54Z');
  assertCloseIso(lunar.eclipse.maximum_datetime, '2026-03-03T11:33:41Z');
  assert.equal(lunar.eclipse.saros_series, 133);
  assert.equal(lunar.eclipse.saros_number, 27);

  const plain = result.events.find((e) => e.type === 'lunation' && !e.eclipse);
  assert.ok(plain);
  assert.equal('eclipse' in plain, false);
});

// --- targets / include_angles / birth_time_sensitive ------------------------------------

test('PARTNER_CHART: targets parameter scopes contacts to the requested natal points', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: PARTNER_CHART.datetime, latitude: PARTNER_CHART.latitude, longitude: PARTNER_CHART.longitude,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Mars'], targets: ['Venus', 'Mercury'], event_types: ['aspect'],
  });
  assert.deepEqual(result.settings_used.targets, ['Venus', 'Mercury']);
  assert.ok(result.contacts.length > 0, 'expected at least one Mars contact to Venus/Mercury over 3 years');
  assert.ok(result.contacts.every((c) => ['Venus', 'Mercury'].includes(c.natal_point)));
});

// Part of Fortune is the one sect-dependent natal target (spec §4.9) - it differs between
// DAY_CHART and NIGHT_CHART even though both share the same clock date/location, so this
// runs on both rather than just one.
test('Part of Fortune as a natal target (include_angles) is sect-dependent: DAY_CHART vs NIGHT_CHART', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const day = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Mars'], targets: ['Part of Fortune'], include_angles: true, event_types: ['aspect'],
  });
  const night = await server.handleToolCall('find_events', {
    ...NIGHT_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Mars'], targets: ['Part of Fortune'], include_angles: true, event_types: ['aspect'],
  });

  // include_angles also pulls in Ascendant/Midheaven (same gate as calculate_transits),
  // so narrow to the Part of Fortune rows specifically before checking sect-dependence.
  const dayPoF = day.contacts.filter((c) => c.natal_point === 'Part of Fortune');
  const nightPoF = night.contacts.filter((c) => c.natal_point === 'Part of Fortune');
  assert.ok(dayPoF.length > 0, 'expected at least one Mars-to-PoF contact for DAY_CHART');
  assert.ok(nightPoF.length > 0, 'expected at least one Mars-to-PoF contact for NIGHT_CHART');
  assert.ok(day.contacts.every((c) => c.birth_time_sensitive === true), 'Ascendant/Midheaven/PoF are all birth_time_sensitive');
  assert.ok(night.contacts.every((c) => c.birth_time_sensitive === true));

  // Different sect -> different PoF longitude -> different exact-pass timestamps for the
  // same transiting body/aspect, proving the tool actually used the sect-specific value
  // rather than always resolving the same (e.g. day-formula) longitude.
  const dayPasses = dayPoF.flatMap((c) => c.passes.map((p) => p.datetime)).sort();
  const nightPasses = nightPoF.flatMap((c) => c.passes.map((p) => p.datetime)).sort();
  assert.notDeepEqual(dayPasses, nightPasses);
});

test('birth_time_sensitive is true only for Ascendant/Midheaven/Part of Fortune/Vertex targets', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2029-01-01T00:00:00Z',
    bodies: ['Mars'], targets: ['Sun', 'Ascendant', 'Midheaven'], include_angles: true, event_types: ['aspect'],
  });
  assert.ok(result.contacts.some((c) => c.natal_point === 'Sun'));
  assert.ok(result.contacts.some((c) => ['Ascendant', 'Midheaven'].includes(c.natal_point)));
  for (const c of result.contacts) {
    const expected = ['Ascendant', 'Midheaven', 'Part of Fortune', 'Vertex'].includes(c.natal_point);
    assert.equal(c.birth_time_sensitive, expected, `${c.natal_point} birth_time_sensitive mismatch`);
  }
});

// --- event_types filtering and sort order ------------------------------------------------

test('event_types filters output to only the requested categories', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    bodies: ['Saturn'], targets: ['Sun'], event_types: ['station'],
  });
  assert.equal(result.contacts.length, 0);
  assert.ok(result.events.every((e) => e.type === 'station'));
});

test('contacts[] is sorted by enters_orb ascending; events[] is sorted by datetime ascending', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    ...DAY_INPUT,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-06-01T00:00:00Z',
    bodies: ['Mars', 'Saturn'], targets: ['Sun', 'Moon', 'Venus'],
  });

  for (let i = 1; i < result.contacts.length; i++) {
    assert.ok(new Date(result.contacts[i - 1].enters_orb) <= new Date(result.contacts[i].enters_orb));
  }
  for (let i = 1; i < result.events.length; i++) {
    assert.ok(new Date(result.events[i - 1].datetime) <= new Date(result.events[i].datetime));
  }
});
