// THE PROGRESSION MODEL — one definition of "where am I in this DR program",
// and the only one. The dashboard's Start here card, the slim progress strip,
// the sidebar's persistent "what to do next" affordance, every page's
// end-of-page next step and every breadcrumb are all derived from what is in
// this file. Every done/not-done state comes from real workspace data
// (a ui.snapshot() result) — never from a "seen it" flag.
//
//   programSteps(snap, ws)       the five foundations, with live done states
//   programProgress(snap, ws)    {steps, done, total, next, complete, stage}
//   nextAction(snap, ws)         EXACTLY ONE next action, always non-null
//   journey(page)                where a page sits on the path: prev / next
//   crumbFor(page, ws)           "what led here", for ui.pageHead({crumb})
//   nextStepFor(page, snap, ws)  "what follows", a ui.nextStep() band
//   sidebarNext({snap, ws})      the persistent affordance in the shell
//
// A mature program is never nagged: once the foundations are done, the blockers
// are clear and a game day has passed, `stage` becomes 'steady', `earned` goes
// true, and the affordances go quiet instead of inventing work.
import { h, btn, term, dot, nextStep, fmtMinutes, relTime } from './ui.js';

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
// ONE next action. Always returns something, and returns the SAME thing
// wherever it is asked, because everything asks this function.
//
// Stages, in order: foundations → blockers → prove → cadence → steady.
//   foundations  a foundation is unfinished — that is the next action
//   blockers     foundations done, but an open blocker would fail a real recovery
//   prove        nothing blocking, but no game day has ever passed
//   cadence      proven, but the last test is stale (>180 days)
//   steady       earned; the next action is upkeep, offered quietly
const STALE_DAYS = 180;

export function nextAction(snap, ws) {
  const s = snap || {};
  const prog = programProgress(s, ws);

  if (!prog.complete && prog.next) {
    const st = prog.next;
    return {
      id: st.id, stage: 'foundations', earned: false,
      title: st.title, why: st.why,
      action: st.action, alt: st.alt || null,
      page: st.page, done: prog.done, total: prog.total,
    };
  }

  const blockers = (s.openBlockers || []).length;
  if (blockers) {
    return {
      id: 'blockers', stage: 'blockers', earned: false,
      title: blockers === 1 ? 'Close the open blocker' : `Close ${blockers} open blockers`,
      why: 'The foundations are in place, but a blocker is something a real recovery would fail on. Fix it, or have someone with authority accept it in writing.',
      action: { label: 'Review blockers', href: `#/${ws}/tests` },
      alt: { label: 'See the impact', href: `#/${ws}/dashboard` },
      page: 'tests', done: prog.done, total: prog.total,
    };
  }

  if (!s.gameDayPassed) {
    return {
      id: 'game-day', stage: 'prove', earned: false,
      title: 'Run a game day',
      why: 'Everything is written down and a technical test has passed. What is still unproven is the part with people in it: decisions, comms, and who is actually awake.',
      action: { label: 'Plan a game day', href: `#/${ws}/tests` },
      alt: { label: 'Check the preflight gates', href: `#/${ws}/checklists` },
      page: 'tests', done: prog.done, total: prog.total,
    };
  }

  const last = s.lastTest?.date ? new Date(s.lastTest.date).getTime() : NaN;
  const ageDays = Number.isNaN(last) ? Infinity : Math.round((Date.now() - last) / 86400000);
  if (ageDays > STALE_DAYS) {
    return {
      id: 'retest', stage: 'cadence', earned: true,
      title: 'Re-test — the evidence has aged',
      why: `The last test was ${relTime(s.lastTest?.date) || 'a long time ago'}. Infrastructure has moved since; a recovery time you have not re-measured is a recovery time you no longer know.`,
      action: { label: 'Schedule the next test', href: `#/${ws}/tests` },
      alt: { label: 'Re-score the assessment', href: `#/${ws}/assessment` },
      page: 'tests', done: prog.done, total: prog.total, ageDays,
    };
  }

  return {
    id: 'steady', stage: 'steady', earned: true,
    title: 'Keep the evidence current',
    why: 'Foundations done, nothing blocking, a game day passed and the numbers are fresh. Nothing here needs you today — the package below is what auditors, execs and on-call read.',
    action: { label: 'Build the evidence package', href: `#/${ws}/exports` },
    alt: { label: 'Re-score the assessment', href: `#/${ws}/assessment` },
    page: 'exports', done: prog.done, total: prog.total, ageDays,
  };
}

