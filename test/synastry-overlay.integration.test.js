import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { ASPECTABLE_ANGLES, resolveChartPoint } from '../lib/aspects.js';
import { DAY_CHART, PARTNER_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const PERSON1 = { person1_datetime: '1985-04-12T23:20:50Z', person1_latitude: 40.7128, person1_longitude: -74.006 };
const PERSON2 = { person2_datetime: '1990-08-25T14:30:00Z', person2_latitude: 34.0522, person2_longitude: -118.2437 };

test('calculate_synastry always returns a house_overlay for both directions', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', { ...PERSON1, ...PERSON2 });

  assert.ok(result.house_overlay);
  for (const planet of ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto']) {
    const p1House = result.house_overlay.person1_planets_in_person2_houses[planet];
    const p2House = result.house_overlay.person2_planets_in_person1_houses[planet];
    assert.ok(Number.isInteger(p1House) && p1House >= 1 && p1House <= 12, `person1 ${planet} should land in a 1-12 house`);
    assert.ok(Number.isInteger(p2House) && p2House >= 1 && p2House <= 12, `person2 ${planet} should land in a 1-12 house`);
  }
});

test('calculate_synastry omits angle_aspects when include_angles is not set', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', { ...PERSON1, ...PERSON2 });
  assert.equal(result.angle_aspects, undefined);
});

test('calculate_synastry include_angles surfaces planet-to-angle and angle-to-angle aspects', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', { ...PERSON1, ...PERSON2, include_angles: true });

  assert.ok(Array.isArray(result.angle_aspects));
  assert.ok(result.angle_aspects.length > 0, 'expect at least one angle contact across major aspects for this pair');

  // Derived from the constant, so adding a body to ASPECTABLE_ANGLES cannot leave this set stale.
  const anglePoints = new Set(ASPECTABLE_ANGLES);
  const hasAngleInvolved = result.angle_aspects.every(
    (a) => anglePoints.has(a.person1_point) || anglePoints.has(a.person2_point)
  );
  assert.ok(hasAngleInvolved, 'every angle_aspects entry should involve at least one angle point');

  // DSC/IC mirror ASC/MC and are never aspected - only ASC/MC/PoF are aspectable.
  const nonAspectableAngles = new Set(['IC', 'Descendant']);
  assert.ok(
    !result.angle_aspects.some((a) => nonAspectableAngles.has(a.person1_point) || nonAspectableAngles.has(a.person2_point)),
    'DSC/IC should never appear in angle_aspects'
  );

  for (let i = 1; i < result.angle_aspects.length; i++) {
    assert.ok(Number(result.angle_aspects[i - 1].orb) <= Number(result.angle_aspects[i].orb));
  }
});

// Part of Fortune lives in additional_points, not chart_points; a lookup against the wrong
// bucket dropped it from every angle_aspects response without warning.
test('calculate_synastry include_angles aspects Part of Fortune', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime,
    person1_latitude: DAY_CHART.latitude,
    person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime,
    person2_latitude: PARTNER_CHART.latitude,
    person2_longitude: PARTNER_CHART.longitude,
    include_angles: true,
  });

  const fortuneRows = result.angle_aspects.filter(
    (a) => a.person1_point === 'Part of Fortune' || a.person2_point === 'Part of Fortune'
  );
  assert.ok(fortuneRows.length > 0, 'expect at least one Part of Fortune contact for this pair');

  // Both directions: person1 Fortune -> person2 planets, and person2 Fortune -> person1 points.
  assert.ok(fortuneRows.some((a) => a.person1_point === 'Part of Fortune'), 'expect person1 Fortune contacts');
  assert.ok(fortuneRows.some((a) => a.person2_point === 'Part of Fortune'), 'expect person2 Fortune contacts');

  // P1 Fortune sextile P2 Neptune — 0.88° orb, well inside the derived class's 2-deg sextile.
  const neptuneSextile = fortuneRows.find(
    (a) => a.person1_point === 'Neptune' && a.person2_point === 'Part of Fortune' && a.aspect === 'sextile'
  );
  assert.ok(neptuneSextile, 'expect P1 Neptune sextile P2 Fortune');
  assert.equal(neptuneSextile.orb, '0.88');
});

