import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { TROPICAL_YEAR_DAYS } from '../lib/progressions.js';
import { DAY_CHART, PARTNER_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const TWO_ARCMIN = 2 / 60;

// Signed angular difference in degrees, wrap-safe - all comparisons in this suite are well
// away from the 0/360 boundary, but this keeps the tolerance checks honest regardless.
function angularDiff(a, b) {
  let diff = ((a - b) % 360 + 540) % 360 - 180;
  return diff;
}

// target_date such that elapsed real time between birthDatetime and it, measured in
// TROPICAL_YEAR_DAYS-day years, is exactly elapsedYears (up to float precision) - the same
// constant lib/progressions.js's computeElapsedYears divides by, so this reproduces a known
// progressed_datetime deterministically instead of guessing a calendar date.
function targetDateFor(birthDatetime, elapsedYears) {
  const birthMs = new Date(birthDatetime).getTime();
  return new Date(birthMs + elapsedYears * TROPICAL_YEAR_DAYS * 86400000).toISOString();
}

const DAY_INPUT = {
  birth_datetime: DAY_CHART.datetime,
  birth_latitude: DAY_CHART.latitude,
  birth_longitude: DAY_CHART.longitude,
  target_date: targetDateFor(DAY_CHART.datetime, DAY_CHART.expected.progressions.elapsedYears),
};

const PARTNER_INPUT = {
  birth_datetime: PARTNER_CHART.datetime,
  birth_latitude: PARTNER_CHART.latitude,
  birth_longitude: PARTNER_CHART.longitude,
  target_date: targetDateFor(PARTNER_CHART.datetime, PARTNER_CHART.expected.progressions.elapsedYears),
};

// Acceptance criterion #1: solar_arc DAY_CHART -> progressed MC 13°04'39" Aquarius ±2',
// progressed Ascendant derived at natal latitude 51.4769.
test('calculate_secondary_progressions solar_arc DAY_CHART matches the spec\'s progressed MC and Ascendant', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  assert.equal(result.progressed_datetime, DAY_CHART.expected.progressions.progressedDatetime);
  assert.ok(Math.abs(result.elapsed_years - DAY_CHART.expected.progressions.elapsedYears) < 1e-6);
  assert.equal(result.angle_method_used, 'solar_arc');

  assert.ok(
    Math.abs(angularDiff(result.progressed_angles.Midheaven.longitude, DAY_CHART.expected.progressions.solarArcMcLongitude)) < TWO_ARCMIN,
    `progressed MC ${result.progressed_angles.Midheaven.longitude} not within 2' of ${DAY_CHART.expected.progressions.solarArcMcLongitude}`
  );
  assert.ok(
    Math.abs(angularDiff(result.progressed_angles.Ascendant.longitude, DAY_CHART.expected.progressions.ascendantLongitude)) < TWO_ARCMIN,
    `progressed Ascendant ${result.progressed_angles.Ascendant.longitude} not within 2' of ${DAY_CHART.expected.progressions.ascendantLongitude}`
  );
});

// Acceptance criterion #2: naibod, same input, MC 12°01'57" Aquarius ±2'.
test('calculate_secondary_progressions naibod DAY_CHART matches the spec\'s progressed MC', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, angle_method: 'naibod' });

  assert.equal(result.angle_method_used, 'naibod');
  assert.ok(
    Math.abs(angularDiff(result.progressed_angles.Midheaven.longitude, DAY_CHART.expected.progressions.naibodMcLongitude)) < TWO_ARCMIN
  );
});

// Acceptance criterion #3: PARTNER_CHART, solar_arc, MC 25°50'43" Scorpio ±2'. This fixture's
// nonzero natal longitude (-74.0060) is what exercises the natal-longitude correction term in
// computeFictitiousLongitude - a Greenwich-only check can't catch a missing correction.
test('calculate_secondary_progressions solar_arc PARTNER_CHART matches the spec\'s progressed MC', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', PARTNER_INPUT);

  assert.equal(result.progressed_datetime, PARTNER_CHART.expected.progressions.progressedDatetime);
  assert.ok(
    Math.abs(angularDiff(result.progressed_angles.Midheaven.longitude, PARTNER_CHART.expected.progressions.solarArcMcLongitude)) < TWO_ARCMIN,
    `progressed MC ${result.progressed_angles.Midheaven.longitude} not within 2' of ${PARTNER_CHART.expected.progressions.solarArcMcLongitude}`
  );
});

