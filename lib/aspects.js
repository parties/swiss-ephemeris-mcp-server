export const EPSILON_DEG = 1e-6;

export const MAJOR_ASPECTS = {
  conjunction: 0,
  sextile: 60,
  square: 90,
  trine: 120,
  opposition: 180,
};

export const MINOR_ASPECTS = {
  semisextile: 30,
  semisquare: 45,
  sesquiquadrate: 135,
  quincunx: 150,
  quintile: 72,
  biquintile: 144,
};

export const DEFAULT_ORBS = {
  conjunction: 8,
  opposition: 8,
  trine: 8,
  square: 8,
  sextile: 6,
  semisextile: 2,
  semisquare: 2,
  sesquiquadrate: 2,
  quincunx: 3,
  quintile: 2,
  biquintile: 2,
};

export const DEFAULT_ASPECT_BODIES = [
  'Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn',
  'Uranus', 'Neptune', 'Pluto', 'North Node', 'Lilith', 'Chiron',
  'Ceres', 'Pallas', 'Juno', 'Vesta',
];

export const ANGLE_BODIES = ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Part of Fortune'];

// DSC = ASC+180 and IC = MC+180, so aspecting all four axis points double-counts every
// contact under two labels. Only these three are used by the aspect-matching engine;
// DSC/IC stay in ANGLE_BODIES as legitimate computed chart points (include_angles output),
// they just never enter aspect pair-matching.
export const ASPECTABLE_ANGLES = ['Ascendant', 'Midheaven', 'Part of Fortune'];

// Point-class orbs: tighter than `body` because these are derived/sensitive points, not
// swetest bodies with their own independently-measured position. Minor-aspect orbs are
// unspecified by SUP-158 and stay at the `body` defaults.
const POINT_ORBS = {
  ...DEFAULT_ORBS,
  conjunction: 3,
  opposition: 3,
  trine: 3,
  square: 3,
  sextile: 2,
};

// Every body/point resolves to one orb class, whose table decides how wide an aspect's orb
// may be.
export const ORB_CLASSES = {
  body: DEFAULT_ORBS,
  point: POINT_ORBS,
};

// Angles and Part of Fortune are derived/sensitive points, not swetest bodies, so they get
// the `point` class. The Vertex is mapped here too (GH #6) even though no tool aspects it
// yet - it already lives in chart_points, and belongs to `point` the day a caller can reach
// it. Anything absent from this map defaults to `body`.
const POINT_CLASS_BODIES = [...ANGLE_BODIES, 'Vertex'];
export const BODY_ORB_CLASS = Object.fromEntries(POINT_CLASS_BODIES.map((name) => [name, 'point']));

function orbClassForBody(name) {
  return BODY_ORB_CLASS[name] ?? 'body';
}

// A chart's points live in three disjoint buckets depending on how they were computed:
// planets (swetest bodies, the only ones carrying speed), chart_points (angles, ARMC,
// Vertex), and additional_points (derived: South Node, Part of Fortune). Callers should
// never have to know which - resolving from the wrong bucket is a silent drop, not an
// error, which is how Part of Fortune went missing from synastry angle_aspects (#8).
export function resolveChartPoint(chart, name) {
  return chart.planets?.[name]
    ?? chart.chart_points?.[name]
    ?? chart.additional_points?.[name]
    ?? null;
}

// Aspect-engine shape for a named point, or null if the chart doesn't carry it. Only
// planets have a speed; angles and derived points are static, so `applying` correctly
// comes out null for them.
export function toAspectBody(chart, name) {
  const point = resolveChartPoint(chart, name);
  return point ? { name, longitude: point.longitude, speed: point.speed ?? null } : null;
}

export function normalizeSeparation(lonA, lonB) {
  let signedDiff = lonA - lonB;
  signedDiff = ((signedDiff % 360) + 360) % 360;
  if (signedDiff > 180) signedDiff -= 360;
  const separation = Math.abs(signedDiff);
  return { signedDiff, separation };
}

export function computeApplying(sep, targetAngle, signedDiff, speedA, speedB) {
  if (speedA == null || speedB == null) return null;

  const dRate = speedA - speedB;
  const sepRate = Math.sign(signedDiff) * dRate;
  if (Math.abs(sepRate) < EPSILON_DEG) return null;

  const orbNow = sep - targetAngle;
  if (Math.abs(orbNow) < EPSILON_DEG) return null;

  return Math.sign(orbNow) * sepRate < 0;
}

function matchAspectsForPair(a, b, aspectDefs, orbsByClass) {
  const { signedDiff, separation } = normalizeSeparation(a.longitude, b.longitude);
  const orbsA = orbsByClass[orbClassForBody(a.name)];
  const orbsB = orbsByClass[orbClassForBody(b.name)];
  const matches = [];

  for (const [aspectName, targetAngle] of Object.entries(aspectDefs)) {
    const category = MAJOR_ASPECTS.hasOwnProperty(aspectName) ? 'major' : 'minor';
    // A pair spanning two classes (e.g. a planet and an angle) is held to whichever side's
    // class is stricter, so a tight point-class orb can never be widened by its partner.
    const orbAllowed = Math.min(orbsA[aspectName], orbsB[aspectName]);
    const orb = Math.abs(separation - targetAngle);

    if (orb <= orbAllowed) {
      const applying = computeApplying(separation, targetAngle, signedDiff, a.speed, b.speed);
      matches.push({
        body_a: a.name,
        body_b: b.name,
        aspect: aspectName,
        category,
        aspect_angle: targetAngle,
        separation,
        orb,
        orb_allowed: orbAllowed,
        applying,
      });
    }
  }

  return matches;
}

