// WHOSE objective is a number judged against?
//
//   node --test test/
//
// A target is a COMMITMENT, and a commitment belongs to somebody. `services[]`
// carries the objective that has `approved: true` and the BIA that set it;
// `workspace.objectives` carries engineering's proposal. Judging a service
// against the workspace figure is wrong in both directions — it told an auditor
// the tolerated data loss was 30 minutes where the signed BIA says 15, and it
// judged a dev environment against production's approved commitment, which the
// lab was never given.
//
// The export path was fixed in `server/lib/xlsx-gen.js:resolveObjectives`. This
// file pins the three surfaces that were still carrying the workspace-only view,
// and the rules none of them may bend:
//
//   1. `measured.js` accepts the resolved objective (`options.target`) and
//      judges against it — the one comparison, not a second copy in the export
//      path. A scope with NO objective of its own does not inherit one: no
//      target, no verdict.
//   2. `failover-brief.md` §6 prints the same provenance the sheet prints —
//      the BIA, the unreconciled workspace figure, and the caveat on evidence
//      that is stale or came off a run that was not clean.
//   3. `objectiveFor()` (the machine-readable rule) and
//      `xlsx-gen.js:resolveObjectives` (the same rule with the export path's
//      prose) never answer differently. That agreement is what keeps the two
//      from drifting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// A throwaway DRCOMPASS_HOME, written BEFORE server/store.js is imported.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drcompass-objective-test-'));
process.env.DRCOMPASS_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const WS = 'objscope';
const WS_DIR = path.join(HOME, 'workspaces', WS);

// The seed's own shape, reduced to what the objective question needs: a
// workspace proposing 60/30 UNAPPROVED, a Tier-0 service committed to 60/15
// APPROVED by a named BIA, and a dev environment with no objective at all.
const WORKSPACE = {
  slug: WS,
  name: 'Objective Scope Fixture',
  regions: { primary: 'us-east-1', recovery: 'us-east-2' },
  environments: [
    {
      id: 'env_prod', name: 'Production', slug: 'prod', isProduction: true,
      regions: { primary: 'us-east-1', recovery: 'us-east-2' },
    },
    // No `objectives` block: this environment has never been given a target.
    {
      id: 'env_dev', name: 'Dev', slug: 'dev', isProduction: false,
      regions: { primary: 'us-east-1', recovery: 'us-east-2' },
    },
  ],
  objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: false },
  strategy: 'warm-standby',
  tooling: ['region-switch'],
};

const SERVICES = [{
  id: 'svc_adj', name: 'adjudication', slug: 'adjudication', envId: 'env_prod', tier: 0,
  objectives: { rtoMinutes: 60, rpoMinutes: 15, approved: true, source: 'BIA 2026-03' },
  componentIds: ['cmp_adj', 'cmp_db'],
}, {
  // A service with no objective of its own, to prove it inherits none.
  id: 'svc_reporting', name: 'reporting', slug: 'reporting', envId: 'env_prod', tier: 2,
  componentIds: ['cmp_report'],
}];

const COMPONENTS = [
  {
    id: 'cmp_adj', name: 'adjudication-service', envId: 'env_prod', serviceId: 'svc_adj',
    category: 'compute', tier: 0, restoreLayer: 'L5', inRecoveryScope: 'yes', dependsOn: ['cmp_db'],
    verification: { command: 'curl -s /healthz', pass: 'HTTP 200' },
  },
  {
    id: 'cmp_db', name: 'Aurora — adjudication', envId: 'env_prod', serviceId: 'svc_adj',
    category: 'database', tier: 0, restoreLayer: 'L3', inRecoveryScope: 'yes',
    replication: { mechanism: 'aurora-global', rpoMinutes: 1 },
  },
  {
    id: 'cmp_report', name: 'reporting-service', envId: 'env_prod', serviceId: 'svc_reporting',
    category: 'compute', tier: 2, restoreLayer: 'L5', inRecoveryScope: 'yes',
  },
  {
    id: 'cmp_dev_adj', name: 'adjudication-service (dev)', envId: 'env_dev',
    category: 'compute', tier: 2, restoreLayer: 'L5', inRecoveryScope: 'yes',
  },
];