// Acceptance criterion #4: progressed_planets matches the manual workaround exactly - calling
// calculate_planetary_positions directly at progressed_datetime and comparing longitudes.
test('calculate_secondary_progressions progressed_planets matches a direct calculate_planetary_positions call at progressed_datetime', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);
  const manual = await server.handleToolCall('calculate_planetary_positions', {
    datetime: result.progressed_datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
  });

  for (const name of ['Sun', 'Moon', 'Venus']) {
    assert.ok(
      Math.abs(angularDiff(result.progressed_planets[name].longitude, manual.planets[name].longitude)) < 1e-6,
      `${name}: progressed ${result.progressed_planets[name].longitude} vs manual ${manual.planets[name].longitude}`
    );
  }

  assert.ok(Math.abs(angularDiff(result.progressed_planets.Moon.longitude, DAY_CHART.expected.progressions.progressedMoonLongitude)) < 1e-4);
  assert.ok(Math.abs(angularDiff(result.progressed_planets.Venus.longitude, DAY_CHART.expected.progressions.progressedVenusLongitude)) < 1e-4);
  assert.ok(Math.abs(angularDiff(result.progressed_planets.Sun.longitude, DAY_CHART.expected.progressions.progressedSunLongitude)) < 1e-4);
});

// Acceptance criterion #5: these fields are always present.
test('calculate_secondary_progressions always echoes angle_method_used/house_frame_used/year_length_days/progressed_datetime', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  assert.equal(typeof result.angle_method_used, 'string');
  assert.equal(typeof result.house_frame_used, 'string');
  assert.equal(typeof result.year_length_days, 'number');
  assert.equal(typeof result.progressed_datetime, 'string');
});

// Acceptance criterion #6: unknown angle_method errors rather than silently defaulting.
// "ephemeris_time" specifically - the spec's proposed-but-rejected third option (see
// docs/tool_requests/2026-07-27_secondary-progressions.md §4) - must not be silently accepted.
test('calculate_secondary_progressions rejects an unknown angle_method', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, angle_method: 'ephemeris_time' }),
    /angle_method must be one of/
  );
});

test('calculate_secondary_progressions rejects an unknown house_frame', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, house_frame: 'transiting' }),
    /house_frame must be one of/
  );
});

// Acceptance criterion #7: retrograde is a boolean on every progressed planet, not something
// callers infer from the sign of speed. DAY_CHART's progressed Venus is retrograde at this date.
test('calculate_secondary_progressions retrograde is present as a boolean on every progressed planet', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  const names = Object.keys(result.progressed_planets);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.equal(typeof result.progressed_planets[name].retrograde, 'boolean', name);
  }
  assert.equal(result.progressed_planets.Venus.retrograde, true, 'progressed Venus should be retrograde at this DAY_CHART progressed date');
  assert.equal(result.progressed_planets.Sun.retrograde, false);
});

// Acceptance criterion #8: the progressed MC must not be the raw chart_points.Midheaven of the
// progressed instant (the exact bug this tool exists to fix) - it's plausible-looking, not
// malformed, so this needs an explicit regression rather than relying on a crash to catch it.
test('calculate_secondary_progressions progressed MC is not the raw clock-time Midheaven at progressed_datetime', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);
  const raw = await server.handleToolCall('calculate_planetary_positions', {
    datetime: result.progressed_datetime,
    latitude: DAY_CHART.latitude,
    longitude: DAY_CHART.longitude,
  });

  assert.ok(Math.abs(angularDiff(raw.chart_points.Midheaven.longitude, DAY_CHART.expected.progressions.rawMidheavenLongitude)) < 1e-4, 'fixture sanity: raw MC should match the recorded wrong value');
  assert.ok(
    Math.abs(angularDiff(result.progressed_angles.Midheaven.longitude, raw.chart_points.Midheaven.longitude)) > 1,
    'progressed MC must differ substantially from the raw clock-time Midheaven'
  );
});

