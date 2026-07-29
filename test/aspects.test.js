import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPSILON_DEG,
  ANGLE_BODIES,
  ASPECTABLE_ANGLES,
  DEFAULT_ORBS,
  ORB_CLASSES,
  ORB_MODELS,
  BODY_ORB_CLASS,
  MAJOR_ASPECTS,
  MINOR_ASPECTS,
  MOIETIES,
  ASPECT_MULTIPLIERS,
  normalizeSeparation,
  computeApplying,
  calculateNatalAspects,
  calculateCrossChartAspects,
  calculateHouseOverlay,
  resolveChartPoint,
  toAspectBody,
  invalidOrbOverrideKeys,
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

// These fixtures use body names ('A', 'B', 'C') that aren't in MOIETIES, so they're pinned
// to the class model explicitly - the moiety default can't resolve orbs for unknown names.
test('orb_overrides changes qualifying pairs (tightening square drops a 5-degree-orb pair)', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 95, speed: 0 }, // 95 deg separation, square orb = 5
  ];

  const withDefaultOrb = calculateNatalAspects(bodies, { orbModel: 'class' });
  assert.ok(withDefaultOrb.some((a) => a.aspect === 'square'));

  const withTightOrb = calculateNatalAspects(bodies, { orbModel: 'class', orbOverrides: { square: 2 } });
  assert.ok(!withTightOrb.some((a) => a.aspect === 'square'));
});

test('includeMinor gating: false never returns minor aspects even at exact minor angle', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 72, speed: 0 }, // exact quintile
  ];

  const withoutMinor = calculateNatalAspects(bodies, { orbModel: 'class', includeMinor: false });
  assert.ok(!withoutMinor.some((a) => a.aspect === 'quintile'));

  const withMinor = calculateNatalAspects(bodies, { orbModel: 'class', includeMinor: true });
  assert.ok(withMinor.some((a) => a.aspect === 'quintile'));
});

// SUP-224: include_south_node gating moved to resolveAspectBodies (index.js) so the natal
// and cross-chart callers share one gate. calculateNatalAspects trusts its input as-is now,
// regardless of includeSouthNode.
test('calculateNatalAspects applies no South Node gating - it trusts its input list as-is', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'South Node', longitude: 0, speed: null }, // exact conjunction
  ];

  const aspects = calculateNatalAspects(bodies, { orbModel: 'class', includeSouthNode: false });
  assert.ok(aspects.some((a) => a.body_a === 'South Node' || a.body_b === 'South Node'));
});

test('aspects are sorted by orb ascending', () => {
  const bodies = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 3, speed: 0 },
    { name: 'C', longitude: 61, speed: 0 },
  ];
  const aspects = calculateNatalAspects(bodies, { orbModel: 'class' });
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

// SUP-224: the DSC/IC exclusion moved to resolveAspectBodies (index.js) - see
// calculate-aspects.integration.test.js for the tool-boundary version of this assertion.
// calculateNatalAspects itself has no body-name special-casing left; it aspects whatever
// it's given.
test('calculateNatalAspects has no DSC/IC special-casing - it trusts its input list as-is', () => {
  const bodies = [
    { name: 'Ascendant', longitude: 0, speed: null },
    { name: 'Descendant', longitude: 180, speed: null },
    { name: 'Midheaven', longitude: 90, speed: null },
    { name: 'IC', longitude: 270, speed: null },
  ];
  const aspects = calculateNatalAspects(bodies, { includeAngles: true });
  const nonAspectable = new Set(['IC', 'Descendant']);
  assert.ok(
    aspects.some((a) => nonAspectable.has(a.body_a) || nonAspectable.has(a.body_b)),
    'IC/Descendant are aspected here because gating is the caller\'s responsibility now'
  );
});

