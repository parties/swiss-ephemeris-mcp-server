import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const REFERENCE_INPUT = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };

test('house_system defaults to Placidus when omitted', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);
  assert.equal(result.house_system, 'P');
});

test('house_system W (whole sign) puts every house cusp at a 0-degree boundary', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', { ...REFERENCE_INPUT, house_system: 'W' });
  assert.equal(result.house_system, 'W');
  for (let h = 1; h <= 12; h++) {
    assert.equal(result.houses[h].degree, 0, `house ${h} cusp should sit at 0 degrees under whole sign`);
  }
});

test('unknown house_system code is rejected', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_planetary_positions', { ...REFERENCE_INPUT, house_system: 'Q' }),
    /house_system must be one of/
  );
});

test('calculate_synastry accepts different house systems per person', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_synastry', {
    person1_datetime: '1985-04-12T23:20:50Z',
    person1_latitude: 40.7128,
    person1_longitude: -74.006,
    person1_house_system: 'W',
    person2_datetime: '1990-08-25T14:30:00Z',
    person2_latitude: 34.0522,
    person2_longitude: -118.2437,
    person2_house_system: 'P',
  });
  assert.equal(result.person1_chart.house_system, 'W');
  assert.equal(result.person2_chart.house_system, 'P');
});
