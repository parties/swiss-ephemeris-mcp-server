import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanetLine, parseHouseLine, parseChartPointLine } from '../lib/swetest-parse.js';

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

// Captured from `swetest -b01.01.1990 -ut12:00:00 -p0123456789tADFGHIo -fPZSBDl -g, -head`
// (DAY_CHART, five-column planet layout — spec §1.1).
test('parsePlanetLine: -fPZSBD adds ecliptic_latitude (field 4) and declination (field 5)', () => {
  const result = parsePlanetLine("Sun            ,10 cp 48'51.3388,   1° 1'10.1129,   0° 0' 0.0460, -23° 0' 6.6992, 280.8142608");
  assert.equal(result.name, 'Sun');
  assert.ok(Math.abs(result.ecliptic_latitude - (0 + 0 / 60 + 0.0460 / 3600)) < 1e-6);
  assert.ok(Math.abs(result.declination - -(23 + 0 / 60 + 6.6992 / 3600)) < 1e-6);
});

test('parsePlanetLine: negative ecliptic latitude and declination both keep their sign', () => {
  const result = parsePlanetLine("Pallas         , 1 ar 33'34.3415,   0°13'31.7955, -20° 6'57.1895, -17°46'48.7667,  1.5595393");
  assert.ok(result.ecliptic_latitude < 0);
  assert.ok(Math.abs(result.ecliptic_latitude - -(20 + 6 / 60 + 57.1895 / 3600)) < 1e-6);
  assert.ok(result.declination < 0);
  assert.ok(Math.abs(result.declination - -(17 + 46 / 60 + 48.7667 / 3600)) < 1e-6);
});

test('parsePlanetLine: true Node reports exactly zero ecliptic latitude', () => {
  const result = parsePlanetLine("true Node      ,16 aq 52'13.2996,   0° 1'23.2488,   0° 0' 0.0000, -15°46'54.4767, 316.8703610");
  assert.equal(result.ecliptic_latitude, 0);
});

// Spec §1.4: Ecl. Obl. is a pseudo-body and must never be reported as a position — only its
// decimal `l` field (the true obliquity) is extracted.
test('parsePlanetLine: Ecl. Obl. is parsed as an obliquity reading, not a body position', () => {
  const result = parsePlanetLine("Ecl. Obl.      ,23 ar 26'32.5178,   0° 0' 0.0000,  23°26'26.0890,   0° 0' 0.0000, 23.4423661");
  assert.equal(result.name, 'Ecl. Obl.');
  assert.equal(result.obliquity, 23.4423661);
  assert.equal(result.longitude, undefined);
  assert.equal(result.declination, undefined);
});

// Captured from `swetest -b01.01.1990 -ut12:00:00 -house0.0,51.4769,P -fPZSBD -g, -head`
// (DAY_CHART). House/angle lines have only four columns — spec §1.1's core trap.
test('parseHouseLine: four-column layout puts declination in field 4, not a latitude field', () => {
  const result = parseHouseLine("house  1       ,25 ar 11'30.7789, 783°25'21.2571,   9°44'57.0155");
  assert.equal(result.house, 1);
  assert.ok(Math.abs(result.declination - (9 + 44 / 60 + 57.0155 / 3600)) < 1e-6);
  assert.equal(result.latitude, undefined);
});

// Spec §1.2: field 3 is the cusp's diurnal rotation rate (783°/day here), never a speed.
test('parseHouseLine: never produces a speed field, even though field 3 looks like one', () => {
  const result = parseHouseLine("house  1       ,25 ar 11'30.7789, 783°25'21.2571,   9°44'57.0155");
  assert.equal(result.speed, undefined);
});

test('parseChartPointLine: Ascendant gets declination from field 4, no speed', () => {
  const result = parseChartPointLine("Ascendant      ,25 ar 11'30.7789, 783°25'21.2571,   9°44'57.0155");
  assert.equal(result.name, 'Ascendant');
  assert.ok(Math.abs(result.declination - (9 + 44 / 60 + 57.0155 / 3600)) < 1e-6);
  assert.equal(result.speed, undefined);
});

// Spec §1.3: ARMC's field 4 is a meaningless right-ascension artifact (swetest prints exactly
// 0). The parser still reads it positionally; index.js is responsible for dropping it.
test('parseChartPointLine: ARMC field 4 parses as zero, not a real declination', () => {
  const result = parseChartPointLine("ARMC           ,10 cp 52'46.0866, 360°59' 8.3304,   0° 0' 0.0000");
  assert.equal(result.name, 'ARMC');
  assert.equal(result.declination, 0);
});
