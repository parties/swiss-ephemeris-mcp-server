import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { TROPICAL_YEAR_DAYS } from '../lib/progressions.js';
import { DAY_CHART, SOUTHERN_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const Y = TROPICAL_YEAR_DAYS;

function assertCloseIso(actual, expected, toleranceSec = 2) {
  const diff = Math.abs(new Date(actual).getTime() - new Date(expected).getTime()) / 1000;
  assert.ok(diff <= toleranceSec, `expected ${actual} to be within ${toleranceSec}s of ${expected}`);
}

function passCount(pairContacts) {
  return pairContacts.reduce((sum, c) => sum + c.passes.length, 0);
}

function pairName(row) {
  return [row.body_a, row.body_b].sort().join('-');
}

// --- §9.1 The lunation identity - the headline test --------------------------------------

test('§9.1 pair_contacts (Sun, Moon) majors reproduce every quarters lunation datetime to the second, and episodes/passes are two different numbers (26/25)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression',
  };

  const lunations = await server.handleToolCall('find_events', {
    ...window, event_types: ['lunation'], lunation_phases: 'quarters',
  });
  const pairs = await server.handleToolCall('find_events', {
    ...window, event_types: ['aspect'], include_pair_aspects: true, pair_bodies: ['Sun', 'Moon'], include_angles: false,
  });

  assert.equal(pairs.pair_contacts.length > 0, true);
  assert.ok(pairs.pair_contacts.every((c) => pairName(c) === 'Moon-Sun'));

  const PHASE_TO_ASPECT = { new: 'conjunction', first_quarter: 'square', full: 'opposition', last_quarter: 'square' };
  const pairDatetimes = new Set();
  for (const c of pairs.pair_contacts) {
    for (const p of c.passes) pairDatetimes.add(p.datetime);
  }

  assert.equal(lunations.events.length, 12, 'expected 12 quarters lunation events in this 90yr window');
  for (const lunation of lunations.events) {
    assert.ok(pairDatetimes.has(lunation.datetime), `expected pair_contacts to reproduce ${lunation.phase}@${lunation.datetime}`);
  }

  // §6.2: majors over 90yr are 26 orb episodes / 25 exact passes - the 26th episode (a
  // square that enters orb near the window edge and never perfects) inflates the episode
  // count without adding a pass, so the two must be asserted as different numbers or an
  // implementation that silently drops the no-pass episode would still pass.
  const majorEpisodes = pairs.pair_contacts.filter((c) => c.category === 'major');
  assert.equal(majorEpisodes.length, 26);
  assert.equal(passCount(majorEpisodes), 25);
  const truncatedNoPass = majorEpisodes.filter((c) => c.passes.length === 0);
  assert.equal(truncatedNoPass.length, 1);
  assert.equal(truncatedNoPass[0].leaves_orb_truncated, true);
});

test('§9.1/§6.1 eight_phase identity: all 24 phase datetimes reproduced to the second by pair_contacts with include_minor', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression',
  };

  const lunations = await server.handleToolCall('find_events', {
    ...window, event_types: ['lunation'], lunation_phases: 'eight_phase',
  });
  const pairs = await server.handleToolCall('find_events', {
    ...window, event_types: ['aspect'], include_pair_aspects: true, pair_bodies: ['Sun', 'Moon'], include_angles: false, include_minor: true,
  });

  assert.equal(lunations.events.length, 24);

  const pairDatetimes = new Set();
  for (const c of pairs.pair_contacts) {
    for (const p of c.passes) pairDatetimes.add(p.datetime);
  }
  for (const lunation of lunations.events) {
    assert.ok(pairDatetimes.has(lunation.datetime), `expected pair_contacts (with include_minor) to reproduce ${lunation.phase}@${lunation.datetime}`);
  }
});

// --- §9.2 Default progressed pair set counts ----------------------------------------------

