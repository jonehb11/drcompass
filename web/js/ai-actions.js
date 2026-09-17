// Contextual AI — the shared primitive every page uses to put AI work next to
// the object the user is actually looking at.
//
// Two modes, one rule: nothing is ever written without an explicit click.
//   mode 'answer'     → POST /w/:ws/ai/answer      → markdown in a review modal
//   mode 'operations' → POST /w/:ws/ai/draft       → per-operation checkboxes,
//                                                    applied via /w/:ws/ai/apply
//   mode 'review'     → POST /w/:ws/ai/review      → findings + markdown
//   mode 'narrative'  → POST /w/:ws/ai/narrative   → markdown document
//
// The operations review UI here is the ONE implementation — the Cmd+K copilot
// drawer (assistant.js) imports it too.
import { api as defaultApi } from './api.js';
import { h, badge, toast, markdown, modal } from './ui.js';

// ---------------------------------------------------------------- styling
// Scoped, idempotent: app.css is shared with other agents, so the few classes
// this module needs live here.
const STYLE = `
.ai-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ai-actions-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); font-weight: 700; margin-right: 2px; }
.ai-actions-hint { font-size: 11.5px; color: var(--muted); flex-basis: 100%; margin-top: -1px; }
button.ai-btn { display: inline-flex; align-items: center; gap: 6px; }
button.ai-btn .ai-glyph { color: var(--accent); font-size: 11px; line-height: 1; }
button.ai-btn[disabled] { opacity: .5; cursor: not-allowed; }
button.ai-btn:not([disabled]):hover { border-color: var(--accent); background: var(--accent-soft); }
button.ai-btn.busy { color: var(--muted); }
.ai-md-scroll { max-height: 60vh; overflow-y: auto; }
.ai-ctx-note { font-size: 11.5px; color: var(--muted); margin-top: 12px;
  border-top: 1px solid var(--border); padding-top: 8px; }
.ai-findings { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.ai-finding { border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px;
  padding: 8px 11px; background: var(--panel2); }
.ai-finding.blocker { border-left-color: var(--err); }
.ai-finding.high { border-left-color: var(--warn); }
.ai-finding.medium, .ai-finding.low { border-left-color: var(--accent); }
.ai-finding.info { border-left-color: var(--border); }
.ai-finding-head { display: flex; align-items: center; gap: 8px; }
.ai-finding-title { font-weight: 650; font-size: 13px; }
.ai-finding-detail { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
.ai-unavailable { font-size: 12.5px; color: var(--muted); }
.ai-unavailable pre { margin-top: 8px; }
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('ai-actions-style')) return;
  const el = h('style', { id: 'ai-actions-style' }, STYLE);
  (document.head || document.body || document.documentElement)?.append(el);
}
ensureStyle();

// ---------------------------------------------------------------- availability

export const INSTALL_HINT =
  'The local Claude Code CLI was not found on PATH. Contextual AI runs entirely through your own '
  + 'claude CLI — nothing leaves this machine except through it.';
export const INSTALL_STEPS = 'npm install -g @anthropic-ai/claude-code\nclaude   # sign in once';

let availPromise = null;
let availValue = null; // null = not resolved yet

/** Resolve (and cache) whether the local claude CLI is usable. */
export function aiAvailable(apiImpl) {
  if (availValue !== null) return Promise.resolve(availValue);
  if (!availPromise) {
    const a = apiImpl || defaultApi;
    availPromise = a.get('/ai/status')
      .then((s) => { availValue = !!(s && s.claudeCliFound); return availValue; })
      .catch(() => { availValue = false; return false; });
  }
  return availPromise;
}

/** Forget the cached answer (e.g. the user just installed the CLI). */
export function resetAiAvailable() { availValue = null; availPromise = null; }

/**
 * Lazily-resolved, cached availability flag.
 *   await AI_AVAILABLE      -> boolean
 *   AI_AVAILABLE.value      -> boolean | null (null until resolved)
 */
export const AI_AVAILABLE = {
  get value() { return availValue; },
  get resolved() { return availValue !== null; },
  then(onOk, onErr) { return aiAvailable().then(onOk, onErr); },
  refresh() { resetAiAvailable(); return aiAvailable(); },
};

// ---------------------------------------------------------------- calls

const val = (v, ...args) => (typeof v === 'function' ? v(...args) : v);

function normalizeContext(context) {
  const c = val(context);
  if (!c) return null;
  if (typeof c === 'string') return { kind: c };
  const out = { kind: String(c.kind || 'workspace') };
  if (c.id) out.id = String(c.id);
  if (c.extra && typeof c.extra === 'object') out.extra = c.extra;
  return out;
}

/** Focused question → {ok, answer} (or {ok:false, message}). */
export async function aiAsk({ ws, api = defaultApi, prompt, context } = {}) {
  if (!ws) return { ok: false, message: 'No workspace open.' };
  try {
    return await api.post(`/w/${ws}/ai/answer`, { prompt: String(prompt || ''), context: normalizeContext(context) });
  } catch (e) { return { ok: false, message: e.message }; }
}

/** Focused instruction → {ok, summary, operations, notes}. Applies nothing. */
export async function aiOperations({ ws, api = defaultApi, instruction, prompt, context, kind } = {}) {
  if (!ws) return { ok: false, message: 'No workspace open.' };
  try {
    return await api.post(`/w/${ws}/ai/draft`, {
      instruction: String(instruction || prompt || ''),
      kind: kind || (normalizeContext(context) || {}).kind || '',
      context: normalizeContext(context),
    });
  } catch (e) { return { ok: false, message: e.message }; }
}

/** Critique → {ok, markdown, findings:[{severity,title,detail}]}. */
export async function aiReview({ ws, api = defaultApi, kind, id } = {}) {
  if (!ws) return { ok: false, message: 'No workspace open.' };
  try { return await api.post(`/w/${ws}/ai/review`, { kind, id: id || '' }); }
  catch (e) { return { ok: false, message: e.message }; }
}

/** Prose document → {ok, kind, title, markdown}. */
export async function aiNarrative({ ws, api = defaultApi, kind } = {}) {
  if (!ws) return { ok: false, message: 'No workspace open.' };
  try { return await api.post(`/w/${ws}/ai/narrative`, { kind }); }
  catch (e) { return { ok: false, message: e.message }; }
}

/** Apply an approved subset of operations → {applied, errors}. */
export function aiApply({ ws, api = defaultApi, operations } = {}) {
  return api.post(`/w/${ws}/ai/apply`, { operations });
}

// ---------------------------------------------------------------- ops review UI

const OP_BADGE = { create: 'ok', update: 'accent', delete: 'err', 'update-workspace': 'purple' };

function opTitle(op, names) {
  if (op.op === 'update-workspace') return 'workspace settings';
  const resolved = op.op === 'create'
    ? (op.data?.name || op.data?.title || '(unnamed)')
    : (names?.[op.collection]?.[op.id] || op.id || '(no id)');
  return `${op.collection} · ${resolved}`;
}

function fieldValue(v) {
  if (v === null || v === undefined) return String(v);
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 240 ? s.slice(0, 237) + '…' : s;
}

function dataDetails(op) {
  const entries = Object.entries(op.data || {});
  if (!entries.length) return null;
  return h('details', { class: 'ai-op-data' },
    h('summary', null, op.op === 'update' ? `changed fields (${entries.length})` : `fields (${entries.length})`),
    h('div', { class: 'ai-op-fields' },
      entries.map(([k, v]) => h('div', { class: 'ai-op-field' },
        h('span', { class: 'ai-op-key' }, k), h('span', { class: 'ai-op-val mono' }, fieldValue(v))))));
}

/** Resolve display names for update/delete targets from the live collections. */
export async function resolveOpNames(ws, api, ops) {
  const names = {};
  const cols = [...new Set((ops || [])
    .filter((o) => (o.op === 'update' || o.op === 'delete') && o.collection)
    .map((o) => o.collection))];
  await Promise.all(cols.map(async (col) => {
    try {
      const { items } = await (api || defaultApi).get(`/w/${ws}/c/${col}`);
      names[col] = Object.fromEntries((items || []).map((it) => [it.id, it.name || it.title || it.id]));
    } catch { names[col] = {}; }
  }));
  return names;
}

/**
 * The review-before-apply block: one checkbox per proposed operation, an Apply
 * button that posts ONLY the checked ones, and a Dismiss that writes nothing.
 * Shared by the page buttons and the Cmd+K copilot drawer.
 *
 * @param {object} o
 * @param {string} o.ws            workspace slug
 * @param {object} [o.api]         api impl (defaults to the app's)
 * @param {object} o.result        {summary, operations, notes} from draft/propose
 * @param {object} [o.names]       {collection: {id: label}} for update/delete
 * @param {function} [o.onApplied] called with {applied, errors} after a successful
 *                                 apply. When given, the hashchange page refresh
 *                                 is skipped — the caller owns refreshing.
 * @param {function} [o.onApply]   override the apply call entirely; receives the
 *                                 selected operations, may return {applied,errors}.
 * @param {function} [o.afterRender] called after each state change (scroll hook)
 */
export function operationsBlock({ ws, api = defaultApi, result, names, onApplied, onApply, afterRender } = {}) {
  const res = result || {};
  const ops = res.operations || [];
  const wrap = h('div');
  const bump = () => { try { afterRender?.(); } catch { /* cosmetic */ } };
  if (res.summary) wrap.append(h('div', { class: 'ai-summary' }, res.summary));

  const checks = [];
  const applyBtn = h('button', { class: 'btn btn-primary btn-sm' }, 'Apply 0 selected');
  const refresh = () => {
    const n = checks.filter((c) => c && c.checked).length;
    applyBtn.textContent = `Apply ${n} selected`;
    applyBtn.disabled = n === 0;
  };

  const cards = ops.map((op, i) => {
    const invalid = op.valid === false;
    const cb = invalid ? null : h('input', { type: 'checkbox', checked: true, class: 'ai-op-check', onChange: refresh });
    checks[i] = cb;
    return h('div', { class: `ai-op ${invalid ? 'invalid' : ''}` },
      h('div', { class: 'ai-op-head' },
        cb || h('input', { type: 'checkbox', disabled: true, class: 'ai-op-check' }),
        badge(op.op, OP_BADGE[op.op] || ''),
        h('span', { class: 'ai-op-title' }, opTitle(op, names))),
      op.why ? h('div', { class: 'ai-op-why' }, op.why) : null,
      invalid ? h('div', { class: 'ai-op-problem' }, `⚠ ${op.problem || 'invalid operation'}`) : null,
      dataDetails(op));
  });

  const actions = h('div', { class: 'ai-op-actions' });
  const dismissBtn = h('button', {
    class: 'btn btn-ghost btn-sm',
    onClick: () => { actions.replaceChildren(h('span', { class: 'hint' }, 'Dismissed — nothing applied.')); bump(); },
  }, 'Dismiss');

  applyBtn.addEventListener('click', async () => {
    const selected = ops.filter((_, i) => checks[i] && checks[i].checked)
      .map(({ valid, problem, ...op }) => op);
    if (!selected.length) return;
    applyBtn.disabled = true;
    dismissBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      const out = (onApply ? await onApply(selected) : await aiApply({ ws, api, operations: selected })) || {};
      const okLines = (out.applied || []).map((a) =>
        h('div', { class: 'ai-applied-line' }, badge(a.op, OP_BADGE[a.op] || ''), ` ${a.collection} · ${a.name}`));
      const errLines = (out.errors || []).map((e) => h('div', { class: 'ai-op-problem' }, `⚠ ${e}`));
      actions.replaceChildren(
        h('div', { class: 'ai-applied' },
          h('div', { class: 'ai-applied-head' }, `Applied ${out.applied?.length ?? selected.length} change(s)`),
          okLines, errLines));
      toast(`AI applied ${out.applied?.length ?? selected.length} change(s)`, (out.errors?.length ? '' : 'ok'));
      if (onApplied) await onApplied(out);
      else if (typeof window !== 'undefined' && typeof HashChangeEvent === 'function') {
        window.dispatchEvent(new HashChangeEvent('hashchange')); // re-render the page with fresh data
      }
    } catch (e) {
      toast(e.message, 'err');
      applyBtn.disabled = false;
      dismissBtn.disabled = false;
      refresh();
    }
    bump();
  });

  if (ops.length) {
    refresh();
    actions.append(applyBtn, dismissBtn);
    wrap.append(h('div', { class: 'ai-ops' }, cards), actions);
  } else {
    wrap.append(h('div', { class: 'hint' }, 'No data changes proposed.'));
  }
  if (res.notes) wrap.append(h('div', { class: 'ai-notes' }, markdown(res.notes)));
  return wrap;
}

// ---------------------------------------------------------------- result modal

function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) { navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = h('textarea', { value: text, style: 'position:fixed;left:-9999px;top:0' });
    document.body.append(ta);
    ta.select?.();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

function findingsBlock(findings) {
  if (!Array.isArray(findings) || !findings.length) return null;
  const SEV = { blocker: 'err', high: 'warn', medium: 'accent', low: '', info: '' };
  return h('div', { class: 'ai-findings' }, findings.map((f) =>
    h('div', { class: `ai-finding ${f.severity || 'medium'}` },
      h('div', { class: 'ai-finding-head' },
        badge(f.severity || 'medium', SEV[f.severity] ?? ''),
        h('span', { class: 'ai-finding-title' }, f.title || '(untitled finding)')),
      f.detail ? h('div', { class: 'ai-finding-detail' }, f.detail) : null)));
}

function contextNote(res) {
  const c = res && res.context;
  if (!c || !c.kind) return null;
  return h('div', { class: 'ai-ctx-note' },
    `Context sent: ${c.kind}${c.id ? ` ${c.id}` : ''} · ${Math.round((c.bytes || 0) / 1024)}KB`
    + (c.truncated ? ' (truncated to fit)' : '') + ' · ran on your local claude CLI.');
}

/**
 * Review UI for an AI result. Reuses ui.modal, so Cancel closes it and nothing
 * is written unless the user clicks Apply inside the operations block.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.answer]     markdown prose (answer/review/narrative modes)
 * @param {Array}  [o.operations] validated operations (operations mode)
 * @param {function} [o.onApply]  override the apply call
 */
export function aiResultModal({
  title = 'AI', answer, operations, summary, notes, findings, result,
  ws, api = defaultApi, names, onApply, onApplied,
} = {}) {
  const body = h('div');
  const actions = [];
  const hasOps = Array.isArray(operations);

  if (hasOps) {
    body.append(operationsBlock({
      ws, api, names, onApply, onApplied,
      result: { summary, notes, operations },
    }));
  } else {
    const fb = findingsBlock(findings);
    if (fb) body.append(fb);
    const text = String(answer || '');
    body.append(h('div', { class: 'ai-md-scroll' },
      text.trim() ? markdown(text) : h('div', { class: 'hint' }, 'The AI returned an empty answer.')));
    if (text.trim()) {
      actions.push({
        label: 'Copy',
        onClick: () => {
          const ok = copyText(text);
          toast(ok ? 'Copied to clipboard' : 'Could not copy — select the text instead', ok ? 'ok' : 'err');
        },
      });
    }
  }
  if (result) { const n = contextNote(result); if (n) body.append(n); }
  return modal(title, body, { wide: true, actions });
}

/** Error/CLI-missing modal — never leaves the user guessing. */
function aiErrorModal(title, res) {
  const msg = (res && (res.message || res.error)) || 'The AI request failed.';
  const body = h('div', null,
    h('div', null, badge(msg, 'warn')),
    res && res.raw
      ? h('details', { class: 'ai-op-data', style: 'margin-top:10px' },
        h('summary', null, 'raw answer'), h('pre', { class: 'mono' }, res.raw))
      : null,
    /not found on PATH/i.test(msg)
      ? h('div', { class: 'ai-unavailable', style: 'margin-top:10px' },
        INSTALL_HINT, h('pre', { class: 'mono' }, INSTALL_STEPS))
      : null);
  return modal(title, body, { actions: [] });
}

// ---------------------------------------------------------------- buttons

async function askForInput(spec) {
  const inp = spec.multiline
    ? h('textarea', { style: 'min-height:80px', placeholder: spec.placeholder || '' }, spec.value || '')
    : h('input', { value: spec.value || '', placeholder: spec.placeholder || '' });
  const ok = await modal(spec.title || 'What should the AI work on?',
    h('div', null,
      spec.hint ? h('p', { class: 'hint', style: 'margin-bottom:8px' }, spec.hint) : null,
      h('label', { class: 'field' }, h('span', null, spec.label || 'Details'), inp)),
    { actions: [{ label: spec.action || 'Continue', kind: 'btn-primary', value: true }] });
  if (!ok) return null;
  const v = String(inp.value || '').trim();
  if (!v && spec.required !== false) { toast('Nothing entered — cancelled', 'err'); return null; }
  return v;
}

/**
 * A small contextual AI button. Clicking it runs one AI call with a spinner,
 * then opens the review modal. Nothing is ever applied without a second click.
 *
 * @param {object} o
 * @param {string}   o.ws                       workspace slug
 * @param {object}   [o.api]                    api impl (ctx.api)
 * @param {string}   o.label                    button text
 * @param {string}   [o.title]                  tooltip
 * @param {object|function} [o.context]         {kind, id?, extra?} selector, or a
 *                                              function returning one (evaluated
 *                                              at click time — use it to capture
 *                                              live form state)
 * @param {string|function} [o.prompt]          question (answer) / instruction
 *                                              (operations). `{{input}}` is
 *                                              replaced by the collected input.
 * @param {string|function} [o.instruction]     alias for prompt
 * @param {'answer'|'operations'|'review'|'narrative'} [o.mode='answer']
 * @param {object}   [o.input]                  {label, placeholder, hint, multiline,
 *                                              title} — ask the user for free text first
 * @param {string}   [o.reviewKind] [o.reviewId] for mode 'review'
 * @param {string}   [o.narrativeKind]          for mode 'narrative'
 * @param {string}   [o.modalTitle]
 * @param {function} [o.onApplied]              after ops are applied
 * @param {function} [o.onResult]               (res) => void, raw result hook
 * @param {'sm'|'md'} [o.size='sm']
 * @returns {HTMLButtonElement}
 */
export function aiButton(o = {}) {
  const {
    ws, api = defaultApi, label = 'Ask AI', title, context, prompt, instruction,
    mode = 'answer', input, reviewKind, reviewId, narrativeKind,
    modalTitle, onApplied, onResult, size = 'sm', glyph = '✦',
  } = o;

  const labelSpan = h('span', null, label);
  const btn = h('button', {
    class: `btn ${size === 'sm' ? 'btn-sm ' : ''}ai-btn`,
    title: title || label,
    type: 'button',
  }, h('span', { class: 'ai-glyph' }, glyph), labelSpan);

  const disable = (why) => { btn.disabled = true; btn.title = why; };

  // Optimistic: render enabled, then disable if the CLI turns out to be absent.
  aiAvailable(api).then((ok) => {
    if (!ok) disable(`${INSTALL_HINT}\n\n${INSTALL_STEPS}`);
  });

  let busy = false;
  btn.addEventListener('click', async () => {
    if (busy || btn.disabled) return;
    if (!ws) { toast('Open a workspace first', 'err'); return; }
    if (!(await aiAvailable(api))) { disable(`${INSTALL_HINT}\n\n${INSTALL_STEPS}`); return; }

    let extraInput = '';
    if (input) {
      extraInput = await askForInput(input);
      if (extraInput === null) return;
    }

    const raw = String(val(instruction ?? prompt) || '');
    const text = extraInput ? (raw.includes('{{input}}') ? raw.replace(/\{\{input\}\}/g, extraInput) : `${raw}\n\n${input.prefix || 'The user asks for:'} ${extraInput}`) : raw;
    const sel = normalizeContext(context);

    busy = true;
    btn.disabled = true;
    btn.classList.add('busy');
    const prevLabel = labelSpan.textContent;
    labelSpan.textContent = 'Thinking…';
    const dots = h('span', { class: 'ai-think-dots' }, h('i'), h('i'), h('i'));
    btn.append(dots);

    let res;
    try {
      if (mode === 'operations') res = await aiOperations({ ws, api, instruction: text, context: sel });
      else if (mode === 'review') res = await aiReview({ ws, api, kind: reviewKind || (sel && sel.kind) || 'workspace', id: reviewId || (sel && sel.id) || '' });
      else if (mode === 'narrative') res = await aiNarrative({ ws, api, kind: narrativeKind });
      else res = await aiAsk({ ws, api, prompt: text, context: sel });
    } catch (e) {
      res = { ok: false, message: e.message };
    } finally {
      busy = false;
      dots.remove();
      labelSpan.textContent = prevLabel;
      btn.classList.remove('busy');
      btn.disabled = false;
    }

    try { onResult?.(res); } catch { /* caller's problem, not the user's */ }

    const heading = modalTitle || label;
    if (!res || !res.ok) { await aiErrorModal(heading, res); return; }

    if (mode === 'operations') {
      const names = await resolveOpNames(ws, api, res.operations || []);
      await aiResultModal({
        title: heading, ws, api, names, onApplied, result: res,
        operations: res.operations || [], summary: res.summary, notes: res.notes,
      });
    } else {
      await aiResultModal({
        title: heading, ws, api, result: res,
        answer: res.markdown || res.answer || '',
        findings: res.findings,
      });
    }
  });

  return btn;
}

/**
 * A row of small AI buttons. `actions` are aiButton option objects; ws/api and
 * onApplied are inherited when an action omits them.
 */
export function aiActionRow({ ws, api = defaultApi, actions = [], label = 'AI', hint, onApplied, style } = {}) {
  const row = h('div', { class: 'ai-actions', style: style || null });
  if (label) row.append(h('span', { class: 'ai-actions-label' }, label));
  for (const a of actions) {
    if (!a) continue;
    row.append(aiButton({ ws, api, onApplied, ...a }));
  }
  if (hint) row.append(h('span', { class: 'ai-actions-hint' }, hint));
  return row;
}

export default { aiButton, aiActionRow, aiAsk, aiOperations, aiReview, aiNarrative, aiResultModal, operationsBlock, AI_AVAILABLE };
