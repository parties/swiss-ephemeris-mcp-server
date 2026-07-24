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

  const anglePoints = new Set(['Ascendant', 'Midheaven', 'IC', 'Descendant']);
  const hasAngleInvolved = result.angle_aspects.every(
    (a) => anglePoints.has(a.person1_point) || anglePoints.has(a.person2_point)
  );
  assert.ok(hasAngleInvolved, 'every angle_aspects entry should involve at least one angle point');

  for (let i = 1; i < result.angle_aspects.length; i++) {
    assert.ok(Number(result.angle_aspects[i - 1].orb) <= Number(result.angle_aspects[i].orb));
  }
});
