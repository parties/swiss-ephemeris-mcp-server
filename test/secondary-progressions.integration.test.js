import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { TROPICAL_YEAR_DAYS } from '../lib/progressions.js';
import { MOIETIES, ASPECT_MULTIPLIERS } from '../lib/aspects.js';
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

// --- SUP-383: orb_model reaches the aspect engine -------------------------------------------
//
// Before SUP-383 this tool named no orb model at all, so both halves of its aspect seam
// (resolveAspectBodies, which validates orb_overrides keys, and calculateCrossChartAspects,
// which applies them) fell back to 'moiety' - and every orb_overrides shape the schema and
// README documented threw `Unknown aspect in orb_overrides: conjunction`. The default is now
// 'fixed' (1 deg majors / 0.5 deg minors), matching find_events at rate
// "secondary_progression": a transit-scaled moiety table keeps a progressed outer-planet
// contact in orb for centuries.
//
// Every test below compares an override run against a baseline run computed IN THE SAME test.
// Row counts drift with ephemeris data; the relationship between two runs does not. And
// aspects_to_natal rows deliberately carry no `orb_allowed` (unlike find_events' contacts), so
// overrides are proven through presence, absence and orb bounds rather than by reading the
// resolved orb back off a row.

const ANGLE_NAMES = ['Ascendant', 'Midheaven'];
const isAngleRow = (a) => ANGLE_NAMES.includes(a.progressed_body) || ANGLE_NAMES.includes(a.natal_body);
const isFortuneRow = (a) => a.natal_body === 'Part of Fortune';
const TIGHT_MAJORS = { conjunction: 0.01, opposition: 0.01, trine: 0.01, square: 0.01, sextile: 0.01 };

// Moiety orb for one row under a moieties table already merged with the caller's override -
// the same (moietyA + moietyB) * multiplier[aspect] formula lib/aspects.js applies internally,
// so A11/A12 can bound survivors by arithmetic instead of by a hardcoded row count.
function moietyOrbFor(row, moieties = MOIETIES, multipliers = ASPECT_MULTIPLIERS) {
  return (moieties[row.progressed_body] + moieties[row.natal_body]) * multipliers[row.aspect];
}

const progress = (server, args) => server.handleToolCall('calculate_secondary_progressions', args);

// A1 - the seam test. With NO overrides at all the validator half of the seam is a no-op, so
// the only way these two runs can differ is orb_model actually reaching
// calculateCrossChartAspects. A fix that threads orb_model into resolveAspectBodies alone
// (making the documented shapes stop throwing while silently ignoring them) fails here.
test('calculate_secondary_progressions orb_model reaches the aspect engine, not just the orb_overrides validator', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const klass = await progress(server, { ...DAY_INPUT, orb_model: 'class' });
  const fixed = await progress(server, { ...DAY_INPUT, orb_model: 'fixed' });

  assert.ok(klass.aspects_to_natal.length > 0, 'sanity: the class baseline should produce aspects');
  assert.ok(
    klass.aspects_to_natal.some((a) => a.orb > 1),
    'sanity: the class baseline must hold a row wider than the fixed table, or this test is vacuous'
  );
  assert.ok(
    fixed.aspects_to_natal.every((a) => a.orb <= 1),
    'orb_model "fixed" never reached the aspect engine - rows exceed the 1-deg fixed major orb'
  );
  assert.ok(fixed.aspects_to_natal.length < klass.aspects_to_natal.length);
});

// A2 - the 1 deg / 0.5 deg split belongs to FIXED_ORBS alone: class and moiety both resolve
// per body/point, so neither can produce a table where every major shares one bound and every
// minor shares a tighter one.
test('calculate_secondary_progressions orb_model "fixed" bounds minors at 0.5 deg and majors at 1', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await progress(server, { ...DAY_INPUT, orb_model: 'fixed', include_minor: true });

  const majors = result.aspects_to_natal.filter((a) => a.category === 'major');
  const minors = result.aspects_to_natal.filter((a) => a.category === 'minor');

  assert.ok(majors.length > 0, 'sanity: expect major aspects under the fixed table');
  assert.ok(minors.length > 0, 'sanity: expect minor aspects under the fixed table with include_minor');
  assert.ok(majors.every((a) => a.orb <= 1), 'every major must be within the 1-deg fixed orb');
  assert.ok(minors.every((a) => a.orb <= 0.5), 'every minor must be within the 0.5-deg fixed orb');
  assert.ok(
    majors.some((a) => a.orb > 0.5),
    'sanity: a major beyond 0.5 deg must survive, or the two halves of the split are indistinguishable'
  );
});

