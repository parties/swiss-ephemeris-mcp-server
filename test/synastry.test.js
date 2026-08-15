import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNatalAspects, calculateCrossChartAspects, DEFAULT_ORBS } from '../lib/aspects.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { SwissEphemerisServer } from '../index.js';
import { DAY_CHART, PARTNER_CHART } from './fixtures/charts.js';

test('calculateCrossChartAspects matches calculateNatalAspects orb table for the same body pair', () => {
  const a = { name: 'A', longitude: 0, speed: 0.5 };
  const b = { name: 'B', longitude: 95, speed: -0.2 }; // 95 deg separation -> square orb 5

  const natal = calculateNatalAspects([a, b], { orbModel: 'class' });
  const cross = calculateCrossChartAspects([a], [b], { orbModel: 'class' });

  assert.equal(natal.length, 1);
  assert.equal(cross.length, 1);
  assert.equal(natal[0].aspect, cross[0].aspect);
  assert.equal(natal[0].orb_allowed, cross[0].orb_allowed);
  assert.equal(natal[0].orb_allowed, DEFAULT_ORBS.square);
});

test('calculateCrossChartAspects includeMinor toggle matches natal engine default (off)', () => {
  const a = { name: 'A', longitude: 0, speed: 0 };
  const b = { name: 'B', longitude: 72, speed: 0 }; // exact quintile (minor)

  const withoutMinor = calculateCrossChartAspects([a], [b], { orbModel: 'class', includeMinor: false });
  assert.ok(!withoutMinor.some((x) => x.aspect === 'quintile'));

  const withMinor = calculateCrossChartAspects([a], [b], { orbModel: 'class', includeMinor: true });
  assert.ok(withMinor.some((x) => x.aspect === 'quintile'));
});

test('calculateCrossChartAspects computes applying/separating using the shared engine math', () => {
  // Sun-like direct body approaching conjunction with a slower direct body.
  const a = { name: 'Sun', longitude: 0, speed: 1 };
  const b = { name: 'Venus', longitude: 5, speed: 0 };

  const [aspect] = calculateCrossChartAspects([a], [b], {});
  assert.equal(aspect.aspect, 'conjunction');
  assert.equal(aspect.applying, true);
});

test('calculate_synastry uses the shared engine and reports applying/separating', async () => {
  const server = new SwissEphemerisServer();
  const person1Planets = {
    Sun: { longitude: 0, sign: 'Aries', degree: 0, speed: 1 },
    Moon: { longitude: 95, sign: 'Cancer', degree: 5, speed: 12 },
  };
  const person2Planets = {
    Sun: { longitude: 5, sign: 'Aries', degree: 5, speed: 0.5 },
    Moon: { longitude: 0, sign: 'Aries', degree: 0, speed: 11 },
  };

  const aspects = server.calculateSynastryAspects(person1Planets, person2Planets);

  const sunSun = aspects.find((x) => x.person1_planet === 'Sun' && x.person2_planet === 'Sun');
  assert.ok(sunSun, 'Sun-Sun conjunction should be present');
  assert.equal(sunSun.aspect, 'conjunction');
  assert.equal(typeof sunSun.applying, 'boolean');

  const moonMoon = aspects.find((x) => x.person1_planet === 'Moon' && x.person2_planet === 'Moon');
  assert.ok(moonMoon, 'Moon(95)-Moon(0) square should be present');
  assert.equal(moonMoon.aspect, 'square');
  assert.equal(moonMoon.orb_allowed ?? DEFAULT_ORBS.square, DEFAULT_ORBS.square);
});

