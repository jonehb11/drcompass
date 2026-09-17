// The honest-numbers contract, browser side.
//
// One rule, enforced here so no page can break it on its own:
//
//   A number is MEASURED only when a test that PASSED, and that directly
//   covers the subject, produced it. Anything typed into Settings is
//   DECLARED — recorded by hand, never evidence. Anything else is UNMEASURED,
//   which is a state, not a failure and not a blank.
//
// Shape mirrors the server's `server/lib/measured.js` (docs/measured-numbers.md)
// so the dashboard, Settings, Tests and the service page tell the same story as
// the workbook and the AI context:
//
//   measuredNumbers(workspace, tests, componentId) -> {
//     rta: { minutes, state, source, test, staleDays, stale, isAchievement, label, note },
//     rpa: { ...same },
//     target: { rtoMinutes, rpoMinutes, approved },
//     verdict: { rto:'met'|'missed'|'unknown', rpo, overall:…|'partial', why },
//     warnings: [],
//   }
//
// This is the browser twin, not a second opinion: wherever a server response
// already carries the server's own result (`posture.numbers`) we render THAT
// and compute nothing. This file only covers the workspace-level screens, which
// have no endpoint of their own.
//
// Pure: no DOM, no fetch. The pages do the rendering; `describe()` supplies the
// words so they cannot drift apart.
import { fmtDate, fmtMinutes } from './ui.js';

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num = (v) => (isNum(v) ? Number(v) : null);
const DAY = 86400000;
// docs/measured-numbers.md: DEFAULT_STALE_AFTER_DAYS.
const STALE_AFTER_DAYS = 180;

/** Days since a test date, or null when undated / in the future. */
export function staleDaysOf(date) {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  const d = Math.floor((Date.now() - t) / DAY);
  return d > 0 ? d : 0;
}

const testRef = (t) => (t ? {
  id: t.id || '', name: t.name || '(unnamed test)', date: t.date || '', status: t.status || '',
} : null);

/**
 * Does this test measure the subject *directly*? A workspace-level number
 * (componentId null) is covered by any test in the workspace; a component
 * number needs the component named on the test itself, never inferred from a
 * shared runbook or a dependency closure.
 */
export function coversDirectly(t, componentId) {
  if (!componentId) return true;
  if (!t) return false;
  if (t.componentId === componentId) return true;
  if (Array.isArray(t.componentIds) && t.componentIds.includes(componentId)) return true;
  return (t.appTests || []).some((a) => a && a.componentId === componentId);
}

const newestFirst = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