// ---------------------------------------------------------------------------
// THE PATH. A DR program is a line, so the pages are a line: each one knows
// what led here and what follows, in both directions.
const SPINE = [
  ['dashboard', 'Overview'],
  ['assessment', 'Assessment'],
  ['inventory', 'Inventory'],
  ['diagrams', 'Diagrams'],
  ['deploy-order', 'Deployment order'],
  ['runbooks', 'Runbooks'],
  ['checklists', 'Checklists'],
  ['tests', 'Tests'],
  ['exports', 'Exports'],
];
const LABEL = Object.fromEntries([...SPINE, ['service', 'Service profile'],
  ['discover', 'Discover'], ['learn', 'Learn'], ['settings', 'Settings']]);
// Pages beside the path still have a place on it.
const BESIDE = {
  service: { after: 'inventory', before: 'runbooks' },
  discover: { after: 'inventory', before: 'inventory' },
  learn: { after: 'dashboard', before: null },
  settings: { after: 'dashboard', before: 'tests' },
};

/** Where a page sits: {page, label, step, of, prev, next}. `step` is null beside the path. */
export function journey(page) {
  const i = SPINE.findIndex(([p]) => p === page);
  if (i >= 0) {
    return {
      page, label: LABEL[page], step: i + 1, of: SPINE.length,
      prev: i > 0 ? { page: SPINE[i - 1][0], label: SPINE[i - 1][1] } : null,
      next: i < SPINE.length - 1 ? { page: SPINE[i + 1][0], label: SPINE[i + 1][1] } : null,
    };
  }
  const b = BESIDE[page];
  if (!b) return { page, label: LABEL[page] || page, step: null, of: SPINE.length, prev: null, next: null };
  return {
    page, label: LABEL[page] || page, step: null, of: SPINE.length,
    prev: b.after ? { page: b.after, label: LABEL[b.after] } : null,
    next: b.before ? { page: b.before, label: LABEL[b.before] } : null,
  };
}

/** "What led here", for ui.pageHead({ crumb }). Null for the Overview itself. */
export function crumbFor(page, ws) {
  const j = journey(page);
  if (!j.prev) return null;
  return { label: j.prev.label, href: `#/${ws}/${j.prev.page}` };
}

