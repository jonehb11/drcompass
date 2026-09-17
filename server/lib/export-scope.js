// Export scoping — "the DR workbook for Acme Pharmacy / prod / adjudication".
//
// Contract: docs/ENV-SERVICE-MODEL.md §3. This module is the one place that
// turns `?envId=`/`?serviceId=`/`?componentId=` into the `scopeOpts` object
// that xlsx-gen.js already understands ({componentIds, rootId, rootName, …}),
// plus the extra labels the workbook titles, the filenames, the README and the
// manifest need. It lives outside xlsx-gen.js and exports.js on purpose: those
// two files are shared, and scoping is a self-contained decision.
//
// Three rules it exists to enforce:
//
//   1. NO SCOPE ⇒ null. Every caller treats null as "whole workspace", so an
//      unscoped export goes down exactly the code path it went down before any
//      of this existed. Nothing here can change an unscoped byte.
//
//   2. A SCOPE CARRIES ITS DEPENDENCY CLOSURE. A package for `adjudication`
//      that omits the Aurora cluster adjudication cannot start without is not a
//      recovery package, it is a list. Components pulled in this way are marked
//      as CONTEXT (`contextIds`) so the workbook can say why they are there.
//
//   3. SCOPING MAY NOT LAUNDER A BLOCKER. Narrowing to one service hides every
//      finding filed against everything else, and a package that looks clean
//      because the mess is out of frame is worse than no package. `hidden`
//      counts exactly what fell outside, and `hiddenSentences` says it in
//      English — the workbook, the README and the manifest all print it.

import * as store from '../store.js';
import {
  resolveScope, describeScope, scopeFromQuery, slugify, UNASSIGNED,
} from './scope.js';
import { serviceClosure, scopeSelection } from './xlsx-gen.js';
import { componentDependencyClosure } from './deploy-order.js';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Gap statuses that mean "someone already dealt with this".
const CLOSED_GAP = new Set(['resolved', 'closed', 'done', 'accepted', 'wont-fix', 'wontfix']);
const LOUD_SEVERITY = new Set(['blocker', 'high']);
const isOpenGap = (g) => !CLOSED_GAP.has(str(g?.status).toLowerCase());

export const SCOPE_QUERY_KEYS = ['envId', 'serviceId', 'componentId', 'componentIds'];

// The id an EMPTY scope carries so that "nothing is in scope" cannot be read by
// xlsx-gen.js as "no scope at all" — see the note at the bottom of
// resolveExportScope. It matches no component, by construction.
export const NO_COMPONENTS = '__drcompass_no_components__';

/** The component ids worth showing a person: never the empty-scope sentinel. */
export const visibleComponentIds = (scope) => (scope && !scope.empty ? scope.componentIds : []);

/** Everything after the workspace slug in an export filename: `prod-adjudication-aurora`. */
export function scopeFileStem(scope) {
  if (!scope) return '';
  return [scope.envSlug, scope.serviceSlug, scope.rootSlug].filter(Boolean).join('-');
}

/** `Prod · adjudication · Aurora cluster` — what a sheet title or a footer says. */
export function scopeLabel(scope) {
  if (!scope) return '';
  return [
    scope.envName ? `${scope.envName} environment` : '',
    scope.serviceName ? `${scope.serviceName} service` : '',
    scope.rootName ? `${scope.rootName}` : '',
  ].filter(Boolean).join(' · ');
}

/** The `scope:` block §3 requires on a scoped JSON response. */
export function exportScopeMeta(scope) {
  if (!scope) return null;
  return {
    envId: scope.envId, envName: scope.envName,
    serviceId: scope.serviceId, serviceName: scope.serviceName,
    componentId: scope.rootId || null, componentName: scope.rootName || null,
    componentCount: visibleComponentIds(scope).length,
    empty: !!scope.empty,
    coreCount: scope.coreIds.length,
    contextCount: scope.contextIds.length,
    label: scope.label,
    description: scope.sentence,
    ...(scope.warnings.length ? { warnings: scope.warnings } : {}),
    hidden: scope.hidden,
    hiddenSentences: scope.hiddenSentences,
  };
}

// Transitive `dependsOn` closure over a starting set. Cycle-safe; ids that
// point at nothing are reported rather than silently dropped, because a
// dangling dependency is a hole in the restore order, not a tidy edge.
//
// The implementation moved to server/lib/deploy-order.js (same algorithm, same
// {ids, added, dangling} shape) so that the workbook, the brief and the
// Deployment Order API all close a scope by ONE rule. Two copies of this rule is
// how the API came to claim a component had been deleted while the workbook
// ordered it correctly. Do not re-inline it here.
const dependencyClosure = componentDependencyClosure;