// Evidence that speaks for the whole subject: it names every component in the
// critical set (Tier 0, in recovery scope), which is what coverage.js requires
// before a number may be a workspace-level claim.
const wholeEstateTest = (over, extra = {}) => ({
  id: 'tst_estate',
  name: 'Full-estate game day',
  type: 'game-day',
  status: 'passed',
  date: '2026-09-10',
  componentIds: ['cmp_adj', 'cmp_db'],
  appTests: [
    { name: 'Adjudicate a claim end to end', componentId: 'cmp_adj', critical: true, result: 'pass' },
    { name: 'Writer is promoted and accepting writes', componentId: 'cmp_db', critical: true, result: 'pass' },
  ],
  // 20 min of data loss: INSIDE the workspace's 30-min proposal, OVER the
  // service's approved 15-min commitment. The whole bug in one number.
  results: { rtaMinutes: 40, rpaMinutes: over ? 20 : 10, cleanRun: true },
  ...extra,
});

// The stored fixture carries a PASSED whole-estate run that is 600+ days old and
// was not clean: measured, inside the RTO — and not a capability anybody may
// claim in the present tense. The store is read once per process, so the
// workspace on disk is written before the first route call and not rewritten.
const staleNotCleanRun = {
  ...wholeEstateTest(false),
  date: '2024-01-05',
  results: { rtaMinutes: 40, rpaMinutes: 10, cleanRun: false },
};

function seed(tests = []) {
  fs.mkdirSync(WS_DIR, { recursive: true });
  const files = {
    workspace: WORKSPACE,
    components: { items: COMPONENTS },
    services: { items: SERVICES },
    runbooks: { items: [] },
    tests: { items: tests },
    gaps: { items: [] },
    checklists: { items: [] },
    decisions: { items: [] },
    contacts: { items: [] },
    documents: { items: [] },
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(WS_DIR, `${name}.json`), JSON.stringify(body, null, 2));
  }
}
seed([staleNotCleanRun]);

const { measuredNumbers, objectiveFor } = await import('../server/lib/measured.js');
const { measuredNumbers: browserMeasuredNumbers } = await import('../web/js/measured.js');
const gen = await import('../server/lib/xlsx-gen.js');
const exportScope = await import('../server/lib/export-scope.js');

const opts = { components: COMPONENTS, now: '2026-09-17' };

