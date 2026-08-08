import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, NIGHT_CHART, SOUTHERN_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

async function positionsFor(fixture) {
  const server = new SwissEphemerisServer();
  return server.handleToolCall('calculate_planetary_positions', {
    datetime: fixture.datetime,
    latitude: fixture.latitude,
    longitude: fixture.longitude,
  });
}

for (const fixture of [DAY_CHART, NIGHT_CHART, SOUTHERN_CHART]) {
  test(`${fixture.label}: moon_phase matches the verified figures`, { skip: !HAS_SWETEST }, async () => {
    const result = await positionsFor(fixture);
    const expected = fixture.expected.moonPhase;
    assert.equal(result.moon_phase.phase, expected.phase);
    assert.ok(Math.abs(result.moon_phase.elongation - expected.elongation) < 1e-5);
    assert.ok(Math.abs(result.moon_phase.illuminated_fraction - expected.illuminatedFraction) < 1e-9);
    assert.equal(result.moon_phase.phase_scheme, '8-phase, bands start at exact aspect');
  });
}

// DAY_CHART and NIGHT_CHART are the same location twelve hours apart. A sign flip in the
// Moon-Sun difference sends both to the same wrong band (Balsamic), so the pair still catches
// that even though both land in Crescent here.
test('DAY_CHART and NIGHT_CHART: elongation differs and neither is a sign-flip artifact', { skip: !HAS_SWETEST }, async () => {
  const day = await positionsFor(DAY_CHART);
  const night = await positionsFor(NIGHT_CHART);
  assert.equal(day.moon_phase.phase, 'Crescent');
  assert.equal(night.moon_phase.phase, 'Crescent');
  assert.notEqual(day.moon_phase.elongation, night.moon_phase.elongation);
  assert.ok(day.moon_phase.elongation > 0 && day.moon_phase.elongation < 360);
  assert.ok(night.moon_phase.elongation > 0 && night.moon_phase.elongation < 360);
});

// SUP-353 spec §4: the wrap case. Moon - Sun here is -179.3393279 (negative) but the true
// elongation, correctly normalized, is 180.6606721 (Full) - a different band than a naive
// signed subtraction would report if left un-normalized.
test('SOUTHERN_CHART: elongation is normalized, not left as a negative raw difference', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(SOUTHERN_CHART);
  assert.ok(result.moon_phase.elongation > 0, 'elongation must be normalized into [0, 360)');
  assert.ok(Math.abs(result.moon_phase.elongation - 180.6606721) < 1e-4);
  assert.equal(result.moon_phase.phase, 'Full');
});

// SUP-353 spec §1.4/§3: elongation must come from the parsed longitudes, not swetest's `*`
// column - that column is the true 3D angular separation, which folds at 180deg and cannot
// distinguish waxing from waning. On SOUTHERN_CHART the two are far enough apart (~5deg) that
// using `*` would report a materially different number.
test('SOUTHERN_CHART: elongation is longitude-derived, not swetest\'s `*` column', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(SOUTHERN_CHART);
  const starColumnValue = 175.6162184; // captured from swetest's `*` field for this fixture
  assert.ok(Math.abs(result.moon_phase.elongation - starColumnValue) > 1, 'elongation should not match the `*` column');
});

test('moon_phase is purely additive: existing planet/chart_point fields are untouched', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  assert.equal(typeof result.planets.Sun.longitude, 'number');
  assert.equal(typeof result.planets.Moon.longitude, 'number');
  assert.equal(typeof result.obliquity, 'number');
  assert.ok(result.moon_phase);
});

test('moon_phase carries Moon\'s illuminated_fraction from the swetest phase column', { skip: !HAS_SWETEST }, async () => {
  const result = await positionsFor(DAY_CHART);
  assert.ok(Math.abs(result.planets.Moon.illuminated_fraction - result.moon_phase.illuminated_fraction) < 1e-12);
});