// SUP-168: `point` split into `angle` (ASC/MC/IC/DSC - 5/4/3/1.5/1.5/1) and `derived`
// (Part of Fortune/Vertex - 3/2/2/1). `angle` is wider than the old `point` class because
// ASC/MC sensitivity is birth-time-error propagation, not aspect strength; `derived` stays
// tight because it compounds derivation from other points.
test('ORB_CLASSES.angle and ORB_CLASSES.derived match the split tables; body is unchanged', () => {
  assert.deepEqual(ORB_CLASSES.body, DEFAULT_ORBS);
  assert.deepEqual(ORB_CLASSES.angle, {
    conjunction: 5, opposition: 5,
    square: 4,
    trine: 3, sextile: 3,
    semisextile: 1.5, quincunx: 1.5,
    semisquare: 1.5, sesquiquadrate: 1.5,
    quintile: 1, biquintile: 1,
  });
  assert.deepEqual(ORB_CLASSES.derived, {
    conjunction: 3, opposition: 3,
    square: 2,
    trine: 2, sextile: 2,
    semisextile: 1, semisquare: 1, sesquiquadrate: 1, quincunx: 1, quintile: 1, biquintile: 1,
  });
});

test('BODY_ORB_CLASS maps ASC/MC/IC/DSC to angle and Part of Fortune/Vertex to derived', () => {
  for (const name of ['Ascendant', 'Midheaven', 'IC', 'Descendant']) {
    assert.equal(BODY_ORB_CLASS[name], 'angle');
  }
  assert.equal(BODY_ORB_CLASS['Part of Fortune'], 'derived');
  assert.equal(BODY_ORB_CLASS.Vertex, 'derived');
});

test('angle orb class is mirror-symmetric (precondition for lossless IC/DSC derivation)', () => {
  const a = ORB_CLASSES.angle;
  assert.equal(a.conjunction, a.opposition);
  assert.equal(a.sextile, a.trine);
  assert.equal(a.semisextile, a.quincunx);
  assert.equal(a.semisquare, a.sesquiquadrate);
  // square self-mirrors; quintile/biquintile have no mirror partner (intentionally unconstrained)
});

test('every orb class ranks all majors wider than all minors', () => {
  for (const [name, orbs] of Object.entries(ORB_CLASSES)) {
    const majors = Object.keys(MAJOR_ASPECTS).map((k) => orbs[k]);
    const minors = Object.keys(MINOR_ASPECTS).map((k) => orbs[k]);
    assert.ok(Math.max(...minors) < Math.min(...majors), `${name}: max minor must be < min major`);
  }
});

// These orb-class tests exercise 'class'-model behavior specifically (per-class tables),
// which still exists but is no longer the default - pinned explicitly.
test('calculateNatalAspects: an angle/derived pair is held to the tighter side even though a same-separation body pair still matches', () => {
  const bodyPair = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 95, speed: 13 }, // 95 deg -> square, orb 5 (within body's 8)
  ];
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null }, // angle square = 4
    { name: 'Part of Fortune', longitude: 95, speed: null }, // derived square = 2; min(4,2)=2, orb 5 exceeds
  ];

  const [bodyAspect] = calculateNatalAspects(bodyPair, { orbModel: 'class', includeAngles: true });
  assert.equal(bodyAspect.aspect, 'square');
  assert.equal(bodyAspect.orb_allowed, DEFAULT_ORBS.square);

  assert.equal(calculateNatalAspects(pointPair, { orbModel: 'class', includeAngles: true }).length, 0);
});

test('calculateNatalAspects: an angle/derived pair within the tighter derived orb still matches', () => {
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null }, // angle square = 4
    { name: 'Part of Fortune', longitude: 92, speed: null }, // square, orb 2 - within derived's 2
  ];
  const [pointAspect] = calculateNatalAspects(pointPair, { orbModel: 'class', includeAngles: true });
  assert.equal(pointAspect.aspect, 'square');
  assert.equal(pointAspect.orb_allowed, 2);
});