// What is genuinely most useful AFTER this page, decided from the workspace
// data rather than from a hard-coded link. Returns a {title, body, action, alt}
// spec; nextStepFor() wraps it in the band.
// What is genuinely most useful AFTER this page, decided from the workspace data
// rather than from a hard-coded link. One entry per page; `go(page, label)` is a
// route, `na` is the program's single next action, `c` the snapshot counts.
// Returns a {title, body, action, alt} spec that nextStepFor() wraps in a band.
const FORWARD = {
  dashboard: (s, c, na) => ({ title: na.title, body: na.why, action: na.action, alt: na.alt }),

  assessment: (s, c, na, go, back) => {
    const top = (s.report?.nextActions || [])[0];
    return top && top.page !== 'assessment'
      ? { title: 'Scored. Now go and change the score.', body: `${top.title} — ${top.why}`,
        action: go(top.page, top.title), alt: { label: 'See it on the Overview', href: back } }
      : { title: na.title, body: na.why, action: na.action, alt: { label: 'Back to Overview', href: back } };
  },

  inventory: (s, c, na, go) => {
    if ((c.components || 0) < 5) {
      return { title: 'Thin inventory',
        body: 'A recovery plan can only cover what is written down. Import the rest read-only from AWS, Kubernetes or Arpio instead of typing it.',
        action: go('discover', 'Import from AWS'), alt: go('service', 'Check one service end to end') };
    }
    if ((s.depsPct || 0) < 60) {
      return { title: `Only ${s.depsPct || 0}% of resources have dependencies recorded`,
        body: 'Recovery order comes from dependencies. The picture makes the holes obvious — anything sitting alone in the graph is something nobody has wired up yet.',
        action: go('diagrams', 'See the dependency picture'), alt: go('discover', 'Map dependencies from AWS') };
    }
    return { title: 'Inventory looking solid?',
      body: 'Turn it into an ordered procedure someone else could follow at 3am, with a check after every step.',
      action: go('deploy-order', 'Work out the recovery order'), alt: go('diagrams', 'See how it connects') };
  },

  service: (s, c, na, go) => ({
    title: 'One service down — what about the rest?',
    body: c.runbooks
      ? 'The same questions apply to every Tier 0 service. Check the runbook actually names this one, then move to the next.'
      : 'Nothing is written down yet for any of it. A runbook pre-fills its L0→L7 steps from this dependency closure.',
    action: go('runbooks', c.runbooks ? 'Open runbooks' : 'Draft a runbook'),
    alt: go('inventory', 'Back to the full inventory'),
  }),

  diagrams: (s, c, na, go) => ({
    title: 'Picture agrees with reality?',
    body: 'The diagram is generated from the inventory, so anything wrong here is wrong there. When it looks right, the order it implies is what belongs in the runbook.',
    action: go('deploy-order', 'Turn it into a recovery order'),
    alt: go('inventory', 'Fix it in Inventory'),
  }),

  'deploy-order': (s, c, na, go) => ({
    title: 'That is the order. Now write it down.',
    body: 'Waves are only useful to someone awake at 3am once they have become numbered steps with a check after each one.',
    action: go('runbooks', c.runbooks ? 'Open runbooks' : 'Draft a runbook from these waves'),
    alt: go('diagrams', 'See it as a picture'),
  }),

  discover: (s, c, na, go) => ((c.components || 0)
    ? { title: 'Imported — now make it yours',
      body: 'Discovery finds what exists. What it cannot know is tier, recovery scope and how you would verify each thing came back. That part is yours.',
      action: go('inventory', 'Review in Inventory'), alt: go('diagrams', 'See the resource map') }
    : { title: 'Nothing imported yet',
      body: 'A read-only scan of one account is the fastest way to a real inventory — it changes nothing in AWS, and nothing lands here until you tick it.',
      action: { label: 'Scan an AWS account', href: `#/${s.ws || ''}/discover/aws` },
      alt: go('inventory', 'Or add one by hand') }),

  checklists: (s, c, na, go) => ({
    title: 'Gates ready?',
    body: 'A checklist is what you run through before the clock starts. The clock itself lives on the Tests page.',
    action: go('tests', c.tests ? 'Open tests' : 'Plan the first test'),
    alt: go('runbooks', 'Check the runbook'),
  }),

  tests: (s, c, na, go, back) => {
    if ((s.passedTests || []).length) {
      return { title: 'Measured. Now make it shareable.',
        body: 'You have numbers a test actually produced. The package turns them into something an auditor, an exec and the on-call engineer can each read.',
        action: go('exports', 'Build the evidence package'), alt: go('assessment', 'Re-score the assessment') };
    }
    return na.stage === 'foundations'
      ? { title: na.title, body: na.why, action: na.action, alt: { label: 'Back to Overview', href: back } }
      : { title: 'Nothing measured yet',
        body: 'Every recovery time on the Overview stays a hypothesis until one of these rows has a real timestamp against it.',
        action: go('checklists', 'Run the preflight gate first'), alt: { label: 'Back to Overview', href: back } };
  },

  learn: (s, c, na, go, back) => ({
    title: `Next in your program: ${na.title}`,
    body: na.why, action: na.action, alt: { label: 'Back to Overview', href: back },
  }),

  settings: (s, c, na, go, back) => {
    const o = s.objectives || {};
    if (o.rtoMinutes == null) {
      return { title: 'No recovery target set',
        body: 'Everything else compares against this one number. Ask the business the longest outage they can live with, put it above, and have them approve it.',
        action: { label: 'Back to Overview', href: back }, alt: go('learn', 'What these words mean') };
    }
    if (!o.approved) {
      return { title: 'Targets are not approved yet',
        body: `Until someone with authority signs off, ${fmtMinutes(o.rtoMinutes)} is an engineering guess. Get the sign-off, then tick the box above.`,
        action: go('exports', 'Build the pack to take to them'), alt: { label: 'Back to Overview', href: back } };
    }
    return { title: 'Targets set and approved',
      body: 'They only become evidence once a test has measured the real numbers against them.',
      action: go('tests', c.tests ? 'Open tests' : 'Plan the first test'), alt: { label: 'Back to Overview', href: back } };
  },

  exports: (s, c, na, go, back) => ({
    title: na.stage === 'steady' ? 'Shared. Nothing else is due.' : na.title,
    body: na.why,
    action: na.action.href.endsWith('/exports') ? { label: 'Back to Overview', href: back } : na.action,
    alt: na.alt,
  }),
};