// A3 - the literal example in this tool's own schema description and README. Widening proof:
// a conjunction past 8 deg, which no unmodified table this tool can select produces (fixed
// allows 1, the class body table 8).
test('calculate_secondary_progressions honors the documented flat orb_overrides shape {"conjunction": 10}', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const baseline = await progress(server, { ...DAY_INPUT, orb_model: 'fixed' });
  const widened = await progress(server, { ...DAY_INPUT, orb_model: 'fixed', orb_overrides: { conjunction: 10 } });

  assert.ok(
    !baseline.aspects_to_natal.some((a) => a.aspect === 'conjunction' && a.orb > 8),
    'sanity: the unmodified fixed table must not already hold a conjunction past 8 deg'
  );
  assert.ok(
    widened.aspects_to_natal.some((a) => a.aspect === 'conjunction' && a.orb > 8),
    'a {"conjunction": 10} override must widen conjunctions past what any unmodified table allows'
  );
  assert.ok(widened.aspects_to_natal.every((a) => a.aspect !== 'conjunction' || a.orb <= 10));
  assert.equal(
    widened.aspects_to_natal.filter((a) => a.aspect !== 'conjunction').length,
    baseline.aspects_to_natal.filter((a) => a.aspect !== 'conjunction').length,
    'a conjunction-only override must leave every other aspect count-stable'
  );
});

// A4 - the call from the bug report, in the direction callers actually want (progressed orbs
// are conventionally ~1 deg). Paired with A3 this pins that overrides are honored in BOTH
// directions: an implementation that clamps an override to its table value passes A4 alone.
test('calculate_secondary_progressions honors a tightening flat orb_overrides value', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const baseline = await progress(server, { ...DAY_INPUT, orb_model: 'class' });
  const tightened = await progress(server, { ...DAY_INPUT, orb_model: 'class', orb_overrides: { conjunction: 1 } });

  assert.ok(
    baseline.aspects_to_natal.some((a) => a.aspect === 'conjunction' && a.orb > 1),
    'sanity: the class baseline must hold a conjunction the 1-deg override would drop'
  );
  const tightConjunctions = tightened.aspects_to_natal.filter((a) => a.aspect === 'conjunction');
  assert.ok(tightConjunctions.length > 0, 'expect some conjunction to survive a 1-deg orb');
  assert.ok(tightConjunctions.every((a) => a.orb <= 1), 'every surviving conjunction must be within the 1-deg override');
  assert.equal(
    tightened.aspects_to_natal.filter((a) => a.aspect !== 'conjunction').length,
    baseline.aspects_to_natal.filter((a) => a.aspect !== 'conjunction').length,
    'a conjunction-only override must leave every other aspect count-stable'
  );
});

// A5 - the per-class shape the schema documents. The natal Part of Fortune row surviving is
// the routing proof: Part of Fortune is derived-class, so an `angle` override reaching it
// would mean the per-class maps are being flattened together.
test('calculate_secondary_progressions honors the per-class {"angle": {...}} shape without spilling into the other classes', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const baseline = await progress(server, { ...DAY_INPUT, orb_model: 'class' });
  const tightened = await progress(server, { ...DAY_INPUT, orb_model: 'class', orb_overrides: { angle: TIGHT_MAJORS } });

  assert.ok(
    baseline.aspects_to_natal.some((a) => isAngleRow(a) && a.orb > 0.01),
    'sanity: the class baseline must hold an angle contact a 0.01-deg override would drop'
  );
  assert.ok(
    tightened.aspects_to_natal.filter(isAngleRow).every((a) => a.orb <= 0.01),
    'every surviving angle contact must be within the 0.01-deg angle-class override'
  );
  assert.equal(
    tightened.aspects_to_natal.filter((a) => !isAngleRow(a)).length,
    baseline.aspects_to_natal.filter((a) => !isAngleRow(a)).length,
    'an angle-only override must leave the body and derived classes count-stable'
  );
  assert.ok(
    tightened.aspects_to_natal.some((a) => isFortuneRow(a) && !ANGLE_NAMES.includes(a.progressed_body)),
    'a natal Part of Fortune contact (derived class) must survive an angle-class override'
  );
});

