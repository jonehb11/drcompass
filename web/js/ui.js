// Tiny DOM + widget helpers shared by every page module.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const card = (...children) => h('div', { class: 'card' }, ...children);

/**
 * Empty state. Two call styles, both supported:
 *   empty('One-line message')                                  // legacy, still fine
 *   empty({ title, body, action, actions, icon, kind })        // preferred
 * `action` / `actions[]` are btn() specs — an empty state should always offer a way out.
 */
export function empty(optsOrMsg, ...rest) {
  if (optsOrMsg === null || optsOrMsg === undefined) return h('div', { class: 'empty' });
  if (typeof optsOrMsg !== 'object' || optsOrMsg instanceof Node) {
    return h('div', { class: 'empty' }, optsOrMsg, ...rest);
  }
  const { title, body, action, actions, icon, kind = '' } = optsOrMsg;
  const acts = [action, ...(actions || [])].filter(Boolean);
  return h('div', { class: `empty empty-rich ${kind}` },
    icon ? h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon) : null,
    title ? h('div', { class: 'empty-title' }, title) : null,
    body ? h('div', { class: 'empty-body' }, body) : null,
    acts.length ? h('div', { class: 'empty-actions' }, acts.map((a, i) => btn({ kind: i === 0 ? 'btn-primary' : '', ...a }))) : null,
    ...rest);
}

export function table(headers, rows) {
  return h('table', { class: 'table' },
    h('thead', null, h('tr', null, headers.map((th) => h('th', null, th)))),
    h('tbody', null, rows));
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 3800);
}

export function modal(title, body, { wide = false, actions = [] } = {}) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back', onClick: (e) => { if (e.target === back) close(null); } });
    const close = (v) => { back.remove(); resolve(v); };
    const btns = actions.map((a) =>
      h('button', { class: `btn ${a.kind || ''}`, onClick: async () => { const v = a.onClick ? await a.onClick() : a.value; if (v !== undefined) close(v); } }, a.label));
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('h2', null, title), body,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-ghost', onClick: () => close(null) }, 'Cancel'), btns));
    back.append(box);
    document.body.append(back);
    back.close = close;
  });
}

/**
 * confirmDialog('Are you sure?')                                  // legacy
 * confirmDialog('…', { title, confirmLabel, detail, danger })     // preferred
 */
export function confirmDialog(msg, opts = {}) {
  const { title = 'Confirm', confirmLabel = 'Confirm', detail = '', danger = true } = opts;
  return modal(title, h('div', null,
    h('p', null, msg),
    detail ? h('p', { class: 'hint', style: 'margin-top:8px' }, detail) : null,
  ), {
    actions: [{ label: confirmLabel, kind: danger ? 'btn-danger' : 'btn-primary', value: true }],
  });
}

export function field(labelText, input) {
  return h('label', { class: 'field' }, h('span', null, labelText), input);
}