test('a pair spanning body and derived classes is held to the stricter (derived) orb', () => {
  const mixedPair = [
    { name: 'Pluto', longitude: 0, speed: 0 }, // body square = 8
    { name: 'Part of Fortune', longitude: 92, speed: null }, // derived square = 2, orb 2 - exactly at boundary
  ];
  const [aspect] = calculateNatalAspects(mixedPair, { orbModel: 'class', includeAngles: true });
  assert.equal(aspect.orb_allowed, 2);

  const justOutside = calculateNatalAspects(
    [
      { name: 'Pluto', longitude: 0, speed: 0 },
      { name: 'Part of Fortune', longitude: 92.01, speed: null },
    ],
    { orbModel: 'class', includeAngles: true }
  );
  assert.equal(justOutside.length, 0, 'a body-class partner cannot widen a derived-class orb past 2 deg');
});

test('orb_overrides per-class shape tightens derived without touching body', () => {
  const bodyPair = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 91.5, speed: 0 }, // square, orb 1.5 - within body's default (8)
  ];
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null }, // angle square = 4, untouched
    { name: 'Part of Fortune', longitude: 91.5, speed: null }, // derived square overridden to 1
  ];
  const opts = { orbModel: 'class', orbOverrides: { derived: { square: 1 } }, includeAngles: true };

  assert.ok(calculateNatalAspects(bodyPair, opts).some((a) => a.aspect === 'square'), 'body class is unaffected by a derived-only override');
  assert.ok(!calculateNatalAspects(pointPair, opts).some((a) => a.aspect === 'square'), 'derived class picks up its own override, tightening the min below 1.5');
});

test('orb_overrides per-class shape loosens derived without touching body', () => {
  const bodyPair = [
    { name: 'A', longitude: 0, speed: 0 },
    { name: 'B', longitude: 94, speed: 0 }, // square, orb 4 - within body's default (8)
  ];
  const pointPair = [
    { name: 'Ascendant', longitude: 0, speed: null }, // angle square = 4
    { name: 'Part of Fortune', longitude: 94, speed: null }, // derived square default = 2
  ];
  const opts = { orbModel: 'class', orbOverrides: { derived: { square: 5 } }, includeAngles: true };

  assert.ok(!calculateNatalAspects(pointPair, { orbModel: 'class', includeAngles: true }).some((a) => a.aspect === 'square'), 'sanity: 4-deg orb exceeds min(angle 4, derived 2) = 2');
  assert.ok(calculateNatalAspects(pointPair, opts).some((a) => a.aspect === 'square'), 'derived class picks up the loosened override, raising the min to angle\'s 4');
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

  const tightened = { orbModel: 'class', orbOverrides: { square: 2 }, includeAngles: true };
  assert.ok(!calculateNatalAspects(bodies, tightened).some((a) => a.aspect === 'square'));
  assert.ok(!calculateNatalAspects(points, tightened).some((a) => a.aspect === 'square'));
});

test('MOIETIES: mirror pairs are equal (IC=Midheaven, Descendant=Ascendant)', () => {
  assert.equal(MOIETIES.IC, MOIETIES.Midheaven);
  assert.equal(MOIETIES.Descendant, MOIETIES.Ascendant);
});

test('MOIETIES: Sun..Saturn match the halved classical values exactly', () => {
  assert.equal(MOIETIES.Sun, 7.5);
  assert.equal(MOIETIES.Moon, 6);
  assert.equal(MOIETIES.Mercury, 3.5);
  assert.equal(MOIETIES.Venus, 3.5);
  assert.equal(MOIETIES.Mars, 4);
  assert.equal(MOIETIES.Jupiter, 4.5);
  assert.equal(MOIETIES.Saturn, 4.5);
});

test('ASPECT_MULTIPLIERS: exact keys and values', () => {
  assert.deepEqual(ASPECT_MULTIPLIERS, {
    conjunction: 1.0,
    opposition: 1.0,
    trine: 1.0,
    square: 1.0,
    sextile: 0.75,
    semisextile: 0.375,
    semisquare: 0.375,
    sesquiquadrate: 0.375,
    quincunx: 0.375,
    quintile: 0.375,
    biquintile: 0.375,
  });
});