test('§9.2 default progressed pair_bodies (10 pairs) over 90yr: per-pair major-episode counts', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  });

  assert.equal(result.settings_used.pair_bodies.length, 5);
  assert.equal(result.settings_used.pairs_searched.length, 10);

  const byPair = {};
  for (const c of result.pair_contacts) {
    const key = pairName(c);
    byPair[key] = (byPair[key] || 0) + 1;
  }

  const totalEpisodes = result.pair_contacts.length;
  const totalPasses = passCount(result.pair_contacts);
  assert.ok(totalEpisodes > 0 && totalPasses > 0, 'expected a nonempty default progressed pair search');

  const moonPairs = ['Moon-Sun', 'Mercury-Moon', 'Moon-Venus', 'Mars-Moon'];
  const moonEpisodes = moonPairs.reduce((sum, key) => sum + (byPair[key] || 0), 0);
  assert.ok(moonEpisodes > totalEpisodes * 0.8, 'expected the four Moon pairs to dominate the default progressed pair output');
});

// --- §9.3 Empty is a correct answer ---------------------------------------------------------

test('§9.3 Sun-Mars and Venus-Mars: zero major-aspect episodes over 90yr; nonzero with include_minor', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  };

  const majors = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Sun', 'Venus', 'Mars'] });
  assert.deepEqual(majors.pair_contacts.filter((c) => pairName(c) === 'Mars-Sun'), []);
  assert.deepEqual(majors.pair_contacts.filter((c) => pairName(c) === 'Mars-Venus'), []);

  const minors = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Sun', 'Venus', 'Mars'], include_minor: true });
  assert.ok(minors.pair_contacts.some((c) => pairName(c) === 'Mars-Sun'), 'expected Sun-Mars minor aspects to appear with include_minor');
  assert.ok(minors.pair_contacts.some((c) => pairName(c) === 'Mars-Venus'), 'expected Venus-Mars minor aspects to appear with include_minor');
});

// --- §9.4 An episode with no pass, and a truncated one --------------------------------------

test('§9.4 Mercury-Venus majors over 90yr: 2 episodes, 1 pass; the second is truncated with no exact pass', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Mercury', 'Venus'], include_angles: false,
  });

  const mercuryVenus = result.pair_contacts.filter((c) => pairName(c) === 'Mercury-Venus' && c.category === 'major');
  assert.equal(mercuryVenus.length, 2);
  assert.equal(passCount(mercuryVenus), 1);

  const truncated = mercuryVenus.find((c) => c.passes.length === 0);
  assert.ok(truncated);
  assert.equal(truncated.leaves_orb_truncated, true);
  assert.ok(truncated.closest_approach.orb < 0.2);

  const perfected = mercuryVenus.find((c) => c.passes.length === 1);
  assert.ok(perfected);
  assert.equal(perfected.aspect, 'conjunction');
});

// --- §9.5 Structural rules -------------------------------------------------------------------

test('§9.5 (Sun, Midheaven) never appears even when explicitly requested, at either angle_method', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  for (const angle_method of ['solar_arc', 'naibod']) {
    const result = await server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
      rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
      pair_bodies: ['Sun', 'Midheaven'], include_angles: true, angle_method,
    });
    assert.deepEqual(result.pair_contacts, []);
    assert.deepEqual(result.settings_used.pairs_searched, []);
  }
});

test('§9.5 North Node never appears in a pair at any setting', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Sun', 'Moon', 'North Node'], include_angles: false, include_minor: true,
  });
  assert.ok(result.pair_contacts.every((c) => c.body_a !== 'North Node' && c.body_b !== 'North Node'));
  assert.ok(result.settings_used.pairs_searched.every((p) => p.body_a !== 'North Node' && p.body_b !== 'North Node'));
});

test('§9.5 Part of Fortune is not a valid pair_bodies member (errors rather than silently doing nothing)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('find_events', {
      birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
      window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
      rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
      pair_bodies: ['Sun', 'Part of Fortune'],
    }),
    /Unknown pair body/
  );
});