function forwardSpec(page, snap, ws) {
  const s = snap || {};
  const na = nextAction(s, ws);
  const go = (p, label) => ({ label, href: `#/${ws}/${p}` });
  const back = `#/${ws}/dashboard`;
  const fn = FORWARD[page];
  if (!fn) return { title: na.title, body: na.why, action: na.action, alt: na.alt };
  return fn({ ...s, ws }, s.counts || {}, na, go, back);
}


/**
 * The band that ends a page: what follows, derived from this workspace's data.
 *   el.append(nextStepFor('inventory', snap, ws));
 * `override` merges on top, for a page that knows something the model does not.
 */
export function nextStepFor(page, snap, ws, override = {}) {
  const spec = { ...forwardSpec(page, snap, ws), ...override };
  const na = nextAction(snap, ws);
  return nextStep({ ...spec, kind: na.stage === 'steady' ? 'nextstep-calm' : '' });
}

/**
 * The persistent, unobtrusive "what to do next" affordance in the shell. It
 * always knows where you are in the program and offers exactly ONE action.
 * Earned completion goes quiet: no progress bar, no "next", just the state.
 */
export function sidebarNext({ snap, ws }) {
  const prog = programProgress(snap, ws);
  const na = nextAction(snap, ws);

  if (na.stage === 'steady') {
    return h('div', { class: 'wp-line wp-ok' }, dot('ok'), ' Tested and current');
  }
  const pct = Math.round((prog.done / prog.total) * 100);
  return h('a', { class: 'wp-prog', href: na.action.href, title: na.why },
    na.stage === 'foundations'
      ? h('span', { class: 'progress wp-bar' }, h('div', { style: `width:${pct}%` }))
      : null,
    h('span', { class: 'wp-prog-t' },
      h('span', { class: 'wp-next-k' }, 'Next'),
      ' ', na.title,
      na.stage === 'foundations' ? h('span', { class: 'wp-next-n' }, ` ${prog.done}/${prog.total}`) : null));
}

/**
 * 'full' | 'strip' | 'none' — what startHere() will draw. The page asks so it
 * knows whether the Start here card has already taken the view's ONE primary
 * action, or whether the end-of-page next step should carry it.
 */
export function startHereMode(ws, snap) {
  const prog = programProgress(snap, ws);
  if (prog.complete) return 'none';
  const pref = readPref(ws);
  if (pref === 'open') return 'full';
  if (pref === 'strip') return 'strip';
  return prog.done >= 2 ? 'strip' : 'full';
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
    box.replaceChildren(startHereMode(ws, snap) === 'full' ? full() : strip());
  }

  function full() {
    const pct = Math.round((prog.done / prog.total) * 100);
    return h('section', { class: 'card starthere', 'aria-labelledby': 'sh-h' },
      h('div', { class: 'sh-head' },
        h('div', null,
          h('h2', { id: 'sh-h' }, prog.done ? 'Keep going' : 'Start here'),
          h('div', { class: 'sh-purpose' },
            'Five steps from an empty workspace to a recovery you have actually tested. Progress is read from your own data — there is nothing to tick off.')),
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

  // Collapsed form. Deliberately NOT a second "what to do next" — the shell's
  // sidebar affordance and the page's own next-step band already carry the one
  // action, so this is only the five pips and a way back to the detail.
  function strip() {
    return h('section', { class: 'sh-strip', 'aria-label': 'Foundations progress' },
      h('span', { class: 'sh-strip-dots' },
        prog.steps.map((s) => h('span', {
          class: `sh-pip ${s.done ? 'done' : s.started ? 'started' : ''}`,
          title: `${s.title} — ${s.done ? 'done' : s.started ? 'in progress' : 'not started'}`,
        }, h('span', { class: 'sr-only' }, `${s.title}: ${s.done ? 'done' : 'not done'}`)))),
      h('span', { class: 'sh-strip-count' }, `${prog.done} of ${prog.total} foundations`),
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
      h('li', null, 'Nothing touches your cloud account until you ask it to, and reads are always read-only.')),
    h('div', { class: 'firstrun-actions' },
      error
        ? btn({ label: 'Reload', kind: 'btn-primary', onClick: () => location.reload() })
        : btn({ label: 'Create your first workspace', kind: 'btn-primary', onClick: onCreate })));
}