// SUP-179/T3: orb_model default flipped to 'moiety'. Unset must behave exactly as explicit
// 'moiety', and 'class' remains fully supported as an explicit opt-in.
test('orb_model seam: unset and explicit "moiety" produce byte-identical natal aspect output', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 90, speed: 12 },
    { name: 'Ascendant', longitude: 3, speed: null },
    { name: 'Part of Fortune', longitude: 91, speed: null },
  ];

  const unset = calculateNatalAspects(bodies, { includeAngles: true });
  const explicitMoiety = calculateNatalAspects(bodies, { includeAngles: true, orbModel: 'moiety' });

  assert.deepEqual(unset, explicitMoiety);
  assert.ok(unset.length > 0, 'sanity: this fixture should actually produce aspects');
});

test('orb_model seam: unset and explicit "moiety" produce byte-identical cross-chart aspect output', () => {
  const bodiesA = [{ name: 'Sun', longitude: 0, speed: 1 }];
  const bodiesB = [{ name: 'Moon', longitude: 90, speed: 12 }];

  const unset = calculateCrossChartAspects(bodiesA, bodiesB, {});
  const explicitMoiety = calculateCrossChartAspects(bodiesA, bodiesB, { orbModel: 'moiety' });

  assert.deepEqual(unset, explicitMoiety);
  assert.ok(unset.length > 0, 'sanity: this fixture should actually produce aspects');
});

test('orb_model rejects unknown values', () => {
  assert.throws(
    () => calculateNatalAspects([], { orbModel: 'bogus' }),
    /Unknown orb_model/
  );
});

test('ORB_MODELS exports exactly the two known model names', () => {
  assert.deepEqual(ORB_MODELS, ['class', 'moiety']);
});

// SUP-175/T3: moiety pair-orb resolver. orbAllowed = (MOIETIES[a] + MOIETIES[b]) *
// ASPECT_MULTIPLIERS[aspect], replacing the class-table min() lookup when orbModel is 'moiety'.
test('orb_model "moiety": Sun-Moon conjunction pair orb is 13.5deg', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 0, speed: 12 },
  ];
  const [match] = calculateNatalAspects(bodies, { orbModel: 'moiety' });

  assert.equal(match.aspect, 'conjunction');
  assert.equal(match.orb_allowed, 13.5);
});

test('orb_model "moiety": Sun-Ascendant conjunction pair orb is 10deg', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Ascendant', longitude: 0, speed: null },
  ];
  const [match] = calculateNatalAspects(bodies, { orbModel: 'moiety', includeAngles: true });

  assert.equal(match.aspect, 'conjunction');
  assert.equal(match.orb_allowed, 10);
});

// Smaller than Sun-Ascendant (10deg) even though Pluto is the outer body — class mode
// can't express this because ASC's angle-class orb is fixed regardless of partner (SUP-169).
test('orb_model "moiety": Pluto-Ascendant conjunction pair orb is 5deg', () => {
  const bodies = [
    { name: 'Pluto', longitude: 0, speed: 0.003 },
    { name: 'Ascendant', longitude: 0, speed: null },
  ];
  const [match] = calculateNatalAspects(bodies, { orbModel: 'moiety', includeAngles: true });

  assert.equal(match.aspect, 'conjunction');
  assert.equal(match.orb_allowed, 5);
});

test('orb_model "moiety": Sun-Moon sextile pair orb uses the 0.75 multiplier -> 10.125deg', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 60, speed: 12 },
  ];
  const [match] = calculateNatalAspects(bodies, { orbModel: 'moiety' });

  assert.equal(match.aspect, 'sextile');
  assert.equal(match.orb_allowed, 10.125);
});