// Minimal markdown renderer — headings, lists, tables, code, bold/italic/links.
export function markdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = md.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let html = '', inCode = false, inList = false, inTable = false;
  const closeBlocks = () => { if (inList) { html += '</ul>'; inList = false; } if (inTable) { html += '</tbody></table>'; inTable = false; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) { closeBlocks(); html += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) { closeBlocks(); html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(line)) { if (inTable) closeBlocks(); if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`; continue; }
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line.trim())) continue; // separator row
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      if (!inTable) { if (inList) closeBlocks(); html += `<table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`; inTable = true; }
      else html += `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
      continue;
    }
    if (/^>\s?/.test(line)) { closeBlocks(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    closeBlocks();
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeBlocks();
  if (inCode) html += '</code></pre>';
  return h('div', { class: 'md', html });
}

/* ============================================================================
 * SHARED DESIGN-SYSTEM HELPERS  (added by the shell/IA pass)
 * Every page should use these instead of hand-rolling markup, so the product
 * reads as one thing. Nothing here renames or removes an existing export.
 * See INTEGRATION-NOTES.md ("shell + IA pass") for the adoption checklist.
 * ==========================================================================*/

// ---------------------------------------------------------------- buttons
/**
 * One button factory so hierarchy stays honest. Renders an <a> when `href` is
 * given (so hash routes keep working and are middle-clickable), else a <button>.
 * kind: '' (secondary, the default) | 'btn-primary' | 'btn-danger' | 'btn-ghost'
 * RULE: exactly one 'btn-primary' per view.
 */
export function btn({ label, href, onClick, kind = '', size = '', disabled = false, title = '', icon = '' } = {}) {
  const cls = `btn ${kind} ${size}`.replace(/\s+/g, ' ').trim();
  const kids = [icon ? h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, icon) : null, label];
  if (href && !disabled) return h('a', { class: cls, href, title: title || null }, kids);
  return h('button', {
    class: cls, type: 'button', disabled, title: title || null,
    onClick: onClick || (href ? () => { location.hash = href; } : null),
  }, kids);
}

// ---------------------------------------------------------------- page chrome
/**
 * The one page header. EVERY page gets a title plus ONE sentence of `purpose`
 * saying what this page is for and what you can do here.
 *   pageHead({ title, purpose, crumb, actions: [btnSpec], meta: [nodes] })
 * `crumb` makes the walkthrough legible backwards: {label, href} (or a node)
 * rendered above the title as "← what led here". Optional; older callers that
 * omit it render exactly as before.
 */
export function pageHead({ title, purpose, crumb, actions = [], meta = [] } = {}) {
  const crumbEl = !crumb ? null
    : crumb instanceof Node ? crumb
      : h('a', { class: 'page-crumb', href: crumb.href }, `← ${crumb.label}`);
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-head-main' },
      crumbEl,
      h('h1', null, title || ''),
      purpose ? h('div', { class: 'sub' }, purpose) : null,
      meta.length ? h('div', { class: 'page-meta' }, meta) : null),
    actions.length ? h('div', { class: 'page-head-actions' }, actions.map((a) => (a instanceof Node ? a : btn(a)))) : null);
}

/** Card header row: title on the left, optional controls on the right. */
export function cardHead(title, ...right) {
  return h('div', { class: 'card-head' },
    typeof title === 'string' ? h('h2', null, title) : title,
    right.length ? h('div', { class: 'card-head-right' }, ...right) : null);
}

/** A labelled section inside a long page. */
export function sectionHead(title, purpose) {
  return h('div', { class: 'section-head' },
    h('h2', null, title),
    purpose ? h('div', { class: 'section-purpose' }, purpose) : null);
}

