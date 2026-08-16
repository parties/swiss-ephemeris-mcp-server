// The one place that spawns `swetest`. Both the chart tools (index.js) and the event
// search's position providers (lib/ephemeris-series.js) go through execSwetest below;
// lib/swetest-parse.js is the matching half that reads what comes back.
//
// Every call used to build a shell string of the form `SE_EPHE_PATH=<dir> swetest <args>`.
// The leading assignment forces execSync through `/bin/sh -c`, so one ephemeris value cost
// two process spawns plus a fresh PATH search for the binary. Resolving `swetest` once and
// calling it directly with execFileSync cuts the per-spawn cost from ~5-10 ms to ~2-3 ms
// (SUP-389) - which is most of the runtime here, because a find_events search is tens of
// thousands of synchronous spawns and almost no computation. It also takes the shell out
// of the path entirely, so SE_EPHE_PATH - an environment variable that was interpolated
// unquoted into a command string - can no longer be read as shell syntax.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The `.se1` data files ship in vendor/ alongside the package (Docker copies them to
// /app/vendor/swisseph; a local or npx install has them next to index.js), so the default
// works with no configuration. SE_EPHE_PATH overrides it.
export const DEFAULT_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'swisseph');

// Read per call rather than resolved once: SE_EPHE_PATH is process state a caller can
// change while running, and the integration tests do exactly that to exercise the
// missing-data-file path.
export function ephePath() {
  return process.env.SE_EPHE_PATH || DEFAULT_EPHE_PATH;
}

const BINARY_NAME = 'swetest';

let cachedBinaryPath;

// First executable match in PATH order - the same rule the shell applied, minus its
// treatment of an empty entry as the current directory, which is not something this
// server should ever pick a binary from.
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.resolve(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Absent, not a file, or not executable - keep looking.
    }
  }
  return null;
}

// Absolute path to the swetest binary, resolved exactly once per process. index.js calls
// this at startup so a missing install fails there, loudly and once, instead of surfacing
// as a per-request `Failed to execute swetest` that reads like a bad request.
export function swetestBinary() {
  if (cachedBinaryPath) return cachedBinaryPath;

  const found = findOnPath(BINARY_NAME);
  if (!found) {
    throw new Error(
      `Swiss Ephemeris binary '${BINARY_NAME}' was not found on PATH (${process.env.PATH || '<empty>'}). ` +
        'Install it and put its directory on PATH - see "Prerequisites for Local Development" in README.md.'
    );
  }

  cachedBinaryPath = found;
  return cachedBinaryPath;
}

// Run swetest with an explicit argv and return its stdout. No shell, so no quoting rules
// and no word splitting: every element of `argv` reaches swetest as exactly one argument.
export function execSwetest(argv) {
  return execFileSync(swetestBinary(), argv, {
    encoding: 'utf8',
    env: { ...process.env, SE_EPHE_PATH: ephePath() },
  });
}