test('orb_model "moiety" (default) is unaffected by explicitly requesting it', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 0, speed: 12 },
  ];
  const explicitMoiety = calculateNatalAspects(bodies, { orbModel: 'moiety' });
  const defaulted = calculateNatalAspects(bodies);

  assert.deepEqual(explicitMoiety, defaulted);
  assert.equal(explicitMoiety[0].orb_allowed, 13.5, 'sanity: moiety-mode Sun-Moon conjunction orb is (7.5+6)*1.0');
});

test('orb_model "class" is unaffected by the moiety resolver', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 0, speed: 12 },
  ];
  const explicitClass = calculateNatalAspects(bodies, { orbModel: 'class' });

  assert.equal(explicitClass[0].orb_allowed, 8, 'sanity: class-mode body/body conjunction orb is untouched');
});

// SUP-176/T4: in moiety mode, orb_overrides takes the two-knob shape
// { moieties: {...}, multipliers: {...} } instead of the flat/per-class shape.
test('orb_model "moiety": a moiety override widens a pair orb', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 0, speed: 12 },
  ];
  const [match] = calculateNatalAspects(bodies, {
    orbModel: 'moiety',
    orbOverrides: { moieties: { Sun: 10 } },
  });

  assert.equal(match.aspect, 'conjunction');
  assert.equal(match.orb_allowed, 16, '(10 + 6) * 1.0');
});

test('orb_model "moiety": a multiplier override changes a pair orb', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 150, speed: 12 },
  ];
  const [match] = calculateNatalAspects(bodies, {
    orbModel: 'moiety',
    includeMinor: true,
    orbOverrides: { multipliers: { quincunx: 0.5 } },
  });

  assert.equal(match.aspect, 'quincunx');
  assert.equal(match.orb_allowed, 6.75, '(7.5 + 6) * 0.5');
});

test('orb_model "moiety": unset moieties/multipliers fall back to the default tables', () => {
  const bodies = [
    { name: 'Sun', longitude: 0, speed: 1 },
    { name: 'Moon', longitude: 0, speed: 12 },
  ];
  const [match] = calculateNatalAspects(bodies, {
    orbModel: 'moiety',
    orbOverrides: { moieties: { Mars: 1 } },
  });

  assert.equal(match.orb_allowed, 13.5, 'Sun/Moon unaffected by a Mars-only override');
});

test('invalidOrbOverrideKeys: valid moiety-shape overrides are accepted in moiety mode', () => {
  const invalid = invalidOrbOverrideKeys(
    { moieties: { Sun: 8, Ascendant: 3 }, multipliers: { quincunx: 0.3, sextile: 0.5 } },
    'moiety'
  );
  assert.deepEqual(invalid, []);
});

test('invalidOrbOverrideKeys: a class-shape override is rejected in moiety mode', () => {
  const invalid = invalidOrbOverrideKeys({ square: 2 }, 'moiety');
  assert.deepEqual(invalid, ['square']);

  const invalidPerClass = invalidOrbOverrideKeys({ angle: { square: 4 } }, 'moiety');
  assert.deepEqual(invalidPerClass, ['angle']);
});

test('invalidOrbOverrideKeys: a moiety-shape override is rejected in class mode', () => {
  const invalid = invalidOrbOverrideKeys(
    { moieties: { Sun: 8 }, multipliers: { quincunx: 0.3 } },
    'class'
  );
  assert.deepEqual(invalid.sort(), ['moieties', 'multipliers']);
});

test('invalidOrbOverrideKeys: unknown body/aspect key rejected in moiety mode', () => {
  const invalid = invalidOrbOverrideKeys(
    { moieties: { NotABody: 1 }, multipliers: { notAnAspect: 0.5 } },
    'moiety'
  );
  assert.deepEqual(invalid.sort(), ['NotABody', 'notAnAspect']);
});