// Mount the exports router the way the app does, so the markdown under test is
// the file a real download produces.
async function mount(modulePath) {
  const router = (await import(modulePath)).default;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  return {
    text: async (p) => (await fetch(`http://localhost:${port}/api${p}`)).text(),
    close: () => server.close(),
  };
}
// Section 6 of the brief, as the lines a reader sees.
const section6 = (md) => md.split(/^## /m).find((s) => s.startsWith('6 ')) || '';

// ------------------------------------------------------------- 1 · the rule

test('objectiveFor resolves service, then environment, then workspace', () => {
  const svc = objectiveFor({ workspace: WORKSPACE, services: SERVICES, serviceId: 'svc_adj' });
  assert.equal(svc.level, 'service');
  assert.equal(svc.rpoMinutes, 15);
  assert.equal(svc.approved, true);
  assert.equal(svc.source, 'BIA 2026-03');
  assert.equal(svc.owner, 'adjudication service');

  const ws = objectiveFor({ workspace: WORKSPACE, services: SERVICES });
  assert.equal(ws.level, 'workspace');
  assert.equal(ws.rpoMinutes, 30);
  assert.equal(ws.approved, false);
  assert.equal(ws.conflict, null);
});

test('a scope with no objective of its own inherits none — not the workspace\'s', () => {
  for (const sel of [{ envId: 'env_dev' }, { serviceId: 'svc_reporting' }]) {
    const o = objectiveFor({ workspace: WORKSPACE, services: SERVICES, ...sel });
    assert.equal(o.level, 'none', `${JSON.stringify(sel)} must not inherit a target`);
    assert.equal(o.rtoMinutes, null);
    assert.equal(o.rpoMinutes, null);
    assert.equal(o.approved, false);
    assert.equal(o.none, true);
    // The workspace figure is still carried — named as the workspace's.
    assert.equal(o.workspace.rpoMinutes, 30);
  }
});

test('a service/workspace disagreement is reported, never resolved', () => {
  const o = objectiveFor({ workspace: WORKSPACE, services: SERVICES, serviceId: 'svc_adj' });
  assert.ok(o.conflict, 'the unreconciled workspace figure is disclosed');
  assert.equal(o.conflict.rpoMinutes, 30);
  assert.match(o.conflict.summary, /RPO 30 vs 15 min/);
});

// ------------------------------------------- 2 · measured.js takes the target

test('measuredNumbers judges against the scoped target, and says whose it is', () => {
  const tests = [wholeEstateTest(true)];
  const target = objectiveFor({ workspace: WORKSPACE, services: SERVICES, serviceId: 'svc_adj' });

  // Against the WORKSPACE proposal, 20 min of data loss is inside 30.
  const asWorkspace = measuredNumbers(WORKSPACE, tests, null, opts);
  assert.equal(asWorkspace.verdict.rpo, 'met');
  assert.equal(asWorkspace.verdict.overall, 'met');

  // Against the service's approved 15, the same number MISSES — and `overall`
  // and `why` move with it. The export path used to splice a per-metric verdict
  // from the service target onto an `overall`/`why` from the workspace one.
  const scoped = measuredNumbers(WORKSPACE, tests, null, { ...opts, target });
  assert.equal(scoped.target.rpoMinutes, 15);
  assert.equal(scoped.target.approved, true);
  assert.equal(scoped.verdict.rpo, 'missed');
  assert.equal(scoped.verdict.overall, 'missed');
  assert.match(scoped.verdict.why, /data loss MISSED \(20 vs 15 min\)/);
  assert.match(scoped.verdict.why, /adjudication service's objective \(BIA 2026-03\), approved/);
  assert.equal(scoped.rpa.isAchievement, false);
});

test('a target with no numbers reaches NO verdict, and the numbers survive it', () => {
  const tests = [wholeEstateTest(true)];
  const target = objectiveFor({ workspace: WORKSPACE, services: SERVICES, envId: 'env_dev' });
  const n = measuredNumbers(WORKSPACE, tests, null, { ...opts, target });
  assert.equal(n.target.rtoMinutes, null);
  assert.equal(n.target.rpoMinutes, null);
  assert.equal(n.verdict.rto, 'unknown');
  assert.equal(n.verdict.rpo, 'unknown');
  assert.equal(n.verdict.overall, 'unknown');
  assert.equal(n.rta.isAchievement, false, 'nothing may be an achievement against a target that does not exist');
  // The measurement itself is untouched: it WAS measured, by a passed test.
  assert.equal(n.rta.state, 'measured');
  assert.equal(n.rta.minutes, 40);
  assert.ok(n.warnings.some((w) => /Dev environment has no RTO\/RPO of its own/.test(w)));
});

test('the override never moves a claim toward MORE certainty', () => {
  // No passed test at all: an approved service target cannot make a hand-typed
  // number, or a missing one, into evidence.
  const declared = { ...WORKSPACE, objectives: { ...WORKSPACE.objectives, rtaMinutes: 47 } };
  const target = objectiveFor({ workspace: declared, services: SERVICES, serviceId: 'svc_adj' });
  const n = measuredNumbers(declared, [], null, { ...opts, target });
  assert.equal(n.rta.state, 'declared');
  assert.equal(n.rta.isAchievement, false);
  assert.equal(n.verdict.rto, 'unknown');
  // And a FAILED run stays a time to failure.
  const failed = measuredNumbers(declared, [{ ...wholeEstateTest(false), status: 'failed' }], null,
    { ...opts, target });
  assert.equal(failed.rta.state, 'declared');
  assert.equal(failed.rta.isAchievement, false);
});

test('"not approved by the business" stops firing beside an approved service objective', () => {
  const unapproved = measuredNumbers(WORKSPACE, [], null, opts);
  assert.ok(unapproved.warnings.some((w) => /^RTO\/RPO are not approved by the business/.test(w)),
    'the workspace proposal is still called a proposal');
  const target = objectiveFor({ workspace: WORKSPACE, services: SERVICES, serviceId: 'svc_adj' });
  const approved = measuredNumbers(WORKSPACE, [], null, { ...opts, target });
  assert.equal(approved.warnings.filter((w) => /not approved by the business/.test(w)).length, 0,
    'the service objective IS approved — saying otherwise is simply false');
  // And the unreconciled workspace figure is still disclosed.
  assert.ok(approved.warnings.some((w) => /disagrees with adjudication service's \(RPO 30 vs 15 min\)/.test(w)));
});

test('the browser twin answers identically about the same override', () => {
  const tests = [{
    ...wholeEstateTest(true),
    // The browser twin reads the flattened test shape the pages hold.
    rtaMinutes: 40, rpaMinutes: 20, cleanRun: true,
  }];
  const target = objectiveFor({ workspace: WORKSPACE, services: SERVICES, serviceId: 'svc_adj' });
  const srv = measuredNumbers(WORKSPACE, tests, null, { ...opts, target });
  const brw = browserMeasuredNumbers(WORKSPACE, tests, null, { components: COMPONENTS, target });
  assert.equal(brw.target.rpoMinutes, srv.target.rpoMinutes);
  assert.equal(brw.target.approved, srv.target.approved);
  assert.equal(brw.verdict.rpo, srv.verdict.rpo);
  assert.equal(brw.verdict.overall, srv.verdict.overall);
  assert.equal(brw.rpa.isAchievement, srv.rpa.isAchievement);
  const none = objectiveFor({ workspace: WORKSPACE, services: SERVICES, envId: 'env_dev' });
  assert.equal(browserMeasuredNumbers(WORKSPACE, tests, null, { components: COMPONENTS, target: none }).verdict.rpo,
    measuredNumbers(WORKSPACE, tests, null, { ...opts, target: none }).verdict.rpo);
});

// ------------------- 3 · the two implementations of the rule cannot disagree

test('xlsx-gen resolveObjectives and objectiveFor answer the same, case for case', async () => {
  const cases = [
    [{ serviceId: 'svc_adj' }, 'service'],
    [{ envId: 'env_dev' }, 'none'],
    [{}, 'workspace'],
  ];
  for (const [sel, level] of cases) {
    const scope = Object.keys(sel).length ? exportScope.resolveExportScope(WS, sel) : undefined;
    const m = await gen.executiveSummaryModel(WS, scope);
    const shared = objectiveFor({ workspace: WORKSPACE, services: SERVICES, ...sel });
    assert.equal(m.numbers.objective.level, level);
    assert.equal(m.numbers.objective.level, shared.level, `${JSON.stringify(sel)}: level`);
    assert.equal(m.numbers.objective.rtoMinutes, shared.rtoMinutes, `${JSON.stringify(sel)}: RTO`);
    assert.equal(m.numbers.objective.rpoMinutes, shared.rpoMinutes, `${JSON.stringify(sel)}: RPO`);
    assert.equal(m.numbers.objective.approved, shared.approved, `${JSON.stringify(sel)}: approved`);
    assert.equal(m.numbers.objective.source, shared.source, `${JSON.stringify(sel)}: source`);
    assert.equal(!!m.numbers.objective.conflict, !!shared.conflict, `${JSON.stringify(sel)}: conflict`);
    assert.equal(!!m.numbers.objective.none, !!shared.none, `${JSON.stringify(sel)}: none`);
  }
});

// --------------------------------- 4 · the brief markdown says what the sheet says

test('§6 of failover-brief.md names the objective\'s owner and its BIA', async () => {
  const app = await mount('../server/routes/exports.js');
  try {
    const six = section6(await app.text(`/w/${WS}/export/failover-brief.md?serviceId=svc_adj`));
    assert.match(six, /RTO target \| 60 min \| Adjudication service objective · BIA 2026-03 · approved/);
    assert.match(six, /RPO target \| 15 min \| Adjudication service objective · BIA 2026-03 · approved/);
    // The old wording claimed the WORKSPACE had approved it.
    assert.doesNotMatch(six, /\| Approved by the business \|/);
  } finally { app.close(); }
});

test('§6 prints the unreconciled workspace figure instead of dropping it', async () => {
  const app = await mount('../server/routes/exports.js');
  try {
    const six = section6(await app.text(`/w/${WS}/export/failover-brief.md?serviceId=svc_adj`));
    assert.match(six, /These targets are NOT reconciled/);
    assert.match(six, /RPO 30 vs 15 min/);
  } finally { app.close(); }
});

test('§6 of a scope with no objective of its own refuses to borrow one', async () => {
  const app = await mount('../server/routes/exports.js');
  try {
    const six = section6(await app.text(`/w/${WS}/export/failover-brief.md?envId=env_dev`));
    assert.match(six, /Dev environment has no objective of its own/);
    assert.match(six, /that is the WORKSPACE's number, not this scope's/);
    assert.doesNotMatch(six, /NOT yet approved by the business/,
      'the workspace\'s approval state is not this scope\'s problem');
  } finally { app.close(); }
});

test('§6 unscoped is the workspace wording it has always been', async () => {
  const app = await mount('../server/routes/exports.js');
  try {
    const six = section6(await app.text(`/w/${WS}/export/failover-brief.md`));
    assert.match(six, /RTO target \| 60 min \| \*\*NOT yet approved by the business\*\* — a proposal, not a commitment/);
    assert.match(six, /RPO target \| 30 min \| \*\*NOT yet approved by the business\*\* — a proposal, not a commitment/);
    assert.doesNotMatch(six, /NOT reconciled/);
  } finally { app.close(); }
});

test('the sheet and the markdown state the objective in the SAME words', async () => {
  const app = await mount('../server/routes/exports.js');
  try {
    for (const q of ['?serviceId=svc_adj', '?envId=env_dev', '']) {
      const six = section6(await app.text(`/w/${WS}/export/failover-brief.md${q}`));
      const scope = q ? exportScope.resolveExportScope(WS, q.includes('svc') ? { serviceId: 'svc_adj' } : { envId: 'env_dev' }) : undefined;
      const model = await gen.failoverBrief(WS, scope);
      const why = model.numbers.objective.why;
      // The sheet prints `objective.why` verbatim beside the target; unscoped it
      // prints the workspace approval sentence, which the markdown also uses.
      if (model.numbers.objective.level === 'workspace') {
        assert.match(six, /NOT yet approved by the business/);
      } else {
        assert.ok(six.includes(why), `${q || 'unscoped'}: the markdown must print the sheet's own sentence:\n${why}`);
      }
      if (model.numbers.objective.conflict) {
        assert.ok(six.includes(model.numbers.objective.conflict.text));
      }
    }
  } finally { app.close(); }
});

test('§6 caveats evidence that is stale or came off a run that was not clean', async () => {
  // The fixture's stored run: passed, 600+ days old, and hand-helped. §6 used to
  // print it as a plain "RTA measured", which is the sentence the sheet has
  // refused to print since measured.js gained `met-with-caveats`.
  const app = await mount('../server/routes/exports.js');
  try {
    const six = section6(await app.text(`/w/${WS}/export/failover-brief.md?serviceId=svc_adj`));
    assert.match(six, /RTA measured \*\*on a past run — not proven current\*\*/);
    assert.match(six, /Not a current capability:/);
    assert.match(six, /days old, past the freshness threshold/);
    assert.match(six, /the run was not clean/);
  } finally { app.close(); }
});
