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

const LAYERS = [
  ['L0', 'Guardrails & backups'], ['L1', 'Recovery launch'], ['L2', 'Platform'],
  ['L3', 'Data & secrets'], ['L4', 'Applications'], ['L5', 'Edge reachability'],
  ['L6', 'Functional success bar'], ['L7', 'Live traffic cutover'],
];
const SEV_ORDER = { blocker: 0, critical: 0, high: 1, medium: 2, low: 3 };

/** Measured vs target, said in words a new owner can act on. */
function recoveryTile({ measured, target, approved, kind, href, label, unit = 'recovery' }) {
  const hasM = measured !== null && measured !== undefined;
  const hasT = target !== null && target !== undefined;
  let tone = 'muted';
  if (hasM && hasT) tone = measured <= target ? 'ok' : measured <= target * 1.5 ? 'warn' : 'err';
  else if (hasM) tone = 'warn';
  else if (hasT) tone = 'muted';

  const sub = hasT
    ? `target ${fmtMinutes(target)}${approved ? ' · approved' : ' · not approved by the business'}`
    : 'no target set yet';
  return statTile({
    value: hasM ? fmtMinutes(measured) : 'not measured',
    label,
    sub: hasM ? sub : `${sub} · no test has measured this yet`,
    kind: tone,
    href,
    hint: hasM && hasT
      ? (measured <= target ? `Last test met the ${unit} target` : `Last test missed the ${unit} target`)
      : 'Open Tests to measure this for real',
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
        measured: obj.rtaMinutes, target: obj.rtoMinutes, approved: obj.approved,
        href: `#/${ws}/tests`, label: h('span', null, 'Recovery time — ', term('rta', 'measured')), unit: 'recovery time',
      }),
      recoveryTile({
        measured: obj.rpaMinutes, target: obj.rpoMinutes, approved: obj.approved,
        href: `#/${ws}/tests`, label: h('span', null, 'Data loss — ', term('rpa', 'measured')), unit: 'data loss',
      }),
    ));

    // ---------------------------------------------------------------- AI (optional tenant)
    const aiContext = {
      workspace: { name: m.name, slug: ws, regions: m.regions, strategy: m.strategy, tooling: m.tooling },
      objectives: obj,
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
            t.results?.rtaMinutes != null ? ` · recovered in ${fmtMinutes(t.results.rtaMinutes)}` : '')),
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
