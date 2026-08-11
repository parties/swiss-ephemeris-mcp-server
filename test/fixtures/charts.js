/**
 * Synthetic chart fixtures.
 *
 * These are arbitrary round datetimes at well-known coordinates. They belong to nobody.
 * Never replace them with a real person's birth data — see CLAUDE.md.
 *
 * Expected values were computed against swiss-ephemeris-mcp-server@1.0.2+c01d22d and are
 * recorded here so a test can assert a concrete number rather than only re-deriving the
 * formula it is trying to verify. If the ephemeris data or house code changes, re-verify
 * rather than blindly updating.
 */

/** Greenwich at noon UTC — Sun near the Midheaven, so an unambiguous day chart. */
export const DAY_CHART = {
  label: 'day chart (Greenwich, noon)',
  datetime: '1990-01-01T12:00:00Z',
  latitude: 51.4769,
  longitude: 0.0,
  expected: {
    sect: 'day',
    sunHouse: 10,
    partOfFortune: 77.6453, // 17°39′ Gemini
    obliquity: 23.4423661, // true obliquity, 23°26′32.52″
    outOfBounds: ['Uranus', 'Ceres'],
    declinationAspectCount: 13, // 1deg orb, 16 bodies (SUP-347 §4.2)
    trueNodeLongitude: 316.8703610, // 16°52′ Aquarius - default node_type (SUP-352)
    moonPhase: { phase: 'Crescent', elongation: 52.4533937, illuminatedFraction: 0.196208808 },
    // SUP-350 find_events engine — window 2026-01-01 .. 2029-01-01, default transiting
    // set, moiety orbs (spec §4.1/§4.2/§4.9).
    plutoSquareLilithPasses: 5,
    plutoConjunctVenusPasses: 3,
    neptuneStationDirect2026: '2026-12-12T22:17:19Z',
    // SUP-356 calculate_secondary_progressions - elapsed 32.500 tropical yr (year_length_days
    // 365.2422) -> progressed_datetime 1990-02-03T00:00:00Z. Verified against vendored swetest;
    // see docs/tool_requests/2026-07-27_secondary-progressions.md for the algorithm.
    progressions: {
      elapsedYears: 32.5,
      progressedDatetime: '1990-02-03T00:00:00Z',
      solarArcMcLongitude: 313.0775174, // 13°04'39" Aquarius
      naibodMcLongitude: 312.0339368, // 12°01'57" Aquarius
      ascendantLongitude: 78.6844134, // 18°41'04" Gemini - derived at natal latitude 51.4769
      progressedSunLongitude: 313.8913796, // 13°53'29" Aquarius
      progressedMoonLongitude: 46.8892126, // 16°53'21" Taurus
      progressedVenusLongitude: 291.5169009, // 21°31'01" Capricorn, retrograde
      // The raw (wrong) angle this tool exists to replace: chart_points.Midheaven of a plain
      // calculate_planetary_positions call at progressedDatetime, natal coordinates - 10°27'45"
      // Leo, +210° from natal MC. Regression guard for SUP-356 acceptance criterion #8.
      rawMidheavenLongitude: 130.4625838,
    },
  },
};

/** Same place, twelve hours earlier — Sun near the IC, so an unambiguous night chart. */
export const NIGHT_CHART = {
  label: 'night chart (Greenwich, midnight)',
  datetime: '1990-01-01T00:00:00Z',
  latitude: 51.4769,
  longitude: 0.0,
  expected: {
    sect: 'night',
    sunHouse: 4,
    partOfFortune: 141.0741, // 21°04′ Leo
    moonPhase: { phase: 'Crescent', elongation: 46.2528185, illuminatedFraction: 0.154978200 },
  },
};

/** Second person, for synastry / transit comparisons. */
export const PARTNER_CHART = {
  label: 'partner chart (New York)',
  datetime: '1995-07-04T00:00:00Z',
  latitude: 40.7128,
  longitude: -74.0060,
  expected: {
    sect: 'day',
    sunHouse: 7,
    partOfFortune: 342.9174, // 12°55′ Pisces
    declinationAspectCount: 16, // 1deg orb, 16 bodies; tightest Mercury contraparallel Neptune 0.025838 (SUP-347 §4.5)
    moonPhase: { phase: 'Crescent', elongation: 67.6455373, illuminatedFraction: 0.311278704 },
    // SUP-356 calculate_secondary_progressions - elapsed 27.500 tropical yr -> progressed_datetime
    // 1995-07-31T12:00:00Z. Nonzero natal longitude (-74.0060) exercises the natal-longitude
    // correction to the fictitious-ARMC-longitude formula (see lib/progressions.js
    // computeFictitiousLongitude) - DAY_CHART's Greenwich fixture can't catch that on its own.
    progressions: {
      elapsedYears: 27.5,
      progressedDatetime: '1995-07-31T12:00:00Z',
      solarArcMcLongitude: 235.8452704, // 25°50'43" Scorpio
    },
  },
};