// What a scoped package would NOT show that the whole-workspace one does.
// Deliberately only the things that change a reader's conclusion: open gaps at
// blocker/high, tests that failed, and components nobody has assigned anywhere.
function hiddenAnalysis(slug, { componentIds, components, envActive }) {
  const inScope = new Set(componentIds.map(str));
  let selection = null;
  try { selection = scopeSelection(slug, { componentIds }); } catch { selection = null; }
  const keptGaps = new Set(arr(selection?.gapIds).map(str));
  const keptTests = new Set(arr(selection?.testIds).map(str));

  let gaps = [];
  let tests = [];
  try { gaps = store.getCollection(slug, 'gaps') || []; } catch { gaps = []; }
  try { tests = store.getCollection(slug, 'tests') || []; } catch { tests = []; }
  const nameOf = new Map(components.map((c) => [str(c.id), str(c.name)]));

  const hiddenGaps = gaps
    .filter((g) => isOpenGap(g) && !keptGaps.has(str(g.id)) && str(g.componentId) && !inScope.has(str(g.componentId)))
    .map((g) => ({
      id: str(g.id), title: str(g.title), severity: str(g.severity || 'medium').toLowerCase(),
      component: nameOf.get(str(g.componentId)) || str(g.componentId), ticket: str(g.ticket),
    }))
    .sort((a, b) => Number(LOUD_SEVERITY.has(b.severity)) - Number(LOUD_SEVERITY.has(a.severity)));
  const loudGaps = hiddenGaps.filter((g) => LOUD_SEVERITY.has(g.severity));

  const hiddenFailedTests = tests
    .filter((t) => str(t.status).toLowerCase() === 'failed' && !keptTests.has(str(t.id)))
    .map((t) => ({ id: str(t.id), name: str(t.name), date: str(t.date) }));

  const outside = components.filter((c) => !inScope.has(str(c.id)));
  const unassigned = envActive ? components.filter((c) => !str(c.envId)) : [];
  // Components OUTSIDE the scope that depend on something INSIDE it: the blast
  // radius this package cannot see. Not a blocker, but the reason a scoped
  // package is not a whole-system risk assessment.
  const blastRadius = outside.filter((c) => arr(c.dependsOn).some((id) => inScope.has(str(id))));

  return {
    componentsOutside: outside.length,
    openGaps: hiddenGaps.length,
    blockerOrHighGaps: loudGaps.length,
    topHiddenGaps: loudGaps.slice(0, 5),
    failedTests: hiddenFailedTests.length,
    topHiddenFailedTests: hiddenFailedTests.slice(0, 3),
    unassignedComponents: unassigned.length,
    blastRadiusComponents: blastRadius.length,
  };
}

// The English. One sentence per fact, each safe to print on its own line in a
// spreadsheet cell, a README bullet or a manifest row.
function hiddenSentences(h, scope) {
  const out = [];
  if (!h) return out;
  if (h.blockerOrHighGaps) {
    out.push(`${plural(h.blockerOrHighGaps, 'open blocker/high gap')} in this workspace `
      + `${h.blockerOrHighGaps === 1 ? 'is' : 'are'} filed against components outside this scope and `
      + `${h.blockerOrHighGaps === 1 ? 'does' : 'do'} not appear anywhere in this package — `
      + `${h.topHiddenGaps.map((g) => `"${g.title}" (${g.severity}, ${g.component})`).join('; ')}. `
      + 'A clean-looking scoped package is not a clean plan.');
  } else if (h.openGaps) {
    out.push(`${plural(h.openGaps, 'open gap')} filed against components outside this scope `
      + `${h.openGaps === 1 ? 'is' : 'are'} not in this package. None of them is graded blocker or high.`);
  }
  if (h.failedTests) {
    out.push(`${plural(h.failedTests, 'recovery test')} recorded as FAILED ${h.failedTests === 1 ? 'is' : 'are'} `
      + `outside this scope and ${h.failedTests === 1 ? 'is' : 'are'} not in the test history here`
      + `${h.topHiddenFailedTests.length ? ` — ${h.topHiddenFailedTests.map((t) => `${t.name}${t.date ? ` (${t.date})` : ''}`).join('; ')}` : ''}.`);
  }
  if (h.unassignedComponents) {
    out.push(`${plural(h.unassignedComponents, 'component')} in this workspace belong to no environment at all, `
      + 'so no environment-scoped package can contain them. Nothing auto-assigns — assign them before you trust an '
      + 'environment-scoped package to be complete.');
  }
  if (h.blastRadiusComponents) {
    out.push(`${plural(h.blastRadiusComponents, 'component')} outside this scope `
      + `${h.blastRadiusComponents === 1 ? 'depends' : 'depend'} on something inside it. `
      + `${h.blastRadiusComponents === 1 ? 'It is' : 'They are'} what breaks while this scope is down, and `
      + `${h.blastRadiusComponents === 1 ? 'it is' : 'they are'} not described here.`);
  }
  if (!out.length && scope) {
    out.push('Nothing graded blocker or high, and no failed test, falls outside this scope — '
      + 'this package is not hiding a known problem.');
  }
  return out;
}

