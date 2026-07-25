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

test('Part of Fortune uses the day formula (ASC + Moon - Sun) when the Sun is above the horizon (houses 7-12)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  // Synthetic day chart (Greenwich, noon).
  const result = await server.handleToolCall('calculate_planetary_positions', {
    datetime: '1990-01-01T12:00:00Z', latitude: 51.4769, longitude: 0.0,
  });
  const sunHouse = Object.entries(result.houses).find(([, h]) => h.longitude === result.houses['11'].longitude)[0];
  assert.equal(sunHouse, '11');

  const asc = result.chart_points.Ascendant.longitude;
  const sun = result.planets.Sun.longitude;
  const moon = result.planets.Moon.longitude;
  const expected = (((asc + moon - sun) % 360) + 360) % 360;
  assert.ok(Math.abs(result.additional_points['Part of Fortune'].longitude - expected) < 1e-6);
});

test('Part of Fortune uses the night formula (ASC + Sun - Moon) when the Sun is below the horizon (houses 1-6)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  // Synthetic night chart (Greenwich, midnight).
  const result = await server.handleToolCall('calculate_planetary_positions', {
    datetime: '1990-01-01T00:00:00Z', latitude: 51.4769, longitude: 0.0,
  });

  const asc = result.chart_points.Ascendant.longitude;
  const sun = result.planets.Sun.longitude;
  const moon = result.planets.Moon.longitude;
  const dayFormula = (((asc + moon - sun) % 360) + 360) % 360;
  const nightFormula = (((asc + sun - moon) % 360) + 360) % 360;

  const actual = result.additional_points['Part of Fortune'].longitude;
  assert.ok(Math.abs(actual - nightFormula) < 1e-6, 'should match the night formula');
  assert.ok(Math.abs(actual - dayFormula) > 1, 'should NOT match the day formula');

  // Cross-check against the known-correct value transcribed in charts/people/<name>.md (15deg07m Taurus).
  assert.equal(result.additional_points['Part of Fortune'].sign, 'Taurus');
  assert.ok(Math.abs(result.additional_points['Part of Fortune'].degree - 15.11) < 0.05);
});