/** Southern hemisphere — catches latitude-sign errors in house and angle math. */
export const SOUTHERN_CHART = {
  label: 'southern hemisphere chart (Sydney)',
  datetime: '2000-03-20T06:00:00Z',
  latitude: -33.8688,
  longitude: 151.2093,
  expected: {
    sect: 'day',
    sunHouse: 8,
    partOfFortune: 316.2748, // 16°16′ Aquarius
    obliquity: 23.4381391, // true obliquity - different from DAY_CHART's, so a hardcoded value fails here
    outOfBounds: [],
    // 1deg orb, 16 bodies; tightest Saturn parallel Ceres 0.314272, includes a contraparallel
    // pair (Mars-Pluto, 0.592604) so that branch is exercised outside DAY_CHART (SUP-347 §4.5)
    declinationAspectCount: 8,
    // Moon - Sun raw difference here is -179.3393279 (Moon at 180.5949902, Sun at
    // 359.9343181) - negative, so this is the wrap case: it only lands at the correct
    // positive elongation if normalized with (% 360 + 360) % 360 rather than left signed.
    moonPhase: { phase: 'Full', elongation: 180.6606721, illuminatedFraction: 0.998544605 },
  },
};

/**
 * SUP-274 regression case: Sun sits between 0deg of the Ascendant's sign and the true
 * Ascendant degree, so Whole Sign widens house 1 to include the Sun while Placidus (whose
 * cusp 1 matches the true Ascendant) does not. Sect must come out "day" under every house
 * system - see the house-system-invariance tests in part-of-fortune.integration.test.js.
 */
export const WHOLE_SIGN_EDGE_CHART = {
  label: 'Whole Sign edge case (Greenwich) - Sun between 0deg Aries and the true Ascendant',
  datetime: '2024-04-04T06:00:00Z',
  latitude: 51.4769,
  longitude: 0.0,
  expected: {
    sect: 'day',
    sunHouse: 12,
    partOfFortune: 327.161505, // 27°10′ Aquarius (Placidus; house-system-invariant per SUP-274)
  },
};

/**
 * SUP-352: true/mean Node divergence case. `swetest`'s true (osculating) Node wobbles
 * around the smoothed mean Node; this date was picked because the two are about 1.7deg
 * apart here, matching the order of magnitude the ticket was filed against.
 */
export const NODE_DIVERGENCE_CHART = {
  label: 'node divergence chart (Greenwich, 2026)',
  datetime: '2026-07-01T12:00:00Z',
  latitude: 51.4769,
  longitude: 0.0,
  expected: {
    trueNodeLongitude: 330.82186044444444, // 0°49' Pisces
    meanNodeLongitude: 332.56042872222224, // 2°34' Pisces
  },
};

/**
 * SUP-359 review follow-up: high latitude (Svalbard), for exercising the progressed
 * Ascendant's adaptive coarse-step subdivision (index.js adaptiveJdGrid) - its rate per
 * degree of ARMC is unbounded near the poles, which no other fixture here gets close to
 * (the highest, DAY_CHART/NIGHT_CHART, is 51.4769). `expected.progressions.ascendant` was
 * computed via find_events' own progressed-Ascendant path (progressedAscendantLongitude in
 * test/find-events-progressed.integration.test.js) and independently cross-checked against
 * calculate_secondary_progressions at the same instant, agreeing to <1e-6deg - the same
 * cross-tool identity §6.1 already establishes at DAY_CHART/PARTNER_CHART/SOUTHERN_CHART,
 * extended here to a latitude the review flagged as untested.
 */
export const POLAR_CHART = {
  label: 'polar chart (Svalbard)',
  datetime: '1990-01-01T12:00:00Z',
  latitude: 78.2232,
  longitude: 15.6267,
  expected: {
    progressions: {
      // elapsed years -> progressed Ascendant longitude, angle_method "solar_arc" (default)
      ascendant10yr: 332.8454332222222,
      ascendant32yr: 329.15207427777773,
      ascendant60yr: 151.55307497222222,
    },
  },
};

// Not included in ALL_CHARTS: several test suites key fixed expectations (e.g. minimum
// aspect counts) off ALL_CHARTS by fixture.label, and this fixture doesn't have entries
// there. It's consumed directly by the house-system-invariance tests instead.
export const ALL_CHARTS = [DAY_CHART, NIGHT_CHART, PARTNER_CHART, SOUTHERN_CHART];

/**
 * Which house a longitude falls in, given the 12 cusps from a chart result.
 * Handles the wrap at 0° Aries.
 */
export function houseOf(longitude, houses) {
  for (let i = 1; i <= 12; i++) {
    const start = houses[String(i)].longitude;
    const end = houses[String((i % 12) + 1)].longitude;
    const inside = start < end
      ? longitude >= start && longitude < end
      : longitude >= start || longitude < end;
    if (inside) return i;
  }
  throw new Error(`longitude ${longitude} matched no house`);
}
