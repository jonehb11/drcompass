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
import { coverageOf as sharedCoverageOf, criticalSet } from '../web/js/coverage.js';

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

// ------------------------------------------- the workspace subject (NEW-2)
//
// The lie-test workspace from docs/DR-VALIDATION-2.md, reduced to its bones:
// one Tier-0 service nobody has tested, one Tier-3 bucket somebody restored.
const wsComponents = [
  { id: 'cmp_tier0', name: 'Payments API', tier: 0, inRecoveryScope: 'yes' },
  { id: 'cmp_logs', name: 'Log archive bucket', tier: 3, inRecoveryScope: 'yes' },
];
const logDrill = {
  id: 'tst_tiny', name: 'S3 log bucket restore drill', status: 'passed', date: '2026-09-10',
  componentIds: ['cmp_logs'], scope: 'Restored one log bucket.',
  results: { rtaMinutes: 5, rpaMinutes: 2, cleanRun: true },
};
const wholeEstate = {
  id: 'tst_all', name: 'Full region evacuation', status: 'passed', date: '2026-09-11',
  results: { rtaMinutes: 44, rpaMinutes: 3, cleanRun: true },
};
const namesBoth = {
  ...logDrill, id: 'tst_both', name: 'Both components', componentIds: ['cmp_logs', 'cmp_tier0'],
};
const wsOpts = { components: wsComponents, now: '2026-09-17' };
const lieWorkspace = {
  name: 'lie-test',
  objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: true },
};

test('a test that names nothing is a whole-estate claim; one that names components is not', () => {
  // named nothing: there is nothing to narrow the claim.
  assert.equal(serverCoverageOf(passedNamingNothing, null, opts), 'direct');
  assert.equal(browserCoversDirectly(passedNamingNothing, null, opts), true);
  assert.equal(serverCoverageOf(wholeEstate, null, wsOpts), 'direct');
  // named ONE Tier-3 component: evidence about that component, not the estate.
  assert.equal(serverCoverageOf(logDrill, null, wsOpts), 'scoped');
  assert.notEqual(serverCoverageOf(logDrill, null, wsOpts), MEASURED_ELIGIBLE);
  // named every in-scope Tier-0 component: the claim is covered.
  assert.equal(serverCoverageOf(namesBoth, null, wsOpts), 'direct');
});

test('with no component list the workspace rule under-claims, never over-claims', () => {
  assert.equal(serverCoverageOf(logDrill, null, {}), 'scoped');
  assert.equal(browserCoversDirectly(logDrill, null, {}), false);
});

test('criticalSet is the most critical tier actually in recovery scope', () => {
  assert.equal(criticalSet(wsComponents).tier, 0);
  assert.deepEqual(criticalSet(wsComponents).ids, ['cmp_tier0']);
  // a Tier-0 component that is explicitly out of scope is not what a recovery
  // claim has to cover; the next tier down is.
  const outOfScope = [{ ...wsComponents[0], inRecoveryScope: 'no' }, wsComponents[1]];
  assert.equal(criticalSet(outOfScope).tier, 3);
  assert.deepEqual(criticalSet(outOfScope).ids, ['cmp_logs']);
  // nothing tiered ⇒ the question cannot be answered from this data.
  assert.equal(criticalSet([{ id: 'x', name: 'x' }]).known, false);
  assert.equal(criticalSet(null).known, false);
});

