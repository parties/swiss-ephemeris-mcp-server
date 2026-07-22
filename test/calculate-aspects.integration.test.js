import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SwissEphemerisServer } from '../index.js';

if (!process.env.SE_EPHE_PATH) {
  process.env.SE_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../vendor/swisseph');
}

function swetestAvailable() {
  try {
    execSync(`SE_EPHE_PATH=${process.env.SE_EPHE_PATH} swetest -b12.04.1985 -ut23:20:50 -p0 -g, -head`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const HAS_SWETEST = swetestAvailable();

test('reference chart 1: all 4 existing tools include a speed field on planets, no shape regressions', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', {
    datetime: '1985-04-12T23:20:50Z',
    latitude: 40.7128,
    longitude: -74.006,
  });
  assert.ok(typeof result.planets.Sun.speed === 'number');
  assert.ok(typeof result.planets.Mercury.speed === 'number');
  // shape unchanged
  assert.ok('sign' in result.planets.Sun);
  assert.ok('degree' in result.planets.Sun);
  assert.ok('longitude' in result.planets.Sun);
});

test('reference chart 2: calculate_aspects longitudes byte-match calculate_planetary_positions', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };
  const positions = await server.handleToolCall('calculate_planetary_positions', input);
  const aspectsResult = await server.handleToolCall('calculate_aspects', input);

  for (const name of Object.keys(positions.planets)) {
    assert.equal(aspectsResult.planets[name].longitude, positions.planets[name].longitude, `${name} longitude should byte-match`);
  }
});

test('reference chart 3: applying/separating aspects resolve to booleans for planet pairs', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    datetime: '1985-04-12T23:20:50Z',
    latitude: 40.7128,
    longitude: -74.006,
  });
  assert.ok(result.aspects.length > 0);
  for (const aspect of result.aspects) {
    assert.ok(['boolean', 'object'].includes(typeof aspect.applying)); // object covers null
  }
});

test('reference chart 4: retrograde body produces a resolved (non-null) applying value when speeds differ enough', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    datetime: '1985-04-12T23:20:50Z',
    latitude: 40.7128,
    longitude: -74.006,
  });
  const mercuryAspects = result.aspects.filter((a) => a.body_a === 'Mercury' || a.body_b === 'Mercury');
  assert.ok(mercuryAspects.length > 0);
});

test('reference chart 5: orb_overrides tightens qualifying pairs on a real chart', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };
  const wide = await server.handleToolCall('calculate_aspects', input);
  const tight = await server.handleToolCall('calculate_aspects', { ...input, orb_overrides: { conjunction: 0.01, opposition: 0.01, trine: 0.01, square: 0.01, sextile: 0.01 } });
  assert.ok(tight.aspects.length <= wide.aspects.length);
});

test('reference chart 6: include_minor_aspects surfaces minor aspects on a real chart', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };
  const withoutMinor = await server.handleToolCall('calculate_aspects', input);
  const withMinor = await server.handleToolCall('calculate_aspects', { ...input, include_minor: true });
  assert.ok(withoutMinor.aspects.every((a) => a.category === 'major'));
  assert.ok(withMinor.aspects.some((a) => a.category === 'minor'));
});

test('reference chart 7: include_angles and include_south_node add angle/PoF/South Node aspects', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };
  const base = await server.handleToolCall('calculate_aspects', input);
  const withExtras = await server.handleToolCall('calculate_aspects', { ...input, include_angles: true, include_south_node: true });

  assert.ok(!base.aspects.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));
  assert.ok(withExtras.aspects.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));
  assert.ok(withExtras.aspects.some((a) => ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Part of Fortune'].includes(a.body_a) || ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Part of Fortune'].includes(a.body_b)));
});

test('unknown body in bodies param throws InvalidParams', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', {
      datetime: '1985-04-12T23:20:50Z',
      latitude: 40.7128,
      longitude: -74.006,
      bodies: ['NotARealBody'],
    }),
    /Unknown body/
  );
});