// ---------------------------------------------------------------- loading
/** Consistent spinner + label. Use instead of a bare "Loading…" string. */
export function spinner(label = 'Loading…') {
  return h('div', { class: 'loading', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', null, label));
}

/** Content-shaped placeholder. `rows` grey bars, or kind:'tiles'|'table'. */
export function skeleton({ rows = 3, kind = 'lines', label = 'Loading…' } = {}) {
  const box = h('div', { class: `skel skel-${kind}`, role: 'status', 'aria-label': label });
  const n = Math.max(1, rows);
  for (let i = 0; i < n; i++) box.append(h('div', { class: 'skel-bar', style: `width:${100 - (i % 3) * 14}%` }));
  return box;
}

// ---------------------------------------------------------------- stat tiles
/**
 * A dashboard/summary number. ALWAYS give it an `href` so the number is a door
 * to the place you act on it.
 *   statTile({ value, label, sub, kind:'ok'|'warn'|'err'|'muted'|'', href })
 */
export function statTile({ value, label, sub, kind = '', href, onClick, hint } = {}) {
  const body = h('div', { class: 'kpi' },
    h('div', { class: `kpi-value ${kind ? `kv-${kind}` : ''}` }, value),
    h('div', { class: 'kpi-label' }, label),
    sub ? h('div', { class: 'kpi-sub' }, sub) : null);
  if (href) return h('a', { class: 'card stat-tile', href, title: hint || null }, body);
  if (onClick) return h('button', { class: 'card stat-tile', type: 'button', onClick, title: hint || null }, body);
  return h('div', { class: 'card stat-tile is-static', title: hint || null }, body);
}

/** Tiny state dot. Same colour language as badges. */
export function dot(kind = '', title = '') {
  return h('span', { class: `state-dot ${kind}`, title: title || null, 'aria-hidden': title ? null : 'true' },
    title ? h('span', { class: 'sr-only' }, title) : null);
}

// ---------------------------------------------------------------- badges
/**
 * BADGE SEMANTICS — one meaning across the whole app:
 *   ok     things are true/proven/healthy  (test passed, gap resolved, target met)
 *   warn   real but unproven, or needs attention soon (unapproved target, planned test)
 *   err    actively wrong / blocking (test failed, blocker gap open, target missed)
 *   accent in progress / informational-active (running, current step)
 *   purple a classification, not a health state (layer id, kind, category)
 *   ''     neutral count or label, no health meaning
 * Never use colour to mean "category" — that's what purple/neutral are for.
 */
export const BADGE_MEANING = Object.freeze({
  ok: 'proven / healthy', warn: 'unproven or needs attention', err: 'blocking or failed',
  accent: 'in progress', purple: 'classification', '': 'neutral label',
});

const SEVERITY_KIND = { blocker: 'err', critical: 'err', high: 'warn', medium: '', low: '', info: '' };
/** Gap severity → badge with consistent colour. */
export function severityBadge(severity) {
  const s = String(severity || 'gap').toLowerCase();
  return badge(s, SEVERITY_KIND[s] ?? '');
}

const STATUS_KIND = {
  passed: 'ok', resolved: 'ok', done: 'ok', complete: 'ok', approved: 'ok',
  failed: 'err', blocked: 'err', open: 'err',
  'in-progress': 'accent', running: 'accent', active: 'accent',
  planned: 'warn', draft: 'warn', pending: 'warn', accepted: 'warn',
  canceled: '', cancelled: '', skipped: '',
};
/** Test/gap/run status → badge with consistent colour. */
export function statusBadge(status, fallback = 'unknown') {
  const s = String(status || fallback).toLowerCase();
  return badge(s, STATUS_KIND[s] ?? '');
}
export const statusKind = (status) => STATUS_KIND[String(status || '').toLowerCase()] ?? '';

// ---------------------------------------------------------------- notices
/** Inline notice band. kind: 'info' | 'ok' | 'warn' | 'err'. */
export function banner({ kind = 'info', title, body, action, dismissible = false } = {}) {
  const el = h('div', { class: `banner banner-${kind}`, role: kind === 'err' ? 'alert' : null },
    h('div', { class: 'banner-main' },
      title ? h('div', { class: 'banner-title' }, title) : null,
      body ? h('div', { class: 'banner-body' }, body) : null),
    action ? btn({ size: 'btn-sm', ...action }) : null,
    dismissible ? h('button', { class: 'banner-x', type: 'button', 'aria-label': 'Dismiss', onClick: () => el.remove() }, '×') : null);
  return el;
}

// ---------------------------------------------------------------- glossary
/**
 * Plain-English definitions for everything a new DR owner won't know.
 * Keys are matched case-insensitively and punctuation-insensitively, so
 * term('RTO'), term('rto') and term('Restore layer') all resolve.
 */
export const GLOSSARY = {
  rto: ['RTO — recovery time objective', 'The longest outage the business says it can live with. A promise you make, not a measurement. Compare it with RTA to see whether the promise is real.'],
  rpo: ['RPO — recovery point objective', 'The most recent data the business says it can afford to lose, measured in time ("we can lose 5 minutes of orders"). Also a target, not a measurement.'],
  rta: ['RTA — recovery time achieved', 'How long recovery actually took the last time you tested it. This is the honest number; quote this one, not the target.'],
  rpa: ['RPA — recovery point achieved', 'How much data you actually would have lost in your last test. The honest counterpart to RPO.'],
  'restore layer': ['Restore layer', 'The order things come back in. You cannot start a database before the network exists, so recovery is grouped into layers — L0 guardrails and backups, up to L7 live traffic — and each layer is checked before the next one starts.'],
  'dependency closure': ['Dependency closure', 'Everything one service needs in order to run, followed all the way down: its database, that database\'s secret, the network they both sit in. Recover a service and you must recover its whole closure.'],
  'dependency mapping': ['Dependency mapping', 'Looking at each resource and recording what it is attached to — which network, which disk, which secret, which database — so recovery order stops being tribal knowledge. Older parts of this app call it "enrichment".'],
  enrichment: ['Enrichment (now: dependency mapping)', 'The old name for dependency mapping: a read-only pass that looks at each discovered resource and records what it is attached to. Nothing is changed in your cloud account.'],
  'scan & map': ['Scan & map', 'A read-only sweep of a cloud account that lists what exists and works out how it connects. It never changes anything — it only reads.'],
  correlate: ['Correlate', 'Matching up records that describe the same real thing from two different sources — for example an AWS resource and the backup entry that protects it.'],
  'recovery point': ['Recovery point', 'The moment in time you would be restoring back to: the timestamp of the backup or replica you would actually use.'],
  'game day': ['Game day', 'A rehearsal of a real disaster, on the clock, with the people who would actually respond. Bigger than a technical test: it exercises decisions and communication too.'],
  'phase 0': ['Phase 0', 'The groundwork that has to exist before any recovery can work at all: accounts and permissions, backups actually turned on, a named owner. If Phase 0 is not done, nothing after it will work.'],
  'pilot light': ['Pilot light', 'A minimal copy of your system kept alive in the recovery region — data replicating, almost no compute running. Cheap to hold, takes time to scale up when you need it.'],
  'warm standby': ['Warm standby', 'A scaled-down but genuinely working copy of the system in the recovery region. Costs more than pilot light, comes back much faster.'],
  'active-active': ['Active-active', 'Both regions serve real traffic all the time. The fastest recovery there is, and the most expensive and complex to run.'],
  'backup & restore': ['Backup & restore', 'You keep backups and rebuild in the recovery region when disaster strikes. The cheapest strategy and by far the slowest.'],
  'blast radius': ['Blast radius', 'How much breaks when one thing fails. A small blast radius means losing one region, account or cluster does not take everything else with it.'],
  'maturity level': ['Maturity level', 'A 0–5 read on how ready your DR program is. Levels above 2 have to be earned with tests that actually passed — answering optimistically will not move you up.'],
  gap: ['Gap', 'Something found in a test or review that would hurt a real recovery. It stays tracked until it is fixed or formally accepted with eyes open.'],
  blocker: ['Blocker', 'A gap bad enough that a real recovery would fail. It must be fixed, or explicitly accepted by someone with authority, before you claim you are ready.'],
  runbook: ['Runbook', 'The step-by-step procedure someone else could follow at 3am to bring the system back — in order, with a check after each step.'],
  verification: ['Verification', 'A command plus a pass bar attached to a step, so you can prove a layer really works before moving on. A layer you cannot verify is a layer you cannot gate.'],
  'decision gate': ['Decision gate', 'The moment someone with authority looks at the evidence and says "yes, we would fail over" — or names what is still missing.'],
};

const normTerm = (k) => String(k || '').toLowerCase().trim().replace(/\s+/g, ' ');
// Machine slugs and older wording resolve to the same definition, so a page can
// pass whatever it has on hand — term('pilot-light'), term('enrich'), term('RTO').
const TERM_ALIAS = {
  'backup-restore': 'backup & restore', 'backup restore': 'backup & restore',
  'scan-map': 'scan & map', 'scan and map': 'scan & map',
  enrich: 'enrichment', enriched: 'enrichment', enriching: 'enrichment',
  'depends on': 'dependency mapping', dependson: 'dependency mapping',
  'map dependencies': 'dependency mapping',
  phase0: 'phase 0', 'game-day': 'game day', gameday: 'game day',
  'restore layers': 'restore layer', layer: 'restore layer',
  'recovery time objective': 'rto', 'recovery point objective': 'rpo',
  'recovery time achieved': 'rta', 'recovery point achieved': 'rpa',
  verify: 'verification', 'verification command': 'verification', gate: 'decision gate',
  blockers: 'blocker', gaps: 'gap', runbooks: 'runbook',
};
export function glossaryEntry(key) {
  const k = normTerm(key);
  if (!k) return null;
  return GLOSSARY[k]
    || GLOSSARY[k.replace(/-/g, ' ')]
    || GLOSSARY[k.replace(/\s+/g, '-')]
    || GLOSSARY[TERM_ALIAS[k] || '']
    || GLOSSARY[TERM_ALIAS[k.replace(/-/g, ' ')] || '']
    || null;
}

/**
 * Render a term with a dotted underline and a hover/focus/click definition.
 *   term('RTO')                  → "RTO" with its definition
 *   term('restore layer', 'L3')  → shows "L3", defines "restore layer"
 * Unknown keys degrade to plain text, so a typo never breaks a page.
 */
export function term(key, label) {
  const entry = glossaryEntry(key);
  const text = label !== undefined && label !== null ? label : (entry ? entry[0].split(' — ')[0] : String(key));
  if (!entry) return h('span', null, text);
  const [heading, definition] = entry;
  const pop = h('span', { class: 'term-pop', role: 'tooltip' },
    h('strong', null, heading), h('span', null, definition));
  const el = h('span', {
    class: 'term', tabindex: '0', role: 'button', 'aria-label': `${text} — what does this mean?`,
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); el.classList.toggle('open'); },
    onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.classList.toggle('open'); }
      if (e.key === 'Escape') el.classList.remove('open');
    },
    onBlur: () => el.classList.remove('open'),
  }, h('span', { class: 'term-text' }, text), pop);
  return el;
}

