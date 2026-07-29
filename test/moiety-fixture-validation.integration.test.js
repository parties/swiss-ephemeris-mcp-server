// SUP-179/T1: permanent regression coverage for orb_model 'moiety' against the shared
// synthetic fixtures (not just synthetic in-memory bodies, as in aspects.test.js's SUP-177
// invariant tests). This does not change the default - see docs/SUP-179-moiety-validation.md
// for the class-vs-moiety comparison report and scripts/validate-moiety-orbs.mjs for how it
// was generated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwissEphemerisServer } from '../index.js';
import {
  DEFAULT_ASPECT_BODIES,
  ASPECTABLE_ANGLES,
  MOIETIES,
  ASPECT_MULTIPLIERS,
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

// Independent oracle for orb_allowed, re-derived from the documented formula rather than
// reusing matchAspectsForPair's internals - see MOIETIES/ASPECT_MULTIPLIERS in lib/aspects.js.
function expectedOrbAllowed(aspect) {
  return (MOIETIES[aspect.body_a] + MOIETIES[aspect.body_b]) * ASPECT_MULTIPLIERS[aspect.aspect];
}

function assertSaneMoietyAspects(aspects, label) {
  assert.ok(aspects.length > 0, `${label}: expected at least one aspect under orb_model 'moiety'`);

  for (const aspect of aspects) {
    assert.ok(aspect.orb >= 0, `${label}: ${aspect.body_a}-${aspect.body_b} ${aspect.aspect} orb should be non-negative, got ${aspect.orb}`);
    assert.ok(aspect.orb_allowed >= 0, `${label}: ${aspect.body_a}-${aspect.body_b} ${aspect.aspect} orb_allowed should be non-negative, got ${aspect.orb_allowed}`);
    assert.ok(aspect.orb <= aspect.orb_allowed, `${label}: ${aspect.body_a}-${aspect.body_b} ${aspect.aspect} matched with orb ${aspect.orb} exceeding orb_allowed ${aspect.orb_allowed}`);
    assert.ok(
      Math.abs(aspect.orb_allowed - expectedOrbAllowed(aspect)) < 1e-9,
      `${label}: ${aspect.body_a}-${aspect.body_b} ${aspect.aspect} orb_allowed should equal (moietyA + moietyB) * multiplier`
    );
  }
}

for (const fixture of ALL_CHARTS) {
  test(`moiety engine stays sane on ${fixture.label} (natal)`, { skip: !HAS_SWETEST }, () => {
    const server = new SwissEphemerisServer();
    const chart = server.calculateEphemeris(fixture.datetime, fixture.latitude, fixture.longitude);
    const bodies = bodiesForChart(chart);

    assert.doesNotThrow(() => calculateNatalAspects(bodies, { includeMinor: true, includeAngles: true, orbModel: 'moiety' }));

    const aspects = calculateNatalAspects(bodies, { includeMinor: true, includeAngles: true, orbModel: 'moiety' });
    assertSaneMoietyAspects(aspects, fixture.label);
  });
}

test('moiety engine stays sane on DAY_CHART x PARTNER_CHART (synastry-shaped cross-chart)', { skip: !HAS_SWETEST }, () => {
  const server = new SwissEphemerisServer();
  const dayChart = server.calculateEphemeris(DAY_CHART.datetime, DAY_CHART.latitude, DAY_CHART.longitude);
  const partnerChart = server.calculateEphemeris(PARTNER_CHART.datetime, PARTNER_CHART.latitude, PARTNER_CHART.longitude);
  const dayBodies = bodiesForChart(dayChart);
  const partnerBodies = bodiesForChart(partnerChart);

  assert.doesNotThrow(() => calculateCrossChartAspects(dayBodies, partnerBodies, { includeMinor: true, includeAngles: true, orbModel: 'moiety' }));

  const aspects = calculateCrossChartAspects(dayBodies, partnerBodies, { includeMinor: true, includeAngles: true, orbModel: 'moiety' });
  assertSaneMoietyAspects(aspects, 'DAY_CHART x PARTNER_CHART');
});
