// blanks.js — what is MISSING from a DR plan, named field by field.
//
// WHY THIS FILE EXISTS
// --------------------
// The user's ask, in their words: "if i have a defined RTO and RPO sheet etc
// then it should fill in the blanks with this stuff". You cannot fill a blank
// you have not found. Every other engine in this product answers "what does the
// plan SAY"; this one answers "where does the plan say NOTHING", so a document
// can be pointed at real holes instead of being asked to guess what might be
// useful.
//
// It is a PURE READ. `findBlanks()` opens the store, computes, and returns —
// it writes nothing, proposes nothing, and calls no AI. Two consumers:
//
//   1. `GET /w/:ws/blanks` (server/routes/blanks.js), so the UI can show the
//      list and the counts; and
//   2. the `general` ingestion flow in ai-bridge.js, which sends these items to
//      the model as context and requires every proposal to name the blank ids
//      it would close in `fills[]`. A blank id is therefore a CONTRACT: it is
//      deterministic, derived only from the subject and the field, and stable
//      across calls so long as the underlying item keeps its id.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not invent a severity of its own, it does not judge quality (a bad
// owner is not this file's problem — an ABSENT one is), and it never reports a
// blank against a subject the scope excluded.

import * as store from '../store.js';
import { objectiveFor } from './measured.js';
import {
  resolveScopeOrThrow, scopeComponents, componentRefs,
  listEnvironments, listServices, UNASSIGNED,
} from './scope.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const trimmed = (v) => str(v).trim();
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const blank = (v) => !trimmed(v);

export const IMPORTANCE = ['blocker', 'high', 'medium', 'low'];

// ---------------------------------------------------------------- grading
//
// HOW `importance` IS GRADED. Derived, in this order — never typed in per-kind
// by hand, because "a missing RTO" is not one thing: it is a blocker on a
// tier-0 production service and a tidiness note on a tier-2 dev component.
//
//   1. BASE, from the subject's TIER. Tier is this product's own recorded
//      statement of how much a thing matters, so it is the only honest place to
//      start:  tier 0 -> blocker,  tier 1 -> high,  tier 2 -> medium,
//      tier 3+ or unset -> low.  An unset tier grades LOW rather than high: we
//      do not know it is critical, and inflating unknowns is how a blank list
//      becomes noise nobody reads.
//   2. ENVIRONMENT. If the subject sits in an environment whose `isProduction`
//      is false, drop one step. The same hole is a different problem in the lab
//      than in production. A subject in a production environment, or in a
//      workspace with no environments at all (single-environment, so it IS
//      production), keeps its base.
//   3. RECOVERY SCOPE. `inRecoveryScope: 'no'` drops one further step: a
//      component nobody intends to recover cannot block a recovery.
//      'unknown' and 'partial' do NOT drop it — not having decided is not the
//      same as having decided no, and the undecided case is exactly what the
//      Executive Summary's own next-action rule chases.
//   4. A PER-KIND CEILING (`CEILING` below). Some blanks are never a blocker
//      however critical the subject, because they do not stop a recovery: a
//      missing `dependsOn` is a modelling hole, an unapproved objective has the
//      number and is missing only the signature. The ceiling is applied last so
//      it can only ever LOWER what tier and environment produced.
//
// Nothing here can RAISE a blank above its subject's tier. That is deliberate:
// if a component matters more than its tier says, the fix is the tier.

const rank = (imp) => IMPORTANCE.indexOf(imp);
const step = (imp, down) => IMPORTANCE[Math.min(IMPORTANCE.length - 1, Math.max(0, rank(imp) + down))];
const cap = (imp, ceiling) => (rank(imp) < rank(ceiling) ? ceiling : imp);

/** Per-kind ceilings — the most severe a blank of this kind may ever grade. */
const CEILING = {
  'objective-rto': 'blocker',
  'objective-rpo': 'blocker',
  'objective-unapproved': 'high',
  'component-owner': 'high',
  'component-verification': 'high',
  'component-depends-on': 'high',
  'component-replication': 'high',
  'component-recovery-scope': 'blocker',
  'runbook-coverage': 'blocker',
  'test-coverage': 'blocker',
  'runbook-role-contact': 'medium',
  'gap-owner': 'high',
};

function baseForTier(tier) {
  if (tier === 0) return 'blocker';
  if (tier === 1) return 'high';
  if (tier === 2) return 'medium';
  return 'low';
}

