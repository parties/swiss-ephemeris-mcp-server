import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPSILON_DEG,
  ANGLE_BODIES,
  ASPECTABLE_ANGLES,
  DEFAULT_ORBS,
  ORB_CLASSES,
  BODY_ORB_CLASS,
  normalizeSeparation,
  computeApplying,
  calculateNatalAspects,
  calculateHouseOverlay,
  resolveChartPoint,
  toAspectBody,
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

// A chart's points are split across three buckets by how they were computed. Resolving a
// name from the wrong bucket is a silent drop rather than an error, which is how Part of
// Fortune went missing from synastry angle_aspects (#8) - these lock the resolver down.
// Shape-only stand-in: arbitrary longitudes, no birth data, so it belongs to nobody.
const BUCKETED_CHART = {
  planets: { Sun: { longitude: 10, speed: 0.98 } },
  chart_points: { Ascendant: { longitude: 100 } },
  additional_points: { 'Part of Fortune': { longitude: 200 } },
};

test('resolveChartPoint finds a point in any of the three buckets', () => {
  assert.equal(resolveChartPoint(BUCKETED_CHART, 'Sun').longitude, 10);
  assert.equal(resolveChartPoint(BUCKETED_CHART, 'Ascendant').longitude, 100);
  assert.equal(resolveChartPoint(BUCKETED_CHART, 'Part of Fortune').longitude, 200);
});

test('resolveChartPoint returns null for a name no bucket carries', () => {
  assert.equal(resolveChartPoint(BUCKETED_CHART, 'Vertex'), null);
  assert.equal(resolveChartPoint({}, 'Sun'), null);
});

test('toAspectBody carries planet speed through and nulls it for static points', () => {
  assert.deepEqual(toAspectBody(BUCKETED_CHART, 'Sun'), { name: 'Sun', longitude: 10, speed: 0.98 });
  // Angles and derived points do not move on their own, so applying/separating is undefined
  // for them - a null speed is what makes computeApplying return null downstream.
  assert.deepEqual(toAspectBody(BUCKETED_CHART, 'Ascendant'), { name: 'Ascendant', longitude: 100, speed: null });
  assert.deepEqual(toAspectBody(BUCKETED_CHART, 'Part of Fortune'), { name: 'Part of Fortune', longitude: 200, speed: null });
  assert.equal(toAspectBody(BUCKETED_CHART, 'Vertex'), null);
});

// synastry-overlay.integration.test.js derives its expected angle set from ANGLE_BODIES, so
// it cannot go stale - but it also cannot catch the constant itself gaining a wrong member.
// This is the assertion that would fail if someone added a planet to it.
test('ANGLE_BODIES membership is pinned', () => {
  assert.deepEqual(ANGLE_BODIES, ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Part of Fortune']);
});

// SUP-159: DSC=ASC+180 and IC=MC+180, so aspecting all four axis points double-counts every
// contact under two labels. Only these three ever enter aspect pair-matching; DSC/IC remain
// legitimate computed points via ANGLE_BODIES (chart_points/include_angles output).
test('ASPECTABLE_ANGLES membership is pinned', () => {
  assert.deepEqual(ASPECTABLE_ANGLES, ['Ascendant', 'Midheaven', 'Part of Fortune']);
});

test('calculateNatalAspects never aspects DSC/IC even when explicitly present in the body list', () => {
  const bodies = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Descendant', longitude: 180, speed: null },
    { name: 'Midheaven', longitude: 90, speed: null },
    { name: 'IC', longitude: 270, speed: null },
  ];
  const aspects = calculateNatalAspects(bodies, { includeAngles: true });
  const nonAspectable = new Set(['IC', 'Descendant']);
  assert.ok(
    !aspects.some((a) => nonAspectable.has(a.body_a) || nonAspectable.has(a.body_b)),
    'DSC/IC should never appear as an aspected body'
  );
});

// SUP-158: `point` gets its own, tighter numbers - 3 deg for the majors, 2 deg for sextile.
// Minor-aspect orbs are unspecified by the ticket, so `point` keeps the `body` minor values.
test('ORB_CLASSES.point is tighter than body for majors/sextile, same for minors', () => {
  assert.deepEqual(ORB_CLASSES.body, DEFAULT_ORBS);
  assert.deepEqual(ORB_CLASSES.point, {
    ...DEFAULT_ORBS,
    conjunction: 3,
    opposition: 3,
    trine: 3,
    square: 3,
    sextile: 2,
  });
});