// ---------------------------------------------------------------- formatting
/** 95 → "1h 35m", 45 → "45 min", null → "—". Use everywhere RTO/RTA appear. */
export function fmtMinutes(mins) {
  if (mins === null || mins === undefined || mins === '' || Number.isNaN(Number(mins))) return '—';
  const m = Math.round(Number(mins));
  if (m < 60) return `${m} min`;
  const h_ = Math.floor(m / 60), r = m % 60;
  if (h_ < 24) return r ? `${h_}h ${r}m` : `${h_}h`;
  const d = Math.floor(h_ / 24), rh = h_ % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return String(d); }
}

/** "3 days ago" / "in 2 weeks" — for last-test-run style lines. */
export function relTime(d) {
  if (!d) return '';
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.round((t - Date.now()) / 86400000);
  const ad = Math.abs(days);
  const unit = ad === 0 ? 'today' : ad === 1 ? '1 day' : ad < 30 ? `${ad} days` : ad < 365 ? `${Math.round(ad / 30)} months` : `${(ad / 365).toFixed(1)} years`;
  if (ad === 0) return 'today';
  return days < 0 ? `${unit} ago` : `in ${unit}`;
}

const STRATEGY_LABEL = {
  'backup-restore': 'Backup & restore', 'pilot-light': 'Pilot light',
  'warm-standby': 'Warm standby', 'active-active': 'Active-active',
};
/** Machine slug → human label. Never show a raw slug to a user. */
export const humanStrategy = (s) => STRATEGY_LABEL[s] || (s ? String(s).replace(/-/g, ' ') : 'not set');

