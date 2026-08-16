// The position-provider seam (SUP-349 spec Q10) and the stepped-scan wrapper it feeds.
// This module is where the event search engine (lib/event-search.js) gets every BODY
// position from `swetest` (via lib/swetest-exec.js) - the engine itself takes providers
// built from these functions and never spawns anything of its own, which is what lets a
// progressions/solar-arc provider be swapped in later without touching it. The one other
// thing a search can need is a house frame (the progressed Ascendant and moving cusps),
// which is a `-house` chart computation rather than a body series and lives in
// lib/house-frame.js.

import { execSwetest } from './swetest-exec.js';
import { parseStepRow, parseEclipseBlock } from './swetest-parse.js';

// Julian day (UT) <-> calendar Date. JD 2440587.5 is the Unix epoch
// (1970-01-01T00:00:00Z); every other instant is a fixed day-fraction offset from it, so
// this is exact, not an approximation. Both directions treat the JD as UT throughout -
// pairing with `-ut` on every swetest call below is what makes that true (spec §4.8: a
// dropped `-ut` reads the JD as ET and is 38.2" off on the Moon).
const JD_UNIX_EPOCH = 2440587.5;

export function jdFromDate(date) {
  return date.getTime() / 86400000 + JD_UNIX_EPOCH;
}

export function dateFromJd(jd) {
  return new Date((jd - JD_UNIX_EPOCH) * 86400000);
}

// swetest -p body codes (index.js uses the same table for the chart tools; duplicated
// here rather than imported because index.js is not part of this ticket's scope and
// shouldn't become a dependency of lib/).
const BODY_CODES = {
  Sun: '0',
  Moon: '1',
  Mercury: '2',
  Venus: '3',
  Mars: '4',
  Jupiter: '5',
  Saturn: '6',
  Uranus: '7',
  Neptune: '8',
  Pluto: '9',
  'North Node': 't',
  Lilith: 'A',
  Chiron: 'D',
  Ceres: 'F',
  Pallas: 'G',
  Juno: 'H',
  Vesta: 'I',
};

function bodyCode(body) {
  const code = BODY_CODES[body];
  if (!code) throw new Error(`Unknown body for ephemeris series: ${body}`);
  return code;
}

// Argv arrays, not command strings: lib/swetest-exec.js spawns the binary directly, so
// nothing here is ever word-split or re-parsed by a shell.
function runSwetest(argv) {
  try {
    return execSwetest(argv);
  } catch (error) {
    throw new Error(`Failed to execute swetest: ${error.message}`);
  }
}

// Single-point lookup: longitude/speed of `body` at Julian day `jd` (UT). Always passes
// `-ut` - see the JD_UNIX_EPOCH comment above for why that isn't optional.
export function positionAt(body, jd) {
  const output = runSwetest([`-j${jd}`, '-ut', `-p${bodyCode(body)}`, '-fJPls', '-g,', '-head', '-n1']);
  const row = output.split('\n').map(parseStepRow).find(Boolean);
  if (!row) throw new Error(`swetest returned no position for ${body} at JD ${jd}`);
  return { longitude: row.longitude, speed: row.speed };
}

// Several bodies at one instant in ONE swetest spawn (SUP-387): `-p` takes a string of
// body codes and emits one row per code at each timestep, so N bodies at the same JD cost
// one process instead of N. Returns positions in the order `bodies` was given.
//
// Row order is the ORDER OF THE CODE STRING, not a sorted or fixed body order - verified
// directly against this binary (`-p10` prints Moon then Sun; `-pD4` prints Chiron then
// Mars). Names aren't used to re-key the rows because swetest's printed names don't match
// this server's body names for several bodies (`t` prints "true Node", `A` prints "mean
// Apogee"), so the row count is checked instead and
// test/ephemeris-series.integration.test.js pins the ordering contract against a future
// swetest.
export function positionsAt(bodies, jd) {
  const codes = bodies.map(bodyCode).join('');
  const output = runSwetest([`-j${jd}`, '-ut', `-p${codes}`, '-fJPls', '-g,', '-head', '-n1']);
  const rows = output.split('\n').map(parseStepRow).filter(Boolean);
  if (rows.length !== bodies.length) {
    throw new Error(`swetest returned ${rows.length} rows for ${bodies.length} bodies (${bodies.join(', ')}) at JD ${jd}`);
  }
  return rows.map((row) => ({ longitude: row.longitude, speed: row.speed }));
}

