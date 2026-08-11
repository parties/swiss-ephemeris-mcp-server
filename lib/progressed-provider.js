// Position-provider seam for secondary progressions at find_events' event-search rate
// (SUP-357/SUP-359). Wraps lib/ephemeris-series.js the way index.js's transitProviderFor
// does for transits, but two things differ (spec §4):
//
//   (a) every JD a provider hands back is TARGET (life) time, not ephemeris time - the
//       day-for-a-year instant is resolved internally, so lib/event-search.js's isoFromJd
//       (which treats whatever `jd` it's given as a real calendar date) reports the
//       subject's life date, not a date in the ephemeris span the underlying swetest call
//       actually queried.
//   (b) `speed` is rescaled by 1/yearLengthDays, so it reads in degrees per day of TARGET
//       time - consistent with the transit provider's units - rather than the raw
//       degrees-per-ephemeris-day swetest returns (which would be ~365x too fast).
//
// The progressed Midheaven provider is here too (also pure - no swetest calls of its own):
// natal MC directed by computeArcDegrees(t), per the spec's explicit warning against ever
// reading the angles of the raw clock moment progressed_datetime falls on. The progressed
// Ascendant and moving house cusps need an actual swetest -house lookup (obliquity, ARMC,
// the fictitious-longitude trick) and live in index.js instead, next to the
// calculateEphemeris method that already knows how to do that (see findEvents).

import { seriesFor as ephemerisSeriesFor, positionAt as ephemerisPositionAt } from './ephemeris-series.js';
import { computeArcDegrees, mod360 } from './progressions.js';

// Target JD -> ephemeris JD, in JD space. Exactly equivalent (bit-for-bit, since JD and a
// Date's epoch-ms are related by a fixed affine transform) to composing
// computeElapsedYears/computeProgressedDate on Date objects, just without the round trip
// through a Date a provider would otherwise need on every single sample.
export function ephemerisJdForTarget(targetJd, birthJd, yearLengthDays) {
  return birthJd + (targetJd - birthJd) / yearLengthDays;
}

// The inverse map: an ephemeris-time JD (the day-for-a-year instant) back to the target
// (life) JD it corresponds to.
export function targetJdForEphemeris(ephemerisJd, birthJd, yearLengthDays) {
  return birthJd + (ephemerisJd - birthJd) * yearLengthDays;
}

// A progressed real-body provider: `positionAt`/`seriesFor` both take and return
// TARGET-time JD, and `speed` is degrees per day of target time - a caller (the shared
// lib/event-search.js engine, or index.js composing a relative provider over this one)
// never has to know or branch on which rate produced it.
export function progressedBodyProvider(body, { birthJd, yearLengthDays }) {
  return {
    seriesFor(startJd, endJd, stepDays) {
      const ephStart = ephemerisJdForTarget(startJd, birthJd, yearLengthDays);
      const ephEnd = ephemerisJdForTarget(endJd, birthJd, yearLengthDays);
      const ephStep = stepDays / yearLengthDays;
      return ephemerisSeriesFor(body, ephStart, ephEnd, ephStep).map((row) => ({
        jd: targetJdForEphemeris(row.jd, birthJd, yearLengthDays),
        longitude: row.longitude,
        speed: row.speed / yearLengthDays,
      }));
    },
    positionAt(targetJd) {
      const ephJd = ephemerisJdForTarget(targetJd, birthJd, yearLengthDays);
      const { longitude, speed } = ephemerisPositionAt(body, ephJd);
      return { longitude, speed: speed / yearLengthDays };
    },
  };
}

// Progressed Midheaven provider (spec §4c): natal MC directed by computeArcDegrees(t),
// never the raw clock-moment MC. Purely arithmetic, composed over the progressed Sun
// provider rather than spawning its own swetest calls:
//   - solar_arc: MC(t) = natalMC + (progressedSun(t) - natalSun), so MC and the progressed
//     Sun move in exact lockstep by construction - MC's speed IS the Sun's already-rescaled
//     target-time speed, reused rather than re-derived.
//   - naibod: MC(t) = natalMC + (360/Y)*elapsedYears(t), a constant rate independent of the
//     Sun entirely - elapsedYears(t) is linear in t, so speed is exactly (360/Y)/Y deg/day
//     of target time (the extra /Y converts "per elapsed year" to "per target-time day").
export function progressedMcProvider({ angleMethod, natalMcLongitude, natalSunLongitude, birthJd, yearLengthDays, sunProvider }) {
  const naibodSpeed = (360 / yearLengthDays) / yearLengthDays;

  function at(targetJd) {
    if (angleMethod === 'solar_arc') {
      const sun = sunProvider.positionAt(targetJd);
      const arc = computeArcDegrees('solar_arc', { natalSunLongitude, progressedSunLongitude: sun.longitude });
      return { longitude: mod360(natalMcLongitude + arc), speed: sun.speed };
    }
    const elapsedYears = (targetJd - birthJd) / yearLengthDays;
    const arc = computeArcDegrees('naibod', { elapsedYears, yearLengthDays });
    return { longitude: mod360(natalMcLongitude + arc), speed: naibodSpeed };
  }

  return {
    positionAt: at,
    seriesFor(startJd, endJd, stepDays) {
      if (angleMethod === 'solar_arc') {
        // Reuses the Sun provider's own grid/spawn - no extra swetest call for MC at all.
        return sunProvider.seriesFor(startJd, endJd, stepDays).map((row) => ({
          jd: row.jd,
          longitude: mod360(natalMcLongitude + computeArcDegrees('solar_arc', { natalSunLongitude, progressedSunLongitude: row.longitude })),
          speed: row.speed,
        }));
      }
      // naibod needs no ephemeris data at all - generate the same ceiling-based grid
      // lib/ephemeris-series.js's seriesFor uses, so a caller composing this with another
      // provider's rows still gets a consistent, endJd-terminated series.
      const rows = [];
      const steps = Math.max(0, Math.ceil((endJd - startJd) / stepDays - 1e-9));
      for (let i = 0; i <= steps; i++) {
        const jd = i === steps ? endJd : Math.min(startJd + i * stepDays, endJd);
        rows.push({ jd, ...at(jd) });
      }
      return rows;
    },
  };
}