/** One number's provenance. `key` is 'rtaMinutes' or 'rpaMinutes'. */
function slotFor(objectives, tests, componentId, key, linkedIdKey, notPassedNote) {
  const covering = (tests || []).filter((t) => t && coversDirectly(t, componentId));
  const passedWith = covering
    .filter((t) => t.status === 'passed' && isNum(t.results?.[key]))
    .sort(newestFirst);

  // An explicit link written by the Tests page wins, but only if it still
  // points at a passed test that carries the number.
  const linkedId = objectives?.[linkedIdKey];
  const linked = linkedId ? passedWith.find((t) => t.id === linkedId) : null;
  const evidence = linked || passedWith[0] || null;

  if (evidence) {
    const staleDays = staleDaysOf(evidence.date);
    const stale = staleDays !== null && staleDays > STALE_AFTER_DAYS;
    return {
      minutes: num(evidence.results[key]),
      state: 'measured',
      source: 'test',
      test: testRef(evidence),
      staleDays,
      stale,
      isAchievement: false, // set once the verdict is known, below
      label: 'measured',
      cleanRun: evidence.results?.cleanRun ?? null,
      note: `Measured by ${evidence.name || 'a recovery test'}${evidence.date ? ` (${fmtDate(evidence.date)})` : ''} — passed.`
        + (stale ? ` Evidence is ${staleDays} days old.` : ''),
      typedMinutes: num(objectives?.[key]),
      conflictsWithTyped: isNum(objectives?.[key]) && Number(objectives[key]) !== num(evidence.results[key]),
    };
  }

  const typed = num(objectives?.[key]);
  if (typed !== null) {
    // Is the typed number the ghost of a run that did NOT pass? The seed's 47
    // came from a failed test, which is a time to failure, not a recovery time.
    const echo = covering
      .filter((t) => t.status !== 'passed' && Number(t.results?.[key]) === typed)
      .sort(newestFirst)[0] || null;
    return {
      minutes: typed,
      state: 'declared',
      source: 'typed',
      test: null,
      echoTest: testRef(echo),
      staleDays: null,
      stale: false,
      isAchievement: false,
      label: 'declared (typed, not measured)',
      cleanRun: null,
      note: echo
        ? `Recorded by hand, not from a test. It matches ${echo.name || 'a test'}`
          + `${echo.date ? ` (${fmtDate(echo.date)})` : ''}, which is recorded as ${echo.status || 'not passed'}`
          + ` — ${notPassedNote}`
        : 'Recorded by hand in Settings, not from a test held by DR Compass.',
      typedMinutes: typed,
      conflictsWithTyped: false,
    };
  }

  const anyRun = covering.filter((t) => isNum(t.results?.[key])).sort(newestFirst)[0] || null;
  return {
    minutes: null,
    state: 'unmeasured',
    source: null,
    test: null,
    echoTest: testRef(anyRun),
    staleDays: null,
    stale: false,
    isAchievement: false,
    label: 'unmeasured',
    cleanRun: null,
    note: anyRun
      ? `No passed test has measured this. The closest run, ${anyRun.name || 'a test'}, is ${anyRun.status || 'not passed'}.`
      : 'No test has measured this yet.',
    typedMinutes: null,
    conflictsWithTyped: false,
  };
}

/**
 * The full honest view. `workspace` is the workspace meta (for objectives),
 * `tests` the test collection, `componentId` optional.
 */
export function measuredNumbers(workspace, tests, componentId = null) {
  const o = (workspace && workspace.objectives) || {};
  const list = Array.isArray(tests) ? tests : [];
  const rta = slotFor(o, list, componentId, 'rtaMinutes', 'rtaTestId',
    'a run that did not pass never reached the success bar, so it has a time to failure, not a recovery time.');
  const rpa = slotFor(o, list, componentId, 'rpaMinutes', 'rpaTestId',
    'a run that did not pass cannot confirm how much data a real recovery would have lost.');
  const target = {
    rtoMinutes: num(o.rtoMinutes),
    rpoMinutes: num(o.rpoMinutes),
    approved: !!o.approved,
  };

  // Vocabulary per docs/measured-numbers.md: 'met' | 'missed' | 'unknown', and
  // overall gains 'partial'. 'met' overall needs BOTH — one objective alone
  // used to be enough, which is how "Objectives met" appeared over a single
  // number with the other never measured.
  const judge = (slot, targetMinutes) => {
    if (slot.state !== 'measured' || slot.minutes === null) return 'unknown';
    if (targetMinutes === null) return 'unknown';
    return slot.minutes <= targetMinutes ? 'met' : 'missed';
  };
  const rtoV = judge(rta, target.rtoMinutes);
  const rpoV = judge(rpa, target.rpoMinutes);
  let overall = 'unknown';
  if (rtoV === 'missed' || rpoV === 'missed') overall = 'missed';
  else if (rtoV === 'met' && rpoV === 'met') overall = 'met';
  else if (rtoV === 'met' || rpoV === 'met') overall = 'partial';
  rta.isAchievement = rtoV === 'met';
  rpa.isAchievement = rpoV === 'met';

  const whyBits = [];
  if (rtoV === 'unknown') whyBits.push(rta.state === 'declared' ? 'the recovery time is hand-recorded, not measured' : 'no passed test has measured the recovery time');
  if (rpoV === 'unknown') whyBits.push(rpa.state === 'declared' ? 'the data loss is hand-recorded, not measured' : 'no passed test has measured the data loss');
  if (rtoV === 'missed') whyBits.push(`recovery took ${fmtMinutes(rta.minutes)} against a ${fmtMinutes(target.rtoMinutes)} target`);
  if (rpoV === 'missed') whyBits.push(`data loss was ${fmtMinutes(rpa.minutes)} against a ${fmtMinutes(target.rpoMinutes)} target`);
  if (!whyBits.length && overall === 'met') whyBits.push('both numbers come from a passed test and are inside target');

  const warnings = [];
  for (const [label, slot] of [['Recovery time', rta], ['Data loss', rpa]]) {
    if (slot.state === 'declared') {
      warnings.push(`${label} is a hand-typed number with no passed test behind it — it is not evidence.`);
    }
    if (slot.state === 'measured' && slot.conflictsWithTyped) {
      warnings.push(`${label}: Settings says ${fmtMinutes(slot.typedMinutes)} but the passed test `
        + `${slot.test.name} measured ${fmtMinutes(slot.minutes)}. The test is the evidence.`);
    }
    if (slot.state === 'measured' && slot.cleanRun === false) {
      warnings.push(`${label} came from a run that needed hands-on help, so it is not yet a repeatable capability.`);
    }
    if (slot.state === 'measured' && slot.stale) {
      warnings.push(`${label} was measured ${slot.staleDays} days ago — evidence past ${STALE_AFTER_DAYS} days is no longer a current capability.`);
    }
  }
  if (!target.approved && (target.rtoMinutes !== null || target.rpoMinutes !== null)) {
    warnings.push('The targets are not approved by the business, so they are proposals rather than commitments.');
  }

  return { rta, rpa, target, verdict: { rto: rtoV, rpo: rpoV, overall, why: whyBits.join('; ') }, warnings };
}

