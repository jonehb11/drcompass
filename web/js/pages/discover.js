// =============================================================================
// Discover — find the things your DR plan has to cover.
//
// The page leads with a CHOOSER ("how do you want to find your resources?"),
// keeps a persistent STATUS STRIP of what discovery has already achieved, and
// only then exposes the five source-specific workflows as tabs. Every action
// states its outcome before it is clicked; every result ends with a next step.
//
// Table of contents
//   §1  Vocabulary          SERVICE_LABELS, styles, localStorage, availability
//   §2  Plain English       ensureGlossary/term, promiseLine, actionRow,
//                           advanced(), nextSteps() — the copy primitives
//   §3  AI tenancy          lazy ai-actions.js probe, aiRow (upgrades itself to
//                           that module's aiActionRow), aiMatchUnlinked
//                           (POST /ai/correlate + /ai/correlate/apply)
//   §4  Background jobs     KIND_INFO, start/poll/attach, activity cards,
//                           resume-on-load, "Last run" cards  (unchanged)
//   §5  Shared widgets      jsonDropZone, proposal tree, proposalsPanel,
//                           logPanel, errorBadges
//   §6  AWS auth pre-flight makeAwsAuth: check / statusLine / preflight
//   §7  Discovery state     loadDiscoveryState (graph via ?summary=1, with a
//                           full-graph fallback), nextActions, statusStrip —
//                           what this workspace has already found, and what
//                           is stale (the returning-user view)
//   §8  Start view          pathChooser (empty inventory) and whatsNext
//                           (inventory that already has components)
//   §9  Tab: AWS account    one connection card, scan & map, script+upload,
//                           map dependencies (was "deep enrichment"),
//                           find resources by tag (was "correlate by tag")
//   §10 Tab: Arpio          two-part key, trace, import → map those only
//   §11 Tab: Kubernetes     snapshot state first, then the two capture paths
//   §12 Tab: Ask AI         ask + "find what I'm likely missing"
//   §13 Tab: Network flows  local CSV parse, columns, flows, assignment, apply
//   §14 Page shell          tabs, deep links (#/:ws/discover/<view>[/<focus>]),
//                           default view, focus targets
// =============================================================================

import { h, card, badge, table, toast, markdown, field, empty, confirmDialog, modal, pageHead, snapshot } from '../ui.js';
import { crumbFor, nextStepFor } from '../onboarding.js';

// ------------------------------------------------------------------- §1 vocab

const SERVICE_LABELS = {
  eks: 'EKS', ecs: 'ECS', lambda: 'Lambda', 'ec2-asg': 'EC2 ASG', rds: 'RDS/Aurora',
  dynamodb: 'DynamoDB', elasticache: 'ElastiCache', sqs: 'SQS', sns: 'SNS',
  kinesis: 'Kinesis', s3: 'S3', secrets: 'Secrets Mgr', route53: 'Route 53',
  cloudfront: 'CloudFront', elb: 'ELB', apigateway: 'API Gateway', ecr: 'ECR',
  transfer: 'Transfer', msk: 'MSK', efs: 'EFS',
};

const STYLE = `
  .svc-chips { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 12px; }
  .svc-chip { padding:4px 11px; border-radius:999px; border:1px solid var(--border); background:var(--panel2);
    color:var(--muted); font:600 12px var(--sans); cursor:pointer; user-select:none; }
  .svc-chip.on { background:var(--accent-soft); color:#9cc0fa; border-color:rgba(79,143,247,.4); }
  .disc-log pre { max-height:260px; overflow:auto; margin-top:8px; }
  .disc-log summary { cursor:pointer; color:var(--muted); font-weight:600; font-size:12.5px; }
  .prompt-chip { padding:4px 11px; border-radius:999px; border:1px solid var(--border); background:var(--panel2);
    color:var(--text); font:600 12px var(--sans); cursor:pointer; }
  .prompt-chip:hover { border-color:var(--accent); color:#9cc0fa; }
  .facts-cell { color:var(--muted); font-size:12.5px; max-width:420px; }
  .drop-zone { border:2px dashed var(--border); border-radius:10px; padding:26px 16px; text-align:center;
    color:var(--muted); cursor:pointer; font-weight:600; font-size:13px; }
  .drop-zone.over { border-color:var(--accent); background:var(--accent-soft); color:#9cc0fa; }
  .muted-card { opacity:.78; }
  .snap-meta { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; font-size:13px; margin:8px 0 10px; }
  .snap-meta .k { color:var(--muted); font-weight:600; }
  .enrich-comps { display:flex; flex-direction:column; gap:6px; max-height:240px; overflow-y:auto;
    border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:2px 0 12px; background:var(--bg2); }

  /* proposal tree (Arpio-style review) */
  .pt-caret { background:none; border:1px solid var(--border); border-radius:6px; color:var(--muted);
    cursor:pointer; font:700 10px var(--mono); padding:1px 6px; margin-right:8px; vertical-align:1px; }
  .pt-caret:hover { color:var(--text); border-color:#3a4557; }
  .pt-dep-line { font-size:11.5px; color:var(--muted); margin-top:3px; }
  .pt-dep-why { margin-top:3px; font-size:11.5px; }
  .pt-dep-why summary { cursor:pointer; color:var(--muted); }
  .pt-dep-why ul { margin:4px 0 0 16px; color:var(--muted); }
  .pt-dep-why li { margin:2px 0; }
  .pt-dep-note { margin-top:3px; font-size:11.5px; }
  .pt-needed { margin-left:8px; }
  .pt-assoc-tr td { border-bottom:0; padding:2px 10px; background:rgba(18,22,29,.5); }
  .pt-assoc-tr:last-of-type td, .pt-assoc-last td { border-bottom:1px solid rgba(42,50,66,.55); padding-bottom:7px; }
  .pt-assoc { display:flex; gap:8px; align-items:center; flex-wrap:wrap; color:var(--muted);
    font-size:12px; padding-left:16px; }
  .pt-glyph { flex:none; min-width:32px; text-align:center; font:700 9.5px var(--mono); color:var(--muted);
    border:1px solid var(--border); border-radius:5px; padding:2px 4px; background:var(--panel); }
  .pt-assoc-name { color:var(--text); opacity:.85; overflow-wrap:anywhere; }
  .pt-assoc-rel { font-style:italic; font-size:11.5px; }
  .pt-assoc-rid { font-family:var(--mono); font-size:10.5px; opacity:.75; overflow-wrap:anywhere; }
  .pt-tag-chip { background:var(--bg2); border:1px solid var(--border); border-radius:999px;
    padding:0 7px; font-size:10.5px; color:var(--muted); max-width:220px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }

  /* deep enrichment */
  .arpio-preset { border:1px solid rgba(157,123,245,.35); background:rgba(157,123,245,.08);
    border-radius:10px; padding:12px 14px; margin:0 0 14px; }
  .arpio-preset h3 { color:var(--purple); margin-bottom:4px; }

  /* multi-tag filter editor */
  .tagf-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .tagf-row .tagf-key { flex:1; min-width:120px; }
  .tagf-row .tagf-vals { flex:2; min-width:180px; }
  .tagf-x { background:none; border:1px solid var(--border); border-radius:7px; color:var(--muted);
    cursor:pointer; font-size:12px; line-height:1; padding:6px 9px; flex:none; }
  .tagf-x:hover { color:var(--err); border-color:rgba(226,86,79,.4); }
  .tagf-x[disabled] { opacity:.35; cursor:default; }

  /* AWS auth pre-flight */
  .auth-line { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:-4px 0 12px;
    font-size:12.5px; color:var(--muted); }
  .auth-line .auth-id { overflow-wrap:anywhere; }
  .auth-wait-sec { font-family:var(--mono); }

  /* background jobs */
  .job-head { display:flex; gap:10px; align-items:center; }
  .job-dot { width:10px; height:10px; border-radius:999px; background:var(--accent); flex:none;
    animation: job-pulse 1.3s ease-in-out infinite; }
  @keyframes job-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; box-shadow:0 0 0 5px rgba(79,143,247,.12); } }
  .job-elapsed { font-family:var(--mono); font-size:12.5px; color:var(--muted); }
  .job-log { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:10px 12px;
    margin-top:10px; max-height:190px; overflow-y:auto; font-family:var(--mono); font-size:12px;
    line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); }
  .job-safe { margin-top:8px; font-size:12.5px; color:var(--ok); }
  .tab .badge { margin-left:6px; vertical-align:1px; }
  .lastrun-sum { color:var(--muted); font-size:12.5px; margin-top:6px; overflow-wrap:anywhere; }

  /* plain-English promises under each action */
  .act { margin:2px 0 0; }
  .act-promise { color:var(--muted); font-size:12.5px; margin:7px 0 0; max-width:70ch; }
  .act-promise .act-ro { color:var(--ok); font-weight:600; }
  .act-promise .act-time { color:var(--muted); }
  .jargon { color:var(--muted); font-weight:400; font-size:.92em; }

  /* "Advanced" disclosures — power kept, clutter hidden */
  .adv { border:1px solid var(--border); border-radius:9px; background:var(--bg2); margin:12px 0; }
  .adv > summary { cursor:pointer; padding:8px 12px; font:600 12.5px var(--sans); color:var(--muted);
    list-style-position:inside; }
  .adv[open] > summary { border-bottom:1px solid var(--border); color:var(--text); }
  .adv-body { padding:12px 14px 4px; }

  /* every result ends with somewhere to go */
  .next-steps { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:12px;
    border-top:1px solid var(--border); padding-top:10px; }
  .next-steps .next-label { font:700 10.5px var(--sans); letter-spacing:.08em; text-transform:uppercase;
    color:var(--muted); }
  .next-step, .next-step-btn { font:600 12.5px var(--sans); }
  .next-step-btn { background:none; border:0; color:var(--accent); cursor:pointer; padding:0; }
  .next-step-btn:hover { text-decoration:underline; }

  /* status strip — what discovery already achieved */
  .ds-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); gap:12px 14px; }
  .ds-tile { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .ds-val { font:700 22px var(--sans); letter-spacing:-.02em; line-height:1.15; }
  .ds-val.none { color:var(--muted); }
  .ds-lab { font-size:12px; color:var(--muted); }
  .ds-act { font:600 12px var(--sans); background:none; border:0; color:var(--accent); cursor:pointer;
    padding:0; text-align:left; }
  .ds-act:hover { text-decoration:underline; }
  .ds-runs { display:flex; flex-wrap:wrap; gap:8px 18px; margin-top:12px; border-top:1px solid var(--border);
    padding-top:10px; font-size:12.5px; }
  .ds-run { display:flex; gap:7px; align-items:center; }
  .ds-run .ds-run-k { color:var(--muted); font-weight:600; }

  /* the chooser */
  .ch-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(272px,1fr)); gap:12px; margin-top:4px; }
  .ch-card { text-align:left; background:var(--bg2); border:1px solid var(--border); border-radius:11px;
    padding:14px 15px; cursor:pointer; color:var(--text); font:inherit; display:flex; flex-direction:column;
    gap:7px; }
  .ch-card:hover { border-color:var(--accent); background:var(--accent-soft); }
  .ch-title { font:650 14px var(--sans); }
  .ch-kv { font-size:12.5px; color:var(--muted); display:flex; gap:6px; }
  .ch-kv b { color:var(--text); font-weight:600; flex:none; }
  .ch-go { color:var(--accent); font:600 12.5px var(--sans); margin-top:auto; }
  .ch-sec { display:flex; flex-direction:column; gap:8px; margin-top:6px; }
  .ch-sec-row { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; background:var(--bg2);
    border:1px solid var(--border); border-radius:9px; padding:9px 12px; }
  .ch-sec-row .ch-sec-t { font:600 13px var(--sans); }
  .ch-sec-row .hint { flex:1; min-width:160px; }

  /* what's next / what's stale */
  .wn-list { display:flex; flex-direction:column; gap:8px; margin-top:4px; }
  .wn-row { display:flex; gap:11px; align-items:center; flex-wrap:wrap; border:1px solid var(--border);
    border-radius:9px; padding:10px 12px; background:var(--bg2); }
  .wn-row .wn-why { color:var(--muted); font-size:12.5px; flex:1; min-width:180px; }
  .ai-inline { margin-top:12px; }
  .ai-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
  .ai-row .hint { flex:1; min-width:160px; }
`;

// localStorage conveniences — storage can be blocked; never let that break the page.
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch { /* best effort */ } }

// A 501/404 from a backend that isn't mounted yet should read as "coming soon",
// not as a broken tab. api.js throws `${status} ${statusText}` for such responses.
function isUnavailable(e) {
  return /\b(404|501)\b|not implemented|not found|no such endpoint|feature unavailable|cannot (get|post|delete|find module)/i
    .test(e?.message || '');
}
function unavailableCard(title) {
  return card(
    h('h2', null, title),
    h('p', { class: 'hint' },
      'This backend is not available yet — the server may be mid-update. Restart DR Compass or reload this page once it is; nothing here is lost.'),
  );
}

// ------------------------------------------------------- §2 plain English
// Nobody should have to know what "enrichment" means to use this page. Plain
// labels lead; the technical word survives in a parenthetical + tooltip so the
// people who DO know it can still find the feature they read about.
//
// A parallel agent is adding a `term()` glossary helper to ui.js. Probe for it
// once (dynamic import — a static named import of a not-yet-existing export
// would fail to link and take the whole page down) and use it when present.

let termFn = null;
let glossaryProbed = false;
export async function ensureGlossary() {
  if (glossaryProbed) return;
  glossaryProbed = true;
  try {
    const ui = await import('../ui.js');
    if (typeof ui.term === 'function') termFn = ui.term;
  } catch { /* ui.js is already loaded; never let a probe break the page */ }
}

// term('Map dependencies', 'enrichment', 'deep enrichment')
//   plain  — the label a newcomer understands; it always leads
//   key    — the glossary key ui.js defines (its signature is term(key, label))
//   legacy — the words older docs and other pages use, for the fallback
// With ui.js's glossary the label gets a dotted underline and a definition
// popover; without it, a quiet parenthetical carries the technical word.
export function term(plain, key, legacy = key) {
  if (termFn) {
    try {
      const out = termFn(key, plain);
      if (out instanceof Node || typeof out === 'string') return out;
    } catch { /* fall through to the local rendering */ }
  }
  if (!legacy) return plain;
  return h('span', { title: `Also called “${legacy}”` }, plain, ' ', h('span', { class: 'jargon' }, `(${legacy})`));
}

// The one-line promise under every action: what it does, what it costs, and
// whether it can change anything. `readOnly` and `time` are the two facts
// users actually hesitate over.
function promiseLine(text, { time = '', readOnly = false, nothingWritten = false } = {}) {
  return h('p', { class: 'act-promise' },
    text,
    readOnly ? h('span', { class: 'act-ro' }, ' Read-only — nothing in AWS is changed.') : null,
    nothingWritten ? h('span', { class: 'act-ro' }, ' Nothing is imported until you review it.') : null,
    time ? h('span', { class: 'act-time' }, ` Usually ${time}.`) : null);
}