// SUP-168: Part of Fortune and Vertex belong to the `derived` orb class - 3 deg conjunction/
// opposition, 2 deg square/trine/sextile - tighter than a swetest body's defaults and tighter
// than the `angle` class (ASC/MC/IC/DSC). A body-class partner can never widen that orb: the
// pair is held to whichever side is stricter. This is the exact fixture pair from SUP-156 that
// motivated the tighter class; the 2.38-deg Fortune-Mars square is the SUP-168 boundary delta -
// it survived under the old point class's 3-deg square but now drops under derived's 2-deg.
test('calculate_synastry include_angles: derived-class orb drops wide Fortune contacts and keeps tight ones', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime,
    person1_latitude: DAY_CHART.latitude,
    person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime,
    person2_latitude: PARTNER_CHART.latitude,
    person2_longitude: PARTNER_CHART.longitude,
    include_angles: true,
    orb_model: 'class',
  });

  const fortuneRows = result.angle_aspects.filter(
    (a) => a.person1_point === 'Part of Fortune' || a.person2_point === 'Part of Fortune'
  );

  // Sub-2-deg Fortune contacts survive at the derived class's default.
  assert.ok(
    fortuneRows.some((a) => a.person1_point === 'Part of Fortune' && a.person2_point === 'Moon' && a.aspect === 'square' && a.orb === '1.58'),
    'P1 Fortune square P2 Moon (1.58 deg) should survive'
  );
  assert.ok(
    fortuneRows.some((a) => a.person1_point === 'Part of Fortune' && a.person2_point === 'Mercury' && a.aspect === 'conjunction' && a.orb === '2.69'),
    'P1 Fortune conjunction P2 Mercury (2.69 deg) is within derived conjunction 3-deg and should survive'
  );

  // P1 Fortune square P2 Mars (2.38 deg) survived under the old point class's 3-deg square but
  // now exceeds derived's 2-deg square - the exact SUP-168 boundary delta.
  assert.ok(
    !fortuneRows.some((a) => a.person1_point === 'Part of Fortune' && a.person2_point === 'Mars' && a.aspect === 'square'),
    'P1 Fortune square P2 Mars (2.38 deg) exceeds the derived class 2-deg square and should drop'
  );

  // P1 IC trine P2 Fortune is NOT in this list - IC mirrors MC and is never aspected (SUP-159).
  assert.ok(
    !fortuneRows.some((a) => a.person1_point === 'IC' || a.person2_point === 'IC'),
    'IC should never appear in a Fortune contact - only ASC/MC/PoF are aspectable angles'
  );

  // Wide Fortune contacts that used to pass under the body-class 8/6-deg defaults still drop.
  assert.ok(
    !fortuneRows.some((a) => a.person1_point === 'Pluto' && a.person2_point === 'Part of Fortune' && a.aspect === 'trine'),
    'Pluto trine PoF (4.18 deg) exceeds the derived class 2-deg trine orb and should drop'
  );
  assert.ok(
    !fortuneRows.some((a) => a.person1_point === 'Jupiter' && a.person2_point === 'Part of Fortune' && a.aspect === 'trine'),
    'Jupiter trine PoF (7.77 deg) exceeds the derived class 2-deg trine orb and should drop'
  );
  assert.ok(
    !fortuneRows.some((a) => a.person1_point === 'Part of Fortune' && a.person2_point === 'Saturn' && a.aspect === 'square'),
    'PoF square Saturn (7.10 deg) exceeds the derived class 2-deg square orb and should drop'
  );

  // SUP-263: the angle-aspect planet side now defaults to the full 17-body list instead of the
  // 10 traditional planets, so Chiron/Juno/Lilith can newly contact Fortune for this fixture pair.
  assert.ok(
    fortuneRows.some((a) => a.person1_point === 'Chiron' && a.person2_point === 'Part of Fortune' && a.aspect === 'trine' && a.orb === '0.90'),
    'P1 Chiron trine P2 Fortune (0.90 deg) is newly in scope under the wider default body list and should survive'
  );
  assert.ok(
    fortuneRows.some((a) => a.person1_point === 'Juno' && a.person2_point === 'Part of Fortune' && a.aspect === 'trine' && a.orb === '1.07'),
    'P1 Juno trine P2 Fortune (1.07 deg) is newly in scope under the wider default body list and should survive'
  );
  assert.ok(
    fortuneRows.some((a) => a.person1_point === 'Part of Fortune' && a.person2_point === 'Lilith' && a.aspect === 'conjunction' && a.orb === '2.62'),
    'P1 Fortune conjunction P2 Lilith (2.62 deg) is newly in scope under the wider default body list and should survive'
  );

  assert.equal(fortuneRows.length, 6, 'six Fortune contacts survive the tighter derived-class orb for this fixture pair under the SUP-263 17-body default (IC excluded, SUP-159)');
});

const SYNASTRY_INPUT = {
  person1_datetime: DAY_CHART.datetime,
  person1_latitude: DAY_CHART.latitude,
  person1_longitude: DAY_CHART.longitude,
  person2_datetime: PARTNER_CHART.datetime,
  person2_latitude: PARTNER_CHART.latitude,
  person2_longitude: PARTNER_CHART.longitude,
};

const TEN_TRADITIONAL_PLANETS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

// SUP-263: calculate_synastry cross-aspected only the 10 traditional planets with no way to
// widen or narrow the list. It now defaults to the same DEFAULT_ASPECT_BODIES 17-body list as
// calculate_aspects/calculate_transits, with a `bodies` override, mirroring resolveAspectBodies's
// validation but scoped to DEFAULT_ASPECT_BODIES only (no angles/South Node here).
test('calculate_synastry default bodies cross-aspects beyond the 10 traditional planets', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', SYNASTRY_INPUT);

  const tenPlanets = new Set(TEN_TRADITIONAL_PLANETS);
  const involvesWiderBody = result.synastry_aspects.some(
    (a) => !tenPlanets.has(a.person1_planet) || !tenPlanets.has(a.person2_planet)
  );
  assert.ok(involvesWiderBody, 'expect at least one synastry aspect involving a body outside the 10 traditional planets');
});

