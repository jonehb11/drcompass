// The honest-numbers rule, enforced at the artifact that actually reaches a
// board: `executiveSummaryModel()` in server/lib/xlsx-gen.js.
//
//   node --test test/
//
// measured-coverage.test.js pins the RULE. This file pins the one place that
// used to bypass it. `execModel`'s number picker took any passed test that
// carried an rtaMinutes/rpaMinutes and called it the WORKSPACE's measured
// number — so a drill that recovered one service in 12 minutes was printed on
// the Executive Summary sheet, EXECUTIVE-SUMMARY.md and the failover brief as
// the programme's recovery time. That is a scoped measurement presented as an
// estate-wide one, which is the same class of defect as presenting a failed
// test's clock as an achievement.
//
// The rule these tests hold to: a passed test is evidence for the workspace
// number only when it COVERED the workspace — it named no components (a whole
// estate exercise) or it named every component in the critical set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// executiveSummaryModel reads through the store, so each case gets its own
// throwaway DRCOMPASS_HOME. The seed is the fixture on purpose: it is the
// workspace every one of these artifacts is demonstrated on.
async function modelWith(extraTests) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-execnum-'));
  const prev = process.env.DRCOMPASS_HOME;
  process.env.DRCOMPASS_HOME = home;
  try {
    const store = await import('../server/store.js');
    store.seedExample();
    const slug = 'example-acme';
    const tests = store.getCollection(slug, 'tests');
    store.saveCollection(slug, 'tests', [...tests, ...extraTests]);
    // Cache-bust: the module reads the store at call time, but the import is
    // cached across cases, which is fine — only the store contents differ.
    const { executiveSummaryModel } = await import('../server/lib/xlsx-gen.js');
    return await executiveSummaryModel(slug);
  } finally {
    if (prev === undefined) delete process.env.DRCOMPASS_HOME;
    else process.env.DRCOMPASS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const scopedPass = {
  id: 'tst_scoped',
  name: 'Adjudication-only drill',
  date: '2026-09-10',
  status: 'passed',
  type: 'component-test',
  componentIds: ['cmp_adjudication'],
  results: { rtaMinutes: 12, rpaMinutes: 3, cleanRun: true },
};

const wholeEstatePass = {
  id: 'tst_full',
  name: 'Full-estate game day',
  date: '2026-09-14',
  status: 'passed',
  type: 'game-day',
  results: { rtaMinutes: 52, rpaMinutes: 9, cleanRun: true },
};

test('a passed test covering ONE component is not the workspace RTA', async () => {
  const m = await modelWith([scopedPass]);
  assert.notEqual(m.numbers.rtaMinutes, 12,
    'the adjudication-only drill was promoted to the workspace recovery time');
  assert.equal(m.numbers.rtaState, 'declared');
  assert.notEqual(m.numbers.rpaMinutes, 3);
  assert.equal(m.numbers.rpaState, 'declared');
});

test('the scoped measurement is reported, not silently dropped', async () => {
  const m = await modelWith([scopedPass]);
  // It is a real result about a real service. It is not the estate's number,
  // but a reader must be told it exists and where it DOES apply, or the model
  // has quietly thrown away a passed test.
  const warnings = (m.numbers.warnings || []).join(' ');
  assert.match(warnings, /Adjudication-only drill/,
    'the scoped passed test is not mentioned anywhere in the model');
  assert.match(warnings, /adjudication-service/,
    'the model does not say which component the scoped result IS evidence for');
});

test('a passed test covering the whole estate IS the workspace RTA', async () => {
  const m = await modelWith([wholeEstatePass]);
  assert.equal(m.numbers.rtaMinutes, 52);
  assert.equal(m.numbers.rtaState, 'measured');
  assert.match(String(m.numbers.rtaStamp), /Full-estate game day/);
});

test('an estate-wide pass outranks a scoped pass, whatever the dates say', async () => {
  // The scoped one is NOT newer here; the point is that ordering must never be
  // able to hand the workspace number to a test that did not cover it.
  const m = await modelWith([wholeEstatePass, { ...scopedPass, date: '2026-09-20' }]);
  assert.equal(m.numbers.rtaMinutes, 52);
  assert.equal(m.numbers.rtaState, 'measured');
});

test('a FAILED estate-wide test never produces a measured number', async () => {
  const m = await modelWith([{ ...wholeEstatePass, id: 'tst_failed', status: 'failed' }]);
  assert.notEqual(m.numbers.rtaState, 'measured');
  assert.notEqual(m.numbers.rtaMinutes, 52);
});