/**
 * @param {string} kind        blank kind (keys CEILING)
 * @param {object} ctx         {tier, isProduction, inRecoveryScope}
 */
function grade(kind, { tier = null, isProduction = true, inRecoveryScope = '' } = {}) {
  let imp = baseForTier(isNum(tier) ? tier : null);
  if (isProduction === false) imp = step(imp, +1);
  if (trimmed(inRecoveryScope).toLowerCase() === 'no') imp = step(imp, +1);
  return cap(imp, CEILING[kind] || 'low');
}

// ------------------------------------------------------------- exportedIn
//
// WHERE THE BLANK SHOWS UP IN WHAT YOU HAND AN AUDITOR. This is the half that
// makes filling a blank worth doing, so every entry below was READ OUT OF
// `server/lib/xlsx-gen.js` rather than guessed. The provenance, so the next
// person can re-check it rather than trusting this comment:
//
//   'Executive Summary'      SHEETS.exec. Its next-action rules (the `cand`
//                            list) fire on exactly these: `noVerification`
//                            ("Write a verification command for N components"),
//                            `undecidedScope` ("Decide recovery scope for N
//                            components still marked partial or unknown"), and
//                            `!numbers.approved` ("Get the RTO / RPO targets
//                            signed off by the business"). Its risk table's
//                            Owner column prints the literal string
//                            'unassigned' when the component has no owner.
//   'How we fail this over'  SHEETS.brief. briefPreconditions() prints an Owner
//                            per precondition, falling back to ownerTeam(); the
//                            narrative reads inRecoveryScope and
//                            replication.mechanism.
//   'Dependencies'          SHEETS.deps. Each component row's notes carry the
//                            tier, the replication mechanism and ownerTeam();
//                            each dependency row carries `scope <value>`; and a
//                            component with a verification gets its own row.
//   'Runbooks'              SHEETS.runbooks. Columns include Verify, Pass-when
//                            and Owner, per step; a check with no pass criterion
//                            prints "NO pass criterion — nobody can fail this at
//                            3am" and an ownerless one prints 'unassigned'.
//   'Tests'                 SHEETS.tests. The header block prints the resolved
//                            objective ("RTO target not set" when it is absent)
//                            and each run is judged against it.
//   'Deployment Order'      SHEETS.deploy. Built from the dependency graph, so a
//                            component with no dependsOn has no edges to order.
//   'Workbench'             SHEETS.workbench. Carries the gap list and the
//                            secrets reconciliation.
//   '<name>.csv'            DATASETS in the same file — these back the CSV
//                            endpoints and their headers are a stated contract.
//                            'components' has Owner / Team, Scope, Replication
//                            Mechanism, Depends On, Verification Command and
//                            Verification Pass as named columns;
//                            'verification-catalog' filters to components that
//                            HAVE a verification, so one without simply vanishes
//                            from it.
const EXPORTED_IN = {
  'objective-rto': ['Executive Summary', 'Tests', 'How we fail this over'],
  'objective-rpo': ['Executive Summary', 'Tests', 'How we fail this over'],
  'objective-unapproved': ['Executive Summary', 'Tests', 'How we fail this over'],
  'component-owner': ['Executive Summary', 'Dependencies', 'How we fail this over', 'components.csv'],
  'component-verification': ['Executive Summary', 'Dependencies', 'components.csv', 'verification-catalog.csv'],
  'component-depends-on': ['Dependencies', 'Deployment Order', 'components.csv'],
  'component-replication': ['Dependencies', 'How we fail this over', 'components.csv'],
  'component-recovery-scope': ['Executive Summary', 'Dependencies', 'How we fail this over', 'components.csv'],
  'runbook-coverage': ['Runbooks', 'How we fail this over'],
  'test-coverage': ['Tests', 'Executive Summary'],
  'runbook-role-contact': ['Runbooks', 'contacts.csv'],
  'gap-owner': ['Executive Summary', 'Workbench'],
};

// --------------------------------------------------------------- the read

function readAll(slug) {
  const get = (name) => {
    try { return arr(store.getCollection(slug, name)); } catch { return []; }
  };
  // getWorkspace throws a 404 for an unknown slug, which is what we want: a
  // blanks request against a workspace that does not exist is an error, not an
  // empty list.
  const workspace = store.getWorkspace(slug);
  return {
    workspace,
    components: get('components'),
    services: listServices(slug),
    environments: listEnvironments(slug, workspace),
    runbooks: get('runbooks'),
    tests: get('tests'),
    gaps: get('gaps'),
    contacts: get('contacts'),
  };
}

