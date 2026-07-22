import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanetLine } from '../lib/swetest-parse.js';

test('parsePlanetLine: no 3rd field -> speed undefined', () => {
  const result = parsePlanetLine("Sun            ,22 le 53'51.2332");
  assert.equal(result.name, 'Sun');
  assert.equal(result.speed, undefined);
});

test('parsePlanetLine: positive speed parsed with sign preserved, no offset', () => {
  const result = parsePlanetLine("Sun            ,22 le 53'51.2332, 0°58'48.6142");
  assert.ok(result.speed > 0);
  assert.ok(Math.abs(result.speed - (0 + 58 / 60 + 48.6142 / 3600)) < 1e-6);
});

test('parsePlanetLine: negative (retrograde) speed parsed with sign preserved', () => {
  const result = parsePlanetLine("Mercury        , 2 cp 21' 3.2731,-0°22' 8.7569");
  assert.ok(result.speed < 0);
  assert.ok(Math.abs(result.speed - -(0 + 22 / 60 + 8.7569 / 3600)) < 1e-6);
});
