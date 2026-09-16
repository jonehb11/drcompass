// Export routes: xlsx workbook, per-sheet CSVs (Google Sheets import path),
// runbook markdown, and an everything-bundle (JSON — no zip deps allowed).
import { Router } from 'express';
import { buildWorkbook, csvDataset, CSV_SHEETS, serviceClosure, scopeSelection } from '../lib/xlsx-gen.js';
import * as store from '../store.js';

const router = Router();
export default router;

const today = () => new Date().toISOString().slice(0, 10);
const safeName = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';

// ----------------------------------------------------------------- scoping

// ?componentId=cmp_x  → that component + its dependency closure + direct dependents.
// ?componentIds=a,b   → exactly those components (no closure walk).
// Neither → null (whole workspace; output identical to pre-scope behavior).
function scopeFrom(slug, query) {
  const one = query.componentId ? String(query.componentId).trim() : '';
  const list = query.componentIds
    ? String(query.componentIds).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!one && !list.length) return null;
  const components = store.getCollection(slug, 'components');
  if (one) {
    const cl = serviceClosure(components, one);
    return {
      componentIds: cl.ids, root: cl.root, rootId: cl.root.id, rootName: cl.root.name,
      depsCount: cl.depsCount, dependentsCount: cl.dependentsCount,
    };
  }
  const root = components.find((c) => c.id === list[0]) || null;
  return {
    componentIds: list, root, rootId: root?.id || list[0], rootName: root?.name || '',
    depsCount: null, dependentsCount: null,
  };
}

const scopeSlug = (scope) => safeName(scope.rootName || scope.rootId);

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
    const slug = req.params.ws;
    const scope = scopeFrom(slug, req.query);
    const wb = await buildWorkbook(slug, scope || undefined);
    const name = scope
      ? `${safeName(slug)}-${scopeSlug(scope)}-dr-package-${today()}.xlsx`
      : `${safeName(slug)}-dr-compass-${today()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.get('/w/:ws/export/csv/:sheet', (req, res, next) => {
  try {
    const slug = req.params.ws;
    const scope = scopeFrom(slug, req.query);
    const csv = toCsv(csvDataset(slug, req.params.sheet, scope || undefined));
    const stem = scope ? `${safeName(slug)}-${scopeSlug(scope)}` : safeName(slug);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}-${safeName(req.params.sheet)}-${today()}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

// Package preview: what a scoped export would contain. The UI uses this to list
// contents and to know which runbook/diagram artifacts to fetch.
router.get('/w/:ws/export/scope/:componentId', (req, res, next) => {
  try {
    const slug = req.params.ws;
    const components = store.getCollection(slug, 'components');
    const cl = serviceClosure(components, req.params.componentId); // 404s on unknown
    const sel = scopeSelection(slug, { componentIds: cl.ids });
    const byId = new Map(components.map((c) => [c.id, c]));
    res.json({
      root: { id: cl.root.id, name: cl.root.name },
      componentIds: cl.ids,
      components: cl.ids.map((id) => byId.get(id)).filter(Boolean).map((c) => ({
        id: c.id, name: c.name, category: c.category || '', tier: c.tier ?? null,
      })),
      runbookIds: sel.runbookIds,
      testIds: sel.testIds,
      gapIds: sel.gapIds,
      depsCount: cl.depsCount,
      dependentsCount: cl.dependentsCount,
    });
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
    const scope = scopeFrom(slug, req.query);
    const meta = store.getWorkspace(slug);
    const tests = store.getCollection(slug, 'tests');
    const generatedAt = new Date().toISOString();
    const sel = scope ? scopeSelection(slug, scope) : null;
    const files = [];
    for (const sheet of CSV_SHEETS) {
      const ds = csvDataset(slug, sheet, scope || undefined);
      if (ds.rows.length) files.push({ name: `${sheet}.csv`, content: toCsv(ds) });
    }
    const includedRunbooks = store.getCollection(slug, 'runbooks')
      .filter((rb) => !sel || sel.runbookIds.includes(rb.id));
    for (const rb of includedRunbooks) {
      files.push({ name: `runbook-${safeName(rb.name) || rb.id}.md`, content: runbookMarkdown(meta, rb, tests) });
    }
    files.push({ name: 'workspace.json', content: JSON.stringify(meta, null, 2) + '\n' });
    if (scope) {
      files.push({
        name: 'scope.json',
        content: JSON.stringify({
          root: scope.root ? { id: scope.root.id, name: scope.root.name } : { id: scope.rootId, name: scope.rootName },
          componentIds: scope.componentIds.filter((id) => sel.componentIds.includes(id)),
          generatedAt,
        }, null, 2) + '\n',
      });
    }
    res.json({ generatedAt, files });
  } catch (e) { next(e); }
});
