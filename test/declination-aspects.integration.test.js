import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, SOUTHERN_CHART, PARTNER_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

function chartInput(chart) {
  return { datetime: chart.datetime, latitude: chart.latitude, longitude: chart.longitude };
}

// §4.2 - the complete DAY_CHART list, exact orb order. A full-list assertion catches an
// over-inclusive body list and an accidental angle/Node inclusion in a way spot checks can't.
const DAY_CHART_DECLINATION_ASPECTS = [
  ['Mars', 'Neptune', 'parallel', 0.068323],
  ['Saturn', 'Neptune', 'parallel', 0.179061],
  ['Moon', 'Juno', 'parallel', 0.181626],
  ['Sun', 'Jupiter', 'contraparallel', 0.223394],
  ['Mars', 'Saturn', 'parallel', 0.247384],
  ['Jupiter', 'Uranus', 'contraparallel', 0.360466],
  ['Sun', 'Uranus', 'parallel', 0.583860],
  ['Lilith', 'Pallas', 'parallel', 0.642716],
  ['Sun', 'Saturn', 'parallel', 0.769586],
  ['Mercury', 'Vesta', 'parallel', 0.895179],
  ['Venus', 'Pallas', 'parallel', 0.902725],
  ['Sun', 'Neptune', 'parallel', 0.948647],
  ['Jupiter', 'Saturn', 'contraparallel', 0.992980],
];

// calculate_planetary_positions: no settings_used block on this tool, so only the array's
// presence/absence and shape are asserted, plus the same §4.2 full-list figures as
// calculate_aspects (same body set, same default orb, independent of any other flag).
test('calculate_planetary_positions: declination_aspects is absent by default', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', chartInput(DAY_CHART));
  assert.equal(result.declination_aspects, undefined);
});

test('calculate_planetary_positions: declination_aspects matches the DAY_CHART §4.2 list when the flag is set', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
  });

  assert.equal(result.declination_aspects.length, 13);
  result.declination_aspects.forEach((row, i) => {
    const [bodyA, bodyB, aspect, orb] = DAY_CHART_DECLINATION_ASPECTS[i];
    assert.equal(row.body_a, bodyA, `row ${i}: body_a`);
    assert.equal(row.body_b, bodyB, `row ${i}: body_b`);
    assert.equal(row.aspect, aspect, `row ${i}: aspect`);
    assert.ok(Math.abs(row.orb - orb) < 1e-5, `row ${i}: orb ${row.orb} should be ~${orb}`);
    assert.equal(row.orb_allowed, 1);
    assert.equal(row.applying, null, `row ${i}: applying must be null`);
  });

  const names = new Set(result.declination_aspects.flatMap((r) => [r.body_a, r.body_b]));
  assert.ok(!names.has('North Node'), 'North Node must never appear in declination_aspects');
});

test('calculate_planetary_positions: orb_overrides.declination widens the match set; an unknown nested key is rejected', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const defaultResult = await server.handleToolCall('calculate_planetary_positions', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
  });
  const widened = await server.handleToolCall('calculate_planetary_positions', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
    orb_overrides: { declination: { parallel: 2 } },
  });
  assert.ok(widened.declination_aspects.length > defaultResult.declination_aspects.length);

  await assert.rejects(
    () => server.handleToolCall('calculate_planetary_positions', {
      ...chartInput(DAY_CHART),
      orb_overrides: { declination: { conjunction: 2 } },
    }),
    /Unknown aspect in orb_overrides: conjunction/
  );
});

test('calculate_aspects: declination_aspects is absent by default, but settings_used always echoes the resolved settings', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', chartInput(DAY_CHART));

  assert.equal(result.declination_aspects, undefined);
  assert.equal(result.settings_used.include_declination_aspects, false);
  assert.deepEqual(result.settings_used.declination_orbs, { parallel: 1, contraparallel: 1 });
  assert.ok(!result.settings_used.declination_bodies.includes('North Node'));
  assert.equal(result.settings_used.declination_bodies.length, 16);
});

