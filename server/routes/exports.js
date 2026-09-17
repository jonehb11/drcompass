// Export routes: xlsx workbook, per-sheet CSVs (Google Sheets import path),
// runbook markdown, and an everything-bundle (JSON — no zip deps allowed).
import { Router } from 'express';
import {
  buildWorkbook, csvDataset, CSV_SHEETS, serviceClosure, scopeSelection,
  executiveSummaryModel,
} from '../lib/xlsx-gen.js';
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

// ------------------------------------------------------ executive summary md
//
// Same model as the Executive Summary sheet (executiveSummaryModel), so the
// workbook's first sheet and the DR Package's EXECUTIVE-SUMMARY.md can never
// tell different stories. Numbers that were never measured say so.

const mins = (v) => (v == null ? null : `${v} min`);
const orText = (v, fallback) => (v == null ? fallback : v);
const join = (arr, sep = ', ') => (arr || []).filter(Boolean).join(sep);

function executiveMarkdown(x) {
  const L = [];
  const w = x.workspace;
  const s = x.service;
  const n = x.numbers;

  L.push(`# Executive summary — ${s ? s.name : w.name}`, '');
  L.push(`> ${s ? `Service DR readiness inside **${w.name}**` : 'DR readiness for the whole workspace'}`
    + ` · generated ${w.generated} by DR Compass · every number below is computed from the workspace, nothing is estimated.`, '');

  // ---- what this is ----
  L.push('## What this covers', '');
  if (s) {
    L.push(`**${s.name}** — ${join([s.kind, s.category], ' · ') || 'no kind recorded'}`
      + `${s.tier != null ? `, Tier ${s.tier}` : ''}. Owner: ${s.owner}.`, '');
    if (s.description) L.push(s.description, '');
    L.push('| | |', '| --- | --- |');
    L.push(`| Restore layer | ${mdEscapeCell(s.layerLabel || s.layer || 'not set')} |`);
    L.push(`| In recovery scope | ${s.inRecoveryScope} |`);
    L.push(`| Recovery mechanism | ${mdEscapeCell(join([s.drStrategy, s.replication], ' · ') || 'not recorded')} |`);
    L.push(`| Per-component RPO | ${orText(mins(s.rpoMinutes), 'not recorded')} |`);
    L.push(`| Depends on | ${s.needs.length} component(s) that must come back first |`);
    L.push(`| Depended on by | ${s.neededBy.length} component(s) — the blast radius while it is down |`);
    L.push(`| Regions | \`${w.primaryRegion || '?'}\` → \`${w.recoveryRegion || '?'}\` |`);
    L.push(`| Workspace strategy | ${mdEscapeCell(w.strategyName || 'not set')} |`);
    if (w.tooling.length) L.push(`| Tooling | ${mdEscapeCell(w.tooling.map((t) => t.label).join('; '))} |`);
    L.push('');
  } else {
    if (w.description) L.push(w.description, '');
    L.push('| | |', '| --- | --- |');
    L.push(`| Workspace | ${mdEscapeCell(w.name)}${w.org ? ` (${mdEscapeCell(w.org)})` : ''} |`);
    L.push(`| Components tracked | ${x.inventory.total} |`);
    L.push(`| Regions | \`${w.primaryRegion || '?'}\` → \`${w.recoveryRegion || '?'}\` |`);
    L.push(`| DR strategy | ${mdEscapeCell(w.strategyName || 'not set')}${w.strategyOption ? ` — typically RTO ${mdEscapeCell(w.strategyOption.rto)}, RPO ${mdEscapeCell(w.strategyOption.rpo)}` : ''} |`);
    if (w.tooling.length) L.push(`| Tooling | ${mdEscapeCell(w.tooling.map((t) => t.label).join('; '))} |`);
    L.push(`| Generated | ${w.generated} |`);
    L.push('');
  }

  // ---- restore order, for a service package ----
  if (s && s.needs.length) {
    L.push(`## What ${s.name} needs to come back — in restore order`, '');
    L.push('| Layer | Must come back first | Recovery posture |', '| --- | --- | --- |');
    for (const dep of s.needs) {
      L.push(`| ${dep.layer || '—'} | ${mdEscapeCell(dep.name)} | ${mdEscapeCell(dep.posture)} |`);
    }
    L.push('');
  }
  if (s && s.neededBy.length) {
    L.push(`## What breaks while ${s.name} is down`, '');
    for (const dep of s.neededBy) {
      L.push(`- ${dep.name}${dep.tier != null ? ` (Tier ${dep.tier}` : ''}${dep.tier != null && dep.layer ? `, ${dep.layer})` : dep.tier != null ? ')' : ''} — ${dep.owner}`);
    }
    L.push('');
  }

  // ---- the honest numbers ----
  L.push('## The honest numbers', '');
  L.push('| | Value | What it is |', '| --- | --- | --- |');
  L.push(`| RTO target | ${orText(mins(n.rtoMinutes), '**not set**')} | Target${n.approved ? ', approved by the business' : ' — **not yet approved by the business**'} |`);
  L.push(`| RPO target | ${orText(mins(n.rpoMinutes), '**not set**')} | Target${n.approved ? ', approved by the business' : ' — **not yet approved by the business**'} |`);
  // The row label, the value and the explanation all come from the model's
  // state (executiveSummaryModel → numbers.rtaState / rtaStamp / rtaWhat).
  // "Achieved" used to be hardcoded here, so a hand-typed 47 printed as
  // "Achieved, per workspace objectives — inside the target".
  const numberRow = (label, state, minutes, stamp, what) => {
    const rowLabel = state === 'measured' ? `${label} measured`
      : state === 'declared' ? `${label} **recorded by hand** (not measured)`
        : `${label} **unmeasured**`;
    const value = minutes == null ? '**not measured yet**'
      : `${mins(minutes)}${stamp ? ` _(${mdEscapeCell(stamp)})_` : ''}`;
    L.push(`| ${rowLabel} | ${value} | ${mdEscapeCell(what || '')} |`);
  };
  numberRow('RTA', n.rtaState, n.rtaMinutes, n.rtaStamp, n.rtaWhat);
  numberRow('RPA', n.rpaState, n.rpaMinutes, n.rpaStamp, n.rpaWhat);
  L.push('');
  L.push('RTO/RPO are targets. RTA/RPA are evidence **only when a test that passed produced them** — a number '
    + 'typed in by hand is a note to self, not a measurement. A target nobody has met is not a recovery capability: '
    + 'when someone asks how fast you can recover, quote the measured number and name the test that produced it.', '');
  if (n.unprovenRun) {
    L.push(`> Nothing has been measured yet. The most recent run carrying numbers, **${mdEscapeCell(n.unprovenRun.name)}**`
      + `${n.unprovenRun.date ? ` (${n.unprovenRun.date})` : ''}, is recorded as **${mdEscapeCell(n.unprovenRun.status)}** — `
      + 'a run that did not pass has a time to failure, not a recovery time.', '');
  }
  if (n.notes) L.push(`> ${String(n.notes).replace(/\r?\n/g, ' ')}`, '');

  // ---- risks ----
  L.push(`## Top risks${x.openGapCount > x.risks.length ? ` (${x.risks.length} of ${x.openGapCount} open)` : ''}`, '');
  if (x.risks.length) {
    L.push('| Severity | Risk | Owner | Component | Ticket |', '| --- | --- | --- | --- | --- |');
    for (const r of x.risks) {
      L.push(`| ${r.severity} | ${mdEscapeCell(r.title)} | ${mdEscapeCell(r.owner)} | ${mdEscapeCell(r.component)} | ${mdEscapeCell(r.ticket || '—')} |`);
    }
  } else {
    L.push('No open gaps are recorded. Either the plan is genuinely clean, or the gaps have not been written down.');
  }
  L.push('');

  // ---- test history ----
  L.push('## Test history — what has actually been proven', '');
  if (x.tests.length) {
    L.push('| Date | Test | Result | RTA | RPA | Findings |', '| --- | --- | --- | --- | --- | --- |');
    for (const t of x.tests.slice(0, 8)) {
      L.push(`| ${t.date || '—'} | ${mdEscapeCell(t.name)} | ${t.statusLabel} | ${orText(mins(t.rtaMinutes), 'unmeasured')} `
        + `| ${orText(mins(t.rpaMinutes), 'unmeasured')} | ${t.findings}${t.blockers ? ` (${t.blockers} blocker)` : ''} |`);
    }
  } else {
    L.push('**No recovery tests have been recorded.** An untested plan is a hypothesis: nothing in the numbers above can be defended yet.');
  }
  L.push('');

  // ---- next actions ----
  L.push('## Next actions', '');
  if (x.actions.length) {
    x.actions.forEach((a, i) => {
      L.push(`${i + 1}. **${a.action}** — ${a.why} _(owner: ${a.owner})_`);
    });
  } else {
    L.push('No actions fall out of the current data: no open blockers, targets approved, tests passing, scope decided.');
  }
  L.push('');
  L.push('---', '');
  L.push(`Generated by DR Compass from workspace \`${w.slug || ''}\` on ${w.generated}. `
    + 'This is a point-in-time snapshot — regenerate before a test or a review.', '');
  return L.join('\n');
}