// SUP-177/T5: regression invariants for the moiety orb system. These guard the
// *relationships* the constants must preserve, not just one formula output, so a future
// edit to MOIETIES/ASPECT_MULTIPLIERS that quietly breaks the ordering gets caught even if
// no single spot-check value changes.

const REPRESENTATIVE_PAIRS = [
  ['Sun', 'Sun'],
  ['Pluto', 'Pluto'],
  ['Sun', 'Moon'],
  ['Moon', 'Saturn'],
  ['Mercury', 'Venus'],
  ['Sun', 'Ascendant'],
  ['Pluto', 'Ascendant'],
];

// Places body A at 0deg and body B exactly on the target aspect angle, so the engine's
// only match is that aspect - orb_allowed then reflects the real matchAspectsForPair path
// (not a re-derivation of the formula in the test).
function pairOrbAllowed(nameA, nameB, aspectName) {
  const targetAngle = MAJOR_ASPECTS[aspectName] ?? MINOR_ASPECTS[aspectName];
  const bodies = [
    { name: nameA, longitude: 0, speed: 1 },
    { name: nameB, longitude: targetAngle, speed: 1 },
  ];
  const [match] = calculateNatalAspects(bodies, { orbModel: 'moiety', includeMinor: true, includeAngles: true });
  return match.orb_allowed;
}

test('moiety invariant: every representative pair keeps every minor-aspect orb narrower than every major-aspect orb', () => {
  for (const [a, b] of REPRESENTATIVE_PAIRS) {
    const minorOrbs = Object.keys(MINOR_ASPECTS).map((aspect) => pairOrbAllowed(a, b, aspect));
    const majorOrbs = Object.keys(MAJOR_ASPECTS).map((aspect) => pairOrbAllowed(a, b, aspect));
    const maxMinor = Math.max(...minorOrbs);
    const minMajor = Math.min(...majorOrbs);
    assert.ok(
      maxMinor < minMajor,
      `${a}-${b}: max minor orb ${maxMinor} should be < min major orb ${minMajor}`
    );
  }
});

// AstrologyAdvisor addition: a same-pair-only test can't catch a cross-pair regression
// like the one SUP-168 caught. This compares a major aspect on one pair against a minor
// aspect on an entirely different, weaker-moiety pair.
test('moiety invariant: cross-body minor orb stays narrower than an unrelated major orb (Moon-Saturn square vs Mercury-Venus quincunx)', () => {
  const majorOrb = pairOrbAllowed('Moon', 'Saturn', 'square');
  const minorOrb = pairOrbAllowed('Mercury', 'Venus', 'quincunx');

  assert.equal(majorOrb, 10.5, '(6 + 4.5) * 1.0');
  assert.equal(minorOrb, 2.625, '(3.5 + 3.5) * 0.375');
  assert.ok(minorOrb < majorOrb);
});

test('moiety invariant: mirror symmetry - Sun-Ascendant pair orb equals Sun-Descendant pair orb', () => {
  // Descendant is excluded from aspect matching (ASPECTABLE_ANGLES), so this is checked
  // directly against the moiety formula rather than through calculateNatalAspects.
  const ascOrb = (MOIETIES.Sun + MOIETIES.Ascendant) * ASPECT_MULTIPLIERS.conjunction;
  const dscOrb = (MOIETIES.Sun + MOIETIES.Descendant) * ASPECT_MULTIPLIERS.conjunction;

  assert.equal(ascOrb, dscOrb);
});

test('moiety invariant: Sun-Ascendant conjunction orb is wider than Pluto-Ascendant conjunction orb (SUP-169 motivating case)', () => {
  const sunAscOrb = pairOrbAllowed('Sun', 'Ascendant', 'conjunction');
  const plutoAscOrb = pairOrbAllowed('Pluto', 'Ascendant', 'conjunction');

  assert.equal(sunAscOrb, 10);
  assert.equal(plutoAscOrb, 5);
  assert.ok(sunAscOrb > plutoAscOrb);
});
