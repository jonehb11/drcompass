// Regression tests for the v0.7.0 DR-architect validation findings owned by the
// gates/exports lane:
//
//   HIGH 6   — exported runbooks silently dropped every WARNING-severity gate
//              finding, including approval-before-verification, because both
//              exporters guarded on `audit.ok` (which means "no ERROR-severity
//              finding", not "audited clean").
//   LOW      — rb.rollback was never gate-audited, and the two formats disagreed
//              about it (.md passed audit = null, .txt kept the FORWARD audit in
//              closure, so a rollback step could inherit a forward step's label).
//   MEDIUM 2 — /recommend ignored ?envId= / ?serviceId= entirely.
//   MEDIUM 3 — stale / not-clean evidence still reported isAchievement: true and
//              verdict.overall: 'met' (validation NEW-10).
//
//   node --test test/
//
// The exporters are HTTP handlers, so the two renderers are exercised through
// the router the way a real download does it — nothing here reaches into a
// private function.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// A throwaway DRCOMPASS_HOME, written BEFORE server/store.js is imported. ES
// modules are immutable, so the store cannot be monkeypatched — a real home
// with a fixture workspace in it is both simpler and closer to a real download.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drcompass-gates-test-'));
process.env.DRCOMPASS_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const WS = 'gatefix';
const WS_DIR = path.join(HOME, 'workspaces', WS);
function seed(files) {
  fs.mkdirSync(WS_DIR, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(WS_DIR, `${name}.json`), JSON.stringify(body, null, 2));
  }
}

const { auditCutoverGate } = await import('../web/js/cutover.js');
const { measuredNumbers } = await import('../server/lib/measured.js');
const {
  measuredNumbers: browserMeasuredNumbers, VERDICT_WORD, VERDICT_TONE,
} = await import('../web/js/measured.js');

// --------------------------------------------------------------- the fixtures

// The reproduction from the validation: the named human approval sits at step 1,
// the populated verification gate at step 2, the traffic move at step 3. The
// approval therefore authorises a cutover whose evidence does not exist yet —
// one WARNING, no errors, so `audit.ok` is true.
const approvalBeforeVerification = {
  id: 'rbk_warn_approval',
  name: 'REPRO approval-before-verification',
  steps: [
    { layer: 'L6', title: 'Named human approval — go/no-go', gateKind: 'cutover-approval' },
    {
      layer: 'L6',
      title: 'Pre-cutover verification — success bar',
      gateKind: 'pre-cutover-verification',
      tests: [{ name: 'One real claim adjudicates end to end', onFail: 'block', expected: 'HTTP 200' }],
    },
    { layer: 'L7', title: 'Flip DNS — move live traffic', gateKind: 'traffic-cutover', command: 'flip' },
  ],
  rollback: [
    { layer: 'L7', title: 'Flip DNS back — move live traffic', gateKind: 'traffic-cutover', command: 'unflip' },
  ],
};

// A gate holding ONLY advisory checks: it cannot fail, so the L7 step behind it
// is reachable behind a gate that can never stop it. Also warning-only.
const advisoryOnlyGate = {
  id: 'rbk_warn_advisory',
  name: 'REPRO advisory-only gate',
  steps: [
    {
      layer: 'L6',
      title: 'Pre-cutover verification — success bar',
      gateKind: 'pre-cutover-verification',
      tests: [{ name: 'Dashboard looks healthy', onFail: 'advise', expected: 'green' }],
    },
    { layer: 'L6', title: 'Named human approval — go/no-go', gateKind: 'cutover-approval' },
    { layer: 'L7', title: 'Flip DNS — move live traffic', gateKind: 'traffic-cutover', command: 'flip' },
  ],
};

// An ERROR-severity runbook, to pin that the output the reviewer verified as
// correct is still produced.
const trafficWithNoGate = {
  id: 'rbk_err',
  name: 'REPRO no gate at all',
  steps: [{ layer: 'L7', title: 'Flip DNS — move live traffic', gateKind: 'traffic-cutover', command: 'flip' }],
};

// A gate-clean runbook: nothing must appear for it.
const cleanRunbook = {
  id: 'rbk_clean',
  name: 'REPRO clean',
  steps: [
    {
      layer: 'L6',
      title: 'Pre-cutover verification',
      gateKind: 'pre-cutover-verification',
      tests: [{ name: 'a real claim', onFail: 'block', expected: 'HTTP 200' }],
    },
    { layer: 'L6', title: 'Named human approval — go/no-go', gateKind: 'cutover-approval' },
    { layer: 'L7', title: 'Flip DNS — move live traffic', gateKind: 'traffic-cutover', command: 'flip' },
  ],
};

