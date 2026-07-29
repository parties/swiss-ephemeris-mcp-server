// SUP-179/T1: permanent regression coverage comparing orb_model 'class' vs 'moiety' against
// the shared synthetic fixtures. lib/aspects.js exports the natal/cross-chart engines as
// calculateNatalAspects/calculateCrossChartAspects (not calculateAspects/calculateSynastryAspects);
// this test drives those directly with real planetary positions, following the fetch/structure
// pattern in test/calculate-aspects.integration.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import {
  DEFAULT_ASPECT_BODIES,
  ASPECTABLE_ANGLES,
  MOIETIES,
  calculateNatalAspects,
  calculateCrossChartAspects,
  toAspectBody,
} from '../lib/aspects.js';
import { ALL_CHARTS, DAY_CHART, PARTNER_CHART } from './fixtures/charts.js';
import { resolveEphePath, swetestAvailable } from './fixtures/ephe-path.js';

const EPHE_PATH = resolveEphePath();
const HAS_SWETEST = swetestAvailable(EPHE_PATH);

const ALL_BODY_NAMES = [...DEFAULT_ASPECT_BODIES, ...ASPECTABLE_ANGLES];

function bodiesForChart(chart) {
  return ALL_BODY_NAMES.map((name) => toAspectBody(chart, name)).filter(Boolean);
}

// Locked lower bounds, recorded from a live run against each fixture in moiety mode. Catches
// a regression where moiety mode silently drops far fewer aspects than expected.
const MIN_MOIETY_ASPECT_COUNTS = {
  'day chart (Greenwich, noon)': 42,
  'night chart (Greenwich, midnight)': 45,
  'partner chart (New York)': 50,
  'southern hemisphere chart (Sydney)': 50,
};

for (const fixture of ALL_CHARTS) {
  test(`${fixture.label}: class and moiety orb models both produce aspects with no moiety orb inflation`, { skip: !HAS_SWETEST }, () => {
    const server = new SwissEphemerisServer();
    const chart = server.calculateEphemeris(fixture.datetime, fixture.latitude, fixture.longitude);
    const bodies = bodiesForChart(chart);

    const classAspects = calculateNatalAspects(bodies, { includeAngles: true, orbModel: 'class' });
    const moietyAspects = calculateNatalAspects(bodies, { includeAngles: true, orbModel: 'moiety' });

    assert.ok(classAspects.length > 0, `${fixture.label}: class orb model should produce aspects`);
    assert.ok(moietyAspects.length > 0, `${fixture.label}: moiety orb model should produce aspects`);
    assert.ok(
      moietyAspects.length >= MIN_MOIETY_ASPECT_COUNTS[fixture.label],
      `${fixture.label}: expected at least ${MIN_MOIETY_ASPECT_COUNTS[fixture.label]} moiety aspects, got ${moietyAspects.length}`
    );

    for (const aspect of moietyAspects) {
      const maxOrb = MOIETIES[aspect.body_a] + MOIETIES[aspect.body_b];
      assert.ok(
        aspect.orb <= maxOrb,
        `${fixture.label}: ${aspect.body_a}-${aspect.body_b} orb ${aspect.orb} exceeds moiety sum ${maxOrb} (no orb inflation allowed)`
      );
    }
  });
}

test('cross-chart (synastry-shaped) moiety aspects between DAY_CHART and PARTNER_CHART are non-empty and unclamped', { skip: !HAS_SWETEST }, () => {
  const server = new SwissEphemerisServer();
  const dayChart = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude);
  const partnerChart = server.calculateEphemeris(PARTNER_CHART.datetime, PARTNER_CHART.latitude, PARTNER_CHART.longitude);

  const aspects = calculateCrossChartAspects(bodiesForChart(dayChart), bodiesForChart(partnerChart), {
    includeAngles: true,
    orbModel: 'moiety',
  });

  assert.ok(aspects.length > 0, 'DAY_CHART x PARTNER_CHART moiety cross-chart aspects should be non-empty');

  for (const aspect of aspects) {
    const maxOrb = MOIETIES[aspect.body_a] + MOIETIES[aspect.body_b];
    assert.ok(
      aspect.orb <= maxOrb,
      `DAY_CHART x PARTNER_CHART: ${aspect.body_a}-${aspect.body_b} orb ${aspect.orb} exceeds moiety sum ${maxOrb}`
    );
  }
});