// `count` positions of `body` on an arithmetic JD grid - `startJd + i*stepDays` for i in
// [0, count) - in ONE swetest spawn (SUP-390). Same `-jX -sSTEP -nN` form seriesFor uses,
// but aimed at a bracket being narrowed rather than a window being scanned: the caller
// picks the step, and the grid may be arbitrarily fine.
//
// The returned `jd` is COMPUTED, never parsed back out of the output, and that is the whole
// reason this isn't just seriesFor with a small step: `-fJ` prints the Julian day to five
// decimals - 0.86 seconds - which is fifteen times COARSER than lib/event-search.js's
// JD_TOLERANCE. Reading a refinement grid's JDs off the rows would quantise the bracket to
// something wider than the tolerance it is trying to reach, and the loop would never
// terminate on anything but the row index. swetest's own step arithmetic is `t0 + i*step`
// to full double precision, verified against per-point `-j` queries at steps from 1 day
// down to 1e-8 days (~1 ms): identical longitude and speed to every printed digit, which is
// what makes a batched grid a drop-in for a sequence of scalar samples rather than an
// approximation of one. test/ephemeris-series.integration.test.js pins that equivalence.
export function samplesFrom(body, startJd, stepDays, count) {
  if (count <= 0) return [];

  const output = runSwetest([`-j${startJd}`, '-ut', `-p${bodyCode(body)}`, '-fJPls', '-g,', '-head', `-n${count}`, `-s${stepDays}`]);
  const rows = output.split('\n').map(parseStepRow).filter(Boolean);
  if (rows.length !== count) {
    throw new Error(`swetest returned ${rows.length} rows for ${count} samples of ${body} from JD ${startJd} step ${stepDays}`);
  }

  return rows.map((row, i) => ({ jd: startJd + i * stepDays, longitude: row.longitude, speed: row.speed }));
}

// Coarse stepped scan: `[{jd, longitude, speed}]` for `body` from `startJd` to `endJd`
// (inclusive Julian days, UT) at a flat `stepDays` step (default 1 day - spec Q1: this
// is a bracketing scan for stations, not a per-body-tuned sampling rate). One swetest
// spawn regardless of window length. Takes JD rather than Date, like positionAt, so a
// caller composing the two (e.g. lib/event-search.js's station/segment scan) never has
// to convert back and forth mid-computation.
//
// §3.1 allows `window_start`/`window_end` at different times of day, so the span isn't
// always an exact multiple of `stepDays`. The row count is CEILING-based (not floored) so
// the coarse scan never falls short of endJd, and the last row is then forced to land
// exactly on endJd - either by trimming a swetest row that overshot it, or by appending an
// exact `positionAt` sample when the last coarse row falls short. The series must never
// extend past endJd: a trailing overshoot row would push segments outside the window and
// surface passes/stations that were never actually in it.
export function seriesFor(body, startJd, endJd, stepDays = 1) {
  if (endJd < startJd) throw new Error('seriesFor: end must not precede start');

  const steps = Math.max(0, Math.ceil((endJd - startJd) / stepDays - 1e-9));
  const count = steps + 1;

  const output = runSwetest([`-j${startJd}`, '-ut', `-p${bodyCode(body)}`, '-fJPls', '-g,', '-head', `-n${count}`, `-s${stepDays}`]);
  const rows = output
    .split('\n')
    .map(parseStepRow)
    .filter(Boolean)
    .map((row) => ({ jd: row.jd, longitude: row.longitude, speed: row.speed }));

  while (rows.length > 0 && rows[rows.length - 1].jd > endJd + 1e-9) rows.pop();

  const last = rows[rows.length - 1];
  if (!last || last.jd < endJd - 1e-9) {
    const { longitude, speed } = positionAt(body, endJd);
    rows.push({ jd: endJd, longitude, speed });
  }

  return rows;
}

const ECLIPSE_FLAGS = { solar: '-solecl', lunar: '-lunecl' };

// Eclipses of `kind` ('solar' | 'lunar') between `startJd` and `endJd` (Julian days, UT).
// `-nN` returns exactly N events starting from the given epoch regardless of the
// window (spec §1.5), so this over-requests and doubles until the window is covered
// (or a hard cap is hit) rather than trusting a single guess to be enough.
export function eclipsesFor(kind, startJd, endJd) {
  const flag = ECLIPSE_FLAGS[kind];
  if (!flag) throw new Error(`Unknown eclipse kind: ${kind}`);

  const MAX_N = 2000;

  for (let n = 40; ; n = Math.min(n * 2, MAX_N)) {
    const output = runSwetest([`-j${startJd}`, '-ut', flag, `-n${n}`, '-head']);
    const eclipses = parseEclipseBlock(output);
    const lastJd = eclipses.length > 0 ? eclipses[eclipses.length - 1].jd : startJd;

    if (lastJd >= endJd || n >= MAX_N) {
      return eclipses.filter((e) => e.jd >= startJd && e.jd <= endJd);
    }
  }
}
