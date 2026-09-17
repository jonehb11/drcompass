// What the EXPORTED artifacts are allowed to say — server/lib/xlsx-gen.js.
//
//   node --test test/
//
// Four defects this file pins, all of them found in a workbook that had already
// been signed off, and all of them the same shape: the export path knowing less
// than the app does.
//
//   1. the cutover gate (web/js/cutover.js) was never read by the workbook, so
//      an L7 traffic step with no verification gate above it rendered as an
//      ordinary row — while the .txt export of the same runbook said
//      "BLOCKED — DO NOT RUN";
//   2. `services[].objectives` (the block carrying `approved` and the BIA that
//      set it) was read nowhere, so a scoped package quoted the workspace's
//      numbers — 30 minutes of tolerated data loss where the signed BIA says
//      15 — and a lab package was judged against production's commitment;
//   3. a scoped package could report "Open gap items 0" while a blocker was
//      open in the workspace;
//   4. a test record whose `findings` arrived as a STRING 500'd all three
//      exports.
//
// Plus the rule measured.js added afterwards: a number that was inside target
// on a stale run, or on a run that only reached the bar by hand, is not a
// present-tense capability and must not print as RECOVERABLE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each case gets a throwaway DRCOMPASS_HOME seeded with the example workspace —
// the same fixture every one of these artifacts is demonstrated on.
async function withSeed(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-xlsxhonesty-'));
  const prev = process.env.DRCOMPASS_HOME;
  process.env.DRCOMPASS_HOME = home;
  try {
    const store = await import('../server/store.js');
    store.seedExample();
    const gen = await import('../server/lib/xlsx-gen.js');
    const exportScope = await import('../server/lib/export-scope.js');
    return await fn({ store, gen, exportScope, slug: 'example-acme' });
  } finally {
    if (prev === undefined) delete process.env.DRCOMPASS_HOME;
    else process.env.DRCOMPASS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const trafficStep = {
  layer: 'L7',
  title: 'Shift traffic to us-east-2 (Route 53 DNS flip)',
  gateKind: 'traffic-cutover',
  command: 'aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch file://flip.json',
  owner: 'network',
  estMinutes: 5,
};
const emptyGateStep = {
  layer: 'L6',
  title: 'GATE: functional success bar BEFORE any traffic moves',
  gateKind: 'pre-cutover-verification',
  tests: [],
  owner: 'claims',
};
const fullGateStep = {
  ...emptyGateStep,
  tests: [{
    name: 'Adjudicate a test claim end to end',
    owner: 'Claims on-call',
    expected: 'HTTP 200 with a paid response inside 2s',
    onFail: 'block',
  }],
};
const approvalStep = {
  layer: 'L7',
  title: 'APPROVAL GATE: authorize the live-traffic cutover',
  gateKind: 'cutover-approval',
  owner: 'incident commander',
};

// The runbook-steps dataset is the cheapest honest view of what the Runbooks
// sheet renders: both read the same gateFacts().
async function stepsFor(store, gen, slug, steps) {
  store.saveCollection(slug, 'runbooks', [{
    id: 'rbk_probe', name: 'PROBE', tooling: 'region-switch', steps,
  }]);
  const ds = gen.csvDataset(slug, 'runbook-steps');
  return { headers: ds.headers, rows: ds.rows };
}

test('the workbook sees an ungated live-traffic cutover (the .txt export always did)', async () => {
  await withSeed(async ({ store, gen, slug }) => {
    const { headers, rows } = await stepsFor(store, gen, slug, [emptyGateStep, trafficStep]);
    const gateCol = headers.indexOf('Cutover gate');
    assert.ok(gateCol > 0, 'the dataset gained a cutover-gate column');
    // The twelve legacy columns keep their order and meaning.
    assert.deepEqual(headers.slice(0, 12), ['Runbook', '#', 'Layer', 'Title', 'Detail', 'Command',
      'Verify', 'Pass', 'Owner', 'Est (min)', 'Gate?', 'Record']);
    const traffic = rows.find((r) => String(r[3]).startsWith('Shift traffic'));
    assert.match(String(traffic[gateCol]), /BLOCKED — DO NOT RUN/);
    assert.match(String(traffic[gateCol]), /verification gate above it is empty/);
    const gate = rows.find((r) => String(r[3]).startsWith('GATE:'));
    assert.match(String(gate[gateCol]), /EMPTY GATE/);
  });
});

test('a populated gate lists its checks, with owner, pass criterion and whether it blocks', async () => {
  await withSeed(async ({ store, gen, slug }) => {
    const { headers, rows } = await stepsFor(store, gen, slug, [fullGateStep, approvalStep, trafficStep]);
    const checksCol = headers.indexOf('Gate checks');
    const gate = rows.find((r) => String(r[3]).startsWith('GATE:'));
    const checks = String(gate[checksCol]);
    assert.match(checks, /BLOCKING: Adjudicate a test claim end to end/);
    assert.match(checks, /pass when HTTP 200 with a paid response inside 2s/);
    assert.match(checks, /Claims on-call/);
    // And the traffic step below a real gate is NOT marked blocked.
    const traffic = rows.find((r) => String(r[3]).startsWith('Shift traffic'));
    assert.doesNotMatch(String(traffic[headers.indexOf('Cutover gate')]), /BLOCKED/);
  });
});

test('an approval that comes before the verification gate is named on the traffic step', async () => {
  await withSeed(async ({ store, gen, slug }) => {
    const { headers, rows } = await stepsFor(store, gen, slug, [approvalStep, fullGateStep, trafficStep]);
    const traffic = rows.find((r) => String(r[3]).startsWith('Shift traffic'));
    assert.match(String(traffic[headers.indexOf('Cutover gate')]), /APPROVAL COMES BEFORE THE GATE/);
  });
});

test('a scoped package is judged against the SERVICE objective, not the workspace one', async () => {
  await withSeed(async ({ gen, exportScope, slug }) => {
    const scope = exportScope.resolveExportScope(slug, { envId: 'env_prod', serviceId: 'svc_prod_adjudication' });
    const m = await gen.executiveSummaryModel(slug, scope);
    // The BIA says 60/15, approved. The workspace proposes 60/30, unapproved.
    assert.equal(m.numbers.rpoMinutes, 15);
    assert.equal(m.numbers.rtoMinutes, 60);
    assert.equal(m.numbers.approved, true);
    assert.equal(m.numbers.objective.level, 'service');
    assert.match(m.numbers.objective.why, /BIA 2026-03/);
    // And the disagreement is stated rather than silently resolved.
    assert.ok(m.numbers.objective.conflict, 'the unreconciled workspace target is disclosed');
    assert.match(m.numbers.objective.conflict.text, /RPO 30 vs 15 min/);
    const row = m.numberRows.find((r) => /NOT reconciled/.test(r.name));
    assert.ok(row, 'the one-pager carries a row for it');
  });
});

test('an environment with no objective of its own does not inherit production\'s', async () => {
  await withSeed(async ({ gen, exportScope, slug }) => {
    const scope = exportScope.resolveExportScope(slug, { envId: 'env_dev' });
    const m = await gen.executiveSummaryModel(slug, scope);
    assert.equal(m.numbers.rtoMinutes, null);
    assert.equal(m.numbers.rpoMinutes, null);
    assert.equal(m.numbers.approved, false);
    assert.equal(m.numbers.objective.level, 'none');
    assert.match(m.numbers.objective.why, /has no objective of its own/);
    // No verdict may be reached against a number that was never its commitment.
    assert.equal(m.numbers.meetsRto, null);
  });
});

test('a scoped one-pager prints the environment\'s own region pair and its share of the estate', async () => {
  await withSeed(async ({ gen, exportScope, slug }) => {
    const scope = exportScope.resolveExportScope(slug, { envId: 'env_staging' });
    const m = await gen.executiveSummaryModel(slug, scope);
    const env = m.identityRows.find((r) => r.name === 'Environment');
    assert.equal(env.value, 'Staging');
    // Staging runs us-east-2 → us-east-1: the REVERSE of the workspace default.
    assert.match(env.note, /us-east-2 → us-east-1/);
    const svc = m.identityRows.find((r) => r.name === 'Service');
    assert.doesNotMatch(String(svc.value), /^every service — /);
    assert.match(String(svc.note), /of 51 components/);
  });
});

test('a scoped package cannot report zero gaps without saying what scoping hid', async () => {
  await withSeed(async ({ gen, exportScope, slug }) => {
    const scope = exportScope.resolveExportScope(slug, { envId: 'env_staging' });
    const m = await gen.executiveSummaryModel(slug, scope);
    assert.equal(m.openGapCount, 0, 'the staging slice really does carry no gaps of its own');
    assert.ok(m.scope.hidden.blockerOrHighGaps > 0, 'and the workspace has open blocker/high gaps');
    assert.ok(m.scope.hiddenSentences.length, 'the model carries the disclosure for sheet 1');
    assert.match(m.scope.hiddenSentences.join(' '), /Three secret lists disagree/);
  });
});

test('a tests record whose findings is a STRING does not break the exports', async () => {
  await withSeed(async ({ store, gen, slug }) => {
    const tests = store.getCollection(slug, 'tests');
    store.saveCollection(slug, 'tests', [...tests, {
      id: 'tst_stringy',
      name: 'Applied by the AI path',
      date: '2026-09-15',
      status: 'passed',
      findings: 'All application tests passed.',
      appTests: 'none',
      results: { rtaMinutes: 33, cleanRun: true },
    }]);
    const exec = await gen.executiveSummaryModel(slug);
    assert.equal(typeof exec.numbers, 'object');
    const brief = await gen.failoverBrief(slug);
    assert.equal(typeof brief.numbers, 'object');
    const wb = await gen.buildWorkbook(slug);
    assert.ok(wb.getWorksheet('Executive Summary'), 'the workbook still builds');
    // And the string is not counted as a finding it never was.
    const row = exec.tests.find((t) => t.name === 'Applied by the AI path');
    assert.equal(row.findings, 0);
  });
});

test('a number met on a STALE run is not printed as RECOVERABLE', async () => {
  await withSeed(async ({ store, gen, slug }) => {
    store.saveCollection(slug, 'tests', [{
      id: 'tst_old',
      name: 'Full-estate game day',
      date: '2024-01-05',
      status: 'passed',
      type: 'game-day',
      results: { rtaMinutes: 40, rpaMinutes: 10, cleanRun: true },
    }]);
    const m = await gen.executiveSummaryModel(slug);
    assert.equal(m.numbers.rtaState, 'measured');
    assert.equal(m.numbers.meetsRto, true, 'the numbers WERE inside target on the day');
    assert.notEqual(m.verdict.label, 'RECOVERABLE');
    assert.match(m.verdict.label, /NOT PROVEN CURRENT/);
    assert.notEqual(m.verdict.tint, 'ok');
    assert.match(m.verdict.because, /days old/);
  });
});

test('a number met on a run that was NOT clean is not printed as RECOVERABLE', async () => {
  await withSeed(async ({ store, gen, slug }) => {
    const today = new Date().toISOString().slice(0, 10);
    store.saveCollection(slug, 'tests', [{
      id: 'tst_messy',
      name: 'Full-estate game day',
      date: today,
      status: 'passed',
      type: 'game-day',
      results: { rtaMinutes: 40, rpaMinutes: 10, cleanRun: false },
    }]);
    const m = await gen.executiveSummaryModel(slug);
    assert.equal(m.numbers.meetsRto, true);
    assert.notEqual(m.verdict.label, 'RECOVERABLE');
    assert.match(m.verdict.because, /not clean/);
    const rtaRow = m.numberRows.find((r) => r.name.startsWith('RTA'));
    assert.notEqual(rtaRow.tint, 'ok', 'green means a capability today');
  });
});

test('an unscoped export still resolves the WORKSPACE objective, unchanged', async () => {
  await withSeed(async ({ gen, slug }) => {
    const m = await gen.executiveSummaryModel(slug);
    assert.equal(m.numbers.rtoMinutes, 60);
    assert.equal(m.numbers.rpoMinutes, 30);
    assert.equal(m.numbers.objective.level, 'workspace');
    assert.equal(m.numbers.objective.why, 'Business target — NOT approved');
    assert.equal(m.numbers.objective.conflict, null);
    assert.equal(m.scope.hiddenSentences.length, 0, 'nothing is out of frame in a whole-workspace export');
  });
});
