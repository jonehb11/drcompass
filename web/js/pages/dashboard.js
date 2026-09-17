// Overview — answers three questions in order, and nothing else:
//   What is the honest recovery story? · What is blocking me? · What next?
// Every number on this page is a link to the place where you act on it, and the
// page never explains a number it is already showing.
//
// Deliberately NOT here: the region pair, the strategy, the maturity level and
// the blocker count as header badges. All four are already on this same screen
// (sidebar posture, Maturity tile, the card below) — a second telling is
// decoration, and the sidebar is the one place workspace identity lives.
import {
  h, card, badge, empty, btn, pageHead, cardHead, statTile, severityBadge, statusBadge,
  term, snapshot, aiRow, fmtMinutes, fmtDate, relTime,
} from '../ui.js';
import { startHere, startHereMode, programProgress, nextAction, nextStepFor } from '../onboarding.js';
import { measuredNumbers, describe } from '../measured.js';

const LAYERS = [
  ['L0', 'Guardrails & backups'], ['L1', 'Recovery launch'], ['L2', 'Platform'],
  ['L3', 'Data & secrets'], ['L4', 'Applications'], ['L5', 'Edge reachability'],
  ['L6', 'Functional success bar'], ['L7', 'Live traffic cutover'],
];
const SEV_ORDER = { blocker: 0, critical: 0, high: 1, medium: 2, low: 3 };

/**
 * One recovery number, told honestly.
 *
 * The tile used to read the hand-typed `objectives.rtaMinutes` and print it
 * green as "measured", with the hover text "Last test met the recovery time
 * target" — a claim about a test, from a field no test ever wrote. Now the tile
 * renders a slot from measured.js, which only says "measured" when a PASSED
 * test produced the number, and it always shows the test beside it.
 *
 * Three states, three quite different tiles:
 *   measured   the number, then "Dev recovery test #2 — Aug 28, 2026 — passed"
 *   declared   the number, neutral, "recorded by hand — not from a test"
 *   unmeasured "Not measured yet" as a call to action, not an apology
 */
function recoveryTile({ slot, targetMinutes, approved, href, label, unit = 'recovery' }) {
  const d = describe(slot, { targetMinutes, unit });
  const targetText = targetMinutes !== null && targetMinutes !== undefined
    ? `target ${fmtMinutes(targetMinutes)}${approved ? ' · approved' : ' · not approved by the business'}`
    : 'no target set yet';

  let value = d.value;
  let sub;
  if (d.state === 'measured') {
    // Name, date and status travel with the number — never a bare green figure.
    sub = `${d.provenance} · ${targetText}`;
  } else if (d.state === 'declared') {
    sub = `Recorded by hand, not from a test · ${targetText}`;
  } else {
    value = 'Not measured yet';
    sub = `${d.action} · ${targetText}`;
  }

  return statTile({
    value,
    label: d.state === 'measured' ? label.measured : d.state === 'declared' ? label.declared : label.unmeasured,
    sub,
    kind: d.tone,
    href,
    hint: d.state === 'unmeasured' ? `Not measured yet — run a recovery test. ${d.hint}` : d.hint,
  });
}

