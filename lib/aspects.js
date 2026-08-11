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

// MOIETIES: half-orb per body/point. Pair orb = (moietyA + moietyB) * ASPECT_MULTIPLIERS[aspect],
// applied in matchAspectsForPair below. Two provenance tiers:
//
// - Sun..Saturn (the 7 classical bodies) are HALVED from the classical full-orb table
//   (15/12/7/7/8/9/9 respectively). This halving is deliberate — a future contributor
//   must not "correct" these back to full orbs.
// - Everything past Saturn, plus the angles (Ascendant/Midheaven/IC/Descendant) and the
//   lots (Part of Fortune, Vertex), is team-constructed by analogy per SUP-168 rationale
//   and is non-traditional.
//
// Structural mirror: IC = Midheaven and Descendant = Ascendant (asserted by unit test).
export const MOIETIES = {
  Sun: 7.5,
  Moon: 6,
  Mercury: 3.5,
  Venus: 3.5,
  Mars: 4,
  Jupiter: 4.5,
  Saturn: 4.5,
  Uranus: 2.5,
  Neptune: 2.5,
  Pluto: 2.5,
  Chiron: 2,
  'North Node': 1.5,
  'South Node': 1.5,
  Lilith: 1,
  Ceres: 1,
  Pallas: 1,
  Juno: 1,
  Vesta: 1,
  Ascendant: 2.5,
  Midheaven: 2.5,
  IC: 2.5,
  Descendant: 2.5,
  'Part of Fortune': 1.5,
  Vertex: 1.5,
};

