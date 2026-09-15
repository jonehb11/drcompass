// AI copilot — a page-independent right-side drawer. The user types an
// instruction, the local Claude Code CLI proposes concrete data operations,
// the user reviews and applies a selected subset. Conversation is
// session-local (in-memory only).
import { api } from './api.js';
import { h, badge, toast, markdown } from './ui.js';

const OP_BADGE = { create: 'ok', update: 'accent', delete: 'err', 'update-workspace': 'purple' };
const STARTERS = [
  'Add a component: ',
  'Find inventory gaps and record the worst ones as gap items',
  'Draft a game-day checklist for next month',
  'Set verification commands for all L3 components',
];

const state = {
  open: false,
  ws: null,          // current workspace slug (from the hash)
  wsName: '',
  page: 'dashboard',
  status: null,      // {claudeCliFound} once fetched
  busy: false,
  hasTurns: false,
};
const els = {}; // launcher, drawer, conv, ta, send, dot, wsLabel, hint, chips

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { ws: parts[0] || null, page: parts[1] || 'dashboard' };
}

// ---------------------------------------------------------------- rendering

function scrollConv() {
  els.conv.scrollTop = els.conv.scrollHeight;
}

function addTurn(cls, ...children) {
  const t = h('div', { class: `ai-turn ${cls}` }, ...children);
  els.conv.append(t);
  state.hasTurns = true;
  if (els.chips) els.chips.style.display = 'none';
  scrollConv();
  return t;
}

function opTitle(op, names) {
  if (op.op === 'update-workspace') return 'workspace settings';
  const resolved = op.op === 'create'
    ? (op.data?.name || op.data?.title || '(unnamed)')
    : (names?.[op.collection]?.[op.id] || op.id || '(no id)');
  return `${op.collection} · ${resolved}`;
}

function fieldValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 237) + '…' : s;
  }
  const s = String(v);
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

// Resolve display names for update/delete targets from the live collections.
async function resolveNames(ops) {
  const names = {};
  const cols = [...new Set(ops.filter((o) => (o.op === 'update' || o.op === 'delete') && o.collection).map((o) => o.collection))];
  await Promise.all(cols.map(async (col) => {
    try {
      const { items } = await api.get(`/w/${state.ws}/c/${col}`);
      names[col] = Object.fromEntries((items || []).map((it) => [it.id, it.name || it.title || it.id]));
    } catch { names[col] = {}; }
  }));
  return names;
}