test('calculate_synastry bodies override restricts the grid to just those bodies', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', { ...SYNASTRY_INPUT, bodies: ['Sun', 'Moon'] });

  assert.ok(result.synastry_aspects.length > 0, 'expect at least one Sun/Moon aspect for this fixture pair');
  assert.ok(
    result.synastry_aspects.every((a) => ['Sun', 'Moon'].includes(a.person1_planet) && ['Sun', 'Moon'].includes(a.person2_planet)),
    'every synastry aspect should be limited to Sun/Moon when bodies is restricted'
  );
});

test('calculate_synastry unknown body in bodies param throws InvalidParams', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_synastry', { ...SYNASTRY_INPUT, bodies: ['NotARealBody'] }),
    /Unknown body/
  );
});

// Regression guard: house_overlay must stay on the 10 traditional planets regardless of the
// `bodies` override - overlaying 17 bodies into 12 houses is noisier and was intentionally
// excluded from this param (SUP-150/SUP-263).
test('calculate_synastry house_overlay stays the 10 traditional planets even when bodies is overridden', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', { ...SYNASTRY_INPUT, bodies: ['Sun', 'Juno'] });

  assert.deepEqual(
    Object.keys(result.house_overlay.person1_planets_in_person2_houses).sort(),
    [...TEN_TRADITIONAL_PLANETS].sort()
  );
  assert.deepEqual(
    Object.keys(result.house_overlay.person2_planets_in_person1_houses).sort(),
    [...TEN_TRADITIONAL_PLANETS].sort()
  );
});

// SUP-265: angle_aspects rows previously carried only person1_point/person2_point (names),
// with no resolved longitude/sign/degree - unlike synastry_aspects, which always has both
// positions. Every row's position should byte-match the point as it appears in the
// returned person1_chart/person2_chart, however that point is bucketed internally.
test('calculate_synastry include_angles: angle_aspects rows carry person1_position/person2_position', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime,
    person1_latitude: DAY_CHART.latitude,
    person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime,
    person2_latitude: PARTNER_CHART.latitude,
    person2_longitude: PARTNER_CHART.longitude,
    include_angles: true,
  });

  assert.ok(result.angle_aspects.length > 0, 'expect at least one angle contact for this pair');

  for (const row of result.angle_aspects) {
    const expectedP1 = resolveChartPoint(result.person1_chart, row.person1_point);
    const expectedP2 = resolveChartPoint(result.person2_chart, row.person2_point);
    assert.deepEqual(
      row.person1_position,
      { longitude: expectedP1.longitude, sign: expectedP1.sign, degree: expectedP1.degree },
      `person1_position should match the resolved ${row.person1_point} point`
    );
    assert.deepEqual(
      row.person2_position,
      { longitude: expectedP2.longitude, sign: expectedP2.sign, degree: expectedP2.degree },
      `person2_position should match the resolved ${row.person2_point} point`
    );
  }

  const fortuneRow = result.angle_aspects.find(
    (a) => a.person1_point === 'Part of Fortune' || a.person2_point === 'Part of Fortune'
  );
  assert.ok(fortuneRow, 'expect at least one Part of Fortune contact for this pair');
  const fortunePosition = fortuneRow.person1_point === 'Part of Fortune'
    ? fortuneRow.person1_position
    : fortuneRow.person2_position;
  assert.equal(typeof fortunePosition.sign, 'string');
  assert.ok(Number.isFinite(fortunePosition.degree));
});

// SUP-265: house_overlay previously only ever carried the 10 SYNASTRY_BODIES planets, so
// Part of Fortune / Ascendant / Midheaven house placement was unreachable from synastry
// output even though every one of those points is already computed on both charts.
test('calculate_synastry house_overlay covers Part of Fortune, Ascendant, Midheaven in both directions and excludes Descendant/IC', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime,
    person1_latitude: DAY_CHART.latitude,
    person1_longitude: DAY_CHART.longitude,
    person2_datetime: PARTNER_CHART.datetime,
    person2_latitude: PARTNER_CHART.latitude,
    person2_longitude: PARTNER_CHART.longitude,
  });

  const overlayBodies = [
    'Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
    'Ascendant', 'Midheaven', 'Part of Fortune',
  ];

  for (const direction of ['person1_planets_in_person2_houses', 'person2_planets_in_person1_houses']) {
    for (const body of overlayBodies) {
      const house = result.house_overlay[direction][body];
      assert.ok(Number.isInteger(house) && house >= 1 && house <= 12, `${direction}.${body} should land in a 1-12 house`);
    }
    for (const excluded of ['Descendant', 'IC']) {
      assert.equal(result.house_overlay[direction][excluded], undefined, `${direction} should not include ${excluded}`);
    }
  }
});
