#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  formatDateToSwiss,
  formatTimeToSwiss,
  parsePlanetLine,
  parseHouseLine,
  parseChartPointLine,
} from './lib/swetest-parse.js';
import {
  DEFAULT_ASPECT_BODIES,
  ANGLE_BODIES,
  ASPECTABLE_ANGLES,
  calculateNatalAspects,
  calculateCrossChartAspects,
  calculateHouseOverlay,
  toAspectBody,
  toPointPosition,
  resolveChartPoint,
  invalidOrbOverrideKeys,
  ORB_MODELS,
} from './lib/aspects.js';

function validateOrbModel(orbModel) {
  if (orbModel !== undefined && !ORB_MODELS.includes(orbModel)) {
    throw new McpError(ErrorCode.InvalidParams, `orb_model must be one of: ${ORB_MODELS.join(', ')}`);
  }
}

// House-overlay only (SUP-263) - the aspect grid and angle-aspect planet side use the wider
// DEFAULT_ASPECT_BODIES list instead; overlaying 17 bodies into 12 houses is noisier.
const SYNASTRY_BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

// Synastry overlay set: the 10 planets plus the aspectable angles (Ascendant, Midheaven,
// Part of Fortune). Descendant/IC are excluded - they're exact mirrors of ASC/MC for house
// placement and the codebase already treats them as non-first-class (ASPECTABLE_ANGLES).
const SYNASTRY_OVERLAY_BODIES = [...SYNASTRY_BODIES, ...ASPECTABLE_ANGLES];

// Falls back to the vendor/ dir shipped alongside this file (works both in the
// Docker image, where it's copied to /app/vendor/swisseph, and in local/npx
// installs, where /app doesn't exist). SE_EPHE_PATH still overrides it.
const DEFAULT_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'swisseph');

// swetest house system codes: https://www.astro.com/swisseph/swephprg.htm#_Toc112948996
const HOUSE_SYSTEMS = {
  P: 'Placidus',
  K: 'Koch',
  O: 'Porphyry',
  R: 'Regiomontanus',
  C: 'Campanus',
  E: 'Equal',
  W: 'Whole Sign',
  B: 'Alcabitus',
  M: 'Morinus',
  T: 'Polich/Page (Topocentric)',
};