function renderProposal(res, names) {
  const ops = res.operations || [];
  const wrap = h('div');
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
    const cb = invalid
      ? null
      : h('input', { type: 'checkbox', checked: true, class: 'ai-op-check', onChange: refresh });
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
    onClick: () => { actions.replaceChildren(h('span', { class: 'hint' }, 'Dismissed — nothing applied.')); },
  }, 'Dismiss');

  applyBtn.addEventListener('click', async () => {
    const selected = ops.filter((_, i) => checks[i] && checks[i].checked)
      .map(({ valid, problem, ...op }) => op);
    if (!selected.length) return;
    applyBtn.disabled = true;
    dismissBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      const out = await api.post(`/w/${state.ws}/ai/apply`, { operations: selected });
      const okLines = (out.applied || []).map((a) =>
        h('div', { class: 'ai-applied-line' }, badge(a.op, OP_BADGE[a.op] || ''), ` ${a.collection} · ${a.name}`));
      const errLines = (out.errors || []).map((e) => h('div', { class: 'ai-op-problem' }, `⚠ ${e}`));
      actions.replaceChildren(
        h('div', { class: 'ai-applied' },
          h('div', { class: 'ai-applied-head' }, `Applied ${out.applied?.length || 0} change(s)`),
          okLines, errLines));
      toast(`AI copilot applied ${out.applied?.length || 0} change(s)`, (out.errors?.length ? '' : 'ok'));
      // Re-render the current page with fresh data.
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) {
      toast(e.message, 'err');
      applyBtn.disabled = false;
      dismissBtn.disabled = false;
      refresh();
    }
    scrollConv();
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

// ---------------------------------------------------------------- sending

async function send(text) {
  const instruction = String(text || '').trim();
  if (!instruction || state.busy) return;
  if (!state.ws) { toast('Create or open a workspace first', 'err'); return; }
  if (!state.status?.claudeCliFound) return;

  state.busy = true;
  els.ta.value = '';
  els.ta.disabled = true;
  els.send.disabled = true;
  addTurn('user', instruction);
  const thinking = addTurn('ai thinking',
    h('span', { class: 'ai-think-dots' }, h('i'), h('i'), h('i')),
    h('span', null, ' Thinking — your local claude CLI is working; this can take up to ~3 minutes.'));

  try {
    const res = await api.post(`/w/${state.ws}/ai/propose`, { instruction, page: state.page });
    thinking.remove();
    if (!res.ok) {
      addTurn('ai',
        h('div', null, badge(res.message || 'The AI request failed', 'warn')),
        res.raw ? h('details', { class: 'ai-op-data', style: 'margin-top:8px' },
          h('summary', null, 'raw answer'), h('pre', { class: 'mono' }, res.raw)) : null);
    } else {
      const names = await resolveNames(res.operations || []);
      addTurn('ai', renderProposal(res, names));
    }
  } catch (e) {
    thinking.remove();
    addTurn('ai', badge(e.message, 'err'));
  } finally {
    state.busy = false;
    els.ta.disabled = !state.status?.claudeCliFound;
    els.send.disabled = !state.status?.claudeCliFound;
    if (!els.ta.disabled) els.ta.focus();
    scrollConv();
  }
}

// ---------------------------------------------------------------- header/status

async function refreshContext() {
  const { ws, page } = parseHash();
  state.page = page;
  if (ws !== state.ws) {
    state.ws = ws;
    state.wsName = '';
    // New workspace → fresh conversation (ids/names would be stale).
    els.conv.replaceChildren(els.chips);
    els.chips.style.display = '';
    state.hasTurns = false;
  }
  els.wsLabel.textContent = state.ws ? '…' : 'no workspace';
  if (state.ws) {
    try {
      const meta = await api.get(`/w/${state.ws}/workspace`);
      state.wsName = meta.name || state.ws;
    } catch { state.wsName = state.ws; }
    els.wsLabel.textContent = state.wsName;
  }

  if (!state.status) {
    try { state.status = await api.get('/ai/status'); }
    catch { state.status = { claudeCliFound: false }; }
  }
  const found = !!state.status.claudeCliFound;
  els.dot.className = `ai-dot ${found ? 'ok' : 'err'}`;
  els.dot.title = found ? 'Claude Code CLI found' : 'Claude Code CLI not found';
  const usable = found && !!state.ws;
  els.ta.disabled = !usable || state.busy;
  els.send.disabled = !usable || state.busy;
  if (!found) {
    els.hint.replaceChildren(
      h('div', null, 'Claude Code CLI not found on PATH — the copilot runs entirely through your local ', h('code', null, 'claude'), '.'),
      h('pre', { class: 'mono', style: 'margin-top:6px' }, 'npm install -g @anthropic-ai/claude-code\nclaude   # sign in once'));
    els.hint.style.display = '';
  } else if (!state.ws) {
    els.hint.textContent = 'No workspace yet — create one with the ＋ button in the sidebar, then come back.';
    els.hint.style.display = '';
  } else {
    els.hint.style.display = 'none';
  }
}

// ---------------------------------------------------------------- open/close

function setOpen(open) {
  state.open = open;
  els.drawer.classList.toggle('open', open);
  els.launcher.style.display = open ? 'none' : '';
  if (open) {
    refreshContext().then(() => { if (!els.ta.disabled) els.ta.focus(); });
  }
}

// ---------------------------------------------------------------- init

export function initAssistant() {
  if (els.drawer) return; // once

  els.launcher = h('button', { class: 'ai-launcher', title: 'AI copilot (⌘K / Ctrl+K)', onClick: () => setOpen(true) }, '✦');

  els.dot = h('span', { class: 'ai-dot' });
  els.wsLabel = h('span', { class: 'ai-ws' }, '…');
  els.hint = h('div', { class: 'ai-hint', style: 'display:none' });

  els.chips = h('div', { class: 'ai-chips' },
    h('div', { class: 'ai-chips-intro' },
      'Tell the copilot what to change — it proposes concrete edits to this workspace and nothing is written until you apply them.'),
    STARTERS.map((s) => h('span', {
      class: 'prompt-chip',
      onClick: () => { els.ta.value = s; els.ta.focus(); els.ta.setSelectionRange(s.length, s.length); },
    }, s.trim().replace(/:$/, '…'))));

  els.conv = h('div', { class: 'ai-conv' }, els.chips);

  els.ta = h('textarea', {
    class: 'ai-ta', rows: 3,
    placeholder: 'e.g. add a DynamoDB sessions table depending on the checkout service…',
    onKeydown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(els.ta.value); } },
  });
  els.send = h('button', { class: 'btn btn-primary btn-sm', onClick: () => send(els.ta.value) }, 'Send');

  els.drawer = h('aside', { class: 'ai-drawer', role: 'dialog', 'aria-label': 'AI copilot' },
    h('div', { class: 'ai-head' },
      els.dot,
      h('div', { class: 'ai-head-titles' }, h('strong', null, 'AI copilot'), els.wsLabel),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost btn-sm', title: 'Close (Esc)', onClick: () => setOpen(false) }, '✕')),
    els.hint,
    els.conv,
    h('div', { class: 'ai-inputrow' },
      els.ta,
      h('div', { class: 'ai-sendrow' },
        h('span', { class: 'hint' }, '⌘/Ctrl+Enter to send · runs your local claude CLI, up to ~3 min'),
        h('span', { class: 'spacer' }),
        els.send)));

  document.body.append(els.launcher, els.drawer);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(!state.open); }
    else if (e.key === 'Escape' && state.open) setOpen(false);
  });
  // While closed, do nothing — refreshContext() on next open detects a
  // workspace change and resets the conversation then.
  window.addEventListener('hashchange', () => { if (state.open) refreshContext(); });
  state.ws = parseHash().ws;
  state.page = parseHash().page;
}