export const ASPECT_MULTIPLIERS = {
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

// A parallel/contraparallel is only reported between points whose declination is an
// independently computed physical datum - points on the ecliptic by construction (the
// Node) restate their longitude in declination (docs/SUP-345-declination-layer-spec.md
// §1.5/§Q2) and are excluded. Angles are excluded for the same reason plus the mirror
// double-count in §Q3 - they never enter this list at all, unlike DEFAULT_ASPECT_BODIES
// which angles join conditionally via include_angles.
export const DECLINATION_ASPECT_BODIES = DEFAULT_ASPECT_BODIES.filter((name) => name !== 'North Node');

// Flat 1 degree for both parallel and contraparallel - the mainstream Western default
// (Solar Fire, Astro Gold, astro.com). Contraparallel intentionally equals parallel: this
// codebase already gives conjunction and opposition equal orbs in every existing class
// (DEFAULT_ORBS, ANGLE_ORBS, DERIVED_ORBS all 8/8, 5/5, 3/3). The 1deg30' luminary
// widening some schools use is a real minority refinement, not the default - reachable
// only via orb_overrides.declination (docs/SUP-345-declination-layer-spec.md §Q1).
export const DECLINATION_ORBS = {
  parallel: 1,
  contraparallel: 1,
};

// Declination orbs are their own class, deliberately NOT added to ORB_CLASSES:
// resolveOrbsForClass spreads every non-class-name override key into every class, so a
// declination class would leak a flat aspect-name override into the declination table and
// couple two systems that must stay independent (moiety-vs-class is a longitude concept
// and must not change a declination orb) - see §Q1 constraint 2. The resolver itself lives
// near calculateDeclinationAspects below, alongside the functions that use it.

export const ANGLE_BODIES = ['Ascendant', 'Midheaven', 'IC', 'Descendant', 'Part of Fortune'];

// DSC = ASC+180 and IC = MC+180, so aspecting all four axis points double-counts every
// contact under two labels. Only these three are used by the aspect-matching engine;
// DSC/IC stay in ANGLE_BODIES as legitimate computed chart points (include_angles output),
// they just never enter aspect pair-matching.
export const ASPECTABLE_ANGLES = ['Ascendant', 'Midheaven', 'Part of Fortune'];

// Angle-class orbs: ASC/MC are highly significant points, so their orbs are WIDER than the
// derived class (and wider than PR#17's old point class). Their sensitivity is birth-time-error
// propagation (ASC moves ~1°/4min), a data-quality property, not an aspect-strength one — that
// belongs in a birth-time-confidence flag, not a tightened orb. Every mirror pair MUST be equal:
// IC/DSC are excluded from aspecting (see ASPECTABLE_ANGLES) and recovered by the 180° mapping in
// README, which is only lossless when mirrored aspects carry equal orbs. Enforced by unit test.
const ANGLE_ORBS = {
  conjunction: 5, opposition: 5,   // mirror pair
  square: 4,                       // self-mirroring
  trine: 3, sextile: 3,            // mirror pair
  semisextile: 1.5, quincunx: 1.5, // mirror pair
  semisquare: 1.5, sesquiquadrate: 1.5, // mirror pair
  quintile: 1, biquintile: 1,      // no mirror partner — IC/DSC contacts here are underivable
};

// Derived-class orbs: Part of Fortune, Vertex, future lots. Genuinely tight — compounded
// derivation from other points plus contested significance. No axis mirror, so no symmetry
// constraint (it is symmetric here regardless).
const DERIVED_ORBS = {
  conjunction: 3, opposition: 3,
  square: 2,
  trine: 2, sextile: 2,
  semisextile: 1, semisquare: 1, sesquiquadrate: 1, quincunx: 1, quintile: 1, biquintile: 1,
};

export const ORB_CLASSES = {
  body: DEFAULT_ORBS,
  angle: ANGLE_ORBS,
  derived: DERIVED_ORBS,
};

// Flat table for orb_model 'fixed' (SUP-357/SUP-359): one orb per aspect, independent of
// which body/point is on either side. This is find_events' progressed-rate default — at
// that rate a moiety or class table's multi-degree orbs put an outer-planet contact "in
// orb" for centuries (see the ruling in the SUP-357 spec), so the whole per-body/per-class
// resolution class/moiety do is deliberately absent here, not just re-tabulated.
export const FIXED_ORBS = {
  conjunction: 1, opposition: 1, trine: 1, square: 1, sextile: 1,
  semisextile: 0.5, semisquare: 0.5, sesquiquadrate: 0.5, quincunx: 0.5, quintile: 0.5, biquintile: 0.5,
};

// orb_model selects how a pair's allowed orb is derived. 'moiety' (default, SUP-179) sums
// each body's individually resolved half-orb (MOIETIES) and scales by the aspect's
// multiplier (ASPECT_MULTIPLIERS). 'class' is the fixed per-class table above (ORB_CLASSES)
// instead. 'fixed' (SUP-357/SUP-359) is flatter still — one orb per aspect name, the same
// for every pair — see matchAspectsForPair.
export const ORB_MODELS = ['class', 'moiety', 'fixed'];

// ASC/MC/IC/DSC are axis points → `angle`. IC/DSC never enter aspect matching (ASPECTABLE_ANGLES)
// so their class is inert, but mapping them to `angle` keeps the mirror relationship honest.
// Part of Fortune and Vertex are derived sensitive points → `derived`. Vertex is pre-mapped ahead
// of its own opt-in flag (GH #6) so it never inherits the wrong class by omission. Anything absent
// defaults to `body`.
const ANGLE_CLASS_BODIES = ['Ascendant', 'Midheaven', 'IC', 'Descendant'];
const DERIVED_CLASS_BODIES = ['Part of Fortune', 'Vertex'];
export const BODY_ORB_CLASS = {
  ...Object.fromEntries(ANGLE_CLASS_BODIES.map((n) => [n, 'angle'])),
  ...Object.fromEntries(DERIVED_CLASS_BODIES.map((n) => [n, 'derived'])),
};

// Exported for lib/event-search.js (SUP-350) - the search engine needs to classify a
// body/point to resolve its 'class'-model orb without reaching into BODY_ORB_CLASS or
// ORB_CLASSES itself, which would pull orb-table knowledge into a module that's supposed
// to only know about the resolved table it's handed.
export function orbClassForBody(name) {
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

// Position payload shape shared with synastry_aspects rows ({longitude, sign, degree}),
// resolved from whichever bucket the chart stores the point in.
export function toPointPosition(chart, name) {
  const point = resolveChartPoint(chart, name);
  return point ? { longitude: point.longitude, sign: point.sign, degree: point.degree } : null;
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

function matchAspectsForPair(a, b, aspectDefs, orbsByClass, orbModel = 'moiety', moieties = MOIETIES, aspectMultipliers = ASPECT_MULTIPLIERS, fixedOrbs = FIXED_ORBS) {
  const { signedDiff, separation } = normalizeSeparation(a.longitude, b.longitude);
  const orbsA = orbModel === 'class' ? orbsByClass[orbClassForBody(a.name)] : null;
  const orbsB = orbModel === 'class' ? orbsByClass[orbClassForBody(b.name)] : null;
  const matches = [];

  for (const [aspectName, targetAngle] of Object.entries(aspectDefs)) {
    const category = MAJOR_ASPECTS.hasOwnProperty(aspectName) ? 'major' : 'minor';
    // A pair spanning two classes (e.g. a planet and an angle) is held to whichever side's
    // class is stricter, so a tight point-class orb can never be widened by its partner.
    // 'fixed' has no per-body/class concept at all - one orb per aspect, full stop.
    const orbAllowed = orbModel === 'moiety'
      ? (moieties[a.name] + moieties[b.name]) * aspectMultipliers[aspectName]
      : orbModel === 'fixed'
      ? fixedOrbs[aspectName]
      : Math.min(orbsA[aspectName], orbsB[aspectName]);
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
// applies to every class (today's shape, unchanged), and per-class `{ body: {...}, angle:
// {...}, derived: {...} }` maps for when only one class's orb should move. Class keys are
// pulled out first so a flat override key can never collide with a class name.
function resolveOrbsForClass(className, orbOverrides) {
  const globalOverrides = Object.fromEntries(
    Object.entries(orbOverrides).filter(([key]) => !(key in ORB_CLASSES))
  );
  return { ...ORB_CLASSES[className], ...globalOverrides, ...orbOverrides[className] };
}

// Validates both orb_overrides shapes at once: flat aspect-name keys, and per-class
// `{ body: {...}, angle: {...}, derived: {...} }` keys whose nested keys must themselves be
// aspect names. Returns the list of keys callers didn't recognize, so the tool boundary can
// reject them with the same error shape used before per-class overrides existed.
//
// In 'moiety' mode the shape is different and disjoint: `{ moieties: { "Sun": 7.5, ... },
// multipliers: { quincunx: 0.3, ... } }`. Nested `moieties` keys must be known body/point
// names (MOIETIES); nested `multipliers` keys must be known aspect names. A class-mode key
// (a flat aspect name, or `body`/`angle`/`derived`) is not `moieties`/`multipliers`, so it
// falls straight into `invalid` here — and conversely `moieties`/`multipliers` are neither a
// class name nor an aspect name, so they already fall into `invalid` under class mode below.
// This keeps cross-mode keys rejected in both directions without extra bookkeeping.
const KNOWN_DECLINATION_ASPECT_NAMES = new Set(Object.keys(DECLINATION_ORBS));

// orb_overrides.declination is validated the same way regardless of orb_model - moiety vs
// class is a longitude concept, and a declination orb must not become valid/invalid
// depending on it (docs/SUP-345-declination-layer-spec.md §Q1 constraint 1). Called once by
// each orb_model branch below; the top-level `declination` key itself is consumed by the
// caller so it never falls through to that branch's own unknown-key check.
function invalidDeclinationOverrideKeys(orbOverrides) {
  if (!Object.hasOwn(orbOverrides, 'declination')) return [];
  return Object.keys(orbOverrides.declination ?? {}).filter((key) => !KNOWN_DECLINATION_ASPECT_NAMES.has(key));
}

export function invalidOrbOverrideKeys(orbOverrides, orbModel = 'moiety') {
  const knownAspectNames = new Set([...Object.keys(MAJOR_ASPECTS), ...Object.keys(MINOR_ASPECTS)]);
  const declinationInvalid = invalidDeclinationOverrideKeys(orbOverrides);

  // 'fixed' has no class/moiety concept to nest overrides under - only flat aspect-name
  // keys are valid, same shape as 'class' minus the per-class {body:{...}} nesting.
  // declination isn't offered under 'fixed' (no tool exposes that combination), so it falls
  // through to the ordinary unknown-key check here, same as before this key existed.
  if (orbModel === 'fixed') {
    return Object.keys(orbOverrides).filter((key) => !knownAspectNames.has(key));
  }

  if (orbModel === 'moiety') {
    const knownBodyNames = new Set(Object.keys(MOIETIES));
    const knownMoietyShapeKeys = new Set(['moieties', 'multipliers']);
    const invalid = [];
    for (const [key, value] of Object.entries(orbOverrides)) {
      if (key === 'declination') continue; // validated via declinationInvalid above
      if (!knownMoietyShapeKeys.has(key)) {
        invalid.push(key);
        continue;
      }
      const nestedKnown = key === 'moieties' ? knownBodyNames : knownAspectNames;
      for (const nestedKey of Object.keys(value ?? {})) {
        if (!nestedKnown.has(nestedKey)) invalid.push(nestedKey);
      }
    }
    return [...invalid, ...declinationInvalid];
  }

  const invalid = [];
  for (const [key, value] of Object.entries(orbOverrides)) {
    if (key === 'declination') continue; // validated via declinationInvalid above
    if (key in ORB_CLASSES) {
      for (const nestedKey of Object.keys(value ?? {})) {
        if (!knownAspectNames.has(nestedKey)) invalid.push(nestedKey);
      }
    } else if (!knownAspectNames.has(key)) {
      invalid.push(key);
    }
  }
  return [...invalid, ...declinationInvalid];
}

// Exported for lib/event-search.js (SUP-350 step 3/4): resolves orb_model/orb_overrides/
// include_minor into a single settings object once per query batch, so the search engine
// can be *handed* that table (via orbAllowedFor below) instead of reaching for MOIETIES,
// ORB_CLASSES or any other orb constant directly. No new aspect, orb class, or change to
// DEFAULT_ORBS/ANGLE_ORBS/DERIVED_ORBS/MOIETIES/ASPECT_MULTIPLIERS - this only exposes
// the existing resolution that matchAspectsForPair already used internally.
export function resolveAspectSettings(options = {}) {
  const { includeMinor = false, orbOverrides = {}, orbModel = 'moiety' } = options;

  if (!ORB_MODELS.includes(orbModel)) {
    throw new Error(`Unknown orb_model: ${orbModel}`);
  }

  const orbsByClass = orbModel === 'class'
    ? {
      body: resolveOrbsForClass('body', orbOverrides),
      angle: resolveOrbsForClass('angle', orbOverrides),
      derived: resolveOrbsForClass('derived', orbOverrides),
    }
    : null;
  const fixedOrbs = orbModel === 'fixed' ? { ...FIXED_ORBS, ...orbOverrides } : null;
  const moieties = orbModel === 'moiety' ? { ...MOIETIES, ...orbOverrides.moieties } : MOIETIES;
  const aspectMultipliers = orbModel === 'moiety'
    ? { ...ASPECT_MULTIPLIERS, ...orbOverrides.multipliers }
    : ASPECT_MULTIPLIERS;
  const aspectDefs = includeMinor
    ? { ...MAJOR_ASPECTS, ...MINOR_ASPECTS }
    : { ...MAJOR_ASPECTS };
  return { orbsByClass, aspectDefs, orbModel, moieties, aspectMultipliers, fixedOrbs };
}

// Orb allowed for a single (nameA, nameB, aspect) triple under a table already resolved
// by resolveAspectSettings - the same moiety-sum-or-tighter-class formula
// matchAspectsForPair uses internally, exposed so callers don't duplicate it.
export function orbAllowedFor(settings, nameA, nameB, aspectName) {
  const { orbModel, orbsByClass, moieties, aspectMultipliers, fixedOrbs } = settings;
  if (orbModel === 'moiety') return (moieties[nameA] + moieties[nameB]) * aspectMultipliers[aspectName];
  if (orbModel === 'fixed') return fixedOrbs[aspectName];
  return Math.min(orbsByClass[orbClassForBody(nameA)][aspectName], orbsByClass[orbClassForBody(nameB)][aspectName]);
}

// orb_model ('moiety' default | 'class', SUP-173/T1 seam, default flipped SUP-179/T3) flows
// through via `options` into resolveAspectSettings below — see ORB_MODELS.
//
// SUP-224: include_angles/include_south_node/DSC-IC gating no longer happens here - it lives
// in resolveAspectBodies (index.js) so the natal and cross-chart callers share one gate.
// bodiesWithLonSpeed is trusted as already gated by the caller.
export function calculateNatalAspects(bodiesWithLonSpeed, options = {}) {
  const { orbsByClass, aspectDefs, orbModel, moieties, aspectMultipliers, fixedOrbs } = resolveAspectSettings(options);

  const aspects = [];

  for (let i = 0; i < bodiesWithLonSpeed.length; i++) {
    for (let j = i + 1; j < bodiesWithLonSpeed.length; j++) {
      aspects.push(...matchAspectsForPair(bodiesWithLonSpeed[i], bodiesWithLonSpeed[j], aspectDefs, orbsByClass, orbModel, moieties, aspectMultipliers, fixedOrbs));
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
// natal and cross-chart judgments can never diverge for the same body pair. orb_model
// flows through via `options` the same way as calculateNatalAspects above.
export function calculateCrossChartAspects(bodiesA, bodiesB, options = {}) {
  const { orbsByClass, aspectDefs, orbModel, moieties, aspectMultipliers, fixedOrbs } = resolveAspectSettings(options);

  const aspects = [];

  for (const a of bodiesA) {
    for (const b of bodiesB) {
      aspects.push(...matchAspectsForPair(a, b, aspectDefs, orbsByClass, orbModel, moieties, aspectMultipliers, fixedOrbs));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}

// Exported so index.js's settings_used echo (declination_orbs) reflects the same
// orb_overrides.declination resolution the matching functions below actually use,
// without duplicating the merge.
export function resolveDeclinationOrbs(orbOverrides = {}) {
  return { ...DECLINATION_ORBS, ...orbOverrides.declination };
}

// A pair can match parallel, contraparallel, both (only possible when both declinations
// are within half the orb of the equator - §3.4, not a bug), or neither.
function matchDeclinationPair(a, b, orbs) {
  const matches = [];

  const parallelOrb = Math.abs(a.declination - b.declination);
  if (parallelOrb <= orbs.parallel) {
    matches.push({
      body_a: a.name,
      body_b: b.name,
      aspect: 'parallel',
      declination_a: a.declination,
      declination_b: b.declination,
      orb: parallelOrb,
      orb_allowed: orbs.parallel,
      // Declination rate isn't longitude rate - it can run in the opposite sense and goes
      // to zero at the solstitial points regardless of longitude speed, so deriving
      // applying/separating from a body's longitude speed would be confidently wrong, not
      // just imprecise (docs/SUP-345-declination-layer-spec.md §Q6). Always null in v1 -
      // present, not omitted, so this row shape matches `aspects`. Do not "fix" this by
      // wiring in longitude speed; real applying needs a second ephemeris call at t+1d
      // (follow-up, §6).
      applying: null,
    });
  }

  const contraparallelOrb = Math.abs(a.declination + b.declination);
  if (contraparallelOrb <= orbs.contraparallel) {
    matches.push({
      body_a: a.name,
      body_b: b.name,
      aspect: 'contraparallel',
      declination_a: a.declination,
      declination_b: b.declination,
      orb: contraparallelOrb,
      orb_allowed: orbs.contraparallel,
      applying: null,
    });
  }

  return matches;
}

// Natal declination aspects: every pairing within one chart's DECLINATION_ASPECT_BODIES
// (already filtered/gated by the caller - see index.js declinationBodyNames/toDeclinationBodies).
// bodiesWithDeclination is [{name, declination}]; angles and the Node must never reach
// here (§Q2/§Q3), which the caller enforces rather than this function re-deriving it.
export function calculateDeclinationAspects(bodiesWithDeclination, orbOverrides = {}) {
  const orbs = resolveDeclinationOrbs(orbOverrides);
  const aspects = [];

  for (let i = 0; i < bodiesWithDeclination.length; i++) {
    for (let j = i + 1; j < bodiesWithDeclination.length; j++) {
      aspects.push(...matchDeclinationPair(bodiesWithDeclination[i], bodiesWithDeclination[j], orbs));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}

// Cross-chart declination aspects (calculate_transits/calculate_synastry): every body in
// bodiesA against every body in bodiesB, same gating contract as calculateDeclinationAspects.
export function calculateCrossChartDeclinationAspects(bodiesA, bodiesB, orbOverrides = {}) {
  const orbs = resolveDeclinationOrbs(orbOverrides);
  const aspects = [];

  for (const a of bodiesA) {
    for (const b of bodiesB) {
      aspects.push(...matchDeclinationPair(a, b, orbs));
    }
  }

  aspects.sort((x, y) => x.orb - y.orb);

  return aspects;
}
