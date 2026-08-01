import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';

// Helpers — build minimal chart objects that calculateTransitAspects / resolveAspectBodies can
// consume without live swetest. Only the fields those functions read are needed.
function makeChart(bodies) {
  const planets = {};
  for (const { name, longitude, speed } of bodies) {
    planets[name] = { longitude, speed, sign: 'Aries', degree: longitude % 30 };
  }
  return { planets, chart_points: {}, additional_points: {} };
}

// Run calculateTransitAspects with synthetic hand-built charts (no live swetest, always runs).
function runTransits(transitBodies, natalBodies, options = {}) {
  const server = new SwissEphemerisServer();
  const natalChart = makeChart(natalBodies);
  const transitChart = makeChart(transitBodies);
  return server.calculateTransitAspects(natalChart, transitChart, options);
}

// --- Regression cases (verified against the buggy output in the fix-plan doc) ---

test('transit applying — quincunx flips false→true after fix', () => {
  // Buggy code used natal speed (1.208467), giving applying:false. Fixed: natal speed=0 → true.
  const { aspects } = runTransits(
    [{ name: 'Moon', longitude: 30.862778, speed: 0.002681 }],
    [{ name: 'Sun', longitude: 240.961411, speed: 1.208467 }],
    { includeMinor: true },
  );
  const row = aspects.find((a) => a.aspect === 'quincunx');
  assert.ok(row, 'quincunx aspect expected');
  assert.equal(row.applying, true);
});

test('transit applying — trine flips true→false after fix', () => {
  // Buggy code used natal speed (0.222087), giving applying:true. Fixed: natal speed=0 → false.
  const { aspects } = runTransits(
    [{ name: 'Mercury', longitude: 65.004580, speed: 0.032657 }],
    [{ name: 'Jupiter', longitude: 184.342573, speed: 0.222087 }],
  );
  const row = aspects.find((a) => a.aspect === 'trine');
  assert.ok(row, 'trine aspect expected');
  assert.equal(row.applying, false);
});

// --- Invariant: natal speed must not affect applying ---

test('transit applying — changing natal speed does not change applying', () => {
  const transit = [{ name: 'Sun', longitude: 10, speed: 1.0 }];
  const natal = [{ name: 'Moon', longitude: 15, speed: 0.5 }];

  const { aspects: a1 } = runTransits(transit, natal);
  const { aspects: a2 } = runTransits(transit, [{ name: 'Moon', longitude: 15, speed: -2.5 }]);
  const { aspects: a3 } = runTransits(transit, [{ name: 'Moon', longitude: 15, speed: 5.0 }]);

  const row1 = a1.find((a) => a.natal_body === 'Moon');
  const row2 = a2.find((a) => a.natal_body === 'Moon');
  const row3 = a3.find((a) => a.natal_body === 'Moon');
  // Guard against a vacuous pass: if the aspect stopped matching, `.applying` would be
  // undefined in all three runs and a bare equality check would pass for the wrong reason.
  assert.ok(row1 && row2 && row3, 'Sun-Moon conjunction expected in all three runs');
  assert.equal(typeof row1.applying, 'boolean', 'applying must resolve to a real boolean here');

  assert.equal(row1.applying, row2.applying, 'flipping natal speed must not change applying');
  assert.equal(row1.applying, row3.applying, 'scaling natal speed must not change applying');
});

// --- Angle/PoF null-preservation ---

test('transit applying — transiting body vs natal Ascendant gives applying:null', () => {
  // Natal Ascendant has speed:null (static point); the frozen-natal-speed transform preserves
  // null so computeApplying returns null rather than coercing null→0.
  const server = new SwissEphemerisServer();
  const natalChart = {
    planets: { Sun: { longitude: 200, speed: 1, sign: 'Libra', degree: 20 } },
    chart_points: {
      Ascendant: { longitude: 5, speed: null, sign: 'Aries', degree: 5 },
      Midheaven: { longitude: 275, speed: null, sign: 'Capricorn', degree: 5 },
    },
    additional_points: {},
  };
  const transitChart = makeChart([{ name: 'Moon', longitude: 6, speed: 0.5 }]);

  const { aspects } = server.calculateTransitAspects(natalChart, transitChart, {
    includeAngles: true,
  });

  const ascRow = aspects.find((a) => a.natal_body === 'Ascendant');
  assert.ok(ascRow, 'aspect to natal Ascendant expected');
  assert.equal(ascRow.applying, null, 'applying must be null for a static natal point');

  const mcRow = aspects.find((a) => a.natal_body === 'Midheaven');
  assert.ok(mcRow, 'aspect to natal Midheaven expected');
  assert.equal(mcRow.applying, null, 'applying must be null for a static natal point');
});

test('transit applying — transiting body vs natal Part of Fortune gives applying:null', () => {
  const server = new SwissEphemerisServer();
  const natalChart = {
    planets: {},
    chart_points: {},
    additional_points: {
      'Part of Fortune': { longitude: 30, speed: null, sign: 'Taurus', degree: 0 },
    },
  };
  const transitChart = makeChart([{ name: 'Sun', longitude: 31, speed: 1.0 }]);

  const { aspects } = server.calculateTransitAspects(natalChart, transitChart, {
    includeAngles: true,
  });

  const pofRow = aspects.find((a) => a.natal_body === 'Part of Fortune');
  assert.ok(pofRow, 'aspect to natal Part of Fortune expected');
  assert.equal(pofRow.applying, null);
});

// --- Node coverage: transiting node speed drives applying, natal node speed does not ---

test('transit applying — transiting North Node speed determines applying, natal node speed does not', () => {
  // North Node oscillates retrograde (~-0.053°/day). Use a synthetic speed to verify only
  // the transiting side matters.
  const natalNode = { name: 'North Node', longitude: 0, speed: -0.053 };

  // transiting node approaching (positive speed toward natal 0), within conjunction orb (moiety=3°):
  const { aspects: a1 } = runTransits(
    [{ name: 'North Node', longitude: 358, speed: 1.0 }],
    [natalNode],
  );
  // same transiting node, opposite natal speed — must not change result:
  const { aspects: a2 } = runTransits(
    [{ name: 'North Node', longitude: 358, speed: 1.0 }],
    [{ name: 'North Node', longitude: 0, speed: 0.053 }],
  );

  const row1 = a1.find((a) => a.aspect === 'conjunction');
  const row2 = a2.find((a) => a.aspect === 'conjunction');
  assert.ok(row1 && row2, 'conjunction expected in both');
  assert.equal(row1.applying, row2.applying, 'natal node speed must not affect applying');
});
