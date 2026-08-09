import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TROPICAL_YEAR_DAYS,
  mod360,
  computeElapsedYears,
  computeProgressedDate,
  formatProgressedDatetime,
  computeArcDegrees,
  rightAscensionFromEclipticLongitude,
  normalizeLongitudeSigned,
  computeFictitiousLongitude,
} from '../lib/progressions.js';

test('mod360 wraps into [0, 360)', () => {
  assert.equal(mod360(370), 10);
  assert.equal(mod360(-10), 350);
  assert.equal(mod360(360), 0);
});

test('computeElapsedYears converts real elapsed time into fractional tropical years', () => {
  const birth = new Date('1990-01-01T12:00:00Z');
  const target = new Date(birth.getTime() + 32.5 * TROPICAL_YEAR_DAYS * 86400000);
  assert.ok(Math.abs(computeElapsedYears(birth, target) - 32.5) < 1e-9);
});

test('computeProgressedDate + formatProgressedDatetime implement day-for-a-year', () => {
  const birth = new Date('1990-01-01T12:00:00Z');
  const progressed = computeProgressedDate(birth, 32.5);
  assert.equal(formatProgressedDatetime(progressed), '1990-02-03T00:00:00Z');
});

test('computeArcDegrees solar_arc is progressed Sun minus natal Sun, mod 360', () => {
  const arc = computeArcDegrees('solar_arc', { natalSunLongitude: 280.8142608, progressedSunLongitude: 313.8913796 });
  assert.ok(Math.abs(arc - 33.0771188) < 1e-6);
});

test('computeArcDegrees naibod derives the rate as 360/year_length_days, not a bare literal', () => {
  const arc = computeArcDegrees('naibod', { elapsedYears: 32.5, yearLengthDays: 365.2422 });
  assert.ok(Math.abs(arc - (360 / 365.2422) * 32.5) < 1e-9);
});

test('rightAscensionFromEclipticLongitude matches the standard MC RA formula', () => {
  // At the equinoxes/solstices (0/90/180/270), ecliptic longitude and RA coincide exactly
  // regardless of obliquity - a degenerate but useful sanity check independent of any
  // fixture-derived number.
  for (const lon of [0, 90, 180, 270]) {
    assert.ok(Math.abs(rightAscensionFromEclipticLongitude(lon, 23.4423661) - lon) < 1e-9, `lon=${lon}`);
  }
  // DAY_CHART worked example: progressed MC 313.0775173888889 deg, true obliquity
  // 23.4424161 deg -> target ARMC 315.5439382 deg (verified against vendored swetest's own
  // -house round trip during SUP-356 implementation).
  const armc = rightAscensionFromEclipticLongitude(313.0775173888889, 23.4424161);
  assert.ok(Math.abs(armc - 315.5439382) < 1e-5);
});

test('normalizeLongitudeSigned normalizes into (-180, 180]', () => {
  assert.ok(Math.abs(normalizeLongitudeSigned(182.630699) - (-177.369301)) < 1e-6);
  assert.equal(normalizeLongitudeSigned(0), 0);
  assert.equal(normalizeLongitudeSigned(180), 180);
  assert.ok(Math.abs(normalizeLongitudeSigned(-180) - 180) < 1e-9);
});

// The natal-longitude correction (see lib/progressions.js computeFictitiousLongitude
// comment): ARMC(lon) = ARMC(0) + lon, and baseArmc was measured AT natalLongitude, not at
// 0 - so recovering ARMC(0) requires subtracting natalLongitude back out. A Greenwich
// fixture (natalLongitude = 0) can't distinguish the correct formula from the naive
// `targetArmc - baseArmc` the spec's own worked example uses, because the correction term
// is zero there. This test uses a nonzero natal longitude specifically to catch that.
test('computeFictitiousLongitude accounts for a nonzero natal longitude', () => {
  // PARTNER_CHART's progressed instant: base ARMC measured at natal_lon=-74.0060,
  // true obliquity 23.4376231, target ecliptic MC 235.8452704 (25°50'43" Scorpio, the
  // spec's expected solar-arc answer).
  const withCorrection = computeFictitiousLongitude({
    progressedMcLongitude: 235.8452704,
    obliquityDeg: 23.4376231,
    baseArmc: 54.6367013,
    natalLongitude: -74.0060,
  });
  const naiveNoCorrection = normalizeLongitudeSigned(
    rightAscensionFromEclipticLongitude(235.8452704, 23.4376231) - 54.6367013
  );
  assert.ok(Math.abs(withCorrection - 104.8760554) < 1e-4, `expected ~104.876, got ${withCorrection}`);
  assert.ok(Math.abs(withCorrection - naiveNoCorrection) > 1, 'the natal-longitude term must materially change the result for a non-Greenwich chart');
});

test('computeFictitiousLongitude with natalLongitude=0 reduces to the naive formula (the spec worked example case)', () => {
  const withCorrection = computeFictitiousLongitude({
    progressedMcLongitude: 313.0775173888889,
    obliquityDeg: 23.4424161,
    baseArmc: 132.9132390,
    natalLongitude: 0,
  });
  assert.ok(Math.abs(withCorrection - (-177.369301)) < 1e-4);
});
