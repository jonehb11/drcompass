// First-run guidance. One definition of "what does a DR program need, in order"
// — used by the dashboard's Start here card, the slim progress strip it shrinks
// into, and the sidebar's progress count. Every done/not-done state below is
// derived from real workspace data, never from a "seen it" flag.
import { h, btn, term, dot } from './ui.js';

const STORE_KEY = (ws) => `drcompass.starthere.${ws}`;

function readPref(ws) {
  try { return localStorage.getItem(STORE_KEY(ws)) || ''; } catch { return ''; }
}
function writePref(ws, v) {
  try { localStorage.setItem(STORE_KEY(ws), v); } catch { /* private mode — fine */ }
}

/**
 * The five foundations, with a plain-English reason and a live done state.
 * snap is a ui.snapshot() result.
 */
export function programSteps(snap, ws) {
  const s = snap || {};
  const c = s.counts || {};
  const r = s.report || null;
  const answered = r?.answeredTotal ?? 0;
  const qTotal = r?.questionCount ?? 0;
  const comps = c.components || 0;
  const depsPct = s.depsPct || 0;
  const passed = (s.passedTests || []).length;
  const lastTest = s.lastTest || null;

  return [
    {
      id: 'assess',
      title: 'Assess where you are',
      why: 'An honest score on six parts of DR, so you fix the weakest thing first instead of guessing.',
      done: qTotal > 0 && answered >= qTotal,
      started: answered > 0,
      progress: qTotal ? `${answered} of ${qTotal} questions answered` : null,
      action: { label: answered ? 'Continue' : 'Start the assessment', href: `#/${ws}/assessment` },
      page: 'assessment',
    },
    {
      id: 'inventory',
      title: 'Build the inventory',
      why: 'Write down what actually has to come back — services, databases, queues, secrets, third parties. Everything later is built from this list.',
      done: comps >= 5,
      started: comps > 0,
      progress: comps ? `${comps} recorded${c.inScope ? ` · ${c.inScope} in recovery scope` : ''}` : null,
      action: { label: comps ? 'Add more' : 'Add resources by hand', href: `#/${ws}/inventory` },
      alt: { label: 'Or import from AWS', href: `#/${ws}/discover` },
      page: 'inventory',
    },
    {
      id: 'deps',
      title: 'Map dependencies',
      whyNode: () => h('span', null,
        'Record what each resource is attached to — its network, its disk, its secret. That is what makes a safe recovery order possible instead of ',
        term('dependency closure', 'tribal knowledge'), '.'),
      why: 'Record what each resource is attached to — its network, its disk, its secret. That is what makes a safe recovery order possible.',
      done: comps >= 3 && depsPct >= 60,
      started: depsPct > 0,
      progress: comps ? `${depsPct}% of resources have dependencies recorded` : null,
      action: { label: 'Map dependencies', href: `#/${ws}/inventory` },
      alt: { label: 'Or see the picture', href: `#/${ws}/diagrams` },
      page: 'inventory',
    },
    {
      id: 'runbook',
      title: 'Draft a runbook',
      why: 'A plan in someone’s head is not a plan. Write the steps a colleague could follow at 3am, in order, with a check after each one.',
      done: (c.runbooks || 0) > 0 && !!s.hasRunbookSteps,
      started: (c.runbooks || 0) > 0,
      progress: c.runbooks ? `${c.runbooks} runbook${c.runbooks > 1 ? 's' : ''}${s.hasRunbookSteps ? '' : ' — no steps written yet'}` : null,
      action: { label: c.runbooks ? 'Open runbooks' : 'Draft a runbook', href: `#/${ws}/runbooks` },
      page: 'runbooks',
    },
    {
      id: 'test',
      title: 'Run a test',
      why: 'Until a recovery has been rehearsed, your recovery time is a hope. One small test in a spare account beats a perfect document.',
      done: passed >= 1,
      started: (c.tests || 0) > 0,
      progress: lastTest ? `last run ${lastTest.status}` : (c.tests ? `${c.tests} planned, none run yet` : null),
      action: { label: c.tests ? 'Open tests' : 'Plan the first test', href: `#/${ws}/tests` },
      page: 'tests',
    },
  ];
}

/** Summary used by the sidebar and by the dashboard header. */
export function programProgress(snap, ws) {
  const steps = programSteps(snap, ws);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done) || null;
  return { steps, done, total: steps.length, next, complete: done === steps.length };
}

// ---------------------------------------------------------------------------

function stepRow(step, i, { isNext }) {
  const state = step.done ? 'done' : isNext ? 'next' : step.started ? 'started' : '';
  return h('li', { class: `sh-step ${state}` },
    h('div', { class: 'sh-num', 'aria-hidden': 'true' }, step.done ? '✓' : String(i + 1)),
    h('div', { class: 'sh-body' },
      h('div', { class: 'sh-title-row' },
        h('span', { class: 'sh-title' }, step.title),
        step.done ? h('span', { class: 'sh-flag ok' }, 'done')
          : isNext ? h('span', { class: 'sh-flag next' }, 'you are here') : null),
      h('div', { class: 'sh-why' }, step.whyNode ? step.whyNode() : step.why),
      step.progress ? h('div', { class: 'sh-progress' }, step.progress) : null),
    h('div', { class: 'sh-act' },
      btn({ ...step.action, kind: isNext ? 'btn-primary' : '', size: 'btn-sm' }),
      step.alt && !step.done ? h('a', { class: 'sh-alt', href: step.alt.href }, step.alt.label) : null));
}

