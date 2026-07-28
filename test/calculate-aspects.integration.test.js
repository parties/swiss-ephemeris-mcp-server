import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SwissEphemerisServer } from '../index.js';
import { ALL_CHARTS, DAY_CHART } from './fixtures/charts.js';

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

// Fixed reference chart used across all cases: real datetime/location run through the
// real swetest binary and real .se1 ephemeris files in vendor/swisseph (no mocking).
// The date is historical, so the ephemeris output is deterministic across runs.
const REFERENCE_INPUT = { datetime: '1985-04-12T23:20:50Z', latitude: 40.7128, longitude: -74.006 };

function findAspect(aspects, bodyA, bodyB) {
  return aspects.find(
    (a) => (a.body_a === bodyA && a.body_b === bodyB) || (a.body_a === bodyB && a.body_b === bodyA)
  );
}

test('reference chart 1: applying aspect (direct motion) resolves applying: true', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  // Sun (direct, speed ~+0.98) conjunct Lilith (direct, speed ~+0.11), separation closing toward 0.
  const aspect = findAspect(result.aspects, 'Sun', 'Lilith');
  assert.ok(aspect, 'Sun-Lilith conjunction should be present in this chart');
  assert.equal(aspect.aspect, 'conjunction');
  assert.equal(aspect.applying, true);
});

test('reference chart 2: separating aspect resolves applying: false', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  // Mars (direct, speed ~+0.71) square Jupiter (direct, speed ~+0.15), separation widening past 90.
  const aspect = findAspect(result.aspects, 'Mars', 'Jupiter');
  assert.ok(aspect, 'Mars-Jupiter square should be present in this chart');
  assert.equal(aspect.aspect, 'square');
  assert.equal(aspect.applying, false);
});

test('reference chart 3: retrograde body reverses the applying flag vs a direct outer planet', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const positions = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);
  const result = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);

  const mercury = positions.planets.Mercury;
  const jupiter = positions.planets.Jupiter;
  assert.ok(mercury.speed < 0, 'fixture assumes Mercury is retrograde on this date');
  assert.ok(jupiter.speed > 0, 'fixture assumes Jupiter is direct on this date');

  // Independent oracle: recompute expected applying from raw longitudes/speeds without
  // reusing lib/aspects.js, so this genuinely exercises end-to-end correctness.
  let signedDiff = mercury.longitude - jupiter.longitude;
  signedDiff = ((signedDiff % 360) + 360) % 360;
  if (signedDiff > 180) signedDiff -= 360;
  const separation = Math.abs(signedDiff);
  const orbNow = separation - 60; // sextile
  const sepRate = Math.sign(signedDiff) * (mercury.speed - jupiter.speed);
  const expectedApplying = Math.sign(orbNow) * sepRate < 0;

  const aspect = findAspect(result.aspects, 'Mercury', 'Jupiter');
  assert.ok(aspect, 'Mercury-Jupiter sextile should be present in this chart');
  assert.equal(aspect.aspect, 'sextile');
  assert.equal(aspect.applying, expectedApplying);
  assert.equal(aspect.applying, false, 'retrograde Mercury vs direct Jupiter should resolve to a reversed (separating) flag here');
});

test('reference chart 4: exact/boundary conjunction resolves applying: null', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, include_south_node: true });
  // North Node and South Node are always exactly 180 deg apart with identical speed
  // magnitude/direction -> zero closing rate -> applying must resolve to null, not false.
  const aspect = findAspect(result.aspects, 'North Node', 'South Node');
  assert.ok(aspect, 'North Node - South Node opposition should be present');
  assert.equal(aspect.orb, 0);
  assert.equal(aspect.applying, null);
});

test('reference chart 5: minor aspects are absent by default and present with include_minor', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutMinor = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  const withMinor = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, include_minor: true });

  assert.equal(findAspect(withoutMinor.aspects, 'Moon', 'Uranus'), undefined);

  // Moon-Uranus semisquare (~45 deg pair) only shows up once minor aspects are included.
  const semisquare = findAspect(withMinor.aspects, 'Moon', 'Uranus');
  assert.ok(semisquare, 'Moon-Uranus semisquare should appear with include_minor: true');
  assert.equal(semisquare.aspect, 'semisquare');
  assert.equal(semisquare.category, 'minor');
  assert.ok(Math.abs(semisquare.separation - 45) < 2);
});

