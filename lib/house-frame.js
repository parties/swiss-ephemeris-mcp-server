// The narrow house-frame read behind every progressed frame (SUP-393).
//
// index.js's `progressedFrameAt` needs exactly four numbers-plus-a-table per frame: the
// true obliquity and base ARMC of the progressed instant (to solve for the fictitious
// longitude - see lib/progressions.js's computeFictitiousLongitude), and then the
// Ascendant and twelve cusps that fall out of a second `-house` lookup at that longitude.
// It used to get them from two `calculateEphemeris` calls, which is FOUR swetest spawns:
// that method always runs a `-p0123456789tADFGHIo` planets call and a `-house` call, and
// of those four spawns exactly one datum from the planets side (`obliquity`) is ever read
// and the second planets call is dead weight entirely. On a 3-year progressed
// `find_events` that handshake was ~40% of every spawn in the request.
//
// One swetest invocation answers both halves at once, because `-p` and `-house` compose:
// `-po` prints the `Ecl. Obl.` pseudo-body and nothing else, and `-house` appends the
// cusp/angle block (including ARMC) computed from the same instant. So a frame is 2 spawns
// instead of 4, and neither of them computes a planet. Measured on an M-series Mac,
// 2026-08-16, 300 reps each:
//
//   -p0123456789tADFGHIo -fPZSBDl-       2.52 ms   (the planets call this replaces)
//   -house... -fPZSBD                    2.10 ms   (the houses call - note `-p` omitted
//                                                   does NOT mean "no bodies": swetest
//                                                   still computes its 13 default planets)
//   -po -house... -fPZSBDl               1.81 ms   (this module)
//
// so the frame's own wall clock drops 2×2.52 + 2×2.10 = 9.24 ms to 2×1.81 = 3.63 ms.
//
// Two things here are load-bearing and must not be "simplified":
//
//   1. Longitudes are reconstructed from the DMS columns by the SAME parsers
//      calculateEphemeris uses, not read off the decimal `-l` column. `-l` prints seven
//      decimals (25.2146544); the DMS reconstruction is 25.214654389. Switching to the
//      decimal would move every progressed Ascendant and cusp in the last digits and
//      break the byte-for-byte agreement with the chart tools. `-l` is requested only
//      because the `Ecl. Obl.` row's obliquity is read from it (its zodiacal encoding is a
//      coincidence - see lib/swetest-parse.js), and appending it shifts no earlier column,
//      so the house/angle block is byte-identical to what `-fPZSBD` alone prints (verified
//      by diffing the two forms).
//
//   2. Nothing here reads a `.se1` file, so calculateEphemeris's missing-ephemeris-file
//      guard has no work to do on this path and is not being quietly dropped. Obliquity
//      and house cusps come from swetest's nutation/sidereal-time model, not from an
//      ephemeris file: run against an empty SE_EPHE_PATH they print the identical figures
//      (a planet on the same command falls back to Moshier and shifts, which is exactly
//      the case the guard exists for - and why no planet is requested here).
//      test/house-frame.integration.test.js pins both claims.

import { execSwetest } from './swetest-exec.js';
import {
  formatDateToSwiss,
  formatTimeToSwiss,
  parsePlanetLine,
  parseHouseLine,
  parseChartPointLine,
} from './swetest-parse.js';

// `{ obliquity, armc, ascendant, houses }` for `date` (a Date, read as UT) at the given
// geographic longitude/latitude and house system, in one swetest spawn. `houses` is keyed
// 1..12 with the same `{longitude, sign, degree, declination}` shape calculateEphemeris
// produces, so a caller can hand it to findHouseForLongitude unchanged.
//
// The `longitude` argument is a geographic longitude to swetest and nothing more, which is
// what lets the caller pass a fictitious one and get the progressed frame back.
export function houseFrameAt(date, latitude, longitude, houseSystem) {
  const argv = [
    `-b${formatDateToSwiss(date)}`,
    `-ut${formatTimeToSwiss(date)}`,
    '-po',
    `-house${longitude},${latitude},${houseSystem}`,
    '-fPZSBDl',
    '-g,',
    '-head',
  ];

  let output;
  try {
    output = execSwetest(argv);
  } catch (error) {
    throw new Error(`Failed to execute swetest for house frame: ${error.message}`);
  }

  let obliquity;
  let armc;
  let ascendant;
  const houses = {};

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('error:') || trimmed.includes('warning:')) continue;

    if (trimmed.startsWith('Ecl. Obl.')) {
      obliquity = parsePlanetLine(line)?.obliquity;
    } else if (trimmed.includes('house ')) {
      const house = parseHouseLine(line);
      if (house && house.house >= 1 && house.house <= 12) {
        houses[house.house] = {
          longitude: house.longitude,
          sign: house.sign,
          degree: house.degree,
          declination: house.declination,
        };
      }
    } else if (trimmed.startsWith('ARMC') || trimmed.startsWith('Ascendant')) {
      const point = parseChartPointLine(line);
      if (point?.name === 'ARMC') armc = point.longitude;
      else if (point?.name === 'Ascendant') ascendant = point.longitude;
    }
  }

  // A frame with a missing piece would otherwise propagate as NaN through
  // computeFictitiousLongitude and surface as an event at an impossible date rather than as
  // an error. Cheap to check, and it can only fire if swetest's output shape changed.
  if (obliquity === undefined || armc === undefined || ascendant === undefined || Object.keys(houses).length !== 12) {
    throw new Error(`swetest returned an incomplete house frame for ${date.toISOString()} at ${longitude},${latitude},${houseSystem}`);
  }

  return { obliquity, armc, ascendant, houses };
}