// ------------------------------------------------------------------ wording
//
// One vocabulary for every surface. `unit` is 'recovery time' or 'data loss'.

const UNIT_ACTION = {
  'recovery time': 'Run a recovery test and mark T0 and T1',
  'data loss': 'Run a recovery test and record the recovery point age',
};

/**
 * describe(slot, { targetMinutes, unit }) -> the words and the tone for one
 * number, wherever it is shown. `tone` is a ui.js badge/tile kind:
 *   ok    measured by a passed test and inside target
 *   err   measured by a passed test and over target
 *   ''    recorded by hand — neutral, never green, never "achieved"
 *   muted not measured yet
 */
export function describe(slot, { targetMinutes = null, unit = 'recovery' } = {}) {
  const s = slot || { state: 'unmeasured', minutes: null };
  const has = s.minutes !== null && s.minutes !== undefined;
  const inTarget = has && targetMinutes !== null && targetMinutes !== undefined
    ? s.minutes <= targetMinutes : null;

  if (s.state === 'measured') {
    const t = s.test || {};
    const stamp = `${t.name || 'a recovery test'}${t.date ? ` — ${fmtDate(t.date)}` : ''} — passed`;
    // Stale evidence WAS measured, so it keeps the word — but it never keeps
    // the green: "measured in 2019" is not "currently meets".
    const stale = !!s.stale;
    return {
      state: 'measured',
      word: 'measured',
      value: fmtMinutes(s.minutes),
      // "47 min (Aug 12 recovery test — passed)" — the number never travels alone.
      valueWithProvenance: `${fmtMinutes(s.minutes)} (${stamp})`,
      provenance: stale ? `${stamp} · evidence is ${s.staleDays} days old` : stamp,
      tone: stale ? 'warn' : inTarget === null ? '' : inTarget ? 'ok' : 'err',
      badge: stale ? `measured ${s.staleDays} days ago` : 'measured — passed test',
      badgeTone: stale ? 'warn' : inTarget === false ? 'err' : 'ok',
      stale,
      verdictWord: inTarget === null ? 'no target set' : inTarget ? 'inside the target' : 'over the target',
      hint: inTarget === null
        ? `Measured by ${stamp}. No target to compare it with yet.`
        : `Measured by ${stamp}, ${inTarget ? 'inside' : 'over'} the ${unit} target.`
          + (stale ? ` Evidence is ${s.staleDays} days old — re-test before quoting it.` : ''),
      action: stale ? 'Re-run the test — this evidence has aged out' : null,
      note: s.note,
    };
  }

  if (s.state === 'declared') {
    return {
      state: 'declared',
      word: 'recorded by hand',
      value: fmtMinutes(s.minutes),
      valueWithProvenance: `${fmtMinutes(s.minutes)} (recorded by hand, not from a test)`,
      provenance: 'recorded by hand, not from a test',
      tone: '',
      badge: 'recorded by hand',
      badgeTone: 'warn',
      // Deliberately NOT "met" / "achieved" in either direction: a number with
      // no test behind it cannot satisfy or breach an objective.
      verdictWord: 'not evidence',
      hint: s.note || 'Typed into Settings. Nothing has tested it, so it cannot be quoted as an achievement.',
      action: UNIT_ACTION[unit] || 'Run a recovery test',
      note: s.note,
    };
  }

  return {
    state: 'unmeasured',
    word: 'not measured yet',
    value: 'Not measured yet',
    valueWithProvenance: 'Not measured yet',
    provenance: 'no passed test has measured this',
    tone: 'muted',
    badge: 'not measured yet',
    badgeTone: '',
    verdictWord: 'unmeasured',
    hint: s.note || 'No test has measured this yet — that is a to-do, not a failure.',
    action: UNIT_ACTION[unit] || 'Run a recovery test',
    note: s.note,
  };
}

