import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jdFromDate, dateFromJd, positionAt, positionsAt, seriesFor, eclipsesFor } from '../lib/ephemeris-series.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const jd = (iso) => jdFromDate(new Date(iso));

test('jdFromDate/dateFromJd round-trip and match the spec epoch (2026-01-01T00:00:00Z = JD 2461041.5)', () => {
  const date = new Date('2026-01-01T00:00:00Z');
  assert.equal(jdFromDate(date), 2461041.5);
  assert.equal(dateFromJd(2461041.5).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(dateFromJd(jdFromDate(date)).getTime(), date.getTime());
});

// Spec §4.8 - the ΔT regression guard. Every JD handed to swetest must carry `-ut`, or
// swetest reads it as Ephemeris Time and the position is off by delta-T (~69s here,
// 38.2" of Moon longitude). This is the one assertion that catches every dropped `-ut`
// in the JD handoff path.
test('positionAt: eclipse JD 2461102.981727 yields Moon longitude 162.8592488 (ΔT guard)', { skip: !HAS_SWETEST }, () => {
  const { longitude } = positionAt('Moon', 2461102.981727);
  assert.ok(Math.abs(longitude - 162.8592488) < 1e-6, `expected 162.8592488, got ${longitude}`);
});

// Captured/verified directly against the vendored ephemeris (spec §1.1 example).
test('seriesFor: matches the captured two-body, two-timestep example', { skip: !HAS_SWETEST }, () => {
  const rows = seriesFor('Mars', jd('2026-01-01T00:00:00Z'), jd('2026-01-02T00:00:00Z'), 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].jd, 2461041.5);
  assert.ok(Math.abs(rows[0].longitude - 282.6881579) < 1e-6);
  assert.ok(Math.abs(rows[0].speed - 0.7663630) < 1e-6);
  assert.ok(Math.abs(rows[1].longitude - 283.4548555) < 1e-6);
});

test('seriesFor: one row per day across the window, inclusive of both ends', { skip: !HAS_SWETEST }, () => {
  const rows = seriesFor('Saturn', jd('2026-01-01T00:00:00Z'), jd('2026-01-11T00:00:00Z'), 1);
  assert.equal(rows.length, 11);
  assert.equal(rows[0].jd, 2461041.5);
  assert.equal(rows[rows.length - 1].jd, 2461051.5);
});

// Regression guard (PR #51 review): the old floor-based row count undershot whenever the
// span wasn't an exact multiple of stepDays, silently dropping the final partial day. §3.1
// allows window_start/window_end at different times of day, so a non-aligned window's last
// row must land exactly on endJd - not stop short of it, and not overshoot past it either.
test('seriesFor: non-day-aligned window lands the last row exactly on endJd, not short of it', { skip: !HAS_SWETEST }, () => {
  const startJd = jd('2026-01-01T00:00:00Z');
  const endJd = jd('2026-01-02T12:00:00Z'); // 1.5 days - not a multiple of the 1-day step
  const rows = seriesFor('Mars', startJd, endJd, 1);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].jd, startJd);
  assert.equal(rows[1].jd, startJd + 1);
  assert.equal(rows[rows.length - 1].jd, endJd);
  assert.ok(rows.every((r) => r.jd <= endJd), 'no row may extend past endJd');
});

test('positionAt: agrees with the matching row from seriesFor at the same JD', { skip: !HAS_SWETEST }, () => {
  const rows = seriesFor('Pluto', jd('2026-06-01T00:00:00Z'), jd('2026-06-02T00:00:00Z'), 1);
  const point = positionAt('Pluto', rows[0].jd);
  assert.ok(Math.abs(point.longitude - rows[0].longitude) < 1e-6);
  assert.ok(Math.abs(point.speed - rows[0].speed) < 1e-6);
});

