const PHASES = [
  'New',
  'Crescent',
  'First Quarter',
  'Gibbous',
  'Full',
  'Disseminating',
  'Last Quarter',
  'Balsamic',
];

const BAND_WIDTH = 360 / PHASES.length;

export const PHASE_SCHEME = '8-phase, bands start at exact aspect';

// Moon - Sun ecliptic longitude difference, normalized to [0, 360).
export function normalizeElongation(rawDifference) {
  return ((rawDifference % 360) + 360) % 360;
}

// Bands start at the exact aspect (New = 0-45deg) - the Rudhyar-lineage form and the
// astrological standard. The almanac form instead centers bands on the exact aspects
// (New = 337.5-22.5deg), which names the phase differently near every boundary.
export function phaseFromElongation(elongation) {
  const index = Math.floor(normalizeElongation(elongation) / BAND_WIDTH) % PHASES.length;
  return PHASES[index];
}

// elongation must come from the parsed ecliptic longitudes, not swetest's `*` column -
// that column is the true 3D angular separation, which folds at 180deg and cannot
// distinguish waxing from waning.
export function moonPhase(sunLongitude, moonLongitude) {
  const elongation = normalizeElongation(moonLongitude - sunLongitude);
  return {
    phase: phaseFromElongation(elongation),
    elongation,
    phase_scheme: PHASE_SCHEME,
  };
}
