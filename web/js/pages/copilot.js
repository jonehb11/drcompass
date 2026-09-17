// AI console — the open copilot.  #/:ws/copilot
//
// Every other AI surface in this product is contextual-but-narrow: a button, a
// fixed prompt, one object. This page is the other half. The user types
// anything; the AI can answer it, propose changes to the workspace, or both,
// and the conversation carries so a follow-up knows what came before.
//
// Three things do not move, no matter what the user asks for:
//   1. NOTHING is written without an explicit Apply. This page renders the same
//      review block as every other AI surface (ai-actions.js), so there is one
//      implementation of "review before apply" in the app, not two.
//   2. The honest-numbers rules travel in every prompt, and the honest-numbers
//      block travels in every context at every scope. AI output is never shown
//      as measured evidence.
//   3. Uploaded documents, discovered resource names and anything else that
//      came from outside are DATA in the prompt, never instructions.
//
// The conversation is session-local: it lives in this module, in memory. It
// survives navigating to another page and back; it does not survive a reload,
// and it is never written to disk or sent anywhere but the user's own CLI.
import { h, card, badge, markdown, modal, toast, pageHead, btn, empty, spinner } from '../ui.js';
import {
  aiConsoleOptions, aiConsoleContext, aiConsoleTurn,
  operationsBlock, resolveOpNames, aiAvailable, resetAiAvailable,
  INSTALL_HINT, INSTALL_STEPS, installHint, aiToolName,
} from '../ai-actions.js';

// ---------------------------------------------------------------- styling
// Scoped and idempotent — app.css is shared with other agents.
const STYLE = `
.cp-wrap { display: flex; flex-direction: column; gap: 14px; }
.cp-scope { display: flex; flex-direction: column; gap: 10px; }
.cp-scope-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.cp-scope-row label.cp-sel { display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--muted); }
.cp-scope-row select { width: auto; min-width: 150px; }
.cp-parts { display: flex; flex-wrap: wrap; gap: 6px; }
.cp-part { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 11px 4px 9px;
  cursor: pointer; background: var(--panel); user-select: none; }
.cp-part:hover { border-color: var(--accent); }
.cp-part.on { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }
.cp-part input { width: auto !important; margin: 0; flex: none; }
.cp-budget { font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap;
  gap: 8px; align-items: center; }
.cp-budget .cp-bytes { font-weight: 650; color: var(--text); }
.cp-conv { display: flex; flex-direction: column; gap: 12px; min-height: 120px; }
.cp-turn { border-radius: 12px; padding: 12px 14px; font-size: 13.5px; overflow-wrap: anywhere; }
.cp-turn.user { background: var(--accent-soft); border: 1px solid rgba(79,143,247,.32);
  align-self: flex-end; max-width: 78%; white-space: pre-wrap; }
.cp-turn.ai { background: var(--panel); border: 1px solid var(--border); align-self: stretch; }
.cp-turn.err { border-color: var(--err); }
.cp-turn-role { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); font-weight: 700; margin-bottom: 6px; }
.cp-uncertain { margin-top: 12px; border: 1px solid var(--warn); border-radius: 9px;
  background: var(--warn-soft); padding: 9px 12px; }
.cp-uncertain-head { font-weight: 650; font-size: 12.5px; margin-bottom: 5px; }
.cp-uncertain ul { margin: 0; padding-left: 18px; font-size: 12.5px; }
.cp-meta { font-size: 11.5px; color: var(--muted); margin-top: 12px;
  border-top: 1px solid var(--border); padding-top: 7px; }
.cp-composer { display: flex; flex-direction: column; gap: 8px; }
.cp-composer textarea { min-height: 92px; resize: vertical; font-size: 13.5px; }
.cp-composer-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cp-starters { display: flex; flex-wrap: wrap; gap: 6px; }
.cp-starter { font-size: 12px; border: 1px dashed var(--border); border-radius: 999px;
  padding: 5px 11px; cursor: pointer; color: var(--muted); background: transparent; }
.cp-starter:hover { border-style: solid; border-color: var(--accent); color: var(--text); }
.cp-applied-note { font-size: 12.5px; color: var(--muted); margin-top: 10px;
  border-left: 2px solid var(--ok); padding-left: 9px; }
.cp-safety { font-size: 12px; color: var(--muted); }
.cp-json { max-height: 55vh; overflow: auto; font-size: 11.5px; }
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('copilot-style')) return;
  const el = h('style', { id: 'copilot-style' }, STYLE);
  (document.head || document.body || document.documentElement)?.append(el);
}

// ---------------------------------------------------------------- session
//
// One conversation per workspace, kept in memory for the life of the tab.

const sessions = new Map();

function session(ws) {
  if (!sessions.has(ws)) {
    sessions.set(ws, { messages: [], scope: null, options: null, draft: '' });
  }
  return sessions.get(ws);
}

/** Exported for the Cmd+K drawer, which hands its conversation over on "open in console". */
export function seedSession(ws, messages) {
  const s = session(ws);
  if (Array.isArray(messages) && messages.length) s.messages = messages.slice();
  return s;
}

export function resetSession(ws) {
  const s = session(ws);
  s.messages = [];
  s.draft = '';
}

const STARTERS = [
  'Group these components into services and tell me which ones you were unsure about.',
  'Which components have no verification, and what should each one actually check?',
  'What is missing before I could hand this to an auditor?',
  'Find duplicate components and propose merges.',
  'Set a restore layer on everything that has none, and explain the ones you guessed.',
  'Give every component a consistent name of the form <service>-<role>.',
];

// ---------------------------------------------------------------- helpers

const kb = (bytes) => (bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes || 0} B`);

