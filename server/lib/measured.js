// The single source of truth for every RTA/RPA number the product renders, and
// for the severity of every risk finding.
//
// The rule, from the product's own doctrine (12-testing-program.md:77):
//
//   RTA = T1 - T0, where T1 is the moment the L6 functional success bar passes.
//   A test that did not pass never reached L6, so IT HAS NO RTA. It has a time
//   to failure.
//
// So: a number is MEASURED only when it came from a test whose status is
// 'passed' AND that test directly covers the subject. A hand-typed number in
// Settings is DECLARED, never measured — it may be shown, never as an
// achievement. Every number offered as evidence carries the test id, name, date
// and status that produced it; a number with no provenance is not evidence.
//
// Contract (consumed by other agents' code): docs/measured-numbers.md
// Pure functions: no store access, no I/O, no throwing on malformed input.
//
// The "covers" predicate — the load-bearing half of the rule above — is NOT
// defined here. It used to be, and `web/js/measured.js` defined it a second
// time, and the two disagreed: this file treated "a step of the test's runbook
// names this component" as DIRECT, the browser file explicitly did not. Since
// the deployment-order generator tags nearly every component onto nearly every
// step, that made one passed test measure the whole workspace (journey report
// problem 10). There is now ONE definition, in `web/js/coverage.js`, which both
// runtimes load — that directory is the only one the browser can fetch from and
// Node can import from without a build step. Read its header for the semantics
// and the reasoning; `test/measured-coverage.test.js` fails if the two ever
// diverge again.

import {
  coverageOf as sharedCoverageOf,
  criticalSet,
  COVERAGE_NOTE,
  MEASURED_ELIGIBLE,
} from '../../web/js/coverage.js';

export {
  COVERAGE_LEVELS, COVERAGE_NOTE, MEASURED_ELIGIBLE, criticalSet,
} from '../../web/js/coverage.js';

export const DEFAULT_STALE_AFTER_DAYS = 180;

