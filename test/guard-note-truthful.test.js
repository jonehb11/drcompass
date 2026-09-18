// A guard note must describe something that actually happened.
//
//   node --test test/
//
// Found by the MCP build agent while wiring the write path. `guardData` for
// `update-workspace` reported "Forced objectives.approved to false" whenever
// `approved === true` arrived — but only PERFORMED the downgrade when a target
// (`rtoMinutes`/`rpoMinutes`) came with it. So `{objectives:{approved:true}}`
// on its own landed APPROVED while the notes told the reviewer it had been
// blocked.
//
// Every other hole closed in this guard was a silent strip: the product did
// less than it claimed. This one was the inverse and worse — the audit trail
// asserted a block at the moment the claim was written. A reviewer reading
// guardNotes to decide whether to trust a change was being told the opposite of
// the truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardOperations } from '../server/lib/ai-bridge.js';

const approvalNote = (notes) =>
  (notes || []).find((n) => /approved to false/i.test(String(n)));

test('approved:true alone is actually downgraded, not just reported', () => {
  const notes = [];
  const ops = guardOperations('bia', [
    { op: 'update-workspace', data: { objectives: { approved: true } } },
  ], notes, 'a-document.pdf');

  const obj = ops[0].data.objectives;
  assert.equal(obj.approved, false,
    'the guard said it forced approved to false and then wrote approved: true');
  assert.ok(approvalNote(notes), 'the downgrade happened but was not reported');
});

test('approved:true alongside a target is still downgraded', () => {
  const notes = [];
  const ops = guardOperations('bia', [
    { op: 'update-workspace', data: { objectives: { approved: true, rtoMinutes: 30 } } },
  ], notes, 'a-document.pdf');

  assert.equal(ops[0].data.objectives.approved, false);
  assert.equal(ops[0].data.objectives.rtoMinutes, 30, 'the target itself is kept — it is a proposal');
  assert.ok(approvalNote(notes));
});

test('approved:false is left alone and reported as nothing', () => {
  const notes = [];
  const ops = guardOperations('bia', [
    { op: 'update-workspace', data: { objectives: { approved: false, rtoMinutes: 30 } } },
  ], notes, 'a-document.pdf');

  assert.equal(ops[0].data.objectives.approved, false);
  assert.equal(approvalNote(notes), undefined,
    'claiming a downgrade that was not needed is the same class of untruth');
});

test('every guard note about the approval flag matches the data it left behind', () => {
  // The general property, so a future edit cannot reintroduce the split: if the
  // note is present, the flag must be false.
  for (const objectives of [
    { approved: true },
    { approved: true, rtoMinutes: 45 },
    { approved: true, rpoMinutes: 10 },
    { approved: true, rtoMinutes: 45, rpoMinutes: 10 },
  ]) {
    const notes = [];
    const ops = guardOperations('general', [{ op: 'update-workspace', data: { objectives } }], notes, 'doc');
    const wrote = ops[0].data.objectives.approved;
    if (approvalNote(notes)) {
      assert.equal(wrote, false, `note claimed a downgrade for ${JSON.stringify(objectives)} but wrote ${wrote}`);
    }
  }
});