test('a Tier-3 drill does not measure a workspace whose Tier-0 was never tested', () => {
  const n = measuredNumbers(lieWorkspace, [logDrill], null, wsOpts);
  assert.equal(n.rta.state, 'unmeasured', 'a log-bucket restore is not a workspace RTA');
  assert.equal(n.rpa.state, 'unmeasured');
  assert.equal(n.rta.isAchievement, false);
  assert.equal(n.verdict.overall, 'unknown');
  assert.equal(n.evidence.qualifyingTests, 0);
  // and it says what it DID measure, for whom — the old note claimed the test
  // "recorded no value" when it had recorded 5 and 2 minutes.
  assert.match(n.rta.note, /5 min/);
  assert.match(n.rta.note, /Log archive bucket/);
  assert.doesNotMatch(n.rta.note, /recorded no value/);
  assert.match(n.rta.note, /Payments API/);
  // the untested Tier-0 service is named, machine-readably, for every consumer
  // that has to refuse to go quiet about it.
  assert.equal(n.scope.kind, 'workspace');
  assert.equal(n.scope.criticalTier, 0);
  assert.deepEqual(n.scope.untestedCritical.map((c) => c.id), ['cmp_tier0']);
  assert.equal(n.scope.claimAllowed, false);
  assert.ok(n.warnings.some((w) => /Payments API/.test(w) && /never been/.test(w)));
  // the component the test DID name keeps its number: refusing the workspace
  // claim must not throw away the evidence.
  const logs = measuredNumbers(lieWorkspace, [logDrill], 'cmp_logs', wsOpts);
  assert.equal(logs.rta.state, 'measured');
  assert.equal(logs.rta.minutes, 5);
});

test('workspace-scoped evidence still measures the workspace', () => {
  for (const t of [wholeEstate, namesBoth]) {
    const n = measuredNumbers(lieWorkspace, [t], null, wsOpts);
    assert.equal(n.rta.state, 'measured', `${t.name} should measure the workspace`);
    assert.equal(n.verdict.overall, 'met');
    assert.equal(n.scope.untestedCritical.length, 0, `${t.name} leaves nothing critical untested`);
    assert.ok(n.scope.measuredFor);
  }
});