// A6 - the sharpest routing proof available on this tool: Part of Fortune is the only
// derived-class point reachable here at all (the progressed side never carries one, and this
// tool has no Vertex), so a `derived` override has a single-row fingerprint.
test('calculate_secondary_progressions per-class {"derived": {...}} reaches natal Part of Fortune and nothing else', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const baseline = await progress(server, { ...DAY_INPUT, orb_model: 'class' });
  const tightened = await progress(server, { ...DAY_INPUT, orb_model: 'class', orb_overrides: { derived: TIGHT_MAJORS } });

  assert.ok(
    baseline.aspects_to_natal.some((a) => isFortuneRow(a) && a.orb > 0.01),
    'sanity: the class baseline must hold a natal Part of Fortune contact a 0.01-deg override would drop'
  );
  assert.ok(
    tightened.aspects_to_natal.filter(isFortuneRow).every((a) => a.orb <= 0.01),
    'every surviving Part of Fortune contact must be within the 0.01-deg derived-class override'
  );
  assert.equal(
    tightened.aspects_to_natal.filter((a) => !isFortuneRow(a)).length,
    baseline.aspects_to_natal.filter((a) => !isFortuneRow(a)).length,
    'a derived-only override must leave every non-Part-of-Fortune row count-stable'
  );
});

// A7 - the NESTED key must be named. This same input already threw before SUP-383, but with
// `...: angle` (the moiety fallback rejecting the class name itself), so a bare
// /Unknown aspect/ regex would pass against the bug and prove nothing.
test('calculate_secondary_progressions rejects an unknown aspect name nested inside a per-class orb_overrides entry', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'class', orb_overrides: { angle: { notAnAspect: 1 } } }),
    /Unknown aspect in orb_overrides: notAnAspect/
  );
});

// A8 - widening the accepted shape must not turn the unknown-key check off. 'fixed' matters
// on its own here: it takes an early-return branch in invalidOrbOverrideKeys distinct from
// class's, and it is the branch the new default exercises. Each model also has to still
// ACCEPT a valid flat key, or "rejects unknown names" is satisfied by rejecting everything.
test('calculate_secondary_progressions still rejects an unknown flat aspect name under both class and fixed', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  for (const orb_model of ['class', 'fixed']) {
    await assert.rejects(
      () => progress(server, { ...DAY_INPUT, orb_model, orb_overrides: { notAnAspect: 1 } }),
      /Unknown aspect in orb_overrides: notAnAspect/,
      `orb_model "${orb_model}" must reject an unknown flat aspect name`
    );
    const accepted = await progress(server, { ...DAY_INPUT, orb_model, orb_overrides: { conjunction: 2 } });
    assert.equal(accepted.orb_model_used, orb_model, `orb_model "${orb_model}" must accept a known flat aspect name`);
  }
});

// A9 - the moiety two-knob shape and the class/fixed flat-or-nested shape are disjoint by
// design (lib/aspects.js): neither `moieties` nor `multipliers` is a class name or an aspect
// name. That rejection was unreachable while 'class' itself was unreachable.
test('calculate_secondary_progressions rejects the moiety two-knob shape under orb_model "class"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'class', orb_overrides: { moieties: { Sun: 8 } } }),
    /Unknown aspect in orb_overrides: moieties/
  );
  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'class', orb_overrides: { multipliers: { quincunx: 0.3 } } }),
    /Unknown aspect in orb_overrides: multipliers/
  );
});

// A10 - the shape widened PER MODEL, not by loosening invalidOrbOverrideKeys globally. That
// looser fix also makes the reported error go away, which is what makes it tempting. The
// orb_model_used assertion is what keeps this honest: the rejection has to happen under a
// genuinely resolved 'moiety', not under the accidental fallback that caused the bug.
test('calculate_secondary_progressions rejects the flat orb_overrides shape under orb_model "moiety"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const resolved = await progress(server, { ...DAY_INPUT, orb_model: 'moiety' });
  assert.equal(resolved.orb_model_used, 'moiety', 'sanity: orb_model "moiety" must be reachable at all');

  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'moiety', orb_overrides: { conjunction: 1 } }),
    /Unknown aspect in orb_overrides: conjunction/
  );
  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'moiety', orb_overrides: { angle: { square: 4 } } }),
    /Unknown aspect in orb_overrides: angle/
  );
});

// A11 - regression guard on the only orb_overrides shape that worked before SUP-383. Now that
// the model is named rather than fallen back into, the knob has to keep working under it.
test('calculate_secondary_progressions orb_model "moiety" still honors the {moieties} knob', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const baseline = await progress(server, { ...DAY_INPUT, orb_model: 'moiety' });
  const overrides = { moieties: { Sun: 0.1, Moon: 0.1 } };
  const tightened = await progress(server, { ...DAY_INPUT, orb_model: 'moiety', orb_overrides: overrides });

  assert.equal(tightened.orb_model_used, 'moiety');
  const tightMoieties = { ...MOIETIES, ...overrides.moieties };
  const isLuminaryRow = (a) => ['Sun', 'Moon'].includes(a.progressed_body) || ['Sun', 'Moon'].includes(a.natal_body);

  assert.ok(
    baseline.aspects_to_natal.some((a) => isLuminaryRow(a) && a.orb > moietyOrbFor(a, tightMoieties)),
    'sanity: the moiety baseline must hold a luminary contact the shrunken moieties would drop'
  );
  assert.ok(
    tightened.aspects_to_natal.filter(isLuminaryRow).every((a) => a.orb <= moietyOrbFor(a, tightMoieties)),
    'every surviving luminary contact must fit the (moietyA + moietyB) * multiplier bound under the override'
  );
  assert.equal(
    tightened.aspects_to_natal.filter((a) => !isLuminaryRow(a)).length,
    baseline.aspects_to_natal.filter((a) => !isLuminaryRow(a)).length,
    'shrinking the Sun/Moon moieties must leave every non-luminary row count-stable'
  );
});

