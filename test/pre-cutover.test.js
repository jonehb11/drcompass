// Unit tests for the pre-cutover verification gate.
//
//   node --test test/
//
// Three jobs:
//   1. pin BACKWARD COMPATIBILITY — an app test written before these fields
//      existed is recovery-test-only and never silently becomes a cutover gate;
//   2. pin the ORDERING rule the product will not draft around — an L7 step is
//      blocked unless a POPULATED pre-cutover verification precedes it;
//   3. pin the PASTE PARSER on the shapes people actually paste, including the
//      rule that it never invents a pass criterion.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAppTest, whenOf, onFailOf, buildPreCutoverChecklist, checklistToMarkdown,
  auditCutoverGate, applyGateRequirements, stepTestsFromChecklist, checklistRows,
  GATE_KINDS, DEFAULT_WHEN,
} from '../web/js/cutover.js';
import { parsePastedTests } from '../web/js/cutover-parse.js';

// ---------------------------------------------------------------- fixtures

const components = [
  { id: 'cmp_adj', name: 'adjudication-service', category: 'compute', tier: 0, restoreLayer: 'L4', dependsOn: ['cmp_aurora', 'cmp_secrets'] },
  { id: 'cmp_aurora', name: 'Aurora — adjudication', category: 'database', tier: 0, restoreLayer: 'L3', dependsOn: [] },
  { id: 'cmp_secrets', name: 'Secrets Manager', category: 'security-secrets', tier: 0, restoreLayer: 'L3', dependsOn: [] },
  { id: 'cmp_edge', name: 'API Gateway', category: 'edge-dns', tier: 0, restoreLayer: 'L5', dependsOn: [] },
  { id: 'cmp_other', name: 'unrelated-service', category: 'compute', tier: 2, restoreLayer: 'L4', dependsOn: [] },
];

const legacyTest = {
  id: 'tst_legacy', name: 'Dev recovery test #2', status: 'failed', date: '2026-08-01',
  appTests: [
    { name: 'Claim adjudicates', command: 'curl ...', expected: 'claim_id', componentId: 'cmp_adj', critical: true, result: 'fail' },
    { name: 'Cache warm', componentId: 'cmp_adj', critical: false, result: 'pass' },
  ],
};

const gateTest = {
  id: 'tst_gate', name: 'Cutover checks — adjudication', status: 'planned', date: '2026-09-17',
  componentId: 'cmp_adj',
  appTests: [
    { name: 'Claim adjudicates end to end', expected: 'a real claim_id, not a 500', componentId: 'cmp_adj',
      when: 'pre-cutover', owner: 'app team', onFail: 'block', proves: 'a customer transaction completes' },
    { name: 'Aurora writer is in the recovery region', expected: 'writer endpoint in us-east-2', componentId: 'cmp_aurora',
      when: 'pre-cutover', owner: 'DBA', onFail: 'block' },
    { name: 'Redis warm', componentId: 'cmp_adj', when: 'pre-cutover', owner: 'app team', onFail: 'advise' },
    { name: 'Edge answers on the direct endpoint', expected: 'HTTP 200', componentId: 'cmp_edge',
      when: 'pre-cutover', owner: 'network', onFail: 'block' },
    { name: 'Partner sends a live claim', expected: 'accepted', componentId: 'cmp_adj', when: 'post-cutover', owner: 'partner mgr', onFail: 'block' },
    { name: 'Unrelated check', componentId: 'cmp_other', when: 'pre-cutover', owner: 'someone', onFail: 'block' },
  ],
};

const data = { workspace: { slug: 'ws' }, components, tests: [legacyTest, gateTest], services: [] };

// -------------------------------------------------- 1. backward compatibility

test('an app test with no `when` is recovery-test-only and is never a gate', () => {
  const a = normalizeAppTest(legacyTest.appTests[0]);
  assert.equal(a.when, DEFAULT_WHEN);
  assert.equal(whenOf({}), 'recovery-test-only');
  // The fields that already existed survive untouched.
  assert.equal(a.name, 'Claim adjudicates');
  assert.equal(a.command, 'curl ...');
  assert.equal(a.expected, 'claim_id');
  assert.equal(a.componentId, 'cmp_adj');
  assert.equal(a.critical, true);
  assert.equal(a.result, 'fail');
});

test('a legacy workspace produces an EMPTY gate, not a fabricated one', () => {
  const c = buildPreCutoverChecklist({ ...data, tests: [legacyTest] }, {});
  assert.equal(c.counts.total, 0);
  assert.equal(c.counts.unclassified, 2);
  assert.match(c.warnings.join(' '), /unclassified/);
});

test('onFail falls back to the legacy critical flag, and explicit wins', () => {
  assert.equal(onFailOf({ critical: true }), 'block');
  assert.equal(onFailOf({ critical: false }), 'advise');
  assert.equal(onFailOf({ critical: true, onFail: 'advise' }), 'advise');
});

