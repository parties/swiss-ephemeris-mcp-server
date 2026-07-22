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

  let speed;
  if (parts.length >= 3) {
    const speedStr = parts[2].trim();
    // Parse signed speed like "0°58'48.6142" or "-0°22' 8.7569" (deg/day, sign on the value)
    const speedMatch = speedStr.match(/^(-?\d+)\D\s*(\d+)'\s*([\d.]+)$/);
    if (speedMatch) {
      const speedDegrees = parseInt(speedMatch[1]);
      const speedMinutes = parseInt(speedMatch[2]);
      const speedSeconds = parseFloat(speedMatch[3]);
      const sign = speedDegrees < 0 || speedStr.trim().startsWith('-') ? -1 : 1;
      speed = sign * (Math.abs(speedDegrees) + (speedMinutes / 60) + (speedSeconds / 3600));
    } else {
      const plainSpeed = parseFloat(speedStr);
      if (!isNaN(plainSpeed)) {
        speed = plainSpeed;
      }
    }
  }

  return {
    name,
    longitude,
    sign: signInfo.name,
    degree: Math.round((degrees + (minutes / 60) + (seconds / 3600)) * 100) / 100,
    speed
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

  return {
    house,
    longitude,
    sign: signInfo.name,
    degree: Math.round((degrees + (minutes / 60) + (seconds / 3600)) * 100) / 100
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

  return {
    name,
    longitude,
    sign: signInfo.name,
    degree: Math.round((degrees + (minutes / 60) + (seconds / 3600)) * 100) / 100
  };
}