// §4.1 - the headline claim the whole ticket rests on: these two pairs are only visible in
// declination, not longitude.
test('DAY_CHART §4.1: Mercury-Vesta and Venus-Pallas are declination-only contacts', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
    include_minor: true,
  });

  const findLongitude = (a, b) => result.aspects.find(
    (x) => (x.body_a === a && x.body_b === b) || (x.body_a === b && x.body_b === a)
  );
  assert.equal(findLongitude('Mercury', 'Vesta'), undefined, 'Mercury-Vesta must not appear in longitude aspects, even with include_minor');
  assert.equal(findLongitude('Venus', 'Pallas'), undefined, 'Venus-Pallas must not appear in longitude aspects, even with include_minor');

  const findDeclination = (a, b) => result.declination_aspects.find(
    (x) => (x.body_a === a && x.body_b === b) || (x.body_a === b && x.body_b === a)
  );
  const mercuryVesta = findDeclination('Mercury', 'Vesta');
  const venusPallas = findDeclination('Venus', 'Pallas');
  assert.ok(mercuryVesta, 'Mercury-Vesta should be a declination parallel');
  assert.ok(venusPallas, 'Venus-Pallas should be a declination parallel');
  assert.equal(mercuryVesta.aspect, 'parallel');
  assert.equal(venusPallas.aspect, 'parallel');
  assert.ok(Math.abs(mercuryVesta.orb - 0.895179) < 1e-5);
  assert.ok(Math.abs(venusPallas.orb - 0.902725) < 1e-5);
});

test('DAY_CHART §4.2: the complete 1deg/16-body declination_aspects list, exact order and orbs', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  // Widest possible net on the longitude side (angles/South Node/Vertex/minors all on) -
  // declination_aspects must be unaffected by every one of these, since none of that gating
  // applies to declination participation (§Q2/§Q3).
  const result = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
    include_minor: true,
    include_angles: true,
    include_south_node: true,
    include_vertex: true,
  });

  assert.equal(result.declination_aspects.length, DAY_CHART.expected.declinationAspectCount);
  assert.equal(result.declination_aspects.length, 13);

  result.declination_aspects.forEach((row, i) => {
    const [bodyA, bodyB, aspect, orb] = DAY_CHART_DECLINATION_ASPECTS[i];
    assert.equal(row.body_a, bodyA, `row ${i}: body_a`);
    assert.equal(row.body_b, bodyB, `row ${i}: body_b`);
    assert.equal(row.aspect, aspect, `row ${i}: aspect`);
    assert.ok(Math.abs(row.orb - orb) < 1e-5, `row ${i}: orb ${row.orb} should be ~${orb}`);
    assert.equal(row.orb_allowed, 1);
    assert.equal(row.applying, null, `row ${i}: applying must be null`);
    assert.ok(typeof row.orb === 'number', 'orb must be a number, not a string');
  });

  // Negative assertions.
  const names = new Set(result.declination_aspects.flatMap((r) => [r.body_a, r.body_b]));
  assert.ok(!names.has('North Node'), 'North Node must never appear in declination_aspects');
  for (const excluded of ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Vertex', 'Part of Fortune']) {
    assert.ok(!names.has(excluded), `${excluded} must never appear in declination_aspects`);
  }
  // The mirror-double-count signature (§Q3): these two pairs at orb exactly 0 would appear
  // if angle declination aspects leaked in.
  assert.ok(!result.declination_aspects.some(
    (r) => (r.body_a === 'Ascendant' && r.body_b === 'Descendant') || (r.body_a === 'Descendant' && r.body_b === 'Ascendant')
  ));
  assert.ok(!result.declination_aspects.some(
    (r) => (r.body_a === 'Midheaven' && r.body_b === 'IC') || (r.body_a === 'IC' && r.body_b === 'Midheaven')
  ));
});

