import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, NODE_DIVERGENCE_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const REFERENCE_INPUT = { datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude };
const DIVERGENCE_INPUT = {
  datetime: NODE_DIVERGENCE_CHART.datetime,
  latitude: NODE_DIVERGENCE_CHART.latitude,
  longitude: NODE_DIVERGENCE_CHART.longitude,
};

// calculate_synastry/calculate_solar_revolution stamp calculation_time with new Date() -
// strip it before comparing two calls made moments apart.
function withoutCalculationTime({ calculation_time, ...rest }) {
  return rest;
}

test('node_type defaults to "true" and matches the pre-existing (undocumented) default', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);
  assert.equal(result.node_type, 'true');
  assert.equal(result.planets['North Node'].longitude, DAY_CHART.expected.trueNodeLongitude);
});

test('calculateEphemeris output is identical whether node_type is omitted or explicitly "true"', { skip: !HAS_SWETEST }, () => {
  const server = new SwissEphemerisServer();
  const omitted = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude, 'P');
  const explicit = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude, 'P', 'true');
  assert.deepEqual(omitted, explicit);
});

test('calculate_planetary_positions output is identical whether node_type is omitted or explicitly "true"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const omitted = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);
  const explicit = await server.handleToolCall('calculate_planetary_positions', { ...REFERENCE_INPUT, node_type: 'true' });
  assert.deepEqual(omitted, explicit);
});

test('calculate_aspects output is identical whether node_type is omitted or explicitly "true"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const omitted = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  const explicit = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, node_type: 'true' });
  assert.deepEqual(omitted, explicit);
});

test('calculate_solar_revolution output is identical whether node_type is omitted or explicitly "true"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { birth_datetime: REFERENCE_INPUT.datetime, birth_latitude: REFERENCE_INPUT.latitude, birth_longitude: REFERENCE_INPUT.longitude, return_year: 2000 };
  const omitted = await server.handleToolCall('calculate_solar_revolution', input);
  const explicit = await server.handleToolCall('calculate_solar_revolution', { ...input, node_type: 'true' });
  assert.deepEqual(withoutCalculationTime(omitted), withoutCalculationTime(explicit));
});

test('calculate_synastry output is identical whether node_type is omitted or explicitly "true"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = {
    person1_datetime: DAY_CHART.datetime,
    person1_latitude: DAY_CHART.latitude,
    person1_longitude: DAY_CHART.longitude,
    person2_datetime: '1995-07-04T00:00:00Z',
    person2_latitude: 40.7128,
    person2_longitude: -74.006,
  };
  const omitted = await server.handleToolCall('calculate_synastry', input);
  const explicit = await server.handleToolCall('calculate_synastry', { ...input, node_type: 'true' });
  assert.deepEqual(withoutCalculationTime(omitted), withoutCalculationTime(explicit));
});

test('node_type: "mean" returns a Node longitude roughly 1.7deg from "true" (2026 date)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const trueResult = await server.handleToolCall('calculate_planetary_positions', { ...DIVERGENCE_INPUT, node_type: 'true' });
  const meanResult = await server.handleToolCall('calculate_planetary_positions', { ...DIVERGENCE_INPUT, node_type: 'mean' });

  assert.equal(trueResult.node_type, 'true');
  assert.equal(meanResult.node_type, 'mean');
  assert.equal(trueResult.planets['North Node'].longitude, NODE_DIVERGENCE_CHART.expected.trueNodeLongitude);
  assert.equal(meanResult.planets['North Node'].longitude, NODE_DIVERGENCE_CHART.expected.meanNodeLongitude);

  const diff = Math.abs(meanResult.planets['North Node'].longitude - trueResult.planets['North Node'].longitude);
  assert.ok(diff > 1 && diff < 2, `expected true/mean Node to differ by roughly 1.7deg, got ${diff}`);
});

test('South Node follows the North Node node_type - true and mean differ by the same amount', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const trueResult = await server.handleToolCall('calculate_planetary_positions', { ...DIVERGENCE_INPUT, node_type: 'true' });
  const meanResult = await server.handleToolCall('calculate_planetary_positions', { ...DIVERGENCE_INPUT, node_type: 'mean' });

  const trueSouth = trueResult.additional_points['South Node'].longitude;
  const meanSouth = meanResult.additional_points['South Node'].longitude;
  assert.notEqual(trueSouth, meanSouth);
});

test('unknown node_type is rejected', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_planetary_positions', { ...REFERENCE_INPUT, node_type: 'osculating' }),
    /node_type must be one of/
  );
});

test('calculate_aspects settings_used.node_type reflects what was actually used', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', { ...DIVERGENCE_INPUT, node_type: 'mean' });
  assert.equal(result.settings_used.node_type, 'mean');
});

test('calculate_transits settings_used.node_type reflects what was actually used, applied to both natal and current charts', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', {
    birth_datetime: DAY_CHART.datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
    node_type: 'mean',
  });
  assert.equal(result.settings_used.node_type, 'mean');
  assert.equal(result.natal_chart.node_type, 'mean');
  assert.equal(result.current_transits.node_type, 'mean');
});

test('calculate_synastry takes a single node_type for both charts, not one per person', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: DAY_CHART.datetime,
    person1_latitude: DAY_CHART.latitude,
    person1_longitude: DAY_CHART.longitude,
    person2_datetime: '1995-07-04T00:00:00Z',
    person2_latitude: 40.7128,
    person2_longitude: -74.006,
    node_type: 'mean',
  });
  assert.equal(result.person1_chart.node_type, 'mean');
  assert.equal(result.person2_chart.node_type, 'mean');
});

test('calculate_solar_revolution applies node_type to both the natal and solar return charts', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_solar_revolution', {
    birth_datetime: DAY_CHART.datetime,
    birth_latitude: DAY_CHART.latitude,
    birth_longitude: DAY_CHART.longitude,
    return_year: 2000,
    node_type: 'mean',
  });
  assert.equal(result.natal_chart.node_type, 'mean');
  assert.equal(result.solar_return_chart.node_type, 'mean');
});