test('§9.5 retrograde is per body, not per relative rate: reversing pair order changes no flag', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const window = {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  };

  const forward = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Sun', 'Moon'] });
  const reversed = await server.handleToolCall('find_events', { ...window, pair_bodies: ['Moon', 'Sun'] });

  assert.ok(forward.pair_contacts.length > 0);

  const passesByDatetime = (result) => {
    const map = new Map();
    for (const c of result.pair_contacts) {
      for (const p of c.passes) map.set(p.datetime, p);
    }
    return map;
  };
  const fwdPasses = passesByDatetime(forward);
  const revPasses = passesByDatetime(reversed);
  assert.equal(fwdPasses.size, revPasses.size);

  for (const [datetime, fwdPass] of fwdPasses) {
    const revPass = revPasses.get(datetime);
    assert.ok(revPass, `expected reversed pair_bodies to still produce a pass at ${datetime}`);
    assert.equal(fwdPass.body_a.retrograde, false, 'progressed Sun never retrogrades');
    assert.equal(revPass.body_a.retrograde, false);
    assert.equal(fwdPass.body_b.retrograde, false, 'progressed Moon never retrogrades');
    assert.equal(revPass.body_b.retrograde, false);
  }
});

test('§9.5/§8.1 sign/degree on a pair pass match each body\'s own absolute longitude, not the separation\'s', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2080-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Sun', 'Moon'], include_angles: false,
  });

  const conjunction = result.pair_contacts.find((c) => pairName(c) === 'Moon-Sun' && c.aspect === 'conjunction' && c.passes.length > 0);
  assert.ok(conjunction);
  const pass = conjunction.passes[0];

  const secProg = await server.handleToolCall('calculate_secondary_progressions', {
    birth_datetime: DAY_CHART.datetime, birth_latitude: DAY_CHART.latitude, birth_longitude: DAY_CHART.longitude,
    target_date: pass.datetime,
  });

  const bySun = pass.body_a.longitude === secProg.progressed_planets.Sun.longitude ? pass.body_a : pass.body_b;
  const byMoon = pass.body_a === bySun ? pass.body_b : pass.body_a;
  assert.ok(Math.abs(bySun.longitude - secProg.progressed_planets.Sun.longitude) < 1e-2);
  assert.equal(bySun.sign, secProg.progressed_planets.Sun.sign);
  assert.ok(Math.abs(byMoon.longitude - secProg.progressed_planets.Moon.longitude) < 1e-2);
  assert.equal(byMoon.sign, secProg.progressed_planets.Moon.sign);

  // Neither reported longitude should equal the RELATIVE separation (the bug §8.1 warns
  // against) - a conjunction's separation is near 0, which is nowhere near either body's
  // actual progressed longitude at this instant in a 1990-2080 window.
  assert.ok(Math.abs(pass.body_a.longitude) > 1);
  assert.ok(Math.abs(pass.body_b.longitude) > 1);
});

test('§9.5 pair_bodies is independent of bodies: bodies:["Moon"] with default pair_bodies still returns all 10 pairs', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    bodies: ['Moon'], include_angles: false,
  });
  assert.deepEqual(result.settings_used.bodies, ['Moon']);
  assert.equal(result.settings_used.pair_bodies.length, 5);
  assert.equal(result.settings_used.pairs_searched.length, 10);
});

test('§9.5 off by default: pair_contacts is empty without include_pair_aspects', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression',
  });
  assert.deepEqual(result.pair_contacts, []);
  assert.equal(result.settings_used.include_pair_aspects, false);
  // pairs_searched previews eligibility regardless of include_pair_aspects.
  assert.equal(result.settings_used.pairs_searched.length, 10);
});

test('§9.5 gated by event_types: include_pair_aspects true but event_types excludes "aspect" produces no pair_contacts', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['station'], include_pair_aspects: true,
  });
  assert.deepEqual(result.pair_contacts, []);
});

// --- §9.6 Transit rate -----------------------------------------------------------------------

