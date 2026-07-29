import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, NIGHT_CHART, SOUTHERN_CHART, houseOf } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const norm = (deg) => (((deg % 360) + 360) % 360);
const dayFormula = ({ asc, sun, moon }) => norm(asc + moon - sun);
const nightFormula = ({ asc, sun, moon }) => norm(asc + sun - moon);

async function chartFor(fixture) {
  const server = new SwissEphemerisServer();
  const result = await server.handleToolCall('calculate_planetary_positions', {
    datetime: fixture.datetime,
    latitude: fixture.latitude,
    longitude: fixture.longitude,
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

test('sect is determined by the Sun house, not by the hemisphere', { skip: !HAS_SWETEST }, async () => {
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
