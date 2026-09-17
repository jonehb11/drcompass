// Every way a proposal could write a MEASUREMENT, closed one at a time.
//
//   node --test test/
//
// WHY THIS FILE EXISTS
// --------------------
// `guardOperations()` is the honest-numbers rule applied to data, and it runs at
// the one write boundary (POST /ai/apply) as well as on the proposal path. It
// stripped `results{}`, `timestamps{}`, `cleanRun` and `appTests[].result` — and
// left three doors standing onto exactly the same claim:
//
//   1. THE FLATTENED NUMBERS. `measured.js:normalizeTest()` accepts a test in
//      two shapes and reads TOP-LEVEL `rtaMinutes`/`rpaMinutes` IN PREFERENCE to
//      the nested `results.*`. Deleting `results{}` and nothing else left the
//      shorter spelling wide open. Reproduced on a live server: an update
//      carrying `{rtaMinutes: 3}` onto an already-passed test moved the
//      executive summary from NOT PROVEN to "came back in 3 min", with
//      `guardNotes: []` — the guard said nothing at all.
//
//   2. WHAT A TEST COVERS. `coverage.js:idsNamedByTest()` builds a test's claim
//      from `componentIds`, `componentId` and `appTests[].componentId`, and
//      'direct' coverage is the only level that may produce a measurement. So
//      ADDING an id to a passed test forges the observation "we exercised this
//      and checked its success bar" — and, because `measured.js` reads a passed
//      test that names NO component as an estate-wide exercise, CLEARING the
//      list turns a one-service drill into a workspace measurement. The door
//      opens in both directions.
//
//   3. WHEN IT HAPPENED. `date` decides staleness, and staleness is what turns
//      "MET ON A PAST RUN" into "re-test before quoting it". Moving it forward
//      from a proposal can only ever make old evidence look current.
//
// The asymmetry that gave the first one away: the guard already stripped the
// flattened `cleanRun`, so flattened fields were known about — these were missed.
//
// The rule every case here holds to: an AI proposal may describe anything, but
// it can never write a measurement, on any path, by any spelling. Each test
// asserts the thing that actually matters — that the EXECUTIVE SUMMARY VERDICT
// does not move — rather than only that a key was deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { guardOperations } = await import('../server/lib/ai-bridge.js');

/**
 * Seed a throwaway workspace, add `seedTests` the HONEST way (straight into the
 * store, as a real run would be recorded), then push `ops` through the guard and
 * apply whatever survives — exactly as POST /ai/apply does. Returns the
 * executive-summary model before and after, so a case can assert the verdict
 * did not move.
 */
