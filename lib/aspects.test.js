import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPSILON_DEG,
  normalizeSeparation,
  computeApplying,
  calculateNatalAspects,
} from './aspects.js';

// 1. normalizeSeparation wraparound
test('normalizeSeparation wraps 350 vs 10 to separation 20, not 340', () => {
  const { separation } = normalizeSeparation(350, 10);
  assert.equal(separation, 20);
});

// 2. Normalization-seam lock-in around 179/-179 discontinuity
test('normalizeSeparation seam: signedDiff on either side of +/-180 yields matching separation and consistent applying sign', () => {
  const caseA = normalizeSeparation(179, 0); // signedDiff = 179
  const caseB = normalizeSeparation(181, 0); // signedDiff wraps to -179
  assert.equal(caseA.separation, 179);
  assert.equal(caseB.separation, 179);

  // Same relative speed regime (speedA=1, speedB=0) on both sides of the seam.
  const applyingA = computeApplying(caseA.separation, 180, caseA.signedDiff, 1, 0);
  const applyingB = computeApplying(caseB.separation, 180, caseB.signedDiff, 1, 0);
  assert.equal(applyingA, true);
  assert.equal(applyingB, false);
});

// 3. conjunction applying
test('computeApplying: conjunction applying (gap closing)', () => {
  const { signedDiff, separation } = normalizeSeparation(2, 0); // separation 2, signedDiff 2
  const applying = computeApplying(separation, 0, signedDiff, 0, 1); // B catching up to A
  assert.equal(applying, true);
});

// 4. conjunction separating
test('computeApplying: conjunction separating (gap widening)', () => {
  const { signedDiff, separation } = normalizeSeparation(2, 0);
  const applying = computeApplying(separation, 0, signedDiff, 1, 0); // A pulling away
  assert.equal(applying, false);
});

// 5. opposition applying and separating
test('computeApplying: opposition applying and separating cases', () => {
  const { signedDiff, separation } = normalizeSeparation(170, 0); // separation 170, target 180
  const applying = computeApplying(separation, 180, signedDiff, 1, 0);
  const separating = computeApplying(separation, 180, signedDiff, 0, 1);
  assert.equal(applying, true);
  assert.equal(separating, false);
});

// 6. retrograde body case
test('computeApplying: retrograde body (negative speed) is not naively assumed applying', () => {
  const { signedDiff, separation } = normalizeSeparation(2, 0); // separation 2, conjunction target 0
  // speedB retrograde but relative rate still widens the gap -> separating.
  const applying = computeApplying(separation, 0, signedDiff, 1, -0.5);
  assert.equal(applying, false);
});

// 7. null speeds -> null
test('computeApplying: returns null when either speed is null or undefined', () => {
  assert.equal(computeApplying(2, 0, 2, null, 1), null);
  assert.equal(computeApplying(2, 0, 2, 1, undefined), null);
  assert.equal(computeApplying(2, 0, 2, null, null), null);
});

// 8. stationary / equal speed -> null
test('computeApplying: equal nonzero speeds (stationary sepRate) return null, not false', () => {
  const applying = computeApplying(2, 0, 2, 1, 1);
  assert.equal(applying, null);
});

// 9. exact-hit boundary uses epsilon, not strict ===
test('computeApplying: orbNow of 1e-9 (below EPSILON_DEG) returns null', () => {
  assert.ok(1e-9 !== 0);
  const applying = computeApplying(90 + 1e-9, 90, 90, 1, 0);
  assert.equal(applying, null);
  assert.ok(1e-9 < EPSILON_DEG);
});

// 10. orbOverrides changes which pairs qualify
test('calculateNatalAspects: tightening square orb from 8 to 2 drops a pair 5deg from exact', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 85, speed: 0 }, // separation 85, square target 90, orb 5
  ];

  const withDefaultOrb = calculateNatalAspects(bodies, {});
  const squareDefault = withDefaultOrb.find((a) => a.aspect === 'square');
  assert.ok(squareDefault, 'square should qualify under default orb 8');

  const withTightOrb = calculateNatalAspects(bodies, { orbOverrides: { square: 2 } });
  const squareTight = withTightOrb.find((a) => a.aspect === 'square');
  assert.equal(squareTight, undefined, 'square should be dropped once orb tightened to 2');
});

// 11. includeMinor false never returns minor aspects, even at exact minor angle
test('calculateNatalAspects: includeMinor false never returns minor aspects even at exact minor angle', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 30, speed: 0 }, // exact semisextile
  ];

  const aspects = calculateNatalAspects(bodies, { includeMinor: false });
  assert.ok(aspects.every((a) => a.category !== 'minor'));
  assert.ok(!aspects.some((a) => a.aspect === 'semisextile'));
});

// 12. includeSouthNode gating
test('calculateNatalAspects: South Node excluded by default, included when includeSouthNode true', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'South Node', longitude: 0, speed: 0 },
  ];

  const withoutSouthNode = calculateNatalAspects(bodies, {});
  assert.equal(withoutSouthNode.length, 0);

  const withSouthNode = calculateNatalAspects(bodies, { includeSouthNode: true });
  assert.ok(withSouthNode.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));
});
