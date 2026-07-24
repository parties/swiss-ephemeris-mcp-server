import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SwissEphemerisServer } from '../index.js';

const REAL_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../vendor/swisseph');

function swetestAvailable() {
  try {
    execSync(`SE_EPHE_PATH=${REAL_EPHE_PATH} swetest -b12.04.1985 -ut23:20:50 -p0 -g, -head`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const HAS_SWETEST = swetestAvailable();

const REFERENCE_INPUT = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };

test('calculate_planetary_positions resolves asteroid bodies (Chiron/Ceres/Pallas/Juno/Vesta) to real, non-zero positions', { skip: !HAS_SWETEST }, async () => {
  if (!process.env.SE_EPHE_PATH) process.env.SE_EPHE_PATH = REAL_EPHE_PATH;
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);

  for (const name of ['Chiron', 'Ceres', 'Pallas', 'Juno', 'Vesta']) {
    const body = result.planets[name];
    assert.ok(body, `${name} should be present in planets`);
    assert.ok(!(body.longitude === 0 && body.speed === 0), `${name} should not fall back to the 0deg/0speed placeholder`);
  }
  assert.equal(result.warnings, undefined, 'no warnings expected when ephemeris data files are all present');
});

test('calculate_planetary_positions omits bodies (with a warning) instead of reporting a fabricated 0deg position when their ephemeris file is missing', { skip: !HAS_SWETEST }, async () => {
  // Point SE_EPHE_PATH somewhere that has the main planet files (via Moshier fallback)
  // but is missing the asteroid file, to reproduce swetest's "found nothing, printed
  // placeholder zeros" behavior without needing to delete real vendor files.
  const brokenPath = '/nonexistent/swisseph/path/for/this/test';
  const originalPath = process.env.SE_EPHE_PATH;
  process.env.SE_EPHE_PATH = brokenPath;
  try {
    const server = new SwissEphemerisServer();
    const result = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);

    assert.equal(result.planets.Chiron, undefined, 'Chiron should be omitted, not fabricated at 0deg Aries');
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
    assert.ok(result.warnings.some((w) => w.includes('seas_18.se1')));
  } finally {
    if (originalPath === undefined) delete process.env.SE_EPHE_PATH;
    else process.env.SE_EPHE_PATH = originalPath;
  }
});