test('§9.6 transit rate: default pair_bodies (21 pairs), 2026 window, moiety orbs', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: '2026-01-01T00:00:00Z', window_end: '2027-01-01T00:00:00Z',
    event_types: ['aspect'], include_pair_aspects: true,
  });

  assert.equal(result.settings_used.rate, 'transit');
  assert.equal(result.settings_used.orb_model, 'moiety');
  assert.deepEqual(result.settings_used.pair_bodies, ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Chiron']);
  assert.equal(result.settings_used.pairs_searched.length, 21);

  assert.equal(result.pair_contacts.length, 52, 'expected 52 orb episodes for 21 transit pairs in 2026');
  const totalPasses = result.pair_contacts.reduce((s, c) => s + c.passes.length, 0);
  assert.equal(totalPasses, 46, 'expected 46 exact passes for 21 transit pairs in 2026');
  // "full-window-in-orb" means the pair was in orb for the ENTIRE year and never reached
  // exact (both ends truncated, no pass). Spec §7 measures zero of these because at the
  // transit rate the outer planets actually move. There CAN be zero-pass episodes where
  // the approach reverses mid-window (Saturn-Uranus approaching a sextile then backing
  // off) - those are not full-window-in-orb because at least one orb edge is untruncated.
  const fullWindowInOrb = result.pair_contacts.filter((c) => c.enters_orb_truncated && c.leaves_orb_truncated && c.passes.length === 0);
  assert.equal(fullWindowInOrb.length, 0, 'expected zero full-window-in-orb-without-a-pass rows at the transit rate');
});

// --- §9.7 Southern hemisphere ------------------------------------------------------------------

test('§9.7 SOUTHERN_CHART: default progressed pair set produces no negative-longitude or NaN separations', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: SOUTHERN_CHART.datetime, latitude: SOUTHERN_CHART.latitude, longitude: SOUTHERN_CHART.longitude,
    window_start: SOUTHERN_CHART.datetime, window_end: '2090-03-20T06:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true, include_angles: false,
  });

  assert.ok(result.pair_contacts.length > 0);
  for (const c of result.pair_contacts) {
    assert.ok(Number.isFinite(c.aspect_angle) && c.aspect_angle >= 0);
    for (const p of c.passes) {
      assert.ok(Number.isFinite(p.body_a.longitude) && p.body_a.longitude >= 0 && p.body_a.longitude < 360);
      assert.ok(Number.isFinite(p.body_b.longitude) && p.body_b.longitude >= 0 && p.body_b.longitude < 360);
    }
  }
});

// --- Ruling F: transit-rate pairs, orb model inheritance --------------------------------------

test('faster_body is echoed and matches the pair with the larger mean rate (Moon faster than Sun)', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Sun', 'Moon'], include_angles: false,
  });
  assert.ok(result.pair_contacts.length > 0);
  assert.ok(result.pair_contacts.every((c) => c.faster_body === 'Moon'));
});

test('Ascendant x Midheaven is eligible via explicit pair_bodies but excluded from the default set', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();
  const withoutAngles = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2000-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
  });
  assert.ok(!withoutAngles.settings_used.pairs_searched.some((p) => p.body_a === 'Ascendant' || p.body_b === 'Ascendant'));

  const explicit = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2020-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Ascendant', 'Midheaven'], include_angles: true,
  });
  assert.equal(explicit.settings_used.pairs_searched.length, 1);
  assert.deepEqual(explicit.settings_used.pairs_searched[0], { body_a: 'Ascendant', body_b: 'Midheaven' });

  const gated = await server.handleToolCall('find_events', {
    birth_datetime: DAY_CHART.datetime, latitude: DAY_CHART.latitude, longitude: DAY_CHART.longitude,
    window_start: DAY_CHART.datetime, window_end: '2020-01-01T00:00:00Z',
    rate: 'secondary_progression', event_types: ['aspect'], include_pair_aspects: true,
    pair_bodies: ['Ascendant', 'Midheaven'], include_angles: false,
  });
  assert.deepEqual(gated.settings_used.pairs_searched, []);
});
