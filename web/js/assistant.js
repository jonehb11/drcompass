// AI copilot — a page-independent right-side drawer. The user types an
// instruction, the local Claude Code CLI proposes concrete data operations,
// the user reviews and applies a selected subset. Conversation is
// session-local (in-memory only).
import { api } from './api.js';
import { h, badge, toast } from './ui.js';
import { operationsBlock, resolveOpNames, aiAvailable, resetAiAvailable } from './ai-actions.js';

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
      // The review-before-apply UI lives in ai-actions.js — one implementation,
      // shared with every contextual AI button on the pages.
      const names = await resolveOpNames(state.ws, api, res.operations || []);
      addTurn('ai', operationsBlock({ ws: state.ws, api, result: res, names, afterRender: scrollConv }));
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

  // One shared, cached CLI probe for the whole app (ai-actions.js owns it).
  if (!state.status) state.status = { claudeCliFound: await aiAvailable(api) };
  const found = !!state.status.claudeCliFound;
  els.dot.className = `ai-dot ${found ? 'ok' : 'err'}`;
  els.dot.title = found ? 'Claude Code CLI found' : 'Claude Code CLI not found';
  const usable = found && !!state.ws;
  els.ta.disabled = !usable || state.busy;
  els.send.disabled = !usable || state.busy;
  if (!found) {
    els.hint.replaceChildren(
      h('div', null, 'Claude Code CLI not found on PATH — the copilot runs entirely through your local ', h('code', null, 'claude'), '.'),
      h('pre', { class: 'mono', style: 'margin-top:6px' }, 'npm install -g @anthropic-ai/claude-code\nclaude   # sign in once'),
      h('button', {
        class: 'btn btn-sm', style: 'margin-top:8px',
        onClick: async () => { resetAiAvailable(); state.status = null; await refreshContext(); },
      }, 'Check again'));
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