// ui.js's card() takes children only, but discovery cards need ids so deep
// links, the status strip and "what's next" can focus the right one.
function panel(attrs, ...children) {
  const el = card(...children);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

// An action = its controls and its promise, always adjacent.
function actionRow(controls, promiseEl) {
  return h('div', { class: 'act' },
    h('div', { class: 'row' }, ...[].concat(controls).filter(Boolean)),
    promiseEl || null);
}

// Advanced disclosure: sensible defaults stay visible, the knobs fold away.
function advanced(summaryText, ...children) {
  return h('details', { class: 'adv' },
    h('summary', null, summaryText || 'Advanced'),
    h('div', { class: 'adv-body' }, ...children.filter(Boolean)));
}

// No result dead-ends. steps: {label, href} | {label, onClick} | falsy.
function nextSteps(...steps) {
  const items = steps.flat(Infinity).filter(Boolean).map((s) => (s.href
    ? h('a', { class: 'next-step', href: s.href }, `→ ${s.label}`)
    : h('button', { class: 'next-step-btn', onClick: s.onClick }, `→ ${s.label}`)));
  if (!items.length) return null;
  return h('div', { class: 'next-steps' }, h('span', { class: 'next-label' }, 'Next'), items);
}

// ------------------------------------------------------------ §3 AI tenancy
// AI is a first-class tenant of discovery, but `web/js/ai-actions.js` ships
// from a parallel agent. Every use is lazy + guarded and degrades in two
// steps: ai-actions.js → this page's own POST /ai/ask → the Ask AI tab.

let aiProbe = null;
function loadAiActions() {
  if (!aiProbe) {
    aiProbe = import('../ai-actions.js')
      .then((m) => (m && typeof m === 'object' ? m : null))
      .catch(() => null); // module not shipped yet — that is a supported state
  }
  return aiProbe;
}

// Set when an AI question is handed off to the Ask AI tab; consumed by renderAi.
let pendingAiPrompt = '';

// Fallback AI button, used only when ai-actions.js is absent: asks through this
// page's own /ai/ask endpoint and renders the answer inline next to the thing
// being asked about.
function fallbackAiButton(ctx, { label, prompt, host }) {
  const btn = h('button', { class: 'btn btn-sm', title: 'Asks your local Claude Code CLI — your account, your machine' },
    `✦ ${label}`);
  btn.addEventListener('click', async () => {
    const idle = btn.textContent;
    btn.disabled = true;
    btn.textContent = '✦ Thinking…';
    const box = host || h('div');
    box.innerHTML = '';
    box.append(card(h('div', { class: 'loading' }, 'Asking your local Claude Code CLI…')));
    try {
      const res = await ctx.api.post(`/w/${ctx.ws}/ai/ask`, { prompt, includeContext: true });
      box.innerHTML = '';
      box.append(res?.ok
        ? card(h('h3', { style: 'margin-bottom:8px' }, label), markdown(res.answer || '(empty answer)'),
            nextSteps({ label: 'Ask a follow-up on the Ask AI tab', href: `#/${ctx.ws}/discover/ai` }))
        : card(badge(res?.message || 'The local Claude Code CLI did not answer', 'warn'),
            nextSteps({ label: 'Set up the Claude Code CLI on the Ask AI tab', href: `#/${ctx.ws}/discover/ai` })));
    } catch (e) {
      box.innerHTML = '';
      pendingAiPrompt = prompt; // the Ask AI tab picks this up pre-filled
      box.append(card(
        badge(e.message || 'AI is unavailable here', 'warn'),
        nextSteps({ label: 'Take this question to the Ask AI tab', href: `#/${ctx.ws}/discover/ai` })));
    } finally {
      btn.disabled = false;
      btn.textContent = idle;
    }
  });
  return btn;
}

// A row of contextual AI affordances. Renders the fallback synchronously, then
// upgrades itself to ai-actions.js's own `aiActionRow` the moment that module
// resolves — so the page never waits on it and never breaks without it.
// `actions` are aiButton option objects: {label, prompt, context, mode, …}.
function aiRow(ctx, { hint, actions, host, label = 'AI' }) {
  const list = (actions || []).filter(Boolean);
  const row = h('div', { class: 'ai-row' });
  row.append(
    ...list.map((a) => fallbackAiButton(ctx, { label: a.label, prompt: a.prompt, host })),
    hint ? h('span', { class: 'hint' }, hint) : null);
  loadAiActions().then((mod) => {
    if (!mod || typeof mod.aiActionRow !== 'function' || !row.isConnected) return;
    try {
      const upgraded = mod.aiActionRow({ ws: ctx.ws, api: ctx.api, actions: list, label, hint });
      if (upgraded instanceof Node) row.replaceWith(upgraded);
    } catch { /* keep the fallback row */ }
  });
  return row;
}

// "Explain what this resource is and why it matters for DR" — the per-row AI
// affordance on a proposal. Answers land in `host`, directly under the table.
async function explainProposal(ctx, p, host, btn) {
  const idle = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  const prompt = `In plain English, explain what the AWS resource "${p.name}" (${p.kind}${p.arn ? `, ARN ${p.arn}` : ''}) is, and why it matters for disaster recovery: what depends on it, what breaks if it is missing in the recovery region, and what I should record about it. Two short paragraphs at most.`;
  host.innerHTML = '';
  host.append(card(h('div', { class: 'loading' }, `Asking about ${p.name}…`)));
  try {
    let res = null;
    const mod = await loadAiActions();
    if (mod && typeof mod.aiAsk === 'function') {
      res = await mod.aiAsk({ ws: ctx.ws, api: ctx.api, prompt, context: { kind: 'workspace' } });
    }
    if (!res || !res.ok) {
      res = await ctx.api.post(`/w/${ctx.ws}/ai/ask`, { prompt, includeContext: true });
    }
    host.innerHTML = '';
    host.append(res?.ok
      ? card(h('h3', { style: 'margin-bottom:8px' }, `${p.name} — what it is, why it matters`),
          markdown(res.answer || '(empty answer)'),
          h('p', { class: 'hint', style: 'margin-top:8px' }, 'An explanation only — nothing was imported or changed.'))
      : card(badge(res?.message || 'The local Claude Code CLI did not answer', 'warn'),
          nextSteps({ label: 'Set up the Claude Code CLI on the Ask AI tab', href: `#/${ctx.ws}/discover/ai` })));
  } catch (e) {
    host.innerHTML = '';
    host.append(card(badge(e.message || 'AI is unavailable here', 'warn')));
  } finally {
    btn.disabled = false;
    btn.textContent = idle;
  }
}

// The button for the above, disabled with a helpful title when the local CLI
// is missing (borrowing ai-actions.js's cached availability probe).
function aiCorrelateButton(ctx, { onApplied } = {}) {
  const btn = h('button', { class: 'btn btn-sm' }, '✦ Match unlinked resources to components');
  btn.addEventListener('click', () => aiMatchUnlinked(ctx, btn, { onApplied }));
  loadAiActions().then((mod) => {
    if (!mod || typeof mod.aiAvailable !== 'function') return;
    mod.aiAvailable(ctx.api).then((ok) => {
      if (ok) return;
      btn.disabled = true;
      btn.title = `${mod.INSTALL_HINT || 'The local Claude Code CLI was not found.'}\n\n${mod.INSTALL_STEPS || ''}`;
    }).catch(() => { /* leave the button enabled; the click path reports the real error */ });
  });
  return btn;
}

// "Match these unlinked resources to components" — wired to the EXISTING
// correlate endpoints (POST /ai/correlate, then /ai/correlate/apply with only
// the links the user ticked). ai-actions.js has no correlate equivalent (its
// aiOperations speaks to /ai/draft), so this keeps its own review modal, and
// only borrows that module's CLI-availability check.
async function aiMatchUnlinked(ctx, btn, { onApplied } = {}) {
  const idle = btn.textContent;
  btn.disabled = true;
  btn.textContent = '✦ Matching…';
  try {
    const r = await ctx.api.post(`/w/${ctx.ws}/ai/correlate`, {});
    if (!r?.ok) { toast(r?.message || r?.error || 'AI matching failed', 'err'); return; }
    const links = Array.isArray(r.links) ? r.links : [];
    if (!links.length) {
      toast(r.message || 'Nothing left to match — every discovered resource is already linked.', 'ok');
      return;
    }
    const rows = links.map((l) => {
      const conf = Math.max(0, Math.min(1, Number(l.confidence) || 0));
      const cb = h('input', { type: 'checkbox', checked: conf >= 0.7, style: 'width:auto;margin-top:3px' });
      const el = h('label', { style: 'display:flex;gap:10px;align-items:flex-start;padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer' },
        cb,
        h('div', { style: 'flex:1;min-width:0' },
          h('div', null,
            h('strong', null, l.targetName || l.rid || l.workloadUid || '?'), ' ',
            badge(l.workloadUid ? 'k8s workload' : (l.targetType || 'resource')), ' → ',
            h('strong', null, l.componentName || l.componentId)),
          l.why ? h('div', { class: 'hint', style: 'margin-top:2px' }, l.why) : null),
        badge(`${Math.round(conf * 100)}%`, conf >= 0.7 ? 'ok' : 'warn'));
      return { l, cb, el };
    });
    const res = await modal('Link these resources to components?',
      h('div', null,
        h('p', { class: 'hint', style: 'margin-bottom:8px' },
          'Your local Claude Code CLI proposed these links. Rows at 70% or better are pre-ticked. Nothing is written until you apply, and every link is re-validated server-side.'),
        h('div', { style: 'max-height:420px;overflow-y:auto' }, rows.map((x) => x.el))),
      { wide: true, actions: [{
        label: 'Apply selected', kind: 'btn-primary',
        onClick: async () => {
          const sel = rows.filter((x) => x.cb.checked).map(({ l }) => ({
            ...(l.rid ? { rid: l.rid } : { workloadUid: l.workloadUid }),
            componentId: l.componentId,
          }));
          if (!sel.length) { toast('Nothing selected', 'err'); return undefined; }
          try { return await ctx.api.post(`/w/${ctx.ws}/ai/correlate/apply`, { links: sel }); }
          catch (e) { toast(`Apply failed: ${e.message || e}`, 'err'); return undefined; }
        },
      }] });
    if (!res) return; // cancelled
    const n = res.applied?.length ?? 0;
    const failed = res.errors?.length ?? 0;
    toast(h('span', null, `${n} link${n === 1 ? '' : 's'} applied${failed ? `, ${failed} failed` : ''} — `,
      h('a', { href: `#/${ctx.ws}/diagrams` }, 'see them on the Diagrams page →')), failed ? 'err' : 'ok');
    await onApplied?.();
  } catch (e) {
    // 503 when the Claude CLI is absent — the server's message is already human.
    toast(`AI matching unavailable: ${e.message || e}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = idle;
  }
}

// ------------------------------------------------------- §4 background jobs
// Long discovery operations run as server-side jobs (POST /w/:ws/jobs) so a
// page refresh never loses a run: the page polls for progress, shows a live
// activity card, and re-attaches on load. When the jobs backend is not
// mounted (404/501), every action falls back to its original synchronous
// call path unchanged.

const KIND_INFO = {
  'aws-scan':      { tab: 'aws',   label: 'AWS scan',        running: 'Scanning AWS account…',        done: 'AWS scan finished' },
  'aws-scan-map':  { tab: 'aws',   label: 'AWS scan & map',  running: 'Scanning AWS account…',        done: 'AWS scan & map finished' },
  'enrich':        { tab: 'aws',   label: 'Deep enrichment', running: 'Enriching components…',        done: 'Enrichment finished' },
  'enrich-by-tag': { tab: 'aws',   label: 'Tag pull',        running: 'Pulling resources by tag…',    done: 'Tag pull finished' },
  'arpio':         { tab: 'arpio', label: 'Arpio import',    running: 'Scanning Arpio account…',      done: 'Arpio scan finished' },
  'k8s-scan':      { tab: 'k8s',   label: 'Kubernetes scan', running: 'Scanning Kubernetes cluster…', done: 'Kubernetes scan finished' },
};

const runningJobs = new Map();   // jobId -> tab id; drives the "N running" tab badges
let currentTabEls = null;        // this page's tab <span>s, set on each page render
const dismissedJobs = new Set(); // session-only "Last run" card dismissals

function refreshTabBadges() {
  if (!currentTabEls) return;
  for (const te of currentTabEls) {
    const n = [...runningJobs.values()].filter((t) => t === te.dataset.tab).length;
    te.textContent = te.dataset.label || te.textContent;
    if (n) te.append(' ', badge(`${n} running`, 'accent'));
  }
}
function addRunning(jobId, tab) {
  if (!tab || runningJobs.get(jobId) === tab) return;
  runningJobs.set(jobId, tab);
  refreshTabBadges();
}
function removeRunning(jobId) {
  if (runningJobs.delete(jobId)) refreshTabBadges();
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtAgo(ts) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Raw fetch (not api.js) so 409-with-jobId and 404/501-unavailable are
// distinguishable by status instead of by parsing an error message.
async function postJsonRaw(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body (e.g. an HTML 404 page) */ }
  return { status: res.status, data };
}

// Pure-ish, node-testable: start a job, attaching to the already-running one
// on 409. postJson(path, body) -> {status, data} and never throws on HTTP
// error statuses. Throws {unavailable:true} when the jobs backend is absent.
export async function startOrAttachJob(postJson, ws, kind, params) {
  const { status, data } = await postJson(`/api/w/${ws}/jobs`, { kind, params });
  if (status === 201 && data?.jobId) return { jobId: data.jobId, attached: false };
  if (status === 409 && data?.jobId) return { jobId: data.jobId, attached: true };
  if (status === 404 || status === 501) {
    const e = new Error(`${status} — jobs backend unavailable`);
    e.unavailable = true;
    throw e;
  }
  const e = new Error(data?.error || `Could not start the job (HTTP ${status})`);
  e.status = status;
  throw e;
}

// Pure-ish, node-testable: poll one job until it finishes. Polls every
// intervalMs, backing off to slowIntervalMs once slowAfterMs has passed.
// io: { getJob(id), sleep(ms), now?, onTick?(job), shouldStop?() }.
// Resolves the finished job on 'done'; throws (with .job attached) on
// 'error'; resolves null if shouldStop() says the UI abandoned the poll
// (the job itself keeps running server-side).
export async function pollJobUntilDone(jobId, io, { intervalMs = 1500, slowAfterMs = 60000, slowIntervalMs = 3000 } = {}) {
  const now = io.now || Date.now;
  const t0 = now();
  for (;;) {
    const job = await io.getJob(jobId);
    io.onTick?.(job);
    if (job?.status === 'done') return job;
    if (job?.status === 'error') {
      const e = new Error(job.error || 'Job failed');
      e.job = job;
      throw e;
    }
    if (io.shouldStop?.()) return null;
    await io.sleep(now() - t0 > slowAfterMs ? slowIntervalMs : intervalMs);
  }
}

function setButtonsRunning(buttons, running) {
  for (const b of buttons || []) {
    if (!b?.el) continue;
    b.el.disabled = running ? true : !!b.idleDisabled;
    const text = running ? b.runningText : b.idleText;
    if (text) b.el.textContent = text;
  }
}

// The live activity card: pulsing dot + label, client-side elapsed ticker,
// last ~12 progress lines auto-scrolling, full log expandable, and the
// reassurance that a refresh loses nothing.
function activityCard(label) {
  const elapsedEl = h('span', { class: 'job-elapsed' }, '0:00');
  const logEl = h('div', { class: 'job-log', hidden: true });
  const fullSummary = h('summary', null, 'Full log');
  const fullPre = h('pre', { class: 'mono' }, '');
  const fullDetails = h('details', { class: 'disc-log', style: 'margin-top:8px', hidden: true }, fullSummary, fullPre);
  const el = card(
    h('div', { class: 'job-head' },
      h('span', { class: 'job-dot' }),
      h('strong', null, label),
      h('span', { class: 'spacer' }),
      elapsedEl),
    logEl,
    fullDetails,
    h('p', { class: 'job-safe' }, 'Safe to leave or refresh this page — the job keeps running and results are saved.'),
  );
  let base = Date.now();
  const tick = () => { elapsedEl.textContent = fmtElapsed(Date.now() - base); };
  const timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    tick();
  }, 1000);
  return {
    el,
    update(job) {
      if (Number.isFinite(job?.elapsedMs)) base = Date.now() - job.elapsedMs;
      const prog = Array.isArray(job?.progress) ? job.progress : [];
      if (prog.length) {
        logEl.hidden = false;
        logEl.textContent = prog.slice(-12).join('\n');
        logEl.scrollTop = logEl.scrollHeight;
        if (prog.length > 12) {
          fullDetails.hidden = false;
          fullSummary.textContent = `Full log (${prog.length} lines)`;
          fullPre.textContent = prog.join('\n');
        }
      }
      tick();
    },
    stop() { clearInterval(timer); },
  };
}

function jobErrorCard(title, e) {
  const progress = Array.isArray(e?.job?.progress) ? e.job.progress : [];
  return card(
    h('h2', null, `${title} failed`),
    h('p', { style: 'margin:8px 0' }, badge(e?.message || 'Job failed', 'err')),
    progress.length
      ? h('details', { class: 'disc-log', open: true, style: 'margin:10px 0' },
          h('summary', null, `Progress log (${progress.length} lines)`),
          h('pre', { class: 'mono' }, progress.join('\n')))
      : null,
  );
}

// Attach the UI to a job (fresh or resumed): activity card in spec.host,
// poll to completion, then render through the shared renderer. If the card
// leaves the DOM (tab switched / host reused) polling stops quietly — the
// job keeps running server-side and resume-on-load picks it back up.
async function attachToJob(ctx, jobId, spec) {
  const { kind, host, render, buttons = [], doneToast } = spec;
  const info = KIND_INFO[kind] || {};
  const label = spec.label || info.running || 'Working…';
  addRunning(jobId, info.tab);
  setButtonsRunning(buttons, true);
  host.innerHTML = '';
  const act = activityCard(label);
  host.append(act.el);
  let failures = 0;
  const getJob = async () => {
    try {
      const j = await ctx.api.get(`/w/${ctx.ws}/jobs/${jobId}`);
      failures = 0;
      return j;
    } catch (e) {
      if (++failures >= 3) throw e; // three misses in a row — give up for real
      return { status: 'running', transient: true }; // brief blip — keep waiting
    }
  };
  try {
    const job = await pollJobUntilDone(jobId, {
      getJob,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onTick: (j) => { if (!j?.transient) { act.update(j); addRunning(jobId, info.tab); } },
      shouldStop: () => !act.el.isConnected,
    });
    act.stop();
    if (!job) return; // abandoned — resume-on-load re-attaches later
    host.innerHTML = '';
    render(job.result ?? {});
    if (doneToast) doneToast(job.result ?? {});
    else toast(`${info.done || 'Job finished'} in ${fmtElapsed(job.elapsedMs)} — results below`, 'ok');
  } catch (e) {
    act.stop();
    if (act.el.isConnected) {
      host.innerHTML = '';
      host.append(jobErrorCard(info.label || 'Job', e));
      toast(e.message, 'err');
    }
  } finally {
    removeRunning(jobId);
    setButtonsRunning(buttons, false);
  }
}

// Job-first runner for an action button. Returns true when the job path
// handled the run (success or failure rendered); false when the jobs
// backend is unavailable, in which case the caller runs its original
// synchronous path unchanged.
async function runJob(ctx, kind, params, { renderResult, activityHost, label, buttons = [], doneToast } = {}) {
  setButtonsRunning(buttons, true);
  let start;
  try {
    start = await startOrAttachJob(postJsonRaw, ctx.ws, kind, params);
  } catch (e) {
    if (e.unavailable) return false; // sync fallback manages the button from here
    setButtonsRunning(buttons, false);
    activityHost.innerHTML = '';
    activityHost.append(jobErrorCard(KIND_INFO[kind]?.label || 'Job', e));
    toast(e.message, 'err');
    return true;
  }
  if (start.attached) toast('Already running — attached');
  await attachToJob(ctx, start.jobId, { kind, host: activityHost, render: renderResult, label, buttons, doneToast });
  return true;
}

// Resume-on-load: one GET /jobs per tab render. Re-attaches to any running
// job of this tab's kinds; otherwise offers a slim "Last run" card for the
// newest job that finished within 24h. Also refreshes every tab badge from
// the same snapshot. kindMap: kind -> {host, render, label?, buttons?, doneToast?}.
async function resumeJobs(ctx, tabId, kindMap) {
  let jobs;
  try { jobs = (await ctx.api.get(`/w/${ctx.ws}/jobs`))?.jobs || []; }
  catch { return; } // jobs backend not mounted — nothing to resume
  try {
    runningJobs.clear();
    for (const j of jobs) {
      if (j?.status === 'running' && KIND_INFO[j.kind]) runningJobs.set(j.id, KIND_INFO[j.kind].tab);
    }
    refreshTabBadges();
    const mine = jobs.filter((j) => j && kindMap[j.kind]);
    const running = mine.filter((j) => j.status === 'running');
    const usedHosts = new Set();
    for (const j of running) {
      const spec = kindMap[j.kind];
      if (usedHosts.has(spec.host)) continue; // one activity card per results area
      usedHosts.add(spec.host);
      attachToJob(ctx, j.id, { kind: j.kind, ...spec }); // deliberately not awaited
    }
    if (running.length) return;
    const fin = mine.find((j) => j.status === 'done' || j.status === 'error'); // list is newest-first
    if (!fin || dismissedJobs.has(fin.id)) return;
    const endedAt = Date.parse(fin.finishedAt || '');
    if (!Number.isFinite(endedAt) || Date.now() - endedAt > 24 * 3600 * 1000) return;
    kindMap[fin.kind].host.append(lastRunCard(ctx, fin, kindMap[fin.kind]));
  } catch { /* resume is best-effort — never break the tab */ }
}

function lastRunCard(ctx, job, spec) {
  const info = KIND_INFO[job.kind] || {};
  const failed = job.status === 'error';
  const viewLabel = failed ? 'View details' : 'View results';
  const viewBtn = h('button', { class: 'btn btn-sm' }, viewLabel);
  const dismissBtn = h('button', {
    class: 'btn btn-ghost btn-sm',
    onClick: () => { dismissedJobs.add(job.id); wrap.remove(); },
  }, 'Dismiss');
  viewBtn.addEventListener('click', async () => {
    viewBtn.disabled = true;
    viewBtn.textContent = 'Loading…';
    try {
      if (failed) {
        const full = await ctx.api.get(`/w/${ctx.ws}/jobs/${job.id}`);
        const e = new Error(full?.error || 'Job failed');
        e.job = full;
        spec.host.innerHTML = '';
        spec.host.append(jobErrorCard(info.label || 'Job', e));
      } else {
        const res = await ctx.api.get(`/w/${ctx.ws}/jobs/${job.id}/result`);
        spec.render(res ?? {});
      }
    } catch (e) {
      toast(isUnavailable(e) ? 'That result is no longer available on the server.' : e.message, 'err');
      viewBtn.disabled = false;
      viewBtn.textContent = viewLabel;
    }
  });
  const ago = fmtAgo(job.finishedAt);
  const wrap = card(
    h('div', { class: 'row' },
      h('strong', null, `Last run — ${info.label || job.kind}`),
      badge(failed ? 'failed' : 'done', failed ? 'err' : 'ok'),
      ago ? h('span', { class: 'hint' }, `finished ${ago}`) : null,
      h('span', { class: 'spacer' }),
      viewBtn, dismissBtn),
    job.summary ? h('div', { class: 'lastrun-sum' }, job.summary) : null,
  );
  return wrap;
}

function keyFacts(p) {
  const bits = [];
  if (p.description) bits.push(p.description);
  if (p.replication?.mechanism && !['unknown', ''].includes(p.replication.mechanism)) bits.push(`replication: ${p.replication.mechanism}`);
  if (p.replication?.notes) bits.push(p.replication.notes);
  const s = bits.join(' · ');
  return s.length > 220 ? s.slice(0, 217) + '…' : s;
}

// --------------------------------------------------------- §5 shared widgets
// ------------------------------------------------ shared: JSON drop-zone
// One FileReader/drag-drop pattern shared by the k8s and AWS script paths.
// onJson(parsed, setText) — setText(null) restores the idle label.
function jsonDropZone(idleLabel, scriptNoun, onJson) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  const zone = h('div', {
    class: 'drop-zone',
    onClick: () => fileInput.click(),
    onDragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    onDragleave: () => zone.classList.remove('over'),
    onDrop: (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    },
  }, idleLabel);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });
  const setText = (t) => { zone.textContent = t ?? idleLabel; };
  function handleFile(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file', 'err');
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(reader.result); }
      catch {
        toast(`“${file.name}” is not valid JSON — upload the unmodified file the ${scriptNoun} script produced.`, 'err');
        return;
      }
      onJson(parsed, setText);
    };
    reader.readAsText(file);
  }
  return { zone, fileInput, setText };
}

// ------------------------------------------------ shared: proposal tree

const ASSOC_GLYPHS = {
  'security-group': 'SG', subnet: 'SNET', vpc: 'VPC', 'iam-role': 'IAM', 'iam-policy': 'POL',
  'kms-key': 'KMS', 'target-group': 'TG', listener: 'LSNR', certificate: 'CERT',
  'availability-zone': 'AZ', tag: 'TAG', 'sns-topic': 'SNS', 'sqs-queue': 'SQS',
  'subnet-group': 'SNG', 'parameter-group': 'PG', 'oidc-provider': 'OIDC', nodegroup: 'NG',
};
function assocGlyph(type) {
  if (!type) return '·';
  if (ASSOC_GLYPHS[type]) return ASSOC_GLYPHS[type];
  const parts = String(type).split(/[-_/\s]+/).filter(Boolean);
  const g = parts.length > 1 ? parts.map((w) => w[0]).join('') : String(type).slice(0, 4);
  return g.toUpperCase().slice(0, 4);
}

// Tags arrive in whatever shape the collector produced: {k:v}, [{key,value}],
// [{Key,Value}], or plain strings. Normalize to "k=v" chips, capped.
function assocTagChips(tags) {
  let pairs = [];
  if (Array.isArray(tags)) {
    pairs = tags.map((t) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object') {
        const k = t.key ?? t.Key, v = t.value ?? t.Value;
        return k !== undefined ? `${k}=${v ?? ''}` : null;
      }
      return null;
    }).filter(Boolean);
  } else if (tags && typeof tags === 'object') {
    pairs = Object.entries(tags).map(([k, v]) => `${k}=${v ?? ''}`);
  }
  const shown = pairs.slice(0, 4);
  const extra = pairs.length - shown.length;
  return [
    ...shown.map((s) => h('span', { class: 'pt-tag-chip' }, s)),
    extra > 0 ? h('span', { class: 'pt-tag-chip' }, `+${extra} tags`) : null,
  ];
}

function assocRows(p) {
  const assocs = p.associations || [];
  return assocs.map((a, i) => h('tr', { class: `pt-assoc-tr ${i === assocs.length - 1 ? 'pt-assoc-last' : ''}`, hidden: true },
    h('td', null),
    h('td', { colspan: 4 },
      h('div', { class: 'pt-assoc' },
        h('span', { class: 'pt-glyph', title: a?.type || '' }, assocGlyph(a?.type)),
        h('span', { class: 'pt-assoc-name' }, a?.name || a?.rid || '(unnamed)'),
        a?.relation ? h('span', { class: 'pt-assoc-rel' }, a.relation) : null,
        a?.rid ? h('span', { class: 'pt-assoc-rid' }, a.rid) : null,
        a?.region ? h('span', { class: 'pt-tag-chip' }, a.region) : null,
        assocTagChips(a?.tags))),
  ));
}

// Shared proposals review panel — Arpio-style tree when scan-map data is present,
// plain flat rows for old/flat proposals (Arpio, AI, tag proposals). Checking a
// proposal auto-selects its dependsOnProposals closure; associations always come
// along with their parent, so they render as info rows, not checkboxes.
function proposalsPanel(proposals, { ws, api }) {
  proposals = (proposals || []).filter(Boolean);
  if (!proposals.length) return card(empty('No proposals found.'));

  const byKey = new Map(proposals.filter((p) => p.key).map((p) => [p.key, p]));
  const indexOfProposal = new Map(proposals.map((p, i) => [p, i]));
  // Cycle-safe dependency closure of each proposal (Set of proposal objects, self excluded).
  const closures = proposals.map((p) => {
    const out = new Set(), seen = new Set([p]), stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      for (const k of cur.dependsOnProposals || []) {
        const dep = byKey.get(k);
        if (dep && !seen.has(dep)) { seen.add(dep); out.add(dep); stack.push(dep); }
      }
    }
    return out;
  });
  const hasDeps = closures.some((s) => s.size);

  const checks = [];
  const warnSlots = [];
  const headRow = h('div', { class: 'row', style: 'margin-bottom:10px' });
  const doneLine = h('div'); // filled after a successful import: what happened + where to go
  const aiBox = h('div', { class: 'ai-inline' }); // per-row "explain this resource" answers
  const importBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Import 0 selected');

  const refreshWarnings = () => {
    if (!hasDeps) return;
    warnSlots.forEach((slot, i) => {
      slot.innerHTML = '';
      if (checks[i].checked) return;
      const p = proposals[i];
      const dependents = proposals.filter((q, j) => j !== i && checks[j].checked && closures[j].has(p));
      if (dependents.length) {
        slot.append(badge(
          `needed by ${dependents[0].name || dependents[0].key || 'another selection'}${dependents.length > 1 ? ` +${dependents.length - 1}` : ''}`,
          'warn'));
      }
    });
  };
  const refresh = () => {
    const sel = proposals.filter((_, i) => checks[i].checked);
    const m = sel.reduce((acc, p) => acc + (p.associations?.length || 0), 0);
    importBtn.textContent = m > 0
      ? `Import ${sel.length} component${sel.length === 1 ? '' : 's'} + ${m} mapped resource${m === 1 ? '' : 's'}`
      : `Import ${sel.length} selected`;
    importBtn.disabled = sel.length === 0;
    refreshWarnings();
  };

  const rows = proposals.map((p, i) => {
    const cb = h('input', {
      type: 'checkbox', checked: !p.existing, style: 'width:auto',
      onChange: () => {
        if (cb.checked && hasDeps) {
          // Auto-select the whole dependency closure (recursive, cycle-safe).
          let auto = 0;
          closures[i].forEach((dep) => {
            const j = indexOfProposal.get(dep);
            if (j !== undefined && !checks[j].checked) { checks[j].checked = true; auto++; }
          });
          if (auto) toast(`Auto-selected ${auto} ${auto === 1 ? 'dependency' : 'dependencies'}`);
        }
        refresh();
      },
    });
    checks.push(cb);
    const warnSlot = h('span', { class: 'pt-needed' });
    warnSlots.push(warnSlot);

    const children = assocRows(p);
    let caret = null;
    if (children.length) {
      let open = false;
      caret = h('button', { class: 'pt-caret', title: 'Show mapped resources', onClick: () => {
        open = !open;
        caret.textContent = `${open ? '▾' : '▸'} ${children.length}`;
        children.forEach((tr) => { tr.hidden = !open; });
      } }, `▸ ${children.length}`);
    }

    const depNames = (p.dependsOnProposals || [])
      .map((k) => byKey.get(k)).filter((d) => d && d !== p)
      .map((d) => d.name || d.key);

    // Per-row AI: "what is this, and why does it matter for DR?"
    const explainBtn = h('button', {
      class: 'pt-caret', style: 'margin:0 0 0 8px',
      title: `Explain what ${p.name} is and why it matters for DR (asks your local Claude Code CLI)`,
    }, '✦ ?');
    explainBtn.addEventListener('click', () => explainProposal({ ws, api }, p, aiBox, explainBtn));

    const mainRow = h('tr', null,
      h('td', null, cb),
      h('td', null,
        caret,
        h('strong', null, p.name),
        p.existing ? h('span', { style: 'margin-left:8px' }, badge('already in inventory', 'warn')) : null,
        explainBtn,
        warnSlot,
        depNames.length ? h('div', { class: 'pt-dep-line' }, `→ depends on: ${depNames.join(', ')}`) : null,
        // Why we inferred each dependency, and how sure we are — an asserted
        // edge the user cannot check is worse than no edge.
        Array.isArray(p.dependencyEvidence) && p.dependencyEvidence.length
          ? h('details', { class: 'pt-dep-why' },
              h('summary', null, `why — ${p.dependencyEvidence.length} inferred`),
              h('ul', null, p.dependencyEvidence.map((e) => h('li', null,
                h('span', { class: 'chip' }, e.confidence || 'inferred'), ' ',
                e.why || `${e.rule || 'match'}`))))
          : null,
        // And where we could NOT work it out, say so rather than showing nothing.
        Array.isArray(p.dependencyNotes) && p.dependencyNotes.length
          ? h('div', { class: 'pt-dep-note hint' }, p.dependencyNotes[0])
          : null),
      h('td', null, badge(p.category)),
      h('td', { class: 'mono', style: 'font-size:12px' }, p.kind),
      h('td', { class: 'facts-cell' }, keyFacts(p)),
    );
    return [mainRow, ...children];
  });
  refresh();

  const allBox = h('input', {
    type: 'checkbox', style: 'width:auto',
    onChange: (e) => { checks.forEach((c) => { c.checked = e.target.checked; }); refresh(); },
  });
  importBtn.addEventListener('click', async () => {
    const selected = proposals.filter((_, i) => checks[i].checked);
    importBtn.disabled = true;
    importBtn.textContent = 'Importing…';
    try {
      // Full extended proposal objects go up — the import route stores
      // associations/edges into the resource graph and links them.
      const res = await api.post(`/w/${ws}/discover/aws/import`, { proposals: selected });
      const imported = res?.imported ?? selected.length;
      const nodes = res?.graphNodesAdded ?? 0;
      const edges = res?.graphEdgesAdded ?? 0;
      const linked = res?.linked ?? 0;
      const bits = [`Imported ${imported} component(s)`];
      if (nodes || edges) bits.push(`${nodes} graph node(s), ${edges} edge(s)`);
      if (linked) bits.push(`${linked} linked`);
      toast(h('span', null, bits.join(' · '), ' — ',
        h('a', { href: `#/${ws}/diagrams` }, 'Explore on the Diagrams page →')), 'ok');
      importBtn.textContent = `Imported ${imported} ✓`;
      headRow.append(h('a', { class: 'btn btn-ghost btn-sm', href: `#/${ws}/diagrams` }, 'Explore on the Diagrams page →'));
      // Say plainly what just happened, and where it landed.
      doneLine.innerHTML = '';
      doneLine.append(
        h('p', null, `Imported ${imported} component${imported === 1 ? '' : 's'}${nodes || edges ? `, with ${nodes} resource${nodes === 1 ? '' : 's'} and ${edges} link${edges === 1 ? '' : 's'} added to the graph` : ''}.`),
        nextSteps(
          { label: `Review ${imported === 1 ? 'it' : 'them'} in Inventory`, href: `#/${ws}/inventory` },
          { label: 'See them on the Diagrams page', href: `#/${ws}/diagrams` },
        ));
    } catch (e) {
      toast(e.message, 'err');
      importBtn.disabled = false;
      refresh();
    }
  });
  headRow.append(
    h('h2', { style: 'margin:0' }, `Proposed components (${proposals.length})`),
    h('span', { class: 'spacer' }),
    importBtn,
    h('a', { class: 'btn btn-ghost btn-sm', href: `#/${ws}/inventory` }, 'Open Inventory →'));
  return card(
    headRow,
    h('p', { class: 'act-promise', style: 'margin:0 0 10px' },
      'Nothing here is in your inventory yet. Tick what you want, press Import, and everything stays editable afterwards.'),
    h('div', { style: 'overflow-x:auto' },
      table([allBox, 'Name', 'Category', 'Kind', 'Key facts'], rows)),
    aiBox,
    doneLine,
    h('p', { class: 'hint', style: 'margin-top:8px' },
      'The ✦ ? on a row explains what that resource is and why it matters for DR. ',
      'Rows already matching an inventory component (by name) start unchecked. ',
      hasDeps ? 'Checking a row also selects everything it depends on; mapped resources under a row always come along with it. ' : '',
      'Everything can be edited after import.'),
    nextSteps(
      { label: 'See what the inventory already holds', href: `#/${ws}/inventory` },
      { label: 'See the resource graph on Diagrams', href: `#/${ws}/diagrams` },
    ),
  );
}