async function throughTheGuard(seedTests, ops) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-doors-'));
  const prev = process.env.DRCOMPASS_HOME;
  process.env.DRCOMPASS_HOME = home;
  try {
    const store = await import('../server/store.js');
    store.seedExample();
    const slug = 'example-acme';
    store.saveCollection(slug, 'tests', [...store.getCollection(slug, 'tests'), ...seedTests]);

    const { executiveSummaryModel } = await import('../server/lib/xlsx-gen.js');
    const before = await executiveSummaryModel(slug);

    const notes = [];
    const guarded = guardOperations('', ops, notes);
    for (const op of guarded) {
      if (op.op !== 'update' || op.collection !== 'tests') continue;
      // The route refuses an update whose data the guard emptied. Mirror that
      // rather than writing `{}` — an op with nothing left is not applied.
      if (!op.data || !Object.keys(op.data).length) continue;
      const items = store.getCollection(slug, 'tests');
      const i = items.findIndex((t) => t.id === op.id);
      if (i < 0) continue;
      items[i] = { ...items[i], ...op.data };
      store.saveCollection(slug, 'tests', items);
    }

    const after = await executiveSummaryModel(slug);

    // The workspace verdict is not the only artifact a forged coverage claim
    // reaches. Adding a component to a passed test does NOT move the
    // estate-wide verdict (the critical set is still uncovered) but it DOES
    // flip that component's own number to `measured` — which is what the
    // Service profile page and a scoped export print. Verified by bypassing the
    // guard: `cmp_adjudication` goes declared -> measured on both door 2 and
    // door 2c. So the component reading travels with the result and those two
    // cases assert on it, or they would pass with the fix reverted.
    // Computed HERE, not returned as a closure: `finally` below deletes the
    // throwaway home, so anything lazy would read an empty workspace.
    const { measuredNumbers } = await import('../server/lib/measured.js');
    const components = store.getCollection(slug, 'components');
    const workspace = store.getWorkspace(slug);
    const liveTests = store.getCollection(slug, 'tests');
    const componentStates = {};
    for (const id of ['cmp_adjudication', 'cmp_pricing']) {
      componentStates[id] = measuredNumbers(workspace, liveTests, id, { components }).rta.state;
    }
    const componentState = (id) => componentStates[id];
    return { before, after, notes, guarded, componentState };
  } finally {
    if (prev === undefined) delete process.env.DRCOMPASS_HOME;
    else process.env.DRCOMPASS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A real passed run that measured NOTHING — the state the seed is in, and the
// one the first exploit started from.
const passedNoNumbers = {
  id: 'tst_real_drill', name: 'Real drill', status: 'passed',
  date: '2026-09-16', type: 'game-day',
};

// A real passed run that measured ONE service, recorded honestly.
const passedOneService = {
  id: 'tst_pricing', name: 'Pricing drill', status: 'passed',
  date: '2026-09-16', type: 'component-test',
  componentIds: ['cmp_pricing'],
  results: { rtaMinutes: 9, rpaMinutes: 2, cleanRun: true },
};

// ---------------------------------------------- door 1: the flattened numbers

test('door 1: top-level rtaMinutes/rpaMinutes cannot make an unmeasured plan measured', async () => {
  const { before, after, notes } = await throughTheGuard([passedNoNumbers], [{
    op: 'update', collection: 'tests', id: 'tst_real_drill',
    data: { rtaMinutes: 3, rpaMinutes: 1 },
  }]);

  assert.equal(before.numbers.rtaState, 'declared');
  assert.match(before.verdict.label, /NOT PROVEN/);

  // The whole point: the verdict an executive reads does not move.
  assert.equal(after.numbers.rtaState, 'declared',
    'a top-level rtaMinutes from a proposal became a MEASUREMENT');
  assert.equal(after.numbers.rpaState, 'declared');
  assert.match(after.verdict.label, /NOT PROVEN/);
  assert.notEqual(after.numbers.rtaMinutes, 3);

  // And it is REPORTED. A guard that strips silently teaches nobody anything.
  assert.match(notes.join(' '), /Dropped rtaMinutes/);
  assert.match(notes.join(' '), /Dropped rpaMinutes/);
  assert.match(notes.join(' '), /flattened spelling/);
});

test('door 1b: the flattened numbers are stripped on a CREATE too', () => {
  const notes = [];
  const [op] = guardOperations('', [{
    op: 'create', collection: 'tests',
    data: { name: 'Planned drill', rtaMinutes: 4, rpaMinutes: 0, type: 'game-day' },
  }], notes);
  // A create lands as 'planned' so it cannot measure anything TODAY — but a
  // number nobody produced does not become true when somebody later marks that
  // test passed by hand.
  assert.equal(op.data.status, 'planned');
  assert.equal(op.data.rtaMinutes, undefined);
  assert.equal(op.data.rpaMinutes, undefined);
  assert.equal(op.data.name, 'Planned drill', 'the guard neutered the item, not just the claim');
});

// --------------------------------------------------- door 2: what it covers

test('door 2: componentIds cannot be ADDED to a passed test to measure an untested service', async () => {
  const { before, after, notes, componentState } = await throughTheGuard([passedOneService], [{
    op: 'update', collection: 'tests', id: 'tst_pricing',
    data: { componentIds: ['cmp_pricing', 'cmp_adjudication'] },
  }]);

  // adjudication is tier 0 and has never been exercised by this drill. With the
  // guard bypassed it reads `measured` here — that is the forged observation.
  assert.equal(componentState('cmp_adjudication'), 'declared',
    'adding a component id to a passed test made an untested tier-0 service "measured"');
  // pricing, which the run really did cover, keeps its honest measurement.
  assert.equal(componentState('cmp_pricing'), 'measured',
    'the guard neutered the real measurement as well as the forged one');

  assert.equal(before.numbers.rtaState, after.numbers.rtaState);
  assert.equal(before.verdict.label, after.verdict.label);
  assert.match(notes.join(' '), /Dropped componentIds/);
});

test('door 2b: CLEARING componentIds cannot widen a one-service drill into a workspace measurement', async () => {
  // The inverse direction, and the easier one to miss: measured.js reads a
  // passed test that names NO components as an estate-wide exercise, so an
  // empty array is not a smaller claim than a longer one — it is the biggest
  // claim available.
  const { before, after, notes } = await throughTheGuard([passedOneService], [{
    op: 'update', collection: 'tests', id: 'tst_pricing',
    data: { componentIds: [] },
  }]);

  assert.equal(after.numbers.rtaState, before.numbers.rtaState,
    'emptying componentIds promoted a scoped drill to the workspace number');
  assert.notEqual(after.numbers.rtaMinutes, 9);
  assert.match(after.verdict.label, /NOT PROVEN/);
  assert.match(notes.join(' '), /Dropped componentIds/);
});

test('door 2c: appTests[].componentId cannot forge coverage on a passed test', async () => {
  const { before, after, notes, guarded, componentState } = await throughTheGuard([passedOneService], [{
    op: 'update', collection: 'tests', id: 'tst_pricing',
    data: { appTests: [{ name: 'claim adjudicated end to end', componentId: 'cmp_adjudication', result: 'pass' }] },
  }]);

  const [op] = guarded;
  assert.equal(op.data.appTests[0].componentId, undefined);
  assert.equal(op.data.appTests[0].result, undefined);
  // The CHECK itself survives — this neuters the claim, not the content.
  assert.equal(op.data.appTests[0].name, 'claim adjudicated end to end');

  // An appTest naming a component is measured-eligible evidence, so this is the
  // same forgery as door 2 by another field. Verified to flip
  // declared -> measured with the guard bypassed.
  assert.equal(componentState('cmp_adjudication'), 'declared',
    'an appTest componentId on a passed test made an untested tier-0 service "measured"');
  assert.equal(before.verdict.label, after.verdict.label);
  assert.match(notes.join(' '), /Dropped appTests\[\]\.componentId/);
});

// ------------------------------------------------------ door 3: when it ran

test('door 3: a stale measurement cannot be re-dated into a current one', async () => {
  const stale = {
    id: 'tst_ancient', name: 'Ancient full-estate drill', status: 'passed',
    date: '2024-02-01', type: 'game-day',
    results: { rtaMinutes: 11, rpaMinutes: 4, cleanRun: true },
  };
  const { before, after, notes } = await throughTheGuard([stale], [{
    op: 'update', collection: 'tests', id: 'tst_ancient',
    data: { date: '2026-09-17', scope: 'a document said this ran again' },
  }]);

  // Before: a real measurement, but old enough that the workbook refuses to
  // call it current.
  assert.equal(before.numbers.rtaState, 'measured');
  assert.match(before.verdict.label, /NOT PROVEN CURRENT/);

  // After: unchanged. The date is what decides whether a number is quotable.
  assert.equal(after.verdict.label, before.verdict.label,
    're-dating a stale run from a proposal made it current');
  assert.match(notes.join(' '), /Dropped date from an update/);
});

// --------------------------------------------------- the doors already shut
//
// Named explicitly so a future reader can tell "checked and safe" from "never
// considered" — the distinction this whole file exists because of.

test('the fields that were already governed stay governed', () => {
  const notes = [];
  const [op] = guardOperations('', [{
    op: 'update', collection: 'tests', id: 'tst_x',
    data: {
      status: 'passed',
      results: { rtaMinutes: 4, rpaMinutes: 0, cleanRun: true },
      timestamps: { t0: '2026-09-15T01:00:00Z', t1: '2026-09-15T01:04:00Z' },
      cleanRun: true,
    },
  }], notes);

  assert.equal(op.data.status, 'planned', 'a proposal can only ever propose a planned test');
  assert.equal(op.data.results, undefined);
  assert.equal(op.data.timestamps, undefined);
  assert.equal(op.data.cleanRun, undefined);
});

test('an update that names no status still does not demote a real passed test', () => {
  // This behaviour is deliberate and is what let door 1 ride in on a
  // pre-existing `passed`. It stays: silently demoting a real run is the same
  // dishonesty pointed the other way. The NUMBER path is what got closed.
  const notes = [];
  const [op] = guardOperations('', [{
    op: 'update', collection: 'tests', id: 'tst_x',
    data: { scope: 'clarified what this drill covered' },
  }], notes);
  assert.equal(op.data.status, undefined);
  assert.equal(op.data.scope, 'clarified what this drill covered');
  assert.deepEqual(notes, [], 'an honest update should produce no guard noise');
});

test('the new strips are idempotent — running the guard twice adds no second note', () => {
  const first = [];
  const [once] = guardOperations('', [{
    op: 'update', collection: 'tests', id: 'tst_x',
    data: { rtaMinutes: 3, date: '2026-09-17', componentIds: ['cmp_a'], name: 'Drill' },
  }], first);
  const second = [];
  const [twice] = guardOperations('', [once], second);
  assert.deepEqual(twice.data, once.data);
  assert.deepEqual(second, [], 'guarding an already-guarded operation reported something new');
  assert.ok(first.length >= 3, 'the first pass should have reported all three strips');
});