// orb_overrides accepts two shapes, mergeable: a flat `{ aspectName: degrees }` map that
// applies to every class (today's shape, unchanged), and per-class `{ body: {...}, point:
// {...} }` maps for when only one class's orb should move. Class keys are pulled out first
// so a flat override key can never collide with a class name.
function resolveOrbsForClass(className, orbOverrides) {
  const globalOverrides = Object.fromEntries(
    Object.entries(orbOverrides).filter(([key]) => !(key in ORB_CLASSES))
  );
  return { ...ORB_CLASSES[className], ...globalOverrides, ...orbOverrides[className] };
}

// Validates both orb_overrides shapes at once: flat aspect-name keys, and per-class
// `{ body: {...}, point: {...} }` keys whose nested keys must themselves be aspect names.
// Returns the list of keys callers didn't recognize, so the tool boundary can reject them
// with the same error shape used before per-class overrides existed.
export function invalidOrbOverrideKeys(orbOverrides) {
  const knownAspectNames = new Set([...Object.keys(MAJOR_ASPECTS), ...Object.keys(MINOR_ASPECTS)]);
  const invalid = [];
  for (const [key, value] of Object.entries(orbOverrides)) {
    if (key in ORB_CLASSES) {
      for (const nestedKey of Object.keys(value ?? {})) {
        if (!knownAspectNames.has(nestedKey)) invalid.push(nestedKey);
      }
    } else if (!knownAspectNames.has(key)) {
      invalid.push(key);
    }
  }
  return invalid;
}

function resolveAspectSettings(options = {}) {
  const { includeMinor = false, orbOverrides = {} } = options;
  const orbsByClass = {
    body: resolveOrbsForClass('body', orbOverrides),
    point: resolveOrbsForClass('point', orbOverrides),
  };
  const aspectDefs = includeMinor
    ? { ...MAJOR_ASPECTS, ...MINOR_ASPECTS }
    : { ...MAJOR_ASPECTS };
  return { orbsByClass, aspectDefs };
}

export function calculateNatalAspects(bodiesWithLonSpeed, options = {}) {
  const {
    includeAngles = false,
    includeSouthNode = false,
  } = options;

  const { orbsByClass, aspectDefs } = resolveAspectSettings(options);

  const aspectableAngleSet = new Set(ASPECTABLE_ANGLES);
  const nonAspectableAngleSet = new Set(ANGLE_BODIES.filter((name) => !aspectableAngleSet.has(name)));
  const bodies = bodiesWithLonSpeed.filter((b) => {
    if (b.name === 'South Node') return includeSouthNode;
    // DSC/IC are computed points, never aspected - see ASPECTABLE_ANGLES.
    if (nonAspectableAngleSet.has(b.name)) return false;
    if (aspectableAngleSet.has(b.name)) return includeAngles;
    return true;
  });

  const aspects = [];

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      aspects.push(...matchAspectsForPair(bodies[i], bodies[j], aspectDefs, orbsByClass));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}

// Determine which house (1-12) a longitude falls in, given a chart's house cusps.
// Houses is the {1: {longitude}, ..., 12: {longitude}} shape returned by calculateEphemeris.
export function findHouseForLongitude(longitude, houses) {
  for (let house = 1; house <= 12; house++) {
    const next = house === 12 ? 1 : house + 1;
    const start = houses[house].longitude;
    const end = houses[next].longitude;

    const offsetFromStart = ((longitude - start) % 360 + 360) % 360;
    let arcLength = ((end - start) % 360 + 360) % 360;
    if (arcLength === 0) arcLength = 360; // degenerate cusps (shouldn't happen in practice)

    if (offsetFromStart < arcLength) return house;
  }
  return null;
}

// House overlay for synastry: which of the target chart's houses each of the
// given bodies (planets/points with longitude) falls into.
export function calculateHouseOverlay(bodiesWithLon, houses) {
  const overlay = {};
  for (const { name, longitude } of bodiesWithLon) {
    overlay[name] = findHouseForLongitude(longitude, houses);
  }
  return overlay;
}

// Cross-chart pairing (e.g. synastry): every body in bodiesA against every body in
// bodiesB, sharing the same aspect-matching/orb logic as calculateNatalAspects so
// natal and cross-chart judgments can never diverge for the same body pair.
export function calculateCrossChartAspects(bodiesA, bodiesB, options = {}) {
  const { orbsByClass, aspectDefs } = resolveAspectSettings(options);

  const aspects = [];

  for (const a of bodiesA) {
    for (const b of bodiesB) {
      aspects.push(...matchAspectsForPair(a, b, aspectDefs, orbsByClass));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}
