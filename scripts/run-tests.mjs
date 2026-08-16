#!/usr/bin/env node
// `npm test` runs through here rather than calling `node --test` directly, because
// `node --test` on its own cannot fail a hung run in this repo (SUP-385).
//
// Two bounds are needed, and neither one subsumes the other:
//
//   --test-timeout   bounds a test that is waiting on something asynchronous. It is a
//                    timer inside the test process, so it fires only when the event loop
//                    turns. Node's own default is 0 (wait forever), which is why an
//                    unsettled promise used to park the suite indefinitely instead of
//                    failing.
//
//   the wall clock   bounds a test that never yields at all. Every swetest call in this
//                    repo goes through execSync (lib/ephemeris-series.js), so a runaway
//                    search blocks the event loop outright and --test-timeout's timer
//                    never gets to run - verified: a test that busy-loops for 20s passes
//                    cleanly under --test-timeout=2000. Only killing the process from
//                    outside catches that shape, so this wrapper owns a deadline of its
//                    own.
//
// Both are overridable by env var for a deliberately long run (see CONTRIBUTING.md):
// TEST_TIMEOUT_MS=0 disables the per-test timer the way node's default did.
//
// Exit status is the child's, except that a wall-clock kill always exits non-zero. Note
// that `node --test` already exits 1 when a test is *cancelled* rather than failed, so a
// per-test timeout does surface as a red run without extra handling here.

import { spawn } from 'node:child_process';

// Both defaults were set off a measured run rather than picked round: when SUP-385 chose
// them the suite was ~6m15s end to end with a ~82s slowest test, so they were roughly 3x
// the real figures. SUP-387 then cut the suite to ~1m15s (slowest test ~12s) without moving
// them, so the margin is now much wider than 3x. That is deliberate: a genuine hang is
// unbounded, so a loose cap still catches it, while a cap pitched close to a fast suite's
// real runtime starts failing honest runs on a slower or busier machine.
const PER_TEST_TIMEOUT_MS = envInt('TEST_TIMEOUT_MS', 300_000);
const WALL_CLOCK_MS = envInt('TEST_WALL_CLOCK_MS', 1_200_000);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} must be a non-negative integer (milliseconds), got: ${raw}`);
    process.exit(2);
  }
  return value;
}

const args = ['--test', `--test-timeout=${PER_TEST_TIMEOUT_MS}`, ...process.argv.slice(2)];

// detached so the kill below reaches the whole process group: `node --test` runs each test
// file in a child of its own, and those in turn spawn swetest. Signalling only the direct
// child would leave a stuck test file (and its swetest) running after this process exits.
const child = spawn(process.execPath, args, { stdio: 'inherit', detached: true });

let killedForTime = false;

const deadline = WALL_CLOCK_MS > 0
  ? setTimeout(() => {
    killedForTime = true;
    console.error(
      `\nTest run exceeded TEST_WALL_CLOCK_MS=${WALL_CLOCK_MS}ms and was killed.\n` +
      'A test is blocking without yielding - the per-test --test-timeout cannot interrupt that ' +
      '(SUP-385). Re-run the suspect file on its own to find it.\n' +
      'If the run is legitimately this long (RUN_SLOW_TESTS=1), raise TEST_WALL_CLOCK_MS.',
    );
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
  }, WALL_CLOCK_MS)
  : null;

function killGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone, or the platform refused a negative pid - fall back to the
    // direct child so a kill attempt is never silently a no-op.
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killGroup(signal);
    process.exit(1);
  });
}

child.on('exit', (code, signal) => {
  if (deadline) clearTimeout(deadline);
  if (killedForTime) process.exit(1);
  process.exit(code ?? (signal ? 1 : 0));
});

child.on('error', (error) => {
  if (deadline) clearTimeout(deadline);
  console.error(`Failed to start the test runner: ${error.message}`);
  process.exit(1);
});