test('calculate_synastry preserves output shape fields (person1_planet, person2_planet, positions)', () => {
  const server = new SwissEphemerisServer();
  const person1Planets = { Sun: { longitude: 0, sign: 'Aries', degree: 0, speed: 1 } };
  const person2Planets = { Sun: { longitude: 3, sign: 'Aries', degree: 3, speed: 1 } };

  const [aspect] = server.calculateSynastryAspects(person1Planets, person2Planets);

  assert.equal(aspect.person1_planet, 'Sun');
  assert.equal(aspect.person2_planet, 'Sun');
  assert.deepEqual(aspect.person1_position, { longitude: 0, sign: 'Aries', degree: 0 });
  assert.deepEqual(aspect.person2_position, { longitude: 3, sign: 'Aries', degree: 3 });
});

test('calculateSynastryAspects defaults to the full 17-body list when bodies is not set (SUP-263)', () => {
  const server = new SwissEphemerisServer();
  const person1Planets = {
    Sun: { longitude: 0, sign: 'Aries', degree: 0, speed: 1 },
    Juno: { longitude: 10, sign: 'Aries', degree: 10, speed: 0.1 },
  };
  const person2Planets = {
    Sun: { longitude: 90, sign: 'Cancer', degree: 0, speed: 1 },
    Juno: { longitude: 10, sign: 'Aries', degree: 10, speed: 0.1 },
  };

  const aspects = server.calculateSynastryAspects(person1Planets, person2Planets);

  const junoJuno = aspects.find((a) => a.person1_planet === 'Juno' && a.person2_planet === 'Juno');
  assert.ok(junoJuno, 'Juno-Juno conjunction should be present under the default 17-body list');
  assert.equal(junoJuno.aspect, 'conjunction');
});

test('calculateSynastryAspects bodies override restricts the grid to just those bodies', () => {
  const server = new SwissEphemerisServer();
  const person1Planets = {
    Sun: { longitude: 0, sign: 'Aries', degree: 0, speed: 1 },
    Juno: { longitude: 10, sign: 'Aries', degree: 10, speed: 0.1 },
  };
  const person2Planets = {
    Sun: { longitude: 3, sign: 'Aries', degree: 3, speed: 1 },
    Juno: { longitude: 10, sign: 'Aries', degree: 10, speed: 0.1 },
  };

  const aspects = server.calculateSynastryAspects(person1Planets, person2Planets, { bodies: ['Sun'] });

  assert.ok(aspects.length > 0);
  assert.ok(aspects.every((a) => a.person1_planet === 'Sun' && a.person2_planet === 'Sun'));
});

test('calculateSynastryAspects throws McpError for an unknown body in bodies', () => {
  const server = new SwissEphemerisServer();
  assert.throws(
    () => server.calculateSynastryAspects({}, {}, { bodies: ['NotARealBody'] }),
    (err) => err instanceof McpError && /Unknown body: NotARealBody/.test(err.message)
  );
});

const SYNASTRY_INPUT = {
  person1_datetime: DAY_CHART.datetime,
  person1_latitude: DAY_CHART.latitude,
  person1_longitude: DAY_CHART.longitude,
  person2_datetime: PARTNER_CHART.datetime,
  person2_latitude: PARTNER_CHART.latitude,
  person2_longitude: PARTNER_CHART.longitude,
};

test('calculate_synastry rejects an unknown orb_model', async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_synastry', { ...SYNASTRY_INPUT, orb_model: 'bogus' }),
    (err) => err instanceof McpError && /orb_model must be one of/.test(err.message)
  );
});

// The bad orb_model has to win over the override keys it invalidates (SUP-384): an MCP
// caller is usually a model, so the error message is the input to its next attempt, and
// naming orb_overrides here sends it to retry the one parameter it got right.
test('calculate_synastry reports an unknown orb_model even when orb_overrides are present', async () => {
  const server = new SwissEphemerisServer();
  await assert.rejects(
    () => server.handleToolCall('calculate_synastry', {
      ...SYNASTRY_INPUT,
      orb_model: 'bogus',
      orb_overrides: { moieties: { Sun: 8 } },
    }),
    (err) => err instanceof McpError && /orb_model must be one of/.test(err.message)
  );
});
