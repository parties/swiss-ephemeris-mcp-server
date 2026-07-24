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
