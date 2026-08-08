const signMap = {
  'ar': { name: 'Aries', offset: 0 },
  'ta': { name: 'Taurus', offset: 30 },
  'ge': { name: 'Gemini', offset: 60 },
  'cn': { name: 'Cancer', offset: 90 },
  'le': { name: 'Leo', offset: 120 },
  'vi': { name: 'Virgo', offset: 150 },
  'li': { name: 'Libra', offset: 180 },
  'sc': { name: 'Scorpio', offset: 210 },
  'sa': { name: 'Sagittarius', offset: 240 },
  'cp': { name: 'Capricorn', offset: 270 },
  'aq': { name: 'Aquarius', offset: 300 },
  'pi': { name: 'Pisces', offset: 330 }
};

// Signed D°MM'SS.ssss form shared by the speed, ecliptic latitude, and declination
// columns (e.g. "0°58'48.6142", "-0°22' 8.7569"). Degrees can print as "-0", which is
// falsy for a `< 0` sign check, so the sign also falls back to the leading '-' in the
// original string.
function parseSignedDMS(str) {
  const trimmed = str.trim();
  const match = trimmed.match(/^(-?\d+)\D\s*(\d+)'\s*([\d.]+)$/);
  if (match) {
    const degrees = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const seconds = parseFloat(match[3]);
    const sign = degrees < 0 || trimmed.startsWith('-') ? -1 : 1;
    return sign * (Math.abs(degrees) + (minutes / 60) + (seconds / 3600));
  }
  const plain = parseFloat(trimmed);
  return isNaN(plain) ? undefined : plain;
}

export function formatDateToSwiss(date) {
  // Format date as DD.MM.YYYY using UTC components
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

export function formatTimeToSwiss(date) {
  // Format time as HH:MM:SS using UTC components
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function parsePlanetLine(line) {
  // Parse planet position line from swetest output
  // Format: "Sun            ,22 le 53'51.2332" or "Moon           , 2 cp 21' 3.2731,  0.1234"
  const parts = line.trim().split(',');
  if (parts.length < 2) return null;

  const name = parts[0].trim();

  // Ecl. Obl. is a pseudo-body, not a real position: appending 'o' to the -p list makes
  // swetest print the obliquity of the date encoded as a zodiacal position that happens to
  // land in Aries. Read the decimal `l` field instead (requires -fPZSBDl) rather than relying
  // on that coincidence - see docs/SUP-345-declination-layer-spec.md §1.4. This must never be
  // treated as a body position, and the caller must exclude it from `planets` by name.
  if (name === 'Ecl. Obl.') {
    const decimalStr = parts[5] !== undefined ? parts[5].trim() : undefined;
    const obliquity = decimalStr !== undefined ? parseFloat(decimalStr) : undefined;
    return { name, obliquity };
  }

  const positionStr = parts[1].trim();

  // Parse position like "22 le 53'51.2332" or "2 cp 21' 3.2731" (note space after apostrophe)
  const posMatch = positionStr.match(/^(\d+)\s+([a-z]{2})\s+(\d+)'\s*([\d.]+)$/i);
  if (!posMatch) return null;

  const degrees = parseInt(posMatch[1]);
  const signAbbr = posMatch[2].toLowerCase();
  const minutes = parseInt(posMatch[3]);
  const seconds = parseFloat(posMatch[4]);

  const signInfo = signMap[signAbbr];
  if (!signInfo) return null;

  // Calculate total longitude in degrees
  const longitude = signInfo.offset + degrees + (minutes / 60) + (seconds / 3600);

  // Speed (deg/day), ecliptic latitude, and declination are the same signed D°MM'SS.ssss
  // form, in that column order (-fPZSBD).
  const speed = parts.length >= 3 ? parseSignedDMS(parts[2]) : undefined;
  const eclipticLatitude = parts.length >= 4 ? parseSignedDMS(parts[3]) : undefined;
  const declination = parts.length >= 5 ? parseSignedDMS(parts[4]) : undefined;

  return {
    name,
    longitude,
    sign: signInfo.name,
    degree: Math.round((degrees + (minutes / 60) + (seconds / 3600)) * 100) / 100,
    speed,
    ecliptic_latitude: eclipticLatitude,
    declination
  };
}

export function parseHouseLine(line) {
  // Parse house cusp line from swetest output
  // Format: "house  1       ,13 cn 39'52.5152"
  const parts = line.trim().split(',');
  if (parts.length < 2) return null;

  const houseMatch = parts[0].trim().match(/^house\s+(\d+)/);
  if (!houseMatch) return null;

  const house = parseInt(houseMatch[1]);
  const positionStr = parts[1].trim();

  // Parse position like "13 cn 39'52.5152" (allow optional spaces after apostrophe)
  const posMatch = positionStr.match(/^(\d+)\s+([a-z]{2})\s+(\d+)'\s*([\d.]+)$/i);
  if (!posMatch) return null;

  const degrees = parseInt(posMatch[1]);
  const signAbbr = posMatch[2].toLowerCase();
  const minutes = parseInt(posMatch[3]);
  const seconds = parseFloat(posMatch[4]);

  const signInfo = signMap[signAbbr];
  if (!signInfo) return null;

  // Calculate total longitude in degrees
  const longitude = signInfo.offset + degrees + (minutes / 60) + (seconds / 3600);

  // House/angle lines have no latitude column (they're all ecliptic latitude 0 by
  // construction), so under -fPZSBD field 3 (index 2) is the cusp's diurnal rotation rate
  // - not a body's speed, never parse it as one - and field 4 (index 3) is declination.
  // See docs/SUP-345-declination-layer-spec.md §1.1-1.2.
  const declination = parts.length >= 4 ? parseSignedDMS(parts[3]) : undefined;

  return {
    house,
    longitude,
    sign: signInfo.name,
    degree: Math.round((degrees + (minutes / 60) + (seconds / 3600)) * 100) / 100,
    declination
  };
}

export function parseChartPointLine(line) {
  // Parse chart point line from swetest output
  // Format: "Ascendant      ,13 cn 39'52.5152"
  const parts = line.trim().split(',');
  if (parts.length < 2) return null;

  const name = parts[0].trim();
  const positionStr = parts[1].trim();

  // Parse position like "13 cn 39'52.5152" (allow optional spaces after apostrophe)
  const posMatch = positionStr.match(/^(\d+)\s+([a-z]{2})\s+(\d+)'\s*([\d.]+)$/i);
  if (!posMatch) return null;

  const degrees = parseInt(posMatch[1]);
  const signAbbr = posMatch[2].toLowerCase();
  const minutes = parseInt(posMatch[3]);
  const seconds = parseFloat(posMatch[4]);

  const signInfo = signMap[signAbbr];
  if (!signInfo) return null;

  // Calculate total longitude in degrees
  const longitude = signInfo.offset + degrees + (minutes / 60) + (seconds / 3600);

  // Same column layout as house lines: field 3 (index 2) is a rotation rate, not a speed;
  // field 4 (index 3) is declination. ARMC's field 4 is a meaningless right-ascension
  // artifact (§1.3) - the caller drops it rather than reporting it here.
  const declination = parts.length >= 4 ? parseSignedDMS(parts[3]) : undefined;

  return {
    name,
    longitude,
    sign: signInfo.name,
    degree: Math.round((degrees + (minutes / 60) + (seconds / 3600)) * 100) / 100,
    declination
  };
}