const TOOL_LABEL = {
  arpio: ['Arpio', 'Third-party service that replicates AWS workloads to a recovery region and can fail them over.'],
  'region-switch': ['AWS Region Switch', 'AWS plans that orchestrate a controlled switch between regions.'],
  'arc-routing-controls': ['Route 53 ARC routing controls', 'Safety-checked on/off switches for sending traffic to a region.'],
  'elastic-dr': ['AWS Elastic Disaster Recovery (DRS)', 'Block-level replication of servers into AWS, launched on demand.'],
  'gitops-iac': ['GitOps / infrastructure as code', 'Recovery by re-applying declarative config (Terraform, Argo) into the recovery region.'],
  'resilience-hub': ['AWS Resilience Hub', 'Assesses an application against RTO/RPO targets and reports drift.'],
  backup: ['Backups (AWS Backup / snapshots)', 'Point-in-time copies you restore from. The floor of every DR program.'],
};
export const humanTool = (t) => (TOOL_LABEL[t] ? TOOL_LABEL[t][0] : String(t || ''));
export const toolHelp = (t) => (TOOL_LABEL[t] ? TOOL_LABEL[t][1] : '');

// ---------------------------------------------------------------- workspace snapshot
/**
 * One cached read of everything the shell, dashboard and onboarding need, so
 * they agree on the facts and don't each fan out 7 requests.
 *   const snap = await ui.snapshot(api, ws);
 * Soft-fails per endpoint (a 501 feature router yields null, not a throw).
 * Call invalidateSnapshot(ws) after you write data that changes program state.
 */