export default {
  title: 'Overview',
  async render(el, { ws, api }) {
    const snap = await snapshot(api, ws);
    if (!snap.ok) {
      el.append(pageHead({ title: 'Overview', purpose: 'Where you stand, what is blocking you, and what to do next.' }));
      el.append(card(empty({
        icon: '⚠️',
        title: 'This workspace could not be read',
        body: 'The server did not return workspace details. Check the terminal running DR Compass, then reload.',
        action: { label: 'Reload', onClick: () => location.reload() },
      })));
      return;
    }

    const m = snap.meta;
    const obj = snap.objectives || {};
    const rep = snap.report;
    const c = snap.counts;
    const prog = programProgress(snap, ws);
    // The single source of truth for what this workspace can actually prove.
    // Everything below — tiles, AI context — reads this, never obj.rtaMinutes.
    // `components` makes the workspace-level claim checkable: a passed test
    // that named one Tier-3 component measured that component, not this
    // workspace (docs/measured-numbers.md, NEW-2).
    const honest = measuredNumbers(m, snap.tests, null, { components: snap.components || [] });

    // ---------------------------------------------------------------- head
    el.append(pageHead({
      title: m.name || 'Overview',
      purpose: 'What your recovery program can actually prove today, and the one thing to do next.',
    }));

    // ---------------------------------------------------------------- start here
    // Exactly one primary action per view. The Start here card claims it while
    // it is expanded; otherwise the end-of-page next step carries it.
    const shMode = startHereMode(ws, snap);
    const sh = startHere({ ws, snap });
    if (sh) el.append(sh, h('div', { style: 'height:var(--s3)' }));

    // ---------------------------------------------------------------- 1. the honest numbers
    el.append(h('section', { class: 'truth-row' },
      statTile({
        value: rep ? `Level ${rep.level} of 5` : '—',
        label: term('maturity level', 'Maturity'),
        sub: rep
          ? `${rep.levelLabel} · ${rep.answeredTotal}/${rep.questionCount} questions answered`
          : 'assessment not available',
        kind: rep ? (rep.level >= 4 ? 'ok' : rep.level >= 2 ? 'warn' : 'err') : 'muted',
        href: `#/${ws}/assessment`,
        hint: 'Open the assessment',
      }),
      recoveryTile({
        slot: honest.rta, targetMinutes: honest.target.rtoMinutes, approved: honest.target.approved,
        href: `#/${ws}/tests`, unit: 'recovery time',
        label: {
          measured: h('span', null, 'Recovery time — ', term('rta', 'measured')),
          declared: h('span', null, 'Recovery time — recorded by hand'),
          unmeasured: h('span', null, 'Recovery time — ', term('rta', 'unmeasured')),
        },
      }),
      recoveryTile({
        slot: honest.rpa, targetMinutes: honest.target.rpoMinutes, approved: honest.target.approved,
        href: `#/${ws}/tests`, unit: 'data loss',
        label: {
          measured: h('span', null, 'Data loss — ', term('rpa', 'measured')),
          declared: h('span', null, 'Data loss — recorded by hand'),
          unmeasured: h('span', null, 'Data loss — ', term('rpa', 'unmeasured')),
        },
      }),
    ));

    // Say out loud what the tiles imply, once, where someone can act on it.
    if (honest.rta.state !== 'measured' || honest.rpa.state !== 'measured') {
      el.append(h('p', { class: 'hint', style: 'margin:8px 2px 0' },
        honest.rta.state === 'declared' || honest.rpa.state === 'declared'
          ? h('span', null,
            'A number recorded by hand is not evidence. ',
            h('a', { href: `#/${ws}/tests` }, 'Record it from a test that passed'),
            ' to make it quotable.')
          : h('span', null,
            'Nothing here has been measured yet. ',
            h('a', { href: `#/${ws}/tests` }, 'Run a recovery test'),
            ' — until then every number on this page is a target.')));
    }

    // ---------------------------------------------------------------- AI (optional tenant)
    const aiContext = {
      workspace: { name: m.name, slug: ws, regions: m.regions, strategy: m.strategy, tooling: m.tooling },
      // Targets only. The AI must never see a hand-typed number under a name
      // that implies it was measured — `measured` below carries the state.
      objectives: { rtoMinutes: obj.rtoMinutes ?? null, rpoMinutes: obj.rpoMinutes ?? null, approved: !!obj.approved, notes: obj.notes || '' },
      measured: {
        rta: { minutes: honest.rta.minutes, state: honest.rta.state, test: honest.rta.test, note: honest.rta.note },
        rpa: { minutes: honest.rpa.minutes, state: honest.rpa.state, test: honest.rpa.test, note: honest.rpa.note },
        verdict: honest.verdict,
        warnings: honest.warnings,
        legend: 'state "measured" = produced by a test recorded as passed; "declared" = typed by a person, NOT evidence; "unmeasured" = nothing has measured it. Never call a declared or unmeasured number achieved, met or measured.',
      },
      maturity: rep ? { level: rep.level, label: rep.levelLabel, answered: rep.answeredTotal, of: rep.questionCount, pillars: rep.pillars } : null,
      counts: c,
      dependenciesMappedPct: snap.depsPct,
      verificationDefinedPct: snap.verifyPct,
      openBlockers: snap.openBlockers.map((g) => ({ title: g.title, severity: g.severity, status: g.status })),
      openGaps: snap.openGaps.length,
      lastTest: snap.lastTest ? { name: snap.lastTest.name, type: snap.lastTest.type, status: snap.lastTest.status, date: snap.lastTest.date } : null,
      gameDayPassed: snap.gameDayPassed,
      gettingStarted: { done: prog.done, of: prog.total, next: prog.next?.title || null },
    };
    el.append(aiRow({
      ws, api, context: aiContext, intro: 'Ask AI about this workspace:',
      actions: [
        { label: 'Explain my DR posture in plain English', prompt: 'Explain this workspace’s current disaster-recovery posture in plain English for a non-specialist manager. Be honest about what is unproven. Do not propose any data changes.' },
        { label: 'What should I do this week?', prompt: 'Given this workspace state, list the 3 highest-value things to do in the next week, in order, with a one-line reason each. Be specific to the data shown. Do not propose any data changes.' },
        { label: 'Draft an executive summary', prompt: 'Draft a short executive summary of this disaster-recovery program: where it stands, the honest recovery numbers, the top risks, and what is needed next. Plain language, no jargon without explanation. Do not propose any data changes.' },
      ],
    }));

    // ---------------------------------------------------------------- 2. what is blocking me
    const blocking = [...snap.openGaps].sort((a, b) =>
      (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
      || String(a.title || '').localeCompare(String(b.title || '')));
    const compGapNotes = snap.components.filter((x) => (x.gaps || []).length);

    const blockCard = card(
      cardHead(h('h2', null, 'What is blocking you'),
        blocking.length ? h('a', { class: 'hint', href: `#/${ws}/tests` }, `all ${snap.openGaps.length} open →`) : null));
    if (blocking.length) {
      blockCard.append(
        h('div', null, blocking.slice(0, 6).map((g) => h('a', { class: 'blocker-row', href: `#/${ws}/tests` },
          h('span', null, severityBadge(g.severity)),
          h('span', { class: 'br-main' },
            h('span', { class: 'br-title' }, g.title || '(untitled gap)'),
            g.detail || g.why ? h('span', { class: 'br-why' }, g.detail || g.why) : null),
          g.status && g.status !== 'open' ? statusBadge(g.status) : null))));
    } else if (compGapNotes.length) {
      blockCard.append(
        h('p', { class: 'hint', style: 'margin-bottom:8px' },
          `Nothing is tracked as a formal gap yet, but ${compGapNotes.length} ${compGapNotes.length > 1 ? 'resources carry' : 'resource carries'} a note worth turning into one:`),
        h('div', null, compGapNotes.slice(0, 5).map((x) => h('a', { class: 'blocker-row', href: `#/${ws}/inventory` },
          h('span', null, badge('note')),
          h('span', { class: 'br-main' },
            h('span', { class: 'br-title' }, x.name),
            h('span', { class: 'br-why' }, (x.gaps || [])[0]))))));
    } else if (!snap.passedTests.length) {
      blockCard.append(empty({
        icon: '\u{1F50D}',
        title: 'Nothing is blocking you — because nothing has been tested yet',
        body: 'An untested plan has no known problems, which is not the same as having none.',
        action: { label: 'Plan a test', href: `#/${ws}/tests`, kind: '' },
      }));
    } else {
      blockCard.append(empty({
        icon: '✅',
        title: 'Nothing open',
        body: `Every gap found so far is fixed or formally accepted, and the last test ${snap.lastTest?.status === 'passed' ? 'passed' : 'has been recorded'}.`,
        action: { label: 'Schedule the next test', href: `#/${ws}/tests`, kind: '' },
      }));
    }

    // ---------------------------------------------------------------- 3. what next
    // This is the ONLY copy of the roadmap in the app. The Assessment page used
    // to render the identical list from the identical data.
    const actCard = card(cardHead('What to do next'));
    if (rep && (rep.nextActions || []).length) {
      actCard.append(
        h('div', { class: 'act-list' }, rep.nextActions.slice(0, 5).map((a, i) =>
          h('a', { class: 'act-item', href: `#/${ws}/${a.page}` },
            h('span', { class: 'act-n' }, String(i + 1)),
            h('span', null, h('span', { class: 'act-t' }, a.title), h('span', { class: 'act-w' }, a.why))))));
    } else {
      actCard.append(empty({
        icon: '\u{1F9ED}',
        title: 'No roadmap yet',
        body: 'The assessment turns your answers into a short, ordered list of what to fix first.',
        action: { label: 'Start the assessment', href: `#/${ws}/assessment`, kind: '' },
      }));
    }

    el.append(h('div', { class: 'grid cols-2', style: 'margin-top:var(--s4); align-items:start' }, blockCard, actCard));

    // ---------------------------------------------------------------- 4. supporting detail
    const detail = [];

    // recent tests — links go to the individual test, not just the list
    const recent = snap.datedTests.slice(0, 5);
    const testCard = card(
      cardHead(h('h2', null, 'Recent tests'),
        recent.length ? h('a', { class: 'hint', href: `#/${ws}/tests` }, 'all tests →') : null));
    if (recent.length) {
      testCard.append(h('table', { class: 'table' }, h('tbody', null, recent.map((t) => h('tr', { class: 'clickable' },
        h('td', null,
          h('a', { href: `#/${ws}/tests/${t.id}` }, t.name || t.type || 'test'),
          h('div', { class: 'hint' },
            t.type || '',
            // "recovered in 47 min" is only true of a run that reached the
            // success bar. A failed run produces a time to failure.
            t.results?.rtaMinutes == null ? ''
              : t.status === 'passed' ? ` · recovered in ${fmtMinutes(t.results.rtaMinutes)}`
                : ` · ${fmtMinutes(t.results.rtaMinutes)} to failure — not a recovery time`)),
        h('td', { style: 'white-space:nowrap' }, fmtDate(t.date), h('div', { class: 'hint' }, relTime(t.date))),
        h('td', { style: 'text-align:right' }, statusBadge(t.status, 'planned')))))));
    } else {
      testCard.append(empty({
        title: 'No tests recorded',
        body: 'Until a recovery has been rehearsed, the numbers above stay unmeasured.',
        action: { label: 'Plan the first test', href: `#/${ws}/tests`, kind: '' },
      }));
    }
    detail.push(testCard);

    // readiness by layer — only the layers you actually use
    if (c.components) {
      const populated = LAYERS.map(([id, name]) => {
        const inLayer = snap.components.filter((x) => x.restoreLayer === id);
        const verified = inLayer.filter((x) => x.verification && x.verification.command);
        return { id, name, n: inLayer.length, v: verified.length };
      }).filter((r) => r.n > 0);
      const unlayered = snap.components.filter((x) => !x.restoreLayer).length;

      const layerCard = card(cardHead(h('h2', null, 'Readiness by ', term('restore layer'))));
      if (populated.length) {
        layerCard.append(h('table', { class: 'table dense' },
          h('thead', null, h('tr', null,
            h('th', null, 'Layer'), h('th', null, h('span', null, 'Can be ', term('verification', 'proved'))), h('th', { class: 'num' }, 'Resources'))),
          h('tbody', null, populated.map((r) => {
            const pct = r.n ? Math.round((r.v / r.n) * 100) : 0;
            return h('tr', null,
              h('td', null, h('a', { href: `#/${ws}/inventory` }, badge(r.id, 'purple'), ' ', h('span', { style: 'font-size:12.5px' }, r.name))),
              h('td', { style: 'min-width:130px' }, h('div', { class: 'layer-bar' },
                h('div', { class: 'progress' }, h('div', { style: `width:${pct}%; background:${pct >= 60 ? 'var(--ok)' : pct > 0 ? 'var(--warn)' : 'var(--err)'}` })),
                h('span', { class: 'hint', style: 'white-space:nowrap' }, `${r.v}/${r.n}`))),
              h('td', { class: 'num' }, String(r.n)));
          }))));
      } else {
        layerCard.append(empty({
          title: 'Nothing has a restore layer yet',
          body: 'Without layers, a runbook cannot be put in a safe order.',
          action: { label: 'Assign layers in Inventory', href: `#/${ws}/inventory`, kind: '' },
        }));
      }
      if (unlayered) {
        layerCard.append(h('p', { class: 'hint', style: 'margin-top:8px' },
          h('a', { href: `#/${ws}/inventory` },
            `${unlayered} resource${unlayered > 1 ? 's' : ''} with no layer — cannot be sequenced →`)));
      }
      detail.push(layerCard);
    }

    el.append(h('div', { class: 'grid cols-2', style: 'margin-top:var(--s4); align-items:start' }, ...detail));

    // ---------------------------------------------------------------- never a dead end
    // ALWAYS present now, not just for a finished program — this is the page's
    // one imperative whenever the Start here card is collapsed or gone, and its
    // target comes from onboarding.nextAction(), the single progression model.
    const na = nextAction(snap, ws);
    el.append(nextStepFor('dashboard', snap, ws, {
      action: { ...na.action, kind: shMode === 'full' ? '' : 'btn-primary' },
    }));
  },
};