function errorBadges(errors) {
  if (!errors?.length) return null;
  return h('div', { class: 'row', style: 'margin:10px 0' },
    errors.map((e) => badge(e, 'warn')));
}

function logPanel(log, label = 'aws calls') {
  if (!log?.length) return null;
  return h('details', { class: 'disc-log', style: 'margin:10px 0' },
    h('summary', null, `Command log (${log.length} ${label})`),
    h('pre', { class: 'mono' }, log.join('\n')));
}

// ---------------------------------------------------- §6 AWS auth pre-flight
// Credential/session UX for the AWS tab. The server's auth endpoints run one
// `sts get-caller-identity` as a pre-flight and can launch `aws sso login` /
// `aws-vault exec` — the browser/OS handles the actual sign-in, DR Compass
// never sees or stores credentials. On a server without these endpoints
// (info.profilesDetailed absent) everything degrades: plain profile labels,
// no status line, and every action proceeds exactly as before.

function profileOptionLabel(p) {
  if (p.sso && p.vault) return `${p.name} (SSO · vault)`;
  if (p.sso) return `${p.name} (SSO)`;
  if (p.vault) return `${p.name} (aws-vault)`;
  return p.name;
}

// Options for a profile <select>: detailed labels when the server provides
// them, otherwise the plain name list (old-server degrade).
function profileOptions(info) {
  const det = Array.isArray(info?.profilesDetailed) ? info.profilesDetailed : null;
  if (det?.length) return det.map((p) => h('option', { value: p.name }, profileOptionLabel(p)));
  if (info?.profiles?.length) return info.profiles.map((p) => h('option', { value: p }, p));
  return [h('option', { value: '' }, '(no profiles found — env credentials)')];
}

function arnTail(arn) {
  const s = String(arn || '');
  const parts = s.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : (s.split(':').pop() || s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAwsAuth(ctx, info) {
  const supported = Array.isArray(info?.profilesDetailed);
  const detailed = supported ? info.profilesDetailed : [];
  const cache = new Map(); // profile -> {at, res} — page-session cache

  const detailOf = (name) => detailed.find((p) => p.name === name) || null;
  // authVia the UI sends along with heavy actions: 'vault' for vault-only
  // profiles, 'profile' otherwise; undefined when the server is old.
  const viaOf = (name) => {
    const d = detailOf(name);
    return d ? (d.source === 'vault' ? 'vault' : 'profile') : undefined;
  };

  // check(profile) -> auth/check response, or null when unsupported/absent
  // (callers treat null as "proceed — no pre-flight available").
  async function check(profile, { maxAgeMs = Infinity } = {}) {
    if (!supported) return null;
    const key = profile || '(default)';
    const c = cache.get(key);
    if (c && Date.now() - c.at < maxAgeMs) return c.res;
    const q = new URLSearchParams();
    if (profile) q.set('profile', profile);
    const via = viaOf(profile);
    if (via) q.set('via', via);
    let res;
    try { res = await ctx.api.get(`/discover/aws/auth/check${q.toString() ? `?${q}` : ''}`); }
    catch (e) {
      if (isUnavailable(e)) return null; // endpoint not mounted — degrade
      throw e;
    }
    cache.set(key, { at: Date.now(), res });
    return res;
  }

  // Launch the login process server-side (opens the browser / vault prompt
  // on this machine). A 409 means one is already running — treat as started.
  async function startLogin(profile) {
    try {
      return await ctx.api.post('/discover/aws/auth/login', { profile, via: viaOf(profile) });
    } catch (e) {
      if (/already in progress/i.test(e?.message || '')) return { started: true, attached: true };
      throw e;
    }
  }

  // Poll auth/check every 2.5s (max 4 min) until the session works; also
  // watch the login process so a crashed login surfaces immediately.
  async function waitForLogin(profile, { onTick, timeoutMs = 240000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      await sleep(2500);
      const secs = Math.round((Date.now() - t0) / 1000);
      onTick?.(secs);
      try {
        const chk = await check(profile, { maxAgeMs: 0 });
        if (chk?.ok) return { ok: true, chk };
        if (chk === null) return { ok: false, error: 'auth endpoints unavailable' };
      } catch { /* transient — keep polling */ }
      try {
        const st = await ctx.api.get(`/discover/aws/auth/login/${encodeURIComponent(profile)}/status`);
        if (st && st.running === false && st.ok === false) {
          return { ok: false, crashed: true, stderrTail: st.stderrTail || '' };
        }
      } catch { /* status endpoint is best-effort */ }
      if (Date.now() - t0 > timeoutMs) return { ok: false, timeout: true };
    }
  }

  // Slim status line under a profile row: authenticated identity, or a
  // warn + Authenticate button, plus a manual re-check. Hidden entirely on
  // old servers.
  function statusLine(profileSel) {
    const line = h('div', { class: 'auth-line', hidden: !supported });
    if (!supported) return { el: line, refresh: () => {} };
    let seq = 0;
    const render = async ({ force = false } = {}) => {
      const mySeq = ++seq;
      const profile = profileSel.value;
      line.innerHTML = '';
      line.append(h('span', null, 'Checking AWS access…'));
      let res = null;
      try { res = await check(profile, { maxAgeMs: force ? 0 : Infinity }); }
      catch (e) { res = { ok: false, error: e.message, canLogin: false, method: 'keys' }; }
      if (mySeq !== seq) return; // a newer render superseded this one
      line.innerHTML = '';
      const recheck = h('button', { class: 'btn btn-ghost btn-sm', onClick: () => render({ force: true }) }, 'Check access');
      if (res === null) { line.hidden = true; return; }
      if (res.ok) {
        line.append(
          badge('✓ authenticated', 'ok'),
          h('span', { class: 'auth-id' }, `as ${res.identity?.account || '?'} (${arnTail(res.identity?.arn)})`),
          recheck);
        return;
      }
      line.append(badge('session expired / not authenticated', 'warn'));
      if (res.canLogin) {
        const authBtn = h('button', { class: 'btn btn-sm' }, 'Authenticate');
        authBtn.addEventListener('click', async () => {
          authBtn.disabled = true;
          authBtn.textContent = 'Waiting for browser sign-in…';
          try {
            await startLogin(profile);
            const done = await waitForLogin(profile, {
              onTick: (s) => { authBtn.textContent = `Waiting for browser sign-in… (${s}s)`; },
            });
            if (done.ok) toast('Authenticated ✓', 'ok');
            else toast(done.crashed ? `Login failed: ${done.stderrTail || 'the login process exited with an error'}`
              : 'Login timed out — try again', 'err');
          } catch (e) { toast(e.message, 'err'); }
          render({ force: true });
        });
        line.append(authBtn);
      }
      line.append(recheck);
    };
    let debounce;
    profileSel.addEventListener('change', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => render(), 350);
    });
    render();
    return { el: line, refresh: () => render({ force: true }) };
  }

  // Pre-flight for every heavy AWS action: cached-ok (<60s) proceeds
  // immediately; an expired session renders an inline auth card that, after
  // a successful browser sign-in, AUTO-STARTS the originally requested
  // action. Unsupported/old server → run() unchanged.
  async function preflight(profile, { host, actionLabel = 'the action', buttons = [], run }) {
    let chk = null;
    setButtonsRunning(buttons, true);
    try { chk = await check(profile, { maxAgeMs: 60000 }); }
    catch { chk = null; } // pre-flight must never block the action outright
    if (!chk || chk.ok) { await run(); return; }
    setButtonsRunning(buttons, false);

    const label = profile || 'default';
    const showCard = (body) => { host.innerHTML = ''; host.append(card(...body)); };

    if (!chk.canLogin) {
      showCard([
        h('h2', null, 'AWS credentials needed'),
        h('p', { style: 'margin:8px 0' }, badge(`Profile '${label}' is not authenticated`, 'err')),
        chk.error ? h('pre', { class: 'mono', style: 'margin:8px 0' }, chk.error) : null,
        h('p', { class: 'hint' },
          'This profile has no login flow DR Compass can launch (static keys). Refresh its credentials in your terminal, then retry.'),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn', onClick: () => preflight(profile, { host, actionLabel, buttons, run }) }, 'Retry')),
      ]);
      return;
    }

    const authBtn = h('button', { class: 'btn btn-primary' }, 'Authenticate');
    const statusEl = h('p', { class: 'hint', style: 'margin-top:8px' });
    showCard([
      h('h2', null, 'Authentication needed'),
      h('p', { style: 'margin:8px 0' },
        `Session for '${label}' needs authentication — `,
        h('strong', null, 'Authenticate'),
        ' will open your browser (AWS’s own sign-in page; DR Compass never sees your credentials).'),
      chk.loginHint ? h('p', { class: 'hint' }, chk.loginHint) : null,
      h('div', { class: 'row', style: 'margin-top:10px' }, authBtn),
      statusEl,
    ]);
    authBtn.addEventListener('click', async () => {
      authBtn.disabled = true;
      try { await startLogin(profile); }
      catch (e) {
        authBtn.disabled = false;
        statusEl.textContent = '';
        statusEl.append(badge(e.message, 'err'));
        return;
      }
      statusEl.innerHTML = '';
      statusEl.append('Waiting for you to finish signing in in the browser… ',
        h('span', { class: 'auth-wait-sec' }, '(0s)'));
      const secEl = statusEl.querySelector('.auth-wait-sec');
      const done = await waitForLogin(profile, {
        onTick: (s) => { if (secEl) secEl.textContent = `(${s}s)`; },
      });
      if (done.ok) {
        toast(`Authenticated ✓ — starting ${actionLabel}`, 'ok');
        host.innerHTML = '';
        await run();
        return;
      }
      showCard([
        h('h2', null, 'Authentication failed'),
        h('p', { style: 'margin:8px 0' },
          badge(done.timeout ? 'Timed out after 4 minutes waiting for the sign-in' : 'The login process exited with an error', 'err')),
        done.stderrTail ? h('pre', { class: 'mono', style: 'margin:8px 0' }, done.stderrTail) : null,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn', onClick: () => preflight(profile, { host, actionLabel, buttons, run }) }, 'Retry')),
      ]);
    });
  }

  return { supported, viaOf, check, statusLine, preflight };
}

// ------------------------------------------------------- §7 discovery state
// The returning-user question this page never used to answer: "what has
// already been done here, and what is stale?" Everything below is best-effort
// — each source is independently guarded so one missing backend degrades a
// single tile instead of the strip.

const STALE_DAYS = 14;
const DAY_MS = 86400000;

export function daysSince(ts) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / DAY_MS);
}
export function isStale(ts, days = STALE_DAYS) {
  const d = daysSince(ts);
  return d === null ? false : d > days;
}

// The strip needs four numbers, so it asks for `?summary=1` — counts only
// (~700 bytes instead of the whole graph, which is megabytes once a real
// account with thousands of protected resources has been mapped).
//
// A server that predates that parameter ignores it and answers with the full
// graph, so this reads either shape and produces identical numbers. Exported
// because both branches are worth testing against the same data.
export function graphStateFrom(g) {
  if (g && g.summary === true) {
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      resources: n(g.nodeCount),
      edges: n(g.edgeCount),
      unlinked: n(g.unlinkedCount),
      linked: n(g.linkedCount),
      componentsWithResources: n(g.componentsWithResources),
      byType: g.byType && typeof g.byType === 'object' ? g.byType : {},
      updatedAt: g.updatedAt || null,
      ok: true,
      viaSummary: true,
    };
  }
  // Full-graph shape (older server): count client-side, exactly as before.
  // `cmp_*` ids appear in `edges`, not as nodes, but the filter stays defensive.
  const nodes = Object.values(g?.nodes || {})
    .filter((node) => node && node.rid && !String(node.rid).startsWith('cmp_'));
  const linkedNodes = nodes.filter((node) => Array.isArray(node.componentIds) && node.componentIds.length);
  const compIds = new Set();
  for (const node of linkedNodes) for (const id of node.componentIds) if (id) compIds.add(id);
  const byType = {};
  for (const node of nodes) byType[node.type || 'other'] = (byType[node.type || 'other'] || 0) + 1;
  return {
    resources: nodes.length,
    edges: Array.isArray(g?.edges) ? g.edges.length : 0,
    unlinked: nodes.length - linkedNodes.length,
    linked: linkedNodes.length,
    componentsWithResources: compIds.size,
    byType,
    updatedAt: g?.updatedAt || null,
    ok: true,
    viaSummary: false,
  };
}