test('SOUTHERN_CHART: 8 declination_aspects, tightest Saturn parallel Ceres, includes a contraparallel pair', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    ...chartInput(SOUTHERN_CHART),
    include_declination_aspects: true,
  });

  assert.equal(result.declination_aspects.length, SOUTHERN_CHART.expected.declinationAspectCount);
  assert.equal(result.declination_aspects.length, 8);

  const tightest = result.declination_aspects[0];
  assert.equal(tightest.body_a, 'Saturn');
  assert.equal(tightest.body_b, 'Ceres');
  assert.equal(tightest.aspect, 'parallel');
  assert.ok(Math.abs(tightest.orb - 0.314272) < 1e-5);

  const marsPluto = result.declination_aspects.find(
    (r) => (r.body_a === 'Mars' && r.body_b === 'Pluto') || (r.body_a === 'Pluto' && r.body_b === 'Mars')
  );
  assert.ok(marsPluto, 'Mars-Pluto contraparallel should be present');
  assert.equal(marsPluto.aspect, 'contraparallel');
  assert.ok(Math.abs(marsPluto.orb - 0.592604) < 1e-5);
});

test('PARTNER_CHART: 16 declination_aspects, tightest Mercury contraparallel Neptune', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    ...chartInput(PARTNER_CHART),
    include_declination_aspects: true,
  });

  assert.equal(result.declination_aspects.length, PARTNER_CHART.expected.declinationAspectCount);
  assert.equal(result.declination_aspects.length, 16);

  const tightest = result.declination_aspects[0];
  assert.equal(tightest.body_a, 'Mercury');
  assert.equal(tightest.body_b, 'Neptune');
  assert.equal(tightest.aspect, 'contraparallel');
  assert.ok(Math.abs(tightest.orb - 0.025838) < 1e-5);
});

// §4.6 - orb-class isolation, both directions.
test('§4.6: orb_overrides.declination widens the declination match set and leaves longitude aspects untouched', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const defaultResult = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
  });
  const widened = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    include_declination_aspects: true,
    orb_overrides: { declination: { parallel: 2 } },
  });

  assert.ok(widened.declination_aspects.length > defaultResult.declination_aspects.length);
  assert.equal(widened.aspects.length, defaultResult.aspects.length, 'longitude aspect count must be unaffected by orb_overrides.declination');
  assert.deepEqual(widened.settings_used.declination_orbs, { parallel: 2, contraparallel: 1 });
});

test('§4.6: a flat/class-mode longitude override leaves declination_orbs untouched', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    orb_model: 'class',
    orb_overrides: { conjunction: 12 },
  });
  assert.deepEqual(result.settings_used.declination_orbs, { parallel: 1, contraparallel: 1 });
});

test('§4.6: a moiety override leaves declination_orbs untouched', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    orb_overrides: { moieties: { Sun: 10 } },
  });
  assert.deepEqual(result.settings_used.declination_orbs, { parallel: 1, contraparallel: 1 });
});

test('§4.6: orb_overrides.declination is accepted under both orb_model "moiety" and "class"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const moietyMode = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    orb_model: 'moiety',
    orb_overrides: { declination: { parallel: 2 } },
    include_declination_aspects: true,
  });
  const classMode = await server.handleToolCall('calculate_aspects', {
    ...chartInput(DAY_CHART),
    orb_model: 'class',
    orb_overrides: { declination: { parallel: 2 } },
    include_declination_aspects: true,
  });
  assert.deepEqual(moietyMode.settings_used.declination_orbs, { parallel: 2, contraparallel: 1 });
  assert.deepEqual(classMode.settings_used.declination_orbs, { parallel: 2, contraparallel: 1 });
});

test('§4.6: an unknown nested key under orb_overrides.declination is rejected', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', {
      ...chartInput(DAY_CHART),
      orb_overrides: { declination: { conjunction: 2 } },
    }),
    /Unknown aspect in orb_overrides: conjunction/
  );
});