test('BODY_ORB_CLASS maps every angle body (including Part of Fortune) and Vertex to the point class', () => {
  for (const name of ANGLE_BODIES) {
    assert.equal(BODY_ORB_CLASS[name], 'point');
  }
  assert.equal(BODY_ORB_CLASS.Vertex, 'point');
});

test('calculateNatalAspects: a point-class pair is held to the tighter point orb even though a same-separation body pair still matches', () => {
  const bodyPair = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 95, speed: 13 }, // 95 deg -> square, orb 5 (within body's 8)
  ];
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Part of Fortune', longitude: 95, speed: null }, // same 5-deg orb, exceeds point's 3
  ];

  const [bodyAspect] = calculateNatalAspects(bodyPair, { includeAngles: true });
  assert.equal(bodyAspect.aspect, 'square');
  assert.equal(bodyAspect.orb_allowed, DEFAULT_ORBS.square);

  assert.equal(calculateNatalAspects(pointPair, { includeAngles: true }).length, 0);
});

test('calculateNatalAspects: a point-class pair within the tighter 3-deg orb still matches', () => {
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Part of Fortune', longitude: 92, speed: null }, // square, orb 2 - within point's 3
  ];
  const [pointAspect] = calculateNatalAspects(pointPair, { includeAngles: true });
  assert.equal(pointAspect.aspect, 'square');
  assert.equal(pointAspect.orb_allowed, 3);
});

test('a pair spanning body and point classes is held to the stricter (point) orb', () => {
  const mixedPair = [
    { name: 'Pluto', longitude: 0, speed: 0 },
    { name: 'Part of Fortune', longitude: 93, speed: null }, // square, orb 3 - fails point's 3? exactly at boundary
  ];
  const [aspect] = calculateNatalAspects(mixedPair, { includeAngles: true });
  assert.equal(aspect.orb_allowed, 3);

  const justOutside = calculateNatalAspects(
    [
      { name: 'Pluto', longitude: 0, speed: 0 },
      { name: 'Part of Fortune', longitude: 93.01, speed: null },
    ],
    { includeAngles: true }
  );
  assert.equal(justOutside.length, 0, 'a body-class partner cannot widen a point-class orb past 3 deg');
});

test('orb_overrides per-class shape tightens point without touching body', () => {
  const bodyPair = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 91.5, speed: 0 }, // square, orb 1.5 - within both defaults
  ];
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Part of Fortune', longitude: 91.5, speed: null },
  ];
  const opts = { orbOverrides: { point: { square: 1 } }, includeAngles: true };

  assert.ok(calculateNatalAspects(bodyPair, opts).some((a) => a.aspect === 'square'), 'body class is unaffected by a point-only override');
  assert.ok(!calculateNatalAspects(pointPair, opts).some((a) => a.aspect === 'square'), 'point class picks up its own override');
});

test('orb_overrides per-class shape loosens point without touching body', () => {
  const bodyPair = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 94, speed: 0 }, // square, orb 4 - exceeds default body of... within body's 8, but beyond point's default 3
  ];
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Part of Fortune', longitude: 94, speed: null },
  ];
  const opts = { orbOverrides: { point: { square: 5 } }, includeAngles: true };

  assert.ok(!calculateNatalAspects(pointPair, { includeAngles: true }).some((a) => a.aspect === 'square'), 'sanity: 4-deg orb exceeds point default of 3');
  assert.ok(calculateNatalAspects(pointPair, opts).some((a) => a.aspect === 'square'), 'point class picks up the loosened override');
  assert.ok(calculateNatalAspects(bodyPair, opts).some((a) => a.aspect === 'square'), 'body class still matches its own (untouched) default');
});

test('orb_overrides flat shape still applies globally across both classes', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 95, speed: 0 }, // square, 5-degree orb
  ];
  const points = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Part of Fortune', longitude: 95, speed: null },
  ];

  const tightened = { orbOverrides: { square: 2 }, includeAngles: true };
  assert.ok(!calculateNatalAspects(bodies, tightened).some((a) => a.aspect === 'square'));
  assert.ok(!calculateNatalAspects(points, tightened).some((a) => a.aspect === 'square'));
});
