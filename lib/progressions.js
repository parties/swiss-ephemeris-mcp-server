// Secondary progressions (SUP-356): day-for-a-year technique. Angle math only - the
// swetest orchestration (which calculateEphemeris calls to make, in what order) lives in
// index.js, since it needs the shared calculateEphemeris/exec plumbing. See
// docs/tool_requests/2026-07-27_secondary-progressions.md for the algorithm derivation and
// the ecliptic-vs-RA ruling (SUP-356 comment thread).

// Tropical year length in days, used both to convert real elapsed time into "elapsed
// years" (the day-for-a-year step) and as the Naibod rate's denominator (360 / this).
export const TROPICAL_YEAR_DAYS = 365.2422;

const MS_PER_DAY = 86400000;

export function mod360(deg) {
  return ((deg % 360) + 360) % 360;
}

// Real elapsed time between birth and the target date, expressed in tropical years
// (fractional). This is "N" in the day-for-a-year technique: progressed_datetime is
// birth_datetime + N days.
export function computeElapsedYears(birthDate, targetDate, yearLengthDays = TROPICAL_YEAR_DAYS) {
  return (targetDate.getTime() - birthDate.getTime()) / MS_PER_DAY / yearLengthDays;
}

export function computeProgressedDate(birthDate, elapsedYears) {
  return new Date(birthDate.getTime() + elapsedYears * MS_PER_DAY);
}

// Rounds to the nearest second and drops milliseconds, matching lib/event-search.js's
// isoFromJd formatting - the ticket's worked examples are all whole-second timestamps.
export function formatProgressedDatetime(date) {
  const rounded = new Date(Math.round(date.getTime() / 1000) * 1000);
  return rounded.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// arc: solar_arc is (progressed Sun - natal Sun), the self-correcting convention (default).
// naibod is a mean-rate stand-in, derived as 360/year_length_days rather than a bare
// 0.9856 literal so it tracks whatever year length this module uses (SUP-356 advisory
// comment #3).
export function computeArcDegrees(angleMethod, { natalSunLongitude, progressedSunLongitude, elapsedYears, yearLengthDays = TROPICAL_YEAR_DAYS }) {
  if (angleMethod === 'solar_arc') {
    return mod360(progressedSunLongitude - natalSunLongitude);
  }
  return mod360((360 / yearLengthDays) * elapsedYears);
}

// Right ascension of a point with ecliptic latitude 0 (the Midheaven always sits on the
// ecliptic) - converts the progressed ecliptic MC into the ARMC swetest's -house actually
// consumes. This is "the step the plan omits" per the spec: RA and ecliptic longitude are
// related nonlinearly through obliquity, so advancing ARMC directly by the same arc as the
// ecliptic MC gives a different (wrong) answer - see docs/tool_requests/2026-07-27_
// secondary-progressions.md §1.
export function rightAscensionFromEclipticLongitude(eclipticLongitudeDeg, obliquityDeg) {
  const lambda = (eclipticLongitudeDeg * Math.PI) / 180;
  const epsilon = (obliquityDeg * Math.PI) / 180;
  const raRad = Math.atan2(Math.sin(lambda) * Math.cos(epsilon), Math.cos(lambda));
  return mod360((raRad * 180) / Math.PI);
}

// Normalizes to (-180, 180], the range swetest's -house geographic longitude argument
// accepts. The result carries no geographic meaning - see computeFictitiousLongitude.
export function normalizeLongitudeSigned(deg) {
  const normalized = mod360(deg);
  return normalized > 180 ? normalized - 360 : normalized;
}

// The fictitious longitude fed to `-house<lon>,<natal_lat>,<sys>` to make swetest compute
// house cusps from a caller-chosen ARMC instead of the real (wrong, clock-driven) one at
// the progressed instant. Derivation: swetest's ARMC is linear in geographic longitude at
// fixed date/time - ARMC(lon) = ARMC(0) + lon (verified 1:1 in the spec) - so solving
// ARMC(lon') = targetArmc for lon' requires the reference constant ARMC(0), which is
// baseArmc - natalLongitude (baseArmc having been measured AT natalLongitude, not at 0).
// The spec's own worked example omits the "+ natalLongitude" term and still passes only
// because it uses a Greenwich (natalLongitude = 0) fixture - PARTNER_CHART (natalLongitude
// = -74.006) fails acceptance criterion #3 without this term (verified against vendored
// swetest during SUP-356 implementation). Do not drop it.
export function computeFictitiousLongitude({ progressedMcLongitude, obliquityDeg, baseArmc, natalLongitude }) {
  const targetArmc = rightAscensionFromEclipticLongitude(progressedMcLongitude, obliquityDeg);
  return normalizeLongitudeSigned(targetArmc - baseArmc + natalLongitude);
}