// --------------------------------------------------------- runbook quick ref
//
// For someone working from a terminal mid-incident: steps, commands, verify and
// pass criteria. No prose, no tables, no markdown syntax to read around.

function runbookQuickRef(meta, rb) {
  const rule = '='.repeat(72);
  const thin = '-'.repeat(72);
  const L = [];
  const wrapIndent = (label, text, indent = '    ') => {
    const body = String(text ?? '').replace(/\r?\n/g, ' ').trim();
    if (!body) return;
    L.push(`${indent}${label}${body}`);
  };
  L.push(rule);
  L.push(`  ${rb.name || 'Runbook'}`);
  L.push(`  ${meta?.name || ''}  |  ${meta?.regions?.primary || '?'} -> ${meta?.regions?.recovery || '?'}`);
  const bits = [rb.tooling, rb.scenario, rb.audience].filter(Boolean).join('  |  ');
  if (bits) L.push(`  ${bits}`);
  L.push(`  QUICK REFERENCE — steps, commands and checks only. Full detail: the .md in runbooks/.`);
  L.push(rule, '');

  if ((rb.preconditions || []).length) {
    L.push('PRECONDITIONS', thin);
    for (const p of rb.preconditions) L.push(`  [ ] ${String(p).replace(/\r?\n/g, ' ')}`);
    L.push('');
  }

  const block = (s, label) => {
    const gate = s.gate ? '  *** GATE — do not proceed until the check passes ***' : '';
    L.push(`${label}${s.layer ? ` [${s.layer}]` : ''}  ${s.title || '(untitled step)'}${gate}`);
    const meta2 = [s.owner ? `owner: ${s.owner}` : '', typeof s.estMinutes === 'number' ? `est: ${s.estMinutes} min` : '']
      .filter(Boolean).join('  |  ');
    if (meta2) L.push(`    (${meta2})`);
    if (s.command) {
      for (const cmdLine of String(s.command).split(/\r?\n/)) L.push(`    $ ${cmdLine}`);
    }
    wrapIndent('check:  ', s.verify);
    wrapIndent('pass:   ', s.pass);
    wrapIndent('record: ', s.record);
    L.push('');
  };

  L.push('STEPS', thin);
  (rb.steps || []).forEach((s, i) => block(s, `  ${String(i + 1).padStart(2)}.`));
  if ((rb.rollback || []).length) {
    L.push('ROLLBACK', thin);
    rb.rollback.forEach((s, i) => block(s, `  R${String(i + 1).padStart(2)}.`));
  }

  L.push('SIGN-OFF', thin);
  for (const f of ['T0 - event declared / test started', 'T  - first access restored',
    'T1 - success bar met', 'RTA (minutes)', 'RPA (minutes)', 'Clean run? (yes/no)',
    'Operator', 'Approved by']) {
    L.push(`  ${f.padEnd(36, '.')} ______________________`);
  }
  L.push('');
  return L.join('\n');
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

// The executive one-pager as markdown — the same model the workbook's first
// sheet renders. ?componentId= scopes it to one service.
router.get('/w/:ws/export/executive-summary.md', (req, res, next) => {
  try {
    const slug = req.params.ws;
    const scope = scopeFrom(slug, req.query);
    const md = executiveMarkdown(executiveSummaryModel(slug, scope || undefined));
    const stem = scope ? `${safeName(slug)}-${scopeSlug(scope)}` : safeName(slug);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}-executive-summary-${today()}.md"`);
    res.send(md);
  } catch (e) { next(e); }
});

// Plain-text quick reference for one runbook: steps, commands, checks. What you
// want open in a second terminal during an incident.
router.get('/w/:ws/export/runbook/:id.txt', (req, res, next) => {
  try {
    const meta = store.getWorkspace(req.params.ws);
    const rb = store.getCollection(req.params.ws, 'runbooks').find((r) => r.id === req.params.id);
    if (!rb) throw store.httpError(404, `no runbook '${req.params.id}'`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.ws)}-runbook-${safeName(rb.name)}-quickref.txt"`);
    res.send(runbookQuickRef(meta, rb));
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