// --------------------------------------------------------- 2. the checklist

test('the checklist is ordered by phase, blocking first, and grouped by owner', () => {
  const c = buildPreCutoverChecklist(data, { when: 'pre-cutover' });
  assert.equal(c.counts.total, 5); // 4 in-scope + the unrelated one (workspace scope)
  assert.equal(c.counts.blocking, 4);
  assert.equal(c.counts.advisory, 1);
  // data (L3) before apps (L4) before edge (L5)
  assert.equal(c.items[0].name, 'Aurora writer is in the recovery region');
  assert.equal(c.items[0].phase, 'data');
  assert.equal(c.items[c.items.length - 1].phase, 'edge');
  // Inside a phase, blocking outranks advisory.
  const appPhase = c.items.filter((i) => i.phase === 'apps');
  assert.equal(appPhase[appPhase.length - 1].name, 'Redis warm');
  // Groups are per owner.
  assert.deepEqual(c.groups.map((g) => g.owner).sort(), ['DBA', 'app team', 'network', 'someone'].sort());
  // post-cutover checks are not in the pre-cutover gate.
  assert.ok(!c.items.some((i) => i.name === 'Partner sends a live claim'));
});

test('scoping to a component takes its dependency closure and nothing else', () => {
  const c = buildPreCutoverChecklist(data, { componentId: 'cmp_adj' });
  const names = c.items.map((i) => i.name);
  assert.ok(names.includes('Claim adjudicates end to end'));
  assert.ok(names.includes('Aurora writer is in the recovery region')); // a dependency
  assert.ok(!names.includes('Unrelated check'));                        // not in the closure
  assert.ok(!names.includes('Edge answers on the direct endpoint'));    // not in the closure
  assert.equal(c.scope.kind, 'component');
  assert.equal(c.scope.componentName, 'adjudication-service');
});

test('a blocking check with no pass criterion is reported, never invented', () => {
  const c = buildPreCutoverChecklist({
    ...data,
    tests: [{ id: 't', name: 't', status: 'planned', appTests: [{ name: 'X', when: 'pre-cutover', onFail: 'block' }] }],
  }, {});
  assert.equal(c.items[0].expected, '');
  assert.match(c.warnings.join(' '), /no pass criterion/);
});

test('"proven" needs a passing result inside a PASSED test record', () => {
  const passing = {
    id: 'tst_p', name: 'Recovery test', status: 'passed', date: '2026-09-10',
    appTests: [{ name: 'Claim adjudicates end to end', componentId: 'cmp_adj', when: 'pre-cutover', onFail: 'block', expected: 'x', result: 'pass' }],
  };
  const failing = { ...passing, id: 'tst_f', status: 'failed', date: '2026-09-11' };
  assert.equal(buildPreCutoverChecklist({ ...data, tests: [passing] }, {}).items[0].proven, true);
  assert.equal(buildPreCutoverChecklist({ ...data, tests: [failing] }, {}).items[0].proven, false);
});