// calculate_transits: transiting_body/natal_body naming, gated by the flag, unaffected by
// which longitude gating flags are set. The transiting side is "now", so only structural
// properties are asserted here, not fixed orb values.
test('calculate_transits: declination_aspects uses transiting_body/natal_body naming and is gated by the flag', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutFlag = await server.handleToolCall('calculate_transits', {
    birth_datetime: DAY_CHART.datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
  });
  assert.equal(withoutFlag.declination_aspects, undefined);
  assert.equal(withoutFlag.settings_used.include_declination_aspects, false);
  assert.deepEqual(withoutFlag.settings_used.declination_orbs, { parallel: 1, contraparallel: 1 });

  const withFlag = await server.handleToolCall('calculate_transits', {
    birth_datetime: DAY_CHART.datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
    include_declination_aspects: true,
  });
  assert.ok(Array.isArray(withFlag.declination_aspects));
  for (const row of withFlag.declination_aspects) {
    assert.ok(typeof row.transiting_body === 'string');
    assert.ok(typeof row.natal_body === 'string');
    assert.notEqual(row.transiting_body, 'North Node');
    assert.notEqual(row.natal_body, 'North Node');
    assert.ok(['parallel', 'contraparallel'].includes(row.aspect));
    assert.equal(row.applying, null);
    assert.ok(typeof row.orb === 'number', 'orb must be a number, not a string (unlike transit_aspects)');
    assert.equal(row.orb_allowed, 1);
    for (let i = 1; i < withFlag.declination_aspects.length; i++) {
      assert.ok(withFlag.declination_aspects[i - 1].orb <= withFlag.declination_aspects[i].orb);
    }
  }
});

// calculate_synastry: person1_planet/person2_planet naming, gated by the flag. Both sides are
// fixed birth data, so this pins an exact figure as an end-to-end wiring check (the underlying
// parallel/contraparallel math is already covered by lib/aspects.js unit tests).
test('calculate_synastry: declination_aspects uses person1_planet/person2_planet naming and is gated by the flag', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutFlag = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime, person1_latitude: DAY_CHART.latitude, person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime, person2_latitude: PARTNER_CHART.latitude, person2_longitude: PARTNER_CHART.longitude,
  });
  assert.equal(withoutFlag.declination_aspects, undefined);

  const withFlag = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime, person1_latitude: DAY_CHART.latitude, person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime, person2_latitude: PARTNER_CHART.latitude, person2_longitude: PARTNER_CHART.longitude,
    include_declination_aspects: true,
  });
  assert.ok(Array.isArray(withFlag.declination_aspects));
  assert.ok(withFlag.declination_aspects.length > 0);

  // Independent oracle: recompute the tightest pair directly from each chart's own verified
  // declination values (person1 Jupiter, person2 Venus), without reusing lib/aspects.js math.
  const positions1 = await server.handleToolCall('calculate_planetary_positions', chartInput(DAY_CHART));
  const positions2 = await server.handleToolCall('calculate_planetary_positions', chartInput(PARTNER_CHART));
  const expectedOrb = Math.abs(positions1.planets.Jupiter.declination - positions2.planets.Venus.declination);

  const jupiterVenus = withFlag.declination_aspects.find(
    (r) => r.person1_planet === 'Jupiter' && r.person2_planet === 'Venus'
  );
  assert.ok(jupiterVenus, 'Jupiter (person1) - Venus (person2) parallel should be present');
  assert.equal(jupiterVenus.aspect, 'parallel');
  assert.ok(Math.abs(jupiterVenus.orb - expectedOrb) < 1e-6);
  assert.equal(jupiterVenus.applying, null);

  for (const row of withFlag.declination_aspects) {
    assert.notEqual(row.person1_planet, 'North Node');
    assert.notEqual(row.person2_planet, 'North Node');
    assert.equal(row.category, undefined, 'declination_aspects rows have no category field');
    assert.equal(row.exact_angle, undefined, 'declination_aspects rows have no exact_angle field');
  }
});

test('calculate_synastry: declination_aspects respects a custom `bodies` list, still excluding the Node', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime, person1_latitude: DAY_CHART.latitude, person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime, person2_latitude: PARTNER_CHART.latitude, person2_longitude: PARTNER_CHART.longitude,
    include_declination_aspects: true,
    bodies: ['Sun', 'Moon', 'North Node'],
  });
  const names = new Set(result.declination_aspects.flatMap((r) => [r.person1_planet, r.person2_planet]));
  assert.ok(!names.has('North Node'));
  for (const n of names) {
    assert.ok(['Sun', 'Moon'].includes(n));
  }
});
