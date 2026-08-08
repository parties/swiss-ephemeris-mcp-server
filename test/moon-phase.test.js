import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseFromElongation, moonPhase, normalizeElongation, PHASE_SCHEME } from '../lib/moon-phase.js';

// Bands start at the exact aspect (start-at-exact-aspect convention), not centered on it
// (the almanac convention). Just below a band start is the discriminator between the two:
// the almanac form would still call 44.9deg "New" (its New band runs 337.5-22.5) while the
// start-at-exact-aspect form has already moved on to the next-lower band.
test('44.9deg names New under the start-at-exact-aspect convention', () => {
  assert.equal(phaseFromElongation(44.9), 'New');
});

test('179.9deg names Gibbous under the start-at-exact-aspect convention', () => {
  assert.equal(phaseFromElongation(179.9), 'Gibbous');
});

// Lower-inclusive edges: a band start belongs to that band, not the previous one.
test('0deg is New', () => {
  assert.equal(phaseFromElongation(0), 'New');
});

test('45.0deg is Crescent, not New', () => {
  assert.equal(phaseFromElongation(45.0), 'Crescent');
});

test('315.0deg is Balsamic, not Last Quarter', () => {
  assert.equal(phaseFromElongation(315.0), 'Balsamic');
});

test('359.9deg is Balsamic', () => {
  assert.equal(phaseFromElongation(359.9), 'Balsamic');
});

test('every 45deg boundary names the band that starts there', () => {
  const expected = ['New', 'Crescent', 'First Quarter', 'Gibbous', 'Full', 'Disseminating', 'Last Quarter', 'Balsamic'];
  for (let i = 0; i < 8; i++) {
    assert.equal(phaseFromElongation(i * 45), expected[i]);
  }
});

test('normalizeElongation wraps a negative raw difference into [0, 360)', () => {
  assert.ok(Math.abs(normalizeElongation(-182.49) - 177.51) < 1e-9);
});

test('normalizeElongation wraps a difference already past 360', () => {
  assert.ok(Math.abs(normalizeElongation(400) - 40) < 1e-9);
});

test('moonPhase computes elongation from longitudes, not a pre-signed input', () => {
  const result = moonPhase(280.8142608, 333.2676545);
  assert.ok(Math.abs(result.elongation - 52.4533937) < 1e-6);
  assert.equal(result.phase, 'Crescent');
  assert.equal(result.phase_scheme, PHASE_SCHEME);
});

test('moonPhase normalizes a negative Moon-minus-Sun difference (wrap case)', () => {
  // Sun late in Pisces (359.93), Moon early in Libra (180.59): the raw difference
  // (moonLon - sunLon) is -179.34, negative, but the true elongation just past opposition
  // is a positive number a little over 180 - only correct if normalized rather than left
  // signed (SOUTHERN_CHART fixture).
  const result = moonPhase(359.9343181, 180.5949902);
  assert.ok(Math.abs(result.elongation - 180.6606721) < 1e-6);
  assert.equal(result.phase, 'Full');
});
