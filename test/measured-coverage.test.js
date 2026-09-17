// Unit tests for the honest-numbers "covers" rule.
//
//   node --test test/
//
// Two jobs:
//   1. pin the SEMANTICS — a runbook step naming a component is not a
//      measurement of it (journey report problem 10);
//   2. pin the AGREEMENT — the server (`server/lib/measured.js`) and the
//      browser (`web/js/measured.js`) must answer identically for every input.
//      Both currently import the one definition in `web/js/coverage.js`, so
//      this suite is the guard that fails the moment anyone re-inlines a second
//      copy of the rule in either file.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverageOf as serverCoverageOf,
  measuredNumbers,
  MEASURED_ELIGIBLE,
  COVERAGE_LEVELS,
} from '../server/lib/measured.js';
import { coversDirectly as browserCoversDirectly } from '../web/js/measured.js';
import { coverageOf as sharedCoverageOf } from '../web/js/coverage.js';

// ---------------------------------------------------------------- fixtures
const runbooks = [{
  id: 'rbk_generated',
  name: 'Deployment order',
  // The shape the deployment-order generator produces: nearly every component
  // tagged onto nearly every step.
  steps: [
    { id: 's1', componentIds: ['cmp_aurora', 'cmp_dlq', 'cmp_s3', 'cmp_secrets'] },
    { id: 's2', componentIds: ['cmp_eks', 'cmp_dlq'] },
  ],
  rollback: [{ id: 'r1', componentIds: ['cmp_alb'] }],
}, {
  id: 'rbk_other', name: 'Unrelated', steps: [{ id: 's9', componentIds: [] }], rollback: [],
}];

const passedNamingAurora = {
  id: 'tst_aurora', name: 'DR test — Aurora only', status: 'passed', date: '2026-09-16',
  runbookId: 'rbk_generated',
  results: { rtaMinutes: 41, rpaMinutes: 3, cleanRun: true },
  appTests: [{ name: 'aurora writes', componentId: 'cmp_aurora', result: 'pass' }],
};
const passedNamingNothing = {
  id: 'tst_broad', name: 'DR test #2', status: 'passed', date: '2026-09-15',
  runbookId: 'rbk_generated',
  results: { rtaMinutes: 94, rpaMinutes: 12, cleanRun: false },
  appTests: [{ name: 'app check', componentId: '', result: 'pass' }],
};
const opts = { runbooks, closureIds: ['cmp_aurora', 'cmp_secrets'] };

// ---------------------------------------------------------------- semantics
test('a test that names the component is direct', () => {
  assert.equal(serverCoverageOf(passedNamingAurora, 'cmp_aurora', opts), 'direct');
  assert.equal(serverCoverageOf({ ...passedNamingNothing, componentIds: ['cmp_dlq'] }, 'cmp_dlq', opts), 'direct');
  assert.equal(serverCoverageOf({ ...passedNamingNothing, componentId: 'cmp_dlq' }, 'cmp_dlq', opts), 'direct');
});

test('a runbook STEP naming the component is runbook-step, never direct', () => {
  // cmp_dlq appears only in the generated runbook's steps.
  assert.equal(serverCoverageOf(passedNamingAurora, 'cmp_dlq', opts), 'runbook-step');
  assert.notEqual(serverCoverageOf(passedNamingAurora, 'cmp_dlq', opts), MEASURED_ELIGIBLE);
  // and so is a component that appears only in the rollback
  assert.equal(serverCoverageOf(passedNamingAurora, 'cmp_alb', opts), 'runbook-step');
});

test('a test that names a neighbour is closure; a bare shared runbook is runbook', () => {
  // no runbook match, no closure match, not named: nothing at all.
  assert.equal(serverCoverageOf(passedNamingAurora, 'cmp_nowhere', { runbooks: [runbooks[1]] }), 'none');
  // named component sits in the subject's closure, so the test is about a neighbour.
  assert.equal(serverCoverageOf(passedNamingAurora, 'cmp_nowhere', { ...opts, runbooks: [runbooks[1]] }), 'closure');
  assert.equal(
    serverCoverageOf({ ...passedNamingAurora, runbookId: 'rbk_other' }, 'cmp_nowhere', { runbooks }),
    'runbook');
  assert.equal(
    serverCoverageOf({ ...passedNamingAurora, runbookId: 'rbk_other' }, 'cmp_neighbour',
      { ...opts, closureIds: ['cmp_aurora'] }),
    'closure');
});

test('the workspace subject is always direct', () => {
  assert.equal(serverCoverageOf(passedNamingNothing, null, opts), 'direct');
  assert.equal(browserCoversDirectly(passedNamingNothing, null, opts), true);
});

