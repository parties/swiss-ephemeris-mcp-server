import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { ANGLE_BODIES } from '../lib/aspects.js';
import { DAY_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const BIRTH_INPUT = { birth_datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };
const MAJOR_BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

test('calculate_transits returns transit_aspects sorted by orb ascending', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...BIRTH_INPUT, bodies: MAJOR_BODIES });

  assert.ok(Array.isArray(result.transit_aspects));
  for (let i = 1; i < result.transit_aspects.length; i++) {
    assert.ok(Number(result.transit_aspects[i - 1].orb) <= Number(result.transit_aspects[i].orb));
  }
});

test('calculate_transits transit_aspects entries use transiting_body/natal_body naming', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...BIRTH_INPUT, bodies: MAJOR_BODIES });

  assert.ok(result.transit_aspects.length > 0, 'expect at least one major transit aspect for this natal chart');
  for (const a of result.transit_aspects) {
    assert.ok(MAJOR_BODIES.includes(a.transiting_body));
    assert.ok(MAJOR_BODIES.includes(a.natal_body));
    assert.ok(typeof a.aspect === 'string');
  }
});

test('calculate_transits include_minor toggles minor aspects in transit_aspects', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutMinor = await server.handleToolCall('calculate_transits', { ...BIRTH_INPUT, bodies: MAJOR_BODIES });
  const withMinor = await server.handleToolCall('calculate_transits', { ...BIRTH_INPUT, bodies: MAJOR_BODIES, include_minor: true });

  assert.ok(!withoutMinor.transit_aspects.some((a) => a.category === 'minor'));
  assert.equal(withMinor.settings_used.include_minor_aspects, true);
});

test('calculate_transits rejects a malformed orb_overrides value', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_transits', { ...BIRTH_INPUT, orb_overrides: 'nope' }),
    /orb_overrides must be an object/
  );
});

const DAY_CHART_INPUT = { birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude };

test('calculate_transits include_angles excludes transiting angles from transit_aspects', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...DAY_CHART_INPUT, include_angles: true });

  assert.ok(!result.transit_aspects.some((a) => ANGLE_BODIES.includes(a.transiting_body)));
});

test('calculate_transits include_angles still includes natal angles in transit_aspects', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...DAY_CHART_INPUT, include_angles: true });

  assert.ok(result.transit_aspects.some((a) => ANGLE_BODIES.includes(a.natal_body)));
});

test('calculate_transits excludes transiting Ascendant even when explicitly requested via bodies', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...DAY_CHART_INPUT, bodies: ['Sun', 'Ascendant'] });

  assert.ok(!result.transit_aspects.some((a) => a.transiting_body === 'Ascendant'));
});

// SUP-224: resolveAspectBodies gates include_angles/include_south_node identically for the
// natal path (calculate_aspects) and the cross-chart path (calculate_transits), including when
// an explicit `bodies` array is passed - previously the explicit array bypassed the flags on
// the cross-chart path only. Both must yield zero Ascendant/South Node rows here.
test('calculate_aspects and calculate_transits agree on in-scope bodies for identical include_angles:false/include_south_node:false + explicit bodies', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const explicitBodies = ['Sun', 'Ascendant', 'South Node'];

  const aspectsResult = await server.handleToolCall('calculate_aspects', {
    datetime: DAY_CHART.datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
    include_angles: false,
    include_south_node: false,
    bodies: explicitBodies,
  });
  const transitsResult = await server.handleToolCall('calculate_transits', {
    ...DAY_CHART_INPUT,
    include_angles: false,
    include_south_node: false,
    bodies: explicitBodies,
  });

  const gatedNames = new Set(['Ascendant', 'South Node']);

  assert.equal(
    aspectsResult.aspects.filter((a) => gatedNames.has(a.body_a) || gatedNames.has(a.body_b)).length,
    0,
    'calculate_aspects should yield 0 Ascendant/South Node rows'
  );
  assert.equal(
    transitsResult.transit_aspects.filter(
      (a) => gatedNames.has(a.transiting_body) || gatedNames.has(a.natal_body)
    ).length,
    0,
    'calculate_transits should yield 0 Ascendant/South Node rows'
  );
});
