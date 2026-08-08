import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, SOUTHERN_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

async function positionsFor(fixture) {
  const server = new SwissEphemerisServer();
  return server.handleToolCall('calculate_planetary_positions', {
    datetime: fixture.datetime,
    latitude: fixture.latitude,
    longitude: fixture.longitude,
  });
}

// §4.3 - out-of-bounds
test('DAY_CHART: obliquity matches the verified true value', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  assert.ok(Math.abs(result.obliquity - DAY_CHART.expected.obliquity) < 1e-6);
  assert.equal(result.obliquity_type, 'true');
});

test('DAY_CHART: Ceres is out of bounds by the verified amount', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  const ceres = result.planets.Ceres;
  assert.equal(ceres.out_of_bounds, true);
  assert.ok(Math.abs(ceres.declination - 26.4572512) < 1e-4);
  assert.ok(Math.abs(ceres.out_of_bounds_by - 3.0148851) < 1e-4);
});

// Tighter than Ceres: 8'36" past the boundary, so a wrong obliquity source (mean vs true,
// 6.43" apart on this chart) would still pass, while a hardcoded boundary would misreport
// out_of_bounds_by by 32" - see docs/SUP-345-declination-layer-spec.md §4.3.
test('DAY_CHART: Uranus is out of bounds by the verified amount (tighter than Ceres)', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  const uranus = result.planets.Uranus;
  assert.equal(uranus.out_of_bounds, true);
  assert.ok(Math.abs(uranus.declination - -23.5857206) < 1e-4);
  assert.ok(Math.abs(uranus.out_of_bounds_by - 0.1433545) < 1e-4);
});

test('DAY_CHART: every body other than Uranus/Ceres is in bounds', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  const oobNames = DAY_CHART.expected.outOfBounds;
  for (const [name, planet] of Object.entries(result.planets)) {
    if (oobNames.includes(name)) continue;
    assert.equal(planet.out_of_bounds, false, `${name} should be in bounds`);
    assert.equal(planet.out_of_bounds_by, null, `${name} should have out_of_bounds_by: null`);
  }
});

test('North Node is never out of bounds and carries zero ecliptic latitude', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  const node = result.planets['North Node'];
  assert.equal(node.ecliptic_latitude, 0);
  assert.equal(node.out_of_bounds, false);
  assert.equal(node.out_of_bounds_by, null);
});

test('transiting Moon can be out of bounds', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor({ datetime: '1990-01-09T12:00:00Z', latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude });
  const moon = result.planets.Moon;
  assert.equal(moon.out_of_bounds, true);
  assert.ok(Math.abs(moon.declination - 27.4015972) < 1e-4);
  assert.ok(Math.abs(moon.out_of_bounds_by - 3.9592824) < 1e-4);
});

// Regression test for the Sun suppression (§Q4): at this solstice moment the Sun's apparent
// declination exceeds true obliquity by a fraction of an arcsecond, which would flag the Sun
// out of bounds under a naive |declination| > obliquity test. The Sun defines the bound and
// must never be reported as having left it.
test('Sun is never out of bounds, even at a solstice where its apparent declination exceeds true obliquity', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor({ datetime: '1990-06-21T12:00:00Z', latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude });
  const sun = result.planets.Sun;
  assert.ok(Math.abs(sun.declination) > result.obliquity, 'fixture assumes the naive test would flag the Sun');
  assert.equal(sun.out_of_bounds, false);
  assert.equal(sun.out_of_bounds_by, null);
});

// §4.4 - the structural identity test: for every latitude-0 point, declination is fully
// determined by longitude. This is what catches the §1.1 column-order trap directly.
test('DAY_CHART: declination == arcsin(sin(obliquity) * sin(longitude)) for every latitude-0 point', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  const obliquityRad = toRad(result.obliquity);

  const points = [
    ...Object.entries(result.houses).map(([house, p]) => [`house ${house}`, p]),
    ['Ascendant', result.chart_points.Ascendant],
    ['Midheaven', result.chart_points.Midheaven],
    ['IC', result.chart_points.IC],
    ['Descendant', result.chart_points.Descendant],
    ['Vertex', result.chart_points.Vertex],
    ['North Node', result.planets['North Node']],
  ];

  for (const [name, point] of points) {
    assert.ok(point && point.declination !== undefined, `${name} should carry a declination`);
    const expected = toDeg(Math.asin(Math.sin(obliquityRad) * Math.sin(toRad(point.longitude))));
    assert.ok(
      Math.abs(point.declination - expected) < 0.001 / 3600,
      `${name}: declination ${point.declination} should equal arcsin(sin ε · sin λ) = ${expected}`
    );
  }
});

test('ARMC has no declination field - its column is a meaningless right-ascension artifact', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  assert.equal(result.chart_points.ARMC.declination, undefined);
});

// §4.5 - sign probe: any latitude/declination column swap, or a sign-map fallthrough, moves
// these numbers by degrees.
test('SOUTHERN_CHART: sign probe values match the verified figures', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(SOUTHERN_CHART);
  assert.ok(Math.abs(result.obliquity - SOUTHERN_CHART.expected.obliquity) < 1e-6);

  const sunDeclination = -(0 + 1 / 60 + 33.83 / 3600);
  assert.ok(Math.abs(result.planets.Sun.declination - sunDeclination) < 1e-3);

  const pallas = result.planets.Pallas;
  const pallasLatitude = -(26 + 42 / 60 + 40 / 3600);
  const pallasDeclination = -(5 + 52 / 60 + 21 / 3600);
  assert.ok(Math.abs(pallas.ecliptic_latitude - pallasLatitude) < 1e-3);
  assert.ok(Math.abs(pallas.declination - pallasDeclination) < 1e-3);
});

// §4.7 - regression guard for trap §1.2: the cusp rotation-rate column must never reach
// `speed`, or every ASC/MC/Vertex aspect would silently acquire a bogus applying flag.
test('chart_points never carry a speed field', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  assert.equal(result.chart_points.Ascendant.speed, undefined);
  assert.equal(result.chart_points.Midheaven.speed, undefined);
  assert.equal(result.chart_points.Vertex.speed, undefined);
  for (const house of Object.values(result.houses)) {
    assert.equal(house.speed, undefined);
  }
});

test('§4.7: ASC/MC aspects still resolve applying: null with the new house format string', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    datetime: DAY_CHART.datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
    include_angles: true,
  });
  const angleAspects = result.aspects.filter((a) => a.body_a === 'Ascendant' || a.body_b === 'Ascendant' || a.body_a === 'Midheaven' || a.body_b === 'Midheaven');
  assert.ok(angleAspects.length > 0, 'fixture should produce at least one ASC/MC aspect');
  for (const aspect of angleAspects) {
    assert.equal(aspect.applying, null);
  }
});
