/**
 * SUP-391: findContacts used to decide whether each interval between orb-boundary crossings
 * was in orb by reading |g| at the interval's MIDPOINT - one swetest spawn apiece, and a
 * third of a find_events aspect search's spawns. It now derives that bit from numbers it
 * already holds, two independent ways (parity across the crossing, and the sign of the
 * crossing's own speed against which boundary it is), and samples the midpoint only when the
 * two disagree.
 *
 * The point of these tests is the "only when they disagree" half. Against the real ephemeris
 * the two derivations agreed on every interval of every shape measured (251/52/154/37
 * intervals on the four calls profiled for that ticket, zero probes), which is the desired
 * outcome and also means the real ephemeris never exercises the fallback at all. So it is
 * pinned here instead, on synthetic providers that force each way in.
 *
 * The oracle is not a second copy of the algorithm: longitude here is a closed-form sinusoid,
 * so the episode boundaries and exact passes are found by scanning THAT curve directly at
 * 10-second resolution and bisecting each sign change - no provider, no segments, no
 * enumeration. A bug shared between engine and oracle would have to be a bug in `Math.sin`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTransitingBody, findContacts } from '../lib/event-search.js';

const JD_LO = 2461041.5;
const PERIOD_DAYS = 20;
const WINDOW_DAYS = 2 * PERIOD_DAYS;
const JD_HI = JD_LO + WINDOW_DAYS;
const CENTRE = 100;
const AMPLITUDE = 5;
const ORB_ALLOWED = 1;

// Deliberately not a whole number of days. On a round phase every exact pass lands on a
// coarse-series row, which is the shared endpoint of two segments, and enumerateCrossings
// reports it from both - a pre-existing edge of the segment enumeration that has nothing to
// do with what these tests are about, so the fixture steps around it.
const PHASE_DAYS = 0.37;

// The aspect target is offset from the curve's centre, which is what breaks the sinusoid's
// symmetry. On a centred target each exact pass sits exactly at the midpoint of its own orb
// episode, and the refinement converging on the pass is then indistinguishable from a
// midpoint probe - the very thing these tests count.
const TARGET_OFFSET = 0.3;
const TARGET = CENTRE + TARGET_OFFSET;

const thetaAt = (jd) => (2 * Math.PI * (jd - JD_LO - PHASE_DAYS)) / PERIOD_DAYS;
const trueLongitude = (jd) => CENTRE + AMPLITUDE * Math.sin(thetaAt(jd));
const trueSpeed = (jd) => AMPLITUDE * ((2 * Math.PI) / PERIOD_DAYS) * Math.cos(thetaAt(jd));

// Signed offset from the aspect target. Stays well inside +/-180 for these amplitudes, so no
// wrapping is involved and the oracle can work on it directly.
const gapAt = (jd) => trueLongitude(jd) - TARGET;

// Independent oracle: bracket every sign change of `f` on a scan far finer than any feature
// of the curve (the narrowest orb episode here is ~0.4 days), then bisect each bracket to
// well under the engine's own 0.05 s tolerance. This never touches the provider or the
// search engine - it reads the closed-form curve directly.
function rootsOf(f) {
  const SCAN_STEP = 1 / 8640; // 10 seconds
  const roots = [];
  let prevJd = JD_LO;
  let prev = f(prevJd);
  for (let jd = JD_LO + SCAN_STEP; jd <= JD_HI; jd = Math.min(jd + SCAN_STEP, JD_HI)) {
    const curr = f(jd);
    if (Math.sign(curr) !== Math.sign(prev)) {
      let lo = prevJd;
      let hi = jd;
      for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(f(mid)) === Math.sign(prev)) lo = mid; else hi = mid;
      }
      roots.push((lo + hi) / 2);
    }
    prevJd = jd;
    prev = curr;
    if (jd >= JD_HI) break;
  }
  return roots;
}

// Episodes are the window cut at every |g| = ORB_ALLOWED crossing, keeping the stretches
// where |g| is actually inside it; passes are the roots of g itself.
const EXPECTED_EPISODES = (() => {
  const orbRoots = rootsOf((jd) => Math.abs(gapAt(jd)) - ORB_ALLOWED);
  const passRoots = rootsOf(gapAt);
  const boundaries = [JD_LO, ...orbRoots, JD_HI];
  const episodes = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const entersOrbJd = boundaries[i];
    const leavesOrbJd = boundaries[i + 1];
    if (Math.abs(gapAt((entersOrbJd + leavesOrbJd) / 2)) > ORB_ALLOWED) continue;
    episodes.push({
      entersOrbJd,
      leavesOrbJd,
      entersTruncated: entersOrbJd === JD_LO,
      leavesTruncated: leavesOrbJd === JD_HI,
      passJds: passRoots.filter((jd) => jd >= entersOrbJd && jd <= leavesOrbJd),
    });
  }
  return episodes;
})();

function isoFromJd(jd) {
  const ms = Math.round(((jd - 2440587.5) * 86400000) / 1000) * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// `speedFor(jd, trueLongitudeAtJd, honestSpeed)` is the whole knob: an honest provider
// returns `honestSpeed`, and the two fallback provokers below corrupt it only for samples
// sitting on an orb boundary, so nothing outside the branch under test changes.
function providerWith(speedFor) {
  const counter = { samples: 0, jds: [] };
  const sampleAt = (jd) => {
    counter.samples += 1;
    counter.jds.push(jd);
    const longitude = trueLongitude(jd);
    return { longitude, speed: speedFor(jd, longitude, trueSpeed(jd)) };
  };
  const provider = {
    positionAt: sampleAt,
    seriesFor(startJd, endJd, stepDays) {
      const rows = [];
      for (let jd = startJd; jd < endJd - 1e-9; jd += stepDays) rows.push({ jd, ...sampleAt(jd) });
      rows.push({ jd: endJd, ...sampleAt(endJd) });
      return rows;
    },
  };
  return { provider, counter };
}

const onOrbBoundary = (longitude) => Math.abs(Math.abs(longitude - TARGET) - ORB_ALLOWED) < 1e-6;

function contactsFrom(provider) {
  const { segments, stations } = scanTransitingBody(provider, JD_LO, JD_HI, 1);
  return { segments, stations };
}

function runFindContacts(speedFor) {
  const { provider, counter } = providerWith(speedFor);
  const { segments, stations } = contactsFrom(provider);
  // Count only what findContacts itself spends, not the coarse scan that set it up.
  counter.samples = 0;
  counter.jds = [];
  const contacts = findContacts({
    provider,
    segments,
    stations,
    natalLongitude: TARGET,
    aspectAngle: 0,
    orbAllowed: ORB_ALLOWED,
    startJd: JD_LO,
    endJd: JD_HI,
  });
  return { contacts, samples: counter.samples, jds: counter.jds };
}

// The nine intervals the in-orb loop walks: the window edges plus the eight orb-boundary
// crossings, taken from the closed-form oracle rather than from the run under test.
const INTERVAL_MIDPOINTS = (() => {
  const boundaries = [JD_LO];
  for (const episode of EXPECTED_EPISODES) {
    if (episode.entersOrbJd !== JD_LO) boundaries.push(episode.entersOrbJd);
    if (episode.leavesOrbJd !== JD_HI) boundaries.push(episode.leavesOrbJd);
  }
  boundaries.push(JD_HI);
  return boundaries.slice(0, -1).map((lo, i) => (lo + boundaries[i + 1]) / 2);
})();

// Refinement lands within JD_TOLERANCE (0.05 s) of each analytic boundary, so a real
// midpoint probe sits within ~0.03 s of the figure above - while the narrowest interval is
// hours wide, leaving no room for a false match at this epsilon (~0.9 s).
const MIDPOINT_EPSILON = 1e-5;

// Every interval except the window's first, which is settled from |g| at startJd and so is
// never probed even when both derivations are unavailable.
const PROBEABLE_INTERVALS = INTERVAL_MIDPOINTS.length - 1;

function midpointProbeCount(jds) {
  return jds.filter((jd) => INTERVAL_MIDPOINTS.some((mid) => Math.abs(jd - mid) < MIDPOINT_EPSILON)).length;
}

function assertMatchesOracle(contacts, label) {
  assert.equal(contacts.length, EXPECTED_EPISODES.length, `${label}: episode count`);
  contacts.forEach((contact, i) => {
    const expected = EXPECTED_EPISODES[i];
    assert.equal(contact.enters_orb, isoFromJd(expected.entersOrbJd), `${label}: episode ${i} enters_orb`);
    assert.equal(contact.leaves_orb, isoFromJd(expected.leavesOrbJd), `${label}: episode ${i} leaves_orb`);
    assert.equal(contact.enters_orb_truncated, expected.entersTruncated, `${label}: episode ${i} enters_orb_truncated`);
    assert.equal(contact.leaves_orb_truncated, expected.leavesTruncated, `${label}: episode ${i} leaves_orb_truncated`);
    assert.equal(contact.passes.length, expected.passJds.length, `${label}: episode ${i} pass count`);
    expected.passJds.forEach((passJd, j) => {
      assert.equal(contact.passes[j].datetime, isoFromJd(passJd), `${label}: episode ${i} pass ${j} datetime`);
    });
  });
}

const HONEST = (jd, longitude, speed) => speed;

// Every assertion below is against the oracle, so an oracle that quietly collapsed to zero
// episodes would make all of them vacuous. Pin its shape: five episodes (both window edges
// truncated), eight interior orb crossings, and four exact passes - the last episode's own
// pass falls just past the window end, which is spec Q4's envelope-with-no-pass case.
test('the fixture exercises what these tests claim to exercise', () => {
  assert.equal(EXPECTED_EPISODES.length, 5);
  assert.equal(PROBEABLE_INTERVALS, 8);
  assert.deepEqual(EXPECTED_EPISODES.map((e) => e.passJds.length), [1, 1, 1, 1, 0]);
  assert.equal(EXPECTED_EPISODES[0].entersTruncated, true);
  assert.equal(EXPECTED_EPISODES[4].leavesTruncated, true);

  // No boundary or pass may land on a coarse-series row, and no pass may land on its own
  // episode's midpoint - the two fixture degeneracies that would make the probe counter lie.
  for (const episode of EXPECTED_EPISODES) {
    const found = [...episode.passJds];
    if (!episode.entersTruncated) found.push(episode.entersOrbJd); // a truncated edge IS the
    if (!episode.leavesTruncated) found.push(episode.leavesOrbJd); // window edge, row or not
    for (const jd of found) {
      const dayFraction = Math.abs(((jd - JD_LO) % 1) - 0.5);
      assert.ok(dayFraction < 0.5 - 1e-3, `${jd} sits on a coarse-series row`);
    }
    for (const passJd of episode.passJds) {
      const mid = (episode.entersOrbJd + episode.leavesOrbJd) / 2;
      assert.ok(Math.abs(passJd - mid) > MIDPOINT_EPSILON * 100, `pass ${passJd} sits at its episode midpoint`);
    }
  }
});

test('orb episodes match the closed-form oracle, with no interval sampled at its midpoint', () => {
  const { contacts, jds } = runFindContacts(HONEST);

  assertMatchesOracle(contacts, 'honest');
  assert.equal(midpointProbeCount(jds), 0, 'expected every interval to be settled without a probe');
});

test('a station exactly on the orb boundary falls back to the midpoint probe', () => {
  // speed 0 at the crossing leaves the slope derivation with nothing to say (`bySlope ===
  // null`), which must send the interval to the probe rather than to parity alone.
  const zeroOnBoundary = (jd, longitude, speed) => (onOrbBoundary(longitude) ? 0 : speed);
  const forced = runFindContacts(zeroOnBoundary);

  assertMatchesOracle(forced.contacts, 'zero-speed-on-boundary');
  assert.equal(midpointProbeCount(forced.jds), PROBEABLE_INTERVALS, 'expected every interval after a crossing to be probed');
});

test('parity and slope disagreeing falls back to the midpoint probe', () => {
  // Flipping the reported speed sign ON THE BOUNDARY ONLY makes the slope derivation claim
  // the opposite of what parity claims. That disagreement is precisely the anomaly the old
  // unconditional probe existed to catch, so the probe must run and its answer must win -
  // note the oracle still has to hold with the slope derivation actively lying.
  const flipOnBoundary = (jd, longitude, speed) => (onOrbBoundary(longitude) ? -speed : speed);
  const forced = runFindContacts(flipOnBoundary);

  assertMatchesOracle(forced.contacts, 'flipped-speed-on-boundary');
  assert.equal(midpointProbeCount(forced.jds), PROBEABLE_INTERVALS, 'expected every interval after a crossing to be probed');
});
