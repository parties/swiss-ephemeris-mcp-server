/**
 * SUP-359 review follow-up: the adaptive coarse-step subdivision (index.js adaptiveJdGrid)
 * exists specifically because the progressed Ascendant's rate is unbounded near the poles
 * (spec §1.2's one named exception) and, before this test, had zero coverage proving the
 * halving branch ever actually fires - no fixture exceeded 51.4769deg latitude. These are
 * pure unit tests of the exported function against synthetic longitude curves (no swetest
 * dependency), plus test/find-events-progressed.integration.test.js's POLAR_CHART cases
 * exercise the real progressed-Ascendant path at a latitude where the effect is genuine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveJdGrid } from '../index.js';

function wrap180(deg) {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

function maxAdjacentJump(grid, longitudeAt) {
  let max = 0;
  for (let i = 1; i < grid.length; i++) {
    max = Math.max(max, Math.abs(wrap180(longitudeAt(grid[i]) - longitudeAt(grid[i - 1]))));
  }
  return max;
}

test('adaptiveJdGrid subdivides base steps whose longitude jump exceeds 90deg, bringing every adjacent jump back under threshold', () => {
  // Two independent steep transitions (~178deg change concentrated in well under a day,
  // the shape a near-pole progressed Ascendant can produce) planted inside two different
  // 1-day base steps of a 20-day span - the same 1-day coarse step find_events uses
  // everywhere else (spec §1.2), which is safe for every real body but not this one.
  const longitudeAt = (jd) => 89 * Math.tanh((jd - 5.33) * 1800) + 89 * Math.tanh((jd - 14.7) * 1800);

  const baseLength = 21; // ceil((20-0)/1) + 1
  const grid = adaptiveJdGrid(0, 20, 1, longitudeAt);

  // Unsubdivided, these two base steps jump ~178deg each - proving the coarse grid alone
  // would have missed (or badly under-sampled) the discontinuity.
  assert.ok(Math.abs(wrap180(longitudeAt(6) - longitudeAt(5))) > 90);
  assert.ok(Math.abs(wrap180(longitudeAt(15) - longitudeAt(14))) > 90);

  // Subdivision more than doubles the grid (both problem intervals get halved repeatedly),
  // and afterwards no adjacent pair exceeds the 90deg threshold the recursion targets.
  assert.ok(grid.length > baseLength * 2, `expected >${baseLength * 2} points, got ${grid.length}`);
  assert.ok(maxAdjacentJump(grid, longitudeAt) < 90);
});

test('adaptiveJdGrid leaves an ordinary (non-pole) rate of change alone - no spurious subdivision', () => {
  const longitudeAt = (jd) => (3 * jd) % 360; // 3deg/day, an ordinary body's order of magnitude
  const grid = adaptiveJdGrid(0, 20, 1, longitudeAt);
  assert.equal(grid.length, 21);
});

test('adaptiveJdGrid never subdivides past MIN_ADAPTIVE_SPAN_JD (1 minute of target time), even at a genuine discontinuity', () => {
  // A hard step function models an actual singularity (e.g. exactly at a pole) rather than
  // a fast-but-continuous swing - recursion should stop at the floor rather than spin
  // forever chasing a jump that never resolves under 90deg.
  const longitudeAt = (jd) => (jd < 5.5 ? 0 : 170);
  const grid = adaptiveJdGrid(0, 10, 1, longitudeAt);

  const minSpan = Math.min(...grid.slice(1).map((jd, i) => jd - grid[i]));
  assert.ok(minSpan > 0);
  assert.ok(minSpan <= 1 / 1440 + 1e-9, `expected the recursion to bottom out near the 1-minute floor, smallest span was ${minSpan} days`);
});
