// `cleanRun` is TRI-STATE: true / false / never recorded.
//
//   node --test test/
//
// The bug this pins: `normalizeTest` collapsed an unrecorded `cleanRun` to
// `false`, and the caveat wording downstream is specific — "the bar was reached
// only after undocumented manual intervention". So a drill where the operator
// simply left the box blank was narrated, in a document handed to an auditor,
// as a control breakdown that never happened. Claiming less is the safe
// direction; inventing a procedural failure is not.
//
// It survived 107 tests because every fixture in the suite set `cleanRun`
// explicitly. These tests deliberately do NOT set it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredNumbers } from '../server/lib/measured.js';
import * as browser from '../web/js/measured.js';

const workspace = {
  name: 'Fixture',
  objectives: { rtoMinutes: 60, rpoMinutes: 30, approved: true },
};

// Named no components ⇒ workspace-scoped evidence (see coverage.js).
const baseTest = {
  id: 'tst_1', name: 'Full-estate drill', type: 'game-day', status: 'passed',
  date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
  results: { rtaMinutes: 33, rpaMinutes: 5 },
};

const numbersFor = (t) => measuredNumbers(workspace, [t], null, { components: [] });

test('cleanRun that was never recorded is null, not false', () => {
  const n = numbersFor(baseTest);
  assert.equal(n.rta.test.cleanRun, null,
    'an unrecorded cleanRun was collapsed to a boolean');
});

test('an unrecorded cleanRun does not caveat the verdict', () => {
  const n = numbersFor(baseTest);
  assert.equal(n.verdict.overall, 'met');
  assert.equal(n.rta.isAchievement, true);
});

test('an unrecorded cleanRun never claims manual intervention', () => {
  const n = numbersFor(baseTest);
  const prose = [n.rta.note, n.rpa.note, ...(n.warnings || [])].join(' ');
  assert.doesNotMatch(prose, /manual intervention/i,
    'the product invented a control failure that never happened');
  assert.doesNotMatch(prose, /improvisation/i);
  assert.doesNotMatch(prose, /not clean/i);
});

test('cleanRun explicitly false STILL caveats — the real signal is intact', () => {
  const n = numbersFor({ ...baseTest, results: { ...baseTest.results, cleanRun: false } });
  assert.equal(n.rta.test.cleanRun, false);
  assert.equal(n.verdict.overall, 'met-with-caveats');
  assert.equal(n.rta.isAchievement, false);
  assert.match([n.rta.note, ...(n.warnings || [])].join(' '), /manual intervention|not clean/i);
});

test('cleanRun explicitly true is an achievement', () => {
  const n = numbersFor({ ...baseTest, results: { ...baseTest.results, cleanRun: true } });
  assert.equal(n.rta.test.cleanRun, true);
  assert.equal(n.verdict.overall, 'met');
  assert.equal(n.rta.isAchievement, true);
});

test('a top-level cleanRun still wins over the nested one', () => {
  const n = numbersFor({ ...baseTest, cleanRun: false, results: { ...baseTest.results, cleanRun: true } });
  assert.equal(n.rta.test.cleanRun, false);
});

// The server and the browser must not disagree about the same record — that
// divergence is the whole reason these two modules are kept in step.
test('server and browser agree on an unrecorded cleanRun', () => {
  const server = numbersFor(baseTest);
  const fn = browser.measuredNumbers || browser.default;
  if (typeof fn !== 'function') return; // twin exposes a different entry point
  const web = fn(workspace, [baseTest], null, { components: [] });
  // The twin carries cleanRun on the SLOT (`rta.cleanRun`); the server carries
  // it on the evidence (`rta.test.cleanRun`). Different shapes, same fact — so
  // compare the fact, and pin the verdict, which is what a reader sees.
  const webClean = web.rta.cleanRun ?? (web.rta.test ? web.rta.test.cleanRun : null) ?? null;
  assert.equal(webClean, server.rta.test.cleanRun,
    'server and browser disagree about an unrecorded clean run');
  assert.equal(web.verdict.overall, server.verdict.overall);
});