// ------------------------------------------------------- whose objective is it
//
// A target is a COMMITMENT, and a commitment belongs to somebody. v0.7 gave a
// service its own `objectives` block — the one that carries `approved: true`
// and `source: "BIA 2026-03"` — and every consumer went on judging that service
// against the workspace's unapproved proposal. That is wrong in both
// directions: it told an auditor the tolerated data loss was 30 minutes when
// the signed BIA says 15, and it judged a dev environment against production's
// approved business commitment, which the lab has never been given.
//
// Resolution order: the scoped SERVICE, then the scoped ENVIRONMENT, then the
// workspace. Two rules this will not bend, and neither may a caller:
//
//   1. A scope with NO objective of its own does not inherit one. `level`
//      becomes 'none', both numbers stay null, and no verdict is reached
//      against a number that was never that scope's commitment. The workspace
//      figure is still carried, named as the workspace's.
//   2. Where the scoped objective and the workspace objective DISAGREE, both
//      are carried and the disagreement is reported. Silently resolving it is
//      how the wrong number reaches a board.
//
// This function answers with DATA only. The sentences an export prints beside
// the number are composed by the renderer that prints them
// (`xlsx-gen.js:resolveObjectives`, whose object is a valid override here);
// `test/objective-scope.test.js` pins the two to the same answer.
export function objectiveFor({
  workspace, services, environments, serviceId, envId,
} = {}) {
  const wsObj = workspace?.objectives && typeof workspace.objectives === 'object' ? workspace.objectives : {};
  const has = (o) => num(o?.rtoMinutes) !== null || num(o?.rpoMinutes) !== null;
  const wsNumbers = {
    rtoMinutes: num(wsObj.rtoMinutes),
    rpoMinutes: num(wsObj.rpoMinutes),
    approved: !!wsObj.approved,
  };
  const base = {
    ...wsNumbers,
    source: str(wsObj.source),
    level: 'workspace',
    owner: 'the workspace',
    none: false,
    fromWorkspace: true,
    workspace: wsNumbers,
    conflict: null,
  };

  const envList = arr(environments).length ? arr(environments) : arr(workspace?.environments);
  const svc = serviceId ? arr(services).find((s) => str(s?.id) === str(serviceId)) || null : null;
  const env = envId ? envList.find((e) => str(e?.id) === str(envId)) || null : null;
  if (!svc && !env) return base;

  const subject = svc
    ? { o: svc.objectives, level: 'service', owner: `${str(svc.name) || str(svc.id)} service` }
    : { o: env.objectives, level: 'environment', owner: `${str(env.name) || str(env.slug) || str(env.id)} environment` };

  // Rule 1: no objective of its own, so no target — not the workspace's.
  if (!has(subject.o)) {
    return {
      ...base,
      rtoMinutes: null,
      rpoMinutes: null,
      approved: false,
      source: '',
      level: 'none',
      owner: subject.owner,
      none: true,
      fromWorkspace: false,
    };
  }

  const rto = num(subject.o.rtoMinutes);
  const rpo = num(subject.o.rpoMinutes);
  // Rule 2: a disagreement is reported, never resolved here.
  const differs = (wsNumbers.rtoMinutes !== null && rto !== null && wsNumbers.rtoMinutes !== rto)
    || (wsNumbers.rpoMinutes !== null && rpo !== null && wsNumbers.rpoMinutes !== rpo);
  const summary = [
    wsNumbers.rtoMinutes !== null && wsNumbers.rtoMinutes !== rto ? `RTO ${wsNumbers.rtoMinutes} vs ${rto} min` : '',
    wsNumbers.rpoMinutes !== null && wsNumbers.rpoMinutes !== rpo ? `RPO ${wsNumbers.rpoMinutes} vs ${rpo} min` : '',
  ].filter(Boolean).join(' · ');
  return {
    ...base,
    rtoMinutes: rto,
    rpoMinutes: rpo,
    approved: !!subject.o.approved,
    source: str(subject.o.source),
    level: subject.level,
    owner: subject.owner,
    none: false,
    fromWorkspace: false,
    conflict: differs ? { ...wsNumbers, summary } : null,
  };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const lower = (v) => str(v).toLowerCase();
const capFirst = (v) => {
  const s = str(v);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
};

const MS_PER_DAY = 86400000;

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function staleAfterDaysFor(workspace, override) {
  const explicit = num(override);
  if (explicit !== null && explicit > 0) return explicit;
  const fromObjectives = num(workspace?.objectives?.staleAfterDays);
  if (fromObjectives !== null && fromObjectives > 0) return fromObjectives;
  const fromWorkspace = num(workspace?.staleAfterDays);
  if (fromWorkspace !== null && fromWorkspace > 0) return fromWorkspace;
  return DEFAULT_STALE_AFTER_DAYS;
}

// --------------------------------------------------------------- test shapes
//
// Tests arrive either as raw store records (results.rtaMinutes) or as the
// flattened objects service.js builds (rtaMinutes at the top level). Normalise
// both so every consumer sees one shape.
function normalizeTest(t) {
  if (!t || typeof t !== 'object') return null;
  const results = t.results && typeof t.results === 'object' ? t.results : {};
  const rta = num(t.rtaMinutes) !== null ? num(t.rtaMinutes) : num(results.rtaMinutes);
  const rpa = num(t.rpaMinutes) !== null ? num(t.rpaMinutes) : num(results.rpaMinutes);
  const cleanRun = t.cleanRun !== undefined ? !!t.cleanRun : !!results.cleanRun;
  return {
    id: str(t.id),
    name: str(t.name) || str(t.id) || '(unnamed test)',
    type: str(t.type),
    status: lower(t.status) || 'planned',
    date: str(t.date),
    runbookId: str(t.runbookId),
    rtaMinutes: rta,
    rpaMinutes: rpa,
    cleanRun,
    appTests: arr(t.appTests).filter(Boolean),
    componentIds: [
      ...arr(t.componentIds).map(str),
      ...(t.componentId ? [str(t.componentId)] : []),
    ].filter(Boolean),
    findings: arr(t.findings).filter(Boolean),
    raw: t,
  };
}

const provenance = (t, covers) => (t ? {
  id: t.id, name: t.name, date: t.date || null, status: t.status,
  covers: covers || null, cleanRun: t.cleanRun,
} : null);

// ------------------------------------------------------------------ coverage
//
// The definition lives in web/js/coverage.js so the server and the browser
// cannot answer differently (see the file header above, and that file's for the
// semantics). This is a thin re-export that accepts the normalised test shape
// this module works in as well as a raw store record.
//
//   direct       — the TEST names the subject: an appTests[] entry for it, or a
//                  componentIds/componentId entry. The only measured-eligible
//                  answer.
//   runbook-step — a step of the runbook the test executed names the subject.
//                  A procedure that touched it, not a measurement of it.
//   closure      — the test names something in the subject's dependency closure.
//   runbook      — the test merely shares a runbook with the subject.
//   none         — no relationship.
//
// For the workspace subject (componentId null) a test is 'direct' only when its
// evidence is workspace-scoped — it named no components (a whole-estate
// exercise) or it named every component in the workspace's critical set.
// Anything else is 'scoped': evidence about the components it names, never a
// workspace-level number. See the coverage.js header for why.
export function coverageOf(test, componentId, options = {}) {
  const t = test && test.raw !== undefined ? test.raw : test;
  if (!t) return 'none';
  return sharedCoverageOf(t, componentId, options);
}

// The per-component result inside a test, when it recorded one.
function appTestResultFor(test, componentId) {
  if (!componentId) return null;
  const hit = test.appTests.find((a) => str(a?.componentId) === str(componentId));
  return hit ? (lower(hit.result) || null) : null;
}

// ------------------------------------------------------------- the numbers

const emptyEntry = (note) => ({
  minutes: null,
  state: 'unmeasured',
  source: null,
  test: null,
  staleDays: null,
  stale: false,
  isAchievement: false,
  label: 'unmeasured',
  note: note || 'Not measured: no passed test has produced this number.',
});

const LABELS = {
  measured: 'measured',
  declared: 'declared (typed, not measured)',
  unmeasured: 'unmeasured',
};

export function formatNumber(entry, opts = {}) {
  const unit = opts.unit || 'min';
  if (!entry || entry.minutes === null) return 'unmeasured';
  if (entry.state === 'measured') {
    const t = entry.test;
    const when = t ? `${t.name}${t.date ? `, ${t.date}` : ''}` : 'a passed test';
    return `${entry.minutes} ${unit} — measured (${when})${entry.stale ? ` · evidence is ${entry.staleDays} days old` : ''}`;
  }
  if (entry.state === 'declared') {
    return `${entry.minutes} ${unit} — declared (typed in Settings, not linked to any passed test)`;
  }
  return `${entry.minutes} ${unit} — unmeasured`;
}

/**
 * measuredNumbers(workspace, tests, componentId = null, options = {})
 *
 * `options.target` — optional. The objective this subject is actually committed
 * to, when it is not the workspace's: `{rtoMinutes, rpoMinutes, approved,
 * source, level, owner, none, conflict}`, as returned by `objectiveFor()` (or by
 * `xlsx-gen.js:resolveObjectives`, which is the same rule with the export
 * path's prose attached). Used verbatim; both numbers null means NO verdict, not
 * the workspace's numbers.
 *
 * See docs/measured-numbers.md for the full contract.
 */
export function measuredNumbers(workspace, tests, componentId = null, options = {}) {
  const ws = workspace && typeof workspace === 'object' ? workspace : {};
  const objectives = ws.objectives && typeof ws.objectives === 'object' ? ws.objectives : {};
  const now = toDate(options.now) || new Date();
  const staleAfterDays = staleAfterDaysFor(ws, options.staleAfterDays);
  const warnings = [];

  const all = arr(tests).map(normalizeTest).filter(Boolean);

  // subject
  const components = arr(options.components);
  const component = options.component
    || (componentId ? components.find((c) => str(c?.id) === str(componentId)) : null)
    || null;
  const subjectName = componentId
    ? (str(component?.name) || str(componentId))
    : (str(ws.name) || str(ws.slug) || 'this workspace');
  const subject = {
    kind: componentId ? 'component' : 'workspace',
    componentId: componentId ? str(componentId) : null,
    name: subjectName,
  };

  // ---- scope of the claim (NEW-2) -----------------------------------------
  // For the workspace subject, "what is this number evidence FOR?" is the whole
  // question. The critical set is what a workspace-level claim has to cover;
  // anything in it that no passed test has ever named is the reason a
  // workspace number cannot be presented as the workspace's recovery evidence.
  const newestFirst = [...all].sort((a, b) => str(b.date).localeCompare(str(a.date)) || a.name.localeCompare(b.name));
  const nameOf = (id) => str(components.find((c) => str(c?.id) === str(id))?.name) || str(id);
  const namesFrom = (t) => {
    const ids = [...new Set([
      ...arr(t?.componentIds).map(str),
      ...arr(t?.appTests).map((a) => str(a?.componentId)),
    ].filter(Boolean))];
    return { ids, names: ids.map(nameOf) };
  };
  let scope;
  if (componentId) {
    scope = {
      kind: 'component',
      rule: 'A number is evidence for a component only when the test named that component.',
      criticalKnown: false, criticalTier: null, critical: [], untestedCritical: [],
      claimAllowed: true,
    };
  } else {
    const crit = criticalSet(components);
    const critical = crit.components.map((c) => {
      // A passed test covers a critical component when it names it — or when it
      // names nothing at all, which is a whole-estate exercise and is the one
      // shape of evidence that speaks for every component in the workspace.
      const t = newestFirst.find((x) => x.status === 'passed'
        && (coverageOf(x, c.id) === MEASURED_ELIGIBLE || namesFrom(x.raw).ids.length === 0)) || null;
      return {
        ...c,
        testedBy: t ? provenance(t, namesFrom(t.raw).ids.length ? 'direct' : 'estate-wide') : null,
      };
    });
    const untestedCritical = critical.filter((c) => !c.testedBy).map(({ id, name, tier }) => ({ id, name, tier }));
    scope = {
      kind: 'workspace',
      rule: 'A workspace-level number needs workspace-scoped evidence: a test that named no components (a '
        + 'whole-estate exercise) or one that named every in-scope component at the workspace\'s most critical tier. '
        + 'A test that named components measures THOSE components.',
      criticalKnown: crit.known,
      criticalTier: crit.tier,
      critical,
      untestedCritical,
      claimAllowed: crit.known
        ? untestedCritical.length === 0
        : false,
    };
    if (!crit.known) {
      scope.why = 'No component in this workspace carries a tier, so the critical set cannot be identified and a '
        + 'workspace-level claim cannot be checked against it. Tier the inventory, or quote the component numbers.';
    } else if (untestedCritical.length) {
      warnings.push(
        `Tier ${crit.tier} ${untestedCritical.length > 1 ? 'components' : 'component'} `
        + `${untestedCritical.map((c) => c.name).join(', ')} ${untestedCritical.length > 1 ? 'have' : 'has'} never been `
        + 'covered by a passed test. Until that changes, no number here is this workspace\'s recovery evidence — '
        + 'a passed test on something peripheral is evidence about that thing only.');
    }
  }

  // Annotate every test with its coverage of the subject, newest first.
  const covered = all
    .map((t) => ({ t, covers: coverageOf(t, componentId, options) }))
    .filter((x) => x.covers !== 'none')
    .sort((a, b) => str(b.t.date).localeCompare(str(a.t.date)) || a.t.name.localeCompare(b.t.name));

  const qualifying = [];
  for (const { t, covers } of covered) {
    if (covers !== MEASURED_ELIGIBLE) continue;
    if (t.status !== 'passed') continue;
    const own = appTestResultFor(t, componentId);
    if (own === 'fail') {
      warnings.push(
        `${t.name}${t.date ? ` (${t.date})` : ''} passed overall, but its app test for ${subjectName} FAILED — `
        + 'that test cannot be evidence for this service.');
      continue;
    }
    qualifying.push(t);
  }

  // The newest passed/failed covering test, for "last test" UI only — never a claim.
  const attempt = covered.find(({ t }) => t.status === 'passed' || t.status === 'failed') || null;
  const lastPassed = covered.find(({ t, covers }) => t.status === 'passed' && covers === MEASURED_ELIGIBLE) || null;

  // The loudest lie the product used to tell: a failed run's duration copied
  // into the objectives and rendered green.
  const failedWithNumbers = covered.find(({ t, covers }) =>
    covers === MEASURED_ELIGIBLE && t.status === 'failed' && (t.rtaMinutes !== null || t.rpaMinutes !== null));
  if (failedWithNumbers) {
    const t = failedWithNumbers.t;
    const blocker = t.findings.find((f) => lower(f?.severity) === 'blocker');
    warnings.push(
      `The newest test covering ${subjectName} (${t.name}${t.date ? `, ${t.date}` : ''}) FAILED`
      + `${blocker ? ` with a blocker finding ("${str(blocker.title)}")` : ''} — a failed run has no RTA, `
      + 'only a time to failure. Its numbers are not evidence and must never be labelled measured, achieved or met.');
  }
  for (const { t, covers } of covered) {
    if (covers === MEASURED_ELIGIBLE || t.status !== 'passed') continue;
    if (t.rtaMinutes === null && t.rpaMinutes === null) continue;
    warnings.push(
      `${t.name} passed and carries numbers, but ${COVERAGE_NOTE[covers] || 'it does not name this service'}`
      + ` — inferred, not measured for ${subjectName}.`
      + (covers === 'scoped'
        ? ` It is evidence for ${namesFrom(t.raw).names.join(', ') || 'the components it names'} and should be quoted`
        + ' there, on the component, with the test named.'
        : '')
      + (covers === 'runbook-step'
        ? ' A generated runbook tags nearly every component onto nearly every step, so "the runbook mentions it"'
        + ' cannot make a number evidence.'
        : ''));
  }

  const typed = {
    rta: num(objectives.rtaMinutes),
    rpa: num(objectives.rpaMinutes),
  };

  const buildEntry = (metricKey, typedValue, humanName, noun) => {
    const hit = qualifying.find((t) => t[metricKey] !== null);
    if (hit) {
      const d = toDate(hit.date);
      const staleDays = d ? Math.max(0, Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY)) : null;
      const stale = staleDays !== null && staleDays > staleAfterDays;
      const notes = [`Measured by ${hit.name}${hit.date ? ` on ${hit.date}` : ''} (passed).`];
      if (stale) {
        notes.push(`Evidence is ${staleDays} days old, past the ${staleAfterDays}-day freshness threshold — re-test before quoting it.`);
        warnings.push(`${humanName} evidence for ${subjectName} is ${staleDays} days old (threshold ${staleAfterDays} days) — stale.`);
      }
      if (hit.cleanRun === false) {
        notes.push('The run was NOT clean: the bar was reached only after undocumented manual intervention, so this is not yet a reproducible capability.');
        warnings.push(`${hit.name} reached its success bar but cleanRun is false — the improvisation owes a runbook change or a finding.`);
      }
      if (typedValue !== null && typedValue !== hit[metricKey]) {
        warnings.push(`Settings declares ${humanName} ${typedValue} min, but the measured value from ${hit.name} is ${hit[metricKey]} min — the measured value wins.`);
      }
      return {
        minutes: hit[metricKey],
        state: 'measured',
        source: 'test',
        test: provenance(hit, 'direct'),
        staleDays,
        stale,
        isAchievement: false, // set once the verdict is known
        label: LABELS.measured,
        note: notes.join(' '),
      };
    }
    if (typedValue !== null) {
      warnings.push(
        `${humanName} for ${subjectName} is typed in Settings (${typedValue} min) with no passed test behind it — `
        + 'declared, not measured. It must not be rendered as achieved or as meeting a target.');
      return {
        minutes: typedValue,
        state: 'declared',
        source: 'typed',
        test: null,
        staleDays: null,
        stale: false,
        isAchievement: false,
        label: LABELS.declared,
        note: `Typed in Settings. No passed test has measured ${noun} for ${subjectName}, `
          + 'so this number is not evidence.',
      };
    }
    // Nothing qualified. Say what DID happen, precisely — the previous wording
    // ("the last completed test recorded no value") was false whenever the test
    // recorded a value for a different subject, which is the ordinary case
    // (validation-2 NEW-2, second half).
    const scopedHit = covered.find(({ t, covers }) =>
      covers !== MEASURED_ELIGIBLE && t.status === 'passed' && t[metricKey] !== null) || null;
    const notes = [`No passed test has measured ${noun} for ${subjectName}.`];
    if (scopedHit) {
      const { names } = namesFrom(scopedHit.t.raw);
      notes.push(
        `${scopedHit.t.name}${scopedHit.t.date ? ` (${scopedHit.t.date})` : ''} passed and recorded `
        + `${scopedHit.t[metricKey]} min, but ${names.length ? `it covered ${names.join(', ')}` : COVERAGE_NOTE[scopedHit.covers] || 'it does not cover this subject'}`
        + ` — that is ${names.length ? `a measurement of ${names.length > 1 ? 'those components' : names[0]}` : 'not a measurement of this subject'}, not of ${subjectName}.`);
    } else if (attempt) {
      notes.push(
        `The last completed test (${attempt.t.name}) `
        + `${attempt.t.status === 'failed'
          ? 'failed'
          : (attempt.t[metricKey] !== null
            ? `recorded ${attempt.t[metricKey]} min, but it does not cover ${subjectName}`
            : 'recorded no value')}.`);
    }
    if (scope.kind === 'workspace' && scope.untestedCritical.length) {
      notes.push(
        `${scope.untestedCritical.map((c) => c.name).join(', ')} (Tier ${scope.criticalTier}) `
        + `${scope.untestedCritical.length > 1 ? 'have' : 'has'} never been covered by a passed test.`);
    }
    return emptyEntry(notes.join(' '));
  };

  const rta = buildEntry('rtaMinutes', typed.rta, 'Recovery time (RTA)', 'a recovery time');
  const rpa = buildEntry('rpaMinutes', typed.rpa, 'Recovery point (RPA)', 'a recovery point (data loss)');

  // ---- targets: the BUSINESS objectives decide verdicts; the component's
  // replication capability is an engineering detail, recorded separately.
  const mechanismRpo = num(component?.replication?.rpoMinutes);
  // WHOSE commitment is this judged against?
  //
  // By default the workspace's — the only objective this pure function can see,
  // since services and environments live in stores it is not handed. A caller
  // that has resolved a narrower objective (a service's BIA target, an
  // environment's own — `objectiveFor()` above, or xlsx-gen's prose wrapper
  // around the same rule) passes it as `options.target`, and it is used
  // VERBATIM: this module never re-resolves it, and never falls back to the
  // workspace number behind the caller's back, because "the workspace's number
  // quietly standing in for a service's" is the exact defect the override
  // exists to end. An override cannot make any claim more certain — it decides
  // only WHICH number a measured value is compared with, and a scope with no
  // objective of its own arrives here with both numbers null and gets no
  // verdict at all. What counts as MEASURED is untouched by it.
  const ov = options.target && typeof options.target === 'object' ? options.target : null;
  const target = ov ? {
    rtoMinutes: num(ov.rtoMinutes),
    rpoMinutes: num(ov.rpoMinutes),
    approved: !!ov.approved,
    mechanismRpoMinutes: mechanismRpo,
    rpoSource: 'business',
    // Whose it is, so a renderer can say so without asking a second question.
    // Present ONLY on the override path: an unscoped result keeps the exact
    // shape every existing consumer (and every serialized AI context) has seen.
    level: str(ov.level) || 'scoped',
    owner: str(ov.owner) || 'this scope',
    source: str(ov.source),
    none: !!ov.none || (num(ov.rtoMinutes) === null && num(ov.rpoMinutes) === null),
  } : {
    rtoMinutes: num(objectives.rtoMinutes),
    rpoMinutes: num(objectives.rpoMinutes),
    approved: !!objectives.approved,
    mechanismRpoMinutes: mechanismRpo,
    rpoSource: 'business',
  };
  if (!target.approved && (target.rtoMinutes !== null || target.rpoMinutes !== null)) {
    // Scope-aware: "RTO/RPO are not approved by the business" beside an approved
    // service objective was simply false — it was reading the workspace's
    // approval flag about a number the workspace does not own.
    warnings.push(ov
      ? `${capFirst(target.owner)}'s RTO/RPO are not approved by the business — they are engineering proposals, `
        + 'not commitments.'
      : 'RTO/RPO are not approved by the business — they are engineering proposals, not commitments.');
  }
  if (ov && target.none) {
    warnings.push(
      `${capFirst(target.owner)} has no RTO/RPO of its own, so nothing here is judged against one. `
      + 'The workspace figures are the WORKSPACE\'s commitment, not this scope\'s — a scope that was never given '
      + 'a target cannot have met or missed it.');
  }
  if (ov && ov.conflict) {
    const summary = str(ov.conflict.summary);
    warnings.push(
      `The workspace objective disagrees with ${target.owner}'s${summary ? ` (${summary})` : ''} and nobody has `
      + `reconciled the two. Every verdict below is against ${target.owner}'s`
      + `${target.approved ? ', which is the approved one' : ''}.`);
  }

  const judge = (entry, targetMinutes) => {
    if (entry.state !== 'measured' || entry.minutes === null || targetMinutes === null) return 'unknown';
    return entry.minutes <= targetMinutes ? 'met' : 'missed';
  };
  const rtoVerdict = judge(rta, target.rtoMinutes);
  const rpoVerdict = judge(rpa, target.rpoMinutes);

  // ---- caveats on the evidence itself (validation NEW-10) -------------------
  //
  // A verdict is a comparison of two numbers; whether the number is EVIDENCE is
  // a separate question, and this module's own header says a recovery that is
  // not reproducible is not a capability. Two facts disqualify a number from
  // licensing the words "achieved" / "currently meets", without touching
  // `state` — it WAS measured, and the number stays:
  //
  //   stale            — docs/measured-numbers.md's rendering table already
  //                      forbids "currently meets" on stale evidence.
  //   cleanRun: false  — the bar was reached only after undocumented manual
  //                      intervention. Nobody can repeat that on the day.
  //
  // Both were already in `note` and in `warnings`; the machine-readable flag
  // contradicted the prose in the same payload, and it is the flag that colours
  // tiles and feeds the AI context.
  const caveatsOf = (entry) => {
    if (entry.state !== 'measured') return [];
    const out = [];
    if (entry.stale) out.push('stale');
    if (entry.test && entry.test.cleanRun === false) out.push('not-clean');
    return out;
  };
  const rtaCaveat = caveatsOf(rta).length ? caveatsOf(rta) : null;
  const rpaCaveat = caveatsOf(rpa).length ? caveatsOf(rpa) : null;

  let overall;
  if (rtoVerdict === 'missed' || rpoVerdict === 'missed') overall = 'missed';
  else if (rtoVerdict === 'met' && rpoVerdict === 'met') {
    // 'met-with-caveats' is the fourth value: both numbers ARE inside target,
    // and the evidence behind at least one of them cannot be spoken of in the
    // present tense. It is deliberately NOT 'met' — a consumer that tests for
    // 'met' must not get one here — and deliberately not 'missed', which would
    // claim the numbers were over target when they were not.
    overall = (rtaCaveat || rpaCaveat) ? 'met-with-caveats' : 'met';
  } else if (rtoVerdict === 'met' || rpoVerdict === 'met') overall = 'partial';
  else overall = 'unknown';

  // `isAchievement` is the ONLY flag that permits the word "achieved". The
  // per-metric verdict stays the pure numeric comparison the contract defines
  // (assessment.js and the workbook's tint both rely on that); the caveat is
  // applied here, where the claim is made.
  rta.isAchievement = rtoVerdict === 'met' && !rtaCaveat;
  rpa.isAchievement = rpoVerdict === 'met' && !rpaCaveat;

  const whyParts = [];
  const side = (label, v, entry, tgt) => {
    if (v === 'unknown') {
      whyParts.push(`${label} is ${entry.state === 'declared' ? 'declared but never measured' : (tgt === null ? 'measured but has no approved target' : 'unmeasured')}`);
    } else {
      whyParts.push(`${label} ${v === 'met' ? 'met' : 'MISSED'} (${entry.minutes} vs ${tgt} min)`);
    }
  };
  side('recovery time', rtoVerdict, rta, target.rtoMinutes);
  side('data loss', rpoVerdict, rpa, target.rpoMinutes);
  let why = `${whyParts.join('; ')}.`;
  if (overall === 'met') {
    why += subject.kind === 'workspace'
      ? ' Both objectives were met by a passed test whose scope covers this workspace.'
      : ' Both objectives were met by a passed test that directly covers this service.';
  }
  else if (overall === 'met-with-caveats') {
    // Name the caveat, and refuse the present tense. The sentence used to read
    // "Both objectives were met by a passed test that directly covers this
    // service" beside a note saying the evidence was 684 days old and the run
    // was not clean — the same payload arguing with itself.
    const reasons = [...new Set([...(rtaCaveat || []), ...(rpaCaveat || [])])];
    const bits = reasons.map((r) => (r === 'stale'
      ? `the evidence is ${rta.staleDays ?? rpa.staleDays} days old, past the ${staleAfterDays}-day freshness threshold`
      : 'the run was not clean — the bar was reached only after undocumented manual intervention'));
    why += ` Both numbers were inside target on the day, but ${bits.join(', and ')}.`
      + ' That is a result from a past run, not a capability this system currently has:'
      + ' re-test before anyone says these objectives are met.';
  }
  else if (overall === 'partial') why += ' One objective is unmeasured, so "objectives met" cannot be claimed.';
  else if (overall === 'unknown') why += ' Nothing measured, so there is nothing to judge against the objectives.';

  if (rpoVerdict !== 'unknown' && mechanismRpo !== null && target.rpoMinutes !== null && mechanismRpo !== target.rpoMinutes) {
    why += ` Judged against the BUSINESS RPO of ${target.rpoMinutes} min, not the ${mechanismRpo}-min replication mechanism.`;
  }
  // Name whose commitment this was judged against whenever it was not the
  // workspace's. A verdict that does not say whose target it used is the
  // ambiguity this override exists to remove. Unscoped callers add nothing.
  if (ov) {
    why += target.none
      ? ` ${capFirst(target.owner)} has no objective of its own, so nothing above is judged against one.`
      : ` Judged against ${target.owner}'s objective${target.source ? ` (${target.source})` : ''}`
        + `${target.approved ? ', approved by the business' : ', NOT approved by the business'}.`;
  }

  // What the number that DOES exist is evidence for — named, so a page or an
  // export can say "measured for X" instead of implying it was measured for
  // everything.
  const measuredForTest = (rta.state === 'measured' ? rta.test : null) || (rpa.state === 'measured' ? rpa.test : null);
  if (measuredForTest) {
    const raw = all.find((t) => t.id === measuredForTest.id);
    const { ids, names } = namesFrom(raw?.raw);
    scope.measuredFor = ids.length
      ? { ids, names, label: names.join(', ') }
      : { ids: [], names: [], label: `${subjectName} (whole-estate exercise — the test names no components)` };
  } else {
    scope.measuredFor = null;
  }

  return {
    subject,
    scope,
    rta,
    rpa,
    target,
    verdict: { rto: rtoVerdict, rpo: rpoVerdict, overall, why },
    evidence: {
      staleAfterDays,
      consideredTests: all.length,
      coveringTests: covered.length,
      qualifyingTests: qualifying.length,
      lastPassedTest: lastPassed ? provenance(lastPassed.t, lastPassed.covers) : null,
      lastAttempt: attempt ? {
        ...provenance(attempt.t, attempt.covers),
        rtaMinutes: attempt.t.rtaMinutes,
        rpaMinutes: attempt.t.rpaMinutes,
      } : null,
    },
    warnings: [...new Set(warnings)],
  };
}