const SNAP_TTL = 6000;
const snapCache = new Map();

export function invalidateSnapshot(ws) {
  if (ws) snapCache.delete(ws); else snapCache.clear();
}

export function snapshot(api, ws, { force = false } = {}) {
  const hit = snapCache.get(ws);
  if (!force && hit && Date.now() - hit.at < SNAP_TTL) return hit.promise;
  const soft = (p) => api.get(p).then((r) => r, () => null);
  const promise = (async () => {
    const [meta, compRes, rbkRes, tstRes, chkRes, gapRes, report] = await Promise.all([
      soft(`/w/${ws}/workspace`), soft(`/w/${ws}/c/components`), soft(`/w/${ws}/c/runbooks`),
      soft(`/w/${ws}/c/tests`), soft(`/w/${ws}/c/checklists`), soft(`/w/${ws}/c/gaps`),
      soft(`/w/${ws}/assessment/report`),
    ]);
    const components = compRes?.items || [];
    const runbooks = rbkRes?.items || [];
    const tests = tstRes?.items || [];
    const checklists = chkRes?.items || [];
    const gaps = gapRes?.items || [];
    const obj = meta?.objectives || {};
    const isClosed = (g) => g.status === 'resolved' || g.status === 'accepted';
    const withDeps = components.filter((c) => Array.isArray(c.dependsOn) && c.dependsOn.length > 0);
    const withVerify = components.filter((c) => c.verification && c.verification.command);
    const datedTests = tests.filter((t) => t.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const passedTests = tests.filter((t) => t.status === 'passed');
    const phase0 = checklists.filter((c) => c.kind === 'phase0');
    return {
      ws, meta: meta || {}, objectives: obj, report: report || null,
      components, runbooks, tests, checklists, gaps, datedTests, passedTests,
      counts: {
        components: components.length, runbooks: runbooks.length, tests: tests.length,
        checklists: checklists.length, gaps: gaps.length,
        withDeps: withDeps.length, withVerify: withVerify.length,
        inScope: components.filter((c) => c.inRecoveryScope === 'yes').length,
      },
      depsPct: components.length ? Math.round((withDeps.length / components.length) * 100) : 0,
      verifyPct: components.length ? Math.round((withVerify.length / components.length) * 100) : 0,
      openGaps: gaps.filter((g) => !isClosed(g)),
      openBlockers: gaps.filter((g) => g.severity === 'blocker' && !isClosed(g)),
      lastTest: datedTests.find((t) => ['passed', 'failed', 'in-progress'].includes(t.status)) || null,
      gameDayPassed: passedTests.some((t) => t.type === 'game-day'),
      phase0Done: phase0.length > 0 && phase0.some((c) => (c.items || []).length > 0 && (c.items || []).every((i) => i.done)),
      hasRunbookSteps: runbooks.some((r) => (r.steps || []).length > 0),
      ok: !!meta,
    };
  })();
  snapCache.set(ws, { at: Date.now(), promise });
  promise.catch(() => snapCache.delete(ws));
  return promise;
}

// ---------------------------------------------------------------- AI (optional tenant)
/**
 * Contextual AI actions, rendered only if web/js/ai-actions.js exists.
 * Degrades to nothing at all when the module is absent or throws — never a
 * broken button, never an auto-applied change.
 *   el.append(ui.aiRow({ ws, api, context: {...}, actions: [
 *     { label: 'Explain my DR posture in plain English', prompt: '…' },
 *   ]}));
 * Returns a container synchronously; it fills in later if AI is available.
 */
export function aiRow({ ws, api, context = {}, actions = [], intro = '', onApply } = {}) {
  const box = h('div', { class: 'ai-row', hidden: true });
  (async () => {
    try {
      const mod = await import('./ai-actions.js');
      const make = mod.aiButton || mod.default?.aiButton;
      if (typeof make !== 'function' || !actions.length) return;
      const made = [];
      for (const a of actions) {
        try {
          const cb = a.onApply || onApply;
          const node = await make({
            ws, api, context, prompt: a.prompt, label: a.label,
            // 'answer' = explain only; nothing is ever applied without the user
            // choosing to. Both callback spellings are forwarded because
            // ai-actions.js has used `onApplied` and `onApply` at different times.
            mode: a.mode || 'answer',
            ...(cb ? { onApply: cb, onApplied: cb } : {}),
            ...(a.extra || {}),
          });
          if (node instanceof Node) made.push(node);
        } catch { /* one bad action must not drop the others */ }
      }
      if (!made.length) return;
      box.append(
        h('span', { class: 'ai-row-label' }, intro || 'Ask AI:'),
        ...made,
      );
      box.hidden = false;
    } catch { /* AI module absent or broken — stay invisible. */ }
  })();
  return box;
}

/** Same defensive wrapper for a panel-style AI section. */
export function aiPanel(opts = {}) {
  const box = h('div', { class: 'ai-panel-slot', hidden: true });
  (async () => {
    try {
      const mod = await import('./ai-actions.js');
      const make = mod.aiPanelSection || mod.default?.aiPanelSection;
      if (typeof make !== 'function') return;
      const node = await make(opts);
      if (node instanceof Node) { box.append(node); box.hidden = false; }
    } catch { /* invisible */ }
  })();
  return box;
}

// ---------------------------------------------------------------- dead-end killer
/**
 * The "what now?" band. Every page that can be *finished* should end with one,
 * so the user is never left staring at a completed thing with nowhere to go.
 *   el.append(ui.nextStep({
 *     title: 'Inventory looking solid?',
 *     body: 'Turn it into an ordered procedure someone could follow at 3am.',
 *     action: { label: 'Draft a runbook', href: `#/${ws}/runbooks` },
 *     alt: { label: 'See the dependency picture', href: `#/${ws}/diagrams` },
 *   }));
 */
export function nextStep({ title, body, action, alt, kind = '' } = {}) {
  return h('div', { class: `nextstep ${kind}` },
    h('div', { class: 'nextstep-main' },
      title ? h('div', { class: 'nextstep-title' }, title) : null,
      body ? h('div', { class: 'nextstep-body' }, body) : null),
    h('div', { class: 'nextstep-acts' },
      // Guidance, not the page's primary action — pass kind:'btn-primary'
      // explicitly when this band really is the one imperative on the page.
      action ? btn({ size: 'btn-sm', ...action }) : null,
      alt ? btn({ size: 'btn-sm', kind: 'btn-ghost', ...alt }) : null));
}