// One snapshot of everything the strip and the start view need.
export async function loadDiscoveryState(ctx) {
  const { ws, api } = ctx;
  const st = {
    components: [], componentCount: 0, awsComponentCount: 0,
    graph: { resources: 0, edges: 0, unlinked: 0, linked: 0, componentsWithResources: 0, updatedAt: null, ok: false },
    k8s: { present: false, capturedAt: null, workloads: 0, unlinkedWorkloads: 0, source: '', ok: false },
    jobs: { byKind: {}, running: 0, ok: false },
    flows: { calls: 0, components: 0 },
    loadedAt: Date.now(),
  };
  const jobs = [
    api.get(`/w/${ws}/c/components`).then((r) => {
      st.components = r?.items || [];
      st.componentCount = st.components.length;
      st.awsComponentCount = st.components.filter((c) => c.awsServices?.length).length;
      // Flow provenance lives on the components themselves, which are already
      // fetched here. (Still the one count with no server-side counter — see
      // the `counts.flowCalls` request in INTEGRATION-NOTES.md.)
      let calls = 0, comps = 0;
      for (const c of st.components) {
        const n = (c.outboundCalls || []).filter((o) => o && o.source === 'network-flows').length;
        if (n) { calls += n; comps++; }
      }
      st.flows = { calls, components: comps };
    }).catch(() => {}),
    api.get(`/w/${ws}/resources/graph?summary=1`).then((g) => {
      st.graph = graphStateFrom(g);
    }).catch(() => {}),
    api.get(`/w/${ws}/k8s`).then((snap) => {
      const has = snap && (snap.capturedAt || snap.summary || snap.cluster || snap.source);
      const wl = Array.isArray(snap?.workloads) ? snap.workloads : [];
      st.k8s = {
        present: !!has,
        capturedAt: snap?.capturedAt || null,
        cluster: snap?.cluster || '',
        source: snap?.source || '',
        workloads: (snap?.summary || snap?.counts)?.workloads ?? wl.length,
        unlinkedWorkloads: wl.filter((w) => w && w.uid && !w.componentId).length,
        ok: true,
      };
    }).catch(() => {}),
    api.get(`/w/${ws}/jobs`).then((r) => {
      const list = Array.isArray(r?.jobs) ? r.jobs : []; // newest first
      const byKind = {};
      for (const j of list) {
        if (!j?.kind) continue;
        if (!byKind[j.kind]) byKind[j.kind] = j; // first hit is the newest
      }
      st.jobs = { byKind, running: list.filter((j) => j?.status === 'running').length, ok: true };
    }).catch(() => {}),
  ];
  await Promise.all(jobs);
  return st;
}

// True when there is genuinely nothing to report, so the status strip would be
// five zeros — the chooser owns the page instead. Job history counts: "your
// scan finished 10 minutes ago and found nothing" is exactly what a returning
// user needs to see, even with an inventory still at zero.
export function isEmptyWorkspace(st) {
  return !st.componentCount && !st.graph.resources && !st.k8s.present && !st.flows.calls
    && !Object.keys(st.jobs?.byKind || {}).length;
}

// Which start view to render. The chooser leads whenever the INVENTORY is
// empty, whatever else has happened; once there are components, the compact
// what's-next / what's-stale list leads and the chooser moves into a
// disclosure.
export function startViewKind(st) {
  return st.componentCount ? 'next' : 'chooser';
}

// Ordered "what to do next" list, derived from the same snapshot. Exported for
// node tests: pure function of state.
export function nextActions(st) {
  const out = [];
  if (!st.componentCount) {
    out.push({ id: 'first-scan', label: 'Find your resources', view: 'start',
      why: 'This workspace has no components yet — pick the path that matches your access.' });
  }
  if (st.graph.unlinked) {
    out.push({ id: 'unlinked', label: `Review ${st.graph.unlinked} unlinked resource${st.graph.unlinked === 1 ? '' : 's'}`, view: 'aws', focus: 'tag',
      why: 'Discovered resources that are not attached to any component yet — they will not show up in a component’s DR story until they are.' });
  }
  if (st.k8s.unlinkedWorkloads) {
    out.push({ id: 'unlinked-workloads', label: `Match ${st.k8s.unlinkedWorkloads} Kubernetes workload${st.k8s.unlinkedWorkloads === 1 ? '' : 's'}`, view: 'k8s', focus: 'snapshot',
      why: 'Workloads in the snapshot that no component claims.' });
  }
  if (st.awsComponentCount && !st.graph.resources) {
    out.push({ id: 'map', label: `Map dependencies for ${st.awsComponentCount} component${st.awsComponentCount === 1 ? '' : 's'}`, view: 'aws', focus: 'map',
      why: 'You have components but no resource graph yet — mapping pulls in their security groups, subnets, IAM, KMS and target groups.' });
  }
  const awsJob = st.jobs.byKind['aws-scan-map'] || st.jobs.byKind['aws-scan'];
  if (st.componentCount && (!awsJob || isStale(awsJob.finishedAt))) {
    out.push({ id: 'rescan', label: 'Scan the AWS account again', view: 'aws', focus: 'scan',
      why: awsJob
        ? `The last account scan finished ${fmtAgo(awsJob.finishedAt) || 'a while ago'} — new resources since then are not in the inventory.`
        : 'No account scan has been recorded in this workspace — a scan proposes anything your inventory is missing.' });
  }
  if (st.k8s.present && isStale(st.k8s.capturedAt)) {
    out.push({ id: 'k8s-stale', label: 'Re-capture the Kubernetes snapshot', view: 'k8s', focus: 'capture',
      why: `The stored snapshot is from ${fmtAgo(st.k8s.capturedAt) || 'a while ago'}.` });
  }
  if (!st.k8s.present) {
    out.push({ id: 'k8s-none', label: 'Capture a Kubernetes snapshot', view: 'k8s', focus: 'capture',
      why: 'Optional — only if you run workloads on a cluster.' });
  }
  if (!st.flows.calls) {
    out.push({ id: 'flows', label: 'Import a firewall / flow-log export', view: 'network', focus: 'upload',
      why: 'Turns observed traffic into the outbound calls your recovery region has to reproduce.' });
  }
  return out;
}

// The persistent strip. Each tile carries a direct action; `nav.goTab` moves to
// the view that performs it.
function statusStrip(ctx, st, nav) {
  const { ws } = ctx;
  const tile = (value, label, action, { none = false, extra = null } = {}) => h('div', { class: 'ds-tile' },
    h('div', { class: `ds-val ${none ? 'none' : ''}` }, value),
    h('div', { class: 'ds-lab' }, label),
    extra,
    action
      ? (action.href
        ? h('a', { class: 'ds-act', href: action.href }, `${action.label} →`)
        : h('button', { class: 'ds-act', onClick: action.onClick }, `${action.label} →`))
      : null);

  const graphAct = st.graph.resources
    ? { label: 'See them on Diagrams', href: `#/${ws}/diagrams` }
    : { label: 'Map dependencies', onClick: () => nav.goTab('aws', 'map') };
  const unlinkedTile = tile(
    String(st.graph.unlinked), st.graph.unlinked === 1 ? 'resource needs review' : 'resources need review',
    st.graph.unlinked
      ? { label: 'Match them to components', onClick: () => nav.goTab('aws', 'tag') }
      : null,
    { none: !st.graph.unlinked, extra: st.graph.unlinked ? null : h('span', { class: 'hint' }, 'everything linked') });

  const k8sAge = st.k8s.present ? (fmtAgo(st.k8s.capturedAt) || 'age unknown') : '';
  const k8sTile = tile(
    st.k8s.present ? String(st.k8s.workloads || 0) : '—',
    st.k8s.present ? `Kubernetes workloads · captured ${k8sAge}` : 'No Kubernetes snapshot',
    { label: st.k8s.present ? 'Open the Kubernetes tab' : 'Capture a snapshot', onClick: () => nav.goTab('k8s', st.k8s.present ? 'snapshot' : 'capture') },
    { none: !st.k8s.present,
      extra: st.k8s.present && isStale(st.k8s.capturedAt) ? badge(`older than ${STALE_DAYS} days`, 'warn') : null });

  // Last run per source, straight from the jobs list.
  const runKinds = [
    ['aws-scan-map', 'AWS scan', 'aws', 'scan'],
    ['aws-scan', 'AWS scan (no mapping)', 'aws', 'scan'],
    ['enrich', 'Dependency mapping', 'aws', 'map'],
    ['enrich-by-tag', 'Tag search', 'aws', 'tag'],
    ['arpio', 'Arpio import', 'arpio', 'import'],
    ['k8s-scan', 'Kubernetes scan', 'k8s', 'capture'],
  ];
  const runs = [];
  for (const [kind, label, tab, focus] of runKinds) {
    const j = st.jobs.byKind[kind];
    if (!j) continue;
    runs.push(h('div', { class: 'ds-run' },
      h('span', { class: 'ds-run-k' }, label),
      j.status === 'running'
        ? badge('running now', 'accent')
        : badge(`${j.status === 'error' ? 'failed ' : ''}${fmtAgo(j.finishedAt) || j.status}`,
          j.status === 'error' ? 'err' : (isStale(j.finishedAt) ? 'warn' : 'ok')),
      h('button', { class: 'ds-act', onClick: () => nav.goTab(tab, focus) }, 'Open →')));
  }

  return card(
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('h2', { style: 'margin:0' }, 'What discovery has found so far'),
      st.jobs.running ? badge(`${st.jobs.running} running`, 'accent') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost btn-sm', onClick: () => nav.refresh() }, 'Refresh'),
      h('button', { class: 'btn btn-sm', onClick: () => nav.goTab('start') }, 'Start a new path')),
    h('div', { class: 'ds-strip' },
      tile(String(st.componentCount), st.componentCount === 1 ? 'component in inventory' : 'components in inventory',
        st.componentCount
          ? { label: 'Open Inventory', href: `#/${ws}/inventory` }
          : { label: 'Choose how to find them', onClick: () => nav.goTab('start') },
        { none: !st.componentCount }),
      tile(String(st.graph.resources), 'resources mapped in the graph', graphAct,
        { none: !st.graph.resources,
          extra: st.graph.edges
            ? h('span', { class: 'hint' },
                `${st.graph.edges} link${st.graph.edges === 1 ? '' : 's'}`,
                st.graph.componentsWithResources ? ` · across ${st.graph.componentsWithResources} component${st.graph.componentsWithResources === 1 ? '' : 's'}` : '')
            : null }),
      unlinkedTile,
      k8sTile,
      tile(String(st.flows.calls), st.flows.calls === 1 ? 'outbound call from flow data' : 'outbound calls from flow data',
        { label: st.flows.calls ? 'Import another export' : 'Import a flow export', onClick: () => nav.goTab('network', 'upload') },
        { none: !st.flows.calls,
          extra: st.flows.components ? h('span', { class: 'hint' }, `on ${st.flows.components} component(s)`) : null })),
    runs.length
      ? h('div', { class: 'ds-runs' }, h('span', { class: 'next-label' }, 'Last run'), runs)
      : h('div', { class: 'ds-runs' }, h('span', { class: 'hint' }, 'No discovery runs recorded in this workspace yet.')),
  );
}

// -------------------------------------------------------------- §8 start view
// The default landing. An empty workspace gets the chooser; a workspace that
// already has components gets a compact "what's next / what's stale" list with
// the chooser one disclosure away.

const PATHS = [
  {
    id: 'aws-scan', view: 'aws', focus: 'scan',
    title: 'I have AWS access on this machine',
    needs: 'AWS CLI v2 and one of your own profiles (SSO, aws-vault or keys)',
    gives: 'Every supported resource proposed as a component, each with its dependencies mapped — security groups, subnets, IAM, KMS, target groups',
    go: 'Scan the account',
    time: '1–5 minutes',
  },
  {
    id: 'script', view: 'aws', focus: 'script',
    title: 'I can’t run AWS credentials here',
    needs: 'Somewhere else you can run a bash script — a jump host, a build box, your laptop',
    gives: 'The same reviewable proposals, from the JSON file the script writes; you upload it here',
    go: 'Download the read-only script',
    time: '5 minutes, mostly waiting on you',
  },
  // A third-party recovery product is one option among several, so it sits
  // after the two paths that need nothing but an AWS account.
  {
    id: 'arpio', view: 'arpio', focus: 'import',
    title: 'I already protect things with a third-party tool (Arpio)',
    needs: 'An Arpio read-only API key (it has two parts) — never written to disk',
    gives: 'Your protected resources as components, then dependency mapping for exactly those resources — no account-wide scan',
    go: 'Import from Arpio',
    time: 'under a minute',
  },
];

const SECONDARY_PATHS = [
  { id: 'k8s', view: 'k8s', focus: 'capture', title: 'I have a Kubernetes cluster',
    hint: 'Snapshot namespaces, workloads, services and ingresses with your own kubectl — or upload the script’s JSON. Links workloads to components automatically.' },
  { id: 'network', view: 'network', focus: 'upload', title: 'I have a firewall / flow-log export',
    hint: 'A CSV or TSV of who talked to whom. Parsed in your browser, aggregated into outbound calls you confirm one source at a time.' },
  { id: 'ai', view: 'ai', focus: 'ask', title: 'I’d rather talk it through first',
    hint: 'Ask your local Claude Code CLI what a plan for this workspace is missing — it can propose importable components too.' },
];

function pathChooser(ctx, nav, { compact = false } = {}) {
  const cardFor = (p) => h('button', { class: 'ch-card', 'data-path': p.id, onClick: () => nav.goTab(p.view, p.focus) },
    h('span', { class: 'ch-title' }, p.title),
    h('span', { class: 'ch-kv' }, h('b', null, 'Needs'), h('span', null, p.needs)),
    h('span', { class: 'ch-kv' }, h('b', null, 'Gives you'), h('span', null, p.gives)),
    h('span', { class: 'ch-go' }, `${p.go} → ${p.time}`));
  const secondary = SECONDARY_PATHS.map((p) => h('div', { class: 'ch-sec-row', 'data-path': p.id },
    h('span', { class: 'ch-sec-t' }, p.title),
    h('span', { class: 'hint' }, p.hint),
    h('button', { class: 'btn btn-sm', onClick: () => nav.goTab(p.view, p.focus) }, 'Open')));
  return card(
    h('div', { id: 'disc-chooser' },
      h('h2', { style: 'margin-bottom:4px' }, compact ? 'Start another path' : 'How do you want to find your resources?'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Everything here is read-only and arrives as proposals you review — nothing is written to your inventory until you say so. Pick whichever matches the access you actually have.'),
      h('div', { class: 'ch-grid' }, PATHS.map(cardFor)),
      h('div', { class: 'divider' }),
      h('p', { class: 'hint', style: 'margin-bottom:8px;font-weight:600' }, 'Also available'),
      h('div', { class: 'ch-sec' }, secondary)),
  );
}

function whatsNext(ctx, st, nav) {
  const actions = nextActions(st);
  const aiHost = h('div', { class: 'ai-inline' });
  const rows = actions.slice(0, 5).map((a) => h('div', { class: 'wn-row', 'data-next': a.id },
    h('button', { class: 'btn btn-sm', onClick: () => nav.goTab(a.view, a.focus) }, a.label),
    h('span', { class: 'wn-why' }, a.why)));
  return h('div', { id: 'disc-next' },
    card(
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('h2', { style: 'margin:0' }, 'What’s next'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, `${st.componentCount} component(s) · ${st.graph.resources} mapped resource(s)`)),
      rows.length ? h('div', { class: 'wn-list' }, rows)
        : h('p', { class: 'hint' }, 'Nothing looks stale — discovery is in good shape. Review the inventory or run a recovery test next.'),
      aiRow(ctx, {
        hint: 'Asks your local Claude Code CLI, with a summary of this workspace as context.',
        host: aiHost,
        actions: [{
          label: 'What am I likely missing?',
          modalTitle: 'What discovery is likely missing',
          context: { kind: 'workspace' },
          prompt: 'Given this inventory, what dependencies, third-party calls, secrets, or components am I likely missing for a complete DR plan? Be specific about what to discover next and how to discover it.',
        }],
      }),
      aiHost,
      nextSteps(
        { label: 'Open Inventory', href: `#/${ctx.ws}/inventory` },
        { label: 'See the resource graph on Diagrams', href: `#/${ctx.ws}/diagrams` },
      ),
    ),
    h('details', { class: 'adv', style: 'margin-top:14px' },
      h('summary', null, 'Start a different discovery path'),
      h('div', { class: 'adv-body' }, pathChooser(ctx, nav, { compact: true }))),
  );
}

function renderStart(el, ctx, nav) {
  el.innerHTML = '';
  const st = nav.state;
  el.append(startViewKind(st) === 'chooser' ? pathChooser(ctx, nav) : whatsNext(ctx, st, nav));
}

// ------------------------------------------------------- §9 Tab: AWS account

