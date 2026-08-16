// SUP-389: lib/swetest-exec.js replaced three `SE_EPHE_PATH=<dir> swetest <args>` shell
// strings with execFileSync against a resolved absolute path. The whole claim of that
// change is "same binary, same arguments, same stdout, fewer processes" - so the central
// test here is a byte-for-byte comparison against the shell form it replaced, not a
// re-assertion of what swetest prints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execSwetest, swetestBinary, ephePath, DEFAULT_EPHE_PATH } from '../lib/swetest-exec.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

// The chart tools' own planet command (index.js calculateEphemeris), with the project's
// established placeholder datetime.
const PLANET_ARGS = ['-b12.04.1985', '-ut23:20:50', '-p0123456789tADFGHIo', '-fPZSBDl-', '-g,', '-head'];

test('execSwetest output is byte-identical to the shell command string it replaced', { skip: !HAS_SWETEST }, () => {
  const viaShell = execSync(`SE_EPHE_PATH=${EPHE_PATH} swetest ${PLANET_ARGS.join(' ')}`, { encoding: 'utf8' });
  const viaExecFile = execSwetest(PLANET_ARGS);

  assert.equal(viaExecFile, viaShell);
  assert.match(viaExecFile, /Sun/, 'sanity: this is real swetest output, not an empty string matching an empty string');
});

test('swetestBinary resolves an absolute executable path, once', { skip: !HAS_SWETEST }, () => {
  const resolved = swetestBinary();

  assert.ok(path.isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
  assert.ok(fs.statSync(resolved).isFile());
  fs.accessSync(resolved, fs.constants.X_OK);
  assert.equal(swetestBinary(), resolved, 'repeat calls must return the cached path, not re-search PATH');
});

// The chart tools read SE_EPHE_PATH per call and the integration tests reassign it at
// runtime (test/missing-ephemeris.integration.test.js points it at a broken directory to
// exercise the placeholder-row path). Caching it at module load would leave those tests
// passing against the wrong ephemeris.
test('execSwetest honors a change to SE_EPHE_PATH made after the module loaded', { skip: !HAS_SWETEST }, () => {
  const original = process.env.SE_EPHE_PATH;
  try {
    process.env.SE_EPHE_PATH = '/nonexistent/swisseph/path/for/this/test';
    assert.equal(ephePath(), '/nonexistent/swisseph/path/for/this/test');
    // swetest reports a missing data file on stdout and keeps going, so this is the
    // observable proof the child actually received the new value.
    assert.match(execSwetest(PLANET_ARGS), /error: SwissEph file '[^']+' not found/);
  } finally {
    if (original === undefined) delete process.env.SE_EPHE_PATH;
    else process.env.SE_EPHE_PATH = original;
  }
});

test('ephePath falls back to the vendored ephemeris directory when SE_EPHE_PATH is unset', () => {
  const original = process.env.SE_EPHE_PATH;
  try {
    delete process.env.SE_EPHE_PATH;
    assert.equal(ephePath(), DEFAULT_EPHE_PATH);
    assert.ok(fs.existsSync(path.join(DEFAULT_EPHE_PATH, 'sepl_18.se1')), 'the fallback must point at the real vendored files');
  } finally {
    if (original !== undefined) process.env.SE_EPHE_PATH = original;
  }
});

// A missing binary used to surface only as a per-call `Failed to execute swetest: Command
// failed: ... sh: swetest: command not found`. Fresh module instance (the resolved path is
// cached per module, and the query string defeats the ESM cache) so an empty PATH is
// actually searched rather than answered from this process's earlier successful lookup.
test('a missing swetest fails with an install-shaped message, not a shell error', async () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = '';
    const fresh = await import('../lib/swetest-exec.js?missing-binary');
    assert.throws(() => fresh.swetestBinary(), (error) => {
      assert.match(error.message, /swetest/);
      assert.match(error.message, /README\.md/);
      return true;
    });
  } finally {
    process.env.PATH = original;
  }
});