function validateHouseSystem(value, paramName = 'house_system') {
  if (value === undefined) return 'P';
  if (typeof value !== 'string' || !HOUSE_SYSTEMS[value]) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${paramName} must be one of: ${Object.keys(HOUSE_SYSTEMS).join(', ')}`
    );
  }
  return value;
}

class SwissEphemerisServer {
  constructor() {
    this.server = new Server(
      {
        name: 'swiss-ephemeris-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'calculate_planetary_positions',
            description: 'Calculate planetary positions, houses, chart points and asteroids for a given datetime and coordinates',
            inputSchema: {
              type: 'object',
              properties: {
                datetime: {
                  type: 'string',
                  description: 'ISO8601 datetime, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Longitude in decimal degrees, positive east',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
              },
              required: ['datetime', 'latitude', 'longitude'],
            },
          },
          {
            name: 'calculate_transits',
            description: 'Calculate birth chart positions and current transits for comparison, including aspects from transiting bodies to the natal chart. `applying` is computed from the transiting body\'s motion only; the natal position is treated as fixed.',
            inputSchema: {
              type: 'object',
              properties: {
                birth_datetime: {
                  type: 'string',
                  description: 'Birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Birth latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Birth longitude in decimal degrees, positive east',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile) in transit_aspects. Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include the NATAL chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in transit_aspects. Transiting angles are always excluded, even if requested via `bodies`: they are artifacts of the moment\'s location and time of day (the transiting Ascendant sweeps the whole zodiac daily), so transit-side angle contacts change minute to minute and carry no meaning. Default false.',
                },
                include_south_node: {
                  type: 'boolean',
                  description: 'Include South Node in transit_aspects. Default false.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list for transit_aspects. Must be names known to the server. Angle bodies are always excluded from the transiting side, even if listed here.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees for transit_aspects, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model for transit_aspects. "moiety" (default) sums each body\'s half-orb (e.g. Sun 7.5°, Moon 6°) and scales by the aspect\'s multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. There is no single canonical orb table — see calculate_aspects\' orb_model description (or README) for moiety provenance and why sextile stays a major aspect despite its narrower 0.75 multiplier.',
                },
              },
              required: ['birth_datetime', 'latitude', 'longitude'],
            },
          },
          {
            name: 'calculate_solar_revolution',
            description: 'Calculate solar return chart for a specific year. The solar return occurs when the Sun returns to the exact same position as at birth.',
            inputSchema: {
              type: 'object',
              properties: {
                birth_datetime: {
                  type: 'string',
                  description: 'Birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                birth_latitude: {
                  type: 'number',
                  description: 'Birth latitude in decimal degrees',
                },
                birth_longitude: {
                  type: 'number',
                  description: 'Birth longitude in decimal degrees, positive east',
                },
                return_year: {
                  type: 'number',
                  description: 'Year for the solar return calculation, e.g., 2024',
                },
                return_latitude: {
                  type: 'number',
                  description: 'Latitude for solar return location (optional, defaults to birth location)',
                },
                return_longitude: {
                  type: 'number',
                  description: 'Longitude for solar return location (optional, defaults to birth location)',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code applied to both natal and solar return charts: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
              },
              required: ['birth_datetime', 'birth_latitude', 'birth_longitude', 'return_year'],
            },
          },
          {
            name: 'calculate_synastry',
            description: 'Calculate synastry chart between two people for relationship compatibility analysis. Compares planetary positions and calculates aspects between the charts.',
            inputSchema: {
              type: 'object',
              properties: {
                person1_datetime: {
                  type: 'string',
                  description: 'Person 1 birth datetime in ISO8601 format, e.g., 1985-04-12T23:20:50Z',
                },
                person1_latitude: {
                  type: 'number',
                  description: 'Person 1 birth latitude in decimal degrees',
                },
                person1_longitude: {
                  type: 'number',
                  description: 'Person 1 birth longitude in decimal degrees, positive east',
                },
                person2_datetime: {
                  type: 'string',
                  description: 'Person 2 birth datetime in ISO8601 format, e.g., 1990-08-25T14:30:00Z',
                },
                person2_latitude: {
                  type: 'number',
                  description: 'Person 2 birth latitude in decimal degrees',
                },
                person2_longitude: {
                  type: 'number',
                  description: 'Person 2 birth longitude in decimal degrees, positive east',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile). Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include cross-chart aspects to chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in addition to planet-planet aspects. Default false.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list (defaults to the full 17-body list: Sun..Pluto, North Node, Lilith, Chiron, Ceres, Pallas, Juno, Vesta). Applies to the aspect grid and angle-aspect planet side only — the house overlay always uses the 10 traditional planets.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model. "moiety" (default) sums each body\'s half-orb and scales by the aspect\'s multiplier — see calculate_aspects for the formula and an example. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. There is no single canonical orb table — see calculate_aspects\' orb_model description (or README) for moiety provenance and why sextile stays a major aspect despite its narrower 0.75 multiplier.',
                },
                person1_house_system: {
                  type: 'string',
                  description: 'House system code for person 1: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
                person2_house_system: {
                  type: 'string',
                  description: 'House system code for person 2: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
              },
              required: ['person1_datetime', 'person1_latitude', 'person1_longitude', 'person2_datetime', 'person2_latitude', 'person2_longitude'],
            },
          },
          {
            name: 'calculate_aspects',
            description: 'Calculate natal chart aspects for a given datetime and coordinates. Returns planetary positions plus all qualifying aspects with orb, applying/separating status, and category.',
            inputSchema: {
              type: 'object',
              properties: {
                datetime: {
                  type: 'string',
                  description: 'ISO8601 datetime, e.g., 1985-04-12T23:20:50Z',
                },
                latitude: {
                  type: 'number',
                  description: 'Latitude in decimal degrees',
                },
                longitude: {
                  type: 'number',
                  description: 'Longitude in decimal degrees, positive east',
                },
                include_minor: {
                  type: 'boolean',
                  description: 'Include minor aspects (semisextile, semisquare, sesquiquadrate, quincunx, quintile, biquintile). Default false.',
                },
                include_angles: {
                  type: 'boolean',
                  description: 'Include chart angles (Ascendant, Midheaven, IC, Descendant, Part of Fortune) in aspect calculations. Default false.',
                },
                include_south_node: {
                  type: 'boolean',
                  description: 'Include South Node in aspect calculations. Default false.',
                },
                bodies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Override the default body list. Must be names known to the server.',
                },
                orb_overrides: {
                  type: 'object',
                  description: 'Per-aspect orb overrides in degrees, e.g. {"conjunction": 10}. Also accepts a per-class shape to move only one orb class, e.g. {"angle": {"square": 4}} or {"derived": {"square": 2}} tightens the angle (Ascendant/Midheaven/IC/Descendant) or derived (Part of Fortune/Vertex) class without touching planets.',
                  additionalProperties: { type: ['number', 'object'] },
                },
                orb_model: {
                  type: 'string',
                  enum: ['class', 'moiety'],
                  description: 'Orb resolution model. "moiety" (default) sums each body\'s half-orb (per-body table, e.g. Sun 7.5°, Moon 6°, Ascendant 2.5°) and scales by the aspect\'s multiplier (1.0 for conjunction/opposition/trine/square, 0.75 for sextile, 0.375 for the minors) — e.g. a Sun-Moon conjunction allows (7.5+6)×1.0 = 13.5°. Under "moiety", orb_overrides takes a different two-knob shape instead: {"moieties": {"Sun": 8}, "multipliers": {"quincunx": 0.3}}. "class" instead uses the fixed per-class orb tables above and honors orb_overrides in its flat/per-class shape. Provenance: there is no single canonical orb table in the tradition — the Sun..Saturn moieties are sourced (halved from a classical full-orb table), everything past Saturn plus angles and lots is a team-constructed, non-traditional convention (see README). Note sextile\'s 0.75 multiplier is a narrower orb, not a demotion: sextile is still returned with category "major" (it is a Ptolemaic aspect) under either orb_model.',
                },
                house_system: {
                  type: 'string',
                  description: 'House system code: P=Placidus (default), K=Koch, O=Porphyry, R=Regiomontanus, C=Campanus, E=Equal, W=Whole Sign, B=Alcabitus, M=Morinus, T=Topocentric.',
                },
              },
              required: ['datetime', 'latitude', 'longitude'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleToolCall(name, args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error.message}`
        );
      }
    });
  }

  calculateEphemeris(datetime, latitude, longitude, houseSystem = 'P') {
    try {
      const date = new Date(datetime);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid datetime format. Use ISO8601 format like 1985-04-12T23:20:50Z');
      }

      const swissDate = formatDateToSwiss(date);
      const swissTime = formatTimeToSwiss(date);
      const ephePath = process.env.SE_EPHE_PATH || DEFAULT_EPHE_PATH;

      // Execute swetest for planets, including asteroids and additional points
      // 0123456789 = Sun through Pluto, t = true Node, A = mean Apogee (Lilith), D = Chiron, F = Ceres, G = Pallas, H = Juno, I = Vesta
      const planetCmd = `SE_EPHE_PATH=${ephePath} swetest -b${swissDate} -ut${swissTime} -p0123456789tADFGHI -fPZS -g, -head`;
      let planetOutput;
      try {
        planetOutput = execSync(planetCmd, { encoding: 'utf8' });
      } catch (error) {
        throw new Error(`Failed to execute swetest for planets: ${error.message}`);
      }

      // Execute swetest for houses
      const houseCmd = `SE_EPHE_PATH=${ephePath} swetest -b${swissDate} -ut${swissTime} -house${longitude},${latitude},${houseSystem} -fPZ -g, -head`;
      let houseOutput;
      try {
        houseOutput = execSync(houseCmd, { encoding: 'utf8' });
      } catch (error) {
        throw new Error(`Failed to execute swetest for houses: ${error.message}`);
      }

      // swetest prints these to stdout (not stderr) when an ephemeris data file for a
      // body is missing, then still emits a "0 ar 0' 0.0000" placeholder row for that
      // body instead of failing the whole command. Without this check that placeholder
      // is indistinguishable from a real 0deg-Aries position and gets reported as fact.
      const missingEphemerisFiles = [...planetOutput.matchAll(/error: SwissEph file '([^']+)' not found/g)]
        .map((m) => m[1]);

      // Parse planets
      const planets = {};
      const planetLines = planetOutput.split('\n').filter(line => line.trim() && !line.includes('error:') && !line.includes('warning:'));

      planetLines.forEach(line => {
        const planet = parsePlanetLine(line);
        if (planet && missingEphemerisFiles.length > 0 && planet.longitude === 0 && planet.speed === 0) {
          // Placeholder row from a missing ephemeris file, not a real position - drop it.
          return;
        }
        if (planet) {
          // Map swetest planet codes to readable names
          const planetNames = {
            'Sun': 'Sun',
            'Moon': 'Moon', 
            'Mercury': 'Mercury',
            'Venus': 'Venus',
            'Mars': 'Mars',
            'Jupiter': 'Jupiter',
            'Saturn': 'Saturn',
            'Uranus': 'Uranus',
            'Neptune': 'Neptune',
            'Pluto': 'Pluto',
            'mean Node': 'North Node',
            'true Node': 'North Node',
            'Chiron': 'Chiron',
            'mean Apogee': 'Lilith',
            'Ceres': 'Ceres',
            'Pallas': 'Pallas',
            'Juno': 'Juno',
            'Vesta': 'Vesta'
          };
          
          const name = planetNames[planet.name] || planet.name;
          planets[name] = {
            longitude: planet.longitude,
            sign: planet.sign,
            degree: planet.degree,
            speed: planet.speed
          };
        }
      });

      // Parse houses and chart points from house output
      const houses = {};
      const chartPoints = {};
      const houseLines = houseOutput.split('\n').filter(line => line.trim() && !line.includes('error:') && !line.includes('warning:'));
      
      houseLines.forEach(line => {
        // Try parsing as house
        if (line.includes('house ')) {
          const house = parseHouseLine(line);
          if (house && house.house >= 1 && house.house <= 12) {
            houses[house.house] = {
              longitude: house.longitude,
              sign: house.sign,
              degree: house.degree
            };
          }
        }
        // Try parsing as chart point
        else if (line.includes('Ascendant') || line.includes('MC') || line.includes('ARMC') || line.includes('Vertex')) {
          const chartPoint = parseChartPointLine(line);
          if (chartPoint) {
            const pointNames = {
              'Ascendant': 'Ascendant',
              'MC': 'Midheaven',
              'ARMC': 'ARMC',
              'Vertex': 'Vertex'
            };
            
            const name = pointNames[chartPoint.name] || chartPoint.name;
            chartPoints[name] = {
              longitude: chartPoint.longitude,
              sign: chartPoint.sign,
              degree: chartPoint.degree
            };
          }
        }
      });

      // Calculate additional points
      const additionalPoints = {};

      // Add South Node (opposite of North Node)
      if (planets['North Node']) {
        const northNodeLon = planets['North Node'].longitude;
        const southNodeLon = (northNodeLon + 180) % 360;
        const signIndex = Math.floor(southNodeLon / 30);
        const degree = southNodeLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        additionalPoints['South Node'] = {
          longitude: southNodeLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100
        };
      }

      // Calculate Part of Fortune: ASC + Moon - Sun for a day chart (Sun above the
      // horizon), ASC + Sun - Moon for a night chart (Sun below the horizon) - the
      // traditional day/night distinction. Sect is a property of the ASC/DSC horizon
      // axis, so it's derived directly from longitudes rather than from `houses`,
      // which is display-house-system-dependent (e.g. Whole Sign widens house 1 to
      // 0° of the Ascendant's sign, decoupling it from the true Ascendant degree).
      if (chartPoints.Ascendant && planets.Sun && planets.Moon) {
        const ascLon = chartPoints.Ascendant.longitude;
        const sunLon = planets.Sun.longitude;
        const moonLon = planets.Moon.longitude;
        const offsetFromAsc = ((sunLon - ascLon) % 360 + 360) % 360;
        const isNightChart = offsetFromAsc < 180;
        let fortuneLon = isNightChart
          ? (ascLon + sunLon - moonLon) % 360
          : (ascLon + moonLon - sunLon) % 360;
        if (fortuneLon < 0) fortuneLon += 360;
        
        const signIndex = Math.floor(fortuneLon / 30);
        const degree = fortuneLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        additionalPoints['Part of Fortune'] = {
          longitude: fortuneLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100
        };
      }

      // Add IC and Descendant based on Ascendant and Midheaven
      if (chartPoints.Ascendant) {
        const ascLon = chartPoints.Ascendant.longitude;
        const descLon = (ascLon + 180) % 360;
        const signIndex = Math.floor(descLon / 30);
        const degree = descLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        chartPoints.Descendant = {
          longitude: descLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100
        };
      }

      if (chartPoints.Midheaven) {
        const mcLon = chartPoints.Midheaven.longitude;
        const icLon = (mcLon + 180) % 360;
        const signIndex = Math.floor(icLon / 30);
        const degree = icLon % 30;
        const signs = [
          'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
          'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
        ];
        
        chartPoints.IC = {
          longitude: icLon,
          sign: signs[signIndex],
          degree: Math.round(degree * 100) / 100
        };
      }

      const result = {
        planets,
        houses,
        chart_points: chartPoints,
        additional_points: additionalPoints,
        datetime: datetime,
        coordinates: {
          latitude,
          longitude
        },
        house_system: houseSystem
      };

      if (missingEphemerisFiles.length > 0) {
        result.warnings = missingEphemerisFiles.map(
          (file) => `Ephemeris data file '${file}' not found under SE_EPHE_PATH (${ephePath}) - bodies depending on it were omitted from 'planets' rather than reported at a false position.`
        );
      }

      return result;

    } catch (error) {
      throw new Error(`Swiss Ephemeris calculation failed: ${error.message}`);
    }
  }

  // Shared by calculate_aspects and calculate_transits: validate the requested
  // bodies/orb_overrides against an ephemeris result and resolve them to
  // {name, longitude, speed} entries for the aspect engine.
  resolveAspectBodies(ephemerisResult, options = {}) {
    const {
      includeAngles = false,
      includeSouthNode = false,
      bodies,
      orbOverrides = {},
      orbModel = 'moiety',
    } = options;

    const knownBodies = new Set([...DEFAULT_ASPECT_BODIES, ...ANGLE_BODIES, 'South Node']);

    const requestedBodies = Array.isArray(bodies) && bodies.length ? bodies : DEFAULT_ASPECT_BODIES;

    for (const b of requestedBodies) {
      if (!knownBodies.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown body: ${b}`);
      }
    }

    const invalidOrbKeys = invalidOrbOverrideKeys(orbOverrides, orbModel);
    if (invalidOrbKeys.length) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${invalidOrbKeys[0]}`);
    }

    const bodySet = new Set(requestedBodies);
    if (includeAngles) {
      // DSC/IC are mirrors of ASC/MC and are never aspected - see ASPECTABLE_ANGLES.
      ASPECTABLE_ANGLES.forEach((b) => bodySet.add(b));
    }
    if (includeSouthNode) {
      bodySet.add('South Node');
    }

    // include_angles/include_south_node gate which bodies enter aspect matching, and that
    // gate applies uniformly whether a body came from the default set or an explicit `bodies`
    // array (SUP-224) - both the natal path (calculate_aspects) and the cross-chart path
    // (calculate_transits/synastry) resolve bodies through here, so they can never disagree.
    // DSC/IC are legitimate computed points but never enter aspect pair-matching - see
    // ASPECTABLE_ANGLES - so they're dropped unconditionally, independent of include_angles.
    const aspectableAngleSet = new Set(ASPECTABLE_ANGLES);
    const nonAspectableAngleSet = new Set(ANGLE_BODIES.filter((b) => !aspectableAngleSet.has(b)));
    for (const name of Array.from(bodySet)) {
      if (name === 'South Node') {
        if (!includeSouthNode) bodySet.delete(name);
      } else if (nonAspectableAngleSet.has(name)) {
        bodySet.delete(name);
      } else if (aspectableAngleSet.has(name) && !includeAngles) {
        bodySet.delete(name);
      }
    }

    const bodiesWithLonSpeed = [];

    for (const name of bodySet) {
      const body = toAspectBody(ephemerisResult, name);
      if (body) bodiesWithLonSpeed.push(body);
    }

    return { bodiesWithLonSpeed, requestedBodies };
  }

  calculateChartAspects(ephemerisResult, options = {}) {
    const {
      includeMinor = false,
      includeAngles = false,
      includeSouthNode = false,
      orbOverrides = {},
      orbModel = 'moiety',
    } = options;

    const { bodiesWithLonSpeed, requestedBodies } = this.resolveAspectBodies(ephemerisResult, options);

    const aspects = calculateNatalAspects(bodiesWithLonSpeed, {
      includeMinor,
      orbOverrides,
      orbModel,
      includeAngles,
      includeSouthNode,
    });

    return {
      aspects,
      settings_used: {
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        bodies: requestedBodies,
        orb_overrides: orbOverrides,
        orb_model: orbModel,
      },
    };
  }

  // Transit-to-natal aspects: current transiting bodies against the natal chart,
  // sharing the same body resolution/validation as calculate_aspects but pairing
  // across two charts via calculateCrossChartAspects (same engine as synastry).
  calculateTransitAspects(natalChart, transitChart, options = {}) {
    const {
      includeMinor = false,
      includeAngles = false,
      includeSouthNode = false,
      orbOverrides = {},
      orbModel = 'moiety',
    } = options;

    const { bodiesWithLonSpeed: natalBodies, requestedBodies } = this.resolveAspectBodies(natalChart, options);

    // Angles and Part of Fortune are artifacts of the moment's location and time of day: the
    // transiting Ascendant sweeps the whole zodiac daily, so transit-side angle contacts change
    // minute to minute and mean nothing. include_angles adds angles to the natal side only.
    // This drop is unconditional (SUP-154) and sits *after* resolveAspectBodies's shared
    // include_angles/include_south_node gate (SUP-224) - it is transit-side-only and must not
    // be merged into that shared gate, which natal callers also go through.
    const angleSet = new Set(ANGLE_BODIES);
    const { bodiesWithLonSpeed: allTransitBodies } = this.resolveAspectBodies(transitChart, options);
    const transitBodies = allTransitBodies.filter((b) => !angleSet.has(b.name));

    // Natal body is a frozen snapshot for transit purposes — only the transiting body's
    // motion should drive `applying`. Zero natal speed here (never in lib/aspects.js),
    // preserving null so angles/Part of Fortune keep applying: null. See lib/aspects.js:24-25
    // for the sibling precedent (MOIETIES halving) of a comment guarding against "cleanup".
    const frozenNatalBodies = natalBodies.map((b) => ({ ...b, speed: b.speed == null ? null : 0 }));

    const aspects = calculateCrossChartAspects(transitBodies, frozenNatalBodies, {
      includeMinor,
      orbOverrides,
      orbModel,
    }).map((a) => ({
      transiting_body: a.body_a,
      natal_body: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: a.orb.toFixed(2),
      exact_angle: a.separation.toFixed(2),
      applying: a.applying,
    }));

    return {
      aspects,
      settings_used: {
        include_minor_aspects: includeMinor,
        include_angles: includeAngles,
        include_south_node: includeSouthNode,
        bodies: requestedBodies,
        orb_overrides: orbOverrides,
        orb_model: orbModel,
      },
    };
  }

  // Synastry-specific body list resolution, scoped to DEFAULT_ASPECT_BODIES only - unlike
  // resolveAspectBodies, ANGLE_BODIES/South Node don't apply here: synastry's planet-side
  // bodies come from a plain `planets` dict (not a full ephemeris result), and angle contacts
  // already go through the separate ASPECTABLE_ANGLES path gated by include_angles.
  resolveSynastryBodies(bodies) {
    const requestedBodies = Array.isArray(bodies) && bodies.length ? bodies : DEFAULT_ASPECT_BODIES;
    const knownBodies = new Set(DEFAULT_ASPECT_BODIES);
    for (const b of requestedBodies) {
      if (!knownBodies.has(b)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown body: ${b}`);
      }
    }
    return requestedBodies;
  }

  calculateSynastryAspects(person1Planets, person2Planets, options = {}) {
    const requestedBodies = this.resolveSynastryBodies(options.bodies);

    const toBodiesWithLonSpeed = (planets) => requestedBodies
      .filter((name) => planets[name])
      .map((name) => ({ name, longitude: planets[name].longitude, speed: planets[name].speed ?? null }));

    const bodiesA = toBodiesWithLonSpeed(person1Planets);
    const bodiesB = toBodiesWithLonSpeed(person2Planets);

    const aspects = calculateCrossChartAspects(bodiesA, bodiesB, options);

    return aspects.map((a) => ({
      person1_planet: a.body_a,
      person2_planet: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: a.orb.toFixed(2),
      exact_angle: a.separation.toFixed(2),
      applying: a.applying,
      person1_position: {
        longitude: person1Planets[a.body_a].longitude,
        sign: person1Planets[a.body_a].sign,
        degree: person1Planets[a.body_a].degree,
      },
      person2_position: {
        longitude: person2Planets[a.body_b].longitude,
        sign: person2Planets[a.body_b].sign,
        degree: person2Planets[a.body_b].degree,
      },
    }));
  }

  // Cross-chart aspects involving ASPECTABLE_ANGLES (Ascendant/Midheaven/Part of Fortune):
  // person1 planets -> person2 angles, person2 planets -> person1 angles, and angle-to-angle.
  // DSC/IC are excluded here - they mirror ASC/MC, so aspecting them would double-count
  // every axis contact under two labels. They remain available as computed chart points.
  calculateSynastryAngleAspects(person1Chart, person2Chart, options = {}) {
    const toBodies = (chart, names) => names
      .map((name) => toAspectBody(chart, name))
      .filter(Boolean);

    const requestedBodies = this.resolveSynastryBodies(options.bodies);

    const toPlanetBodies = (chart) => toBodies(chart, requestedBodies);
    const toAngleBodies = (chart) => toBodies(chart, ASPECTABLE_ANGLES);

    const person1Planets = toPlanetBodies(person1Chart);
    const person2Planets = toPlanetBodies(person2Chart);
    const person1Angles = toAngleBodies(person1Chart);
    const person2Angles = toAngleBodies(person2Chart);

    const crossed = [
      ...calculateCrossChartAspects(person1Planets, person2Angles, options),
      ...calculateCrossChartAspects(person1Angles, person2Planets, options),
      ...calculateCrossChartAspects(person1Angles, person2Angles, options),
    ];

    crossed.sort((a, b) => a.orb - b.orb);

    return crossed.map((a) => ({
      person1_point: a.body_a,
      person2_point: a.body_b,
      aspect: a.aspect,
      category: a.category,
      orb: a.orb.toFixed(2),
      exact_angle: a.separation.toFixed(2),
      applying: a.applying,
      person1_position: toPointPosition(person1Chart, a.body_a),
      person2_position: toPointPosition(person2Chart, a.body_b),
    }));
  }

  async handleToolCall(name, args) {
    switch (name) {
      case 'calculate_planetary_positions':
        const { datetime, latitude, longitude, house_system } = args;

        if (!datetime || typeof datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'datetime parameter is required and must be a string'
          );
        }
        
        if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'latitude must be a number between -90 and 90'
          );
        }
        
        if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'longitude must be a number between -180 and 180'
          );
        }

        return this.calculateEphemeris(datetime, latitude, longitude, validateHouseSystem(house_system));

      case 'calculate_transits':
        const {
          birth_datetime,
          latitude: birth_latitude,
          longitude: birth_longitude,
          house_system: transit_house_system,
          include_minor: transit_include_minor,
          include_angles: transit_include_angles,
          include_south_node: transit_include_south_node,
          bodies: transit_bodies,
          orb_overrides: transit_orb_overrides,
          orb_model: transit_orb_model,
        } = args;

        if (!birth_datetime || typeof birth_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_datetime parameter is required and must be a string'
          );
        }

        if (typeof birth_latitude !== 'number' || birth_latitude < -90 || birth_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_latitude must be a number between -90 and 90'
          );
        }

        if (typeof birth_longitude !== 'number' || birth_longitude < -180 || birth_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_longitude must be a number between -180 and 180'
          );
        }

        if (transit_include_minor !== undefined && typeof transit_include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (transit_include_angles !== undefined && typeof transit_include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (transit_include_south_node !== undefined && typeof transit_include_south_node !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_south_node must be a boolean');
        }

        if (transit_bodies !== undefined && (!Array.isArray(transit_bodies) || !transit_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (transit_orb_overrides !== undefined && (typeof transit_orb_overrides !== 'object' || transit_orb_overrides === null || Array.isArray(transit_orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        validateOrbModel(transit_orb_model);

        const validatedTransitHouseSystem = validateHouseSystem(transit_house_system);

        // Calculate birth chart
        const natalChart = this.calculateEphemeris(birth_datetime, birth_latitude, birth_longitude, validatedTransitHouseSystem);

         // Calculate current transits
         const currentDate = new Date();
         const currentISOString = currentDate.toISOString();
         const currentEphemeris = this.calculateEphemeris(currentISOString, birth_latitude, birth_longitude, validatedTransitHouseSystem);

         const { aspects: transitAspects, settings_used: transitSettingsUsed } = this.calculateTransitAspects(natalChart, currentEphemeris, {
           includeMinor: transit_include_minor,
           includeAngles: transit_include_angles,
           includeSouthNode: transit_include_south_node,
           bodies: transit_bodies,
           orbOverrides: transit_orb_overrides,
           orbModel: transit_orb_model,
         });

         return {
           natal_chart: natalChart,
           current_transits: currentEphemeris,
           transit_aspects: transitAspects,
           settings_used: transitSettingsUsed,
           calculation_time: currentISOString
         };

      case 'calculate_solar_revolution':
        const { birth_datetime: sr_birth_datetime, birth_latitude: sr_birth_latitude, birth_longitude: sr_birth_longitude, return_year, return_latitude, return_longitude, house_system: sr_house_system } = args;

        if (!sr_birth_datetime || typeof sr_birth_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_datetime parameter is required and must be a string'
          );
        }

        if (typeof sr_birth_latitude !== 'number' || sr_birth_latitude < -90 || sr_birth_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_latitude must be a number between -90 and 90'
          );
        }

        if (typeof sr_birth_longitude !== 'number' || sr_birth_longitude < -180 || sr_birth_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'birth_longitude must be a number between -180 and 180'
          );
        }

        if (typeof return_year !== 'number' || return_year < 1900 || return_year > 2100) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'return_year must be a number between 1900 and 2100'
          );
        }

        const validatedSrHouseSystem = validateHouseSystem(sr_house_system);

        // Calculate birth chart to get natal Sun position
        const srNatalChart = this.calculateEphemeris(sr_birth_datetime, sr_birth_latitude, sr_birth_longitude, validatedSrHouseSystem);
        const natalSunLongitude = srNatalChart.planets.Sun.longitude;

        // Calculate solar return chart for the given year
        // Use the birthday in the return year as a starting point
        const birthDate = new Date(sr_birth_datetime);
        const returnDate = new Date(return_year, birthDate.getMonth(), birthDate.getDate(), birthDate.getHours(), birthDate.getMinutes(), birthDate.getSeconds());

        // Use return location if provided, otherwise use birth location
        const returnLat = return_latitude !== undefined ? return_latitude : sr_birth_latitude;
        const returnLon = return_longitude !== undefined ? return_longitude : sr_birth_longitude;

        // Calculate the solar return chart at the approximate return date
        const solarReturnChart = this.calculateEphemeris(returnDate.toISOString(), returnLat, returnLon, validatedSrHouseSystem);

        return {
          natal_chart: srNatalChart,
          solar_return_chart: {
            planets: solarReturnChart.planets,
            houses: solarReturnChart.houses,
            chart_points: solarReturnChart.chart_points,
            additional_points: solarReturnChart.additional_points,
            datetime: returnDate.toISOString(),
            coordinates: {
              latitude: returnLat,
              longitude: returnLon
            },
            house_system: validatedSrHouseSystem
          },
          natal_sun_longitude: natalSunLongitude,
          return_sun_longitude: solarReturnChart.planets.Sun.longitude,
          calculation_time: new Date().toISOString()
        };

      case 'calculate_synastry':
        const { person1_datetime, person1_latitude, person1_longitude, person2_datetime, person2_latitude, person2_longitude, include_minor: synastry_include_minor, include_angles: synastry_include_angles, bodies: synastry_bodies, orb_overrides: synastry_orb_overrides, orb_model: synastry_orb_model, person1_house_system, person2_house_system } = args;

        if (synastry_include_minor !== undefined && typeof synastry_include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (synastry_include_angles !== undefined && typeof synastry_include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (synastry_bodies !== undefined && (!Array.isArray(synastry_bodies) || !synastry_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (synastry_orb_overrides !== undefined && (typeof synastry_orb_overrides !== 'object' || synastry_orb_overrides === null || Array.isArray(synastry_orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        if (synastry_orb_overrides !== undefined) {
          const invalidSynastryOrbKeys = invalidOrbOverrideKeys(synastry_orb_overrides, synastry_orb_model);
          if (invalidSynastryOrbKeys.length) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown aspect in orb_overrides: ${invalidSynastryOrbKeys[0]}`);
          }
        }

        validateOrbModel(synastry_orb_model);

        if (!person1_datetime || typeof person1_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person1_datetime parameter is required and must be a string'
          );
        }

        if (typeof person1_latitude !== 'number' || person1_latitude < -90 || person1_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person1_latitude must be a number between -90 and 90'
          );
        }

        if (typeof person1_longitude !== 'number' || person1_longitude < -180 || person1_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person1_longitude must be a number between -180 and 180'
          );
        }

        if (!person2_datetime || typeof person2_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person2_datetime parameter is required and must be a string'
          );
        }

        if (typeof person2_latitude !== 'number' || person2_latitude < -90 || person2_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person2_latitude must be a number between -90 and 90'
          );
        }

        if (typeof person2_longitude !== 'number' || person2_longitude < -180 || person2_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'person2_longitude must be a number between -180 and 180'
          );
        }

        // Calculate person 1's natal chart
        const person1NatalChart = this.calculateEphemeris(person1_datetime, person1_latitude, person1_longitude, validateHouseSystem(person1_house_system, 'person1_house_system'));

        // Calculate person 2's natal chart
        const person2NatalChart = this.calculateEphemeris(person2_datetime, person2_latitude, person2_longitude, validateHouseSystem(person2_house_system, 'person2_house_system'));

        // Calculate aspects between the two charts
        const aspects = this.calculateSynastryAspects(person1NatalChart.planets, person2NatalChart.planets, {
          includeMinor: synastry_include_minor,
          bodies: synastry_bodies,
          orbOverrides: synastry_orb_overrides,
          orbModel: synastry_orb_model,
        });

        // House overlay: which of the other person's houses each planet/angle falls into
        const person1PlanetBodies = SYNASTRY_OVERLAY_BODIES
          .filter((n) => resolveChartPoint(person1NatalChart, n))
          .map((n) => ({ name: n, longitude: resolveChartPoint(person1NatalChart, n).longitude }));
        const person2PlanetBodies = SYNASTRY_OVERLAY_BODIES
          .filter((n) => resolveChartPoint(person2NatalChart, n))
          .map((n) => ({ name: n, longitude: resolveChartPoint(person2NatalChart, n).longitude }));

        const houseOverlay = {
          person1_planets_in_person2_houses: calculateHouseOverlay(person1PlanetBodies, person2NatalChart.houses),
          person2_planets_in_person1_houses: calculateHouseOverlay(person2PlanetBodies, person1NatalChart.houses),
        };

        // Optional angle aspects: planet-to-angle and angle-to-angle contacts across the two charts
        let angleAspects;
        if (synastry_include_angles) {
          angleAspects = this.calculateSynastryAngleAspects(person1NatalChart, person2NatalChart, {
            includeMinor: synastry_include_minor,
            bodies: synastry_bodies,
            orbOverrides: synastry_orb_overrides,
            orbModel: synastry_orb_model,
          });
        }

        return {
          person1_chart: person1NatalChart,
          person2_chart: person2NatalChart,
          synastry_aspects: aspects,
          house_overlay: houseOverlay,
          ...(synastry_include_angles ? { angle_aspects: angleAspects } : {}),
          calculation_time: new Date().toISOString()
        };

      case 'calculate_aspects':
        const {
          datetime: aspects_datetime,
          latitude: aspects_latitude,
          longitude: aspects_longitude,
          include_minor,
          include_angles,
          include_south_node,
          bodies: aspects_bodies,
          orb_overrides,
          orb_model,
          house_system: aspects_house_system,
        } = args;

        if (!aspects_datetime || typeof aspects_datetime !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'datetime parameter is required and must be a string'
          );
        }

        if (typeof aspects_latitude !== 'number' || aspects_latitude < -90 || aspects_latitude > 90) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'latitude must be a number between -90 and 90'
          );
        }

        if (typeof aspects_longitude !== 'number' || aspects_longitude < -180 || aspects_longitude > 180) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'longitude must be a number between -180 and 180'
          );
        }

        if (include_minor !== undefined && typeof include_minor !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_minor must be a boolean');
        }

        if (include_angles !== undefined && typeof include_angles !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_angles must be a boolean');
        }

        if (include_south_node !== undefined && typeof include_south_node !== 'boolean') {
          throw new McpError(ErrorCode.InvalidParams, 'include_south_node must be a boolean');
        }

        if (aspects_bodies !== undefined && (!Array.isArray(aspects_bodies) || !aspects_bodies.every((b) => typeof b === 'string'))) {
          throw new McpError(ErrorCode.InvalidParams, 'bodies must be an array of strings');
        }

        if (orb_overrides !== undefined && (typeof orb_overrides !== 'object' || orb_overrides === null || Array.isArray(orb_overrides))) {
          throw new McpError(ErrorCode.InvalidParams, 'orb_overrides must be an object');
        }

        validateOrbModel(orb_model);

        const aspectsEphemerisResult = this.calculateEphemeris(aspects_datetime, aspects_latitude, aspects_longitude, validateHouseSystem(aspects_house_system));
        const { aspects: chartAspects, settings_used } = this.calculateChartAspects(aspectsEphemerisResult, {
          includeMinor: include_minor,
          includeAngles: include_angles,
          includeSouthNode: include_south_node,
          bodies: aspects_bodies,
          orbOverrides: orb_overrides,
          orbModel: orb_model,
        });

        return {
          ...aspectsEphemerisResult,
          aspects: chartAspects,
          settings_used,
        };

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  }

  async run() {
    // Check if we should run as HTTP server (for ngrok) or stdio
    const useHttp = process.env.MCP_HTTP_MODE === 'true';
    
    if (useHttp) {
      // HTTP mode for ngrok
      const port = process.env.PORT || 8000;

      console.log('Starting HTTP server for ngrok...');
      console.log(`Port: ${port}`);

      const app = express();
      app.use(express.json());

      // Map to store transports by session ID
      const transports = {};

      // SSE endpoint for Claude MCP Connector
      app.all('/mcp', async (req, res) => {
        try {
          console.log(`Received ${req.method} MCP request from Claude via ngrok`);
          
          // Check for existing session ID
          const sessionId = req.headers['mcp-session-id'];
          let transport;

          if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
          } else if (!sessionId && this.isInitializeRequest(req.body)) {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => Math.random().toString(36).substring(2, 15),
            });

            // Connect to the MCP server
            await this.server.connect(transport);
            
            // Handle the request first, then store the transport
            await transport.handleRequest(req, res, req.body);
            
            // Store the transport by session ID after handling the request
            if (transport.sessionId) {
              transports[transport.sessionId] = transport;
              console.log(`✅ New session created and stored: ${transport.sessionId}`);
            }
            
            return; // Exit early since we already handled the request
          } else {
            // Invalid request
            return res.status(400).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
              },
              id: null,
            });
          }

          // Handle the request using the transport (for existing sessions)
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error('Error handling MCP request:', error);
          if (!res.headersSent) {
            res.status(500).json({ 
              error: 'Internal server error', 
              details: error.message 
            });
          }
        }
      });

      // Health check endpoint
      app.get('/health', (req, res) => {
        res.json({ 
          status: 'ok', 
          server: 'swiss-ephemeris-mcp-server',
          version: '1.0.0',
          transport: 'StreamableHTTP',
          protocol: 'http',
          port: port,
          note: 'Use ngrok for HTTPS tunneling',
          endpoint: '/mcp - StreamableHTTP transport for Claude MCP Connector'
        });
      });

      // Root endpoint with info
      app.get('/', (req, res) => {
        res.json({
          name: 'Swiss Ephemeris MCP Server',
          version: '1.0.0',
          description: 'MCP server for Swiss Ephemeris calculations with HTTP transport for ngrok tunneling',
          protocol: 'http',
          port: port,
          endpoints: {
            mcp: `/mcp - StreamableHTTP transport for Claude MCP Connector`,
            health: `/health - Health check`
          },
          usage: 'Use ngrok to create HTTPS tunnel, then connect Claude to the ngrok URL + /mcp',
          note: 'Start with: ngrok http ' + port
        });
      });

      app.listen(port, () => {
        console.log(`\n✅ HTTP server listening on port ${port}`);
        console.log(`🚇 Ready for ngrok tunneling`);
        console.log(`💡 Start ngrok with: ngrok http ${port}`);
        console.log(`MCP endpoint: http://localhost:${port}/mcp`);
        console.log(`Health check: http://localhost:${port}/health`);
        console.log('\nReady for Claude MCP Connector integration via ngrok\n');
      });
    } else {
      // Stdio mode (default) - for Claude Desktop
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Swiss Ephemeris MCP server running on stdio');
    }
  }

  // Helper method to check if request is an initialize request
  isInitializeRequest(body) {
    if (Array.isArray(body)) {
      return body.some(request => request.method === 'initialize');
    }
    return body && body.method === 'initialize';
  }
}

export { SwissEphemerisServer };

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new SwissEphemerisServer();
  server.run().catch(console.error);
}