/**
 * Resolve an export request's scope.
 *
 *   resolveExportScope('acme-pharmacy', { envId: 'prod', serviceId: 'adjudication' })
 *
 * Accepts ids, slugs or names for `envId`/`serviceId` (scope.js decides), plus
 * the pre-existing `componentId` / `componentIds`. Returns `null` when nothing
 * was asked for — the caller then behaves exactly as it did before.
 *
 * Throws a 404 `store.httpError` on an unknown environment, service or
 * component: an empty package for a typo'd id is how someone concludes a
 * service has nothing in it.
 *
 * @returns {null | {
 *   componentIds: string[], coreIds: string[], contextIds: string[],
 *   rootId: string, rootName: string, rootSlug: string,
 *   depsCount: ?number, dependentsCount: ?number,
 *   envId: ?string, envName: string, envSlug: string,
 *   serviceId: ?string, serviceName: string, serviceSlug: string, serviceIds: string[],
 *   label: string, fileStem: string, sentence: string, warnings: string[],
 *   hidden: object, hiddenSentences: string[] }}
 */
export function resolveExportScope(slug, query = {}) {
  const q = query || {};
  const wanted = scopeFromQuery(q);
  const one = str(q.componentId).trim();
  const list = q.componentIds
    ? str(q.componentIds).split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // RULE 1: nothing asked for ⇒ nothing changes.
  if (!wanted.envId && !wanted.serviceId && !one && !list.length) return null;

  const components = store.getCollection(slug, 'components') || [];
  const envServiceActive = !!(wanted.envId || wanted.serviceId);

  // --- environment + service ------------------------------------------------
  let resolved = null;
  if (envServiceActive) {
    resolved = resolveScope(slug, q, { components });
    if (!resolved.ok) throw store.httpError(resolved.error.status, resolved.error.message);
  }

  const warnings = [...(resolved?.warnings || [])];
  const envName = resolved?.envId === UNASSIGNED ? 'unassigned' : str(resolved?.envName);
  const serviceName = resolved?.serviceId === UNASSIGNED ? 'unassigned' : str(resolved?.serviceName);

  // --- the component set ----------------------------------------------------
  let coreIds = [];
  let contextIds = [];
  let dangling = [];
  let root = null;
  let depsCount = null;
  let dependentsCount = null;

  if (one) {
    // Component scope keeps its existing meaning exactly: the component, its
    // transitive dependencies, and its direct dependents (the blast radius).
    const cl = serviceClosure(components, one); // throws 404 on an unknown id
    root = cl.root;
    depsCount = cl.depsCount;
    dependentsCount = cl.dependentsCount;
    coreIds = [str(cl.root.id)];
    contextIds = cl.ids.map(str).filter((id) => id !== str(cl.root.id));
    if (envServiceActive) {
      const inEnvService = resolved.componentIds;
      const strays = cl.ids.filter((id) => !inEnvService.has(str(id)));
      if (!inEnvService.has(str(cl.root.id))) {
        warnings.push(`'${cl.root.name || one}' is not in ${scopeLabel({ envName, serviceName }) || 'the requested scope'} — `
          + 'the package still covers it and what it depends on, because that is what was asked for, but the '
          + 'environment/service labels on this package describe the request, not the contents.');
      } else if (strays.length) {
        warnings.push(`${plural(strays.length, 'component')} in this dependency closure sit outside `
          + `${scopeLabel({ envName, serviceName })} — they are included because the recovery of `
          + `'${cl.root.name || one}' depends on them.`);
      }
    }
  } else if (list.length) {
    const known = new Set(components.map((c) => str(c.id)));
    const missing = list.filter((id) => !known.has(id));
    if (missing.length === list.length) throw store.httpError(404, `no component '${missing[0]}'`);
    if (missing.length) warnings.push(`${plural(missing.length, 'requested component id')} did not match anything in this workspace and ${missing.length === 1 ? 'was' : 'were'} ignored.`);
    coreIds = list.filter((id) => known.has(id));
    root = components.find((c) => str(c.id) === coreIds[0]) || null;
  } else {
    coreIds = [...resolved.componentIds];
  }

  // RULE 2: the closure comes with it. (Component scope already walked its own.)
  if (!one) {
    const cl = dependencyClosure(components, coreIds);
    contextIds = cl.added;
    dangling = cl.dangling;
    if (dangling.length) {
      warnings.push(`${plural(dangling.length, 'dependency id')} in this scope point at a component that does not `
        + 'exist in this workspace — a hole in the restore order, not a tidy edge. They are listed on the Diagrams sheet.');
    }
  }

  const realIds = [...new Set([...coreIds, ...contextIds].map(str))];

  // A scope that nothing is assigned to yet resolves to ZERO components — and an
  // empty component list is how xlsx-gen.js spells "no scope", which would hand
  // back the WHOLE workspace under a `prod-adjudication` filename. That is the
  // worst possible failure of this feature: a package labelled as one service
  // containing everything. So an empty scope is carried as one id that matches
  // no component, which filters every sheet down to nothing and lets the
  // Diagrams tab say, in words, that the scope is empty because nobody has
  // assigned anything to it.
  const empty = realIds.length === 0;
  const componentIds = empty ? [NO_COMPONENTS] : realIds;
  if (empty) {
    warnings.push('Nothing is assigned to this scope, so this export is EMPTY on purpose. It is not a package of '
      + 'the whole workspace under a narrower name — assign components to this environment/service and export again.');
  }

  // RULE 3: what the narrowing hides.
  const hidden = hiddenAnalysis(slug, {
    // "components that belong to no environment at all" is a fact about an
    // ENVIRONMENT-scoped package. A service package that merely inherited its
    // service's environment for the region pair (scope.js, audit H4) did not
    // exclude anything for being unassigned, so it must not say it did.
    componentIds: realIds, components, envActive: !!(resolved?.envId && !resolved.envInherited),
  });

  const envSlug = resolved?.env ? (str(resolved.env.slug) || slugify(resolved.env.name, 'env'))
    : resolved?.envId === UNASSIGNED ? 'no-environment' : '';
  const serviceSlug = resolved?.service ? (str(resolved.service.slug) || slugify(resolved.service.name, 'service'))
    : resolved?.serviceId === UNASSIGNED ? 'no-service' : '';
  const rootName = str(root?.name || (one ? one : ''));

  const scope = {
    componentIds,
    // The INVENTORY of an env/service package, for the deploy-order engine
    // (`opts.inventoryComponentIds`, server/lib/deploy-order.js). `componentIds`
    // means "this scope and its blast radius" there: the engine walks one hop
    // OUTWARD, which put prod's EKS, VPC, IAM and KMS into a staging plan
    // because staging shares the registry. `coreIds` gives the same plan the
    // Deployment Order page shows. Only for a pure env/service scope:
    // `?componentId=` keeps its documented blast-radius meaning.
    ...(envServiceActive && !one && !list.length ? { inventoryComponentIds: coreIds } : {}),
    empty,
    coreIds,
    contextIds,
    dangling,
    rootId: str(root?.id || one || ''),
    rootName,
    rootSlug: rootName ? slugify(rootName, 'service') : '',
    depsCount,
    dependentsCount,
    envId: resolved?.envId || null,
    envName,
    // An environment is its own account and its own region pair (contract §2).
    envRegions: (resolved?.env && typeof resolved.env.regions === 'object' && resolved.env.regions) || null,
    envSlug,
    env: resolved?.env || null,
    serviceId: resolved?.serviceId || null,
    serviceName,
    serviceSlug,
    service: resolved?.service || null,
    serviceIds: resolved?.serviceIds || [],
    totalComponents: components.length,
    warnings,
  };
  scope.label = scopeLabel(scope);
  scope.fileStem = scopeFileStem(scope);
  scope.hidden = hidden;
  scope.hiddenSentences = hiddenSentences(hidden, scope);
  scope.sentence = sentenceFor(scope, resolved);
  return scope;
}