test('reference chart 6: include_angles surfaces Ascendant/MC/PoF aspects, all with applying: null', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutAngles = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  const withAngles = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, include_angles: true });

  const angleNames = ['Ascendant', 'Midheaven', 'Part of Fortune'];
  const nonAspectableAngleNames = ['IC', 'Descendant'];
  assert.ok(!withoutAngles.aspects.some((a) => angleNames.includes(a.body_a) || angleNames.includes(a.body_b)));

  const angleAspects = withAngles.aspects.filter(
    (a) => angleNames.includes(a.body_a) || angleNames.includes(a.body_b)
  );
  assert.ok(angleAspects.length > 0, 'include_angles: true should add Ascendant/MC/PoF aspects');
  for (const aspect of angleAspects) {
    assert.equal(aspect.applying, null, `${aspect.body_a}-${aspect.body_b} angle aspect must have applying: null (angles have no speed)`);
  }

  // DSC/IC mirror ASC/MC (DSC=ASC+180, IC=MC+180) - aspecting both ends would double-count
  // every axis contact, so they never appear in aspects even with include_angles: true.
  assert.ok(
    !withAngles.aspects.some((a) => nonAspectableAngleNames.includes(a.body_a) || nonAspectableAngleNames.includes(a.body_b)),
    'DSC/IC should never appear in aspects - only ASC/MC/PoF are aspectable'
  );
});

test('reference chart 7: South Node opt-in mirrors North Node aspects (same orb, opposite body)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutSouthNode = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  const withSouthNode = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, include_south_node: true });

  assert.ok(!withoutSouthNode.aspects.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));

  const marsNorthNode = findAspect(withSouthNode.aspects, 'Mars', 'North Node');
  const marsSouthNode = findAspect(withSouthNode.aspects, 'Mars', 'South Node');
  assert.ok(marsNorthNode, 'Mars-North Node aspect should be present');
  assert.ok(marsSouthNode, 'Mars-South Node aspect should be present (mirror of North Node)');
  assert.ok(Math.abs(marsNorthNode.orb - marsSouthNode.orb) < 1e-6, 'South Node orb should mirror North Node orb');
});

test('reference chart 8 (cross-check): calculate_aspects longitudes byte-match calculate_planetary_positions', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const positions = await server.handleToolCall('calculate_planetary_positions', REFERENCE_INPUT);
  const aspectsResult = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);

  for (const name of Object.keys(positions.planets)) {
    assert.equal(aspectsResult.planets[name].longitude, positions.planets[name].longitude, `${name} longitude should byte-match`);
  }
});

test('orb_overrides tightens qualifying pairs on a real chart', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const wide = await server.handleToolCall('calculate_aspects', REFERENCE_INPUT);
  const tight = await server.handleToolCall('calculate_aspects', {
    ...REFERENCE_INPUT,
    orb_overrides: { conjunction: 0.01, opposition: 0.01, trine: 0.01, square: 0.01, sextile: 0.01 },
  });
  assert.ok(tight.aspects.length <= wide.aspects.length);
});

// SUP-168: orb_overrides also accepts a per-class shape, `{ angle: {...}, derived: {...} }`,
// so a caller can tighten/loosen the angle (ASC/MC/IC/DSC) or derived (Part of Fortune, Vertex)
// class without touching body. `point` split into these two classes; both must be overridden
// to reach every angle-family body.
test('orb_overrides per-class shape reaches the angle and derived classes through the tool boundary', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const wide = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, include_angles: true });
  const tightOverride = { conjunction: 0.01, opposition: 0.01, trine: 0.01, square: 0.01, sextile: 0.01 };
  const tight = await server.handleToolCall('calculate_aspects', {
    ...REFERENCE_INPUT,
    include_angles: true,
    orb_overrides: { angle: tightOverride, derived: tightOverride },
  });

  const angleNames = ['Ascendant', 'Midheaven', 'Part of Fortune'];
  const isAngleAspect = (a) => angleNames.includes(a.body_a) || angleNames.includes(a.body_b);

  assert.ok(wide.aspects.some((a) => isAngleAspect(a) && a.orb > 0.01), 'sanity: the wide default has an angle aspect a 0.01-deg orb would drop');
  assert.ok(
    tight.aspects.filter(isAngleAspect).every((a) => a.orb <= 0.01),
    'every surviving angle aspect must be within the 0.01-deg angle/derived override (e.g. an exact angle-angle square)'
  );
  assert.equal(
    tight.aspects.filter((a) => !isAngleAspect(a)).length,
    wide.aspects.filter((a) => !isAngleAspect(a)).length,
    'non-angle (body-class) aspects are unaffected by an angle/derived-only override'
  );
});

