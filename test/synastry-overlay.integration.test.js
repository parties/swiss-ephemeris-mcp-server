import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SwissEphemerisServer } from '../index.js';
import { ANGLE_BODIES } from '../lib/aspects.js';
import { DAY_CHART, PARTNER_CHART } from './fixtures/charts.js';

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

  // Derived from the constant, so adding a body to ANGLE_BODIES cannot leave this set stale.
  const anglePoints = new Set(ANGLE_BODIES);
  const hasAngleInvolved = result.angle_aspects.every(
    (a) => anglePoints.has(a.person1_point) || anglePoints.has(a.person2_point)
  );
  assert.ok(hasAngleInvolved, 'every angle_aspects entry should involve at least one angle point');

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

  // P2 Fortune (342.917) sextile P1 Sun (280.82) — 2.10° orb.
  const sunSextile = fortuneRows.find(
    (a) => a.person2_point === 'Part of Fortune' && a.person1_point === 'Sun' && a.aspect === 'sextile'
  );
  assert.ok(sunSextile, 'expect P2 Fortune sextile P1 Sun');
  assert.equal(sunSextile.orb, '2.10');
});
