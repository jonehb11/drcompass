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

// The snapshot is per (workspace × scope): the same workspace viewed in dev and
// in prod is not the same set of facts, so caching on `ws` alone would show one
// environment's counts under another's name. `api.scopeKey` is set by
// scopedApi(); a plain api has none and keys as it always did.
const snapKey = (api, ws) => `${ws}\u0000${(api && api.scopeKey) || ''}`;

export function invalidateSnapshot(ws) {
  if (!ws) { snapCache.clear(); return; }
  for (const k of [...snapCache.keys()]) if (k === ws || k.startsWith(`${ws}\u0000`)) snapCache.delete(k);
}

export function snapshot(api, ws, { force = false } = {}) {
  const key = snapKey(api, ws);
  const hit = snapCache.get(key);
  if (!force && hit && Date.now() - hit.at < SNAP_TTL) return hit.promise;
  const soft = (p) => api.get(p).then((r) => r, () => null);
  const promise = (async () => {
    const [meta, compRes, rbkRes, tstRes, chkRes, gapRes, report, svcRes, docRes] = await Promise.all([
      soft(`/w/${ws}/workspace`), soft(`/w/${ws}/c/components`), soft(`/w/${ws}/c/runbooks`),
      soft(`/w/${ws}/c/tests`), soft(`/w/${ws}/c/checklists`), soft(`/w/${ws}/c/gaps`),
      soft(`/w/${ws}/assessment/report`),
      // v0.7. A workspace older than services.json soft-fails to null and every
      // service-aware affordance simply does not appear.
      soft(`/w/${ws}/c/services`),
      // Same soft-fail contract: a workspace with no documents.json simply has
      // no Documents count, and the nav slot stays empty.
      soft(`/w/${ws}/c/documents`),
    ]);
    const services = svcRes?.items || [];
    const documents = docRes?.items || [];
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
      components, runbooks, tests, checklists, gaps, services, documents, datedTests, passedTests,
      environments: Array.isArray(meta?.environments) ? meta.environments : [],
      unassignedService: components.filter((c) => !c.serviceId).length,
      unassignedEnv: components.filter((c) => !c.envId).length,
      counts: {
        components: components.length, runbooks: runbooks.length, tests: tests.length,
        checklists: checklists.length, gaps: gaps.length, services: services.length,
        documents: documents.length,
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
  snapCache.set(key, { at: Date.now(), promise });
  promise.catch(() => snapCache.delete(key));
  return promise;
}

/* ============================================================================
 * ENVIRONMENTS, SERVICES AND SCOPE  (v0.7 — docs/ENV-SERVICE-MODEL.md)
 *
 * A workspace is ONE system you are responsible for recovering (Acme Pharmacy).
 * Inside it are ENVIRONMENTS (dev / staging / prod — separate accounts,
 * recovered separately) and SERVICES (adjudication, remittance — each owning a
 * slice of the components, each able to own sub-services).
 *
 * Everything here is additive and soft: a workspace with no `environments` and
 * no services behaves exactly as it did before any of this existed. Nothing
 * fabricates an environment, and nothing auto-assigns a component.
 *
 * Published for other agents in INTEGRATION-NOTES.md ("env + service navigation").
 * ==========================================================================*/

/**
 * The page segment of a route. Lives here rather than in app.js so Settings can
 * refuse to create an environment whose slug would be read as a page name —
 * the one thing that could make `#/:ws/:env/:page` ambiguous.
 */
export const ROUTE_PAGES = Object.freeze([
  'dashboard', 'assessment', 'inventory', 'service', 'discover', 'documents',
  'diagrams', 'deploy-order', 'runbooks', 'tests', 'checklists', 'exports',
  'copilot', 'learn', 'settings',
]);

/** Reserved route/scope word: every environment at once (scope.js: not scoped). */
export const ENV_ALL = 'all';

/** Words an environment slug may not take, because a route would not parse. */
export const RESERVED_ENV_SLUGS = Object.freeze([...ROUTE_PAGES, ENV_ALL, 'any', 'null', 'undefined', 'unassigned', 'w']);
/** Reserved scope word from scope.js: "belongs to nothing yet". */
export const UNASSIGNED = 'unassigned';

const S = (v) => (v === null || v === undefined ? '' : String(v));
const A = (v) => (Array.isArray(v) ? v : []);

/** Same slug rule as server/lib/scope.js, so a UI-made slug round-trips. */
export function slugify(name, fallback = '') {
  const s = S(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** What an environment is called in a URL. Falls back to its id. */
export const envSlug = (env) => (env ? S(env.slug) || S(env.id) : '');

// ---- the per-workspace choice, remembered across visits -------------------
const ENV_KEY = (ws) => `drcompass.env.${ws}`;
export function readEnvPref(ws) {
  try { return localStorage.getItem(ENV_KEY(ws)) || ''; } catch { return ''; }
}
export function writeEnvPref(ws, slug) {
  try {
    if (slug) localStorage.setItem(ENV_KEY(ws), slug);
    else localStorage.removeItem(ENV_KEY(ws));
  } catch { /* private mode — the hash still carries the choice */ }
}

/**
 * Read the environments off a workspace meta object (they live in
 * workspace.json per the contract, §2). NEVER fabricates one.
 *   { items, defaultEnvId, multi, prod }
 */
export function environmentsOf(meta) {
  const items = A(meta?.environments).filter((e) => e && typeof e === 'object' && S(e.id));
  const declared = S(meta?.defaultEnvId);
  const defaultEnvId = items.some((e) => S(e.id) === declared) ? declared : (items[0] ? S(items[0].id) : null);
  return {
    items,
    defaultEnvId,
    multi: items.length > 0,
    prod: items.find((e) => e.isProduction) || null,
  };
}

/** id, slug or name → the environment. 'all'/blank → null. Never throws. */
export function findEnv(items, needle) {
  const n = S(needle).trim();
  if (!n || n.toLowerCase() === ENV_ALL) return null;
  const lower = n.toLowerCase();
  return A(items).find((e) => S(e.id) === n)
    || A(items).find((e) => S(e.slug).toLowerCase() === lower)
    || A(items).find((e) => S(e.name).toLowerCase() === lower)
    || null;
}

/**
 * Wrap the api so every READ carries the scope. Writes are never scoped — a
 * PUT says what it means on its own — so they pass straight through.
 *
 *   const sapi = ui.scopedApi(api, { envId: 'env_prod' });
 *   await sapi.get(`/w/${ws}/c/components`);   // → ?envId=env_prod
 *   await sapi.raw.get('/workspaces');         // deliberately unscoped
 *
 * `envId: 'unassigned'` is the scope.js magic value for "not in any
 * environment yet" and is passed through as-is.
 */
export function scopedApi(api, { envId = null, serviceId = null } = {}) {
  const env = S(envId).trim();
  const svc = S(serviceId).trim();
  if (!env && !svc) {
    // No scope at all: hand back something with the same shape (so callers can
    // always read .raw / .envId) but with byte-identical request behaviour.
    return Object.assign(Object.create(null), {
      get: (p) => api.get(p), post: (p, b) => api.post(p, b),
      put: (p, b) => api.put(p, b), del: (p) => api.del(p),
      raw: api, envId: null, serviceId: null, scopeKey: '',
    });
  }
  const scoped = (p) => {
    const path = S(p);
    // Never scope the workspace list itself, and never double-append.
    if (!path.startsWith('/w/')) return path;
    if (/[?&](envId|serviceId)=/.test(path)) return path;
    const q = [];
    if (env) q.push(`envId=${encodeURIComponent(env)}`);
    if (svc) q.push(`serviceId=${encodeURIComponent(svc)}`);
    return `${path}${path.includes('?') ? '&' : '?'}${q.join('&')}`;
  };
  // A server build that has not yet implemented §3 scoping answers a scoped
  // request with the WHOLE workspace and no `scope:` block. Showing every
  // environment's components under the heading "Production" would be a lie the
  // user acts on, so the two collections that carry an `envId` of their own are
  // narrowed here as well. The moment the server does the scoping (and says so
  // with a `scope:` block) this pass stops touching anything.
  const NARROWABLE = /\/c\/(components|services)(\?|$)/;
  const narrow = (path, data) => {
    if (!env || !data || !Array.isArray(data.items) || data.scope) return data;
    if (!NARROWABLE.test(path)) return data;
    if (!data.items.some((x) => x && 'envId' in x)) return data;
    const items = data.items.filter((x) => {
      const own = S(x?.envId).trim();
      return env === UNASSIGNED ? !own : own === env;
    });
    return { ...data, items, scopedByClient: true };
  };

  return Object.assign(Object.create(null), {
    get: (p) => api.get(scoped(p)).then((d) => narrow(scoped(p), d)),
    post: (p, b) => api.post(p, b),
    put: (p, b) => api.put(p, b),
    del: (p) => api.del(p),
    raw: api,
    envId: env || null,
    serviceId: svc || null,
    scopeKey: `${env}|${svc}`,
    /** Exposed so a page can scope a URL it builds itself (an export href). */
    scopePath: scoped,
  });
}

// ---- the switcher's visual language ---------------------------------------
/**
 * Production is the control that decides which account people are looking at,
 * so it never looks like the others. Returns 'prod' | 'env' for CSS.
 */
export const envKind = (env) => (env && env.isProduction ? 'prod' : 'env');

/** A small label for an environment, red-edged when it is production. */
export function envBadge(env, { short = false } = {}) {
  if (!env) return badge('All environments', '');
  const name = short ? (S(env.slug) || S(env.name)) : (S(env.name) || S(env.slug));
  return h('span', { class: `badge env-badge ${env.isProduction ? 'is-prod' : ''}` },
    env.isProduction ? h('span', { class: 'env-dot', 'aria-hidden': 'true' }) : null, name);
}

// ---------------------------------------------------------------- service tree

/**
 * Every component id an item points at, at any nesting depth. Mirrors
 * server/lib/scope.js `componentRefs` so the client and the server agree on
 * what "this runbook covers that component" means.
 */
export function componentRefs(item, depth = 0) {
  const out = new Set();
  if (!item || typeof item !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(item)) {
    if (k === 'componentId' && typeof v === 'string' && v) out.add(v);
    else if (k === 'componentIds') for (const id of A(v)) { if (S(id)) out.add(S(id)); }
    else if (v && typeof v === 'object') for (const id of componentRefs(v, depth + 1)) out.add(id);
  }
  return out;
}

const isClosedGap = (g) => g.status === 'resolved' || g.status === 'accepted';

/**
 * THE SERVICE TREE — the answer to "within Acme Pharmacy you have remittance or
 * adjudication, and these are sub-services, so show them categorized with
 * their sub-components and the things they require".
 *
 *   buildServiceTree({ services, components, gaps, runbooks, tests })
 *     → { roots, nodes, byId, unassigned, crossCount }
 *
 * Each node carries what the brief asks a service row to answer:
 *   tier · component count · open blockers · has a runbook · has a passing test
 * plus `requires` — its dependencies on OTHER services, derived from its own
 * components' `dependsOn` edges crossing a service boundary. That derivation is
 * the point: nobody types "adjudication needs pricing", it falls out of the
 * component graph, and a dependency landing on a component in NO service is
 * reported rather than hidden.
 */
export function buildServiceTree({ services = [], components = [], gaps = [], runbooks = [], tests = [] } = {}) {
  const svcs = A(services).filter((s) => s && S(s.id));
  const comps = A(components).filter((c) => c && S(c.id));
  const compById = new Map(comps.map((c) => [S(c.id), c]));
  const svcById = new Map(svcs.map((s) => [S(s.id), s]));

  // --- hierarchy (same rules as scope.js: dangling parents surface at the top,
  //     a cycle cannot hide a service).
  const nodes = new Map(svcs.map((s) => [S(s.id), {
    service: s, id: S(s.id), name: S(s.name) || S(s.id), children: [], parent: null, depth: 0,
  }]));
  const roots = [];
  for (const s of svcs) {
    const node = nodes.get(S(s.id));
    const p = S(s.parentServiceId).trim();
    if (p && nodes.has(p) && p !== S(s.id)) { nodes.get(p).children.push(node); node.parent = nodes.get(p); }
    else roots.push(node);
  }
  const reachable = new Set();
  const walk = (n, depth) => {
    if (reachable.has(n.id)) return;
    reachable.add(n.id);
    n.depth = depth;
    n.children.forEach((k) => walk(k, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  for (const s of svcs) if (!reachable.has(S(s.id))) { const n = nodes.get(S(s.id)); n.parent = null; roots.push(n); walk(n, 0); }

  // --- membership. `component.serviceId` is preferred over `service.componentIds`
  //     exactly as the contract says (§2).
  const ownOf = new Map([...nodes.keys()].map((id) => [id, []]));
  const unassigned = [];
  for (const c of comps) {
    const sid = S(c.serviceId).trim();
    if (sid && ownOf.has(sid)) ownOf.get(sid).push(c);
    else unassigned.push(c);
  }

  // --- rolled-up membership: a service is itself AND its sub-services.
  const descendants = (node, acc = new Set()) => {
    if (acc.has(node.id)) return acc;
    acc.add(node.id);
    for (const k of node.children) descendants(k, acc);
    return acc;
  };
  for (const node of nodes.values()) {
    node.own = ownOf.get(node.id) || [];
    node.descendantIds = descendants(node);
    node.all = [];
    for (const id of node.descendantIds) node.all.push(...(ownOf.get(id) || []));
    node.counts = { own: node.own.length, all: node.all.length, subServices: node.descendantIds.size - 1 };
    node.tier = node.service.tier ?? null;
  }

  // --- evidence: blockers, a runbook, a passing test.
  const openBlockers = A(gaps).filter((g) => g.severity === 'blocker' && !isClosedGap(g));
  const openGaps = A(gaps).filter((g) => !isClosedGap(g));
  const refsCache = new Map();
  const refsOf = (item) => {
    if (!refsCache.has(item)) refsCache.set(item, componentRefs(item));
    return refsCache.get(item);
  };
  const touches = (item, idSet, serviceIds) => {
    // An item may name the service directly (services-aware runbooks/tests) …
    if (S(item.serviceId) && serviceIds.has(S(item.serviceId))) return true;
    // … or, far more often, name components that belong to it.
    for (const id of refsOf(item)) if (idSet.has(id)) return true;
    return false;
  };
  for (const node of nodes.values()) {
    const idSet = new Set(node.all.map((c) => S(c.id)));
    node.openBlockers = openBlockers.filter((g) => touches(g, idSet, node.descendantIds));
    node.openGaps = openGaps.filter((g) => touches(g, idSet, node.descendantIds));
    node.runbooks = A(runbooks).filter((r) => touches(r, idSet, node.descendantIds));
    node.tests = A(tests).filter((t) => touches(t, idSet, node.descendantIds));
    node.hasRunbook = node.runbooks.some((r) => A(r.steps).length > 0);
    node.hasPassingTest = node.tests.some((t) => t.status === 'passed');
  }

  // --- THE QUESTION THE USER ACTUALLY ASKED: "the things they require".
  // A service requires another service when one of its components depends on a
  // component owned by that other service. Its OWN FAMILY does not count:
  // adjudication needing its own claims-intake is internal, and claims-intake
  // needing adjudication is the same edge seen from below — reporting either as
  // a cross-service requirement would make every parent look like it depends on
  // itself.
  for (const node of nodes.values()) {
    node.familyIds = new Set(node.descendantIds);
    for (let p = node.parent; p; p = p.parent) node.familyIds.add(p.id);
  }
  let crossCount = 0;
  for (const node of nodes.values()) {
    const req = new Map();     // otherServiceId | '' (unassigned) → {service, via[]}
    for (const c of node.all) {
      for (const depId of A(c.dependsOn)) {
        const dep = compById.get(S(depId));
        if (!dep) continue;                                   // dangling id: not a claim
        const depSvc = S(dep.serviceId).trim();
        if (depSvc && node.familyIds.has(depSvc)) continue;    // internal to this family
        const key = depSvc || '';
        if (!req.has(key)) req.set(key, { serviceId: depSvc || null, service: svcById.get(depSvc) || null, via: [] });
        req.get(key).via.push({ from: c, to: dep });
        crossCount += 1;
      }
    }
    node.requires = [...req.values()].sort((a, b) => b.via.length - a.via.length);
    node.requiresUnassigned = req.get('') || null;
  }
  // The reverse edge, so a service can say who would break without it.
  for (const node of nodes.values()) node.requiredBy = [];
  for (const node of nodes.values()) {
    for (const r of node.requires) {
      if (!r.serviceId) continue;
      const other = nodes.get(r.serviceId);
      if (other && other !== node) other.requiredBy.push({ serviceId: node.id, service: node.service, via: r.via });
    }
  }

  return {
    roots, nodes, byId: nodes, services: svcs,
    unassigned, crossCount,
    total: comps.length,
    assigned: comps.length - unassigned.length,
  };
}

// ---------------------------------------------------------------- bulk assign

const ASSIGN_KINDS = {
  service: { field: 'serviceId', label: 'service' },
  env: { field: 'envId', label: 'environment' },
  tier: { field: 'tier', label: 'tier' },
};

/**
 * Work out exactly what a bulk assignment would change, BEFORE it changes it.
 * Nothing is written by this function — a preview is a promise the apply step
 * then keeps.
 *
 *   buildAssignPlan({ kind:'service', components, target:'svc_adj', label:'adjudication', nameOf })
 *     → { kind, target, targetLabel, changes[], unchanged[], groups[], undoGroups[] }
 */
export function buildAssignPlan({ kind, components = [], target = null, targetLabel = '', nameOf = null } = {}) {
  const spec = ASSIGN_KINDS[kind];
  if (!spec) throw new Error(`unknown assignment kind '${kind}'`);
  const norm = (v) => (v === '' || v === undefined ? null : v);
  const to = norm(target);
  const name = typeof nameOf === 'function' ? nameOf : (v) => (v === null ? 'nothing' : S(v));

  const changes = [];
  const unchanged = [];
  for (const c of A(components)) {
    const from = norm(c[spec.field] ?? null);
    const same = kind === 'tier' ? Number(from ?? NaN) === Number(to ?? NaN) && (from == null) === (to == null) : from === to;
    if (same) unchanged.push(c);
    else changes.push({ id: S(c.id), component: c, from, fromLabel: name(from), to, toLabel: name(to) });
  }
  // The inverse, grouped by what each component USED to be, so one click puts
  // every one of them back exactly where it was.
  const undo = new Map();
  for (const ch of changes) {
    const key = ch.from === null ? '\u0000null' : S(ch.from);
    if (!undo.has(key)) undo.set(key, { target: ch.from, ids: [] });
    undo.get(key).ids.push(ch.id);
  }
  return {
    kind, field: spec.field, noun: spec.label,
    target: to, targetLabel: targetLabel || name(to),
    changes, unchanged,
    groups: changes.length ? [{ target: to, ids: changes.map((c) => c.id) }] : [],
    undoGroups: [...undo.values()],
  };
}

/** The inverse of a plan, ready to hand back to applyAssignPlan(). */
export function invertPlan(plan) {
  return {
    ...plan,
    groups: plan.undoGroups,
    undoGroups: plan.groups,
    targetLabel: 'where they were',
  };
}

// Which write path works in THIS server build, learned once per workspace. The
// model agent's bulk endpoints are preferred; a build without them falls back
// to writing both sides itself, which is the same end state.
const bulkCaps = new Map();
const capKey = (ws, kind) => `${ws}\u0000${kind}`;

/**
 * Apply a plan. Prefers the bulk endpoints
 * (`POST /w/:ws/services/:id/members`, `POST /w/:ws/environments/:id/members`)
 * and falls back to per-component writes that keep `component.serviceId` and
 * `service.componentIds` in step — the consistency server/store.js warns about.
 *
 * Returns `{ written, via }`. Throws only if nothing could be written at all.
 */
export async function applyAssignPlan(api, ws, plan) {
  const write = api.raw || api;
  let written = 0;
  let via = 'fallback';

  for (const group of plan.groups) {
    if (!group.ids.length) continue;
    const target = group.target;

    if (plan.kind !== 'tier' && target !== null && bulkCaps.get(capKey(ws, plan.kind)) !== 'fallback') {
      const base = plan.kind === 'service' ? 'services' : 'environments';
      try {
        await write.post(`/w/${ws}/${base}/${encodeURIComponent(target)}/members`, { componentIds: group.ids });
        bulkCaps.set(capKey(ws, plan.kind), 'bulk');
        written += group.ids.length;
        via = 'bulk endpoint';
        continue;
      } catch {
        // 404/501 (endpoint not in this build) or a server-side refusal: fall
        // through and do it by hand rather than losing the user's action.
        bulkCaps.set(capKey(ws, plan.kind), 'fallback');
      }
    }

    for (const id of group.ids) {
      await write.put(`/w/${ws}/c/components/${id}`, { [plan.field]: target });
      written += 1;
    }
  }

  // Keep `service.componentIds` honest when we wrote membership by hand. The
  // server rebuilds it from components on its own routes; on this path we are
  // the ones who have to.
  if (plan.kind === 'service' && via === 'fallback') {
    try { await reconcileServiceMembership(write, ws); } catch { /* the component side is the source of truth */ }
  }
  return { written, via };
}

/** Rebuild every `service.componentIds` from `component.serviceId`. */
export async function reconcileServiceMembership(api, ws) {
  const write = api.raw || api;
  const [comps, svcs] = await Promise.all([
    write.get(`/w/${ws}/c/components`).then((r) => r.items || [], () => []),
    write.get(`/w/${ws}/c/services`).then((r) => r.items || [], () => []),
  ]);
  const want = new Map(svcs.map((s) => [S(s.id), []]));
  for (const c of comps) {
    const sid = S(c.serviceId).trim();
    if (sid && want.has(sid)) want.get(sid).push(S(c.id));
  }
  for (const s of svcs) {
    const next = want.get(S(s.id)) || [];
    const cur = A(s.componentIds).map(S);
    if (next.length === cur.length && next.every((id, i) => id === cur[i])) continue;
    await write.put(`/w/${ws}/c/services/${s.id}`, { componentIds: next });
  }
}

/**
 * "N components aren't in a service yet" — a first-class state, never an error.
 * Prefers `GET /w/:ws/unassigned` and derives it locally when that endpoint is
 * not in this build.
 */
export async function loadUnassigned(api, ws, components = null) {
  const read = api.raw || api;
  try {
    const r = await read.get(`/w/${ws}/unassigned`);
    if (r && (Array.isArray(r.components) || Array.isArray(r.items))) {
      const items = r.components || r.items;
      return {
        source: 'endpoint',
        noService: A(r.noService || items.filter((c) => !c.serviceId)),
        noEnv: A(r.noEnv || items.filter((c) => !c.envId)),
      };
    }
  } catch { /* not in this build — derive it */ }
  const comps = components || await read.get(`/w/${ws}/c/components`).then((r) => r.items || [], () => []);
  return {
    source: 'derived',
    noService: comps.filter((c) => !S(c.serviceId).trim()),
    noEnv: comps.filter((c) => !S(c.envId).trim()),
  };
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
