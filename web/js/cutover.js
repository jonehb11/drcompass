// Pre-cutover verification — ONE definition, loaded by both runtimes.
//
// WHY THIS FILE EXISTS
// --------------------
// The product could already describe the app-level tests you run during a
// recovery *test*. It had no notion of the tests that must pass before you move
// live customer traffic during a real event — the verification gate that sits
// between "the recovery region is up" (L5/L6) and "we move traffic" (L7).
//
// That gate is the artifact a person on a bridge call actually reads: an ordered
// list of checks, grouped by who runs them, each with the pass criterion the
// person who owns the service actually gave you, and a clear mark on which
// failures stop the cutover and which are advisory.
//
// The rule lives in `web/js/` because that is the only directory both runtimes
// load without a build step (same reason as `web/js/coverage.js`): the browser
// fetches it as a static module, Node imports it by relative path from
// `server/routes/recommend.js`. No bundler, no duplicate, nothing to sync.
//
// EVERYTHING HERE IS ADDITIVE. An app test with no `when` is
// 'recovery-test-only' and never appears in a cutover gate, so every workspace
// written before this file existed behaves exactly as it did. Nothing in here
// promotes a legacy test into a gate on its own — a gate has to be declared by
// a human, because the whole point is that somebody took responsibility for it.

export const PRE_CUTOVER_SCHEMA_VERSION = 1;

/* ===========================================================================
 * 1. VOCABULARY
 * =========================================================================*/

/** When a test must run, relative to moving live traffic. */
export const WHEN_VALUES = ['pre-cutover', 'post-cutover', 'recovery-test-only'];
export const WHEN_LABEL = {
  'pre-cutover': 'before traffic moves',
  'post-cutover': 'after traffic moves',
  'recovery-test-only': 'recovery test only',
};
/** Absent ⇒ this. A test nobody classified is not a gate. */
export const DEFAULT_WHEN = 'recovery-test-only';

/** What a failure does to the cutover. */
export const ON_FAIL_VALUES = ['block', 'advise'];
export const ON_FAIL_LABEL = {
  block: 'failure blocks the cutover',
  advise: 'advisory — record it and carry on',
};

/** The gate roles a runbook step can declare. */
export const GATE_KINDS = {
  verification: 'pre-cutover-verification',
  approval: 'cutover-approval',
  traffic: 'traffic-cutover',
  postCutover: 'post-cutover-verification',
};

// Phases: the order a bridge call actually works through the list. Derived from
// the restore layer of the component each check is attached to, because that is
// the one ordering the product already enforces (04-restore-layer-cake.md).
export const PHASES = [
  { id: 'data', rank: 1, label: 'Data & secrets are right', layers: ['L0', 'L1', 'L2', 'L3'] },
  { id: 'apps', rank: 2, label: 'The applications are actually serving', layers: ['L4'] },
  { id: 'edge', rank: 3, label: 'Edge, certificates and partners reachable — without touching DNS', layers: ['L5'] },
  { id: 'business', rank: 4, label: 'A real business transaction, end to end', layers: ['L6'] },
  { id: 'live', rank: 5, label: 'After the flip — on live traffic', layers: ['L7'] },
];
const PHASE_BY_LAYER = (() => {
  const m = {};
  for (const p of PHASES) for (const l of p.layers) m[l] = p;
  return m;
})();
export const phaseById = (id) => PHASES.find((p) => p.id === id) || PHASES[3];

/* ===========================================================================
 * 2. NORMALIZATION — the additive fields, read defensively
 * =========================================================================*/

const str = (v) => (v === null || v === undefined ? '' : String(v));
const trimmed = (v) => str(v).trim();
const num = (v) => (Number.isFinite(Number(v)) && str(v) !== '' ? Number(v) : null);
const arr = (v) => (Array.isArray(v) ? v : []);

