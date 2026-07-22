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

export function calculateNatalAspects(bodiesWithLonSpeed, options = {}) {
  const {
    includeMinor = false,
    orbOverrides = {},
    includeAngles = false,
    includeSouthNode = false,
  } = options;

  const orbs = { ...DEFAULT_ORBS, ...orbOverrides };
  const aspectDefs = includeMinor
    ? { ...MAJOR_ASPECTS, ...MINOR_ASPECTS }
    : { ...MAJOR_ASPECTS };

  const angleSet = new Set(ANGLE_BODIES);
  const bodies = bodiesWithLonSpeed.filter((b) => {
    if (b.name === 'South Node') return includeSouthNode;
    if (angleSet.has(b.name)) return includeAngles;
    return true;
  });

  const aspects = [];

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      const { signedDiff, separation } = normalizeSeparation(a.longitude, b.longitude);

      for (const [aspectName, targetAngle] of Object.entries(aspectDefs)) {
        const category = MAJOR_ASPECTS.hasOwnProperty(aspectName) ? 'major' : 'minor';
        const orbAllowed = orbs[aspectName];
        const orb = Math.abs(separation - targetAngle);

        if (orb <= orbAllowed) {
          const applying = computeApplying(separation, targetAngle, signedDiff, a.speed, b.speed);
          aspects.push({
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
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}
