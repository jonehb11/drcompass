// The blanks engine, and the `general` document flow that is pointed at it.
//
//   node --test test/
//
// WHAT THESE PIN DOWN
// -------------------
// `flowForKind('other')` returned '' and the ingest route then refused with
// "flow must be one of bia, solution, test-notes" — so a set of meeting notes,
// an RTO/RPO sheet exported as text, an architecture doc or a vendor email
// could not be ingested at all. `general` is the door for those, and
// `findBlanks()` is what it is pointed at: the fields the plan leaves EMPTY, so
// a document can fill real holes instead of guessing what might be useful.
//
// The rules these hold to:
//   * a blank id is a CONTRACT — deterministic, and stable across calls, or
//     `operations[].fills` means nothing;
//   * `importance` is DERIVED from tier / environment / recovery scope, never
//     typed in per kind, and nothing can grade above its subject's tier;
//   * an unknown scope id is a 404 naming what exists, never an empty list —
//     silently returning zero blanks for a typo is how somebody concludes their
//     plan is complete;
//   * `general` changes nothing for the three specialist flows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DRCOMPASS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-blanks-'));

const store = await import('../server/store.js');
store.seedExample();
const SLUG = 'example-acme';

const { findBlanks, IMPORTANCE } = await import('../server/lib/blanks.js');
const {
  flowForKind, INGEST_FLOWS, guardOperations, salvageJsonObject,
} = await import('../server/lib/ai-bridge.js');

// ------------------------------------------------- truncated CLI responses
//
// The provider CLI has its own output ceiling and a real document routinely
// reaches it. Before salvageJsonObject() existed, a response cut mid-string
// failed JSON.parse and ingestion answered "The AI did not return parseable
// JSON" with ZERO operations — blaming the model for a transport cut, and
// presenting a document it had read well as a document with nothing in it.
//
// Both truncations seen in practice cut inside the FINAL `notes` string, with
// every operation already on the wire. The rule: salvage what is provably
// complete, drop what was in flight rather than guessing it, and never let a
// partial read look like a whole one.

const FULL_RESPONSE = JSON.stringify({
  summary: 's',
  classified: { kind: 'meeting-notes', confidence: 'high', why: 'w', quote: 'q', betterFlow: '' },
  operations: [
    { op: 'update', collection: 'services', id: 'svc_a', data: { owner: 'Priya' }, why: 'w', quote: 'q', fills: [], confidence: 'high' },
    { op: 'create', collection: 'gaps', data: { title: 'KMS runbook' }, why: 'w', quote: 'q', fills: [], confidence: 'medium' },
  ],
  unmatched: [], conflicts: [], flags: [],
  notes: 'a much longer trailing note that is the first casualty of a cut',
});

test('a complete response still parses strictly — no change on the happy path', () => {
  const r = salvageJsonObject(FULL_RESPONSE);
  assert.equal(r.complete, true);
  assert.equal(r.method, 'strict');
  assert.equal(r.obj.operations.length, 2);
});

test('a response cut inside the final notes keeps every operation', () => {
  // The exact shape observed twice in practice.
  const r = salvageJsonObject(FULL_RESPONSE.slice(0, FULL_RESPONSE.length - 25));
  assert.equal(r.complete, false, 'a truncated response must not be reported as complete');
  assert.equal(r.obj.operations.length, 2, 'operations were on the wire and must survive the cut');
  assert.ok(!('notes' in r.obj), 'the field that was in flight must be dropped, not half-built');
  assert.deepEqual(r.obj.classified.kind, 'meeting-notes');
});

test('an operation cut in half is DROPPED, never closed into a proposal nobody made', () => {
  // Closing the brackets around a half-written operation would yield a valid
  // `{"op":"create"}` — a proposal the model never finished. An array element
  // is a unit: the partial one goes.
  const r = salvageJsonObject(FULL_RESPONSE.slice(0, FULL_RESPONSE.indexOf('"create"') + 40));
  assert.equal(r.complete, false);
  assert.equal(r.obj.operations.length, 1);
  assert.equal(r.obj.operations[0].op, 'update');
  assert.ok(r.obj.operations.every((o) => o.data), 'a recovered operation with no data was invented by the salvager');
});

