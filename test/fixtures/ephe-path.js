import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const REQUIRED_SE1_FILES = ['sepl_18.se1', 'semo_18.se1', 'seas_18.se1'];

const VENDOR_EPHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vendor/swisseph'
);

// Resolves the ephemeris directory integration tests should run against. An ambient
// SE_EPHE_PATH is honored (pointing the suite at a fuller install is legitimate) but is
// validated rather than trusted blindly: a stale or wrong value would otherwise silently
// push swetest onto its built-in Moshier approximation instead of the real ephemeris
// (SUP-152), and every test downstream would keep passing against numbers that were
// never computed from vendor/swisseph. Pass { pinned: true } to ignore any ambient
// override entirely, for tests whose subject is specifically the vendored files.
export function resolveEphePath({ pinned = false } = {}) {
  const candidate = pinned ? VENDOR_EPHE_PATH : process.env.SE_EPHE_PATH || VENDOR_EPHE_PATH;
  const missing = REQUIRED_SE1_FILES.filter((file) => !fs.existsSync(path.join(candidate, file)));
  if (missing.length > 0) {
    throw new Error(
      `SE_EPHE_PATH points at ${candidate}, which has no ${missing.join(', ')} - ` +
        'swetest would silently fall back to its Moshier approximation instead of failing loudly.'
    );
  }
  if (!pinned) process.env.SE_EPHE_PATH = candidate;
  return candidate;
}

export function swetestAvailable(ephePath) {
  try {
    execSync(`SE_EPHE_PATH=${ephePath} swetest -b12.04.1985 -ut23:20:50 -p0 -g, -head`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