const RUNBOOKS = [approvalBeforeVerification, advisoryOnlyGate, trafficWithNoGate, cleanRunbook];

// Two components in two environments, one gap-worthy each, for MEDIUM 2.
const COMPONENTS = [
  { id: 'cmp_p', name: 'Prod DB', tier: 0, envId: 'env_prod', serviceId: 'svc_adj', inRecoveryScope: 'no' },
  { id: 'cmp_s', name: 'Staging DB', tier: 0, envId: 'env_stg', serviceId: 'svc_stg', inRecoveryScope: 'no' },
];

seed({
  workspace: {
    slug: WS,
    name: 'Test workspace',
    regions: { primary: 'us-east-1', recovery: 'us-east-2' },
    tooling: [],
    objectives: {},
    environments: [
      { id: 'env_prod', name: 'Prod', slug: 'prod' },
      { id: 'env_stg', name: 'Staging', slug: 'staging' },
    ],
  },
  components: { items: COMPONENTS },
  services: {
    items: [
      { id: 'svc_adj', name: 'adjudication', slug: 'adjudication', envId: 'env_prod', componentIds: ['cmp_p'] },
      { id: 'svc_stg', name: 'adjudication-stg', slug: 'adjudication-stg', envId: 'env_stg', componentIds: ['cmp_s'] },
    ],
  },
  runbooks: { items: RUNBOOKS },
  tests: { items: [] },
  gaps: { items: [] },
  checklists: { items: [] },
});

