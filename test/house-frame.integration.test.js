import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { houseFrameAt } from '../lib/house-frame.js';
import { DAY_CHART, NIGHT_CHART, PARTNER_CHART, SOUTHERN_CHART, POLAR_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

// lib/house-frame.js exists to be a cheaper way of asking for the four things a progressed
// frame needs, NOT a second opinion about them: index.js's progressedFrameAt swapped two
// whole calculateEphemeris charts for it (SUP-393), and calculate_secondary_progressions
// still does the same handshake through calculateEphemeris. If the two ever disagree in the
// last bits, find_events' progressed Ascendant/cusp timings silently drift away from the
// chart tool's for the same instant. Exact equality (not a tolerance) is the contract,
// which is why both sides must keep reconstructing longitude from the DMS columns rather
// than reading swetest's rounded decimal `-l` field.
const CHARTS = [DAY_CHART, NIGHT_CHART, PARTNER_CHART, SOUTHERN_CHART, POLAR_CHART];
const HOUSE_SYSTEMS = ['P', 'W', 'K', 'R', 'C'];

test('houseFrameAt returns exactly what calculateEphemeris does for obliquity, ARMC, Ascendant and the twelve cusps', { skip: !HAS_SWETEST }, async () => {
  const server = new SwissEphemerisServer();

  for (const chart of CHARTS) {
    for (const houseSystem of HOUSE_SYSTEMS) {
      const full = server.calculateEphemeris(chart.datetime, chart.latitude, chart.longitude, houseSystem);
      const frame = houseFrameAt(new Date(chart.datetime), chart.latitude, chart.longitude, houseSystem);
      const where = `${chart.label} / house_system ${houseSystem}`;

      assert.equal(frame.obliquity, full.obliquity, `obliquity: ${where}`);
      assert.equal(frame.armc, full.chart_points.ARMC.longitude, `ARMC: ${where}`);
      assert.equal(frame.ascendant, full.chart_points.Ascendant.longitude, `Ascendant: ${where}`);
      assert.deepEqual(frame.houses, full.houses, `houses: ${where}`);
    }
  }
});

test('houseFrameAt agrees with calculateEphemeris at a fictitious longitude too', { skip: !HAS_SWETEST }, async () => {
  // The longitudes progressedFrameAt actually passes on its second call are solutions of
  // computeFictitiousLongitude, not geography: they are uniform over (-180, 180] and bear no
  // relation to the natal one. The equality above has to hold there as well - including at
  // the wrap points, where a cusp block can straddle 0deg Aries.
  const server = new SwissEphemerisServer();
  const chart = DAY_CHART;

  for (const longitude of [-179.9999, -90.5, -0.0001, 0, 0.0001, 73.25, 179.9999, 180]) {
    const full = server.calculateEphemeris(chart.datetime, chart.latitude, longitude, 'P');
    const frame = houseFrameAt(new Date(chart.datetime), chart.latitude, longitude, 'P');

    assert.equal(frame.obliquity, full.obliquity, `obliquity at longitude ${longitude}`);
    assert.equal(frame.armc, full.chart_points.ARMC.longitude, `ARMC at longitude ${longitude}`);
    assert.equal(frame.ascendant, full.chart_points.Ascendant.longitude, `Ascendant at longitude ${longitude}`);
    assert.deepEqual(frame.houses, full.houses, `houses at longitude ${longitude}`);
  }
});

test('a house frame is identical with no ephemeris data files at all - it reads no .se1', { skip: !HAS_SWETEST }, async () => {
  // Why lib/house-frame.js does not carry calculateEphemeris's missing-ephemeris-file guard
  // (SUP-393): obliquity and house cusps come out of swetest's nutation/sidereal-time model,
  // not out of an ephemeris file, so there is no placeholder-0deg-Aries failure mode to
  // guard against on this path. A body on the same command WOULD silently drop to the
  // Moshier approximation - which is exactly why the frame read requests none.
  const withFiles = houseFrameAt(new Date(DAY_CHART.datetime), DAY_CHART.latitude, DAY_CHART.longitude, 'P');

  const originalPath = process.env.SE_EPHE_PATH;
  process.env.SE_EPHE_PATH = '/nonexistent/swisseph/path/for/this/test';
  try {
    const withoutFiles = houseFrameAt(new Date(DAY_CHART.datetime), DAY_CHART.latitude, DAY_CHART.longitude, 'P');
    assert.deepEqual(withoutFiles, withFiles);
    assert.equal(withoutFiles.obliquity, DAY_CHART.expected.obliquity);
  } finally {
    if (originalPath === undefined) delete process.env.SE_EPHE_PATH;
    else process.env.SE_EPHE_PATH = originalPath;
  }
});
