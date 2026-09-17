// Invariant 2 — FENCE BEFORE PROMOTE — at the level of runbook STEPS.
//
//   node --test test/
//
// The ordering has always been right: `addFenceGates` puts a `fence:` item in a
// strictly earlier wave than the writer it protects. What was wrong was the step
// COMPOSITION — the draft folded the wave's fence gates and the wave's clusters
// into one step, under one "SUPPLY THE CREATE/RESTORE COMMAND" block that ended
// "everything in this step can run in PARALLEL". A containment action and a
// create action cannot share a step, a command, or a verification, and "run
// these in parallel" is actively wrong when one of them is the fence that must
// complete before the others begin.
//
// These tests pin the fix and the things the fix must NOT change.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDeployOrder, toRunbookDraft } from '../server/lib/deploy-order.js';

// A writer store (so a fence gate is synthesised), a cache and a parameter group
// in the same category and the same wave — which is what produced the mixed step.
const components = [
  {
    id: 'cmp_aurora', name: 'Aurora — ledger', kind: 'aurora-postgres', category: 'database',
    tier: 0, restoreLayer: 'L3', owner: 'data', dependsOn: ['cmp_vpc'],
  },
  {
    id: 'cmp_aurora2', name: 'Aurora — pricing', kind: 'aurora-postgres', category: 'database',
    tier: 0, restoreLayer: 'L3', owner: 'data', dependsOn: ['cmp_vpc'],
  },
  {
    id: 'cmp_redis', name: 'Redis — ledger cache', kind: 'elasticache-redis', category: 'database',
    tier: 1, restoreLayer: 'L3', owner: 'data', dependsOn: ['cmp_vpc'],
  },
  {
    id: 'cmp_vpc', name: 'VPC + subnets', kind: 'vpc', category: 'networking',
    tier: 0, restoreLayer: 'L2', owner: 'platform', dependsOn: [],
  },
];

const draft = () => toRunbookDraft(computeDeployOrder({ components }), {
  workspace: { regions: { primary: 'us-east-1', recovery: 'us-east-2' }, tooling: ['terraform'] },
});

const isFenceStep = (s) => /FENCE the old primary/.test(s.title);
const fenceItems = (r) => r.waves.flatMap((w) => w.categories.flatMap((c) => c.items))
  .filter((i) => i.kind === 'fence-gate');

test('a fence gate gets its OWN step, ahead of the creates in the same wave', () => {
  const rb = draft();
  const fence = rb.steps.filter(isFenceStep);
  assert.equal(fence.length, 1, 'one fence step');
  const i = rb.steps.indexOf(fence[0]);
  const creates = rb.steps.filter((s) => /Wave \d+ — Data stores$|Wave \d+ — Database$/.test(s.title));
  assert.ok(creates.length, 'the create step still exists');
  for (const c of creates) {
    assert.ok(rb.steps.indexOf(c) > i, `${c.title} comes after the fence step`);
  }
});

test('the fence step contains ONLY fence gates, and the create step contains none', () => {
  const rb = draft();
  const fence = rb.steps.find(isFenceStep);
  assert.match(fence.detail, /Fence the old primary — Aurora — ledger/);
  assert.match(fence.detail, /Fence the old primary — Aurora — pricing/);
  assert.doesNotMatch(fence.detail, /Redis — ledger cache/);
  for (const s of rb.steps.filter((x) => !isFenceStep(x))) {
    assert.doesNotMatch(String(s.detail), /Fence the old primary/,
      `"${s.title}" must not carry a fence bullet`);
    assert.doesNotMatch(String(s.command), /Fence the old primary/,
      `"${s.title}" must not name a fence in its create command`);
  }
});

test('the fence step is never told to create anything, and never says PRE-EVENT', () => {
  const rb = draft();
  const fence = rb.steps.find(isFenceStep);
  assert.doesNotMatch(fence.command, /SUPPLY THE CREATE\/RESTORE COMMAND/);
  assert.match(fence.command, /NOTHING IS CREATED IN THIS STEP/);
  // A fence is performed DURING the event. The third-party precondition wording
  // ("this is a PRE-EVENT task, not a recovery step") is true of a partner
  // allowlist and false — and dangerous — of a fence.
  assert.doesNotMatch(fence.command, /PRE-EVENT/);
  assert.match(fence.command, /CONTAINMENT/);
});