test('the markdown artifact groups by owner and states the gate', () => {
  const md = checklistToMarkdown(buildPreCutoverChecklist(data, {}));
  assert.match(md, /## DBA/);
  assert.match(md, /BLOCKING/);
  assert.match(md, /Only then: run the L7 traffic block/);
});

test('checklistRows gives the exporters a flat, stable row per check', () => {
  const rows = checklistRows(buildPreCutoverChecklist(data, {}));
  assert.equal(rows.length, 5);
  assert.deepEqual(Object.keys(rows[0]).slice(0, 5), ['order', 'phase', 'phaseLabel', 'check', 'proves']);
  assert.equal(rows[0].blocking, 'BLOCKING');
});

// ------------------------------------------------------ 3. the runbook gate

const trafficStep = { id: 's3', layer: 'L7', title: 'Block: live-traffic cutover', gateKind: GATE_KINDS.traffic };
const approvalStep = { id: 's2', layer: 'L7', title: 'APPROVAL GATE: authorize the live-traffic cutover', gateKind: GATE_KINDS.approval };

test('an L7 traffic step with no verification gate above it is BLOCKED', () => {
  const a = auditCutoverGate({ steps: [approvalStep, trafficStep] });
  assert.equal(a.ok, false);
  assert.deepEqual(a.blockedIndexes, [1]);
  assert.match(a.findings.map((f) => f.kind).join(','), /traffic-before-verification/);
});

test('an EMPTY verification gate does not unblock the L7 step', () => {
  const a = auditCutoverGate({
    steps: [{ id: 's1', layer: 'L6', title: 'GATE: success bar', gateKind: GATE_KINDS.verification, tests: [] }, approvalStep, trafficStep],
  });
  assert.equal(a.ok, false);
  assert.ok(a.findings.some((f) => f.kind === 'empty-gate'));
  assert.deepEqual(a.blockedIndexes, [2]);
});

test('a POPULATED gate followed by an approval unblocks the L7 step', () => {
  const tests = stepTestsFromChecklist(buildPreCutoverChecklist(data, { componentId: 'cmp_adj' }));
  const rb = {
    steps: [
      { id: 's1', layer: 'L6', title: 'GATE: pre-cutover verification', gateKind: GATE_KINDS.verification, tests },
      approvalStep, trafficStep,
    ],
  };
  const a = auditCutoverGate(rb);
  assert.equal(a.ok, true, a.findings.map((f) => f.text).join(' | '));
  assert.deepEqual(a.blockedIndexes, []);
  // The dependency is written onto the step, so it survives export.
  applyGateRequirements(rb);
  assert.deepEqual(rb.steps[2].requires.sort(), [GATE_KINDS.approval, GATE_KINDS.verification].sort());
});

test('an approval placed BEFORE the verification is flagged', () => {
  const a = auditCutoverGate({
    steps: [
      approvalStep,
      { id: 's1', layer: 'L6', title: 'GATE', gateKind: GATE_KINDS.verification, tests: [{ name: 'x', expected: 'y', onFail: 'block' }] },
      trafficStep,
    ],
  });
  assert.ok(a.findings.some((f) => f.kind === 'approval-before-verification'));
});

test('an L7 step that does not move traffic is not treated as a cutover', () => {
  const a = auditCutoverGate({ steps: [{ id: 'x', layer: 'L7', title: 'Communications: stakeholders and partners' }] });
  assert.equal(a.trafficSteps.length, 0);
});

// --------------------------------------------------------- 4. paste parsing

test('parses a markdown checklist with owners and blocking markers', () => {
  const { items, format } = parsePastedTests(`Pre-cutover checks from the walkthrough:
- [ ] Claim adjudicates end to end — expect a real claim_id, not a 500. Owner: app team. BLOCKING
- [ ] Settlement import job runs (owner: batch team) -> new rows in the remittance db, blocking, ~15 min
- [ ] Redis warm — nice to have, advisory`);
  assert.equal(format, 'list');
  assert.equal(items.length, 3);
  assert.equal(items[0].owner, 'app team');
  assert.equal(items[0].onFail, 'block');
  assert.match(items[0].expected, /claim_id/);
  assert.equal(items[1].owner, 'batch team');
  assert.equal(items[1].estMinutes, 15);
  assert.equal(items[2].onFail, 'advise');
  assert.ok(items.every((i) => i.when === 'pre-cutover'));
});

test('a "Post-cutover:" heading switches the timing for the rows under it', () => {
  const { items } = parsePastedTests(`1. Secrets resolve for the app identity: zero errors in secrets-init
2. Images come from the recovery ECR: no us-east-1 image refs
Post-cutover:
3. Partner sends a live claim: real claim id within 5 min`);
  assert.equal(items.length, 3);
  assert.equal(items[0].when, 'pre-cutover');
  assert.equal(items[2].when, 'post-cutover');
  assert.equal(items[2].onFail, 'advise'); // a post-cutover check cannot block a cutover that happened
  assert.match(items[0].expected, /zero errors/);
});

test('parses a pasted table by its headers', () => {
  const { items, format } = parsePastedTests(`Test | Owner | Expected | Blocking
Auth token issues | identity | token accepted by a protected endpoint | yes
Queue drains | platform | test message consumed under 60s | no`);
  assert.equal(format, 'table');
  assert.equal(items.length, 2);
  assert.equal(items[0].owner, 'identity');
  assert.equal(items[0].onFail, 'block');
  assert.equal(items[1].onFail, 'advise');
  assert.match(items[1].expected, /60s/);
});

test('parses Test:/Owner:/Expected: blocks', () => {
  const { items, format } = parsePastedTests(`Test: Aurora writer is in us-east-2
Owner: DBA
Proves: the write path survived the switchover
Expected: the writer endpoint resolves to the recovery region
Blocking: yes

Test: Dashboards populated
Owner: SRE
Blocking: no`);
  assert.equal(format, 'blocks');
  assert.equal(items.length, 2);
  assert.equal(items[0].owner, 'DBA');
  assert.match(items[0].proves, /write path/);
  assert.equal(items[1].onFail, 'advise');
  assert.equal(items[1].expected, ''); // nothing was invented
});

test('the parser never invents a pass criterion and says so', () => {
  const { items, warnings } = parsePastedTests('- [ ] Check the thing');
  assert.equal(items.length, 1);
  assert.equal(items[0].expected, '');
  assert.match(warnings.join(' '), /no pass criterion/);
});

test('unrecognisable prose yields nothing, with an explanation', () => {
  const res = parsePastedTests('We talked for a while about the recovery and he seemed happy.');
  assert.equal(res.items.length, 0);
  assert.match(res.warnings.join(' '), /Parse with AI|list of checks/);
});