test('orb_overrides rejects an unknown aspect name nested inside a per-class override', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', {
      ...REFERENCE_INPUT,
      orb_overrides: { angle: { notAnAspect: 1 } },
    }),
    /Unknown aspect in orb_overrides/
  );
});

test('unknown body in bodies param throws InvalidParams', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', {
      ...REFERENCE_INPUT,
      bodies: ['NotARealBody'],
    }),
    /Unknown body/
  );
});

// With orb_model unset or explicitly 'class', calculate_aspects must be byte-identical
// to today's output — 'class' stays the default and moiety mode is opt-in only.
test('orb_model seam: unset and explicit "class" are byte-identical on a real chart (DAY_CHART)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const input = { datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude, include_angles: true, include_minor: true };

  const unset = await server.handleToolCall('calculate_aspects', input);
  const explicitClass = await server.handleToolCall('calculate_aspects', { ...input, orb_model: 'class' });

  assert.deepEqual(unset, explicitClass);
  assert.ok(unset.aspects.length > 0, 'sanity: DAY_CHART should produce aspects');
  assert.equal(unset.settings_used.orb_model, 'class');
});

test('orb_model "moiety" is accepted at the tool boundary', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, orb_model: 'moiety' });

  assert.equal(result.settings_used.orb_model, 'moiety');
});

test('orb_model rejects an unknown value at the tool boundary', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', { ...REFERENCE_INPUT, orb_model: 'bogus' }),
    /orb_model must be one of/
  );
});

// SUP-176/T4: in moiety mode, orb_overrides takes the two-knob { moieties, multipliers }
// shape. The flat/per-class shape is a class-mode-only shape and must be rejected in moiety
// mode, and vice versa.
test('orb_overrides moiety-shape override is accepted and applied at the tool boundary', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_aspects', {
    ...REFERENCE_INPUT,
    orb_model: 'moiety',
    orb_overrides: { moieties: { Sun: 10 }, multipliers: { quincunx: 0.5 } },
  });

  assert.equal(result.settings_used.orb_model, 'moiety');
  assert.deepEqual(result.settings_used.orb_overrides, { moieties: { Sun: 10 }, multipliers: { quincunx: 0.5 } });
});

test('orb_overrides rejects a class-shape override in moiety mode', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', {
      ...REFERENCE_INPUT,
      orb_model: 'moiety',
      orb_overrides: { square: 2 },
    }),
    /Unknown aspect in orb_overrides/
  );
});

test('orb_overrides rejects a moiety-shape override in class mode', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_aspects', {
      ...REFERENCE_INPUT,
      orb_overrides: { moieties: { Sun: 10 } },
    }),
    /Unknown aspect in orb_overrides/
  );
});

// The point resolver in lib/aspects.js walks planets -> chart_points -> additional_points and
// returns the first hit, which is only safe while those buckets share no key. Nothing in the
// chart builder enforces that, so assert it against every fixture: a collision would make
// resolution order silently significant, which is the failure mode behind #8.
test('a chart\'s three point buckets share no keys', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();

  for (const fixture of ALL_CHARTS) {
    const chart = await server.handleToolCall('calculate_planetary_positions', {
      datetime: fixture.datetime,
      latitude: fixture.latitude,
      longitude: fixture.longitude,
    });

    const buckets = ['planets', 'chart_points', 'additional_points'];
    const seen = new Map();

    for (const bucket of buckets) {
      for (const name of Object.keys(chart[bucket] ?? {})) {
        const previous = seen.get(name);
        assert.equal(
          previous,
          undefined,
          `${fixture.label}: "${name}" appears in both ${previous} and ${bucket}`
        );
        seen.set(name, bucket);
      }
    }
  }
});