test('the browser twin refuses the same workspace claim', async () => {
  const web = await import('../web/js/measured.js');
  const brw = web.measuredNumbers(lieWorkspace, [logDrill], null, { components: wsComponents });
  assert.equal(brw.rta.state, 'unmeasured');
  assert.equal(brw.verdict.overall, 'unknown');
  assert.deepEqual(brw.scope.untestedCritical.map((c) => c.id), ['cmp_tier0']);
  assert.match(brw.rta.note, /Log archive bucket/);
  const ok = web.measuredNumbers(lieWorkspace, [namesBoth], null, { components: wsComponents });
  assert.equal(ok.rta.state, 'measured');
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
    // the workspace subject depends on `components`, so the matrix has to
    // include it or the two runtimes could drift again on exactly NEW-2.
    { runbooks, components: wsComponents },
    { components: [{ id: 'cmp_aurora', name: 'Aurora', tier: 0, inRecoveryScope: 'yes' }] },
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

// ------------------------------------- the evidence rule, one file over (NEW-3)
//
// `web/js/coverage.js` argues that a runbook step is authoring metadata, not
// evidence. `server/routes/service.js` used to agree in the comments and
// disagree in the code: `proofState` matched the concatenated text of EVERY
// runbook in the workspace, so a draft attached to nothing, whose single step
// had an empty command, an empty verify and an empty pass, silenced a rule by
// the words in its title. These tests pin the two arguments together.
test('prose in a draft runbook title never counts as evidence', async () => {
  const { buildProof, proofState, RISK_RULE_INTERNALS } = await import('../server/routes/service.js');
  const { QUOTA_RE, IRSA_RE } = RISK_RULE_INTERNALS;
  const draft = {
    id: 'rbk_draft', name: 'notes', status: 'draft',
    steps: [{ id: 's1', title: 'Someday check vcpu quota and the oidc issuer url', command: '', verify: '', pass: '' }],
    rollback: [],
  };
  const linked = { linkedIds: new Set(['cmp_tier0']) };
  const proof = buildProof([draft], [], [{ id: 'cmp_tier0' }], linked);
  assert.equal(proofState(proof, QUOTA_RE), 'claimed', 'a draft may be reported, never believed');
  assert.equal(proofState(proof, IRSA_RE), 'claimed');
  assert.notEqual(proofState(proof, QUOTA_RE), 'verified');

  // the same step, now executable, in a non-draft runbook that names the
  // service: that IS evidence.
  const real = {
    id: 'rbk_real', name: 'Recovery', status: 'approved',
    steps: [{
      id: 's1', title: 'Check vcpu quota in the recovery region',
      componentIds: ['cmp_tier0'],
      command: 'aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A',
      verify: 'compare against full production load', pass: 'headroom >= peak vCPU',
    }],
    rollback: [],
  };
  assert.equal(proofState(buildProof([real], [], [], linked), QUOTA_RE), 'verified');

  // executable, but about a different service: not evidence about this one.
  const elsewhere = { ...real, steps: [{ ...real.steps[0], componentIds: ['cmp_other'] }] };
  assert.equal(proofState(buildProof([elsewhere], [], [], linked), QUOTA_RE), 'claimed');

  // executable and attached, but still a draft: not evidence.
  assert.equal(proofState(buildProof([{ ...real, status: 'draft' }], [], [], linked), QUOTA_RE), 'claimed');
});

test('a checklist item is evidence only when it is ticked AND records a proof', async () => {
  const { buildProof, proofState, RISK_RULE_INTERNALS } = await import('../server/routes/service.js');
  const { QUOTA_RE } = RISK_RULE_INTERNALS;
  const list = (item) => buildProof([], [{ name: 'Phase 0', items: [item] }], [], { linkedIds: new Set(['c1']) });
  const text = 'Recovery-region vcpu quota checked against full production load';
  assert.equal(proofState(list({ text, done: true, proof: 'quota case 12345, 2026-09-12' }), QUOTA_RE), 'verified');
  assert.equal(proofState(list({ text, done: true, proof: '' }), QUOTA_RE), 'claimed');
  assert.equal(proofState(list({ text, done: false, proof: 'x' }), QUOTA_RE), 'listed-not-done');
  assert.equal(proofState(buildProof([], [], [], {}), QUOTA_RE), 'none');
});

test('a component verification command is evidence; a pass condition alone is not', async () => {
  const { buildProof, proofState, RISK_RULE_INTERNALS } = await import('../server/routes/service.js');
  const { KMS_RE } = RISK_RULE_INTERNALS;
  const withCommand = [{ id: 'c1', verification: { command: 'aws kms describe-key --key-id mrk-abc', pass: 'MultiRegion true' } }];
  const passOnly = [{ id: 'c1', verification: { command: '', pass: 'we use a multi-region key' } }];
  assert.equal(proofState(buildProof([], [], withCommand, {}), KMS_RE), 'verified');
  assert.equal(proofState(buildProof([], [], passOnly, {}), KMS_RE), 'claimed');
});

// ------------------------------------------- the return-path vocabulary (NEW-6)
test('a rollback that shifts traffic back is a return path', async () => {
  const { namesReturnPath, RISK_RULE_INTERNALS } = await import('../server/routes/service.js');
  const { TRAFFIC_MOVE_RE, RETURN_TRAFFIC_RE, DATA_PROMOTE_RE, RETURN_DATA_RE } = RISK_RULE_INTERNALS;
  const traffic = (t) => namesReturnPath(t, RETURN_TRAFFIC_RE, TRAFFIC_MOVE_RE);
  const data = (t) => namesReturnPath(t, RETURN_DATA_RE, DATA_PROMOTE_RE);

  // the exact false positive from the validation's only clean workspace.
  assert.ok(traffic('Shift traffic back to us-east-1 \n aws route53 change-resource-record-sets --change-batch file://restore.json \n dig +short notify.example \n resolves to us-east-1 and error rate flat'));
  // every other forward verb the hand-written list had never been told about.
  assert.ok(traffic('Move live traffic back to the primary region'));
  assert.ok(traffic('update-routing-control-state back to the primary region'));
  assert.ok(traffic('Reverse the start-plan-execution and cut over again to us-east-1'));
  assert.ok(traffic('Roll back the DNS weights'));
  assert.ok(traffic('Return traffic to us-east-1'));
  assert.ok(data('failover-global-cluster back to us-east-1'));
  assert.ok(data('Make us-east-1 the writer again'));
  // and it still refuses an end state with no verb, or a forward-only step.
  assert.equal(traffic('Traffic is healthy in us-west-2'), false);
  assert.equal(traffic('Shift traffic to us-west-2 \n change-resource-record-sets'), false);
  assert.equal(data('Promote the us-west-2 cluster to writer'), false);
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