async function renderAws(el, ctx, nav) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('div', { class: 'loading' }, 'Checking for the AWS CLI…'));
  let info;
  try { info = await api.get('/discover/aws/profiles'); }
  catch (e) { el.innerHTML = ''; el.append(card(badge(e.message, 'err'))); return; }
  let meta = {};
  try { meta = await api.get(`/w/${ws}/workspace`); } catch { /* region default only */ }
  let comps = [];
  try { comps = (await api.get(`/w/${ws}/c/components`)).items || []; } catch { /* component list degrades to empty */ }
  el.innerHTML = '';

  // ONE profile + region + auth status for the whole tab. Before this there
  // were two of each (scan card and enrichment card), able to disagree.
  const conn = awsConnection(ctx, info, meta);
  const resumeMap = {}; // kind -> resume spec; filled here + by mapDependenciesSection

  // --- scan & map -----------------------------------------------------------
  const scanResults = h('div');
  const scanAi = h('div', { class: 'ai-inline' });
  const renderScanResults = (res, { fellBack = false } = {}) => {
    scanResults.innerHTML = '';
    const proposals = res.proposals || [];
    const errs = res.errors || [];
    scanResults.append(...[
      fellBack ? h('div', { class: 'row', style: 'margin:0 0 10px' },
        badge('Dependency mapping is not available on this server yet — showing a plain scan instead.', 'warn')) : null,
      errorBadges(errs),
      logPanel(res.log),
      proposals.length ? proposalsPanel(proposals, ctx)
        : (errs.length ? empty('Nothing discovered — see warnings above.') : empty('Nothing discovered in this region for the selected services.')),
    ].filter(Boolean));
    // Contextual AI right where the result is, not in a drawer somewhere else.
    scanResults.append(card(
      h('h3', { style: 'margin-bottom:6px' }, 'Not sure this is everything?'),
      aiRow(ctx, {
        hint: 'Reads the proposals plus your existing inventory. Suggests only — it writes nothing.',
        host: scanAi,
        actions: [
          {
            label: 'What am I likely missing?',
            modalTitle: 'What this scan probably missed',
            context: { kind: 'workspace' },
            prompt: `I just scanned an AWS account and it proposed ${proposals.length} component(s)${proposals.length ? `: ${proposals.slice(0, 40).map((p) => p.name).join(', ')}` : ''}. Given this workspace, what dependencies, third-party calls, secrets, data stores or components am I likely still missing for a complete DR plan, and how would I discover each one?`,
          },
          {
            label: 'Explain these resources',
            modalTitle: 'What these resources are, and why they matter for DR',
            context: { kind: 'workspace' },
            prompt: `For each of these AWS resources a scan just proposed, explain in one or two plain sentences what it is and why it matters for disaster recovery (what breaks if it is missing in the recovery region): ${proposals.slice(0, 25).map((p) => `${p.name} (${p.kind})`).join('; ') || '(none)'}.`,
          },
        ],
      }),
      scanAi,
    ));
  };

  if (!info.awsCliFound) {
    el.append(card(
      h('h2', null, 'AWS CLI not found on this machine'),
      h('p', null, 'The scan shells out to your local AWS CLI v2 with your own profiles — DR Compass never sees or stores credentials.'),
      h('p', { class: 'hint' }, 'Install it, configure a profile, then reload this page — or use the script path below, which needs nothing installed here:'),
      h('pre', { class: 'mono' }, 'brew install awscli\naws configure --profile my-profile'),
      nextSteps({ label: 'Use the script path instead', onClick: () => nav.goTab('aws', 'script') }),
    ));
    // Fall through: the script download + upload path below works without a local CLI.
  }

  const serviceIds = info.services || Object.keys(SERVICE_LABELS);
  const selected = new Set(serviceIds); // all on by default
  const mapCb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const scopeLine = h('p', { class: 'hint', style: 'margin:0' });
  const refreshScope = () => {
    scopeLine.innerHTML = '';
    scopeLine.append(
      selected.size === serviceIds.length
        ? `All ${serviceIds.length} supported services`
        : `${selected.size} of ${serviceIds.length} services`,
      ' · ',
      mapCb.checked ? 'dependencies mapped' : 'no dependency mapping',
      ' · region ',
      h('span', { class: 'mono' }, conn.region() || '(unset)'));
  };
  const chips = serviceIds.map((id) => {
    const chip = h('span', { class: 'svc-chip on', onClick: () => {
      if (selected.has(id)) { selected.delete(id); chip.classList.remove('on'); }
      else { selected.add(id); chip.classList.add('on'); }
      refreshScope();
    } }, SERVICE_LABELS[id] || id);
    return chip;
  });
  conn.regionInp.addEventListener('input', refreshScope);

  const scanBtn = h('button', { class: 'btn btn-primary', disabled: !info.awsCliFound }, 'Scan this account');
  const scanButtons = [{
    el: scanBtn,
    runningText: 'Scanning… (read-only list/describe calls)',
    idleText: 'Scan this account',
    idleDisabled: !info.awsCliFound,
  }];
  mapCb.addEventListener('change', () => {
    scanButtons[0].idleText = mapCb.checked ? 'Scan this account' : 'Scan this account (no mapping)';
    if (!scanBtn.disabled) scanBtn.textContent = scanButtons[0].idleText;
    refreshScope();
  });
  refreshScope();

  scanBtn.addEventListener('click', async () => {
    if (!selected.size) { toast('Pick at least one service to scan', 'err'); return; }
    conn.persist();
    const base = conn.base({ services: [...selected] });
    // Credential pre-flight: an expired SSO/vault session renders an inline
    // Authenticate card and auto-starts the scan once sign-in completes.
    await conn.auth.preflight(conn.profile(), {
      host: scanResults,
      actionLabel: mapCb.checked ? 'the AWS scan & map' : 'the AWS scan',
      buttons: scanButtons,
      run: async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scanning… (read-only list/describe calls)';
        scanResults.innerHTML = '';
        // Job path first — survives refresh; falls back to the synchronous
        // scan below when the jobs backend is not mounted.
        const handled = await runJob(ctx,
          mapCb.checked ? 'aws-scan-map' : 'aws-scan',
          mapCb.checked ? { ...base, mapDependencies: true } : base, {
            label: 'Scanning AWS account…',
            activityHost: scanResults,
            renderResult: (res) => renderScanResults(res),
            buttons: scanButtons,
          });
        if (handled) return;
        try {
          let res = null, fellBack = false;
          if (mapCb.checked) {
            try {
              res = await api.post(`/w/${ws}/discover/aws/scan-map`, { ...base, mapDependencies: true });
            } catch (e) {
              if (!isUnavailable(e)) throw e;
              fellBack = true; // scan-map backend not mounted yet — plain scan still works
            }
          }
          if (!res) res = await api.post(`/w/${ws}/discover/aws`, base);
          renderScanResults(res, { fellBack });
        } catch (e) {
          scanResults.append(isUnavailable(e) ? unavailableCard('AWS scan') : card(badge(e.message, 'err')));
        } finally {
          scanBtn.disabled = !info.awsCliFound;
          scanBtn.textContent = scanButtons[0].idleText;
        }
      },
    });
  });

  const scanCard = panel(
    { id: 'disc-card-scan', 'data-focus': 'scan' },
    h('h2', null, 'Scan this AWS account'),
    promiseLine('Reads your account and proposes components — plus each resource’s dependencies (security groups, subnets, IAM, KMS, target groups, tags) drawn into the resource graph. Secret values are never read: names and ARNs only, and every command it runs is shown in the log.',
      { readOnly: true, nothingWritten: true, time: '1–5 minutes for a normal account' }),
    h('div', { class: 'row', style: 'margin-top:10px' }, scopeLine),
    advanced('Advanced — choose services, turn dependency mapping off',
      h('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:4px' },
        mapCb, h('strong', { style: 'font-size:13px' }, term('Map dependencies', 'enrichment', 'deep enrichment'))),
      h('p', { class: 'hint', style: 'margin:0 0 12px 26px' },
        'On by default. Also pulls each resource’s associations — security groups, subnets, IAM, target groups, KMS, tags — the way a recovery tool builds its resource graph. Turning it off makes the scan quicker but leaves you a flat list.'),
      h('span', { class: 'hint', style: 'font-weight:600' }, 'Services to scan (all on by default)'),
      h('div', { class: 'svc-chips' }, chips)),
    actionRow(scanBtn,
      h('p', { class: 'act-promise' }, 'Uses the profile and region above. Safe to leave the page while it runs.')),
  );

  // --- script path (no credentials here) -----------------------------------
  const scriptResults = h('div');
  const scriptLink = h('a', {
    class: 'btn', href: '/api/discover/aws/script', download: 'drcompass-aws-discovery.sh',
    onClick: (e) => {
      e.currentTarget.href = `/api/discover/aws/script?services=${encodeURIComponent([...selected].join(','))}`;
    },
  }, 'Download the read-only script');
  const upload = jsonDropZone('Drop the discovery JSON here, or click to choose the file', 'discovery', async (parsed, setText) => {
    setText('Uploading…');
    scriptResults.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/discover/aws/upload`, parsed);
      renderScriptResults(res);
      toast('Discovery artifact uploaded — review the proposals below', 'ok');
    } catch (e) {
      scriptResults.append(isUnavailable(e) ? unavailableCard('Discovery upload') : card(badge(e.message, 'err')));
    } finally {
      setText(null);
    }
  });
  // The uploaded artifact lands in the same review tree as a live scan.
  const renderScriptResults = (res) => {
    scriptResults.innerHTML = '';
    const proposals = res.proposals || [];
    scriptResults.append(...[
      errorBadges(res.errors),
      logPanel(res.log),
      proposals.length ? proposalsPanel(proposals, ctx) : empty('That artifact contained nothing importable.'),
    ].filter(Boolean));
  };
  const scriptCard = panel(
    { id: 'disc-card-script', 'data-focus': 'script' },
    h('h2', null, 'No AWS credentials on this machine?'),
    promiseLine('Downloads a bash script scoped to the services above. Run it anywhere you do have credentials — a jump host, a build box — then drop the JSON it writes here and you get exactly the same reviewable proposals.',
      { readOnly: true, nothingWritten: true, time: '5 minutes, mostly your own hands' }),
    actionRow(scriptLink,
      h('p', { class: 'act-promise' }, 'The script only ever calls list/describe. Open it and read it first — it is a plain bash file.')),
    h('p', { class: 'hint', style: 'margin:12px 0 8px' }, 'Step 2 — upload what it produced:'),
    upload.zone, upload.fileInput,
    scriptResults,
  );

  el.append(
    conn.el,
    scanCard,
    scanResults,
    scriptCard,
    ...mapDependenciesSection(ctx, nav, info, comps, resumeMap, conn),
  );
  resumeMap['aws-scan'] = { host: scanResults, render: (res) => renderScanResults(res), buttons: scanButtons };
  resumeMap['aws-scan-map'] = { host: scanResults, render: (res) => renderScanResults(res), buttons: scanButtons };
  resumeJobs(ctx, 'aws', resumeMap); // deliberately not awaited — resume never blocks the tab
}

// One AWS connection for the whole tab: profile, region, live auth status.
// Remembers both across visits (old `drc.enrich.*` keys are still read so an
// existing user's choice survives this redesign).
function awsConnection(ctx, info, meta) {
  const auth = makeAwsAuth(ctx, info);
  const profileSel = h('select', null, profileOptions(info));
  const names = Array.isArray(info?.profilesDetailed) && info.profilesDetailed.length
    ? info.profilesDetailed.map((p) => p.name)
    : (info?.profiles || []);
  const saved = lsGet('drc.aws.profile') || lsGet('drc.enrich.profile');
  if (saved && names.includes(saved)) profileSel.value = saved;
  const regionInp = h('input', {
    value: lsGet('drc.aws.region') || lsGet('drc.enrich.region') || meta?.regions?.primary || 'us-east-1',
    placeholder: 'e.g. us-east-1',
  });
  const authLine = auth.statusLine(profileSel);
  const persist = () => {
    lsSet('drc.aws.profile', profileSel.value);
    lsSet('drc.enrich.profile', profileSel.value); // keep the old key in sync
    lsSet('drc.aws.region', regionInp.value.trim());
    lsSet('drc.enrich.region', regionInp.value.trim());
  };
  profileSel.addEventListener('change', persist);
  regionInp.addEventListener('change', persist);

  const el = panel(
    { id: 'disc-card-connection', 'data-focus': 'connection' },
    h('div', { class: 'row', style: 'margin-bottom:6px' },
      h('h2', { style: 'margin:0' }, 'AWS connection'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, 'Used by every action on this tab')),
    h('p', { class: 'hint', style: 'margin-bottom:12px' },
      'Everything here runs through your own local AWS CLI with your own profile. DR Compass never reads, sends or stores credentials — if a session has expired it asks AWS’s own sign-in page to refresh it.'),
    h('div', { class: 'grid cols-2' },
      field('AWS profile', profileSel),
      field('Region (primary)', regionInp)),
    authLine.el,
  );

  // The body every heavy action sends: profile, region, and how to authenticate.
  const base = (extra = {}) => {
    const b = { profile: profileSel.value, region: regionInp.value.trim(), ...extra };
    const via = auth.viaOf(profileSel.value);
    if (via) b.authVia = via;
    return b;
  };
  return {
    el, auth, profileSel, regionInp, authLine, persist, base,
    profile: () => profileSel.value,
    region: () => regionInp.value.trim(),
  };
}

// ------------------------------------------------- AWS tab: deep enrichment

function enrichTotalsChips(res) {
  return h('div', { class: 'row', style: 'margin:4px 0 10px' },
    badge(`${res.addedNodes ?? 0} nodes added`, 'ok'),
    badge(`${res.updatedNodes ?? 0} nodes updated`, 'accent'),
    badge(`${res.addedEdges ?? 0} edges added`, 'accent'),
    typeof res.matched === 'number' ? badge(`${res.matched} tag-matched`, res.matched ? 'accent' : 'warn') : null,
    typeof res.targeted === 'number' ? badge(`${res.targeted} Arpio-imported component(s) targeted`, res.targeted ? 'purple' : 'warn') : null);
}

function matchedByCell(mb) {
  if (mb === 'arn') return badge('exact', 'ok');
  if (mb === 'name') return badge('name');
  return h('span', { class: 'hint' }, '—');
}

function enrichResultPanel(res, compsById) {
  const per = res.perComponent || [];
  const rows = per.map((p) => h('tr', null,
    h('td', null, h('strong', null, compsById[p.componentId]?.name || p.componentId || '(unlinked — review in graph)')),
    h('td', null, p.found ? badge('✓ found', 'ok') : badge('—')),
    h('td', null, matchedByCell(p.matchedBy)),
    h('td', null, String(p.nodes ?? 0)),
  ));
  return card(
    h('h3', { style: 'margin-bottom:8px' }, 'Enrichment results'),
    enrichTotalsChips(res),
    res.targeted === 0
      ? h('p', { class: 'hint', style: 'margin:0 0 10px' },
          'No Arpio-imported components found — import on the Arpio tab first.')
      : null,
    ...[errorBadges(res.errors), logPanel(res.log)].filter(Boolean),
    per.length
      ? h('div', { style: 'overflow-x:auto' }, table(['Component', 'Associations', 'Matched by', 'Nodes added'], rows))
      : empty('No per-component detail returned.'),
    h('p', { class: 'hint', style: 'margin-top:8px' },
      '“exact” = matched by ARN; “name” = matched heuristically by name. Click nodes on the Diagrams page to explore what got associated.'),
  );
}

// "Map dependencies" (the operation formerly labelled "deep enrichment") and
// "Find resources by tag" (formerly "correlate by tag"). Both run through the
// shared AWS connection card — this section no longer owns a profile picker, a
// region box or an auth status line of its own.
function mapDependenciesSection(ctx, nav, info, comps, resumeMap, conn) {
  const { ws, api } = ctx;
  const compsById = Object.fromEntries(comps.map((c) => [c.id, c]));
  const awsComps = comps.filter((c) => c.awsServices?.length);

  // Aliases, so every run / pre-flight / fallback path below is unchanged.
  const auth = conn.auth;
  const profileSel = conn.profileSel;
  const regionInp = conn.regionInp;
  const persist = conn.persist;

  const checks = [];
  const allToggle = h('input', {
    type: 'checkbox', checked: true, style: 'width:auto',
    onChange: (e) => checks.forEach((c) => { c.checked = e.target.checked; }),
  });
  const compList = awsComps.length
    ? h('div', { class: 'enrich-comps' },
        h('label', { class: 'row', style: 'gap:8px;cursor:pointer;padding-bottom:4px;border-bottom:1px solid var(--border)' },
          allToggle, h('strong', null, 'Select all')),
        awsComps.map((c) => {
          const cb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
          checks.push(cb);
          return h('label', { class: 'row', style: 'gap:8px;cursor:pointer' },
            cb, c.name, badge((c.awsServices || []).slice(0, 4).join(', ')));
        }))
    : h('p', { class: 'hint', style: 'margin:2px 0 12px' },
        'No inventory components list AWS services yet — scan or import above first, or use “Find resources by tag” below.');

  // Each card owns the area its own results render into — a run never wipes a
  // neighbouring card's output any more.
  const results = h('div');     // the Map dependencies card
  const tagResults = h('div');  // the Find resources by tag card

  // Shared render/toast paths — used identically by the job path, the sync
  // fallback, and "Last run → View results".
  const renderEnrichResults = (res, { expectTargeted = false } = {}) => {
    results.innerHTML = '';
    if (expectTargeted && typeof res.targeted !== 'number') {
      // Older backend that ignores target:'arpio' — it enriched every AWS
      // component instead of just the Arpio-imported ones. Say so.
      results.append(h('div', { class: 'row', style: 'margin:0 0 10px' },
        badge('Mapping only the Arpio-imported resources is not available on this server yet — mapped every AWS component instead.', 'warn')));
    }
    results.append(enrichResultPanel(res, compsById));
    const added = res.addedNodes ?? 0;
    results.append(card(
      h('p', null, added
        ? `Mapped ${added} resource${added === 1 ? '' : 's'} into the graph${res.addedEdges ? `, with ${res.addedEdges} link${res.addedEdges === 1 ? '' : 's'} between them` : ''}.`
        : 'Nothing new to map — every association these components have was already in the graph.'),
      nextSteps(
        { label: 'See them on the Diagrams page', href: `#/${ws}/diagrams` },
        { label: 'Open Inventory', href: `#/${ws}/inventory` },
        { label: 'Find resources your inventory missed, by tag', onClick: () => nav.goTab('aws', 'tag') },
      ),
    ));
  };
  const toastEnrich = (res) => {
    if (typeof res.targeted === 'number' && res.targeted === 0) {
      toast('No Arpio-imported components found — import on the Arpio tab first.', 'err');
    } else {
      toast(h('span', null, `Mapped ${res.addedNodes ?? 0} resource(s) into the graph — `,
        h('a', { href: `#/${ws}/diagrams` }, 'see them on the Diagrams page →')), 'ok');
    }
  };

  const runEnrich = async (btn, runningLabel, idleLabel, path, body, cardTitle = 'Map dependencies', { expectTargeted = false } = {}) => {
    const authVia = auth.viaOf(profileSel.value);
    if (authVia) body = { ...body, authVia };
    // Credential pre-flight — an expired session shows an inline Authenticate
    // card and auto-starts this enrichment once the sign-in completes.
    await auth.preflight(profileSel.value, {
      host: results,
      actionLabel: cardTitle.toLowerCase(),
      buttons: [{ el: btn, runningText: runningLabel, idleText: idleLabel }],
      run: async () => {
        btn.disabled = true;
        btn.textContent = runningLabel;
        persist();
        results.innerHTML = '';
        // Job path first — survives refresh; sync fallback below is unchanged.
        const handled = await runJob(ctx, 'enrich', body, {
          label: expectTargeted ? 'Mapping Arpio dependencies…' : 'Enriching components…',
          activityHost: results,
          renderResult: (res) => renderEnrichResults(res, { expectTargeted }),
          doneToast: toastEnrich,
          buttons: [{ el: btn, runningText: runningLabel, idleText: idleLabel }],
        });
        if (handled) return;
        try {
          const res = await api.post(path, body);
          renderEnrichResults(res, { expectTargeted });
          toastEnrich(res);
        } catch (e) {
          results.innerHTML = '';
          results.append(isUnavailable(e) ? unavailableCard(cardTitle) : card(badge(e.message, 'err')));
        } finally {
          btn.disabled = false;
          btn.textContent = idleLabel;
        }
      },
    });
  };

  // --- The Arpio path's second half: map ONLY the components imported from
  // Arpio, matching by their exact ARNs — no account-wide scan.
  const ARPIO_IDLE = 'Map dependencies for Arpio-imported resources only';
  const arpioBtn = h('button', { class: 'btn' }, ARPIO_IDLE);
  arpioBtn.addEventListener('click', () => {
    runEnrich(arpioBtn, 'Mapping Arpio dependencies… (read-only)', ARPIO_IDLE,
      `/w/${ws}/resources/enrich`,
      { target: 'arpio', profile: profileSel.value, region: regionInp.value.trim() },
      'Arpio overlay', { expectTargeted: true });
  });
  const arpioPreset = h('div', { class: 'arpio-preset' },
    h('h3', null, 'Came from Arpio?'),
    promiseLine('Maps dependencies for only the resources you imported from Arpio, matched on their exact ARNs — so results say “exact” and no account-wide scan happens. Import on the Arpio tab first.',
      { readOnly: true, time: 'a minute or two' }),
    actionRow([arpioBtn,
      h('button', { class: 'btn btn-ghost btn-sm', onClick: () => nav.goTab('arpio', 'import') }, 'Open the Arpio tab')],
    null));

  const ENRICH_IDLE = 'Map dependencies';
  const enrichBtn = h('button', { class: 'btn', disabled: !awsComps.length }, ENRICH_IDLE);
  enrichBtn.addEventListener('click', () => {
    const ids = awsComps.filter((_, i) => checks[i].checked).map((c) => c.id);
    if (!ids.length) { toast('Select at least one component to map', 'err'); return; }
    runEnrich(enrichBtn, 'Mapping… (read-only describe calls)', ENRICH_IDLE,
      `/w/${ws}/resources/enrich`,
      { componentIds: ids, profile: profileSel.value, region: regionInp.value.trim() });
  });
  // The visible default is "all of them"; the picker is one disclosure away.
  const selCountLine = h('p', { class: 'hint', style: 'margin:0' });
  const refreshSelCount = () => {
    const n = checks.filter((c) => c.checked).length;
    selCountLine.textContent = awsComps.length
      ? (n === awsComps.length
        ? `All ${awsComps.length} component(s) that name an AWS service`
        : `${n} of ${awsComps.length} component(s) selected`)
      : 'No components name an AWS service yet';
  };
  checks.forEach((cb) => cb.addEventListener('change', refreshSelCount));
  allToggle.addEventListener('change', refreshSelCount);
  refreshSelCount();

  // --- Find resources by tag (was "correlate by tag"): multi-tag filter ----
  // Persisted as JSON [{key, values:[...]}]; migrates the old single key/value.
  const TAGF_LS = 'drc.enrich.tagFilters';
  const loadTagFilters = () => {
    try {
      const raw = lsGet(TAGF_LS);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          return arr.slice(0, 10).map((t) => ({
            key: String(t?.key ?? ''),
            values: Array.isArray(t?.values) ? t.values.map(String) : [],
          }));
        }
      }
    } catch { /* fall through to legacy/blank */ }
    const legacyKey = lsGet('drc.enrich.tagKey'), legacyVal = lsGet('drc.enrich.tagValue');
    if (legacyKey || legacyVal) return [{ key: legacyKey || '', values: legacyVal ? [legacyVal] : [] }];
    return [{ key: '', values: [] }];
  };

  const tagRows = []; // {el, keyInp, valInp}
  const tagRowsBox = h('div');
  const addRowBtn = h('button', { class: 'btn btn-sm' }, '＋ Add tag filter');
  const refreshTagRowButtons = () => {
    tagRows.forEach((r) => { r.removeBtn.disabled = tagRows.length <= 1; });
    addRowBtn.disabled = tagRows.length >= 10;
  };
  const addTagRow = (key = '', values = []) => {
    if (tagRows.length >= 10) return;
    const keyInp = h('input', { class: 'tagf-key', value: key, placeholder: 'tag key — e.g. app' });
    const valInp = h('input', { class: 'tagf-vals', value: values.join(', '), placeholder: 'values, comma-separated — e.g. claims-platform, pricing' });
    const removeBtn = h('button', { class: 'tagf-x', title: 'Remove this filter', onClick: () => {
      const i = tagRows.findIndex((r) => r.removeBtn === removeBtn);
      if (i >= 0 && tagRows.length > 1) { tagRows[i].el.remove(); tagRows.splice(i, 1); refreshTagRowButtons(); }
    } }, '✕');
    const el = h('div', { class: 'tagf-row' }, keyInp, valInp, removeBtn);
    tagRows.push({ el, keyInp, valInp, removeBtn });
    tagRowsBox.append(el);
    refreshTagRowButtons();
  };
  loadTagFilters().forEach((t) => addTagRow(t.key, t.values));
  addRowBtn.addEventListener('click', () => addTagRow());

  const proposeCb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const TAG_IDLE = 'Find resources';
  const tagBtn = h('button', { class: 'btn' }, TAG_IDLE);
  const renderTagResults = (res, { note = null } = {}) => {
    tagResults.innerHTML = '';
    if (note) {
      tagResults.append(h('div', { class: 'row', style: 'margin:0 0 10px' }, badge(note, 'warn')));
    }
    tagResults.append(enrichResultPanel(res, compsById));
    if (res.proposals?.length) tagResults.append(proposalsPanel(res.proposals, ctx));
    const matched = res.matched ?? 0;
    tagResults.append(card(
      h('p', null, matched
        ? `Found ${matched} resource${matched === 1 ? '' : 's'} carrying those tags. ${res.proposals?.length ? `${res.proposals.length} of them look like components worth importing — review them above.` : 'They are in the resource graph; any that match no component are flagged for review.'}`
        : 'Nothing carried those tags in this region. Check the key spelling and the region above — tag keys are case-sensitive in AWS.'),
      nextSteps(
        { label: 'See them on the Diagrams page', href: `#/${ws}/diagrams` },
        { label: 'Open Inventory', href: `#/${ws}/inventory` },
      ),
    ));
  };
  const toastTag = (res) => {
    toast(`Found ${res.matched ?? 0} resource(s)${res.proposals?.length ? ` — ${res.proposals.length} component proposal(s) below` : ''}.`,
      (res.matched ?? 0) ? 'ok' : '');
  };
  tagBtn.addEventListener('click', async () => {
    const tags = tagRows
      .map((r) => ({
        key: r.keyInp.value.trim(),
        values: r.valInp.value.split(',').map((s) => s.trim()).filter(Boolean),
      }))
      .filter((t) => t.key && t.values.length);
    if (!tags.length) { toast('Enter at least one tag key with at least one value', 'err'); return; }
    lsSet(TAGF_LS, JSON.stringify(tags));
    persist();
    const common = { profile: profileSel.value, region: regionInp.value.trim() };
    const authVia = auth.viaOf(profileSel.value);
    if (authVia) common.authVia = authVia;
    const tagButtons = [{ el: tagBtn, runningText: 'Searching… (read-only)', idleText: TAG_IDLE }];
    // Credential pre-flight — an expired session shows an inline Authenticate
    // card and auto-starts the tag search once the sign-in completes.
    await auth.preflight(profileSel.value, {
      host: tagResults,
      actionLabel: 'the tag search',
      buttons: tagButtons,
      run: async () => {
        tagBtn.disabled = true;
        tagBtn.textContent = 'Searching… (read-only)';
        tagResults.innerHTML = '';
        // Job path first — survives refresh; the sync fallback below (including
        // its old-backend single-tag degradation) is unchanged.
        const handled = await runJob(ctx, 'enrich-by-tag',
          { ...common, tags, proposeComponents: proposeCb.checked }, {
            label: 'Searching for resources by tag…',
            activityHost: tagResults,
            renderResult: (res) => renderTagResults(res),
            doneToast: toastTag,
            buttons: tagButtons,
          });
        if (handled) return;
        try {
          let res = null, fellBack = false;
          try {
            res = await api.post(`/w/${ws}/resources/enrich-by-tag`,
              { ...common, tags, proposeComponents: proposeCb.checked });
            // An older backend answers the new body with 200 + an errors[] complaint
            // rather than a 4xx — treat that as "multi-tag unsupported" too.
            if (res && typeof res.matched !== 'number'
                && (res.errors || []).some((m) => /tagKey and tagValue/i.test(String(m)))) {
              fellBack = true;
              res = null;
            }
          } catch (e) {
            if (!isUnavailable(e)) throw e;
            fellBack = true;
          }
          if (!res) {
            // Old backend: single key/value only — degrade to the first filter's first value.
            res = await api.post(`/w/${ws}/resources/enrich-by-tag`,
              { ...common, tagKey: tags[0].key, tagValue: tags[0].values[0] });
          }
          renderTagResults(res, {
            note: fellBack
              ? `Multi-tag filters not available on this server yet — used only ${tags[0].key}=${tags[0].values[0]}.`
              : null,
          });
          toastTag(res);
        } catch (e) {
          tagResults.innerHTML = '';
          tagResults.append(isUnavailable(e) ? unavailableCard('Find resources by tag') : card(badge(e.message, 'err')));
        } finally {
          tagBtn.disabled = false;
          tagBtn.textContent = TAG_IDLE;
        }
      },
    });
  });

  if (resumeMap) {
    resumeMap['enrich'] = {
      host: results,
      render: (res) => renderEnrichResults(res),
      doneToast: toastEnrich,
      buttons: [
        { el: enrichBtn, runningText: 'Mapping… (read-only describe calls)', idleText: ENRICH_IDLE, idleDisabled: !awsComps.length },
        { el: arpioBtn, runningText: 'Mapping Arpio dependencies… (read-only)', idleText: ARPIO_IDLE },
      ],
    };
    resumeMap['enrich-by-tag'] = {
      host: tagResults,
      render: (res) => renderTagResults(res),
      doneToast: toastTag,
      buttons: [{ el: tagBtn, runningText: 'Searching… (read-only)', idleText: TAG_IDLE }],
    };
  }

  // AI help for the review backlog, wired to the real correlate endpoints.
  const matchBtn = aiCorrelateButton(ctx, { onApplied: () => nav.refresh() });

  return [
    panel(
      { id: 'disc-card-map', 'data-focus': 'map' },
      h('h2', null, term('Map dependencies', 'enrichment', 'deep enrichment')),
      promiseLine('For components already in your inventory, pulls what each one actually depends on — security groups, subnets and AZs, IAM roles and policies, target groups and listeners, KMS keys, certificates, tags — into the resource graph you see when you click a node on the Diagrams page. Your inventory text is not rewritten.',
        { readOnly: true, time: 'under a minute for a handful of components' }),
      h('p', { class: 'hint', style: 'margin-top:6px' },
        'Older DR Compass docs — and the jobs list — call this “deep enrichment”.'),
      h('div', { class: 'row', style: 'margin:10px 0 0' }, selCountLine),
      advanced(`Advanced — choose which components to map (${awsComps.length} available)`,
        h('span', { class: 'hint', style: 'font-weight:600' }, 'Components that name an AWS service — all selected by default'),
        compList),
      actionRow(enrichBtn,
        awsComps.length
          ? h('p', { class: 'act-promise' }, 'Uses the profile and region in the AWS connection card above.')
          : h('p', { class: 'act-promise' }, 'Nothing to map yet — scan the account above, or import from Arpio, first.')),
      h('div', { class: 'divider' }),
      arpioPreset,
    ),
    results,
    panel(
      { id: 'disc-card-tag', 'data-focus': 'tag' },
      h('h2', null, term('Find resources by tag', 'correlate', 'correlate by tag')),
      promiseLine('Asks AWS for everything carrying the tags you name, wherever it lives, and adds it to the resource graph. This is how you catch what a service-by-service scan missed; anything that matches no component is flagged for review rather than guessed at.',
        { readOnly: true, nothingWritten: true, time: 'seconds' }),
      h('p', { class: 'hint', style: 'margin-top:6px' },
        'Older DR Compass docs call this “correlate by tag”.'),
      h('p', { class: 'hint', style: 'margin:10px 0 6px;font-weight:600' }, 'Tag filter'),
      tagRowsBox,
      advanced('Advanced — more filters, component proposals',
        h('p', { class: 'hint', style: 'margin-bottom:8px' },
          'A resource must match every row (AND across rows); within a row, any one of the comma-separated values counts (OR within values).'),
        h('div', { class: 'row', style: 'margin-bottom:12px' }, addRowBtn),
        h('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:4px' },
          proposeCb, 'Propose components for app-level matches',
          h('span', { class: 'hint' }, '(on by default — review and import them like a scan)'))),
      actionRow(tagBtn,
        h('p', { class: 'act-promise' }, 'Uses the profile and region in the AWS connection card above.')),
      h('div', { class: 'ai-row' }, matchBtn,
        h('span', { class: 'hint' },
          'Asks your local Claude Code CLI to propose which component each unlinked resource (and unmatched Kubernetes workload) belongs to. You approve each link before anything is written.')),
    ),
    tagResults,
  ];
}