// ------------------------------------------------------- shared severity table
//
// Audit R-6: recommend.js:detectGaps() and service.js:computeRisks() judged the
// same conditions differently (tier-0 out of scope was 'high' in one and
// 'blocker' in the other), so two pages showed two severities for one fact.
// This is the ONE table. Both engines call severityFor().

const byTier = (tier, [t0, t1, rest]) => {
  const n = num(tier);
  if (n === null) return rest;
  if (n <= 0) return t0;
  if (n <= 1) return t1;
  return rest;
};

export const RISK_SEVERITY = {
  // scope
  'service-out-of-scope': (c) => (c.scope === 'no'
    ? byTier(c.tier, ['blocker', 'high', 'medium'])
    : byTier(c.tier, ['high', 'medium', 'medium'])),
  'component-out-of-scope': (c) => RISK_SEVERITY['service-out-of-scope'](c),
  'dependency-out-of-scope': (c) => (c.scope === 'no'
    ? byTier(c.tier, ['high', 'high', 'medium'])
    : 'medium'),
  // Audit R-7: the outbound-call target resolver matches on normalised
  // substrings, so "pricing" can hit three components. A finding that asserts a
  // scope problem about the WRONG component is the most expensive kind of wrong,
  // so a low-confidence match may never drive a high-severity row on its own —
  // it is reported one step down, phrased as a possible match, and carries the
  // confidence and the alternatives so a human can confirm it.
  'outbound-target-out-of-scope': (c) => {
    const base = c.critical ? 'high' : 'medium';
    if (c.confidence === 'low') return base === 'high' ? 'medium' : 'low';
    return base;
  },
  // secrets
  'unreplicated-secret': (c) => (c.replicated === 'no'
    ? byTier(c.tier, ['blocker', 'high', 'high'])
    : byTier(c.tier, ['high', 'medium', 'medium'])),
  // hygiene. The SERVICE having no verification means no test of it can ever be
  // more than a judgement call — that is high. A dependency missing one is real
  // but ordinary backlog, and firing it at high once per dependency is how a
  // risk list becomes wallpaper (audit R-2).
  'missing-verification': (c) => (c.isRoot ? 'high' : byTier(c.tier, ['medium', 'low', 'low'])),
  'unlayered-dependency': () => 'medium',
  'replication-undefined': () => 'medium',
  'no-runbook': (c) => (c.namesService === false ? 'medium' : 'high'),
  'no-test-coverage': (c) => (c.anyTest ? 'medium' : 'high'),
  'test-failed': () => 'high',
  'manual-third-party-failover': (c) => (c.critical ? 'blocker' : 'high'),
  'manual-cutover': (c) => (c.onPath || num(c.tier) <= 1 ? 'high' : 'medium'),
  'no-runbook-for-tooling': () => 'medium',
  // structure
  'dangling-dependency': () => 'high',
  'layer-inversion': () => 'high',
  // regional failure modes (audit R-5)
  'quota-capacity-unverified': (c) => byTier(c.tier, ['high', 'medium', 'medium']),
  'irsa-oidc-trust': () => 'high',
  'acm-cert-not-regional': (c) => byTier(c.tier, ['high', 'high', 'medium']),
  'kms-single-region-key': () => 'high',
  'arn-pinned-to-primary': () => 'high',
  // A failover with no way back is a one-way door (02-dr-fundamentals.md:72).
  // No rollback at all on a runbook that moves traffic or promotes data is the
  // serious case; a rollback that exists but names no ACTION that returns the
  // thing it moved is a real but lesser finding — it is at least written down.
  'runbook-without-rollback': (c) => (c.hasRollback ? 'medium' : byTier(c.tier, ['high', 'high', 'medium'])),
  // "Gates, not timers" — a runbook with no gate advances on the clock, which is
  // how a runbook lies to you. Medium: it is a quality defect in a written
  // procedure, not a missing capability.
  'runbook-without-gates': () => 'medium',
  // The gate you read the other gates on. If it is not in scope, every
  // verification in the procedure is a guess (04-restore-layer-cake.md's
  // "verification by dashboard" anti-pattern, now checkable).
  'observability-out-of-scope': (c) => byTier(c.tier, ['high', 'medium', 'medium']),
  // The failover path depends on something the failover scenario may have taken
  // out. "Could you execute the failover with the primary region AND your SSO
  // dark?" — 08-tooling-arc-route53.md's central rule, now enforced.
  'control-plane-dependency-in-failover-path': (c) => byTier(c.tier, ['high', 'high', 'medium']),
  // Two writers. Not a data-LOSS finding — a data-CORRUPTION one (double
  // charges, duplicate settlement files), and unlike downtime it is not undone
  // by bringing the region back.
  'scheduler-double-run': (c) => byTier(c.tier, ['high', 'medium', 'medium']),
  // A capacity failure, not a data one: severity follows the tier and whether
  // the store that absorbs the herd is even in scope (if it is not, the scope
  // rule is already saying something louder about it).
  'cache-cold-start-load': (c) => (c.backingInScope === false ? 'low' : byTier(c.tier, ['high', 'medium', 'low'])),
  // ---- the pre-cutover verification gate --------------------------------
  // These four are workspace- and runbook-level, not component-level, so none of
  // them takes a tier: "this workspace has no success bar" is not a fact about a
  // tier-2 component. They were graded literally in server/routes/recommend.js
  // while this table did not know them (severityFor() answered 'medium' for all
  // four, which is how a blocker could be filed as hygiene); the values here are
  // the ones that were being emitted, so nothing a reader has seen changes.
  //
  // A cutover with no verification gate is a plan that moves live customer
  // traffic onto something unproven. That is the same class as 'rpo-gap' — the
  // promise is already broken before anyone executes — so: blocker, and it is in
  // BLOCKS_RECOVERY below.
  'cutover-without-verification': () => 'blocker',
  // The workspace declares NO pre-cutover checks at all: there is no success bar
  // anywhere, so every runbook that says "verify the success bar" is naming
  // something that does not exist. Blocker for the same reason, one level up.
  'no-pre-cutover-verification': () => 'blocker',
  // A blocking check with no pass criterion is a gate nobody can fail. High, not
  // blocker: the check exists and has an owner, so someone can state the
  // criterion in minutes — unlike the two above, which are a missing capability.
  // Graded like 'test-failed' and 'no-test-coverage' (no test at all), which is
  // the same shape of defect: evidence that cannot settle the question.
  'pre-cutover-check-without-criterion': () => 'high',
  // An unowned check is an unrun check on the day. Medium, matching
  // 'missing-verification' for a non-root and 'runbook-without-gates': a quality
  // defect in a written procedure, and firing it at high once per check is how a
  // risk list becomes wallpaper (audit R-2).
  'pre-cutover-check-without-owner': () => 'medium',
  // The gate EXISTS, is populated and sits in front of the traffic step — and
  // still cannot do its job: every check in it is advisory (so it cannot fail),
  // or the named approval is placed BEFORE it (so it authorised a cutover whose
  // evidence did not exist yet). Graded 'high', not 'blocker': unlike
  // 'cutover-without-verification' nothing is missing, the ordering or the
  // onFail flag is wrong — which is minutes of work by someone who already
  // owns the checks. Same grade, and for the same reason, as
  // 'pre-cutover-check-without-criterion'.
  'cutover-gate-unsound': () => 'high',
  // evidence
  'stale-evidence': (c) => byTier(c.tier, ['high', 'medium', 'medium']),
  'rpo-gap': () => 'blocker',
  'replication-lag-exceeds-mechanism': () => 'medium',
  'rta-gap': () => 'high',
  'unverified-objective': () => 'high',
};

