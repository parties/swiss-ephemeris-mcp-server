import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SwissEphemerisServer } from '../index.js';
import { ANGLE_BODIES } from '../lib/aspects.js';
import { DAY_CHART, SOUTHERN_CHART } from './fixtures/charts.js';

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

// Angles and Part of Fortune describe a moment's location and time of day, not a moving body.
// The transiting Ascendant covers the whole zodiac each day, so a transit-side angle contact
// is a different contact minutes later - include_angles means the natal chart's angles only.
// A fixed transit_datetime (another fixture's, so still nobody's data) keeps this deterministic.
const TRANSIT_INPUT = {
  birth_datetime: DAY_CHART.datetime,
  latitude: DAY_CHART.latitude,
  longitude: DAY_CHART.longitude,
  transit_datetime: SOUTHERN_CHART.datetime,
};

test('calculate_transits never aspects a transiting angle', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...TRANSIT_INPUT, include_angles: true });

  const transitingAngles = result.transit_aspects.filter((a) => ANGLE_BODIES.includes(a.transiting_body));
  assert.deepEqual(transitingAngles, [], 'transiting angles should never appear as an aspecting body');
});

test('calculate_transits include_angles still aspects the natal angles', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_transits', { ...TRANSIT_INPUT, include_angles: true });

  // Without this, an over-broad filter would drop the natal side too and still satisfy the
  // test above. Part of Fortune is named explicitly because it resolves from a different
  // bucket than the four angles (#8).
  const natalAngles = new Set(result.transit_aspects.filter((a) => ANGLE_BODIES.includes(a.natal_body)).map((a) => a.natal_body));
  assert.ok(natalAngles.size > 0, 'expect transits to the natal angles when include_angles is true');
  assert.ok(natalAngles.has('Part of Fortune'), 'expect transits to the natal Part of Fortune');
});

test('calculate_transits keeps transiting angles out even when bodies names one', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  // An explicit bodies array bypasses the include_angles flag: that gating lives in
  // calculateNatalAspects, which the cross-chart engine never calls. So the transit side
  // has to be filtered by name, not by the flag.
  // Orbs wide enough that the five major targets (0/60/90/120/180 +/- 30) tile the whole
  // 0-180 range, so a transiting-Ascendant row is guaranteed if the body is in play at all.
  // Without that the test passes for the wrong reason whenever no contact happens to form.
  const WIDE = { conjunction: 30, sextile: 30, square: 30, trine: 30, opposition: 30 };
  const result = await server.handleToolCall('calculate_transits', {
    ...TRANSIT_INPUT,
    bodies: ['Sun', 'Ascendant'],
    orb_overrides: WIDE,
  });

  assert.ok(result.transit_aspects.length > 0, 'wide orbs should produce contacts to aspect at all');
  const transitingAscendant = result.transit_aspects.filter((a) => a.transiting_body === 'Ascendant');
  assert.deepEqual(transitingAscendant, [], 'an explicit bodies entry should not put the transiting Ascendant in play');
});