function sendableMessages(messages) {
  // The transcript the server sees: role + text + what actually landed. The
  // rendered DOM and the raw result objects stay on this side.
  return messages
    .filter((m) => m.role !== 'error')
    .map((m) => ({
      role: m.role,
      content: m.content,
      proposedCount: m.proposedCount || 0,
      appliedCount: m.appliedCount || 0,
    }));
}

// ---------------------------------------------------------------- page

export default {
  title: 'AI console',

  async render(el, ctx) {
    const { ws, api, navigate } = ctx;
    ensureStyle();
    const s = session(ws);

    const cliOk = await aiAvailable(api);

    // ---- scope state -------------------------------------------------------
    let options = s.options;
    if (!options) {
      options = await aiConsoleOptions({ ws, api }).catch((e) => ({ ok: false, message: e.message }));
      if (options && options.ok) s.options = options;
    }
    const parts = (options && options.parts) || [];
    if (!s.scope) {
      s.scope = {
        envId: '', serviceId: '',
        include: (options && options.defaultInclude) || parts.filter((p) => p.default).map((p) => p.key),
      };
    }
    const scope = s.scope;

    // ---- shell -------------------------------------------------------------
    const wrap = h('div', { class: 'cp-wrap' });
    el.append(pageHead({
      title: 'AI console',
      purpose: 'Ask for anything about this workspace. The AI can answer, or propose changes to your data, '
        + 'or both — and nothing is written until you review it and click Apply.',
      actions: [
        btn({
          label: 'New conversation',
          onClick: () => { resetSession(ws); navigate(`#/${ws}/copilot`); window.dispatchEvent(new HashChangeEvent('hashchange')); },
        }),
      ],
    }), wrap);

    if (!cliOk) {
      // [ai-providers] Name the tool the user actually selected, and point at
      // the place they can change it — the copilot is not Claude-only any more.
      wrap.append(card(
        h('h2', null, `${aiToolName()} was not found`),
        h('p', { class: 'hint' }, installHint() || INSTALL_HINT),
        h('pre', { class: 'mono' }, INSTALL_STEPS),
        h('p', { class: 'hint', style: 'margin-top:10px' },
          'Using a different tool — Cursor, Kiro, Amazon Q, Gemini, Codex, Ollama, or your own command? ',
          h('a', { href: `#/${ws}/settings` }, 'Choose it under Settings → AI tool →')),
        h('div', { class: 'row', style: 'margin-top:12px' },
          btn({
            label: 'Check again',
            kind: 'btn-primary',
            onClick: () => { resetAiAvailable(); window.dispatchEvent(new HashChangeEvent('hashchange')); },
          }))));
      return;
    }

    // ---- scope card --------------------------------------------------------
    const budget = h('div', { class: 'cp-budget' }, h('span', { class: 'hint' }, 'measuring…'));
    const scopeBox = h('div', { class: 'cp-scope' });

    const envSel = h('select', null,
      h('option', { value: '' }, 'All environments'),
      ((options && options.environments) || []).map((e) =>
        h('option', { value: e.id }, e.name + (e.isProduction ? ' (production)' : ''))));
    envSel.value = scope.envId || '';

    const svcSel = h('select', null,
      h('option', { value: '' }, 'All services'),
      ((options && options.services) || []).map((sv) => h('option', { value: sv.id }, sv.name)));
    svcSel.value = scope.serviceId || '';

    const hasOrg = ((options && options.environments) || []).length || ((options && options.services) || []).length;

    const partChips = h('div', { class: 'cp-parts' });
    const chipFor = (p) => {
      const cb = h('input', { type: 'checkbox', checked: scope.include.includes(p.key) });
      const chip = h('label', { class: `cp-part ${cb.checked ? 'on' : ''}`, title: p.hint }, cb, p.label);
      cb.addEventListener('change', () => {
        scope.include = cb.checked
          ? [...new Set([...scope.include, p.key])]
          : scope.include.filter((k) => k !== p.key);
        chip.classList.toggle('on', cb.checked);
        measure();
      });
      return chip;
    };
    for (const p of parts) partChips.append(chipFor(p));

    let measureSeq = 0;
    let lastContext = null;
    async function measure() {
      const seq = ++measureSeq;
      budget.replaceChildren(h('span', { class: 'hint' }, 'measuring…'));
      const r = await aiConsoleContext({ ws, api, scope });
      if (seq !== measureSeq) return;
      lastContext = r;
      if (!r || !r.ok) {
        budget.replaceChildren(badge(r?.message || 'Could not measure the context', 'warn'));
        return;
      }
      const kept = (r.parts || []).filter((p) => !p.dropped);
      budget.replaceChildren(
        h('span', null, 'Will be sent: '),
        h('span', { class: 'cp-bytes' }, kb(r.bytes)),
        h('span', null, ` · ${r.scope.componentCount} of ${r.counts.workspaceComponents} components`
          + (r.scope.envName ? ` · ${r.scope.envName}` : '')
          + (r.scope.serviceName ? ` · ${r.scope.serviceName}` : '')),
        h('span', null, kept.length ? ` · ${kept.map((p) => `${p.label} (${kb(p.bytes)})`).join(', ')}` : ' · workspace meta and the honest numbers only'),
        r.truncated ? badge('truncated to fit', 'warn') : null,
        h('button', {
          class: 'cp-starter', style: 'margin-left:4px',
          onClick: async () => {
            const full = await aiConsoleContext({ ws, api, scope, full: true });
            await modal('Exactly what would be sent',
              h('div', null,
                h('p', { class: 'hint' },
                  'This is the whole context block, verbatim. It is quoted to the model as DATA — the prompt '
                  + 'tells it never to follow an instruction found inside it.'),
                h('pre', { class: 'mono cp-json' }, full.ok ? full.context : (full.message || 'unavailable'))),
              { wide: true, actions: [] });
          },
        }, 'show it'));
    }

    scopeBox.append(
      h('div', { class: 'cp-scope-row' },
        hasOrg ? h('label', { class: 'cp-sel' }, 'Environment', envSel) : null,
        hasOrg ? h('label', { class: 'cp-sel' }, 'Service', svcSel) : null,
        partChips),
      budget);
    envSel.addEventListener('change', () => { scope.envId = envSel.value; measure(); });
    svcSel.addEventListener('change', () => { scope.serviceId = svcSel.value; measure(); });

    wrap.append(card(
      h('h2', null, 'What the AI can see'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Pick how much of the estate goes into the prompt. The workspace settings and the honest-numbers '
        + 'block always travel, whatever you choose here — so a hand-typed recovery number can never reach '
        + 'the model without the note that says nobody measured it.'),
      scopeBox));

    // ---- conversation ------------------------------------------------------
    const conv = h('div', { class: 'cp-conv' });
    const convCard = card(conv);
    wrap.append(convCard);

    const emptyState = () => empty({
      icon: '✦',
      title: 'Ask it anything about this workspace',
      body: 'It reads what you selected above, answers in plain language, and — when a change is what you '
        + 'actually want — proposes the edits for you to review. It is the same review-and-apply step as '
        + 'everywhere else in the app: nothing is written until you tick it and click Apply.',
    });

    function scrollToEnd(node) {
      try { (node || conv.lastElementChild)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      catch { /* cosmetic */ }
    }

    function userTurn(text) {
      return h('div', { class: 'cp-turn user' }, text);
    }

    function aiTurn(msg) {
      const box = h('div', { class: 'cp-turn ai' }, h('div', { class: 'cp-turn-role' }, 'AI console'));
      const res = msg.res || {};
      if (msg.content && msg.content.trim()) box.append(markdown(msg.content));
      else box.append(h('div', { class: 'hint' }, 'The AI returned no prose for this turn.'));

      if (Array.isArray(res.uncertain) && res.uncertain.length) {
        box.append(h('div', { class: 'cp-uncertain' },
          h('div', { class: 'cp-uncertain-head' }, `Not sure about ${res.uncertain.length} thing${res.uncertain.length === 1 ? '' : 's'}`),
          h('ul', null, res.uncertain.map((u) => h('li', null, u)))));
      }

      const ops = res.operations || [];
      if (ops.length) {
        if (msg.appliedCount > 0) {
          // Already applied in this session: do not offer the same ops again.
          box.append(h('div', { class: 'cp-applied-note' },
            `${msg.appliedCount} change(s) from this turn were applied. `
            + `${ops.length - msg.appliedCount > 0 ? `${ops.length - msg.appliedCount} proposed change(s) were not.` : ''}`));
        } else {
          box.append(operationsBlock({
            ws, api, grouped: true,
            result: { summary: res.summary, operations: ops, notes: '' },
            names: msg.names,
            onApplied: (out) => {
              msg.appliedCount = (out.applied || []).length;
              // The sidebar counts and every page's data are now stale.
              window.dispatchEvent(new CustomEvent('drcompass:data-changed'));
              toast('Applied — ask a follow-up and the AI will know what landed.', 'ok');
            },
            afterRender: () => scrollToEnd(box),
          }));
        }
      } else if (res.parsed === false) {
        box.append(h('div', { class: 'hint', style: 'margin-top:8px' },
          'The AI answered in prose rather than the structured format, so there is nothing to apply from this turn.'));
      }

      if (res.notes && res.notes.trim()) box.append(h('div', { class: 'ai-notes' }, markdown(res.notes)));

      const c = res.context;
      if (c) {
        const kept = (c.parts || []).filter((p) => !p.dropped).map((p) => p.label);
        box.append(h('div', { class: 'cp-meta' },
          `Context sent: ${kb(c.bytes)} — ${c.scope?.componentCount ?? '?'} component(s)`
          + (c.scope?.envName ? `, ${c.scope.envName}` : '')
          + (c.scope?.serviceName ? `, ${c.scope.serviceName}` : '')
          + (kept.length ? `, including ${kept.join(', ')}` : '')
          + (c.truncated ? ' (truncated to fit)' : '')
          + (c.historyTurns ? ` · ${c.historyTurns} earlier turn(s) carried` : '')
          + ' · ran on your local claude CLI.'));
      }
      return box;
    }

    function repaint() {
      conv.replaceChildren();
      if (!s.messages.length) { conv.append(emptyState()); return; }
      for (const m of s.messages) {
        if (m.role === 'user') conv.append(userTurn(m.content));
        else if (m.role === 'error') conv.append(h('div', { class: 'cp-turn ai err' }, badge(m.content, 'warn')));
        else conv.append(aiTurn(m));
      }
    }
    repaint();

    // ---- composer ----------------------------------------------------------
    const ta = h('textarea', {
      placeholder: 'e.g. "organise these components into services by what they do, set a tier on each service, '
        + 'and tell me which ones you had to guess"',
    });
    // A draft handed over from the Cmd/Ctrl+K drawer ("Full console →").
    try {
      const handover = window.__drcompassCopilotDraft;
      if (handover && handover.ws === ws && handover.text) {
        s.draft = handover.text;
        delete window.__drcompassCopilotDraft;
      }
    } catch { /* handover is a convenience, never load-bearing */ }
    ta.value = s.draft || '';
    ta.addEventListener('input', () => { s.draft = ta.value; });

    const sendBtn = h('button', { class: 'btn btn-primary' }, 'Send');
    const status = h('span', { class: 'hint' }, '⌘/Ctrl+Enter to send · runs your local claude CLI, up to ~3 min');

    let busy = false;
    async function send() {
      const text = String(ta.value || '').trim();
      if (!text || busy) return;
      busy = true;
      ta.value = '';
      s.draft = '';
      ta.disabled = true;
      sendBtn.disabled = true;
      status.textContent = 'Thinking — your local claude CLI is working…';

      s.messages.push({ role: 'user', content: text });
      conv.querySelector('.empty')?.remove();
      const uTurn = userTurn(text);
      conv.append(uTurn);
      const thinking = h('div', { class: 'cp-turn ai' }, spinner('Thinking — this can take up to three minutes.'));
      conv.append(thinking);
      scrollToEnd(thinking);

      let res;
      try {
        res = await aiConsoleTurn({
          ws, api, scope,
          messages: sendableMessages(s.messages),
          page: 'copilot',
        });
      } catch (e) {
        res = { ok: false, message: e.message };
      }
      thinking.remove();

      if (!res || !res.ok) {
        const msg = { role: 'error', content: (res && res.message) || 'The AI request failed.' };
        s.messages.push(msg);
        conv.append(h('div', { class: 'cp-turn ai err' },
          badge(msg.content, 'warn'),
          res && res.raw
            ? h('details', { class: 'ai-op-data', style: 'margin-top:8px' },
              h('summary', null, 'raw answer'), h('pre', { class: 'mono' }, res.raw))
            : null));
      } else {
        const names = await resolveOpNames(ws, api, res.operations || []);
        const msg = {
          role: 'assistant',
          content: res.reply || res.summary || '',
          res, names,
          proposedCount: (res.operations || []).length,
          appliedCount: 0,
        };
        s.messages.push(msg);
        const node = aiTurn(msg);
        conv.append(node);
        scrollToEnd(node);
      }

      busy = false;
      ta.disabled = false;
      sendBtn.disabled = false;
      status.textContent = '⌘/Ctrl+Enter to send · runs your local claude CLI, up to ~3 min';
      ta.focus();
    }

    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    sendBtn.addEventListener('click', send);

    const starters = h('div', { class: 'cp-starters' },
      STARTERS.map((t) => h('button', {
        class: 'cp-starter', type: 'button',
        onClick: () => { ta.value = t; s.draft = t; ta.focus(); },
      }, t)));

    wrap.append(card(
      h('div', { class: 'cp-composer' },
        ta,
        h('div', { class: 'cp-composer-row' }, sendBtn, status),
        starters,
        h('div', { class: 'cp-safety' },
          'The AI proposes; you decide. Nothing it suggests is evidence — a recovery time only counts as '
          + 'measured when a test recorded as passed produced it, and the console is told that in every prompt.'))));

    measure();
    ta.focus();
  },
};