// A12 - the aspect-scoped half of the moiety shape, otherwise untested at this tool boundary.
test('calculate_secondary_progressions orb_model "moiety" still honors the {multipliers} knob', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const baseline = await progress(server, { ...DAY_INPUT, orb_model: 'moiety' });
  const overrides = { multipliers: { sextile: 0.01 } };
  const tightened = await progress(server, { ...DAY_INPUT, orb_model: 'moiety', orb_overrides: overrides });

  assert.equal(tightened.orb_model_used, 'moiety');
  const tightMultipliers = { ...ASPECT_MULTIPLIERS, ...overrides.multipliers };

  assert.ok(
    baseline.aspects_to_natal.some((a) => a.aspect === 'sextile' && a.orb > moietyOrbFor(a, MOIETIES, tightMultipliers)),
    'sanity: the moiety baseline must hold a sextile the shrunken multiplier would drop'
  );
  assert.ok(
    tightened.aspects_to_natal.filter((a) => a.aspect === 'sextile').every((a) => a.orb <= moietyOrbFor(a, MOIETIES, tightMultipliers)),
    'every surviving sextile must fit the shrunken multiplier bound'
  );
  assert.equal(
    tightened.aspects_to_natal.filter((a) => a.aspect !== 'sextile').length,
    baseline.aspects_to_natal.filter((a) => a.aspect !== 'sextile').length,
    'a sextile-only multiplier override must leave every other aspect count-stable'
  );
});

// A13 - two probes. The second is the ordering guard: orb_model has to be validated ahead of
// orb resolution, or a caller who mistypes the model gets told `Unknown aspect in
// orb_overrides`, which names the wrong parameter entirely.
test('calculate_secondary_progressions rejects an unknown orb_model', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'bogus' }),
    /orb_model must be one of/
  );
  await assert.rejects(
    () => progress(server, { ...DAY_INPUT, orb_model: 'bogus', orb_overrides: { conjunction: 1 } }),
    (error) => {
      assert.match(error.message, /orb_model must be one of/);
      assert.doesNotMatch(error.message, /Unknown aspect in orb_overrides/, 'a bogus orb_model must not be reported as an orb_overrides problem');
      return true;
    }
  );
});

// A14 - round-trip two distinct models; a single assertion would pass against a hardcoded
// echo string.
test('calculate_secondary_progressions echoes the resolved orb model as orb_model_used', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  for (const orb_model of ['moiety', 'class']) {
    const result = await progress(server, { ...DAY_INPUT, orb_model });
    assert.equal(result.orb_model_used, orb_model);
  }
});

// B1 - the default-flip seam, mirroring calculate_aspects' own orb_model seam test.
test('calculate_secondary_progressions with orb_model omitted is byte-identical to orb_model "fixed"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { ...DAY_INPUT, include_minor: true };

  const unset = await progress(server, input);
  const explicitFixed = await progress(server, { ...input, orb_model: 'fixed' });

  assert.deepEqual(unset, explicitFixed);
  assert.ok(unset.aspects_to_natal.length > 0, 'sanity: DAY_CHART should produce aspects');
  assert.equal(unset.orb_model_used, 'fixed');
});

// B2 - the bug report, encoded: the schema's own orb_overrides example, with nothing else set.
test('calculate_secondary_progressions accepts the orb_overrides example from its own schema description with no orb_model', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await progress(server, { ...DAY_INPUT, orb_overrides: { conjunction: 10 } });

  assert.equal(result.orb_model_used, 'fixed');
  assert.ok(result.aspects_to_natal.length > 0);
});

test('calculate_secondary_progressions default orb_model_used is "fixed"', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await progress(server, DAY_INPUT);

  assert.equal(result.orb_model_used, 'fixed');
  assert.ok(result.aspects_to_natal.length > 0);
  assert.ok(result.aspects_to_natal.every((a) => a.orb <= 1), 'the fixed default bounds every major at 1 deg');
});
