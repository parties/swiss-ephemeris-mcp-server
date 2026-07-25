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
  },
};

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
