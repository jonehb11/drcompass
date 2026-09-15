// Export routes: xlsx workbook, per-sheet CSVs (Google Sheets import path),
// runbook markdown, and an everything-bundle (JSON — no zip deps allowed).
import { Router } from 'express';
import { buildWorkbook, csvDataset, CSV_SHEETS } from '../lib/xlsx-gen.js';
import * as store from '../store.js';

const router = Router();
export default router;

const today = () => new Date().toISOString().slice(0, 10);
const safeName = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';

// ------------------------------------------------------------------- CSV

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv({ headers, rows }) {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// ------------------------------------------------------------- runbook md

function mdEscapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function stepSection(s, label) {
  const lines = [`### ${label} — ${s.layer ? `[${s.layer}] ` : ''}${s.title || '(untitled step)'}`, ''];
  const meta = [];
  if (s.owner) meta.push(`**Owner:** ${s.owner}`);
  if (typeof s.estMinutes === 'number') meta.push(`**Est:** ${s.estMinutes} min`);
  if (s.gate) meta.push('**GATE** — do not proceed until the verify below passes');
  if (meta.length) lines.push(meta.join(' · '), '');
  if (s.detail) lines.push(s.detail, '');
  if (s.command) lines.push('```', s.command, '```', '');
  if (s.verify || s.pass) {
    lines.push(`**Verify:** ${s.verify || '—'}`);
    lines.push(`**Pass when:** ${s.pass || '—'}`, '');
  }
  if (s.record) lines.push(`**Record:** ${s.record}`, '');
  return lines;
}

function runbookMarkdown(meta, rb, tests) {
  const lines = [`# ${rb.name}`, ''];
  lines.push(`> Workspace: **${meta.name}** · primary \`${meta.regions?.primary || '?'}\` → recovery \`${meta.regions?.recovery || '?'}\``, '');
  lines.push('| | |', '| --- | --- |');
  lines.push(`| Tooling | ${mdEscapeCell(rb.tooling || '—')} |`);
  lines.push(`| Scenario | ${mdEscapeCell(rb.scenario || '—')} |`);
  lines.push(`| Audience | ${mdEscapeCell(rb.audience || '—')} |`);
  lines.push(`| Steps | ${(rb.steps || []).length} (+ ${(rb.rollback || []).length} rollback) |`);
  const linked = (rb.linkedTestIds || [])
    .map((id) => tests.find((t) => t.id === id)?.name || id).join(', ');
  if (linked) lines.push(`| Linked tests | ${mdEscapeCell(linked)} |`);
  if (rb.updatedAt) lines.push(`| Updated | ${mdEscapeCell(String(rb.updatedAt).slice(0, 10))} |`);
  lines.push('');

  if ((rb.preconditions || []).length) {
    lines.push('## Preconditions', '');
    for (const p of rb.preconditions) lines.push(`- ${p}`);
    lines.push('');
  }

  lines.push('## Steps', '');
  (rb.steps || []).forEach((s, i) => lines.push(...stepSection(s, `Step ${i + 1}`)));

  if ((rb.rollback || []).length) {
    lines.push('## Rollback', '');
    rb.rollback.forEach((s, i) => lines.push(...stepSection(s, `Rollback ${i + 1}`)));
  }

  if (rb.notes) lines.push('## Notes', '', rb.notes, '');

  lines.push('## Sign-off (fill in during execution)', '');
  lines.push('| Field | Value |', '| --- | --- |');
  for (const f of ['T0 — event declared / test started', 'T — first access restored',
    'T1 — success bar met', 'RTA (minutes)', 'RPA (minutes)', 'Clean run? (yes/no)',
    'Operator', 'Approved by']) {
    lines.push(`| ${f} | ____________ |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ----------------------------------------------------------------- routes

router.get('/w/:ws/export/xlsx', async (req, res, next) => {
  try {
    const wb = await buildWorkbook(req.params.ws);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.ws)}-dr-compass-${today()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.get('/w/:ws/export/csv/:sheet', (req, res, next) => {
  try {
    const csv = toCsv(csvDataset(req.params.ws, req.params.sheet));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.ws)}-${safeName(req.params.sheet)}-${today()}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/w/:ws/export/runbook/:id.md', (req, res, next) => {
  try {
    const meta = store.getWorkspace(req.params.ws);
    const runbooks = store.getCollection(req.params.ws, 'runbooks');
    const tests = store.getCollection(req.params.ws, 'tests');
    const rb = runbooks.find((r) => r.id === req.params.id);
    if (!rb) throw store.httpError(404, `no runbook '${req.params.id}'`);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.ws)}-runbook-${safeName(rb.name)}.md"`);
    res.send(runbookMarkdown(meta, rb, tests));
  } catch (e) { next(e); }
});

router.get('/w/:ws/export/bundle', (req, res, next) => {
  try {
    const slug = req.params.ws;
    const meta = store.getWorkspace(slug);
    const tests = store.getCollection(slug, 'tests');
    const files = [];
    for (const sheet of CSV_SHEETS) {
      const ds = csvDataset(slug, sheet);
      if (ds.rows.length) files.push({ name: `${sheet}.csv`, content: toCsv(ds) });
    }
    for (const rb of store.getCollection(slug, 'runbooks')) {
      files.push({ name: `runbook-${safeName(rb.name) || rb.id}.md`, content: runbookMarkdown(meta, rb, tests) });
    }
    files.push({ name: 'workspace.json', content: JSON.stringify(meta, null, 2) + '\n' });
    res.json({ generatedAt: new Date().toISOString(), files });
  } catch (e) { next(e); }
});
