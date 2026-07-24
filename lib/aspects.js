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

function matchAspectsForPair(a, b, aspectDefs, orbs) {
  const { signedDiff, separation } = normalizeSeparation(a.longitude, b.longitude);
  const matches = [];

  for (const [aspectName, targetAngle] of Object.entries(aspectDefs)) {
    const category = MAJOR_ASPECTS.hasOwnProperty(aspectName) ? 'major' : 'minor';
    const orbAllowed = orbs[aspectName];
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

function resolveAspectSettings(options = {}) {
  const { includeMinor = false, orbOverrides = {} } = options;
  const orbs = { ...DEFAULT_ORBS, ...orbOverrides };
  const aspectDefs = includeMinor
    ? { ...MAJOR_ASPECTS, ...MINOR_ASPECTS }
    : { ...MAJOR_ASPECTS };
  return { orbs, aspectDefs };
}

export function calculateNatalAspects(bodiesWithLonSpeed, options = {}) {
  const {
    includeAngles = false,
    includeSouthNode = false,
  } = options;

  const { orbs, aspectDefs } = resolveAspectSettings(options);

  const angleSet = new Set(ANGLE_BODIES);
  const bodies = bodiesWithLonSpeed.filter((b) => {
    if (b.name === 'South Node') return includeSouthNode;
    if (angleSet.has(b.name)) return includeAngles;
    return true;
  });

  const aspects = [];

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      aspects.push(...matchAspectsForPair(bodies[i], bodies[j], aspectDefs, orbs));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}

// Determine which house (1-12) a longitude falls in, given a chart's house cusps.
// Houses is the {1: {longitude}, ..., 12: {longitude}} shape returned by calculateEphemeris.
function findHouseForLongitude(longitude, houses) {
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
  const { orbs, aspectDefs } = resolveAspectSettings(options);

  const aspects = [];

  for (const a of bodiesA) {
    for (const b of bodiesB) {
      aspects.push(...matchAspectsForPair(a, b, aspectDefs, orbs));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}
