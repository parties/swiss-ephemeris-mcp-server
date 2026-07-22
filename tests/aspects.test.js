import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPSILON_DEG,
  normalizeSeparation,
  computeApplying,
  calculateNatalAspects,
} from '../lib/aspects.js';

// --- normalizeSeparation ---

test('1: normalizeSeparation wraparound 350→10 gives separation 20 not 340', () => {
  const { separation } = normalizeSeparation(350, 10);
  assert.ok(Math.abs(separation - 20) < EPSILON_DEG, `expected 20, got ${separation}`);
});

test('2: normalization seam lock-in near 179 degrees', () => {
  // Approaching 180 from slightly below (positive signedDiff side)
  const posResult = normalizeSeparation(0, 179.9999);
  // Approaching 180 from slightly above (negative signedDiff side)
  const negResult = normalizeSeparation(0, 180.0001);

  // Both separations should be near 180
  assert.ok(posResult.separation < 180, `pos separation should be <180, got ${posResult.separation}`);
  assert.ok(negResult.separation < 180, `neg separation should be <180, got ${negResult.separation}`);

  // signedDiffs should have opposite signs
  assert.ok(posResult.signedDiff > 0 || posResult.signedDiff < 0, 'signedDiff should be non-zero (pos side)');
  assert.ok(negResult.signedDiff > 0 || negResult.signedDiff < 0, 'signedDiff should be non-zero (neg side)');

  // The two signedDiffs should differ in sign, confirming each side of the seam
  assert.notEqual(Math.sign(posResult.signedDiff), Math.sign(negResult.signedDiff));
});

// --- computeApplying ---

test('3: applying conjunction — bodies moving toward each other', () => {
  // A at 10, B at 12, signedDiff = -2 (A-B), separation = 2, orb = 2 from 0
  // speedA=1, speedB=1.1 → dRate = -0.1, sepRate = sign(-2)*(-0.1) = 0.1
  // orbNow = 2-0 = 2, sign(2)*0.1 = 0.1 > 0 → false (separating)
  // Let's try speedA=1.1, speedB=1 → dRate=0.1, sepRate=sign(-2)*0.1=-0.1
  // sign(2)*(-0.1) = -0.1 < 0 → true (applying)
  const result = computeApplying(2, 0, -2, 1.1, 1.0);
  assert.equal(result, true, 'should be applying');
});

test('4: separating conjunction', () => {
  // A faster than B but moving away
  const result = computeApplying(2, 0, -2, 1.0, 1.1);
  assert.equal(result, false, 'should be separating');
});

test('5: applying opposition', () => {
  // A at 0 (stationary), B at 178 (2 deg before opposition), moving direct (+1).
  // signedDiff=lonA-lonB=-178, sepRate=sign(-178)*(0-1)=(-1)*(-1)=1
  // orbNow=178-180=-2, sign(-2)*1=-2<0 → true (applying)
  const { signedDiff, separation } = normalizeSeparation(0, 178);
  const result = computeApplying(separation, 180, signedDiff, 0, 1);
  assert.equal(result, true, `applying opposition: separation=${separation}`);
});

test('6: retrograde body — one negative speed', () => {
  // Sun at 10 (speed +1), Mercury at 8 (speed -0.5, retrograde)
  // signedDiff = lonA - lonB = 10-8=2, separation=2, conjunction
  // dRate = 1 - (-0.5) = 1.5, sepRate = sign(2)*1.5 = 1.5
  // orbNow = 2-0=2, sign(2)*1.5=3 > 0 → false (separating)
  // Reversed: A at 8 retrograde, B at 10 direct
  // signedDiff = 8-10=-2, dRate=(-0.5)-1=-1.5, sepRate=sign(-2)*(-1.5)=1.5
  // sign(2)*1.5>0 → false (separating)
  // Let's verify applying: B retrograde catching up to A
  // A at 10, speed 0; B at 12, speed -1 (moving toward A)
  // signedDiff = 10-12=-2, sep=2, orbNow=2
  // dRate=0-(-1)=1, sepRate=sign(-2)*1=-1
  // sign(2)*(-1)=-2<0 → true (applying)
  const result = computeApplying(2, 0, -2, 0, -1);
  assert.equal(result, true, 'retrograde B applying toward A');
});

test('7: computeApplying returns null when speedA is null', () => {
  assert.equal(computeApplying(5, 0, 5, null, 1), null);
});

test('7b: computeApplying returns null when speedB is undefined', () => {
  assert.equal(computeApplying(5, 0, 5, 1, undefined), null);
});

test('8: stationary case (equal nonzero speeds) returns null, not false', () => {
  // speedA === speedB → dRate=0 → sepRate=0 → |sepRate|<EPSILON → null
  const result = computeApplying(5, 0, 5, 1.5, 1.5);
  assert.equal(result, null, 'equal speeds should give null (stationary relative motion)');
});

test('9: exact-hit epsilon boundary (orbNow=1e-9) returns null', () => {
  // orbNow = sep - targetAngle = 1e-9, which is < EPSILON_DEG (1e-6)
  const sep = 0 + 1e-9; // conjunction, orbNow=1e-9
  const result = computeApplying(sep, 0, 5, 1.0, 0.5);
  assert.equal(result, null, 'orbNow near zero (1e-9) should return null via epsilon check');
});

// --- calculateNatalAspects ---

function makeBodies(list) {
  return list.map(([name, longitude, speed]) => ({ name, longitude, speed }));
}

test('10: orbOverrides tightens square — drops pair outside new orb', () => {
  // Sun at 0, Moon at 95 → separation=95, square=90, orb=5
  // default square orb=8 → qualifies
  // override square to 2 → does NOT qualify (orb=5 > 2)
  const bodies = makeBodies([
    ['Sun', 0, 1.0],
    ['Moon', 95, 13.0],
  ]);

  const withDefault = calculateNatalAspects(bodies);
  const withOverride = calculateNatalAspects(bodies, { orbOverrides: { square: 2 } });

  const hasSquare = (arr) => arr.some((a) => a.aspect === 'square');
  assert.ok(hasSquare(withDefault), 'default orb should include the square');
  assert.ok(!hasSquare(withOverride), 'tightened orb should exclude the square');
});

test('11: includeMinor:false never returns minor aspects even at exact minor angle', () => {
  // Sun at 0, Moon at 30 → exact semisextile (30 deg)
  const bodies = makeBodies([
    ['Sun', 0, 1.0],
    ['Moon', 30, 13.0],
  ]);
  const aspects = calculateNatalAspects(bodies, { includeMinor: false });
  const hasMinor = aspects.some((a) => a.category === 'minor');
  assert.ok(!hasMinor, 'no minor aspects should appear when includeMinor=false');
});

test('12a: includeSouthNode:false (default) never includes South Node', () => {
  const bodies = makeBodies([
    ['Sun', 0, 1.0],
    ['South Node', 180, 0.053],
  ]);
  const aspects = calculateNatalAspects(bodies);
  const hasSN = aspects.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node');
  assert.ok(!hasSN, 'South Node should not appear by default');
});

test('12b: includeSouthNode:true includes South Node', () => {
  const bodies = makeBodies([
    ['Sun', 0, 1.0],
    ['South Node', 180, 0.053],
  ]);
  const aspects = calculateNatalAspects(bodies, { includeSouthNode: true });
  const hasSN = aspects.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node');
  assert.ok(hasSN, 'South Node should appear when includeSouthNode=true');
});