test('every answer is one of the declared levels', () => {
  for (const cid of ['cmp_aurora', 'cmp_dlq', 'cmp_alb', 'cmp_nowhere']) {
    assert.ok(COVERAGE_LEVELS.includes(serverCoverageOf(passedNamingAurora, cid, opts)));
  }
});

// ------------------------------------------------------------- the leak itself
test('a passed test naming ONE component does not measure the others', () => {
  const workspace = { name: 'payments-core', objectives: { rtoMinutes: 120, rpoMinutes: 15, approved: true } };
  const tests = [passedNamingAurora, passedNamingNothing];
  const now = '2026-09-17';

  const aurora = measuredNumbers(workspace, tests, 'cmp_aurora', { ...opts, now });
  assert.equal(aurora.rta.state, 'measured');
  assert.equal(aurora.rta.minutes, 41);
  assert.equal(aurora.verdict.overall, 'met');

  for (const cid of ['cmp_dlq', 'cmp_s3', 'cmp_secrets', 'cmp_alb', 'cmp_eks']) {
    const n = measuredNumbers(workspace, tests, cid, { ...opts, now });
    assert.equal(n.rta.state, 'unmeasured', `${cid} must not be measured`);
    assert.equal(n.rpa.state, 'unmeasured', `${cid} must not be measured`);
    assert.notEqual(n.verdict.overall, 'met', `${cid} must not read "met"`);
    assert.equal(n.evidence.qualifyingTests, 0, `${cid} must have no qualifying test`);
  }
});

test('a hand-typed number stays declared, never measured', () => {
  // The shipped seed: objectives.rtaMinutes 47 with only a FAILED test behind it.
  const workspace = { name: 'example-acme', objectives: { rtaMinutes: 47, rtoMinutes: 60, approved: true } };
  const failed = {
    id: 'tst_aug01', name: 'Dev recovery test #2', status: 'failed', date: '2026-08-28',
    runbookId: 'rbk_generated', results: { rtaMinutes: 47 },
    appTests: [{ componentId: 'cmp_aurora', result: 'fail' }],
    findings: [{ severity: 'blocker', title: 'Two secrets missing' }],
  };
  const n = measuredNumbers(workspace, [failed], 'cmp_aurora', { ...opts, now: '2026-09-17' });
  assert.equal(n.rta.state, 'declared');
  assert.equal(n.rta.isAchievement, false);
  assert.equal(n.verdict.rto, 'unknown');
});

// ---------------------------------------------------- server / browser agree
test('server coverageOf and browser coversDirectly never disagree', () => {
  const components = ['cmp_aurora', 'cmp_dlq', 'cmp_s3', 'cmp_secrets', 'cmp_alb', 'cmp_eks', 'cmp_nowhere', null, ''];
  const tests = [
    passedNamingAurora,
    passedNamingNothing,
    { ...passedNamingAurora, componentIds: ['cmp_s3'] },
    { ...passedNamingAurora, componentId: 'cmp_eks' },
    { ...passedNamingAurora, runbookId: 'rbk_other' },
    { ...passedNamingAurora, runbookId: '' },
    { ...passedNamingAurora, appTests: [] },
    { id: 'malformed' },
    {},
  ];
  const optionSets = [
    {},
    { runbooks },
    { runbooks, closureIds: ['cmp_aurora'] },
    { runbooks, closureIds: new Set(['cmp_aurora', 'cmp_secrets']) },
  ];
  let checked = 0;
  for (const t of tests) {
    for (const cid of components) {
      for (const o of optionSets) {
        const server = serverCoverageOf(t, cid, o) === MEASURED_ELIGIBLE;
        const browser = browserCoversDirectly(t, cid, o);
        const shared = sharedCoverageOf(t, cid, o) === MEASURED_ELIGIBLE;
        assert.equal(server, browser,
          `server/browser disagree for ${t.id || '(anon)'} / ${cid} — the two implementations have drifted apart`);
        assert.equal(server, shared, 'the server no longer uses the shared rule');
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `expected a real matrix, checked ${checked}`);
});

test('the browser module still exposes the whole contract shape', () => {
  // A second implementation would most likely reappear here, so assert the
  // browser's own measuredNumbers agrees with the server's about who is
  // measured.
  const workspace = { objectives: { rtoMinutes: 120, rpoMinutes: 15, approved: true } };
  const tests = [passedNamingAurora, passedNamingNothing];
  return import('../web/js/measured.js').then((web) => {
    for (const cid of ['cmp_aurora', 'cmp_dlq', 'cmp_secrets']) {
      const srv = measuredNumbers(workspace, tests, cid, { ...opts, now: '2026-09-17' });
      const brw = web.measuredNumbers(workspace, tests, cid);
      assert.equal(srv.rta.state, brw.rta.state,
        `server says ${srv.rta.state} and the browser says ${brw.rta.state} for ${cid}`);
    }
  });
});
