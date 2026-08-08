import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlanetLine,
  parseHouseLine,
  parseChartPointLine,
  parseStepRow,
  parseEclipseBlock,
} from '../lib/swetest-parse.js';

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

// Captured from `swetest -b01.01.2026 -ut00:00:00 -p46 -fJPls -g, -head -n2 -s1`
// (spec §1.1) - two bodies over two timesteps, interleaved by body within each JD.
test('parseStepRow: parses JD, name, longitude, speed from the four-column decimal CSV', () => {
  const result = parseStepRow('2461041.50,Mars           , 282.6881579,  0.7663630');
  assert.equal(result.jd, 2461041.50);
  assert.equal(result.name, 'Mars');
  assert.equal(result.longitude, 282.6881579);
  assert.equal(result.speed, 0.7663630);
});

test('parseStepRow: rows interleave by body within a timestep, keyed off JD+name', () => {
  const rows = [
    '2461041.50,Mars           , 282.6881579,  0.7663630',
    '2461041.50,Saturn         , 356.1672418,  0.0583277',
    '2461042.50,Mars           , 283.4548555,  0.7670312',
    '2461042.50,Saturn         , 356.2263460,  0.0598757',
  ].map(parseStepRow);

  assert.deepEqual(rows.map((r) => `${r.jd}/${r.name}`), [
    '2461041.5/Mars',
    '2461041.5/Saturn',
    '2461042.5/Mars',
    '2461042.5/Saturn',
  ]);
});

test('parseStepRow: retrograde (negative) speed keeps its sign', () => {
  const result = parseStepRow('2461041.50,Mars           , 282.6881579, -0.7663630');
  assert.ok(result.speed < 0);
});

test('parseStepRow: malformed line returns null', () => {
  assert.equal(parseStepRow('not,enough'), null);
  assert.equal(parseStepRow(''), null);
});

// Captured from `swetest -b01.01.2026 -ut00:00:00 -solecl -n2 -head` (tab-delimited,
// default separator - spec §1.5 explicitly is NOT the -g, comma format used elsewhere).
test('parseEclipseBlock: solar eclipse line 1 has 7 fields (core-shadow-width inserted)', () => {
  const raw = [
    '',
    "annular solar\t17.02.2026\t  12:11:53.3\t131.068478 km\t0.9638/0.9797/0.9288\tsaros 121/61\t2461089.008255",
    "\t  09:56:47.0    11:43:04.0    12:41:04.2    14:27:39.5 dt=68.9",
    "\t  87° 3'33\"\t -64°41' 2\"\t2 min 19.42 sec",
  ].join('\n');

  const [eclipse] = parseEclipseBlock(raw);
  assert.equal(eclipse.eclipse_type, 'annular solar');
  assert.equal(eclipse.jd, 2461089.008255);
  assert.deepEqual(eclipse.magnitudes, [0.9638, 0.9797, 0.9288]);
  assert.equal(eclipse.saros_series, 121);
  assert.equal(eclipse.saros_number, 61);
});

// Captured from `swetest -b01.01.2026 -ut00:00:00 -lunecl -n3 -head`. Line 1 has 6
// fields for lunar (no core-shadow-width) - a parser tuned on the solar shape would
// misread this. Also covers the multi-token "penumb. lunar eclipse" type name, matched
// by substring rather than token count.
test('parseEclipseBlock: lunar eclipse line 1 has 6 fields, parses total/partial/penumbral', () => {
  const raw = [
    '',
    "total lunar eclipse\t 3.03.2026\t  11:33:41.2\t1.1507/2.1839\tsaros 133/27\t2461102.981727",
    "    08:44:24.0    09:50:05.1    11:04:32.3    12:02:51.5    13:17:17.7    14:23:07.5 dt=68.9",
    "\t-170°37'17\"\t   6°24' 6\"",
    "partial lunar eclipse\t28.08.2026\t  04:12:58.0\t0.9299/1.9646\tsaros 138/29\t2461280.675671",
    "    01:23:57.7    02:33:52.8     -            -           05:52:02.8    07:01:49.6 dt=68.8",
    "\t -63° 7'15\"\t  -9°18' 3\"",
    "penumb. lunar eclipse\t20.02.2027\t  23:12:52.8\t0.0000/0.9266\tsaros 143/18\t2461457.467278",
    "    21:12:22.7     -            -            -            -           01:13:26.2 dt=68.8",
    "\t  14°43' 1\"\t   9°47'18\"",
  ].join('\n');

  const eclipses = parseEclipseBlock(raw);
  assert.equal(eclipses.length, 3);

  assert.equal(eclipses[0].eclipse_type, 'total lunar eclipse');
  assert.equal(eclipses[0].jd, 2461102.981727);
  assert.deepEqual(eclipses[0].magnitudes, [1.1507, 2.1839]);
  assert.equal(eclipses[0].saros_series, 133);
  assert.equal(eclipses[0].saros_number, 27);

  // Spec §1.5/§1.6 - penumbral is real and must be emitted, not filtered, even at a
  // magnitude too faint to be visually detectable.
  assert.equal(eclipses[2].eclipse_type, 'penumb. lunar eclipse');
  assert.deepEqual(eclipses[2].magnitudes, [0.0000, 0.9266]);
});

test('parseEclipseBlock: ignores blank/continuation lines and non-eclipse input', () => {
  assert.deepEqual(parseEclipseBlock(''), []);
  assert.deepEqual(parseEclipseBlock('\n\t  87° 3\'33"\t -64°41\' 2"\n'), []);
});