// ------------------------------------------------------------- §10 Tab: Arpio

function renderArpio(el, ctx, nav) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  // Arpio API keys have two parts (key ID + secret), sent together as
  // "X-Api-Key: <keyId>:<secret>". Pasting the combined "id:secret" into the
  // Key ID field alone also works.
  const keyIdInp = h('input', { placeholder: 'API key ID', autocomplete: 'off' });
  const secretInp = h('input', { type: 'password', placeholder: 'API key secret', autocomplete: 'off' });
  const acctInp = h('input', { placeholder: 'Optional — first randomized string in your Arpio console URL', autocomplete: 'off' });
  const connectBtn = h('button', { class: 'btn btn-primary' }, 'Connect & scan');
  const results = h('div');

  // Shared render path — used by the job path, the sync fallback, and
  // "Last run → View results".
  const renderArpioResults = (res) => {
    results.innerHTML = '';
    res = res || {};
    if (res.ok) {
      if (res.message) results.append(errorBadges([res.message]));
      if (res.trace?.length) results.append(logPanel(res.trace, 'steps'));
      results.append(proposalsPanel(res.proposals || [], ctx));
      // The second half of the Arpio path: map dependencies for exactly these.
      results.append(card(
        h('h3', { style: 'margin-bottom:6px' }, 'After you import them'),
        h('p', { class: 'hint' },
          'Map dependencies for only these resources — matched on their exact ARNs, with no account-wide scan. That needs an AWS profile, so it lives on the AWS tab.'),
        nextSteps(
          { label: 'Map dependencies for these resources', onClick: () => nav.goTab('aws', 'map') },
          { label: 'Review what you imported in Inventory', href: `#/${ws}/inventory` },
        ),
      ));
    } else {
      results.append(card(
        h('h2', null, 'Could not read from Arpio'),
        h('p', { style: 'margin:8px 0' }, badge(res.message || 'Unknown error', 'warn')),
        res.trace?.length
          ? h('details', { class: 'disc-log', open: true, style: 'margin:10px 0' },
              h('summary', null, `What each Arpio endpoint returned (${res.trace.length} steps — no secrets)`),
              h('pre', { class: 'mono' }, res.trace.join('\n')))
          : null,
        h('p', { class: 'hint' },
          'Keys are created in the Arpio console under Settings → Account Settings → API Keys, and both parts are needed (sent as "X-Api-Key: <keyId>:<secret>"). If the key cannot list accounts, add your Account ID — the first randomized string in your Arpio console URL. If the trace shows data that isn\'t being extracted, paste the trace to your AI copilot or into a GitHub issue — it contains structure only, no secrets.'),
      ));
    }
  };
  const toastArpio = (res) => {
    if (res?.ok) toast(`Arpio scan finished — ${(res.proposals || []).length} proposal(s) below`, 'ok');
    else toast(res?.message || 'Could not read from Arpio — see details below', 'err');
  };
  const connectButtons = [{ el: connectBtn, runningText: 'Connecting…', idleText: 'Connect & scan' }];

  connectBtn.addEventListener('click', async () => {
    const keyId = keyIdInp.value.trim();
    const secret = secretInp.value.trim();
    if (!keyId || (!secret && !keyId.includes(':'))) {
      toast('Enter the Arpio API key ID and secret (or paste the combined id:secret)', 'err');
      return;
    }
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    results.innerHTML = '';
    const body = keyId.includes(':') && !secret
      ? { apiKey: keyId, accountId: acctInp.value.trim() }
      : { apiKeyId: keyId, apiSecret: secret, accountId: acctInp.value.trim() };
    // Job path first — same body as the sync endpoint (keys are used
    // per-request server-side and never persisted, job or not); falls back
    // to the synchronous call when the jobs backend is not mounted.
    const handled = await runJob(ctx, 'arpio', body, {
      label: 'Scanning Arpio account…',
      activityHost: results,
      renderResult: renderArpioResults,
      doneToast: toastArpio,
      buttons: connectButtons,
    });
    if (handled) return;
    try {
      const res = await api.post(`/w/${ws}/discover/arpio`, body);
      renderArpioResults(res);
    } catch (e) {
      results.append(card(badge(e.message, 'err')));
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect & scan';
    }
  });

  el.append(
    panel(
      { id: 'disc-card-arpio', 'data-focus': 'import' },
      h('h2', null, 'Import what Arpio already protects'),
      promiseLine('Reads your Arpio accounts, applications and protected resources and proposes them as components — already marked in-recovery-scope with mechanism "arpio-recovery-point". Your key is used for this one request and never written to disk.',
        { readOnly: true, nothingWritten: true, time: 'under a minute' }),
      h('p', { class: 'hint', style: 'margin:10px 0 10px' },
        'Create a key in the Arpio console under ', h('strong', null, 'Settings → Account Settings → API Keys'),
        '. It has two parts — enter both. (Pasting the combined ', h('code', null, 'id:secret'), ' into the first box works too.)'),
      h('div', { class: 'grid cols-2' },
        field('API key ID (never persisted)', keyIdInp),
        field('API key secret (never persisted)', secretInp)),
      advanced('Advanced — Arpio account ID',
        h('p', { class: 'hint', style: 'margin-bottom:8px' },
          'Only needed if the key cannot list accounts by itself. It is the first randomized string in your Arpio console URL.'),
        field('Arpio account ID', acctInp)),
      actionRow(connectBtn,
        h('p', { class: 'act-promise' }, 'Then: review the proposals, import the ones you want, and map their dependencies from the AWS tab.')),
    ),
    results,
  );
  resumeJobs(ctx, 'arpio', {
    arpio: { host: results, render: renderArpioResults, doneToast: toastArpio, buttons: connectButtons },
  }); // deliberately not awaited
}

// -------------------------------------------------------- §11 Tab: Kubernetes

function k8sSummaryChips(summary) {
  const s = summary || {};
  return h('div', { class: 'row', style: 'margin:10px 0' },
    badge(`${s.namespaces ?? 0} namespaces`, 'accent'),
    badge(`${s.workloads ?? 0} workloads`, 'accent'),
    badge(`${s.services ?? 0} services`, 'accent'),
    badge(`${s.ingresses ?? 0} ingresses`, 'accent'),
    badge(`${s.linked ?? 0} linked to inventory`, 'ok'));
}

async function renderK8s(el, ctx, nav) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('div', { class: 'loading' }, 'Checking for kubectl…'));
  let info = null, infoErr = null;
  try { info = await api.get('/discover/k8s/contexts'); }
  catch (e) { infoErr = e; }
  el.innerHTML = '';

  const scanResults = h('div');
  const snapshotBox = h('div');
  let triggerScan = null; // set below when kubectl is available
  let k8sScanButtons = []; // set below when the scan button exists

  // Shared render path — used by the job path, the sync fallback, and
  // "Last run → View results". (loadSnapshot is hoisted.)
  const renderK8sScanResults = (res) => {
    scanResults.innerHTML = '';
    const linked = res.summary?.linked ?? 0;
    const wl = res.summary?.workloads ?? 0;
    scanResults.append(card(
      h('h3', { style: 'margin-bottom:6px' }, 'Snapshot captured'),
      k8sSummaryChips(res.summary),
      ...[errorBadges(res.errors), logPanel(res.log, 'kubectl commands')].filter(Boolean),
      h('p', null, `${wl} workload${wl === 1 ? '' : 's'} captured, ${linked} of them matched to a component automatically${wl - linked > 0 ? ` — ${wl - linked} still unmatched.` : '.'}`),
      nextSteps(
        { label: 'See the cluster diagram', href: `#/${ws}/diagrams/k8s-cluster` },
        wl - linked > 0 ? { label: 'Match the rest to components', onClick: () => nav.goTab('aws', 'tag') } : null,
        { label: 'Open Inventory', href: `#/${ws}/inventory` },
      ),
    ));
    loadSnapshot();
  };

  // ---- Card 3 body: current snapshot (loaded/reloaded independently)
  async function loadSnapshot() {
    snapshotBox.innerHTML = '';
    let snap = null;
    try { snap = await api.get(`/w/${ws}/k8s`); }
    catch (e) {
      snapshotBox.append(isUnavailable(e)
        ? unavailableCard('Current snapshot')
        : card(h('h2', null, 'Current snapshot'), badge(e.message, 'err')));
      return;
    }
    const has = snap && (snap.capturedAt || snap.summary || snap.cluster || snap.source);
    if (!has) {
      snapshotBox.append(panel(
        { id: 'disc-card-snapshot', 'data-focus': 'snapshot' },
        h('h2', null, 'No cluster snapshot stored yet'),
        h('p', { class: 'hint' },
          'Capture one below — either straight from your kubeconfig with kubectl, or by running the snapshot script somewhere with cluster access and uploading its JSON. A snapshot gives you namespaces, workloads, services and ingresses, and links workloads to inventory components automatically.'),
      ));
      return;
    }
    const rescanBtn = h('button', { class: 'btn' }, 'Re-capture');
    rescanBtn.addEventListener('click', () => {
      if (triggerScan) triggerScan();
      else toast('kubectl was not found — re-run the snapshot script and upload the JSON instead', 'err');
    });
    const deleteBtn = h('button', { class: 'btn btn-danger' }, 'Delete snapshot');
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete the stored Kubernetes snapshot? Inventory components are not touched — only the cluster snapshot and its diagrams.');
      if (!ok) return;
      try {
        await api.del(`/w/${ws}/k8s`);
        toast('Snapshot deleted', 'ok');
        loadSnapshot();
      } catch (e) { toast(e.message, 'err'); }
    });
    const ago = fmtAgo(snap.capturedAt);
    snapshotBox.append(panel(
      { id: 'disc-card-snapshot', 'data-focus': 'snapshot' },
      h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('h2', { style: 'margin:0' }, 'Snapshot on file'),
        ago ? badge(`captured ${ago}`, isStale(snap.capturedAt) ? 'warn' : 'ok') : null,
        h('span', { class: 'spacer' }),
        rescanBtn, deleteBtn),
      isStale(snap.capturedAt)
        ? h('p', { class: 'hint', style: 'margin-bottom:8px' },
            `This snapshot is more than ${STALE_DAYS} days old — clusters move fast, so re-capture before you rely on it for a recovery test.`)
        : null,
      h('div', { class: 'snap-meta' },
        h('span', { class: 'k' }, 'Captured'), h('span', null, snap.capturedAt || '—'),
        h('span', { class: 'k' }, 'Source'), h('span', null, snap.source || '—'),
        h('span', { class: 'k' }, 'Cluster'), h('span', { class: 'mono' }, snap.cluster || '—')),
      k8sSummaryChips(snap.summary || snap.counts),
      nextSteps(
        { label: 'See the cluster diagram', href: `#/${ws}/diagrams/k8s-cluster` },
        { label: 'Open Inventory', href: `#/${ws}/inventory` },
      ),
    ));
  }

  // ---- Capture path 1: straight from your kubeconfig
  let scanCard;
  if (infoErr) {
    scanCard = isUnavailable(infoErr)
      ? unavailableCard('Capture with kubectl')
      : card(h('h2', null, 'Capture with kubectl'), badge(infoErr.message, 'err'));
  } else if (!info?.kubectlFound) {
    scanCard = panel(
      { id: 'disc-card-k8s-capture', 'data-focus': 'capture' },
      h('div', { class: 'muted-card' },
        h('h2', null, 'kubectl not found on this machine'),
        h('p', null, 'This path shells out to your local ', h('code', null, 'kubectl'), ' with your own kubeconfig — nothing is routed through DR Compass.'),
        h('p', { class: 'hint', style: 'margin:8px 0 6px' }, 'Install it and reload this page, or use the script path below, which needs nothing installed here:'),
        h('pre', { class: 'mono' }, 'brew install kubectl   # or: see kubernetes.io/docs/tasks/tools')),
    );
  } else {
    const contexts = info.contexts || [];
    const ctxSel = h('select', null,
      contexts.length
        ? contexts.map((c) => h('option', { value: c.name }, c.current ? `${c.name} (current)` : c.name))
        : [h('option', { value: '' }, '(no contexts found in kubeconfig)')]);
    const current = contexts.find((c) => c.current);
    if (current) ctxSel.value = current.name;
    const nsInp = h('input', { placeholder: 'e.g. claims,pricing — blank = all app namespaces' });
    const K8S_IDLE = 'Capture a snapshot';
    const scanBtn = h('button', { class: 'btn btn-primary', disabled: !contexts.length }, K8S_IDLE);
    k8sScanButtons = [{
      el: scanBtn,
      runningText: 'Capturing… (read-only kubectl get calls)',
      idleText: K8S_IDLE,
      idleDisabled: !contexts.length,
    }];
    triggerScan = async () => {
      if (scanBtn.disabled) return;
      scanBtn.disabled = true;
      scanBtn.textContent = 'Capturing… (read-only kubectl get calls)';
      scanResults.innerHTML = '';
      const namespaces = nsInp.value.split(',').map((s) => s.trim()).filter(Boolean);
      const body = { context: ctxSel.value };
      if (namespaces.length) body.namespaces = namespaces;
      // Job path first — survives refresh; sync fallback below unchanged.
      const handled = await runJob(ctx, 'k8s-scan', body, {
        label: 'Capturing the Kubernetes cluster…',
        activityHost: scanResults,
        renderResult: renderK8sScanResults,
        buttons: k8sScanButtons,
      });
      if (handled) return;
      try {
        const res = await api.post(`/w/${ws}/k8s/scan`, body);
        renderK8sScanResults(res);
      } catch (e) {
        scanResults.append(isUnavailable(e)
          ? unavailableCard('Kubernetes scan')
          : card(badge(e.message, 'err')));
      } finally {
        scanBtn.disabled = !contexts.length;
        scanBtn.textContent = K8S_IDLE;
      }
    };
    scanBtn.addEventListener('click', triggerScan);
    scanCard = panel(
      { id: 'disc-card-k8s-capture', 'data-focus': 'capture' },
      h('h2', null, 'Capture the cluster with kubectl'),
      promiseLine(h('span', null,
        'Records namespaces, workloads, services and ingresses through your own kubeconfig, then matches workloads to inventory components by name. Only ',
        h('code', null, 'kubectl get -o json'),
        ' runs; Secret and ConfigMap names are recorded, never their values.'),
      { readOnly: true, time: '10–30 seconds' }),
      field('Context', ctxSel),
      advanced('Advanced — limit to specific namespaces',
        h('p', { class: 'hint', style: 'margin-bottom:8px' },
          'Blank (the default) captures every application namespace and skips the cluster’s own system namespaces.'),
        field('Namespaces (comma-separated)', nsInp)),
      actionRow(scanBtn,
        h('p', { class: 'act-promise' }, 'Replaces the stored snapshot for this workspace. Inventory components are never modified.')),
    );
  }

  // ---- Card 2: run a script yourself, then upload the artifact
  const uploadResults = h('div');
  const upload = jsonDropZone('Drop the snapshot JSON here, or click to choose the file', 'snapshot', async (parsed, setText) => {
    setText('Uploading…');
    uploadResults.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/k8s/upload`, parsed);
      uploadResults.append(card(
        h('h3', { style: 'margin-bottom:6px' }, 'Snapshot stored'),
        k8sSummaryChips(res.summary),
        errorBadges(res.warnings),
        nextSteps(
          { label: 'See the cluster diagram', href: `#/${ws}/diagrams/k8s-cluster` },
          { label: 'Open Inventory', href: `#/${ws}/inventory` },
        ),
      ));
      toast('Snapshot uploaded', 'ok');
      loadSnapshot();
    } catch (e) {
      uploadResults.append(isUnavailable(e)
        ? unavailableCard('Snapshot upload')
        : card(badge(e.message, 'err')));
    } finally {
      setText(null);
    }
  });
  const scriptCard = panel(
    { id: 'disc-card-k8s-script', 'data-focus': 'k8s-script' },
    h('h2', null, 'No cluster access from this machine?'),
    promiseLine('Downloads a snapshot script you run wherever you do have cluster access — a bastion, a CI runner. Drop the JSON it writes here and you get the same stored snapshot.',
      { readOnly: true, time: 'a couple of minutes' }),
    actionRow(
      h('a', { class: 'btn', href: '/api/discover/k8s/script', download: 'drcompass-k8s-snapshot.sh' },
        'Download the snapshot script'),
      h('p', { class: 'act-promise' }, 'Plain bash, read-only kubectl calls — open it and read it before you run it.')),
    h('p', { class: 'hint', style: 'margin:12px 0 8px' }, 'Step 2 — upload what it produced:'),
    upload.zone, upload.fileInput,
    uploadResults,
  );

  el.append(
    snapshotBox,   // state first: what this workspace already has
    scanCard,
    scanResults,
    scriptCard,
    h('p', { class: 'hint', style: 'margin-top:14px' },
      'The AI copilot (Cmd/Ctrl+K) can also help interpret a snapshot or link workloads to components.'),
  );
  loadSnapshot();
  resumeJobs(ctx, 'k8s', {
    'k8s-scan': { host: scanResults, render: renderK8sScanResults, buttons: k8sScanButtons },
  }); // deliberately not awaited
}

