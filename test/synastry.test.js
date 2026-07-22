import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNatalAspects, calculateCrossChartAspects, DEFAULT_ORBS } from '../lib/aspects.js';
import { SwissEphemerisServer } from '../index.js';

test('calculateCrossChartAspects matches calculateNatalAspects orb table for the same body pair', () => {
  const a = { name: 'A', longitude: 0, speed: 0.5 };
  const b = { name: 'B', longitude: 95, speed: -0.2 }; // 95 deg separation -> square orb 5

  const natal = calculateNatalAspects([a, b], {});
  const cross = calculateCrossChartAspects([a], [b], {});

  assert.equal(natal.length, 1);
  assert.equal(cross.length, 1);
  assert.equal(natal[0].aspect, cross[0].aspect);
  assert.equal(natal[0].orb_allowed, cross[0].orb_allowed);
  assert.equal(natal[0].orb_allowed, DEFAULT_ORBS.square);
});

test('calculateCrossChartAspects includeMinor toggle matches natal engine default (off)', () => {
  const a = { name: 'A', longitude: 0, speed: 0 };
  const b = { name: 'B', longitude: 72, speed: 0 }; // exact quintile (minor)

  const withoutMinor = calculateCrossChartAspects([a], [b], { includeMinor: false });
  assert.ok(!withoutMinor.some((x) => x.aspect === 'quintile'));

  const withMinor = calculateCrossChartAspects([a], [b], { includeMinor: true });
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