// ----------------------------------------------------------- server posture
//
// `GET /w/:ws/service/:id` returns `posture`. When it carries the new
// provenance (posture.rta / posture.rpa in the shape above) we render it
// straight. When it does not — an older server, a partial deploy — we derive
// the same shape from posture.measured, and a test that did not PASS, or that
// only covers this service through a shared runbook or its dependency closure,
// never becomes a measurement.

function slotFromLegacy(m, key, typed) {
  if (m && m.status === 'passed' && m.covers === 'direct' && isNum(m[key])) {
    const staleDays = staleDaysOf(m.date);
    const stale = staleDays !== null && staleDays > STALE_AFTER_DAYS;
    return {
      minutes: num(m[key]),
      state: 'measured',
      source: 'test',
      test: { id: m.id || '', name: m.name || '(unnamed test)', date: m.date || '', status: m.status },
      staleDays,
      stale,
      isAchievement: false,
      label: 'measured',
      cleanRun: m.cleanRun ?? null,
      note: `Measured by ${m.name}${m.date ? ` (${fmtDate(m.date)})` : ''} — passed.`,
      typedMinutes: num(typed),
      conflictsWithTyped: false,
    };
  }
  const why = !m ? 'No test covers this service.'
    : m.covers && m.covers !== 'direct'
      ? `The only test that touches this service, ${m.name}, covers it ${m.covers === 'runbook' ? 'only through a shared runbook' : 'only through its dependency closure'} — that is not a measurement of this service.`
      : m.status !== 'passed'
        ? `${m.name} is recorded as ${m.status || 'not passed'}, so it produced a time to failure, not a recovery time.`
        : `${m.name} did not produce this number.`;
  if (isNum(typed)) {
    return {
      minutes: num(typed), state: 'declared', source: 'typed', test: null,
      echoTest: m ? { id: m.id || '', name: m.name || '', date: m.date || '', status: m.status || '' } : null,
      staleDays: null, stale: false, isAchievement: false, label: 'declared (typed, not measured)', cleanRun: null,
      note: `Recorded by hand on the workspace, not from a test. ${why}`,
      typedMinutes: num(typed), conflictsWithTyped: false,
    };
  }
  return {
    minutes: null, state: 'unmeasured', source: null, test: null,
    echoTest: m ? { id: m.id || '', name: m.name || '', date: m.date || '', status: m.status || '' } : null,
    staleDays: null, stale: false, isAchievement: false, label: 'unmeasured', cleanRun: null,
    note: why, typedMinutes: null, conflictsWithTyped: false,
  };
}