export const slug = (s) => trimmed(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Normalize a `when` value; anything unrecognized falls back to the default. */
export function whenOf(a) {
  const w = trimmed(a?.when).toLowerCase();
  if (WHEN_VALUES.includes(w)) return w;
  // A couple of spellings people actually type.
  if (/^pre[-_ ]?cut/.test(w)) return 'pre-cutover';
  if (/^post[-_ ]?cut/.test(w)) return 'post-cutover';
  return DEFAULT_WHEN;
}

/**
 * Does a failure block the cutover?
 * Explicit `onFail` wins. Absent, we fall back to the legacy `critical` flag —
 * which is the closest thing the old shape had to this question — but only for
 * tests that have been classified as cutover gates at all.
 */
export function onFailOf(a) {
  const f = trimmed(a?.onFail).toLowerCase();
  if (f === 'block' || f === 'blocking' || f === 'blocker') return 'block';
  if (f === 'advise' || f === 'advisory' || f === 'warn') return 'advise';
  return a?.critical ? 'block' : 'advise';
}

export const isBlocking = (a) => onFailOf(a) === 'block';

/**
 * Fill the additive fields on an app test without changing anything that is
 * already there. Safe to run on a legacy app test: the result is a superset.
 */
export function normalizeAppTest(a = {}, defaults = {}) {
  const when = a.when === undefined && defaults.when ? whenOf(defaults) : whenOf(a);
  return {
    // --- the shape that already existed -------------------------------------
    name: trimmed(a.name),
    command: str(a.command),
    expected: str(a.expected),
    componentId: trimmed(a.componentId),
    critical: !!a.critical,
    result: a.result === 'pass' || a.result === 'fail' ? a.result : null,
    // --- additive -----------------------------------------------------------
    when,
    owner: trimmed(a.owner) || trimmed(defaults.owner),
    proves: trimmed(a.proves) || trimmed(a.hint),
    onFail: onFailOf(a),
    evidence: trimmed(a.evidence),
    estMinutes: num(a.estMinutes),
    source: trimmed(a.source) || trimmed(defaults.source),
    serviceId: trimmed(a.serviceId) || trimmed(defaults.serviceId),
  };
}

/** The identity of a check across test records: its name + what it is attached to. */
export const testKey = (a) => `${slug(a?.name) || 'unnamed'}::${trimmed(a?.componentId) || trimmed(a?.serviceId) || '*'}`;

export const ownerKeyOf = (a) => slug(a?.owner) || 'unassigned';
export const ownerLabelOf = (a) => trimmed(a?.owner) || 'Unassigned — nobody has been named for this';

/* ===========================================================================
 * 3. SCOPE — what "this service, in this environment" means
 * =========================================================================*/

/** Cycle-safe dependency closure. Mirrors lib/xlsx-gen.js serviceClosure(). */
export function componentClosure(components, rootId) {
  const all = arr(components);
  const byId = new Map(all.map((c) => [c.id, c]));
  if (!byId.has(rootId)) return { ids: [], root: null, depsCount: 0, dependentsCount: 0 };
  const seen = new Set([rootId]);
  const deps = [];
  const queue = [rootId];
  while (queue.length) {
    const cur = byId.get(queue.shift());
    for (const dep of arr(cur?.dependsOn)) {
      if (seen.has(dep) || !byId.has(dep)) continue;
      seen.add(dep); deps.push(dep); queue.push(dep);
    }
  }
  const dependents = [];
  for (const c of all) {
    if (c.id === rootId || seen.has(c.id)) continue;
    if (arr(c.dependsOn).includes(rootId)) { seen.add(c.id); dependents.push(c.id); }
  }
  return { ids: [rootId, ...deps, ...dependents], root: byId.get(rootId), depsCount: deps.length, dependentsCount: dependents.length };
}

/**
 * Resolve the scope of a checklist.
 *
 * `serviceId` is a v0.7 service (svc_*) when the services collection exists;
 * `componentId` is the older one-component-is-the-service sense that the Service
 * DR Profile page uses. Both are supported, because both are what a user means
 * when they say "this service", and neither is guaranteed to be present.
 */
export function resolveScope({ workspace, components = [], services = [] } = {}, opts = {}) {
  const comps = arr(components);
  const svcs = arr(services);
  const envs = arr(workspace?.environments);
  const wantEnv = trimmed(opts.envId);
  const env = envs.find((e) => e.id === wantEnv || e.slug === wantEnv) || null;
  const envId = env ? env.id : wantEnv;

  const out = {
    serviceId: '', serviceName: '', componentId: '', componentName: '',
    envId: envId || '', envName: env ? (env.name || env.slug || env.id) : '',
    componentIds: [], componentCount: 0, kind: 'workspace',
    depsCount: null, dependentsCount: null, unknown: '',
  };

  const inEnv = (c) => !envId || !c.envId || c.envId === envId;

  const wantSvc = trimmed(opts.serviceId);
  if (wantSvc) {
    const svc = svcs.find((s) => s.id === wantSvc || s.slug === wantSvc) || null;
    if (!svc) { out.unknown = `no service '${wantSvc}' in this workspace`; }
    else {
      out.kind = 'service';
      out.serviceId = svc.id;
      out.serviceName = svc.name || svc.slug || svc.id;
      if (!out.envId && svc.envId) {
        out.envId = svc.envId;
        const e2 = envs.find((e) => e.id === svc.envId);
        out.envName = e2 ? (e2.name || e2.slug || e2.id) : '';
      }
      const ids = new Set(arr(svc.componentIds).map(trimmed).filter(Boolean));
      for (const c of comps) if (c.serviceId === svc.id) ids.add(c.id);
      out.componentIds = comps.filter((c) => ids.has(c.id) && inEnv(c)).map((c) => c.id);
      out.componentCount = out.componentIds.length;
      return out;
    }
  }

  const wantCmp = trimmed(opts.componentId);
  if (wantCmp) {
    const closure = typeof opts.closure === 'function'
      ? opts.closure(comps, wantCmp)
      : componentClosure(comps, wantCmp);
    const root = comps.find((c) => c.id === wantCmp);
    if (!root) { out.unknown = `no component '${wantCmp}' in this workspace`; }
    else {
      out.kind = 'component';
      out.componentId = root.id;
      out.componentName = root.name || root.id;
      if (!out.envId && root.envId) {
        out.envId = root.envId;
        const e3 = envs.find((e) => e.id === root.envId);
        out.envName = e3 ? (e3.name || e3.slug || e3.id) : '';
      }
      if (root.serviceId) {
        out.serviceId = root.serviceId;
        const svc = svcs.find((s) => s.id === root.serviceId);
        if (svc) out.serviceName = svc.name || svc.slug || svc.id;
      }
      const ids = opts.includeDependencies === false ? [root.id] : arr(closure?.ids);
      out.componentIds = comps.filter((c) => ids.includes(c.id) && inEnv(c)).map((c) => c.id);
      out.componentCount = out.componentIds.length;
      out.depsCount = num(closure?.depsCount);
      out.dependentsCount = num(closure?.dependentsCount);
      return out;
    }
  }

  out.componentIds = comps.filter(inEnv).map((c) => c.id);
  out.componentCount = out.componentIds.length;
  return out;
}

/* ===========================================================================
 * 4. THE CHECKLIST
 * =========================================================================*/

function phaseFor(a, component) {
  if (whenOf(a) === 'post-cutover') return phaseById('live');
  const layer = trimmed(component?.restoreLayer);
  return PHASE_BY_LAYER[layer] || phaseById('business');
}

/**
 * Build the ordered verification list for a scope.
 *
 * @param {object} data  {workspace, components, tests, services}
 * @param {object} opts  {serviceId, componentId, envId, when, includeDependencies, closure}
 * @returns {object} see the shape in INTEGRATION-NOTES.md ("Pre-cutover checklist").
 */
export function buildPreCutoverChecklist(data = {}, opts = {}) {
  const components = arr(data.components);
  const tests = arr(data.tests);
  const byId = new Map(components.map((c) => [c.id, c]));
  const when = WHEN_VALUES.includes(opts.when) ? opts.when : 'pre-cutover';
  const scope = resolveScope(data, opts);
  const scopeIds = new Set(scope.componentIds);
  const scoped = scope.kind !== 'workspace';

  const warnings = [];
  if (scope.unknown) warnings.push(scope.unknown);

  const inScope = (a, t) => {
    if (!scoped) return true;
    const cid = trimmed(a.componentId);
    if (cid) return scopeIds.has(cid);
    if (trimmed(a.serviceId)) return trimmed(a.serviceId) === scope.serviceId;
    // Unattached check: it belongs to the scope only if its parent record does.
    const tc = trimmed(t.componentId);
    if (tc) return scopeIds.has(tc);
    if (trimmed(t.serviceId)) return trimmed(t.serviceId) === scope.serviceId;
    // A workspace-level record's unattached check is a whole-system business
    // check — include it, and say so, rather than silently dropping the one
    // test that proves the business transaction.
    return true;
  };

  const items = new Map();
  let unclassified = 0;
  let outOfEnv = 0;

  for (const t of tests) {
    const tEnv = trimmed(t.envId);
    if (scope.envId && tEnv && tEnv !== scope.envId) { outOfEnv += 1; continue; }
    for (const raw of arr(t.appTests)) {
      const a = normalizeAppTest(raw);
      if (!a.name) continue;
      if (a.when === DEFAULT_WHEN) { if (inScope(a, t)) unclassified += 1; continue; }
      if (a.when !== when) continue;
      if (!inScope(a, t)) continue;

      const key = testKey(a);
      const comp = byId.get(a.componentId) || null;
      const ph = phaseFor(a, comp);
      const run = {
        testId: trimmed(t.id), testName: trimmed(t.name) || '(unnamed test)',
        date: trimmed(t.date), status: trimmed(t.status), result: a.result,
      };
      const prev = items.get(key);
      if (prev) {
        prev.from.push(run);
        // Keep the freshest evidence, and prefer the fields that are filled in.
        if (!prev.lastRun || (run.date && run.date > (prev.lastRun.date || ''))) prev.lastRun = run;
        for (const f of ['command', 'expected', 'proves', 'evidence', 'owner', 'source']) if (!prev[f] && a[f]) prev[f] = a[f];
        if (a.onFail === 'block') { prev.onFail = 'block'; prev.blocking = true; }
        if (a.critical) prev.critical = true;
        if (prev.estMinutes === null) prev.estMinutes = a.estMinutes;
        continue;
      }
      items.set(key, {
        key,
        order: 0,
        name: a.name,
        proves: a.proves,
        command: a.command,
        expected: a.expected,
        evidence: a.evidence,
        owner: ownerLabelOf(a),
        ownerKey: ownerKeyOf(a),
        ownerNamed: !!a.owner,
        when: a.when,
        onFail: a.onFail,
        blocking: isBlocking(a),
        critical: a.critical,
        componentId: a.componentId,
        componentName: comp ? (comp.name || comp.id) : (a.componentId || ''),
        layer: comp ? trimmed(comp.restoreLayer) : '',
        phase: ph.id,
        phaseLabel: ph.label,
        phaseRank: ph.rank,
        estMinutes: a.estMinutes,
        source: a.source,
        from: [run],
        lastRun: run.result ? run : null,
      });
    }
  }

  const list = [...items.values()].sort((x, y) =>
    x.phaseRank - y.phaseRank
    || (y.blocking - x.blocking)
    || (y.critical - x.critical)
    || x.name.localeCompare(y.name));
  list.forEach((it, i) => {
    it.order = i + 1;
    // Proven only by a run that passed inside a test record that itself passed —
    // the same honesty rule the measured numbers use.
    it.proven = !!(it.lastRun && it.lastRun.result === 'pass' && it.lastRun.status === 'passed');
    it.failedLastRun = !!(it.lastRun && it.lastRun.result === 'fail');
  });

  // Group by who runs it: the bridge call hands each group to one person.
  const groupMap = new Map();
  for (const it of list) {
    if (!groupMap.has(it.ownerKey)) {
      groupMap.set(it.ownerKey, {
        owner: it.owner, ownerKey: it.ownerKey, named: it.ownerNamed,
        items: [], blocking: 0, advisory: 0, estMinutes: 0, firstOrder: it.order,
      });
    }
    const g = groupMap.get(it.ownerKey);
    g.items.push(it);
    if (it.blocking) g.blocking += 1; else g.advisory += 1;
    if (it.estMinutes) g.estMinutes += it.estMinutes;
  }
  const groups = [...groupMap.values()].sort((a, b) => {
    if (a.ownerKey === 'unassigned') return 1;
    if (b.ownerKey === 'unassigned') return -1;
    return a.firstOrder - b.firstOrder;
  });

  const blocking = list.filter((i) => i.blocking);
  const advisory = list.filter((i) => !i.blocking);
  const byPhase = PHASES.map((p) => ({
    phase: p.id, label: p.label,
    items: list.filter((i) => i.phase === p.id).map((i) => i.key),
  })).filter((p) => p.items.length);

  if (!list.length) {
    warnings.push(scoped
      ? `No ${when} checks are recorded for ${scope.serviceName || scope.componentName || 'this scope'}. `
        + 'Until somebody writes down what must pass, "we verified it" is a feeling — capture them from whoever owns the service.'
      : `No ${when} checks are recorded in this workspace yet.`);
  }
  if (unclassified) {
    warnings.push(`${unclassified} app test${unclassified === 1 ? ' is' : 's are'} in scope but unclassified `
      + '(no `when`), so they are treated as recovery-test-only and are NOT part of this gate. Classify them if they belong here.');
  }
  if (outOfEnv) {
    warnings.push(`${outOfEnv} test record${outOfEnv === 1 ? ' was' : 's were'} skipped: bound to a different environment than `
      + `${scope.envName || scope.envId}. A check proven somewhere else is not a check proven here.`);
  }
  const unowned = list.filter((i) => !i.ownerNamed).length;
  if (unowned) warnings.push(`${unowned} check${unowned === 1 ? ' has' : 's have'} no owner — on the day, an unowned check is an unrun check.`);
  const noCriterion = list.filter((i) => i.blocking && !i.expected).length;
  if (noCriterion) warnings.push(`${noCriterion} blocking check${noCriterion === 1 ? ' has' : 's have'} no pass criterion — a gate nobody can fail is not a gate.`);

  return {
    schemaVersion: PRE_CUTOVER_SCHEMA_VERSION,
    when,
    generatedAt: new Date().toISOString(),
    scope,
    items: list,
    groups,
    byPhase,
    counts: {
      total: list.length,
      blocking: blocking.length,
      advisory: advisory.length,
      owners: groups.length,
      unowned,
      unclassified,
      proven: list.filter((i) => i.proven).length,
      failedLastRun: list.filter((i) => i.failedLastRun).length,
      byOwner: Object.fromEntries(groups.map((g) => [g.ownerKey, g.items.length])),
      byPhase: Object.fromEntries(byPhase.map((p) => [p.phase, p.items.length])),
    },
    totalEstMinutes: list.reduce((s, i) => s + (i.estMinutes || 0), 0),
    warnings,
  };
}

/** Flat rows for an exporter (one row per check, stable column order). */
export function checklistRows(checklist) {
  return arr(checklist?.items).map((i) => ({
    order: i.order,
    phase: i.phase,
    phaseLabel: i.phaseLabel,
    check: i.name,
    proves: i.proves,
    owner: i.owner,
    component: i.componentName,
    componentId: i.componentId,
    layer: i.layer,
    command: i.command,
    passCriterion: i.expected,
    evidence: i.evidence,
    onFail: i.onFail,
    blocking: i.blocking ? 'BLOCKING' : 'advisory',
    estMinutes: i.estMinutes,
    lastResult: i.lastRun ? `${i.lastRun.result || '—'} (${i.lastRun.testName}${i.lastRun.date ? `, ${i.lastRun.date}` : ''})` : 'never run',
    proven: i.proven ? 'yes' : 'no',
    source: i.source,
  }));
}

export const CHECKLIST_COLUMNS = [
  'order', 'phase', 'check', 'proves', 'owner', 'component', 'command',
  'passCriterion', 'evidence', 'blocking', 'estMinutes', 'lastResult', 'source',
];

/** The artifact you hand the person on the bridge call. */
export function checklistToMarkdown(checklist, { title } = {}) {
  const c = checklist || {};
  const s = c.scope || {};
  const name = title || `Pre-cutover verification — ${s.serviceName || s.componentName || 'whole workspace'}${s.envName ? ` (${s.envName})` : ''}`;
  const L = [`# ${name}`, ''];
  L.push(`**Nothing moves traffic until every BLOCKING check below has passed in the recovery region.**`, '');
  L.push(`${c.counts?.blocking || 0} blocking · ${c.counts?.advisory || 0} advisory · ${c.counts?.owners || 0} owner(s)`
    + `${c.totalEstMinutes ? ` · ~${c.totalEstMinutes} min if run in series` : ''}`, '');
  for (const w of arr(c.warnings)) L.push(`> ⚠ ${w}`, '');
  for (const g of arr(c.groups)) {
    L.push(`## ${g.owner}  (${g.blocking} blocking, ${g.advisory} advisory)`, '');
    for (const i of g.items) {
      L.push(`- [ ] **${i.order}. ${i.name}**${i.blocking ? ' — BLOCKING' : ' — advisory'}`);
      if (i.proves) L.push(`      - Proves: ${i.proves}`);
      if (i.componentName) L.push(`      - Component: ${i.componentName}${i.layer ? ` (${i.layer})` : ''}`);
      if (i.command) L.push('      - Run: `' + i.command.replace(/\n+/g, ' ') + '`');
      if (i.expected) L.push(`      - Pass: ${i.expected}`);
      if (i.evidence) L.push(`      - Record: ${i.evidence}`);
      if (i.lastRun) L.push(`      - Last run: ${i.lastRun.result || '—'} in ${i.lastRun.testName}${i.lastRun.date ? ` (${i.lastRun.date})` : ''}`);
      L.push('');
    }
  }
  L.push('## Gate', '');
  L.push('- [ ] Every BLOCKING check above passed, with evidence recorded.');
  L.push('- [ ] Named decision-maker approves the cutover in writing, with the reason.');
  L.push('- [ ] Only then: run the L7 traffic block.');
  L.push('');
  return L.join('\n');
}

/** The compact shape embedded in a runbook step / Region-switch plan block. */
export function stepTestsFromChecklist(checklist) {
  return arr(checklist?.items).map((i) => ({
    key: i.key,
    name: i.name,
    owner: i.owner,
    proves: i.proves,
    command: i.command,
    expected: i.expected,
    evidence: i.evidence,
    onFail: i.onFail,
    componentId: i.componentId,
    componentName: i.componentName,
    phase: i.phase,
  }));
}

/** One-line summary of a gate's tests, for a step's verify/pass fields. */
export function gateSummary(tests) {
  const list = arr(tests);
  if (!list.length) return '';
  const blocking = list.filter((t) => onFailOf(t) === 'block');
  const owners = [...new Set(list.map((t) => trimmed(t.owner)).filter(Boolean))];
  return `${blocking.length} blocking check${blocking.length === 1 ? '' : 's'} of ${list.length}`
    + `${owners.length ? ` across ${owners.length} owner${owners.length === 1 ? '' : 's'} (${owners.slice(0, 4).join(', ')}${owners.length > 4 ? '…' : ''})` : ''}`;
}

/* ===========================================================================
 * 5. RUNBOOK GATING — L7 is not reachable without L6
 * =========================================================================*/

const stepGateKind = (s) => trimmed(s?.gateKind);
export { stepGateKind };

// Not every L7 step moves traffic — "monitor the execution report" and
// "communications" are L7 too, and treating them as cutovers would demand an
// approval in front of a status update. A traffic step is one that is TAGGED as
// one, is a traffic block type, or (for runbooks written before this existed)
// is an L7 step that says in its title that it moves traffic.
const MOVES_TRAFFIC_RE = /\bcut[- ]?over|\bflip\b|\bdns\b|routing[- ]control|health[- ]check|(move|shift|switch|redirect)s? (the )?(live )?traffic/i;
export function isTrafficStep(s) {
  const kind = stepGateKind(s);
  if (kind === GATE_KINDS.traffic) return true;
  if (kind) return false; // explicitly tagged as something else
  if (['route53-health-check', 'routing-control'].includes(trimmed(s?.blockType))) return true;
  return trimmed(s?.layer) === 'L7' && MOVES_TRAFFIC_RE.test(`${str(s?.title)} ${str(s?.name)}`);
}

export const isVerificationStep = (s) => stepGateKind(s) === GATE_KINDS.verification;
export const isApprovalStep = (s) => stepGateKind(s) === GATE_KINDS.approval
  || (trimmed(s?.blockType) === 'manual-approval' && /cutover|traffic/i.test(str(s?.name) + str(s?.title)));

/** Legacy steps: what this step LOOKS like, offered to the user, never applied silently. */
export function inferGateKind(s) {
  if (stepGateKind(s)) return stepGateKind(s);
  const text = `${str(s?.title)} ${str(s?.name)}`.toLowerCase();
  if (trimmed(s?.layer) === 'L6' && /success bar|verif|functional|business transaction/.test(text)) return GATE_KINDS.verification;
  if (/approval|authorize|authorise|go\/no-go/.test(text) && /cutover|traffic/.test(text)) return GATE_KINDS.approval;
  if (isTrafficStep(s)) return GATE_KINDS.traffic;
  return '';
}

/**
 * Audit one runbook's cutover gate.
 *
 * The rule, in one sentence: an L7 step must be preceded by a
 * pre-cutover-verification step that CONTAINS real tests, and by an approval.
 * A verification step with no tests in it is a placeholder, and a placeholder is
 * how a traffic cutover happens on vibes.
 *
 * @returns {{ok, findings, verificationSteps, approvalSteps, trafficSteps, blockedIndexes, gateTests}}
 */
export function auditCutoverGate(rb) {
  const steps = arr(rb?.steps);
  const findings = [];
  const verificationSteps = [];
  const approvalSteps = [];
  const trafficSteps = [];

  steps.forEach((s, i) => {
    if (isVerificationStep(s)) verificationSteps.push({ index: i, step: s, tests: arr(s.tests) });
    else if (isApprovalStep(s)) approvalSteps.push({ index: i, step: s });
    if (isTrafficStep(s)) trafficSteps.push({ index: i, step: s });
  });

  const titleOf = (s, i) => `step ${i + 1} (“${trimmed(s?.title) || trimmed(s?.name) || 'untitled'}”)`;

  for (const v of verificationSteps) {
    const blocking = v.tests.filter((t) => onFailOf(t) === 'block');
    if (!v.tests.length) {
      findings.push({
        severity: 'err', kind: 'empty-gate', index: v.index,
        text: `${titleOf(v.step, v.index)} is marked the pre-cutover verification gate but contains no tests — `
          + 'it is a placeholder. Populate it from the service\'s pre-cutover checks, or the cutover is approved against nothing.',
      });
    } else if (!blocking.length) {
      findings.push({
        severity: 'warn', kind: 'no-blocking-test', index: v.index,
        text: `${titleOf(v.step, v.index)} holds ${v.tests.length} check(s) but none of them blocks the cutover — `
          + 'every one is advisory, so the gate cannot fail.',
      });
    }
    const noCriterion = v.tests.filter((t) => onFailOf(t) === 'block' && !trimmed(t.expected));
    if (noCriterion.length) {
      findings.push({
        severity: 'warn', kind: 'no-pass-criterion', index: v.index,
        text: `${noCriterion.length} blocking check(s) in ${titleOf(v.step, v.index)} have no pass criterion `
          + `(${noCriterion.slice(0, 3).map((t) => `“${trimmed(t.name)}”`).join(', ')}) — nobody can fail them at 3am.`,
      });
    }
  }

  const blockedIndexes = [];
  for (const t of trafficSteps) {
    const before = verificationSteps.filter((v) => v.index < t.index && v.tests.length);
    const approvedBefore = approvalSteps.filter((a) => a.index < t.index);
    if (!before.length) {
      blockedIndexes.push(t.index);
      const placeholder = verificationSteps.some((v) => v.index < t.index);
      findings.push({
        severity: 'err', kind: 'traffic-before-verification', index: t.index,
        text: `${titleOf(t.step, t.index)} moves live traffic, but ${placeholder
          ? 'the verification gate above it is empty'
          : 'no pre-cutover verification gate comes before it'}. L6 before L7 is the one ordering this product will not draft around — `
          + 'populate the gate with the service\'s pre-cutover checks before this step can be run.',
      });
    }
    if (!approvedBefore.length) {
      findings.push({
        severity: 'err', kind: 'traffic-without-approval', index: t.index,
        text: `${titleOf(t.step, t.index)} moves live traffic with no manual-approval step in front of it — `
          + 'a machine must never decide to cut customer traffic over.',
      });
    }
    // The approval has to be AFTER the verification, or it approved nothing.
    if (before.length && approvedBefore.length && !approvedBefore.some((a) => a.index > before[before.length - 1].index)) {
      findings.push({
        severity: 'warn', kind: 'approval-before-verification', index: t.index,
        text: `The approval in front of ${titleOf(t.step, t.index)} comes BEFORE the verification gate — `
          + 'it authorises a cutover whose evidence does not exist yet. Move it after the L6 gate.',
      });
    }
  }

  if (!trafficSteps.length && verificationSteps.length) {
    findings.push({
      severity: 'info', kind: 'no-traffic-step',
      text: 'This runbook has a pre-cutover gate but no L7 traffic step — the cutover happens somewhere else. '
        + 'Say where, or the gate proves something nobody then acts on.',
    });
  }

  return {
    ok: !findings.some((f) => f.severity === 'err'),
    findings,
    verificationSteps,
    approvalSteps,
    trafficSteps,
    blockedIndexes,
    gateTests: verificationSteps.flatMap((v) => v.tests),
  };
}

/**
 * Declare the dependency on the step itself, so it survives export, and so an
 * operator reading the JSON sees what the UI sees. Mutates and returns `rb`.
 */
export function applyGateRequirements(rb) {
  const steps = arr(rb?.steps);
  const hasVerification = steps.some(isVerificationStep);
  for (const s of steps) {
    if (!isTrafficStep(s)) continue;
    const req = new Set(arr(s.requires).map(trimmed).filter(Boolean));
    if (hasVerification) req.add(GATE_KINDS.verification);
    req.add(GATE_KINDS.approval);
    s.requires = [...req];
  }
  return rb;
}

export default {
  PRE_CUTOVER_SCHEMA_VERSION, WHEN_VALUES, ON_FAIL_VALUES, GATE_KINDS, PHASES,
  normalizeAppTest, whenOf, onFailOf, isBlocking, testKey,
  resolveScope, buildPreCutoverChecklist, checklistRows, checklistToMarkdown,
  stepTestsFromChecklist, gateSummary, auditCutoverGate, applyGateRequirements,
};
