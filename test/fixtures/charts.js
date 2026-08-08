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
    trueNodeLongitude: 316.8703610, // 16°52′ Aquarius - default node_type (SUP-352)
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
