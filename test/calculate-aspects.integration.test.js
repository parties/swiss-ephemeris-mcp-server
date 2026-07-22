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

  const angleNames = ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Part of Fortune'];
  assert.ok(!withoutAngles.aspects.some((a) => angleNames.includes(a.body_a) || angleNames.includes(a.body_b)));

  const angleAspects = withAngles.aspects.filter(
    (a) => angleNames.includes(a.body_a) || angleNames.includes(a.body_b)
  );
  assert.ok(angleAspects.length > 0, 'include_angles: true should add Ascendant/MC/IC/Descendant/PoF aspects');
  for (const aspect of angleAspects) {
    assert.equal(aspect.applying, null, `${aspect.body_a}-${aspect.body_b} angle aspect must have applying: null (angles have no speed)`);
  }

  const ascDesc = findAspect(withAngles.aspects, 'Ascendant', 'Descendant');
  assert.ok(ascDesc);
  assert.equal(ascDesc.aspect, 'opposition');
  assert.equal(ascDesc.orb, 0);
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
