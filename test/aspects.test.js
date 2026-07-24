import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPSILON_DEG,
  normalizeSeparation,
  computeApplying,
  calculateNatalAspects,
  calculateHouseOverlay,
} from '../lib/aspects.js';

test('normalizeSeparation wraps around 0/360 seam (350 vs 10 -> sep 20, not 340)', () => {
  const { separation } = normalizeSeparation(350, 10);
  assert.equal(separation, 20);
});

test('normalizeSeparation locks in ~179 sep approached from both sides of the seam', () => {
  const fromPositive = normalizeSeparation(0, -179.001);
  const fromNegative = normalizeSeparation(0, 179.001);
  assert.ok(Math.abs(fromPositive.separation - 179.001) < 1e-9);
  assert.ok(Math.abs(fromNegative.separation - 179.001) < 1e-9);
});

test('computeApplying: conjunction applying when separation is shrinking', () => {
  // orbNow = 5 (positive, outside target), sepRate negative (shrinking) -> applying
  const applying = computeApplying(5, 0, 5, 0, 1);
  assert.equal(applying, true);
});

test('computeApplying: conjunction separating when separation is growing', () => {
  // orbNow = 5 (positive), sepRate positive (growing) -> separating
  const applying = computeApplying(5, 0, 5, 1, 0);
  assert.equal(applying, false);
});

test('computeApplying: opposition sign-flip, sep growing toward 180 -> applying true', () => {
  // orbNow = -5 (sep below 180), sepRate positive (growing toward 180) -> applying
  const applying = computeApplying(175, 180, 175, 1, 0);
  assert.equal(applying, true);
});

test('computeApplying: retrograde-body reference pair', () => {
  // Sun ~0.9803 deg/day direct, Mercury ~-1.3833 deg/day retrograde, near conjunction
  const sunSpeed = 0.9801706111111111;
  const mercurySpeed = -1.3833333333333333;
  const applying = computeApplying(3, 0, 3, sunSpeed, mercurySpeed);
  // dRate = sunSpeed - mercurySpeed > 0, sepRate = sign(3)*dRate > 0, orbNow = 3 > 0
  // sign(orbNow) * sepRate > 0 -> separating
  assert.equal(applying, false);
});

test('computeApplying: null speed (angle/PoF) -> null', () => {
  assert.equal(computeApplying(5, 0, 5, null, 1), null);
  assert.equal(computeApplying(5, 0, 5, 1, undefined), null);
});

test('computeApplying: stationary/equal-speed -> null (not false)', () => {
  const applying = computeApplying(5, 0, 5, 0.5, 0.5);
  assert.equal(applying, null);
  assert.notEqual(applying, false);
});

test('computeApplying: exact-hit epsilon boundary -> null', () => {
  const orbNow = 1e-9;
  assert.ok(orbNow !== 0);
  const applying = computeApplying(orbNow, 0, 10, 1, 0);
  assert.equal(applying, null);

  // sanity: a real (non-epsilon) orb with the same setup does resolve
  const resolved = computeApplying(1e-3, 0, 10, 1, 0);
  assert.notEqual(resolved, null);
});

test('orb_overrides changes qualifying pairs (tightening square drops a 5-degree-orb pair)', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 95, speed: 0 }, // 95 deg separation, square orb = 5
  ];

  const withDefaultOrb = calculateNatalAspects(bodies, {});
  assert.ok(withDefaultOrb.some((a) => a.aspect === 'square'));

  const withTightOrb = calculateNatalAspects(bodies, { orbOverrides: { square: 2 } });
  assert.ok(!withTightOrb.some((a) => a.aspect === 'square'));
});

test('includeMinor gating: false never returns minor aspects even at exact minor angle', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 72, speed: 0 }, // exact quintile
  ];

  const withoutMinor = calculateNatalAspects(bodies, { includeMinor: false });
  assert.ok(!withoutMinor.some((a) => a.aspect === 'quintile'));

  const withMinor = calculateNatalAspects(bodies, { includeMinor: true });
  assert.ok(withMinor.some((a) => a.aspect === 'quintile'));
});

test('includeSouthNode gating: excludes from all aspects when false, includes when true', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'South Node', longitude: 0, speed: null }, // exact conjunction
  ];

  const withoutSouthNode = calculateNatalAspects(bodies, { includeSouthNode: false });
  assert.ok(!withoutSouthNode.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));

  const withSouthNode = calculateNatalAspects(bodies, { includeSouthNode: true });
  assert.ok(withSouthNode.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));
});

test('aspects are sorted by orb ascending', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 3, speed: 0 },
    { name: 'C', longitude: 61, speed: 0 },
  ];
  const aspects = calculateNatalAspects(bodies, {});
  for (let i = 1; i < aspects.length; i++) {
    assert.ok(aspects[i - 1].orb <= aspects[i].orb);
  }
});

test('EPSILON_DEG is a small positive number', () => {
  assert.ok(EPSILON_DEG > 0 && EPSILON_DEG < 1e-3);
});

function equalHouses(ascendantLongitude) {
  const houses = {};
  for (let h = 1; h <= 12; h++) {
    houses[h] = { longitude: (ascendantLongitude + (h - 1) * 30) % 360 };
  }
  return houses;
}

test('calculateHouseOverlay places a body just past a cusp into that house', () => {
  const houses = equalHouses(0); // house 1 starts at 0, house 2 at 30, ...
  const overlay = calculateHouseOverlay([{ name: 'Sun', longitude: 31 }], houses);
  assert.equal(overlay.Sun, 2);
});

test('calculateHouseOverlay places a body just before a cusp into the earlier house', () => {
  const houses = equalHouses(0);
  const overlay = calculateHouseOverlay([{ name: 'Sun', longitude: 29.999 }], houses);
  assert.equal(overlay.Sun, 1);
});

test('calculateHouseOverlay handles the 360/0 wraparound (house 12 into house 1)', () => {
  const houses = equalHouses(350); // house 1 starts at 350, house 12 starts at 320
  const overlay = calculateHouseOverlay([{ name: 'Moon', longitude: 5 }], houses);
  assert.equal(overlay.Moon, 1); // 5 deg is past the 350 cusp, wrapped
});