// SUP-356 advisory comment #1: house 1 must equal the progressed Ascendant and house 10 must
// equal the progressed Midheaven under the default (progressed) house_frame - an MC-only
// assertion can't catch a wrong-latitude bug in the house computation.
test('calculate_secondary_progressions progressed_houses 1 and 10 match progressed_angles Ascendant/Midheaven', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  assert.equal(result.house_frame_used, 'progressed');
  assert.ok(Math.abs(angularDiff(result.progressed_houses['1'].longitude, result.progressed_angles.Ascendant.longitude)) < 1e-6);
  assert.ok(Math.abs(angularDiff(result.progressed_houses['10'].longitude, result.progressed_angles.Midheaven.longitude)) < 1e-6);
});

// house_frame: 'natal' reuses the birth chart's own cusps for progressed_houses, but
// progressed_angles stay the arc-directed progressed values regardless.
test('calculate_secondary_progressions house_frame natal reuses natal cusps for progressed_houses but keeps progressed_angles progressed', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, house_frame: 'natal' });

  assert.equal(result.house_frame_used, 'natal');
  assert.ok(Math.abs(angularDiff(result.progressed_houses['10'].longitude, result.natal_chart.chart_points.Midheaven.longitude)) < 1e-9);
  assert.ok(
    Math.abs(angularDiff(result.progressed_angles.Midheaven.longitude, result.natal_chart.chart_points.Midheaven.longitude)) > 1,
    'progressed_angles must stay the progressed value even under house_frame natal'
  );
});

// SUP-356 advisory comment #2: unlike calculate_transits' unconditional drop of the
// transiting-side angles (index.js calculateTransitAspects), progressed Ascendant/Midheaven
// must stay aspectable on the progressed side when include_angles is true (the default) -
// otherwise this tool's headline output (progressed angle contacts) is unreachable. Progressed
// Part of Fortune must never appear on the progressed side (sect convention unsettled).
test('calculate_secondary_progressions include_angles keeps progressed Ascendant/Midheaven aspectable but excludes progressed Part of Fortune', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  assert.ok(
    result.aspects_to_natal.some((a) => a.progressed_body === 'Ascendant' || a.progressed_body === 'Midheaven'),
    'expect at least one progressed angle contact for this chart/date'
  );
  assert.ok(!result.aspects_to_natal.some((a) => a.progressed_body === 'Part of Fortune'));

  const withoutAngles = await server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, include_angles: false });
  assert.ok(!withoutAngles.aspects_to_natal.some((a) => a.progressed_body === 'Ascendant' || a.progressed_body === 'Midheaven'));
});

// SUP-356 §4 ruling: orbs are numbers, not the .toFixed(2) strings calculate_transits and
// calculate_synastry use (SUP-345/SUP-351 made the same call).
test('calculate_secondary_progressions aspects_to_natal reports orb and exact_angle as numbers', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  assert.ok(result.aspects_to_natal.length > 0);
  for (const a of result.aspects_to_natal) {
    assert.equal(typeof a.orb, 'number', JSON.stringify(a));
    assert.equal(typeof a.exact_angle, 'number', JSON.stringify(a));
  }
});

test('calculate_secondary_progressions includes ephemeris_version and the full natal_chart', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_secondary_progressions', DAY_INPUT);

  assert.equal(typeof result.ephemeris_version, 'string');
  assert.ok(result.ephemeris_version.startsWith('swiss-ephemeris-mcp-server@'));
  assert.ok(result.natal_chart.planets.Sun);
  assert.ok(result.natal_chart.chart_points.Midheaven);
});

test('calculate_secondary_progressions rejects a malformed orb_overrides value', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, orb_overrides: 'nope' }),
    /orb_overrides must be an object/
  );
});

test('calculate_secondary_progressions requires birth_datetime, birth_latitude, birth_longitude, and target_date', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(() => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, birth_datetime: undefined }));
  await assert.rejects(() => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, birth_latitude: undefined }));
  await assert.rejects(() => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, birth_longitude: undefined }));
  await assert.rejects(() => server.handleToolCall('calculate_secondary_progressions', { ...DAY_INPUT, target_date: undefined }));
});
