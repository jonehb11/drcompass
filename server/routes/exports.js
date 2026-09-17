// Export routes: xlsx workbook, per-sheet CSVs (Google Sheets import path),
// runbook markdown, and an everything-bundle (JSON — no zip deps allowed).
import { Router } from 'express';
import {
  buildWorkbook, csvDataset, CSV_SHEETS, serviceClosure, scopeSelection,
  executiveSummaryModel,
  failoverBrief,
} from '../lib/xlsx-gen.js';
import { resolveExportScope, exportScopeMeta, visibleComponentIds } from '../lib/export-scope.js';
import { auditCutoverGate, onFailOf } from '../../web/js/cutover.js';
import * as store from '../store.js';

const router = Router();
export default router;

const today = () => new Date().toISOString().slice(0, 10);
const safeName = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';

// ----------------------------------------------------------------- scoping
//
// Every export endpoint takes the same narrowing knobs
// (docs/ENV-SERVICE-MODEL.md §3):
//
//   ?envId=prod             one environment (id, slug or name; 404 if unknown)
//   ?serviceId=adjudication one service AND its sub-services
//   ?componentId=cmp_x      that component + its dependency closure + direct dependents
//   ?componentIds=a,b       exactly those components
//   none of them            the whole workspace, byte-identical to before
//
// The resolution itself lives in ../lib/export-scope.js — including the
// dependency closure an env/service scope drags along, and the accounting of
// what the narrowing HIDES, which every scoped artifact here prints.
const scopeFrom = (slug, query) => resolveExportScope(slug, query || {});

// The scope half of a filename: `prod-adjudication`, `prod-adjudication-aurora`,
// or — component-only scope, exactly as before — `aurora`.
const scopeSlug = (scope) => safeName(scope.fileStem || scope.rootName || scope.rootId);

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

// The pre-cutover gate has to survive the export, not just the editor. An
// operator running a failover at 3am is reading the .md or the quick reference,
// and the checks that must pass before traffic moves are exactly what they need
// in front of them. `audit` is auditCutoverGate(rb) for this runbook, or null.
function gateLinesFor(s, i, audit) {
  if (!audit) return { banner: null, tests: [], warnings: [] };
  const blocked = (audit.blockedIndexes || []).includes(i);
  const tests = Array.isArray(s.tests) ? s.tests : [];
  let banner = null;
  if (blocked) {
    banner = '⛔ **BLOCKED** — this step moves live traffic and no verification gate above it has passed. '
      + 'Do not run it until the gate does.';
  } else if (tests.length) {
    const blocking = tests.filter((t) => onFailOf(t) === 'block').length;
    banner = `**PRE-CUTOVER GATE** — ${tests.length} check(s), ${blocking} of them blocking. `
      + 'Every blocking check must pass, with evidence, before the next traffic step.';
  }
  return { banner, tests, warnings: gateWarningsFor(audit, i) };
}

// ---- WARNING-SEVERITY FINDINGS (validation HIGH 6) -------------------------
//
// `audit.ok` is `!findings.some(f => f.severity === 'err')`. It means "no
// ERROR-severity finding" — it does NOT mean "audited clean", and three of the
// audit's finding kinds are warnings: `approval-before-verification`,
// `no-blocking-test` and `no-pass-criterion`. Guarding the exports on
// `audit.ok` is how a runbook whose named approval comes BEFORE the evidence it
// approves exported with no notice at all, and how a gate made only of advisory
// checks — a gate that cannot fail — unblocked an L7 step silently.
//
// So both formats render from the FINDINGS LIST. `audit.ok` keeps its meaning
// for every other caller (web/js/cutover.js, the editor, xlsx-gen), and a
// warning is rendered as a warning: never as a BLOCKED.

/**
 * Warning-severity findings an operator standing at step `i` has to read.
 * Two sources, both read out of the audit rather than re-derived here: the
 * findings filed AGAINST this step, and — for a traffic step — the findings
 * filed against the verification gates it is standing behind. "The gate above
 * you cannot fail" is a fact about this cutover, not only about the gate step.
 */
function gateWarningsFor(audit, i) {
  if (!audit || i < 0) return [];
  const warn = (audit.findings || []).filter((f) => f.severity === 'warn');
  const out = warn.filter((f) => f.index === i).map((f) => f.text);
  const isTraffic = (audit.trafficSteps || []).some((t) => t.index === i);
  if (isTraffic) {
    const gates = new Set((audit.verificationSteps || []).filter((v) => v.index < i).map((v) => v.index));
    for (const f of warn) {
      if (f.index !== i && gates.has(f.index)) {
        out.push(`the verification gate this step stands behind is not sound — ${f.text}`);
      }
    }
  }
  return out;
}