/** The environment a subject sits in, for rule 2 of the grading. */
function envOf(environments, envId) {
  if (!trimmed(envId)) return null;
  return environments.find((e) => str(e.id) === str(envId)) || null;
}

/**
 * Is this subject in production? An environment that says so, or a workspace
 * with no environments defined at all (single-environment: it IS production).
 * An environment that exists and says `isProduction: false` is the only thing
 * that lowers a grade.
 */
function isProductionFor(environments, envId) {
  if (!environments.length) return true;
  const env = envOf(environments, envId);
  if (!env) return true; // unassigned — do not discount it on a guess
  return env.isProduction !== false;
}

// ------------------------------------------------------------ the blanks

/**
 * Compute everything missing from a plan.
 *
 * @param {string} slug
 * @param {{envId?:string, serviceId?:string}} query
 * @returns {{items:object[], counts:object, scope:object|null}}
 *
 * Throws `store.httpError(404, …)` for an unknown workspace, envId or
 * serviceId — the message names the ids that DO exist, because silently
 * returning zero blanks for a typo is how someone concludes their plan is
 * complete.
 */
export function findBlanks(slug, query = {}) {
  const all = readAll(slug);
  const scope = resolveScopeOrThrow(slug, query, {
    workspace: all.workspace,
    components: all.components,
    services: all.services,
  });

  const components = scopeComponents(all.components, scope);
  const inScopeIds = new Set(components.map((c) => str(c.id)));

  // Which SERVICES this request is about. A service scope is the service and
  // its sub-services (scope.serviceIds, resolved by lib/scope.js). An
  // environment scope is every service recorded in that environment. No scope
  // is every service.
  const services = (() => {
    if (scope.serviceId === UNASSIGNED) return [];
    if (scope.serviceIds.length) {
      const want = new Set(scope.serviceIds.map(str));
      return all.services.filter((s) => want.has(str(s.id)));
    }
    if (scope.envId && scope.envId !== UNASSIGNED) {
      return all.services.filter((s) => str(s.envId) === str(scope.envId));
    }
    return all.services;
  })();

  // Which ENVIRONMENTS this request is about. An explicit envId is that one. A
  // service scope with no envId is the environments those services actually sit
  // in — reporting Staging's missing objective on a request scoped to a
  // production service is a blank about something the caller did not ask about.
  const environments = (() => {
    if (scope.envId === UNASSIGNED) return [];
    if (scope.envId) return all.environments.filter((e) => str(e.id) === str(scope.envId));
    if (scope.serviceIds.length) {
      const want = new Set(services.map((s) => str(s.envId)).filter(Boolean));
      return all.environments.filter((e) => want.has(str(e.id)));
    }
    return all.environments;
  })();

  const items = [];
  const push = (it) => { items.push(it); };

  const subjectComponent = (c) => ({ type: 'component', id: str(c.id), name: str(c.name) || str(c.id) });
  const subjectService = (s) => ({ type: 'service', id: str(s.id), name: str(s.name) || str(s.id) });
  const subjectWorkspace = (name) => ({ type: 'workspace', id: str(slug), name });

  const add = (kind, subject, field, label, why, gradeCtx) => push({
    id: `${kind}:${subject.id}:${field}`,
    kind,
    subject,
    field,
    label,
    why,
    importance: grade(kind, gradeCtx),
    exportedIn: EXPORTED_IN[kind] || [],
  });

  // ---------------------------------------------------------- objectives
  //
  // The resolution rules already exist — `objectiveFor()` in measured.js is the
  // single definition of whose commitment a number is (service, then
  // environment, then workspace; and rule 1 there: a scope with NO objective of
  // its own does NOT inherit one). This file asks it the question and reports
  // the silence; it does not re-derive any of it.
  const objectiveBlanks = (subject, selector, gradeCtx, ownerPhrase) => {
    const o = objectiveFor({
      workspace: all.workspace,
      services: all.services,
      environments: all.environments,
      ...selector,
    });
    const missingRto = o.rtoMinutes === null || o.rtoMinutes === undefined;
    const missingRpo = o.rpoMinutes === null || o.rpoMinutes === undefined;

    if (missingRto) {
      add('objective-rto', subject, 'objectives.rtoMinutes',
        'No RTO target',
        `${ownerPhrase} has no RTO of its own${o.none ? ' — and measured.js:objectiveFor() does not let it inherit one, so there is no number to judge a recovery against' : ''}. `
        + 'Until someone records how much downtime is tolerable, every test result is a number with nothing to compare it to.',
        gradeCtx);
    }
    if (missingRpo) {
      add('objective-rpo', subject, 'objectives.rpoMinutes',
        'No RPO target',
        `${ownerPhrase} has no RPO of its own${o.none ? ' — and it does not inherit one' : ''}. `
        + 'Without it nobody has said how much data loss is acceptable, so no replication choice can be called adequate or inadequate.',
        gradeCtx);
    }
    // Only meaningful when there IS a number: "unapproved" is about a target
    // that exists and has not been signed off, not about an absent one.
    if (!missingRto || !missingRpo) {
      if (!o.approved) {
        add('objective-unapproved', subject, 'objectives.approved',
          'RTO/RPO target is not approved',
          `${ownerPhrase} records ${[
            isNum(o.rtoMinutes) ? `RTO ${o.rtoMinutes} min` : null,
            isNum(o.rpoMinutes) ? `RPO ${o.rpoMinutes} min` : null,
          ].filter(Boolean).join(' and ')}, but objectives.approved is false`
          + `${blank(o.source) ? ' and objectives.source is empty, so nothing records where the number came from' : ` (source: ${o.source})`}. `
          + 'An unapproved target is a proposal — the Executive Summary raises "Get the RTO / RPO targets signed off by the business" as a next action while it stands.',
          gradeCtx);
      } else if (blank(o.source)) {
        // Approved with no source is its own hole: a number nobody can trace.
        add('objective-unapproved', subject, 'objectives.source',
          'Approved target with no recorded source',
          `${ownerPhrase} records an APPROVED target, but objectives.source is empty — nothing says which BIA, meeting or sign-off produced it. `
          + 'A target with no source is indistinguishable from a measurement.',
          gradeCtx);
      }
    }
  };

  // The workspace's own objective, only when nothing is scoped: under a scope
  // the relevant commitment is the scoped one, and reporting the workspace's
  // silence as well would double-count it.
  if (!scope.active) {
    objectiveBlanks(
      subjectWorkspace(str(all.workspace.name) || slug),
      {},
      // The workspace is not tiered and is not in one environment. It is graded
      // as tier 0 / production: it is the whole program's commitment.
      { tier: 0, isProduction: true },
      'This workspace');
  }

  for (const env of environments) {
    objectiveBlanks(
      { type: 'workspace', id: str(env.id), name: `${str(env.name) || str(env.slug) || str(env.id)} environment` },
      { envId: str(env.id) },
      // An environment has no tier. Production grades as tier 0, anything else
      // as tier 2 — the same shape rule 2 of the grading applies elsewhere.
      { tier: env.isProduction === false ? 2 : 0, isProduction: env.isProduction !== false },
      `The ${str(env.name) || str(env.id)} environment`);
  }

  for (const s of services) {
    objectiveBlanks(
      subjectService(s),
      { serviceId: str(s.id) },
      { tier: isNum(s.tier) ? s.tier : null, isProduction: isProductionFor(all.environments, s.envId) },
      `The ${str(s.name) || str(s.id)} service`);
  }

  // ---------------------------------------------------------- components
  for (const c of components) {
    const ctx = {
      tier: isNum(c.tier) ? c.tier : null,
      isProduction: isProductionFor(all.environments, c.envId),
      inRecoveryScope: c.inRecoveryScope,
    };
    const subject = subjectComponent(c);

    if (blank(c.owner) && blank(c.team)) {
      add('component-owner', subject, 'owner',
        'No owner or team',
        'Neither owner nor team is set. The exports print ownerTeam() for this component, so it appears as an empty '
        + 'cell on Dependencies and components.csv, and as the literal word "unassigned" wherever the Executive '
        + 'Summary needs somebody to chase. A finding nobody owns is a finding nobody closes.',
        ctx);
    }

    const v = c.verification && typeof c.verification === 'object' ? c.verification : {};
    if (blank(v.command) && blank(v.pass)) {
      add('component-verification', subject, 'verification',
        'No verification command or pass criterion',
        'verification.command and verification.pass are both empty, so nothing says how to tell this came back. '
        + 'It drops out of verification-catalog.csv entirely (that dataset filters to components that HAVE one) and '
        + 'feeds the Executive Summary\'s "Write a verification command for N components" action. '
        + 'Without one, "it came back" is an opinion rather than a check someone can run.',
        ctx);
    }

    if (!arr(c.dependsOn).filter(Boolean).length) {
      add('component-depends-on', subject, 'dependsOn',
        'No recorded dependencies',
        'dependsOn is empty. That is legitimate for a true leaf (a VPC, an IAM role), and a hole for anything that '
        + 'reads a database or mounts a secret — the deployment-order engine builds waves from these edges, so a '
        + 'component with none is ordered on nothing. Confirm it is genuinely a leaf, or record what it needs.',
        ctx);
    }

    const mech = trimmed(c.replication && c.replication.mechanism);
    if (!mech || mech.toLowerCase() === 'unknown') {
      add('component-replication', subject, 'replication.mechanism',
        'Replication mechanism unknown',
        `replication.mechanism is ${mech ? `'${mech}'` : 'empty'}, so nothing records HOW this comes back — `
        + 'snapshot, continuous replication, rebuilt from IaC, or not at all. It is the field the Dependencies '
        + 'sheet and the narrative both read to say what the recovery of this component actually is.',
        ctx);
    }

    const sc = trimmed(c.inRecoveryScope).toLowerCase();
    if (!sc || sc === 'unknown') {
      add('component-recovery-scope', subject, 'inRecoveryScope',
        'Recovery scope not decided',
        'inRecoveryScope is unset or "unknown" — nobody has said whether this is recovered or abandoned. '
        + 'The Executive Summary raises it as a next action in the words "Anything undecided now gets decided '
        + 'during the incident".',
        ctx);
    }
  }

  // ----------------------------------------- tier-0 runbook / test coverage
  //
  // TWO DIFFERENT QUESTIONS, and web/js/coverage.js is emphatic that they are
  // not the same evidence:
  //
  //   * a RUNBOOK step naming a component is AUTHORING METADATA — it says a
  //     written procedure is about this component. That is exactly the right
  //     signal for "is there a procedure for this at all", so runbook coverage
  //     accepts it.
  //   * a TEST naming a component (test.componentId / componentIds /
  //     appTests[].componentId) is an OBSERVATION — somebody exercised it and
  //     checked a success bar. Test coverage accepts ONLY that. It deliberately
  //     does NOT infer coverage from a shared runbook: coverage.js calls that
  //     "breadth generated by a machine", and treating it as evidence is the
  //     bug that once marked an entire workspace measured.
  //
  // componentRefs() (lib/scope.js) is the generic walk both use, so a new link
  // field does not silently stop counting.
  const runbookCovered = new Set();
  for (const rb of all.runbooks) for (const id of componentRefs(rb)) runbookCovered.add(str(id));
  const testCovered = new Set();
  for (const t of all.tests) for (const id of componentRefs(t)) testCovered.add(str(id));

  for (const c of components) {
    if (c.tier !== 0) continue;
    // A tier-0 component explicitly OUT of recovery scope is a decision, not a
    // hole: nobody needs a runbook for something nobody is recovering.
    if (trimmed(c.inRecoveryScope).toLowerCase() === 'no') continue;
    const ctx = {
      tier: 0,
      isProduction: isProductionFor(all.environments, c.envId),
      inRecoveryScope: c.inRecoveryScope,
    };
    const subject = subjectComponent(c);
    if (!runbookCovered.has(str(c.id))) {
      add('runbook-coverage', subject, 'runbooks',
        'Tier-0 component with no runbook',
        'No runbook in this workspace names this component in any step. It is tier 0 — the most critical rating '
        + 'this plan has — so at 3am somebody will have to improvise the procedure for it.',
        ctx);
    }
    if (!testCovered.has(str(c.id))) {
      add('test-coverage', subject, 'tests',
        'Tier-0 component with no test',
        'No test names this component on itself or in its appTests[], so nothing has ever been observed to recover '
        + 'it. Per web/js/coverage.js, a runbook step naming it is authoring metadata and does NOT count here: '
        + 'until a test names it, every number about this component is a target.',
        ctx);
    }
  }

  // --------------------------------------------- roles named with no contact
  //
  // A runbook step says "owner: approver". If nobody in `contacts` is that
  // person, the procedure names a role that the plan cannot resolve to a human.
  const contactHaystack = all.contacts
    .map((p) => [p.name, p.role, p.responsibilities].map(str).join(' ').toLowerCase())
    .filter(Boolean);
  const knownRole = (role) => {
    const r = trimmed(role).toLowerCase();
    if (!r) return true;
    return contactHaystack.some((h) => h.includes(r));
  };

  const scopedRunbooks = all.runbooks.filter((rb) => {
    if (!scope.active) return true;
    const refs = [...componentRefs(rb)].map(str);
    // An item that links to NO component is workspace-wide and is KEPT, exactly
    // as lib/scope.js keeps it: a workspace-wide runbook applies to everything.
    if (!refs.length) return true;
    return refs.some((id) => inScopeIds.has(id));
  });

  const seenRole = new Set();
  for (const rb of scopedRunbooks) {
    const steps = [...arr(rb.steps), ...arr(rb.rollback)].filter(Boolean);
    for (const s of steps) {
      const role = trimmed(s.owner);
      if (!role || knownRole(role)) continue;
      const key = role.toLowerCase();
      if (seenRole.has(key)) continue;
      seenRole.add(key);
      add('runbook-role-contact', { type: 'workspace', id: `role_${key.replace(/[^a-z0-9]+/g, '-')}`, name: role },
        'contacts',
        `Runbook role "${role}" has no contact`,
        `Steps in "${str(rb.name) || str(rb.id)}" are assigned to "${role}", and no entry in contacts matches that `
        + 'name, role or responsibility. The Runbooks sheet prints the role in its Owner column, so during an '
        + 'exercise somebody has to work out who that is before they can call them.',
        // A role is not tiered and not environment-bound. It grades from the
        // per-kind ceiling alone: a name the plan cannot resolve is real, but it
        // is not what stops a recovery.
        { tier: 1, isProduction: true });
    }
  }

  // ------------------------------------------------------------ gap owners
  const scopedGaps = all.gaps.filter((g) => {
    if (trimmed(g.status).toLowerCase() === 'resolved') return false;
    if (!scope.active) return true;
    const cid = trimmed(g.componentId);
    if (!cid) return true; // workspace-wide gap
    return inScopeIds.has(cid);
  });
  const byId = new Map(all.components.map((c) => [str(c.id), c]));
  for (const g of scopedGaps) {
    if (!blank(g.owner)) continue;
    const c = byId.get(trimmed(g.componentId)) || null;
    add('gap-owner', { type: 'workspace', id: str(g.id), name: str(g.title) || str(g.id) },
      'owner',
      'Open gap with no owner',
      'This gap records no owner. Worth knowing precisely: the exports never read gaps[].owner at all — the '
      + 'Executive Summary\'s top-risk table prints the OWNING COMPONENT\'s owner instead, and the literal word '
      + `"unassigned" when there is none${c ? ` (here: ${str(c.name)}${blank(c.owner) && blank(c.team) ? ', which also has no owner' : ''})` : ' (this gap names no component at all)'}. `
      + 'So an ownerless gap is invisible as such to a reader of the workbook, which is the worse failure mode.',
      {
        // A gap carries its OWN severity. It is the subject's statement of how
        // much it matters, so it stands in for tier here rather than the
        // component's — a blocker gap on a tier-2 component is still a blocker.
        tier: { blocker: 0, high: 1, medium: 2, low: 3 }[trimmed(g.severity).toLowerCase()] ?? null,
        isProduction: c ? isProductionFor(all.environments, c.envId) : true,
      });
  }

  // ----------------------------------------------------------------- counts
  const byImportance = Object.fromEntries(IMPORTANCE.map((k) => [k, 0]));
  const byKind = {};
  for (const it of items) {
    byImportance[it.importance] = (byImportance[it.importance] || 0) + 1;
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  }

  // Worst first, then by kind, then by subject — a stable order, so two calls
  // with the same data produce the same list and `fills[]` ids stay meaningful.
  items.sort((a, b) => rank(a.importance) - rank(b.importance)
    || a.kind.localeCompare(b.kind)
    || a.subject.name.localeCompare(b.subject.name)
    || a.id.localeCompare(b.id));

  return {
    items,
    counts: { total: items.length, byImportance, byKind },
    scope: scope.active
      ? {
        envId: scope.envId, envName: scope.envName,
        serviceId: scope.serviceId, serviceName: scope.serviceName,
        componentCount: scope.componentCount, totalComponents: scope.totalComponents,
        serviceCount: services.length,
        warnings: scope.warnings,
      }
      : null,
  };
}

export default findBlanks;