// Mount a route module the way the app does, with the error shape a thrown
// store.httpError produces.
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
    post: async (p) => {
      const res = await fetch(`http://localhost:${port}/api${p}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return { status: res.status, body: await res.json() };
    },
    close: () => server.close(),
  };
}
const exportApp = () => mount('../server/routes/exports.js');

// ------------------------------------------------- HIGH 6 · the audit itself

test('HIGH 6 · the warning-only runbooks are exactly that: warnings, and audit.ok is TRUE', () => {
  for (const rb of [approvalBeforeVerification, advisoryOnlyGate]) {
    const a = auditCutoverGate(rb);
    assert.equal(a.ok, true, `${rb.name}: audit.ok must still be true — that is the trap`);
    assert.equal(a.findings.filter((f) => f.severity === 'err').length, 0);
    assert.ok(a.findings.some((f) => f.severity === 'warn'), `${rb.name} must carry a warning`);
    assert.deepEqual(a.blockedIndexes, [], 'nothing is BLOCKED in either of these');
  }
  assert.equal(
    auditCutoverGate(approvalBeforeVerification).findings.find((f) => f.severity === 'warn').kind,
    'approval-before-verification',
  );
  assert.equal(
    auditCutoverGate(advisoryOnlyGate).findings.find((f) => f.severity === 'warn').kind,
    'no-blocking-test',
  );
});

// ------------------------------------------------- HIGH 6 · the two exporters

test('HIGH 6 · a warning-only runbook gets a BEFORE YOU RUN THIS block in BOTH formats', async () => {
  const app = await exportApp();
  try {
    for (const rb of [approvalBeforeVerification, advisoryOnlyGate]) {
      const md = await app.text(`/w/${WS}/export/runbook/${rb.id}.md`);
      const txt = await app.text(`/w/${WS}/export/runbook/${rb.id}.txt`);
      assert.match(md, /## Before you run this/, `${rb.name}: the .md dropped the notice`);
      assert.match(txt, /BEFORE YOU RUN THIS/, `${rb.name}: the .txt dropped the notice`);
      // A warning is NOT a BLOCKED, and it says so in both formats.
      assert.match(md, /⚠ \*\*WARNING\*\*/);
      assert.match(txt, /!\s+WARNING —/);
      // ...and the FORWARD path of a warning-only runbook carries no BLOCKED at
      // all. (The rollback path of the first fixture legitimately does — see the
      // LOW tests below — so the forward half is what is asserted here.)
      // The BLOCKED BANNER is what must never appear (the header sentence does
      // say the word, in "Nothing in this runbook is BLOCKED").
      assert.doesNotMatch(md.split('\n## Rollback\n')[0], /⛔ \*\*BLOCKED\*\*/,
        `${rb.name}: a warning must never render as a BLOCKED banner`);
      assert.doesNotMatch(txt.split('\nROLLBACK\n')[0], /\*\*\* BLOCKED/,
        `${rb.name}: a warning must never render as a BLOCKED banner`);
    }
  } finally { app.close(); }
});

test('HIGH 6 · the approval-before-verification finding reaches the traffic step itself', async () => {
  const app = await exportApp();
  try {
    const md = await app.text(`/w/${WS}/export/runbook/${approvalBeforeVerification.id}.md`);
    const step3 = md.split('### Step 3')[1].split('\n## Rollback\n')[0];
    assert.match(step3, /comes BEFORE the verification gate/,
      'the step that moves traffic has to carry the finding, not only the header block');
  } finally { app.close(); }
});

test('HIGH 6 · an L7 step behind an advisory-only gate is told the gate cannot fail', async () => {
  const app = await exportApp();
  try {
    const md = await app.text(`/w/${WS}/export/runbook/${advisoryOnlyGate.id}.md`);
    const step3 = md.split('### Step 3')[1];
    assert.match(step3, /the verification gate this step stands behind is not sound/);
    assert.match(step3, /the gate cannot fail/);
  } finally { app.close(); }
});

test('HIGH 6 · the ERROR-severity rendering is untouched, and a clean runbook still says nothing', async () => {
  const app = await exportApp();
  try {
    const md = await app.text(`/w/${WS}/export/runbook/${trafficWithNoGate.id}.md`);
    const txt = await app.text(`/w/${WS}/export/runbook/${trafficWithNoGate.id}.txt`);
    // Bold for md, `!!` for txt, and the intro sentence, all exactly as before.
    assert.match(md, /The cutover gate in this runbook did not audit clean\./);
    assert.match(md, /^- \*\*step 1 .* moves live traffic, but no pre-cutover verification gate/m);
    assert.match(txt, /^ {2}!! step 1 .* moves live traffic, but no pre-cutover/m);
    assert.match(md, /⛔ \*\*BLOCKED\*\*/);

    const cleanMd = await app.text(`/w/${WS}/export/runbook/${cleanRunbook.id}.md`);
    const cleanTxt = await app.text(`/w/${WS}/export/runbook/${cleanRunbook.id}.txt`);
    assert.doesNotMatch(cleanMd, /Before you run this/);
    assert.doesNotMatch(cleanTxt, /BEFORE YOU RUN THIS/);
    assert.doesNotMatch(cleanMd, /WARNING/);
  } finally { app.close(); }
});

// -------------------------------------------------------------- LOW · rollback

test('LOW · the rollback path is audited, and the .md and the .txt agree about it', async () => {
  const app = await exportApp();
  try {
    const md = await app.text(`/w/${WS}/export/runbook/${approvalBeforeVerification.id}.md`);
    const txt = await app.text(`/w/${WS}/export/runbook/${approvalBeforeVerification.id}.txt`);
    // '## Rollback' is also a substring of '### Rollback 1', so split on the
    // whole heading line.
    const mdRollback = md.split('\n## Rollback\n')[1];
    const txtRollback = txt.split('\nROLLBACK\n')[1];
    // Audited at all: the .md used to pass audit = null and say nothing here.
    assert.match(mdRollback, /rollback path is audited too/);
    assert.match(txtRollback, /rollback path is audited too/);
    // And the finding is about the ROLLBACK step, not about a forward step that
    // happens to share its index — which is what the .txt used to do.
    for (const section of [mdRollback, txtRollback]) {
      assert.match(section, /Flip DNS back/);
      assert.doesNotMatch(section, /Flip DNS — move live traffic/,
        'a rollback finding must never name a forward step');
    }
    // Both formats reach the same verdict about the same step.
    // Both formats reach the same verdict about the same step. Before this fix
    // the .md could not reach one at all (audit = null) and the .txt reached the
    // FORWARD audit's — so this equality is the whole point of the finding.
    assert.equal(/⛔ \*\*BLOCKED\*\*/.test(mdRollback), /\*\*\* BLOCKED/.test(txtRollback));
    assert.equal(/⛔ \*\*BLOCKED\*\*/.test(mdRollback), true,
      'a rollback that moves traffic with no gate and no approval in front of it is audited, not exempt');
  } finally { app.close(); }
});

test('LOW · a runbook with no rollback gains no rollback section', async () => {
  const app = await exportApp();
  try {
    const md = await app.text(`/w/${WS}/export/runbook/${advisoryOnlyGate.id}.md`);
    assert.doesNotMatch(md, /\n## Rollback\n/);
    assert.doesNotMatch(md, /rollback path is audited/);
  } finally { app.close(); }
});

// ------------------------------------------------------ MEDIUM 2 · /recommend

test('MEDIUM 2 · /recommend narrows to ?envId= / ?serviceId= and 404s on an unknown id', async () => {
  const app = await mount('../server/routes/recommend.js');
  try {
    const unscoped = await app.post(`/w/${WS}/recommend`);
    const prod = await app.post(`/w/${WS}/recommend?envId=env_prod`);
    const staging = await app.post(`/w/${WS}/recommend?envId=env_stg`);

    // §3: no scope ⇒ no scope block at all.
    assert.equal(unscoped.body.scope, undefined);
    // A scoped response says what it was scoped to.
    assert.equal(prod.body.scope.envName, 'Prod');
    assert.equal(prod.body.scope.componentCount, 1);
    assert.equal(staging.body.scope.envName, 'Staging');
    assert.match(prod.body.scope.description, /Prod environment/);

    // The out-of-scope finding is about the PROD component and must not appear
    // under a staging heading — that is the cross-environment leakage.
    const titles = (r) => r.body.gapsDetected.map((g) => g.title).join(' | ');
    assert.match(titles(unscoped), /Prod DB/);
    assert.match(titles(unscoped), /Staging DB/);
    assert.match(titles(prod), /Prod DB/);
    assert.doesNotMatch(titles(prod), /Staging DB/);
    assert.doesNotMatch(titles(staging), /Prod DB/,
      'the staging scope must not carry a production gap');

    // A service scope is narrower again.
    const svc = await app.post(`/w/${WS}/recommend?serviceId=svc_adj`);
    assert.equal(svc.body.scope.serviceName, 'adjudication');
    assert.doesNotMatch(titles(svc), /Staging DB/);

    // Unknown ids are 404s that name what exists, not silent empty answers.
    const badEnv = await app.post(`/w/${WS}/recommend?envId=env_nope`);
    assert.equal(badEnv.status, 404);
    assert.match(badEnv.body.error, /env_prod/);
    const badSvc = await app.post(`/w/${WS}/recommend?serviceId=svc_nope`);
    assert.equal(badSvc.status, 404);
    assert.match(badSvc.body.error, /svc_adj/);
  } finally { app.close(); }
});

test('HIGH 6 · a warning-only runbook produces a gap, where the err-only filter produced silence', async () => {
  const app = await mount('../server/routes/recommend.js');
  try {
    const r = await app.post(`/w/${WS}/recommend`);
    const byRule = r.body.gapSummary.byRule;
    // The error-severity runbook still files exactly the gap it always did.
    assert.equal(byRule['cutover-without-verification'], 1);
    // The two warning-only runbooks each file one, at 'high', not 'blocker'.
    assert.equal(byRule['cutover-gate-unsound'], 2);
    for (const g of r.body.gapsDetected.filter((x) => x.rule === 'cutover-gate-unsound')) {
      assert.equal(g.severity, 'high');
    }
  } finally { app.close(); }
});

// --------------------------------------------- MEDIUM 3 · stale / unclean

const m3ws = { name: 'lie-test', objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: true } };
const m3components = [{ id: 'cmp_a', name: 'Adjudication', tier: 0, inRecoveryScope: 'yes' }];
const m3base = {
  id: 't1', name: 'Region failover drill', status: 'passed',
  rtaMinutes: 12, rpaMinutes: 4, componentIds: ['cmp_a'],
};
const m3 = (extra) => measuredNumbers(m3ws, [{ ...m3base, ...extra }], 'cmp_a',
  { components: m3components, now: '2026-09-17' });

test('MEDIUM 3 · stale evidence never reports isAchievement or a plain "met"', () => {
  const n = m3({ date: '2024-11-02', cleanRun: true });
  assert.equal(n.rta.state, 'measured', 'the number is still measured — it WAS measured');
  assert.equal(n.rta.minutes, 12, 'and the number itself is kept');
  assert.equal(n.rta.stale, true);
  assert.equal(n.rta.isAchievement, false);
  assert.equal(n.rpa.isAchievement, false);
  assert.equal(n.verdict.overall, 'met-with-caveats');
  assert.notEqual(n.verdict.overall, 'met');
  // The per-metric verdict stays the pure numeric comparison the contract
  // defines — assessment.js and the workbook tint both depend on that.
  assert.equal(n.verdict.rto, 'met');
  assert.doesNotMatch(n.verdict.why, /Both objectives were met/);
  assert.match(n.verdict.why, /684 days old/);
});

test('MEDIUM 3 · a run that was not clean never reports isAchievement or a plain "met"', () => {
  const n = m3({ date: '2026-08-01', cleanRun: false });
  assert.equal(n.rta.stale, false, 'this one is fresh — cleanRun is the only caveat');
  assert.equal(n.rta.isAchievement, false);
  assert.equal(n.verdict.overall, 'met-with-caveats');
  assert.match(n.verdict.why, /not clean/);
});

test('MEDIUM 3 · fresh, clean, in-target evidence is still "met" and still an achievement', () => {
  const n = m3({ date: '2026-08-01', cleanRun: true });
  assert.equal(n.verdict.overall, 'met');
  assert.equal(n.rta.isAchievement, true);
  assert.equal(n.rpa.isAchievement, true);
  assert.match(n.verdict.why, /Both objectives were met/);
});

test('MEDIUM 3 · over target is still "missed" — the caveat never rescues a miss', () => {
  const n = m3({ date: '2024-11-02', cleanRun: false, rtaMinutes: 900 });
  assert.equal(n.verdict.overall, 'missed');
  assert.equal(n.rta.isAchievement, false);
});

test('MEDIUM 3 · the browser twin applies the same rule, and the new word has a rendering', () => {
  // The browser reads the slot's own `stale` / `cleanRun`, so drive it through
  // the same shape it gets from a workspace read.
  const tests = [{
    ...m3base, date: '2024-11-02', results: { rtaMinutes: 12, rpaMinutes: 4, cleanRun: true },
  }];
  const brw = browserMeasuredNumbers(m3ws, tests, 'cmp_a', { components: m3components, now: '2026-09-17' });
  if (brw.rta.state === 'measured') {
    assert.equal(brw.rta.isAchievement, false, 'the browser twin must not claim an achievement on stale evidence');
    assert.notEqual(brw.verdict.overall, 'met');
  }
  // Whatever produces it, the fourth value must render — a missing map entry is
  // how 'met-with-caveats' would silently print "Not measured yet".
  assert.equal(VERDICT_WORD['met-with-caveats'], 'Met on a past run — not proven current');
  assert.equal(VERDICT_TONE['met-with-caveats'], 'warn');
  assert.doesNotMatch(VERDICT_WORD['met-with-caveats'], /Not measured yet/);
});

test('MEDIUM 3 · the legacy fromPosture path cannot claim an achievement either', async () => {
  const { fromPosture } = await import('../web/js/measured.js');
  // What an older/partial server sends: the PER-METRIC verdict is 'met' (that is
  // the pure numeric comparison, by contract) while `overall` already carries the
  // caveat. Deriving isAchievement from the per-metric value alone set the one
  // flag that licenses the word "achieved" on evidence the same object had
  // already disqualified.
  const caveated = {
    rta: { minutes: 12, state: 'measured', stale: true, staleDays: 684, cleanRun: false, test: { name: 'drill' } },
    rpa: { minutes: 4, state: 'measured', stale: true, staleDays: 684, cleanRun: false, test: { name: 'drill' } },
    objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: true },
  };
  const withServerVerdict = fromPosture({
    ...caveated, verdictDetail: { rto: 'met', rpo: 'met', overall: 'met-with-caveats', why: 'stale' },
  });
  assert.equal(withServerVerdict.verdict.overall, 'met-with-caveats');
  assert.equal(withServerVerdict.rta.isAchievement, false);
  assert.equal(withServerVerdict.rpa.isAchievement, false);

  // And an older server that sends no verdict at all: the fallback derives the
  // fourth value itself rather than collapsing to a green 'met'.
  const derived = fromPosture(caveated);
  assert.equal(derived.verdict.overall, 'met-with-caveats');
  assert.equal(derived.rta.isAchievement, false);

  // Fresh + clean still reaches the plain 'met' on this path too.
  const clean = fromPosture({
    rta: { minutes: 12, state: 'measured', stale: false, staleDays: 3, cleanRun: true, test: { name: 'drill' } },
    rpa: { minutes: 4, state: 'measured', stale: false, staleDays: 3, cleanRun: true, test: { name: 'drill' } },
    objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: true },
  });
  assert.equal(clean.verdict.overall, 'met');
  assert.equal(clean.rta.isAchievement, true);
});

test('MEDIUM 3 · the browser twin never returns an empty "why" for the caveated verdict', async () => {
  const { measuredNumbers: brw } = await import('../web/js/measured.js');
  const n = brw(
    { name: 'w', objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: true } },
    [{
      id: 't1', name: 'drill', status: 'passed', date: '2024-11-02', componentIds: ['cmp_a'],
      results: { rtaMinutes: 12, rpaMinutes: 4, cleanRun: true },
    }],
    'cmp_a',
    { components: [{ id: 'cmp_a', name: 'A', tier: 0, inRecoveryScope: 'yes' }], now: '2026-09-17' },
  );
  assert.equal(n.verdict.overall, 'met-with-caveats');
  assert.ok(n.verdict.why.length > 0, 'an amber tile with a blank sentence under it explains nothing');
  assert.match(n.verdict.why, /684 days old/);
});