test('"run these in parallel" never spans the containment/create boundary', () => {
  const rb = draft();
  const fence = rb.steps.find(isFenceStep);
  // Parallel WITH EACH OTHER is fine — five independent clusters. Parallel with
  // what follows is the bug.
  assert.match(fence.command, /parallel WITH EACH OTHER/);
  assert.match(fence.command, /Nothing in the next\n# step starts until this step is green/);
  const create = rb.steps.find((s) => /Wave \d+ — Data stores$|Wave \d+ — Database$/.test(s.title)
    && /Redis — ledger cache/.test(s.detail));
  assert.match(create.command, /THE FENCE STEP IMMEDIATELY ABOVE MUST BE GREEN/);
  assert.match(create.detail, /Fence before promote/);
});

test('the fence step has the invariant-2 pass criterion, a gate, an owner and a record', () => {
  const rb = draft();
  const fence = rb.steps.find(isFenceStep);
  assert.match(fence.pass, /one of the three is demonstrably true and written down/);
  assert.equal(fence.gate, true, 'a fence is a gate: the steps after it are unsafe until it passes');
  assert.equal(fence.owner, 'data', 'whoever owns the database owns demoting its old primary');
  assert.match(fence.record, /which fence you applied/);
  // The minutes recorded against the cluster are for RESTORING it; a fence that
  // nobody has timed gets no number rather than the cluster's.
  assert.equal(fence.estMinutes, null);
  // L1: the fence is a recovery-launch action, not an L0 pre-event precondition
  // and not the L3 of the data block it protects.
  assert.equal(fence.layer, 'L1');
});

test('splitting a step changes no item, no wave and no ordering', () => {
  const r = computeDeployOrder({ components });
  const fences = fenceItems(r);
  assert.equal(fences.length, 2, 'one fence per writer store');
  // Every fence is an ordering edge on its promote target, in a STRICTLY
  // earlier wave. This is the invariant the step split must not disturb.
  const byId = new Map(r.waves.flatMap((w) => w.categories.flatMap((c) => c.items))
    .map((i) => [i.id, i]));
  for (const f of fences) {
    const target = byId.get(f.componentId);
    assert.ok(target, `${f.name} points at a component in the plan`);
    assert.ok(f.wave < target.wave,
      `${f.name} (wave ${f.wave}) must be strictly before ${target.name} (wave ${target.wave})`);
    assert.equal(f.action, 'verify', 'a fence is confirmed, never deployed');
  }
  // Item and wave counts are a property of the ORDER, not of how it is written
  // up: the draft must not be able to move them.
  const itemCount = r.waves.reduce((n, w) => n + w.categories.reduce((m, c) => m + c.items.length, 0), 0);
  assert.equal(itemCount, r.stats.itemCount);
  const rb = draft();
  const inSteps = rb.steps.reduce((n, s) => n + (/^Wave /.test(s.title)
    ? s.detail.split('\n').filter((l) => l.startsWith('• ')).length : 0), 0);
  assert.equal(inSteps, itemCount, 'every ordered item appears in exactly one step');
});

test('a group that is entirely one phase is still exactly one step', () => {
  const rb = draft();
  const titles = rb.steps.filter((s) => /^Wave /.test(s.title)).map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length, 'no step title is duplicated');
  // Networking has no verify items, so it is untouched by the split.
  assert.equal(titles.filter((t) => /— Networking$/.test(t)).length,
    titles.filter((t) => /— Networking/.test(t)).length);
});

test('a third-party precondition is still wave 0, verify, and L0 — not a fence', () => {
  const r = computeDeployOrder({
    components: [
      ...components,
      {
        id: 'cmp_bank', name: 'settlement.bank.example.com', kind: 'sftp', category: 'third-party',
        tier: 0, restoreLayer: 'L5', dependsOn: [],
        outboundCalls: [{ target: 'settlement.bank.example.com', when: 'startup', protocol: 'sftp' }],
      },
    ],
  });
  const wave0 = r.waves[0].categories.flatMap((c) => c.items);
  const ext = wave0.filter((i) => i.category === 'third-party');
  assert.ok(ext.length, 'the partner is a wave-0 precondition');
  for (const e of ext) assert.equal(e.action, 'verify');
  const rb = toRunbookDraft(r, { workspace: { regions: { recovery: 'us-east-2' } } });
  const tp = rb.steps.find((s) => /Wave 0 — Third party/.test(s.title));
  assert.equal(tp.layer, 'L0');
  // Unsplit, so it keeps the plain title and the precondition wording.
  assert.equal(tp.title, 'Wave 0 — Third party');
  assert.match(tp.command, /PRE-EVENT task/);
  assert.doesNotMatch(tp.command, /CONTAINMENT/);
});