const looksLikeSlot = (s) => !!s && typeof s === 'object'
  && ['measured', 'declared', 'unmeasured'].includes(s.state);

/**
 * Normalise whatever `posture` carries into the contract shape.
 *
 * Order of preference:
 *   1. `posture.numbers` — the server's own measuredNumbers() result. Render it.
 *   2. `posture.rta` / `posture.rpa` — a slot-shaped variant.
 *   3. derive from `posture.measured` + `posture.declared`, applying the same
 *      rule locally. This branch is the fallback for an older server, and it
 *      degrades to "recorded by hand", never to the old "measured" claim.
 */
export function fromPosture(posture, workspaceObjectives = null) {
  const p = posture || {};

  // 1. the server already did this work.
  const n = p.numbers;
  if (n && looksLikeSlot(n.rta) && looksLikeSlot(n.rpa)) {
    return {
      rta: n.rta,
      rpa: n.rpa,
      target: n.target || { rtoMinutes: null, rpoMinutes: null, approved: false },
      verdict: n.verdict || p.verdictDetail || { rto: 'unknown', rpo: 'unknown', overall: 'unknown', why: '' },
      warnings: Array.isArray(n.warnings) ? n.warnings : (Array.isArray(p.warnings) ? p.warnings : []),
      evidence: n.evidence || null,
      lastAttempt: p.lastAttempt || n.evidence?.lastAttempt || null,
    };
  }

  // 2 / 3. older or partial responses.
  const declared = p.declared || {};
  const o = workspaceObjectives || {};
  const typedRta = declared.rtaMinutes ?? o.rtaMinutes;
  const typedRpa = declared.rpaMinutes ?? o.rpaMinutes;
  const target = {
    rtoMinutes: num(p.objectives?.rtoMinutes ?? o.rtoMinutes),
    rpoMinutes: num(p.targetRpoMinutes ?? p.objectives?.rpoMinutes ?? o.rpoMinutes),
    approved: !!(p.objectives?.approved ?? o.approved),
  };

  const rta = looksLikeSlot(p.rta) ? p.rta : slotFromLegacy(p.measured, 'rtaMinutes', typedRta);
  const rpa = looksLikeSlot(p.rpa) ? p.rpa : slotFromLegacy(p.measured, 'rpaMinutes', typedRpa);

  const judge = (slot, t) => {
    if (slot.state !== 'measured' || slot.minutes === null || t === null) return 'unknown';
    return slot.minutes <= t ? 'met' : 'missed';
  };
  const sv = p.verdictDetail && typeof p.verdictDetail === 'object' ? p.verdictDetail : null;
  const rtoV = sv?.rto || judge(rta, target.rtoMinutes);
  const rpoV = sv?.rpo || judge(rpa, target.rpoMinutes);
  let overall = sv?.overall || 'unknown';
  if (!sv?.overall) {
    if (rtoV === 'missed' || rpoV === 'missed') overall = 'missed';
    else if (rtoV === 'met' && rpoV === 'met') overall = 'met';
    else if (rtoV === 'met' || rpoV === 'met') overall = 'partial';
  }
  rta.isAchievement = rtoV === 'met';
  rpa.isAchievement = rpoV === 'met';
  return {
    rta, rpa, target,
    verdict: { rto: rtoV, rpo: rpoV, overall, why: sv?.why || '' },
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    evidence: null,
    lastAttempt: p.lastAttempt || null,
  };
}

/**
 * The headline word for a service/workspace verdict — never overstated.
 * 'met' says "measured" out loud, because by the contract it can only be
 * reached when BOTH numbers came from a passed test.
 */
export const VERDICT_WORD = Object.freeze({
  met: 'Objectives met — measured',
  missed: 'Objectives missed — measured',
  partial: 'Partly measured',
  unknown: 'Not measured yet',
  // tolerated aliases from older/other producers
  unmeasured: 'Not measured yet',
  unproven: 'Not measured yet',
});
export const VERDICT_TONE = Object.freeze({
  met: 'ok', missed: 'err', partial: 'warn', unknown: 'muted',
  unmeasured: 'muted', unproven: 'muted',
});