// SUP-387. positionsAt exists to turn N single-body spawns into one, so the only thing
// that can go wrong is silently attributing one body's position to another - and the row
// mapping rests on swetest emitting rows in the order the `-p` codes were given. That is
// an observed property of the binary, not a documented guarantee, so it gets pinned here:
// a reordering (or a future swetest that sorts by planet number) fails this rather than
// quietly returning Mars' longitude for Chiron in every pair aspect the server reports.
test('positionsAt: each body matches its own positionAt, in the order requested', { skip: !HAS_SWETEST }, () => {
  // Deliberately not in swetest's own body-number order, and including two bodies whose
  // printed names ("true Node", "mean Apogee") don't match this server's names - the two
  // cases a name-keyed implementation would get wrong.
  const bodies = ['Chiron', 'Mars', 'North Node', 'Moon', 'Lilith'];
  const atJd = jd('2026-06-01T00:00:00Z');

  const batched = positionsAt(bodies, atJd);
  assert.equal(batched.length, bodies.length);

  bodies.forEach((body, index) => {
    const single = positionAt(body, atJd);
    assert.equal(batched[index].longitude, single.longitude, `${body} longitude at index ${index}`);
    assert.equal(batched[index].speed, single.speed, `${body} speed at index ${index}`);
  });
});

test('positionsAt: rejects an unknown body rather than mis-mapping the rows it did get', { skip: !HAS_SWETEST }, () => {
  assert.throws(() => positionsAt(['Sun', 'Nibiru'], jd('2026-06-01T00:00:00Z')), /Unknown body/);
});

// Spec §4.7 - both eclipse cases, verified against the vendored ephemeris.
test('eclipsesFor: solar eclipse annotation matches the verified 2026-02-17 annular solar', { skip: !HAS_SWETEST }, () => {
  const eclipses = eclipsesFor('solar', jd('2026-01-01T00:00:00Z'), jd('2027-01-01T00:00:00Z'));
  assert.equal(eclipses.length, 2); // annular solar 2026-02-17, total solar 2026-08-12
  assert.equal(eclipses[0].eclipse_type, 'annular solar');
  assert.equal(eclipses[0].saros_series, 121);
  assert.equal(eclipses[0].saros_number, 61);
  assert.deepEqual(eclipses[0].magnitudes, [0.9638, 0.9797, 0.9288]);
  assert.equal(dateFromJd(eclipses[0].jd).toISOString(), '2026-02-17T12:11:53.232Z');
});

test('eclipsesFor: lunar eclipse annotation matches the verified 2026-03-03 total lunar', { skip: !HAS_SWETEST }, () => {
  const eclipses = eclipsesFor('lunar', jd('2026-01-01T00:00:00Z'), jd('2027-01-01T00:00:00Z'));
  assert.equal(eclipses.length, 2); // total lunar 2026-03-03, partial lunar 2026-08-28
  assert.equal(eclipses[0].eclipse_type, 'total lunar eclipse');
  assert.equal(eclipses[0].saros_series, 133);
  assert.equal(eclipses[0].saros_number, 27);
  assert.equal(dateFromJd(eclipses[0].jd).toISOString(), '2026-03-03T11:33:41.212Z');
});

// Regression guard for the over-request-and-trim logic (spec §1.5: `-nN` returns exactly
// N events regardless of window, so a naive single small request can silently miss
// events near the end of a wide window).
test('eclipsesFor: covers a window wider than the initial over-request guess', { skip: !HAS_SWETEST }, () => {
  const eclipses = eclipsesFor('lunar', jd('2026-01-01T00:00:00Z'), jd('2036-01-01T00:00:00Z'));
  assert.ok(eclipses.length >= 20, `expected at least 20 lunar eclipses in 10 years, got ${eclipses.length}`);
  for (const e of eclipses) {
    assert.ok(e.jd >= jd('2026-01-01T00:00:00Z'));
    assert.ok(e.jd <= jd('2036-01-01T00:00:00Z'));
  }
});
