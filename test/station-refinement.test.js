/**
 * SUP-390: the batched station refinement in lib/event-search.js must land on the SAME
 * Julian day the scalar bisection it replaced landed on - the whole point of the change is
 * spawn count, not accuracy, and spec §6.2 publishes station timestamps to the second.
 *
 * These are pure unit tests against synthetic providers (no swetest dependency). The
 * real-ephemeris side is in test/event-search.integration.test.js.
 *
 * The synthetic speed curve is deliberately nasty in the one way the real ephemeris is
 * nasty: swetest prints speed to seven decimals, so near a station the printed value grazes
 * the last digit and the sign predicate the search narrows DITHERS rather than flipping
 * once. Sampled through Pluto's 2027-05-08 station at 0.25s resolution the printed speed
 * reads 0.0000000 / 0.0000001 / 0.0000000 / 0.0000001 over about three seconds. That is why
 * the batched path REPLAYS bisection's own steps over the fetched grid instead of taking the
 * leftmost sign change in it: the two rules agree wherever the predicate is monotone and
 * disagree by seconds exactly where it is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTransitingBody } from '../lib/event-search.js';

const JD_LO = 2461041.5;
const JD_HI = JD_LO + 1;
const JD_TOLERANCE = 0.05 / 86400; // must track lib/event-search.js's own constant

// A retrograde-to-direct station: speed passes through zero, plus a wobble, then quantised
// to swetest's seven printed decimals. `wobbleAmplitude: 0` degrades to a clean monotone
// step; the values in DITHER_FIXTURES below are ones where it does not.
function speedCurve({ rootFraction, ratePerDay = 0.004, wobbleAmplitude = 0, wobbleFrequency = 1e5 }) {
  const root = JD_LO + rootFraction;
  return (jd) => {
    const raw = (jd - root) * ratePerDay + wobbleAmplitude * Math.sin((jd - root) * wobbleFrequency);
    return Math.round(raw * 1e7) / 1e7;
  };
}

// Curves on which the naive "leftmost sign change in the batch" rule demonstrably picks a
// different flip from bisection. `dithersFromScalarBy` below re-proves that every run, so
// these cannot quietly go stale into a vacuous test.
const DITHER_FIXTURES = [
  { rootFraction: 0.371828, wobbleAmplitude: 1.5e-7, wobbleFrequency: 1e5 },
  { rootFraction: 0.5123, wobbleAmplitude: 9e-8, wobbleFrequency: 4e5 },
  { rootFraction: 0.83197, wobbleAmplitude: 4.9e-8, wobbleFrequency: 6e6 },
  { rootFraction: 0.61803, wobbleAmplitude: 4e-8, wobbleFrequency: 4e5 },
];

// Two providers over the identical curve: one offering only the scalar seam, one also
// offering the batched read. Both count what they were asked for.
function providersFor(speedAt) {
  const sampleAt = (jd) => ({ longitude: 120 + (jd - JD_LO) * 0.004, speed: speedAt(jd) });
  const seriesFor = () => [{ jd: JD_LO, ...sampleAt(JD_LO) }, { jd: JD_HI, ...sampleAt(JD_HI) }];
  const scalar = { samples: 0, spawns: 0 };
  const batched = { samples: 0, spawns: 0 };

  return {
    scalar,
    batched,
    scalarProvider: {
      seriesFor,
      positionAt: (jd) => {
        scalar.samples += 1;
        scalar.spawns += 1;
        return sampleAt(jd);
      },
    },
    batchedProvider: {
      seriesFor,
      positionAt: (jd) => {
        batched.samples += 1;
        batched.spawns += 1;
        return sampleAt(jd);
      },
      samplesFrom: (startJd, stepDays, count) => {
        batched.samples += count;
        batched.spawns += 1;
        return Array.from({ length: count }, (_, i) => {
          const jd = startJd + i * stepDays;
          return { jd, ...sampleAt(jd) };
        });
      },
    },
  };
}

function stationJd(provider) {
  const { stations } = scanTransitingBody(provider, JD_LO, JD_HI, 1);
  assert.equal(stations.length, 1, 'expected exactly one station in the synthetic bracket');
  return stations[0].jd;
}

// The rule this change did NOT adopt, written out here so the fixtures above can be shown
// to actually discriminate between the two. Kept independent of lib/ on purpose.
function firstFlipRefinement(speedAt) {
  const signLo = Math.sign(speedAt(JD_LO));
  let lo = JD_LO;
  let hi = JD_HI;
  while (hi - lo > JD_TOLERANCE) {
    const divisions = 2 ** Math.min(6, Math.max(1, Math.ceil(Math.log2((hi - lo) / JD_TOLERANCE))));
    const step = (hi - lo) / divisions;
    const jds = Array.from({ length: divisions - 1 }, (_, i) => (lo + step) + i * step);
    let index = 0;
    while (index < jds.length && Math.sign(speedAt(jds[index])) === signLo) index += 1;
    if (index > 0) lo = jds[index - 1];
    if (index < jds.length) hi = jds[index];
  }
  return (lo + hi) / 2;
}

test('batched station refinement lands on the same JD as scalar bisection (monotone predicate)', () => {
  const { scalarProvider, batchedProvider } = providersFor(speedCurve({ rootFraction: 0.371828 }));
  assert.equal(stationJd(batchedProvider), stationJd(scalarProvider));
});

// The regression guard that matters. Swap the index replay in refineStationJd for a
// left-to-right scan and this is the assertion that goes red.
test('batched station refinement lands on the same JD as scalar bisection (dithering predicate)', () => {
  for (const fixture of DITHER_FIXTURES) {
    const { scalarProvider, batchedProvider } = providersFor(speedCurve(fixture));
    const scalarJd = stationJd(scalarProvider);
    const batchedJd = stationJd(batchedProvider);
    assert.equal(
      batchedJd, scalarJd,
      `${JSON.stringify(fixture)}: batched station is ${((batchedJd - scalarJd) * 86400).toExponential(2)}s from the scalar one`,
    );
  }
});

// Without this the test above proves nothing: on a curve where every rule agrees, an
// equality assertion passes no matter what refineStationJd does.
test('the dithering fixtures really do discriminate: the leftmost-flip rule misses by seconds', () => {
  for (const fixture of DITHER_FIXTURES) {
    const speedAt = speedCurve(fixture);
    const { scalarProvider } = providersFor(speedAt);
    const offBySeconds = Math.abs(firstFlipRefinement(speedAt) - stationJd(scalarProvider)) * 86400;
    assert.ok(offBySeconds > 0.5, `${JSON.stringify(fixture)}: leftmost-flip was only ${offBySeconds}s off, too weak a fixture`);
  }
});

test('batching trades sample count for spawn count: same halvings, far fewer spawns', () => {
  const { scalarProvider, batchedProvider, scalar, batched } = providersFor(speedCurve({ rootFraction: 0.371828 }));
  stationJd(scalarProvider);
  stationJd(batchedProvider);

  // A day-wide bracket down to JD_TOLERANCE is 21 halvings, one scalar sample each, plus
  // the position read scanTransitingBody does at the refined station JD.
  assert.equal(scalar.spawns, 21 + 1);
  // The same 21 halvings, fetched 63 grid points at a time: 4 batched spawns and the same
  // trailing read.
  assert.equal(batched.spawns, 4 + 1);
  assert.ok(batched.samples > scalar.samples, 'the batched path deliberately fetches MORE samples per spawn');
});

test('a provider with no samplesFrom keeps the scalar path', () => {
  const { scalarProvider, scalar } = providersFor(speedCurve({ rootFraction: 0.371828 }));
  assert.ok(Number.isFinite(stationJd(scalarProvider)));
  assert.ok(scalar.spawns > 20, 'the scalar fallback should still be paying per-halving');
});