test('a cut before any operation completed yields no operations at all, not a wrong one', () => {
  const r = salvageJsonObject(FULL_RESPONSE.slice(0, FULL_RESPONSE.indexOf('"svc_a"') + 4));
  assert.equal(r.complete, false);
  assert.ok(!Array.isArray(r.obj.operations), 'a half-read operations array must be absent, not partially populated');
  // What DID arrive is still usable, and the caller reports the rest as lost.
  assert.equal(r.obj.summary, 's');
});

test('unrecoverable output stays unrecoverable — the salvager never invents an object', () => {
  assert.equal(salvageJsonObject('I could not read that file.').obj, null);
  assert.equal(salvageJsonObject('').obj, null);
  assert.equal(salvageJsonObject('{"sum').obj, null);
});

// ------------------------------------------------------------- the flow door

test('an unclassified document now has a flow to go to', () => {
  // The bug, stated as a test: 'other' produced '' and the route refused.
  assert.equal(flowForKind('other'), 'general');
  assert.equal(flowForKind('something-this-build-has-never-heard-of'), 'general');
  assert.ok(INGEST_FLOWS.includes('general'));
});

test('a document the user DID classify still goes to its specialist', () => {
  // `general` is the door for unclassified documents, not a replacement for the
  // three briefs that already know what they are reading.
  assert.equal(flowForKind('bia'), 'bia');
  assert.equal(flowForKind('solution'), 'solution');
  assert.equal(flowForKind('test-plan'), 'test-notes');
  assert.equal(flowForKind('runbook-notes'), 'test-notes');
});

// ------------------------------------------------------------- the blank ids

test('a blank id is deterministic and stable across calls', () => {
  const a = findBlanks(SLUG);
  const b = findBlanks(SLUG);
  assert.deepEqual(a.items.map((x) => x.id), b.items.map((x) => x.id),
    'two calls over the same data produced different ids — `fills` would be meaningless');
  assert.equal(a.items.length, new Set(a.items.map((x) => x.id)).size, 'blank ids are not unique');
  for (const it of a.items) {
    assert.equal(it.id, `${it.kind}:${it.subject.id}:${it.field}`);
  }
});

test('every blank carries the shape the general flow and the UI are built against', () => {
  const { items, counts } = findBlanks(SLUG);
  assert.ok(items.length > 0, 'the seed has known holes; finding none means the engine is not reading');
  for (const it of items) {
    assert.ok(it.kind && it.field && it.label && it.why);
    assert.ok(['component', 'service', 'workspace'].includes(it.subject.type));
    assert.ok(it.subject.id && it.subject.name);
    assert.ok(IMPORTANCE.includes(it.importance));
    assert.ok(Array.isArray(it.exportedIn) && it.exportedIn.length > 0,
      `blank ${it.id} names no export — "where does this show up" is what makes filling it worth doing`);
  }
  assert.equal(counts.total, items.length);
  assert.equal(
    Object.values(counts.byImportance).reduce((a, b) => a + b, 0), items.length,
    'counts.byImportance does not add up to the item count',
  );
  assert.equal(
    Object.values(counts.byKind).reduce((a, b) => a + b, 0), items.length,
    'counts.byKind does not add up to the item count',
  );
});

