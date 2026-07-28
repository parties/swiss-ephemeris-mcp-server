#!/usr/bin/env node
// SUP-179/T1: compares orb_model 'class' (current default) vs 'moiety' (candidate default) on
// the shared synthetic fixtures and writes a markdown report for AstrologyAdvisor sign-off.
//
// Usage: node scripts/validate-moiety-orbs.mjs > docs/SUP-179-moiety-validation.md
// Requires swetest on PATH (or SE_EPHE_PATH pointing at vendor/swisseph, the default here).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SwissEphemerisServer } from '../index.js';
import {
  DEFAULT_ASPECT_BODIES,
  ASPECTABLE_ANGLES,
  calculateNatalAspects,
  calculateCrossChartAspects,
  toAspectBody,
} from '../lib/aspects.js';
import { ALL_CHARTS, DAY_CHART, PARTNER_CHART } from '../test/fixtures/charts.js';

if (!process.env.SE_EPHE_PATH) {
  process.env.SE_EPHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../vendor/swisseph');
}

const server = new SwissEphemerisServer();

// Mirrors calculate_aspects' default body set with include_angles/include_minor both on, so
// the comparison exercises the full pair space (planets, nodes, asteroids, ASC/MC/PoF).
const ALL_BODY_NAMES = [...DEFAULT_ASPECT_BODIES, ...ASPECTABLE_ANGLES];

function bodiesForChart(chart) {
  return ALL_BODY_NAMES.map((name) => toAspectBody(chart, name)).filter(Boolean);
}

function aspectKey(a) {
  // body_a/body_b order is stable within one calculateNatalAspects/calculateCrossChartAspects
  // call (pair-generation order), so no need to sort - both class/moiety runs iterate the
  // same body list in the same order.
  return `${a.body_a}|${a.body_b}|${a.aspect}`;
}