/**
 * The first-run experience. Returns an element, or null for a workspace that
 * has finished all five foundations (a mature program is never nagged).
 *
 *   el.append(startHere({ ws, snap }));
 *
 * Renders the big numbered card while the program is young, and collapses to a
 * one-line progress strip once it is underway or the user hides it.
 */
export function startHere({ ws, snap }) {
  const prog = programProgress(snap, ws);
  if (prog.complete) return null;

  const box = h('div', { class: 'starthere-slot' });
  const autoStrip = prog.done >= 2;

  function draw() {
    const pref = readPref(ws);
    const mode = pref === 'open' ? 'full' : pref === 'strip' ? 'strip' : (autoStrip ? 'strip' : 'full');
    box.replaceChildren(mode === 'full' ? full() : strip());
  }

  function full() {
    const pct = Math.round((prog.done / prog.total) * 100);
    return h('section', { class: 'card starthere', 'aria-labelledby': 'sh-h' },
      h('div', { class: 'sh-head' },
        h('div', null,
          h('h2', { id: 'sh-h' }, prog.done ? 'Keep going' : 'Start here'),
          h('div', { class: 'sh-purpose' },
            'Five steps take you from an empty workspace to a recovery you have actually tested. Each one is short, and your progress is worked out from your own data — there is nothing to tick off by hand.')),
        h('div', { class: 'sh-count' },
          h('div', { class: 'sh-count-n' }, `${prog.done}/${prog.total}`),
          h('div', { class: 'sh-count-l' }, 'foundations done'))),
      h('div', { class: 'progress sh-bar' }, h('div', { style: `width:${pct}%` })),
      h('ol', { class: 'sh-steps' },
        prog.steps.map((s, i) => stepRow(s, i, { isNext: prog.next && s.id === prog.next.id }))),
      h('div', { class: 'sh-foot' },
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onClick: () => { writePref(ws, 'strip'); draw(); },
        }, 'Shrink to a progress strip'),
        h('span', { class: 'spacer' }),
        h('a', { class: 'hint', href: `#/${ws}/learn` }, 'New to disaster recovery? Read the basics first →')));
  }

  function strip() {
    return h('section', { class: 'sh-strip', 'aria-label': 'Getting started progress' },
      h('span', { class: 'sh-strip-label' }, 'Getting started'),
      h('span', { class: 'sh-strip-dots' },
        prog.steps.map((s) => h('span', {
          class: `sh-pip ${s.done ? 'done' : s.started ? 'started' : ''}`,
          title: `${s.title} — ${s.done ? 'done' : s.started ? 'in progress' : 'not started'}`,
        }, h('span', { class: 'sr-only' }, `${s.title}: ${s.done ? 'done' : 'not done'}`)))),
      h('span', { class: 'sh-strip-count' }, `${prog.done} of ${prog.total}`),
      prog.next ? h('span', { class: 'sh-strip-next' }, 'Next: ', h('a', { href: prog.next.action.href }, prog.next.title)) : null,
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onClick: () => { writePref(ws, 'open'); draw(); },
      }, 'Show all steps'));
  }

  draw();
  return box;
}

/**
 * The very first screen of a fresh install: no workspaces exist at all.
 * `onCreate` should open the new-workspace dialog.
 */
export function firstRunWelcome({ onCreate, error } = {}) {
  return h('div', { class: 'firstrun' },
    h('div', { class: 'firstrun-mark', 'aria-hidden': 'true' }, '\u{1F9ED}'),
    h('h1', null, error ? 'Cannot reach the DR Compass server' : 'Welcome to DR Compass'),
    h('p', { class: 'firstrun-lead' }, error
      ? 'The app loaded but the local server did not answer, so your workspaces could not be listed. Check the terminal where you started DR Compass, then reload.'
      : 'DR Compass takes you from “we should have a disaster-recovery plan” to a recovery you have actually tested — one workspace per system you are responsible for.'),
    error ? null : h('ul', { class: 'firstrun-list' },
      h('li', null, h('strong', null, 'A workspace'), ' holds one system: what it is made of, how it comes back, and the evidence that it does.'),
      h('li', null, 'You will be asked for a ', h('strong', null, 'primary region'), ' (where it runs today) and a ', h('strong', null, 'recovery region'), ' (where it comes back). Both can be changed later.'),
      h('li', null, 'Nothing touches your cloud account until you explicitly ask it to, and reads are always read-only.')),
    h('div', { class: 'firstrun-actions' },
      error
        ? btn({ label: 'Reload', kind: 'btn-primary', onClick: () => location.reload() })
        : btn({ label: 'Create your first workspace', kind: 'btn-primary', onClick: onCreate })));
}