test('the list is worst-first', () => {
  const { items } = findBlanks(SLUG);
  const ranks = items.map((i) => IMPORTANCE.indexOf(i.importance));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

// --------------------------------------------------------------- the grading

test('importance is derived from tier and environment, not from the kind of blank', () => {
  const { items } = findBlanks(SLUG);
  const byId = new Map(items.map((i) => [i.id, i]));

  // Same KIND of blank, different subjects: the production tier-0 service has
  // no objective and grades blocker; a dev tier-2 service's grades low. If the
  // kind decided the grade these would be equal.
  const prodPlatform = byId.get('objective-rto:svc_prod_platform:objectives.rtoMinutes');
  const devPlatform = byId.get('objective-rto:svc_dev_platform:objectives.rtoMinutes');
  assert.ok(prodPlatform && devPlatform);
  assert.equal(prodPlatform.importance, 'blocker');
  assert.equal(devPlatform.importance, 'low');
  assert.ok(IMPORTANCE.indexOf(prodPlatform.importance) < IMPORTANCE.indexOf(devPlatform.importance),
    'a missing RTO on a tier-0 production service graded no worse than one on a tier-2 dev service');
});

test('a per-kind ceiling can only lower a grade, never raise it', () => {
  const { items } = findBlanks(SLUG);
  // dependsOn is a modelling hole, not a stopper: it caps at 'high' however
  // critical the component. There are tier-0 production components with no
  // dependsOn in the seed, so this would be 'blocker' without the ceiling.
  const deps = items.filter((i) => i.kind === 'component-depends-on');
  assert.ok(deps.length > 0);
  assert.ok(deps.every((i) => i.importance !== 'blocker'),
    'component-depends-on reached blocker despite its ceiling');
});

// --------------------------------------------------------------- objectives

test('the objective rules come from measured.js, not from a second copy', () => {
  const { items } = findBlanks(SLUG);
  const ids = new Set(items.map((i) => i.id));

  // svc_prod_adjudication carries its OWN approved objective (BIA 2026-03), so
  // it has no objective blank at all.
  assert.ok(!ids.has('objective-rto:svc_prod_adjudication:objectives.rtoMinutes'));
  assert.ok(!ids.has('objective-rpo:svc_prod_adjudication:objectives.rpoMinutes'));

  // svc_prod_platform has none of its own — and objectiveFor()'s rule 1 says it
  // does NOT inherit the workspace's, so this really is a blank.
  assert.ok(ids.has('objective-rto:svc_prod_platform:objectives.rtoMinutes'));
  assert.ok(ids.has('objective-rpo:svc_prod_platform:objectives.rpoMinutes'));

  const blank = items.find((i) => i.id === 'objective-rto:svc_prod_platform:objectives.rtoMinutes');
  assert.match(blank.why, /does not let it inherit one/);
});

test('an unapproved target is a blank, and a missing one is a different blank', () => {
  const { items } = findBlanks(SLUG);
  // The seed workspace records 60/30 with approved:false — a number that
  // exists and has not been signed off. That is 'unapproved', not 'missing'.
  const unapproved = items.find((i) => i.kind === 'objective-unapproved' && i.subject.type === 'workspace');
  assert.ok(unapproved, 'the seed workspace objective is unapproved and was not reported');
  assert.equal(unapproved.field, 'objectives.approved');
  assert.notEqual(unapproved.importance, 'blocker', 'the number is there; only the signature is missing');
});

// ------------------------------------------------------------------ scoping

test('an unknown scope id is a 404 naming what exists, never an empty list', () => {
  assert.throws(() => findBlanks(SLUG, { serviceId: 'svc_nope' }), (e) => {
    assert.equal(e.status, 404);
    assert.match(e.message, /known services: svc_prod_adjudication/);
    return true;
  });
  assert.throws(() => findBlanks(SLUG, { envId: 'env_nope' }), (e) => {
    assert.equal(e.status, 404);
    assert.match(e.message, /known environments: env_prod, env_staging, env_dev/);
    return true;
  });
});

test('a scope narrows the blanks to what the caller asked about', () => {
  const all = findBlanks(SLUG);
  const scoped = findBlanks(SLUG, { serviceId: 'svc_prod_platform' });
  assert.ok(scoped.counts.total < all.counts.total);
  assert.equal(scoped.scope.serviceName, 'platform');

  // A service scope must not drag in other environments' objectives: scoped to
  // a production service, Staging's missing objective is a blank about
  // something the caller did not ask about.
  const envSubjects = scoped.items
    .filter((i) => i.kind.startsWith('objective') && i.subject.id.startsWith('env_'))
    .map((i) => i.subject.id);
  assert.deepEqual([...new Set(envSubjects)], ['env_prod']);
});

test('the workspace objective is reported unscoped and not double-counted under a scope', () => {
  const all = findBlanks(SLUG);
  const scoped = findBlanks(SLUG, { envId: 'env_prod' });
  assert.ok(all.items.some((i) => i.subject.id === SLUG),
    'the workspace commitment is not reported at all');
  assert.ok(!scoped.items.some((i) => i.subject.id === SLUG),
    'the workspace objective was reported again under a scope that has its own');
});

// -------------------------------------------- the general flow's guard rule

test('the general flow cannot write a target into a component replication capability', () => {
  const notes = [];
  const [op] = guardOperations('general', [{
    op: 'update', collection: 'components', id: 'cmp_x',
    data: { replication: { mechanism: 'aurora-global', rpoMinutes: 10, notes: 'from the doc' } },
  }], notes, 'Recovery Objectives Register v4.1.txt');

  // A general document may BE a BIA, so an RPO it states cannot be trusted into
  // replication.rpoMinutes — that field is a CAPABILITY claim about a mechanism.
  assert.equal(op.data.replication.rpoMinutes, undefined);
  // Narrowed, not a blanket delete: an architecture doc is the best source
  // there is for the mechanism and the notes.
  assert.equal(op.data.replication.mechanism, 'aurora-global');
  assert.equal(op.data.replication.notes, 'from the doc');
  assert.match(notes.join(' '), /Dropped replication\.rpoMinutes/);
});

test('the general replication rule keys on the flow string, so it fires at /ai/apply too', () => {
  // The rule must not depend on the model's own classification, or it would
  // hold on the proposal path and not at the write boundary.
  const notes = [];
  const [op] = guardOperations('general', [{
    op: 'create', collection: 'components',
    data: { name: 'New store', replication: { mechanism: 'snapshot', rpoMinutes: 5 } },
  }], notes, '');
  assert.equal(op.data.replication.rpoMinutes, undefined);
  assert.equal(op.data.replication.mechanism, 'snapshot');
});

test('the other flows are untouched by the general rule', () => {
  const notes = [];
  const [op] = guardOperations('solution', [{
    op: 'update', collection: 'components', id: 'cmp_x',
    data: { replication: { mechanism: 'aurora-global', rpoMinutes: 1 } },
  }], notes, '');
  // A solution document describes the mechanism AND what it delivers; that is
  // a capability statement, which is exactly what this field is for.
  assert.equal(op.data.replication.rpoMinutes, 1);
  assert.deepEqual(notes, []);
});

// --------------------------------------------------- coverage, the two kinds

test('tier-0 coverage blanks use test evidence and runbook authorship separately', () => {
  const { items } = findBlanks(SLUG);
  const rb = items.filter((i) => i.kind === 'runbook-coverage');
  const ts = items.filter((i) => i.kind === 'test-coverage');
  assert.ok(ts.length > rb.length,
    'the seed runbook names 16 components while its tests name far fewer, so test coverage must be the sparser of the two');
  // The distinction coverage.js insists on: a runbook step naming a component
  // is authoring metadata, and it must NOT count as test coverage.
  assert.match(ts[0].why, /authoring metadata and does NOT count here/);
  // Nothing tier-0-and-out-of-scope is reported: that is a decision, not a hole.
  const components = store.getCollection(SLUG, 'components');
  const byId = new Map(components.map((c) => [c.id, c]));
  for (const it of [...rb, ...ts]) {
    assert.equal(byId.get(it.subject.id).tier, 0);
    assert.notEqual(String(byId.get(it.subject.id).inRecoveryScope || '').toLowerCase(), 'no');
  }
});