// Compares two raw match-object lists (same fixture, same options, differing only in
// orb_model): which pairs+aspect appear only in one side, and for pairs present in both, the
// orb_allowed delta (the measured `orb` itself is orb_model-independent - it's the allowed
// threshold that moves between 'class' and 'moiety').
function compareAspectLists(classAspects, moietyAspects) {
  const classByKey = new Map(classAspects.map((a) => [aspectKey(a), a]));
  const moietyByKey = new Map(moietyAspects.map((a) => [aspectKey(a), a]));

  const addedInMoiety = [...moietyByKey.keys()].filter((k) => !classByKey.has(k)).map((k) => moietyByKey.get(k));
  const droppedInMoiety = [...classByKey.keys()].filter((k) => !moietyByKey.has(k)).map((k) => classByKey.get(k));

  const deltas = [...classByKey.keys()]
    .filter((k) => moietyByKey.has(k))
    .map((k) => {
      const classAspect = classByKey.get(k);
      const moietyAspect = moietyByKey.get(k);
      return {
        body_a: classAspect.body_a,
        body_b: classAspect.body_b,
        aspect: classAspect.aspect,
        orb: classAspect.orb,
        classOrbAllowed: classAspect.orb_allowed,
        moietyOrbAllowed: moietyAspect.orb_allowed,
        delta: moietyAspect.orb_allowed - classAspect.orb_allowed,
      };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return { addedInMoiety, droppedInMoiety, deltas };
}

function fmtAspect(a) {
  return `${a.body_a} ${a.aspect} ${a.body_b} (orb ${a.orb.toFixed(4)}°, allowed ${a.orb_allowed.toFixed(4)}°)`;
}

function fmtDelta(d) {
  const sign = d.delta >= 0 ? '+' : '';
  return `${d.body_a} ${d.aspect} ${d.body_b} (measured orb ${d.orb.toFixed(4)}°): class allowed ${d.classOrbAllowed.toFixed(4)}° -> moiety allowed ${d.moietyOrbAllowed.toFixed(4)}° (${sign}${d.delta.toFixed(4)}°)`;
}

function renderFixtureSection(label, classAspects, moietyAspects) {
  const { addedInMoiety, droppedInMoiety, deltas } = compareAspectLists(classAspects, moietyAspects);
  const lines = [];

  lines.push(`### ${label}`);
  lines.push('');
  lines.push(`- Aspect count: class ${classAspects.length}, moiety ${moietyAspects.length}`);
  lines.push(`- Added in moiety (present only under \`moiety\`): ${addedInMoiety.length}`);
  lines.push(`- Dropped in moiety (present only under \`class\`): ${droppedInMoiety.length}`);
  lines.push('');

  if (addedInMoiety.length) {
    lines.push('**Added in moiety:**');
    lines.push('');
    for (const a of addedInMoiety) lines.push(`- ${fmtAspect(a)}`);
    lines.push('');
  }

  if (droppedInMoiety.length) {
    lines.push('**Dropped in moiety:**');
    lines.push('');
    for (const a of droppedInMoiety) lines.push(`- ${fmtAspect(a)}`);
    lines.push('');
  }

  const topDeltas = deltas.slice(0, 10);
  if (topDeltas.length) {
    lines.push(`**Largest allowed-orb deltas (moiety minus class, top ${topDeltas.length} of ${deltas.length} shared aspects):**`);
    lines.push('');
    for (const d of topDeltas) lines.push(`- ${fmtDelta(d)}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const sections = [];

  for (const fixture of ALL_CHARTS) {
    const chart = server.calculateEphemeris(fixture.datetime, fixture.latitude, fixture.longitude);
    const bodies = bodiesForChart(chart);
    const classAspects = calculateNatalAspects(bodies, { includeMinor: true, includeAngles: true, orbModel: 'class' });
    const moietyAspects = calculateNatalAspects(bodies, { includeMinor: true, includeAngles: true, orbModel: 'moiety' });
    sections.push(renderFixtureSection(`${fixture.label} (natal)`, classAspects, moietyAspects));
  }

  // Synastry-shaped pair: DAY_CHART x PARTNER_CHART, via calculateCrossChartAspects.
  const dayChart = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude);
  const partnerChart = server.calculateEphemeris(PARTNER_CHART.datetime, PARTNER_CHART.latitude, PARTNER_CHART.longitude);
  const dayBodies = bodiesForChart(dayChart);
  const partnerBodies = bodiesForChart(partnerChart);
  const synastryClass = calculateCrossChartAspects(dayBodies, partnerBodies, { includeMinor: true, includeAngles: true, orbModel: 'class' });
  const synastryMoiety = calculateCrossChartAspects(dayBodies, partnerBodies, { includeMinor: true, includeAngles: true, orbModel: 'moiety' });
  sections.push(renderFixtureSection(
    `${DAY_CHART.label} x ${PARTNER_CHART.label} (synastry)`,
    synastryClass,
    synastryMoiety,
  ));

  const report = [
    '# SUP-179: orb_model \'class\' vs \'moiety\' validation report',
    '',
    'Generated by `scripts/validate-moiety-orbs.mjs`. Compares `calculateNatalAspects` /',
    '`calculateCrossChartAspects` output (`lib/aspects.js`) under `orbModel: \'class\'` (current',
    'default) against `orbModel: \'moiety\'` (candidate default) on the shared synthetic',
    'fixtures (`test/fixtures/charts.js`), with `includeMinor: true, includeAngles: true` over',
    'the full default body set plus ASC/MC/Part of Fortune.',
    '',
    'The measured `orb` (how exact an aspect is) does not depend on `orb_model` - only the',
    '*allowed* orb (the threshold a measured orb must fall within to count as an aspect) does.',
    'So "orb delta" below means the allowed-orb delta for aspects present under both models;',
    'aspects that cross the threshold under only one model show up in Added/Dropped instead.',
    '',
    'This is validation only - no production default changed in this task. See SUP-179 /',
    'SUP-204 for the report request and follow-up SUP-179/T2 for the default flip, gated on',
    'AstrologyAdvisor sign-off against this report.',
    '',
    '## Per-fixture comparison',
    '',
    ...sections,
  ].join('\n');

  process.stdout.write(report + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