// ------------------------------------------------------------ §12 Tab: Ask AI

const SUGGEST_PROMPT = 'Given this inventory, what dependencies, third-party calls, secrets, or components am I likely missing for a complete DR plan?';
const PROMPT_CHIPS = [
  'Which components look under-specified?',
  'Draft outbound-call entries for adjudication-service',
  'What would break first in a region failover?',
  'Which secrets are most likely to break a recovery test?',
  'Propose a verification command for each database component',
];

async function renderAi(el, ctx, nav) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('div', { class: 'loading' }, 'Checking for the Claude Code CLI…'));
  let status = { claudeCliFound: false };
  try { status = await api.get('/discover/ai/status'); } catch { /* banner below covers it */ }
  el.innerHTML = '';

  if (!status.claudeCliFound) {
    el.append(card(
      h('h2', null, 'Claude Code CLI not found'),
      h('p', null, 'The AI tab shells out to your local ', h('code', null, 'claude'), ' CLI — your account, your machine, nothing routed through DR Compass.'),
      h('p', { class: 'hint', style: 'margin:8px 0 6px' }, 'Install Claude Code and sign in, then reload this page:'),
      h('pre', { class: 'mono' }, 'npm install -g @anthropic-ai/claude-code\nclaude   # sign in once'),
    ));
    // Still render the tools below (disabled) so users can see what they would get.
  }

  const promptTa = h('textarea', { placeholder: 'e.g. Which of these components would block a region failover first, and why?', style: 'min-height:110px' });
  const ctxCheck = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const askBtn = h('button', { class: 'btn btn-primary', disabled: !status.claudeCliFound }, 'Ask');
  const answerBox = h('div');

  askBtn.addEventListener('click', async () => {
    const prompt = promptTa.value.trim();
    if (!prompt) { toast('Type a question first', 'err'); return; }
    askBtn.disabled = true;
    askBtn.textContent = 'Thinking… (local claude CLI, up to 3 min)';
    answerBox.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/ai/ask`, { prompt, includeContext: ctxCheck.checked });
      answerBox.append(res.ok
        ? card(h('h3', { style: 'margin-bottom:8px' }, 'Answer'), markdown(res.answer || '(empty answer)'))
        : card(badge(res.message, 'warn')));
    } catch (e) {
      answerBox.append(card(badge(e.message, 'err')));
    } finally {
      askBtn.disabled = !status.claudeCliFound;
      askBtn.textContent = 'Ask';
    }
  });

  const chipRow = h('div', { class: 'row', style: 'margin:8px 0 12px' },
    PROMPT_CHIPS.map((p) => h('span', { class: 'prompt-chip', onClick: () => { promptTa.value = p; promptTa.focus(); } }, p)));

  const SUGGEST_IDLE = 'Find what I’m likely missing';
  const suggestBtn = h('button', { class: 'btn btn-primary', disabled: !status.claudeCliFound }, SUGGEST_IDLE);
  const suggestBox = h('div');
  suggestBtn.addEventListener('click', async () => {
    suggestBtn.disabled = true;
    suggestBtn.textContent = 'Reading your inventory… (up to 3 min)';
    suggestBox.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/ai/suggest`, { freeText: SUGGEST_PROMPT });
      if (res.ok && res.proposals) suggestBox.append(proposalsPanel(res.proposals, ctx));
      else if (res.ok && res.raw) suggestBox.append(card(
        h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'The AI did not return importable proposals — its raw answer is below, and you can act on it by hand:'),
        markdown(res.raw),
        nextSteps({ label: 'Add components by hand in Inventory', href: `#/${ws}/inventory` })));
      else suggestBox.append(card(badge(res.message || 'No suggestions returned', 'warn')));
    } catch (e) {
      suggestBox.append(card(badge(e.message, 'err')));
    } finally {
      suggestBtn.disabled = !status.claudeCliFound;
      suggestBtn.textContent = SUGGEST_IDLE;
    }
  });

  // A question handed over from another card ("take this to the Ask AI tab").
  if (pendingAiPrompt) {
    promptTa.value = pendingAiPrompt;
    pendingAiPrompt = '';
  }

  el.append(
    panel(
      { id: 'disc-card-ai-ask', 'data-focus': 'ask' },
      h('h2', null, 'Ask AI about your DR plan'),
      promiseLine('Runs your question through the Claude Code CLI on this machine — your account, your machine, nothing routed through DR Compass. With context on, a compact summary of this workspace (component names, kinds, dependencies, gaps — never secret values) rides along. Answers only: nothing in your workspace changes.',
        { time: '20 seconds to 3 minutes' }),
      chipRow,
      field('Question', promptTa),
      h('div', { class: 'row' },
        h('label', { class: 'row', style: 'gap:8px;cursor:pointer' }, ctxCheck, 'Include workspace context'),
        h('span', { class: 'spacer' }), askBtn),
    ),
    answerBox,
    panel(
      { id: 'disc-card-ai-suggest', 'data-focus': 'suggest' },
      h('h2', null, 'Find what I’m likely missing'),
      promiseLine(`Sends your inventory plus one question — “${SUGGEST_PROMPT}” — and turns the answer into component proposals you review and import exactly like a scan.`,
        { nothingWritten: true, time: 'up to 3 minutes' }),
      actionRow(suggestBtn,
        h('p', { class: 'act-promise' }, 'Best run after a scan, when there is something to reason about.')),
    ),
    suggestBox,
  );
}

// ------------------------------------------------- §13 Tab: Network flows
// Feed in a firewall / flow-log export and learn which workload calls what.
// The file is parsed IN THE BROWSER — it is never uploaded; only the parsed
// cells go to your own local DR Compass server, which analyzes them in memory.

const NET_STYLE = `
  .nf-stats { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:10px 0 2px; }
  .nf-map { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px 14px; margin:6px 0 12px; }
  .nf-src { font-family:var(--mono); font-size:12px; overflow-wrap:anywhere; max-width:300px; }
  .nf-dst { overflow-wrap:anywhere; max-width:320px; }
  .nf-dst .nf-raw { display:block; color:var(--muted); font-family:var(--mono); font-size:11px; }
  .nf-arrow { color:var(--muted); text-align:center; width:18px; }
  .nf-num { font-family:var(--mono); text-align:right; white-space:nowrap; }
  .nf-grp td { background:var(--bg2); font-weight:700; font-size:12.5px; }
  .nf-why { color:var(--muted); font-size:11.5px; margin-top:2px; overflow-wrap:anywhere; }
  .nf-scroll { max-height:460px; overflow:auto; border:1px solid var(--border); border-radius:8px; }
  .nf-scroll table { margin:0; }
  .nf-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0 10px; }
  .nf-toolbar input[type=search] { flex:1; min-width:180px; }
  .nf-pick select { width:100%; max-width:280px; }
`;

const NET_BADGE = { 'aws-service': 'accent', 'third-party': 'warn', saas: 'purple', internal: '' };
const NET_MAX_PARSE_ROWS = 100000;
const NET_MAX_TABLE_ROWS = 500;
const NET_MAX_SOURCE_ROWS = 300;
// `count` and `volume` are deliberately two roles, not one. A count is a number
// of observations; bytes and packets are traffic. The importer refuses to let a
// byte column answer "how many times?" — see server/lib/network-flows.js, and
// problem 1 in docs/JOURNEY-REPORT.md for what happened when it did.
const NET_ROLES = [
  ['source', 'Source'], ['destination', 'Destination'], ['port', 'Port'],
  ['protocol', 'Protocol'], ['action', 'Action'], ['count', 'Count / hits / sessions'],
  ['volume', 'Traffic (bytes / packets)'],
];

// Delimiter vote on the header line, ignoring quoted sections.
function netDelimiter(line) {
  const counts = { '\t': 0, ',': 0, ';': 0, '|': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && counts[ch] !== undefined) counts[ch]++;
  }
  let best = ','; let bestN = 0;
  for (const [d, n] of Object.entries(counts)) if (n > bestN) { best = d; bestN = n; }
  return bestN ? best : ',';
}

// Small RFC4180-ish parser: quoted fields with "" escapes, CRLF, CSV or TSV.
// Stops after maxRows data rows and says so.
function parseDelimited(text, { maxRows = NET_MAX_PARSE_ROWS } = {}) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = netDelimiter(firstLine);
  const rows = [];
  let row = []; let field = ''; let quoted = false; let touched = false; let truncated = false;

  const endField = () => { row.push(field); field = ''; touched = false; };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
    row = [];
    if (rows.length >= maxRows + 1) truncated = true; // +1 for the header row
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      continue;
    }
    if (ch === '"' && !touched) { quoted = true; touched = true; continue; }
    if (ch === delim) { endField(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); if (truncated) break; continue; }
    field += ch; touched = true;
  }
  if (!truncated && (touched || field !== '' || row.length)) endRow();
  if (!rows.length) return { headers: [], rows: [], truncated, delimiter: delim, synthesizedHeaders: false };

  // A first row of nothing but addresses/numbers is data, not a header
  // (a word like "a" or "dst" is a header even though it looks like hex).
  const looksLikeData = (r) => r.length > 1
    && r.some((c) => /\d/.test(String(c)))
    && r.every((c) => {
      const v = String(c).trim();
      if (!v) return true;
      if (/^\d+(\.\d+)*$/.test(v)) return true;                    // 443, 10.0.1.5
      return v.includes(':') && /^[0-9a-f:]+$/i.test(v);           // ipv6 literal
    });
  let headers;
  let synthesizedHeaders = false;
  if (looksLikeData(rows[0])) {
    headers = rows[0].map((_, i) => `col${i + 1}`);
    synthesizedHeaders = true;
  } else {
    headers = rows.shift().map((hd, i) => String(hd).trim() || `col${i + 1}`);
  }
  const width = headers.length;
  const data = rows.map((rw) => (rw.length === width ? rw : Array.from({ length: width }, (_, i) => rw[i] ?? '')));
  return { headers, rows: data, truncated, delimiter: delim, synthesizedHeaders };
}

// Drop-zone twin of jsonDropZone for plain-text exports (CSV/TSV) — that one
// JSON.parses the file, which is exactly what must NOT happen here.
function netDropZone(idleLabel, onText) {
  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.log,text/csv,text/plain', style: 'display:none' });
  const zone = h('div', {
    class: 'drop-zone',
    onClick: () => fileInput.click(),
    onDragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    onDragleave: () => zone.classList.remove('over'),
    onDrop: (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    },
  }, idleLabel);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });
  const setText = (t) => { zone.textContent = t ?? idleLabel; };
  function handleFile(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file', 'err');
    reader.onload = () => onText(String(reader.result || ''), file, setText);
    reader.readAsText(file);
  }
  return { zone, fileInput, setText };
}