export function severityFor(rule, ctx = {}) {
  const fn = RISK_SEVERITY[rule];
  if (typeof fn !== 'function') return 'medium';
  const out = fn(ctx || {});
  return ['blocker', 'high', 'medium', 'low'].includes(out) ? out : 'medium';
}

// Rules whose finding, left unfixed, actually stops a recovery — used to rank
// the risk list so the actionable things sit above the hygiene backlog.
export const BLOCKS_RECOVERY = new Set([
  'service-out-of-scope', 'component-out-of-scope', 'dependency-out-of-scope',
  'unreplicated-secret', 'manual-third-party-failover', 'outbound-target-out-of-scope',
  'manual-cutover', 'dangling-dependency', 'layer-inversion',
  'quota-capacity-unverified', 'irsa-oidc-trust', 'acm-cert-not-regional',
  'kms-single-region-key', 'arn-pinned-to-primary', 'rpo-gap', 'rta-gap',
  'no-runbook', 'test-failed',
  // A runbook that can reach L7 with no populated verification gate cuts live
  // traffic to something unproven. The recovery it produces cannot be known to
  // have worked, which is the literal sense of "stops a recovery".
  // 'no-pre-cutover-verification' is deliberately NOT here: it is the
  // workspace-level absence of any declared checks, real and blocker-grade, but
  // it is not a specific plan that will execute wrongly — the per-runbook rule
  // above is, and that is the one worth ranking to the top of a list.
  'cutover-without-verification',
  // If the step cannot be executed with the primary region (or the IdP) dark,
  // the recovery does not start. That is a blocker of recovery in the literal
  // sense. The other three new rules are deliberately NOT here:
  // runbook-without-rollback blocks the RETURN trip, scheduler-double-run
  // corrupts AFTER recovery, and cache-cold-start-load degrades it — none of
  // them stops the recovery itself, and inflating this set is how ranking stops
  // meaning anything.
  'control-plane-dependency-in-failover-path',
]);

export default measuredNumbers;