// Greedy wrap for the plain-text format, which has no reflow of its own.
function wrapText(text, indent = 2, width = 100) {
  const pad = ' '.repeat(indent);
  const out = [];
  let line = '';
  for (const word of String(text).replace(/\r?\n/g, ' ').split(/\s+/).filter(Boolean)) {
    if (line && (line.length + 1 + word.length) > width) { out.push(pad + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(pad + line);
  return out;
}

/** Split one audit into what the "before you run this" block has to say, or null. */
function auditNotice(audit) {
  const findings = (audit && Array.isArray(audit.findings)) ? audit.findings : [];
  const errs = findings.filter((f) => f.severity === 'err');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (!errs.length && !warns.length) return null;
  return { findings, errs, warns, blocking: errs.length > 0 };
}

// One sentence per notice, so the .md and the .txt cannot tell different
// stories about the same audit. `what` names the sequence being audited.
function noticeIntro(notice, what) {
  if (notice.blocking) {
    return `The cutover gate in ${what} did not audit clean. Read these before the window opens —`
      + ' each one is a way this plan can move traffic to something nobody proved:';
  }
  const n = notice.warns.length;
  return `Nothing in ${what} is BLOCKED — no step moves traffic without a populated gate in front of it. `
    + `But it did not audit clean either: ${n === 1 ? 'the warning' : `the ${n} warnings`} below `
    + `${n === 1 ? 'describes' : 'describe'} a gate that can pass without proving what it is there to prove. `
    + `${n === 1 ? 'It does not stop' : 'None of them stops'} you running this; `
    + `${n === 1 ? 'it has' : 'every one of them has'} to be answered before you trust the result:`;
}

// The finding list, markdown. An ERROR line is exactly what it has always been
// (bold, no prefix) — the reviewer verified that rendering. A WARNING is
// labelled as one so it can never be read as a blocker, and an info finding is
// left plain, as before.
function noticeMdLines(notice) {
  return notice.findings.map((f) => {
    if (f.severity === 'err') return `- **${f.text}**`;
    if (f.severity === 'warn') return `- ⚠ **WARNING** — ${f.text}`;
    return `- ${f.text}`;
  });
}

// The same list, plain text. `!!` for an error is unchanged; `! ` stays the
// prefix for everything else, with the word WARNING carrying the distinction.
function noticeTxtLines(notice) {
  return notice.findings.map((f) => {
    const text = String(f.text).replace(/\r?\n/g, ' ');
    if (f.severity === 'err') return `  !! ${text}`;
    if (f.severity === 'warn') return `  !  WARNING — ${text}`;
    return `  !  ${text}`;
  });
}

// ---- THE ROLLBACK PATH (validation LOW) -----------------------------------
//
// `auditCutoverGate` walks `rb.steps` and nothing else, and the two formats
// disagreed about what that meant for `rb.rollback`: runbookMarkdown passed
// `audit = null` (so a rollback step could never be flagged), runbookQuickRef
// kept the FORWARD audit in closure (so rollback step 3 could inherit forward
// step 3's blockedIndex — a label about a different step entirely).
//
// A rollback that moves traffic back is still a traffic move: it cuts customer
// traffic between regions, and the reason a machine must not decide that on its
// own does not stop applying because the direction reversed. So BOTH formats
// now audit the rollback AS ITS OWN SEQUENCE — indexes are rollback-relative,
// findings are about the rollback steps, and the two formats print the same
// thing. It is deliberately a separate audit and not folded into the cutover
// notice: a finding about the flip back is not a reason to stop the flip out.
const rollbackAudit = (rb) => ((rb?.rollback || []).length ? auditCutoverGate({ steps: rb.rollback }) : null);

function stepSection(s, label, i = -1, audit = null) {
  const lines = [`### ${label} — ${s.layer ? `[${s.layer}] ` : ''}${s.title || '(untitled step)'}`, ''];
  const meta = [];
  if (s.owner) meta.push(`**Owner:** ${s.owner}`);
  if (typeof s.estMinutes === 'number') meta.push(`**Est:** ${s.estMinutes} min`);
  if (s.gate) meta.push('**GATE** — do not proceed until the verify below passes');
  if (meta.length) lines.push(meta.join(' · '), '');
  const g = gateLinesFor(s, i, audit);
  if (g.banner) lines.push(g.banner, '');
  for (const w of g.warnings) lines.push(`> ⚠ **WARNING** — ${w}`, '');
  if (g.tests.length) {
    lines.push('| Check | Owner | Pass when | Blocking |', '| --- | --- | --- | --- |');
    for (const t of g.tests) {
      lines.push(`| ${mdEscapeCell(t.name || '—')} | ${mdEscapeCell(t.owner || '—')} `
        + `| ${mdEscapeCell(t.expected || '—')} | ${onFailOf(t) === 'block' ? 'YES' : 'advisory'} |`);
    }
    lines.push('');
  }
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

  const audit = auditCutoverGate(rb);
  const notice = auditNotice(audit);
  if (notice) {
    lines.push('## Before you run this', '');
    lines.push(noticeIntro(notice, 'this runbook'), '');
    lines.push(...noticeMdLines(notice));
    lines.push('');
  }

  lines.push('## Steps', '');
  (rb.steps || []).forEach((s, i) => lines.push(...stepSection(s, `Step ${i + 1}`, i, audit)));

  if ((rb.rollback || []).length) {
    const rbAudit = rollbackAudit(rb);
    lines.push('## Rollback', '');
    const rbNotice = auditNotice(rbAudit);
    if (rbNotice) {
      lines.push('**The rollback path is audited too** — a rollback that moves traffic back is still a traffic move. '
        + 'The step numbers in these findings are ROLLBACK step numbers, and none of them is a reason not to run the '
        + 'cutover above.', '');
      lines.push(noticeIntro(rbNotice, 'the rollback path'), '');
      lines.push(...noticeMdLines(rbNotice));
      lines.push('');
    }
    rb.rollback.forEach((s, i) => lines.push(...stepSection(s, `Rollback ${i + 1}`, i, rbAudit)));
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
// The same four questions, in the same order, off the same model as the
// Executive Summary sheet (executiveSummaryModel): what this is · can we
// recover it · what would stop us · what happens next. Every verdict sentence
// and every row is composed in the model, so this file writes no prose of its
// own and the two formats cannot drift. What the one-pager drops is not
// deleted — it is under "Detail", in the same order the sheet puts it below
// its print line.

const mins = (v) => (v == null ? null : `${v} min`);
const orText = (v, fallback) => (v == null ? fallback : v);
const join = (arr, sep = ', ') => (arr || []).filter(Boolean).join(sep);

// ---- SCOPE BLOCK (env/service exports only) --------------------------------
// Owned by the export-scoping change; nothing above or below it reads these
// lines. Two paragraphs, and neither is optional: what this summary covers, and
// what narrowing to it took out of frame. A scoped package that reads clean
// because the mess is filed against another service is the exact failure this
// block exists to prevent.
function scopeMarkdownBlock(scope) {
  const L = ['## What this summary is scoped to', ''];
  L.push(`**${scope.label || 'Scoped export'}** — ${scope.sentence}`, '');
  if ((scope.contextIds || []).length) {
    L.push(`${(scope.coreIds || []).length} component(s) are assigned to this scope; `
      + `${scope.contextIds.length} more are included because recovering this scope depends on them.`, '');
  }
  for (const wmsg of scope.warnings || []) L.push(`> ${mdEscapeCell(wmsg)}`, '');
  L.push('### What scoping this way hides', '');
  if (scope.hidden && (scope.hidden.blockerOrHighGaps || scope.hidden.failedTests)) {
    L.push('**Read this before you call this package clean.**', '');
  }
  for (const line of scope.hiddenSentences || []) L.push(`- ${line}`);
  L.push('', 'The whole-workspace export is the one that shows everything: '
    + 'rebuild it without `envId`/`serviceId` to see the findings listed above in context.', '');
  return L;
}

function executiveMarkdown(x, scope = null) {
  const L = [];
  const w = x.workspace;
  const s = x.service;
  const n = x.numbers;
  const row = (cells) => L.push(`| ${cells.map(mdEscapeCell).join(' | ')} |`);
  const head = (cells) => { row(cells); L.push(`| ${cells.map(() => '---').join(' | ')} |`); };

  // On a single-component scope the scope label and the subject are the same
  // string, and "— adjudication-service — adjudication-service" reads as a bug.
  const subjectName = s ? s.name : w.name;
  const titleScope = scope?.label && scope.label !== subjectName ? `${scope.label} — ` : '';
  L.push(`# Executive summary — ${titleScope}${subjectName}`, '');

  // ---- the verdict, before anything else. Composed in the model, so the sheet
  // banner and this line are word-for-word the same sentence.
  L.push(`> **${x.verdict.label}** — ${x.verdict.because}`, '');

  // SCOPE: see scopeMarkdownBlock. Absent entirely on an unscoped export.
  if (scope && (scope.envId || scope.serviceId)) L.push(...scopeMarkdownBlock(scope));

  // ---- 1. what this is ----
  L.push('## What this is', '');
  head(['What', 'Value', 'Detail']);
  for (const r of x.identityRows) row([r.name, r.value, r.note]);
  L.push('');

  // ---- 2. can we recover it ----
  L.push('## Can we recover it', '');
  head(['Number', 'Value', 'Where it came from']);
  for (const r of x.numberRows) row([r.name, r.value, r.why]);
  L.push('');

  // ---- 3. what would stop us ----
  L.push(`## What would stop us — ${x.stopperHeadline}`, '');
  if (x.stoppers.length) {
    head(['Blocker or gap', 'Severity', 'Owner']);
    for (const st of x.stoppers) row([st.title, st.severity, st.who]);
  } else if (x.computedRisks) {
    L.push('Nothing is recorded and the risk engine found nothing on the services it scanned — which is still not a passed test.');
  } else {
    L.push('Nothing is written down AND the risk engine did not run. Treat this as unknown, not clean.');
  }
  L.push('');

  // ---- 4. what happens next ----
  L.push('## What happens next', '');
  if (x.actionRows.length) {
    head(['Action', 'Owner', 'Why now']);
    for (const a of x.actionRows.slice(0, 3)) row([`${a.n}. ${a.action}`, a.owner, a.trigger]);
  } else if (x.computedRisks) {
    L.push('No action falls out of the current data — no open blockers, targets approved, tests passing, scope decided.');
  } else {
    L.push('No action falls out of what is written down — but the risk engine did not run, so that is not the same as none.');
  }
  L.push('');

  L.push(`**Where the rest is** — ${x.pointers.join(' · ')}.`, '');

  // ---------------------------------------------------------------- detail
  //
  // Everything the one-pager dropped, in the order the sheet puts it below its
  // print line. Nothing above this rule needs it to be read.
  L.push('---', '', '## Detail', '');
  L.push('> RTO/RPO are targets. RTA/RPA are evidence ONLY when a test that PASSED and covered this subject '
    + 'produced them — a number typed in by hand is a note to self. A target nobody has met is not a recovery '
    + 'capability.', '');

  if (n.notes) {
    L.push('### The note on these numbers', '', String(n.notes).replace(/\r?\n/g, ' '), '');
  }

  if (x.actionRows.length > 3) {
    L.push('### Further actions — derived, below the top three', '');
    for (const a of x.actionRows.slice(3)) {
      L.push(`${a.n}. **${a.action}** — ${a.why} _(owner: ${a.owner})_`);
    }
    L.push('');
  }

  L.push('### Test history — what has actually been proven', '');
  if (x.tests.length) {
    head(['Date', 'Test', 'Result', 'RTA', 'RPA', 'Findings']);
    for (const t of x.tests.slice(0, 8)) {
      row([t.date || '—', t.name, t.statusLabel,
        orText(mins(t.rtaMinutes), 'unmeasured'), orText(mins(t.rpaMinutes), 'unmeasured'),
        `${t.findings}${t.blockers ? ` (${t.blockers} blocker)` : ''}`]);
    }
  } else {
    L.push('**No recovery tests have been recorded.** An untested plan is a hypothesis: nothing in the numbers above can be defended yet.');
  }
  L.push('');

  if (s && s.needs.length) {
    L.push(`### What ${s.name} needs to come back — in restore order`, '');
    head(['Layer', 'Must come back first', 'Recovery posture']);
    for (const dep of s.needs) row([dep.layer || '—', dep.name, dep.posture]);
    L.push('');
  }
  if (s && s.neededBy.length) {
    L.push(`### What breaks while ${s.name} is down`, '');
    for (const dep of s.neededBy) {
      L.push(`- ${dep.name}${dep.tier != null ? ` (Tier ${dep.tier}${dep.layer ? `, ${dep.layer}` : ''})` : ''} — ${dep.owner}`);
    }
    L.push('');
  }

  if (w.description) L.push('### What this workspace is', '', w.description, '');

  L.push(`Generated by DR Compass from workspace \`${w.slug || ''}\` on ${w.generated}.`, '');
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

  const audit = auditCutoverGate(rb);
  const rbAudit = rollbackAudit(rb);

  const block = (s, label, i = -1, a = audit) => {
    const gate = s.gate ? '  *** GATE — do not proceed until the check passes ***' : '';
    L.push(`${label}${s.layer ? ` [${s.layer}]` : ''}  ${s.title || '(untitled step)'}${gate}`);
    const meta2 = [s.owner ? `owner: ${s.owner}` : '', typeof s.estMinutes === 'number' ? `est: ${s.estMinutes} min` : '']
      .filter(Boolean).join('  |  ');
    if (meta2) L.push(`    (${meta2})`);
    // The blocking checks belong HERE — this is the sheet someone reads while
    // the business is down, and a gate that only exists in the editor is not a
    // gate. An unproven traffic step says so in the loudest form this file has.
    const g = gateLinesFor(s, i, a);
    if (g.banner) {
      const blocked = (a?.blockedIndexes || []).includes(i);
      L.push(blocked
        ? '    *** BLOCKED — moves live traffic with no verification gate passed above it. DO NOT RUN. ***'
        : `    *** PRE-CUTOVER GATE — ${g.tests.length} check(s), `
          + `${g.tests.filter((t) => onFailOf(t) === 'block').length} blocking ***`);
    }
    for (const w of g.warnings) L.push(`    !   WARNING — ${String(w).replace(/\r?\n/g, ' ')}`);
    for (const t of g.tests) {
      L.push(`    [ ] ${onFailOf(t) === 'block' ? 'BLOCKING' : 'advisory'}  ${String(t.name || '—').replace(/\r?\n/g, ' ')}`);
      wrapIndent('pass:   ', t.expected, '          ');
      wrapIndent('owner:  ', t.owner, '          ');
    }
    if (s.command) {
      for (const cmdLine of String(s.command).split(/\r?\n/)) L.push(`    $ ${cmdLine}`);
    }
    wrapIndent('check:  ', s.verify);
    wrapIndent('pass:   ', s.pass);
    wrapIndent('record: ', s.record);
    L.push('');
  };

  const notice = auditNotice(audit);
  if (notice) {
    L.push('BEFORE YOU RUN THIS', thin);
    // The same sentence the .md prints, wrapped — one composer, so the two
    // formats cannot describe the same audit differently.
    if (!notice.blocking) L.push(...wrapText(noticeIntro(notice, 'this runbook'), 2, 100));
    L.push(...noticeTxtLines(notice));
    L.push('');
  }

  L.push('STEPS', thin);
  (rb.steps || []).forEach((s, i) => block(s, `  ${String(i + 1).padStart(2)}.`, i));
  if ((rb.rollback || []).length) {
    L.push('ROLLBACK', thin);
    // Audited as its own sequence, exactly as runbookMarkdown does it — see
    // rollbackAudit. The two formats read one audit object apiece and agree.
    const rbNotice = auditNotice(rbAudit);
    if (rbNotice) {
      L.push(...wrapText('The rollback path is audited too: a rollback that moves traffic back is still a traffic '
        + 'move. Step numbers below are ROLLBACK step numbers; none of this stops the cutover above.', 2, 100));
      if (!rbNotice.blocking) L.push(...wrapText(noticeIntro(rbNotice, 'the rollback path'), 2, 100));
      L.push(...noticeTxtLines(rbNotice));
      L.push('');
    }
    rb.rollback.forEach((s, i) => block(s, `  R${String(i + 1).padStart(2)}.`, i, rbAudit));
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
//
// The `/:componentId` form is unchanged, to the byte, for every caller that
// already uses it. The query form below it takes ?envId=/?serviceId=
// (/?componentId=) and answers the same question for an environment or a
// service — that is what the Exports page's env → service → component picker
// reads on every change.
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

router.get('/w/:ws/export/scope', (req, res, next) => {
  try {
    const slug = req.params.ws;
    const scope = scopeFrom(slug, req.query); // 404s on an unknown env/service/component
    const components = store.getCollection(slug, 'components');
    const byId = new Map(components.map((c) => [c.id, c]));
    // An EMPTY scope carries a sentinel id so the workbook comes out empty
    // rather than whole (see export-scope.js); it must never reach a reader.
    const ids = scope ? visibleComponentIds(scope) : components.map((c) => c.id);
    const sel = scopeSelection(slug, { componentIds: ids.length ? ids : scope.componentIds });
    const core = new Set(scope ? scope.coreIds : ids);
    res.json({
      active: !!scope,
      empty: !!scope?.empty,
      root: scope?.rootId ? { id: scope.rootId, name: scope.rootName } : null,
      environment: scope?.envId
        ? { id: scope.envId, name: scope.envName, slug: scope.envSlug, regions: scope.envRegions || null }
        : null,
      service: scope?.serviceId ? { id: scope.serviceId, name: scope.serviceName, slug: scope.serviceSlug } : null,
      label: scope?.label || '',
      fileStem: scope?.fileStem || '',
      description: scope?.sentence || `The whole workspace — all ${components.length} components.`,
      componentIds: ids,
      // `core` = assigned to this scope; `context` = dragged in because the
      // recovery depends on it. The picker prints both so "14 components" is
      // never read as "14 components of adjudication".
      contextComponentIds: scope ? scope.contextIds : [],
      components: ids.map((id) => byId.get(id)).filter(Boolean).map((c) => ({
        id: c.id, name: c.name, category: c.category || '', tier: c.tier ?? null,
        context: !core.has(c.id),
      })),
      runbookIds: sel.runbookIds,
      testIds: sel.testIds,
      gapIds: sel.gapIds,
      depsCount: scope?.depsCount ?? null,
      dependentsCount: scope?.dependentsCount ?? null,
      warnings: scope?.warnings || [],
      hidden: scope?.hidden || null,
      hiddenSentences: scope?.hiddenSentences || [],
    });
  } catch (e) { next(e); }
});

// The executive one-pager as markdown — the same model the workbook's first
// sheet renders. ?componentId= scopes it to one service.
router.get('/w/:ws/export/executive-summary.md', async (req, res, next) => {
  try {
    const slug = req.params.ws;
    const scope = scopeFrom(slug, req.query);
    const md = executiveMarkdown(await executiveSummaryModel(slug, scope || undefined), scope);
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
          root: scope.rootId ? { id: scope.rootId, name: scope.rootName } : null,
          // SCOPE: environment + service, so a consumer of the bundle can name
          // the package the same way the workbook and the README do.
          environment: scope.envId
            ? { id: scope.envId, name: scope.envName, slug: scope.envSlug, regions: scope.envRegions || null }
            : null,
          service: scope.serviceId ? { id: scope.serviceId, name: scope.serviceName, slug: scope.serviceSlug } : null,
          label: scope.label,
          description: scope.sentence,
          componentIds: visibleComponentIds(scope).filter((id) => sel.componentIds.includes(id)),
          contextComponentIds: scope.contextIds.filter((id) => sel.componentIds.includes(id)),
          hidden: scope.hidden,
          hiddenSentences: scope.hiddenSentences,
          warnings: scope.warnings,
          generatedAt,
        }, null, 2) + '\n',
      });
    }
    // `scope` appears only when there IS one: an unscoped bundle stays the
    // exact `{generatedAt, files}` body it has always been.
    res.json(scope ? { generatedAt, scope: exportScopeMeta(scope), files } : { generatedAt, files });
  } catch (e) { next(e); }
});

// ===================================== the failover brief (.md) ============
//
// ADDITIVE SECTION. The same model the "How we fail this over" sheet renders
// (xlsx-gen.js → failoverBrief), so the workbook and the markdown can never
// tell different stories — the same relationship executiveMarkdown has with
// the Executive Summary sheet.
//
// This is the artifact you paste into a ticket, a PR or a Slack thread when
// someone asks "what does it actually take to fail Acme Pharmacy over?". It reads
// top to bottom; every sentence in it is derived from the workspace.

const briefMins = (v) => (v == null ? null : `${v} min`);

function briefMarkdown(m, scope = null) {
  const L = [];
  const s = m.subject;
  const esc = mdEscapeCell;

  // ---- the title and the one line ----
  L.push(`# How we fail this over — ${s.system}`, '');
  L.push(`> ${m.subjectLabel}`
    + ` · \`${s.primaryRegion || '?'}\` → \`${s.recoveryRegion || '?'}\``
    + `${s.strategyName ? ` · ${s.strategyName}` : ''}`
    + ` · generated ${m.generated} by DR Compass.`, '');
  L.push('Every sentence below is derived from this workspace — the inventory, the resource graph, the '
    + 'deployment-order engine, the gap list and the risk rules. Nothing is estimated: where the data is '
    + 'silent, this says so.', '');
  if (scope) {
    L.push(`**Scope.** ${scope.sentence}`, '');
    for (const w of scope.warnings || []) L.push(`> ⚠ ${w}`, '');
    for (const h of scope.hiddenSentences || []) L.push(`> ${h}`, '');
  }

  // ---- 1 ----
  L.push('## 1 · What this is', '');
  L.push(`This workbook is the disaster-recovery plan for **${s.system}**`
    + `${s.envName ? `, **${s.envName}** environment` : ''}`
    + `${s.serviceName ? `, **${s.serviceName}** service` : ''}`
    + `${!s.serviceName && s.root ? `, scoped to **${s.root.name}** and everything it needs` : ''}`
    + ` — ${s.componentCount} component${s.componentCount === 1 ? '' : 's'}, failing over from `
    + `\`${s.primaryRegion || 'an unrecorded primary region'}\` to \`${s.recoveryRegion || 'an unrecorded recovery region'}\``
    + `${s.strategyName ? ` on a ${s.strategyName.toLowerCase()} strategy` : ''}`
    + `${s.tooling.length ? `, using ${s.tooling.join(', ')}` : ''}.`, '');
  if (s.env?.isProduction) L.push('> **THIS IS PRODUCTION.**', '');
  if (m.order.available) {
    L.push(`The order below is computed from the dependency graph — ${m.order.itemCount} items in `
      + `${m.order.waveCount} waves — not typed by hand.`, '');
  } else {
    L.push('> The deployment-order engine did not run for this workspace, so section 3 is the restore-layer '
      + 'order from the inventory rather than a computed build order.', '');
  }

  // ---- 2 ----
  L.push('## 2 · What it is made of', '');
  if (m.madeOf.length) for (const p of m.madeOf) L.push(p, '');
  else L.push('No components are recorded in this slice, so there is nothing to describe.', '');

  // ---- 3 ----
  L.push('## 3 · The order it comes back in', '');
  if (m.order.available) {
    if (m.order.chain.length) L.push(`**Category order, the short answer:** ${m.order.chain.join(' → ')}.`, '');
    L.push('| Stage | What gets built | Why this, here |', '| --- | --- | --- |');
    for (const st of m.order.stages) {
      L.push(`| **${st.label}**<br>${esc(st.layerLabel || st.layer)} | ${esc(st.categories.join(' · '))} `
        + `| ${esc([st.why,
          st.readinessGates ? `${st.readinessGates} readiness gate${st.readinessGates === 1 ? '' : 's'} in here — "created" is not "Ready".` : '',
          st.estMinutes != null ? `~${st.estMinutes} min, from your own runbook steps.` : '',
          ...st.reviewReasons].filter(Boolean).join(' '))} |`);
    }
    L.push('');
    if (m.order.cycleCount || m.order.unorderedCount) {
      L.push(`> ${[
        m.order.cycleCount ? `The engine could not fully determine the order in ${m.order.cycleCount} place(s) — a dependency cycle` : '',
        m.order.unorderedCount ? `${m.order.unorderedCount} item(s) could not be placed in any wave` : '',
      ].filter(Boolean).join('; ')}. An order with a flagged hole in it is safer than a clean-looking one that is wrong.`, '');
    }
  } else {
    L.push(`Restore-layer order from the inventory: ${(m.inventory.byLayer || []).map(([l, n]) => `${l} (${n})`).join(' → ')}.`, '');
  }

  // ---- 4 ----
  L.push('## 4 · What has to be true before we start', '');
  const b = m.before;
  if (b.externals.length) {
    L.push(`${b.externals.length} precondition${b.externals.length === 1 ? '' : 's'} cannot be built during the `
      + 'failover — they are **verified, not created**. Partner allowlists and egress-IP approvals have lead times '
      + 'measured in days.', '');
    L.push('| Must already be true | By | Why |', '| --- | --- | --- |');
    for (const e of b.externals) {
      L.push(`| ${esc(e.name)} | ${esc(`before wave ${e.wave}${e.owner ? ` · ${e.owner}` : ''}`)} | ${esc(e.why)} |`);
    }
    L.push('');
  }
  if (b.callIssues.length) {
    L.push('Ordering issues the engine could not resolve — a service scheduled to start before something it calls:', '');
    for (const ci of b.callIssues) L.push(`- **${esc(ci.name)}** (${ci.severity}) — ${esc(ci.why)}`);
    L.push('');
  }
  if (b.gate) {
    L.push(`**${b.gate.names.join(', ')} — ${b.gate.done} of ${b.gate.total} green.**`
      + (b.gate.done === b.gate.total
        ? ' Re-read the freshness items at T0 anyway — "checked" goes stale.'
        : ` ${b.gate.total - b.gate.done} still open; the gate exists because each of these has failed a real test before.`), '');
    for (const i of b.gate.open) L.push(`- [ ] ${esc(i.text)}${i.why ? ` — ${esc(i.why)}` : ''} _(owner: ${esc(i.owner)})_`);
    L.push('');
  } else if (!b.externals.length) {
    L.push('> No Phase 0 checklist and no external preconditions are recorded. That is not the same as there being '
      + 'none — it means nobody has written down what must be true before the first recovery action.', '');
  }

  // ---- 5 ----
  L.push('## 5 · Where it breaks today', '');
  const cr = m.breaks.computed;
  if (cr && cr.total) {
    L.push(`The risk engine found **${cr.total} finding${cr.total === 1 ? '' : 's'}** `
      + `(${cr.bySeverity.map(([sev, n]) => `${n} ${sev}`).join(' · ')}) across the ${cr.scanned} service`
      + `${cr.scanned === 1 ? '' : 's'} it scanned. `
      + (cr.blockerCount
        ? `**${cr.blockerCount} ${cr.blockerCount === 1 ? 'is a blocker or a hole' : 'are blockers or holes'} in the restore order — this plan is NOT clean.**`
        : 'None of them is a blocker or a hole in the restore order.')
      // The digest is workspace-wide unless the scope is a single component;
      // the gap table under it is narrowed. Say which is which.
      + (m.scoped && !s.root ? ' That scan covers the whole workspace; the gap rows below are narrowed to this slice.' : ''), '');
  } else if (!cr) {
    L.push('> The computed risk engine could not be loaded, so what follows is the hand-written gap list only. '
      + 'An empty list is not evidence of a clean plan.', '');
  }
  if (m.breaks.risks.length) {
    L.push('| Severity | What is broken | Where | Owner | Ticket |', '| --- | --- | --- | --- | --- |');
    for (const r of m.breaks.risks) {
      L.push(`| ${r.severity} | ${esc(r.title)} | ${esc(r.component)} | ${esc(r.owner)} | ${esc(r.ticket || '—')} |`);
    }
    L.push('');
    if (m.breaks.openGapCount > m.breaks.risks.length) {
      L.push(`_${m.breaks.openGapCount - m.breaks.risks.length} further open gaps are in the workspace._`, '');
    }
  } else {
    L.push('No open gaps are written down. Either the plan is clean or the gaps have not been recorded — the '
      + 'risk-engine line above is the one that tells you which.', '');
  }

  // ---- 6 — docs/measured-numbers.md governs every row here ----
  L.push('## 6 · What we know, and what we do not', '');
  const n = m.numbers;
  // WHOSE objective this package is judged against — the scoped service's (with
  // the BIA that set it), the scoped environment's, or the workspace's. The
  // sentence is composed once, in xlsx-gen.js:resolveObjectives, and printed
  // verbatim here and by the sheet's own section 6 (addFailoverBrief), so the
  // workbook and this markdown cannot state the same fact differently. This
  // block used to word the provenance itself — "Approved by the business" — and
  // so printed an approved service target as though the workspace had approved
  // it, and a scope with no objective of its own as an unapproved proposal it
  // had never been given.
  const obj = n.objective || { level: 'workspace', why: '', conflict: null, none: false };
  const targetWhy = obj.level === 'workspace'
    ? (n.approved ? 'Approved by the business' : '**NOT yet approved by the business** — a proposal, not a commitment')
    : obj.why;
  const targetValue = (v) => briefMins(v) || (obj.none ? '**none of its own**' : '**not set**');
  L.push('| | Value | What it is |', '| --- | --- | --- |');
  L.push(`| RTO target | ${targetValue(n.rtoMinutes)} | ${esc(targetWhy)} |`);
  L.push(`| RPO target | ${targetValue(n.rpoMinutes)} | ${esc(targetWhy)} |`);
  // Two objectives that disagree are a governance fact, not a rendering choice:
  // printing one and dropping the other is how the wrong number reaches a board.
  if (obj.conflict) {
    L.push(`| **These targets are NOT reconciled** | ${esc(obj.conflict.workspaceValue)} | ${esc(obj.conflict.text)} |`);
  }
  // A measured number may be spoken of in the present tense only while its
  // evidence can be: stale evidence, or a run that reached the bar only after
  // undocumented manual intervention, says so in the row label and in the cell
  // (measured.js `met-with-caveats` / isAchievement, carried as numbers.caveated).
  const row = (label, state, minutes, stamp, what) => {
    const rowLabel = state === 'measured'
      ? `${label} measured${n.caveated ? ' **on a past run — not proven current**' : ''}`
      : state === 'declared' ? `${label} **recorded by hand** (not measured)`
        : `${label} **unmeasured**`;
    const detail = [what || '', state === 'measured' && n.caveated
      ? `Not a current capability: ${(n.evidenceCaveats || []).join(', and ')}.` : ''].filter(Boolean).join(' ');
    L.push(`| ${rowLabel} | ${minutes == null ? '**not measured yet**' : `${briefMins(minutes)}${stamp ? ` _(${esc(stamp)})_` : ''}`} | ${esc(detail)} |`);
  };
  row('RTA', n.rtaState, n.rtaMinutes, n.rtaStamp, n.rtaWhat);
  row('RPA', n.rpaState, n.rpaMinutes, n.rpaStamp, n.rpaWhat);
  const passed = m.tests.filter((t) => t.status === 'passed').length;
  L.push(`| Tests on record | ${m.tests.length ? `${m.tests.length} · ${passed} passed` : '**none**'} | `
    + (m.tests.length
      ? `Most recent: ${esc(m.tests[0].name)}${m.tests[0].date ? ` (${m.tests[0].date})` : ''} — ${m.tests[0].statusLabel}`
        + `${m.tests[0].findings ? `, ${m.tests[0].findings} finding${m.tests[0].findings === 1 ? '' : 's'}` : ''}`
      : 'An untested plan is a hypothesis — nothing above can be defended until one passes') + ' |');
  L.push('');
  L.push('RTO and RPO are targets. RTA and RPA are evidence **only when a test that passed produced them** — a '
    + 'number typed into settings is a note to self. When someone asks how fast you can recover, quote the '
    + 'measured number and name the test that produced it.', '');

  // ---- 7 ----
  L.push('## 7 · Who does what', '');
  if (m.people.length) {
    L.push('| Role | Who | Where they appear |', '| --- | --- | --- |');
    for (const p of m.people) {
      L.push(`| ${esc(p.role)} | ${p.named ? esc(p.person) : '**NOBODY NAMED**'} | ${esc([p.does, p.where].filter(Boolean).join(' · '))} |`);
    }
    L.push('');
  } else {
    L.push('**No owners are recorded on any runbook step and no contacts are listed.** During an incident that '
      + 'means the first fifteen minutes go on finding people.', '');
  }

  L.push('---', '');
  L.push(`Generated by DR Compass from ${s.system} on ${m.generated}. `
    + 'A point-in-time snapshot — regenerate before a test or a review.', '');
  return L.join('\n');
}

// The narrative one-pager as markdown. Takes the same scope knobs as every
// other export (?envId= / ?serviceId= / ?componentId= / ?componentIds=); with
// none of them it is the whole workspace.
router.get('/w/:ws/export/failover-brief.md', async (req, res, next) => {
  try {
    const slug = req.params.ws;
    const scope = scopeFrom(slug, req.query); // 404s on an unknown env/service/component
    // The already-resolved environment / service is handed to the model so the
    // brief names them even when the component set alone would not prove it.
    const m = await failoverBrief(slug, scope || undefined,
      scope ? { env: scope.env, service: scope.service } : {});
    const stem = scope ? `${safeName(slug)}-${scopeSlug(scope)}` : safeName(slug);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}-failover-brief-${today()}.md"`);
    res.send(briefMarkdown(m, scope));
  } catch (e) { next(e); }
});