const netPct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
// Display twin of formatBytes() in server/lib/network-flows.js — decimal units,
// because that is what a firewall export means by MB. The SENTENCE written onto
// a component always comes from the server (flow.purpose); this only formats
// what the flows table shows.
function netBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 1000) return `${Math.round(v)} B`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let x = v / 1000; let i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} ${units[i]}`;
}
function netConfBadge(conf, label = 'match') {
  const pct = Math.round((Number(conf) || 0) * 100);
  return badge(`${pct}% ${label}`, pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : '');
}

async function renderNetwork(el, ctx, nav) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('style', null, NET_STYLE));

  let comps = [];
  try { comps = (await api.get(`/w/${ws}/c/components`)).items || []; }
  catch { /* the picker degrades to "skip only" */ }
  const compsById = new Map(comps.map((c) => [c.id, c]));

  const st = { headers: [], rows: [], fileName: '', analysis: null, picks: new Map() };
  const parseBox = h('div');
  const mappingBox = h('div');
  const flowsBox = h('div');
  const assignBox = h('div');
  const resultBox = h('div');
  const clearAll = () => {
    mappingBox.innerHTML = ''; flowsBox.innerHTML = '';
    assignBox.innerHTML = ''; resultBox.innerHTML = '';
  };

  // ---- analyze (no mapping = let the server detect the columns)
  async function analyze(mapping) {
    clearAll();
    mappingBox.append(card(h('div', { class: 'loading' }, 'Analyzing flows…')));
    try {
      const body = { headers: st.headers, rows: st.rows };
      if (mapping) body.mapping = mapping;
      const res = await api.post(`/w/${ws}/network/flows/analyze`, body);
      st.analysis = res;
      st.picks = new Map((res.sourceSuggestions || []).map((s) => [s.source, s.componentId || '']));
      mappingBox.innerHTML = '';
      renderMapping();
      renderFlows();
      renderAssign();
    } catch (e) {
      mappingBox.innerHTML = '';
      mappingBox.append(isUnavailable(e)
        ? unavailableCard('Network flow import')
        : card(h('h2', null, 'Column mapping'), badge(e.message, 'err')));
    }
  }

  // ---- card 2: column mapping
  function renderMapping() {
    const a = st.analysis;
    if (!a) return;
    const meta = (a.mapping && a.mapping.meta) || {};
    const selects = {};
    const grid = h('div', { class: 'nf-map' }, NET_ROLES.map(([role, label]) => {
      const sel = h('select', null,
        h('option', { value: '' }, '— not mapped —'),
        st.headers.map((hd, i) => h('option', { value: String(i) }, `${i + 1}. ${hd}`)));
      const cur = a.mapping ? a.mapping[role] : null;
      sel.value = cur === null || cur === undefined ? '' : String(cur);
      selects[role] = sel;
      const detected = a.detected ? a.detected[role] : null;
      const note = detected === null || detected === undefined
        ? 'not detected'
        : `detected: ${st.headers[detected]} · ${netPct(a.roleConfidence?.[role])}`;
      // Say what else was in the running. A tie between two host-shaped
      // columns is forgivable; hiding it is what made the wrong column stick.
      const alts = (meta.alternatives || {})[role] || [];
      const altNote = alts.length
        ? `also considered: ${alts.map((x) => x.header).filter(Boolean).join(', ')}`
        : '';
      return h('div', null, field(label, sel),
        h('div', { class: 'nf-why' }, note),
        altNote ? h('div', { class: 'nf-why' }, altNote) : null);
    }));
    const reBtn = h('button', { class: 'btn' }, 'Re-analyze with this mapping');
    reBtn.addEventListener('click', () => {
      const mapping = {};
      for (const [role] of NET_ROLES) mapping[role] = selects[role].value === '' ? null : Number(selects[role].value);
      if (mapping.source === null || mapping.destination === null) {
        toast('Pick both a source and a destination column', 'err');
        return;
      }
      analyze(mapping);
    });
    // Detection is usually right, so the selects live behind a disclosure that
    // opens itself when the detection is shaky, incomplete — or CONTESTED,
    // meaning a second column was a plausible candidate for a role and lost.
    // (Problem 2 in docs/JOURNEY-REPORT.md: the tie was fine, reporting it as
    // 100% confident and leaving this shut was not.)
    const contested = Array.isArray(meta.contested) ? meta.contested : [];
    const roleLabel = Object.fromEntries(NET_ROLES);
    const contestedRoles = contested.filter((r) => r !== 'volume' && r !== 'count').map((r) => roleLabel[r] || r);
    const shaky = (Number(a.confidence) || 0) < 0.6 || !!a.warning
      || contestedRoles.length > 0 || !!meta.countRefused
      || a.mapping?.source === null || a.mapping?.source === undefined
      || a.mapping?.destination === null || a.mapping?.destination === undefined;
    const summaryBits = NET_ROLES
      .map(([role, label]) => {
        const idx = a.mapping ? a.mapping[role] : null;
        return (idx === null || idx === undefined) ? null : `${label}: ${st.headers[idx]}`;
      })
      .filter(Boolean).join(' · ');
    mappingBox.append(card(
      h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('h2', { style: 'margin:0' }, 'Columns we read'),
        netConfBadge(a.confidence, 'confident'),
        h('span', { class: 'spacer' })),
      h('p', { class: 'hint', style: 'margin-bottom:4px' },
        summaryBits || 'No columns could be matched to a role.'),
      a.warning ? badge(a.warning, 'warn') : null,
      meta.countRefused
        ? h('p', { class: 'hint', style: 'margin:6px 0 0' },
          badge(`“${meta.countRefused.header}” is ${meta.countRefused.unit}, not a count`, 'warn'),
          ' ',
          `Traffic volume is recorded as ${meta.countRefused.unit}. How often a call was seen is counted from the flow records themselves — a byte total is never an observation count.`)
        : null,
      contestedRoles.length
        ? h('p', { class: 'hint', style: 'margin:6px 0 0' },
          `Another column could have filled ${contestedRoles.join(' / ')} — check the mapping below before applying.`)
        : null,
      h('details', { class: 'adv', open: shaky },
        h('summary', null, 'Advanced — fix a column we got wrong'),
        h('div', { class: 'adv-body' },
          h('p', { class: 'hint', style: 'margin-bottom:10px' },
            'Detected from the header names and the shape of the values. Correct anything that is wrong and re-analyze — a mapping only has to be right once per export format.'),
          grid,
          h('div', { class: 'row' }, reBtn))),
    ));
  }

  // ---- card 3: aggregated flows
  function renderFlows() {
    const a = st.analysis;
    const flows = a?.flows || [];
    if (!flows.length) {
      flowsBox.append(card(
        h('h2', null, 'Flows'),
        empty('No flows came out of that mapping — check that the source and destination columns are right.'),
      ));
      return;
    }
    const s = a.stats || {};
    const filterInp = h('input', { type: 'search', placeholder: 'Filter by source, destination or port…' });
    const groupCb = h('input', { type: 'checkbox', style: 'width:auto' });
    const tableHost = h('div', { class: 'nf-scroll' });
    const countLine = h('div', { class: 'nf-why' }, '');

    // Observed = observations. Traffic = traffic. Two columns, because they are
    // two different facts and only one of them is a number of calls.
    const hasVolume = flows.some((f) => (f.bytes || 0) > 0 || (f.packets || 0) > 0);
    const countBasis = flows[0]?.countBasis === 'count-column' ? 'count-column' : 'records';
    const volumeOf = (f) => {
      if ((f.bytes || 0) > 0) return netBytes(f.bytes);
      if ((f.packets || 0) > 0) return `${Number(f.packets).toLocaleString()} pkts`;
      return '—';
    };
    const sumBytes = Number(s.totalBytes) > 0
      ? Number(s.totalBytes)
      : flows.reduce((n, f) => n + (f.bytes || 0), 0);
    const sumPackets = Number(s.totalPackets) > 0
      ? Number(s.totalPackets)
      : flows.reduce((n, f) => n + (f.packets || 0), 0);
    const cols = ['Source', '', 'Destination', 'Port', 'Proto',
      countBasis === 'count-column' ? 'Observed' : 'Flow records',
      ...(hasVolume ? ['Traffic'] : []), 'Kind', 'Actions'];

    const flowRow = (f, showSource = true) => h('tr', null,
      h('td', { class: 'nf-src' }, showSource ? f.source : ''),
      h('td', { class: 'nf-arrow' }, '→'),
      h('td', { class: 'nf-dst' },
        h('span', null, f.destLabel || f.destination),
        f.destLabel && f.destLabel !== f.destination ? h('span', { class: 'nf-raw' }, f.destination) : null),
      h('td', { class: 'nf-num' }, f.port ?? '—'),
      h('td', null, f.protocol || '—'),
      h('td', { class: 'nf-num' }, String(f.count)),
      hasVolume ? h('td', { class: 'nf-num' }, volumeOf(f)) : null,
      h('td', null, badge(f.destType, NET_BADGE[f.destType] ?? '')),
      h('td', { class: 'nf-why' }, (f.sampleActions || []).join(', ')));

    const draw = () => {
      const q = filterInp.value.trim().toLowerCase();
      const match = (f) => !q
        || f.source.includes(q) || f.destination.includes(q)
        || String(f.destLabel || '').toLowerCase().includes(q)
        || String(f.port || '').includes(q) || String(f.protocol || '').includes(q);
      const shown = flows.filter(match);
      const rows = [];
      if (groupCb.checked) {
        const bySource = new Map();
        for (const f of shown) {
          if (!bySource.has(f.source)) bySource.set(f.source, []);
          bySource.get(f.source).push(f);
        }
        const groups = [...bySource.entries()]
          .map(([src, fs]) => [src, fs, fs.reduce((n, f) => n + f.count, 0)])
          .sort((x, y) => y[2] - x[2] || x[0].localeCompare(y[0]));
        let drawn = 0;
        for (const [src, fs, total] of groups) {
          if (drawn >= NET_MAX_TABLE_ROWS) break;
          const bytes = fs.reduce((n, f) => n + (f.bytes || 0), 0);
          const observed = countBasis === 'count-column'
            ? `${total.toLocaleString()} observed`
            : `${total.toLocaleString()} flow record${total === 1 ? '' : 's'}`;
          rows.push(h('tr', { class: 'nf-grp' },
            h('td', { colspan: String(cols.length) },
              `${src} — ${fs.length} flow${fs.length === 1 ? '' : 's'}, ${observed}${bytes > 0 ? `, ${netBytes(bytes)}` : ''}`)));
          for (const f of fs.slice(0, NET_MAX_TABLE_ROWS - drawn)) { rows.push(flowRow(f, false)); drawn++; }
        }
      } else {
        for (const f of shown.slice(0, NET_MAX_TABLE_ROWS)) rows.push(flowRow(f));
      }
      tableHost.innerHTML = '';
      tableHost.append(rows.length
        ? table(cols, rows)
        : empty('Nothing matches that filter.'));
      countLine.textContent = shown.length > NET_MAX_TABLE_ROWS
        ? `Showing the first ${NET_MAX_TABLE_ROWS} of ${shown.length} flows — narrow the filter to see the rest.`
        : `${shown.length} flow${shown.length === 1 ? '' : 's'}.`;
    };
    filterInp.addEventListener('input', draw);
    groupCb.addEventListener('change', draw);

    flowsBox.append(card(
      h('h2', null, 'Flows'),
      h('div', { class: 'nf-stats' },
        badge(`${s.totalFlows ?? 0} unique flows`, 'accent'),
        badge(`${s.uniqueSources ?? 0} sources`, 'accent'),
        badge(`${s.rowsRead ?? 0} rows read`, ''),
        s.rowsSkipped ? badge(`${s.rowsSkipped} rows skipped (no source/destination)`, 'warn') : null,
        a.truncated ? badge(`capped at ${s.maxFlows ?? 2000} flows`, 'warn') : null,
        sumBytes > 0 ? badge(`${netBytes(sumBytes)} of traffic`, '') : null,
        sumPackets > 0 ? badge(`${sumPackets.toLocaleString()} packets`, '') : null),
      h('p', { class: 'hint', style: 'margin:0 0 8px' },
        countBasis === 'count-column'
          ? 'Observed counts come from the export’s own count column.'
          : 'This export has no count column, so “observed” is the number of flow records — traffic volume is reported as traffic, never as a number of calls.'),
      h('div', { class: 'nf-toolbar' },
        filterInp,
        h('label', { class: 'row', style: 'gap:8px;cursor:pointer;white-space:nowrap' }, groupCb, 'Group by source')),
      tableHost,
      countLine,
    ));
    draw();
  }

  // ---- card 4: assignment
  function renderAssign() {
    const a = st.analysis;
    const all = a?.sourceSuggestions || [];
    if (!all.length) return;
    // Busiest sources first (the server sorts them); a huge export would
    // otherwise put thousands of dropdowns in the DOM at once.
    const suggestions = all.slice(0, NET_MAX_SOURCE_ROWS);
    // Only what is on screen can be applied — no silent writes for rows the
    // user never saw.
    const shownSources = new Set(suggestions.map((s) => s.source));
    for (const k of [...st.picks.keys()]) if (!shownSources.has(k)) st.picks.delete(k);

    // Components grouped by category so the dropdown stays navigable.
    const byCat = new Map();
    for (const c of comps) {
      const cat = c.category || 'other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(c);
    }
    const groups = [...byCat.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    const applyBtn = h('button', { class: 'btn btn-primary' }, 'Apply assignments');
    const refreshBtn = () => {
      const n = [...st.picks.values()].filter(Boolean).length;
      const calls = (a.flows || []).filter((f) => st.picks.get(f.source)).length;
      applyBtn.disabled = !n;
      applyBtn.textContent = n
        ? `Apply ${n} assignment${n === 1 ? '' : 's'} (${calls} call${calls === 1 ? '' : 's'})`
        : 'Apply assignments';
    };

    const rows = suggestions.map((sg) => {
      const sel = h('select', null,
        h('option', { value: '' }, '— skip —'),
        groups.map(([cat, list]) => h('optgroup', { label: cat },
          list.map((c) => h('option', { value: c.id }, c.name)))));
      sel.value = st.picks.get(sg.source) || '';
      sel.addEventListener('change', () => { st.picks.set(sg.source, sel.value); refreshBtn(); });
      const target = sg.componentId ? compsById.get(sg.componentId) : null;
      // When the graph narrowed it to a handful of components but could not
      // pick one, offer those instead of an empty shrug.
      const cands = Array.isArray(sg.candidates) ? sg.candidates : [];
      return h('tr', null,
        h('td', { class: 'nf-src' }, sg.source),
        h('td', null,
          sg.componentId
            ? h('div', null, target?.name || sg.componentId, ' ', netConfBadge(sg.confidence))
            : badge(cands.length ? `${cands.length} possible` : 'no suggestion', 'warn'),
          h('div', { class: 'nf-why' }, sg.why || ''),
          !sg.componentId && cands.length
            ? h('div', { class: 'nf-why' }, `candidates: ${cands.map((c) => c.componentName || c.componentId).join(', ')}`)
            : null),
        h('td', { class: 'nf-pick' }, sel),
        h('td', { class: 'nf-num' }, String(sg.flowCount)));
    });

    applyBtn.addEventListener('click', async () => {
      const bySource = new Map(suggestions.map((s) => [s.source, s]));
      const assignments = [];
      for (const f of a.flows || []) {
        const componentId = st.picks.get(f.source);
        if (!componentId) continue;
        assignments.push({
          componentId,
          target: f.destLabel || f.destination,
          type: f.destType,
          protocol: f.protocol || 'tcp',
          port: f.port,
          // The sentence is built once, on the server, from what was actually
          // observed — the client does not word it a second way.
          purpose: f.purpose || 'observed in network flows',
          critical: false,
          // observedCount is observations only. Traffic travels as traffic.
          observedCount: f.count,
          countBasis: f.countBasis || 'records',
          observedBytes: f.bytes || 0,
          observedPackets: f.packets || 0,
          workload: bySource.get(f.source)?.workload || '',
        });
      }
      if (!assignments.length) { toast('Nothing to apply — assign at least one source', 'err'); return; }
      const label = applyBtn.textContent;
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      resultBox.innerHTML = '';
      try {
        const res = await api.post(`/w/${ws}/network/flows/apply`, { assignments });
        resultBox.append(card(
          h('h2', null, 'Applied'),
          h('div', { class: 'nf-stats' },
            badge(`${res.componentsUpdated} components updated`, 'ok'),
            badge(`${res.callsAdded} outbound calls added`, 'ok'),
            badge(`${res.graphNodesAdded} graph nodes`, 'accent'),
            badge(`${res.graphEdgesAdded} graph edges`, 'accent')),
          h('p', { class: 'hint', style: 'margin:10px 0 6px' },
            'Re-applying the same export is safe: calls are deduped on target + port + protocol.'),
          nextSteps(
            { label: 'Check the calls on those components in Inventory', href: `#/${ws}/inventory` },
            { label: 'See the new targets on the Diagrams page', href: `#/${ws}/diagrams` },
          ),
        ));
        toast(`${res.callsAdded} outbound calls written`, 'ok');
      } catch (e) {
        resultBox.append(isUnavailable(e) ? unavailableCard('Apply flows') : card(badge(e.message, 'err')));
      } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = label;
        refreshBtn();
      }
    });

    assignBox.append(card(
      h('h2', null, 'Match each source to a component'),
      promiseLine('Writes the confirmed calls onto your components as outbound calls, and external targets into the resource graph. Nothing is written until you press Apply, and re-applying the same export changes nothing — calls are deduped on target, port and protocol.',
        { time: 'instant' }),
      h('p', { class: 'hint', style: 'margin:10px 0' },
        'Each source is matched against your inventory and the Kubernetes snapshot — pod-hash suffixes are stripped, so ',
        h('code', null, 'adjudication-deploy-7d9f…-x2k9p'), ' finds the adjudication component. Change anything that looks wrong; sources left on “skip” are not written.'),
      comps.length ? null : badge('This workspace has no components yet — add some on the Inventory page first', 'warn'),
      all.length > suggestions.length
        ? badge(`Showing the ${NET_MAX_SOURCE_ROWS} busiest of ${all.length} sources — narrow the export to reach the rest`, 'warn')
        : null,
      h('div', { class: 'nf-scroll' },
        table(['Source', 'Suggested component', 'Assign to', 'Flows'], rows)),
      h('p', { class: 'hint', style: 'margin:10px 0' },
        'Internal-to-internal traffic is recorded as outbound calls only — DR Compass does not invent ',
        h('code', null, 'dependsOn'), ' links from flow data. External targets (AWS services, SaaS, third parties) also become resource-graph nodes.'),
      h('div', { class: 'row' }, applyBtn),
    ));
    refreshBtn();
  }

  // ---- card 1: upload
  const drop = netDropZone('Drop your firewall / flow-log export here (CSV or TSV), or click to choose the file',
    (text, file, setText) => {
      clearAll();
      parseBox.innerHTML = '';
      let parsed;
      try { parsed = parseDelimited(text, { maxRows: NET_MAX_PARSE_ROWS }); }
      catch (e) { toast(`Could not parse “${file.name}”: ${e.message}`, 'err'); setText(null); return; }
      if (!parsed.headers.length || !parsed.rows.length) {
        parseBox.append(card(badge(`“${file.name}” has no data rows — is it a delimited export?`, 'err')));
        setText(null);
        return;
      }
      if (parsed.headers.length > 20) {
        parseBox.append(card(badge(`“${file.name}” has ${parsed.headers.length} columns — DR Compass reads at most 20. Trim the export to the columns that matter (source, destination, port, protocol, action, count).`, 'err')));
        setText(null);
        return;
      }
      st.headers = parsed.headers;
      st.rows = parsed.rows;
      st.fileName = file.name;
      setText(`${file.name} — parsed locally. Drop another file to start over.`);
      parseBox.append(card(
        h('h3', { style: 'margin-bottom:6px' }, 'Parsed on this machine'),
        h('div', { class: 'nf-stats' },
          badge(`${parsed.rows.length.toLocaleString()} rows`, 'accent'),
          badge(`${parsed.headers.length} columns`, 'accent'),
          badge(parsed.delimiter === '\t' ? 'tab-separated' : `delimiter “${parsed.delimiter}”`, ''),
          parsed.truncated ? badge(`only the first ${NET_MAX_PARSE_ROWS.toLocaleString()} rows were read`, 'warn') : null,
          parsed.synthesizedHeaders ? badge('no header row found — columns named col1…colN', 'warn') : null),
        h('p', { class: 'hint', style: 'margin-top:8px' },
          'The file itself never left this browser. The parsed cells go only to your local DR Compass server, which analyzes them in memory — nothing is stored until you press Apply.'),
      ));
      analyze(null);
    });

  el.append(
    panel(
      { id: 'disc-card-flows', 'data-focus': 'upload' },
      h('h2', null, 'Learn who calls what, from traffic you already log'),
      promiseLine('Drop in a Palo Alto traffic log, a VPC or security-group flow-log export, an istio egress report — any CSV or TSV with a source, a destination and a port. You get who-calls-whom, a guess at which component or Kubernetes workload each source is, and — only once you confirm each one — outbound calls written onto your inventory.',
        { nothingWritten: true, time: 'seconds, even for 100,000 rows' }),
      h('p', { class: 'hint', style: 'margin:10px 0 12px' },
        h('strong', null, 'The file never leaves this browser. '),
        'It is parsed here; only the parsed cells are posted to the DR Compass server running on this machine, which analyzes them in memory.'),
      drop.zone, drop.fileInput,
    ),
    parseBox,
    mappingBox,
    flowsBox,
    assignBox,
    resultBox,
    h('p', { class: 'hint', style: 'margin-top:14px' },
      'Tip: run this before you write a partner allowlist — the third-party rows are exactly the egress your recovery region has to reproduce.'),
  );
}

// ---------------------------------------------------------------- §14 page
// Views (deep links): #/<ws>/discover/<view>[/<focus>]
//   start   — the chooser (empty workspace) or what's next (populated)
//   aws     — focus: connection | scan | script | map | tag
//   k8s     — focus: snapshot | capture | k8s-script
//   network — focus: upload
//   arpio   — focus: import
//   ai      — focus: ask | suggest
// Unknown view -> start; unknown focus is ignored. The five original tab ids
// are unchanged, so every existing bookmark still resolves.

const VIEWS = [
  { id: 'start', label: 'Start here', render: renderStart },
  { id: 'aws', label: 'AWS account', render: renderAws },
  { id: 'k8s', label: 'Kubernetes', render: renderK8s },
  { id: 'network', label: 'Network flows', render: renderNetwork },
  { id: 'arpio', label: 'Arpio', render: renderArpio },
  { id: 'ai', label: 'Ask AI', render: renderAi },
];

// Scroll a card into view and open its disclosures, so "→ Find resources by
// tag" lands on the thing it named rather than the top of a long tab.
function focusCard(root, focus) {
  if (!focus) return;
  const target = root.querySelector(`[data-focus="${focus}"]`);
  if (!target) return;
  for (const d of target.querySelectorAll('details.adv')) d.open = true;
  try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  catch { /* jsdom-less shims and old browsers: position is not essential */ }
}

export default {
  title: 'Discover',
  async render(el, ctx) {
    await ensureGlossary(); // pick up ui.js's term() helper if it has shipped
    const { ws } = ctx;
    const body = h('div');
    const stripHost = h('div', { id: 'disc-status' });
    // Every other page ends with the shared next-step band; so does this one.
    const footHost = h('div');

    // Shared navigation + state handed to every view: one snapshot of "what
    // has been discovered", one way to move between views, one way to refresh.
    const nav = {
      state: null,
      view: 'start',
      async goTab(id, focus) {
        await activate(VIEWS.some((v) => v.id === id) ? id : 'start', focus);
      },
      async refresh() {
        await loadState({ force: true });
        renderStrip();
        if (nav.view === 'start') await activate('start'); // the list itself is derived from state
      },
    };

    // One snapshot costs four small GETs (the graph one asks for counts only),
    // and tab-hopping reuses it for a few seconds anyway. Explicit refreshes,
    // and anything that just changed the workspace, always reload.
    const STATE_TTL_MS = 5000;
    const loadState = async ({ force = false } = {}) => {
      if (!force && nav.state && Date.now() - (nav.state.loadedAt || 0) < STATE_TTL_MS) return;
      try { nav.state = await loadDiscoveryState(ctx); }
      catch {
        nav.state = nav.state || {
          componentCount: 0, awsComponentCount: 0, components: [], loadedAt: Date.now(),
          graph: { resources: 0, edges: 0, unlinked: 0 }, k8s: { present: false, unlinkedWorkloads: 0 },
          jobs: { byKind: {} }, flows: { calls: 0 },
        };
      }
    };
    const renderStrip = () => {
      stripHost.innerHTML = '';
      // An empty workspace has nothing to report — the chooser carries the page.
      if (nav.state && !isEmptyWorkspace(nav.state)) stripHost.append(statusStrip(ctx, nav.state, nav));
    };

    const activate = async (id, focus) => {
      nav.view = id;
      tabEls.forEach((te) => te.classList.toggle('active', te.dataset.tab === id));
      const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
      body.innerHTML = '';
      await v.render(body, ctx, nav);
      focusCard(body, focus);
      // Keep the strip honest after a view that may have changed things, but
      // never block the render on it.
      loadState().then(renderStrip);
    };

    const tabEls = VIEWS.map((v) =>
      h('span', { class: 'tab', 'data-tab': v.id, 'data-label': v.label, onClick: () => activate(v.id) }, v.label));
    currentTabEls = tabEls;
    refreshTabBadges(); // running jobs already known this session badge instantly

    el.append(
      h('style', null, STYLE),
      pageHead({
        title: 'Discover',
        purpose: 'Import what your DR plan has to cover from AWS, Kubernetes, Arpio or your firewall logs — read-only, and nothing lands until you review it.',
        crumb: crumbFor('discover', ws),
      }),
      stripHost,
      h('div', { class: 'tabs' }, tabEls),
      body,
      footHost,
    );

    await loadState();
    renderStrip();
    const asked = ctx.params?.[0];
    await activate(asked && VIEWS.some((v) => v.id === asked) ? asked : 'start', ctx.params?.[1]);

    // The chooser view offers a choice, not an imperative, so the band carries
    // the one primary action there. Every other view has its own (Scan, Connect,
    // Ask …) and must not have to compete with this band.
    const snap = await snapshot(ctx.api, ws).catch(() => ({}));
    const band = nextStepFor('discover', snap, ws);
    if (nav.view === 'start') band.querySelector('.nextstep-acts .btn')?.classList.add('btn-primary');
    footHost.append(band);
  },
};