// One paragraph saying what this package is, in the voice of the rest of the
// product: what it covers, what came along because the recovery needs it, and
// how much of the workspace that is.
function sentenceFor(scope, resolved) {
  const parts = [];
  if (resolved && resolved.active) parts.push(describeScope(resolved));
  else if (scope.rootName) {
    parts.push(`Scoped to ${scope.rootName}`
      + `${scope.depsCount != null ? `, the ${scope.depsCount} component${scope.depsCount === 1 ? '' : 's'} it depends on` : ''}`
      + `${scope.dependentsCount ? ` and the ${scope.dependentsCount} that depend on it` : ''}.`);
  }
  if (scope.rootName && resolved && resolved.active) {
    parts.push(`Narrowed further to ${scope.rootName} and its dependency closure.`);
  }
  if (!scope.rootName && scope.contextIds.length) {
    parts.push(`${plural(scope.coreIds.length, 'component')} are assigned to this scope; `
      + `${plural(scope.contextIds.length, 'further component')} ${scope.contextIds.length === 1 ? 'is' : 'are'} `
      + 'included because the recovery of this scope depends on them.');
  }
  // The sentinel an empty scope carries is not a component and is never counted.
  parts.push(`${plural(visibleComponentIds(scope).length, 'component')} of ${scope.totalComponents} in the workspace.`);
  return parts.filter(Boolean).join(' ');
}
