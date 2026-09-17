// A cut-off AI answer must not read as "this document had nothing in it".
//
//   node --test test/
//
// Found by running the real thing: ~900 words of meeting notes through the
// `general` ingest flow came back as `operations: 0` with the message "The AI
// did not return parseable JSON". The model had in fact read the document
// correctly — its own summary named every item it intended to propose — and the
// reply was cut off at 9,657 characters mid-string. The caller could not tell
// that from a document with nothing to say, which is the dangerous part: a
// half-read BIA looks exactly like an irrelevant one.
//
// A later run of the SAME document returned 13,119 characters complete, so this
// is intermittent rather than a fixed ceiling — which is why the fix is detect
// + retry once, not a bigger buffer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksTruncated } from '../server/lib/ai-bridge.js';

test('an object cut off mid-string is truncated', () => {
  assert.equal(looksTruncated('{"summary":"the run was cut off right here'), true);
});

test('an array cut off mid-element is truncated', () => {
  assert.equal(looksTruncated('{"operations":[{"op":"create"},{"op":"upda'), true);
});

test('a complete object is not truncated', () => {
  assert.equal(looksTruncated('{"operations":[],"warnings":[]}'), false);
});

test('prose with no JSON at all is not truncated — it is malformed', () => {
  // This distinction is the point: malformed must NOT be retried, because the
  // model produced something it considers finished and will produce it again.
  assert.equal(looksTruncated('I could not read that document.'), false);
});

test('an empty response is not truncated — it is empty', () => {
  assert.equal(looksTruncated(''), false);
  assert.equal(looksTruncated('   \n  '), false);
});

test('a closing brace INSIDE a string does not fool the detector', () => {
  assert.equal(looksTruncated('{"note":"use } to close the block"}'), false);
});

test('an escaped quote does not fool the detector', () => {
  assert.equal(looksTruncated('{"quote":"she said \\"yes\\" firmly"}'), false);
});

test('trailing prose after a closed object is not truncated', () => {
  assert.equal(looksTruncated('{"a":1}\n\nHope that helps.'), false);
});

test('an unclosed brace inside a string is not a truncation', () => {
  // The whole object closes; the stray brace lives in a value.
  assert.equal(looksTruncated('{"pattern":"^\\\\{[a-z]+"}'), false);
});
