// The position-provider seam (SUP-349 spec Q10) and the stepped-scan wrapper it feeds.
// This module is the only place that spawns `swetest` for the event search engine
// (lib/event-search.js) - the engine itself takes providers built from these functions
// and never shells out on its own, which is what lets a progressions/solar-arc provider
// be swapped in later without touching the engine.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseStepRow, parseEclipseBlock } from './swetest-parse.js';

const DEFAULT_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'swisseph');

function ephePath() {
  return process.env.SE_EPHE_PATH || DEFAULT_EPHE_PATH;
}

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

function runSwetest(args) {
  try {
    return execSync(`SE_EPHE_PATH=${ephePath()} swetest ${args}`, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Failed to execute swetest: ${error.message}`);
  }
}

// Single-point lookup: longitude/speed of `body` at Julian day `jd` (UT). Always passes
// `-ut` - see the JD_UNIX_EPOCH comment above for why that isn't optional.
export function positionAt(body, jd) {
  const output = runSwetest(`-j${jd} -ut -p${bodyCode(body)} -fJPls -g, -head -n1`);
  const row = output.split('\n').map(parseStepRow).find(Boolean);
  if (!row) throw new Error(`swetest returned no position for ${body} at JD ${jd}`);
  return { longitude: row.longitude, speed: row.speed };
}

// Coarse stepped scan: `[{jd, longitude, speed}]` for `body` from `startJd` to `endJd`
// (inclusive Julian days, UT) at a flat `stepDays` step (default 1 day - spec Q1: this
// is a bracketing scan for stations, not a per-body-tuned sampling rate). One swetest
// spawn regardless of window length. Takes JD rather than Date, like positionAt, so a
// caller composing the two (e.g. lib/event-search.js's station/segment scan) never has
// to convert back and forth mid-computation.
export function seriesFor(body, startJd, endJd, stepDays = 1) {
  const count = Math.floor((endJd - startJd) / stepDays + 1e-9) + 1;
  if (count < 1) throw new Error('seriesFor: end must not precede start');

  const output = runSwetest(`-j${startJd} -ut -p${bodyCode(body)} -fJPls -g, -head -n${count} -s${stepDays}`);
  return output
    .split('\n')
    .map(parseStepRow)
    .filter(Boolean)
    .map((row) => ({ jd: row.jd, longitude: row.longitude, speed: row.speed }));
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
    const output = runSwetest(`-j${startJd} -ut ${flag} -n${n} -head`);
    const eclipses = parseEclipseBlock(output);
    const lastJd = eclipses.length > 0 ? eclipses[eclipses.length - 1].jd : startJd;

    if (lastJd >= endJd || n >= MAX_N) {
      return eclipses.filter((e) => e.jd >= startJd && e.jd <= endJd);
    }
  }
}
