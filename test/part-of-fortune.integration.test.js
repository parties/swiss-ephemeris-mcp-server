import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, NIGHT_CHART, SOUTHERN_CHART, WHOLE_SIGN_EDGE_CHART, houseOf } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

// All house systems this server supports (index.js HOUSE_SYSTEMS) - sect must not depend
// on which of these the caller picks (SUP-274).
const ALL_HOUSE_SYSTEMS = ['P', 'K', 'O', 'R', 'C', 'E', 'W', 'B', 'M', 'T'];

const norm = (deg) => (((deg % 360) + 360) % 360);
const dayFormula = ({ asc, sun, moon }) => norm(asc + moon - sun);
const nightFormula = ({ asc, sun, moon }) => norm(asc + sun - moon);

async function chartFor(fixture, houseSystem) {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', {
    datetime: fixture.datetime,
    latitude: fixture.latitude,
    longitude: fixture.longitude,
    ...(houseSystem ? { house_system: houseSystem } : {}),
  });
  return {
    result,
    asc: result.chart_points.Ascendant.longitude,
    sun: result.planets.Sun.longitude,
    moon: result.planets.Moon.longitude,
    fortune: result.additional_points['Part of Fortune'].longitude,
    sunHouse: houseOf(result.planets.Sun.longitude, result.houses),
  };
}

test('Part of Fortune uses the day formula (ASC + Moon - Sun) when the Sun is above the horizon', { skip: !HAS_SWETEST }, async () => {
  const c = await chartFor(DAY_CHART);

  assert.equal(c.sunHouse, DAY_CHART.expected.sunHouse, 'fixture should be a day chart');
  assert.ok(c.sunHouse >= 7 && c.sunHouse <= 12, 'Sun should be above the horizon');

  assert.ok(Math.abs(c.fortune - dayFormula(c)) < 1e-6, 'should match the day formula');
  assert.ok(Math.abs(c.fortune - nightFormula(c)) > 1, 'should NOT match the night formula');
  assert.ok(Math.abs(c.fortune - DAY_CHART.expected.partOfFortune) < 0.001);
});

test('Part of Fortune uses the night formula (ASC + Sun - Moon) when the Sun is below the horizon', { skip: !HAS_SWETEST }, async () => {
  const c = await chartFor(NIGHT_CHART);

  assert.equal(c.sunHouse, NIGHT_CHART.expected.sunHouse, 'fixture should be a night chart');
  assert.ok(c.sunHouse >= 1 && c.sunHouse <= 6, 'Sun should be below the horizon');

  assert.ok(Math.abs(c.fortune - nightFormula(c)) < 1e-6, 'should match the night formula');
  assert.ok(Math.abs(c.fortune - dayFormula(c)) > 1, 'should NOT match the day formula');
  assert.ok(Math.abs(c.fortune - NIGHT_CHART.expected.partOfFortune) < 0.001);
});

// Under the default house system (Placidus), cusp 1 == the true Ascendant degree, so the
// Sun's Placidus house number happens to correlate with sect. The code itself no longer
// computes sect this way (see SUP-274) - it reads the ASC/DSC arc directly - but this test
// still holds as an outward-facing check for the default configuration.
test('sect correlates with the Sun house under Placidus, the default house system', { skip: !HAS_SWETEST }, async () => {
  const c = await chartFor(SOUTHERN_CHART);

  assert.equal(c.sunHouse, SOUTHERN_CHART.expected.sunHouse);
  assert.ok(Math.abs(c.fortune - dayFormula(c)) < 1e-6, 'southern day chart still uses the day formula');
  assert.ok(Math.abs(c.fortune - SOUTHERN_CHART.expected.partOfFortune) < 0.001);
});

test('the two Greenwich fixtures differ only by sect, so they exercise both branches', { skip: !HAS_SWETEST }, async () => {
  const day = await chartFor(DAY_CHART);
  const night = await chartFor(NIGHT_CHART);

  assert.notEqual(day.sunHouse >= 7, night.sunHouse >= 7, 'one above the horizon, one below');
  assert.ok(Math.abs(day.fortune - night.fortune) > 1, 'the two branches produce different results');
});

// SUP-274: sect is a property of the ASC/DSC horizon axis, not of whichever house system
// the caller asked for. Whole Sign widens house 1 to 0deg of the Ascendant's sign, so a Sun
// sitting between 0deg of that sign and the true Ascendant degree used to get misclassified
// as night under Whole Sign while every cusp-1-equals-true-ASC system (Placidus included)
// correctly called it day.
test('Part of Fortune is house-system-invariant on the SUP-274 Whole Sign edge case', { skip: !HAS_SWETEST }, async () => {
  const placidus = await chartFor(WHOLE_SIGN_EDGE_CHART, 'P');
  const wholeSign = await chartFor(WHOLE_SIGN_EDGE_CHART, 'W');

  assert.equal(placidus.sunHouse, WHOLE_SIGN_EDGE_CHART.expected.sunHouse, 'fixture should match its recorded Placidus Sun house');
  assert.ok(Math.abs(placidus.fortune - WHOLE_SIGN_EDGE_CHART.expected.partOfFortune) < 0.001);

  assert.ok(
    Math.abs(placidus.fortune - wholeSign.fortune) < 1e-6,
    `Part of Fortune should be identical under Placidus (${placidus.fortune}) and Whole Sign (${wholeSign.fortune})`
  );
});

// Broader regression guard for the same invariant: sect must not change when house_system
// changes, for any of the 10 supported house systems, on both an unambiguous day and an
// unambiguous night chart.
for (const fixture of [DAY_CHART, NIGHT_CHART]) {
  test(`Part of Fortune is identical across all house systems for ${fixture.label}`, { skip: !HAS_SWETEST }, async () => {
    const charts = await Promise.all(ALL_HOUSE_SYSTEMS.map((hs) => chartFor(fixture, hs)));

    for (let i = 1; i < charts.length; i++) {
      assert.ok(
        Math.abs(charts[0].fortune - charts[i].fortune) < 1e-6,
        `${fixture.label}: house_system ${ALL_HOUSE_SYSTEMS[0]} gave ${charts[0].fortune}, ` +
          `house_system ${ALL_HOUSE_SYSTEMS[i]} gave ${charts[i].fortune}`
      );
    }
  });
}
