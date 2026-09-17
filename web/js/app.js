import { api } from './api.js';
import * as ui from './ui.js';
import { h, toast, modal, field, btn } from './ui.js';
import { initAssistant } from './assistant.js';
import { firstRunWelcome, sidebarNext, setJourneyEnv } from './onboarding.js';

// One source of truth, shared with Settings so an environment can never be
// given a slug that would be read as a page name (see ui.RESERVED_ENV_SLUGS).
const PAGES = ui.ROUTE_PAGES;

// Teardown for the page currently in #outlet (see route()).
let pageCleanup = null;
async function runPageCleanup() {
  const fn = pageCleanup;
  pageCleanup = null;
  if (typeof fn !== 'function') return;
  try { await fn(); } catch (e) { console.error('page cleanup failed', e); }
}
const outlet = document.getElementById('outlet');
const wsSelect = document.getElementById('ws-select');
const posture = document.getElementById('ws-posture');
const routeStatus = document.getElementById('route-status');
const envBlock = document.getElementById('env-block');
const envSelect = document.getElementById('env-select');
const envNote = document.getElementById('env-note');
const envLabel = document.getElementById('env-label');
let workspaces = [];
let loadError = null;

/* ---------------------------------------------------------------------------
 * ROUTING — `#/:ws/:env/:page/...`, with `:env` OPTIONAL.
 *
 * Every link written before environments existed — `#/acme-pharmacy/inventory`,
 * `#/acme-pharmacy/tests/tst_1`, `#/acme-pharmacy/service/cmp_eks` — still resolves,
 * because the segment after the workspace is read as a PAGE when it names one
 * and as an ENVIRONMENT otherwise. Page names are a closed list; an environment
 * slug that would collide with one is rejected where environments are created
 * (Settings), so the two can never be ambiguous.
 *
 * A workspace WITH environments canonicalises to the four-segment form with
 * location.replace() — no history entry, so Back still goes where the user
 * expects — and a workspace WITHOUT them stays exactly as it was.
 * ------------------------------------------------------------------------ */

/** True for the segment that names a page rather than an environment. */
const isPageSeg = (s) => PAGES.includes(s);

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const ws = parts[0] || null;
  if (parts.length < 2) return { ws, env: null, page: 'dashboard', params: [], hadEnv: false };
  if (isPageSeg(parts[1])) {
    // Legacy (and still valid) `#/:ws/:page/...`.
    return { ws, env: null, page: parts[1], params: parts.slice(2), hadEnv: false };
  }
  return { ws, env: parts[1], page: parts[2] || 'dashboard', params: parts.slice(3), hadEnv: true };
}

/** Build a route. `env` null/'' → the legacy two-segment form. */
export function hrefFor(ws, env, page, ...params) {
  const segs = [ws, env || null, page || 'dashboard', ...params].filter((s) => s !== null && s !== undefined && s !== '');
  return `#/${segs.join('/')}`;
}

export function navigate(hash) { location.hash = hash; }

// What the shell currently resolved to. Read by the history canonicaliser below.
let currentRoute = { ws: null, envSlug: null, multi: false };

/**
 * A page may write its own deep link straight into the address bar — the
 * Diagrams page does it for the selected diagram, with `#/:ws/diagrams/:id`,
 * a string written before environments existed. `history.replaceState` fires
 * no hashchange, so the shell would never see it and the URL would quietly
 * lose the environment it is actually showing. Canonicalise on the way out
 * instead, so a copied link still opens on the same account.
 */
function canonicalHash(url) {
  if (!currentRoute.multi || !currentRoute.envSlug) return url;
  const parts = String(url).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== currentRoute.ws) return url;         // another workspace: leave it alone
  if (!parts[1] || !isPageSeg(parts[1])) return url;    // already carries an env segment
  return hrefFor(parts[0], currentRoute.envSlug, parts[1], ...parts.slice(2));
}
if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
  const native = history.replaceState.bind(history);
  history.replaceState = (state, title, url) => native(
    state, title, typeof url === 'string' && url.startsWith('#/') ? canonicalHash(url) : url);
}

async function loadWorkspaces() {
  try {
    workspaces = await api.get('/workspaces');
    loadError = null;
  } catch (e) {
    workspaces = [];
    loadError = e;
    throw e;
  }
  wsSelect.innerHTML = '';
  for (const w of workspaces) wsSelect.append(h('option', { value: w.slug }, w.name));
}

/* ---------------------------------------------------------------- environments
 * They live in workspace.json (docs/ENV-SERVICE-MODEL.md §2), so one cached
 * read of the workspace meta is all the shell needs. A workspace with no
 * `environments` key is single-environment and NOTHING is fabricated for it —
 * the switcher does not appear, the routes keep their old shape, and every
 * request goes out unscoped exactly as before.
 */
const envCache = new Map();
function invalidateEnvs(ws) { if (ws) envCache.delete(ws); else envCache.clear(); }

async function envsFor(ws) {
  if (envCache.has(ws)) return envCache.get(ws);
  const promise = api.get(`/w/${ws}/workspace`)
    .then((meta) => ui.environmentsOf(meta))
    .catch(() => ui.environmentsOf(null));
  envCache.set(ws, promise);
  return promise;
}

/**
 * Which environment is this view about?
 *   wanted  what the hash asked for (slug, id, name, 'all', or null)
 * Returns { env, slug, envId, all, known } — `all` means "every environment",
 * which is what an unassigned-heavy workspace needs to see its own data.
 */
function resolveEnv(envs, wanted, ws) {
  if (!envs.multi) return { env: null, slug: null, envId: null, all: false, known: true };
  const asked = String(wanted || '').trim();
  if (asked.toLowerCase() === ui.ENV_ALL) return { env: null, slug: ui.ENV_ALL, envId: null, all: true, known: true };
  const direct = ui.findEnv(envs.items, asked);
  if (direct) return { env: direct, slug: ui.envSlug(direct), envId: String(direct.id), all: false, known: true };
  // Nothing usable in the hash: the remembered choice, then the workspace's
  // declared default, then the first environment. Never production by accident
  // — `defaultEnvId` is the workspace's own statement of what to open on.
  const pref = ui.findEnv(envs.items, ui.readEnvPref(ws));
  const dflt = pref
    || ui.findEnv(envs.items, envs.defaultEnvId)
    || envs.items[0];
  return { env: dflt, slug: ui.envSlug(dflt), envId: String(dflt.id), all: false, known: !asked };
}

/** The switcher itself. Production is a different colour and says the word. */
function paintEnvSwitcher(envs, chosen, ws, page, params) {
  if (!envBlock) return;
  if (!envs.multi) {
    // One environment is the honest answer for most workspaces, and a labelled
    // block with nothing to switch is clutter — so the label and the picker go
    // away entirely and only one quiet line remains, because this is the single
    // place anyone would look for the feature.
    envBlock.hidden = false;
    envBlock.className = 'env-block is-single';
    envSelect.hidden = true;
    if (envLabel) envLabel.hidden = true;
    envNote.replaceChildren(
      h('span', null, 'One environment. '),
      h('a', { href: hrefFor(ws, null, 'settings') }, 'Add dev, staging and prod →'));
    document.body.dataset.envKind = '';
    return;
  }
  envSelect.hidden = false;
  envBlock.hidden = false;
  if (envLabel) envLabel.hidden = false;
  const isProd = !!chosen.env?.isProduction;
  envBlock.className = `env-block ${isProd ? 'is-prod' : ''}`;
  document.body.dataset.envKind = isProd ? 'prod' : 'env';

  envSelect.replaceChildren(
    ...envs.items.map((e) => h('option', {
      value: ui.envSlug(e),
      selected: chosen.env && String(e.id) === String(chosen.env.id),
    }, `${e.name || e.slug}${e.isProduction ? ' — production' : ''}`)),
    h('option', { value: ui.ENV_ALL, selected: chosen.all }, 'All environments'));
  envSelect.setAttribute('aria-label',
    `Environment — currently ${chosen.all ? 'all environments' : (chosen.env?.name || 'unknown')}`);

  const e = chosen.env;
  const regions = e?.regions || {};
  envNote.replaceChildren(
    isProd ? h('span', { class: 'env-flag' }, h('span', { class: 'env-dot' }), 'Production') : null,
    chosen.all
      ? h('div', { style: 'margin-top:4px' }, 'Every environment at once. Counts below add up across accounts.')
      : h('div', { style: 'margin-top:4px' },
        regions.primary || regions.recovery
          ? h('span', { class: 'mono' }, `${regions.primary || 'region?'} → ${regions.recovery || 'region?'}`)
          : h('span', null, 'No regions set for this environment.'),
        e?.awsProfile ? h('div', null, `profile ${e.awsProfile}`) : null));

  envSelect.onchange = () => {
    const v = envSelect.value;
    ui.writeEnvPref(ws, v);
    ui.invalidateSnapshot(ws);
    navigate(hrefFor(ws, v, page, ...params));
  };
}

// ---------------------------------------------------------------- new workspace

async function newWorkspaceDialog() {
  const name = h('input', { placeholder: 'Payments Platform' });
  const slug = h('input', { placeholder: 'payments' });
  const primary = h('input', { value: 'us-east-1' });
  const recovery = h('input', { value: 'us-west-2' });
  let slugTouched = false;
  slug.addEventListener('input', () => { slugTouched = true; });
  name.addEventListener('input', () => {
    if (!slugTouched) slug.value = name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  });

  const ok = await modal('New workspace', h('div', null,
    h('p', { class: 'hint', style: 'margin-bottom:14px' },
      'One workspace per system you are responsible for recovering. All of this can be changed later.'),
    field('What is this system called?', name),
    field('Short name for links and file names (letters, numbers, dashes)', slug),
    h('div', { class: 'grid cols-2' },
      field('Primary region — where it runs today', primary),
      field('Recovery region — where it comes back', recovery)),
  ), { actions: [{ label: 'Create workspace', kind: 'btn-primary', value: true }] });
  if (!ok) return;

  const finalSlug = slug.value.trim() || name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!finalSlug) { toast('A short name is required — try "payments".', 'err'); return; }
  try {
    const ws = await api.post('/workspaces', {
      slug: finalSlug,
      name: name.value.trim() || finalSlug,
      regions: { primary: primary.value.trim(), recovery: recovery.value.trim() },
    });
    ui.invalidateSnapshot(ws.slug);
    await loadWorkspaces();
    navigate(`#/${ws.slug}/dashboard`);
    route();
    toast(`Workspace '${ws.name}' created — the Start here steps will walk you through it.`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------- sidebar state

function navSlot(page) { return document.querySelector(`#nav .nx[data-slot="${page}"]`); }

function setSlot(page, node) {
  const slot = navSlot(page);
  if (!slot) return;
  slot.replaceChildren();
  if (node) slot.append(node);
}

const navCount = (n, kind = '') => h('span', { class: `nx-count ${kind}` }, String(n));

/** Live counts and state dots in the sidebar, derived from the workspace itself. */
function paintSidebar(snap, ws) {
  const c = snap.counts || {};
  const obj = snap.objectives || {};
  const rep = snap.report;

  setSlot('dashboard', snap.openBlockers.length
    ? navCount(snap.openBlockers.length, 'err')
    : null);
  setSlot('assessment', rep
    ? ((rep.answeredTotal ?? 0) === 0
      ? ui.dot('warn', 'not started')
      : navCount(`L${rep.level}`, rep.level >= 3 ? 'ok' : ''))
    : null);
  setSlot('inventory', c.components ? navCount(c.components) : ui.dot('warn', 'nothing recorded yet'));
  setSlot('runbooks', c.runbooks ? navCount(c.runbooks) : ui.dot('warn', 'no runbook yet'));
  setSlot('checklists', c.checklists ? navCount(c.checklists) : null);
  setSlot('documents', c.documents ? navCount(c.documents) : null);
  setSlot('tests', snap.lastTest
    ? h('span', { class: 'nx-pair' }, ui.dot(ui.statusKind(snap.lastTest.status), `last test ${snap.lastTest.status}`), navCount(c.tests))
    : (c.tests ? navCount(c.tests) : ui.dot('warn', 'never tested')));
  setSlot('settings', (obj.rtoMinutes === null || obj.rtoMinutes === undefined || !obj.approved)
    ? ui.dot('warn', obj.rtoMinutes == null ? 'no recovery target set' : 'targets not approved')
    : null);

  // ---- workspace posture. Two facts only: the region pair this plan is about,
  // and the ONE thing to do next. The maturity level used to live here too — it
  // is already the Assessment nav count three rows below, and the strategy is
  // already on Settings and the Service profile.
  const m = snap.meta || {};
  if (!posture) return;
  posture.replaceChildren(
    h('div', { class: 'wp-regions' },
      h('span', null, m.regions?.primary || 'region?'),
      h('span', { class: 'wp-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', null, m.regions?.recovery || 'region?')),
    sidebarNext({ snap, ws }),
  );
}

async function refreshSidebar(ws, sapi = api) {
  try {
    // Scoped, so the counts in the sidebar describe the environment on screen
    // rather than the sum of every account.
    const snap = await ui.snapshot(sapi, ws);
    if (parseHash().ws === ws) paintSidebar(snap, ws);
  } catch { /* sidebar extras are never load-bearing */ }
}

// ---------------------------------------------------------------- routing

function showFirstRun() {
  outlet.replaceChildren(firstRunWelcome({ onCreate: newWorkspaceDialog, error: loadError }));
  posture?.replaceChildren();
  document.title = 'DR Compass';
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  let { ws, env: envSeg, page, params } = parseHash();

  if (!workspaces.length) {
    try { await loadWorkspaces(); } catch { /* handled below */ }
  }
  if (!ws || !workspaces.some((w) => w.slug === ws)) {
    ws = workspaces[0]?.slug;
    if (!ws) { showFirstRun(); return; }
    location.replace(hrefFor(ws, envSeg, PAGES.includes(page) ? page : 'dashboard', ...params));
    return;
  }
  if (!PAGES.includes(page)) page = 'dashboard';

  // ---- canonicalise the environment segment BEFORE anything is fetched.
  const envs = await envsFor(ws);
  if (seq !== routeSeq) return;
  const chosen = resolveEnv(envs, envSeg, ws);

  if (envs.multi) {
    // The workspace has environments, so the canonical route carries one. An
    // old link (`#/ws/inventory`) or an unknown slug lands here and is replaced
    // — no history entry, and the page it asked for is the page it gets.
    if (envSeg !== chosen.slug) {
      location.replace(hrefFor(ws, chosen.slug, page, ...params));
      return;
    }
    ui.writeEnvPref(ws, chosen.slug);
  } else if (envSeg) {
    // Environments were removed (or never existed) but the link still names
    // one: drop the segment rather than 404 the page.
    location.replace(hrefFor(ws, null, page, ...params));
    return;
  }

  wsSelect.value = ws;
  currentRoute = { ws, envSlug: chosen.slug, multi: envs.multi };
  paintEnvSwitcher(envs, chosen, ws, page, params);
  setJourneyEnv(chosen.slug);

  // Every read from here on carries the scope; writes go out unscoped.
  const sapi = ui.scopedApi(api, { envId: chosen.envId });

  document.querySelectorAll('#nav a').forEach((a) => {
    const on = a.dataset.page === page;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    a.href = hrefFor(ws, chosen.slug, a.dataset.page);
  });

  outlet.setAttribute('aria-busy', 'true');
  outlet.replaceChildren(ui.skeleton({ rows: 4, label: 'Loading page' }));
  // Fresh facts once per navigation; the page's own ui.snapshot() call shares
  // this in-flight request rather than fanning out again.
  ui.invalidateSnapshot(ws);
  refreshSidebar(ws, sapi);

  // Let the outgoing page tear down first: pages that mount a diagram canvas
  // (or any long-lived listener) leak the engine otherwise. A page opts in by
  // returning a cleanup function from render(), or by exporting destroy().
  await runPageCleanup();

  try {
    const mod = (await import(`./pages/${page}.js`)).default;
    // `api` is the SCOPED api: a page written before environments existed keeps
    // calling `api.get('/w/:ws/c/components')` and now gets this environment's
    // components without a line of change. `api.raw` is the unscoped one.
    const ctx = {
      ws, api: sapi, ui, params, navigate,
      env: chosen.env, envId: chosen.envId, envSlug: chosen.slug,
      environments: envs.items, allEnvironments: chosen.all,
      href: (p, ...rest) => hrefFor(ws, chosen.slug, p, ...rest),
    };
    const el = h('div');
    const cleanup = await mod.render(el, ctx);
    if (seq !== routeSeq) {
      // A newer navigation won — tear this one down instead of leaking it.
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      return;
    }
    pageCleanup = typeof cleanup === 'function'
      ? cleanup
      : (typeof mod.destroy === 'function' ? () => mod.destroy() : null);
    outlet.replaceChildren(el);
    document.title = `${mod.title || page} · DR Compass`;
    if (routeStatus) routeStatus.textContent = `${mod.title || page} loaded`;
  } catch (e) {
    console.error(e);
    if (seq !== routeSeq) return;
    outlet.replaceChildren(ui.card(
      h('h2', null, 'This page could not be opened'),
      h('p', null, 'The rest of the app is fine — your data is untouched. If this keeps happening, the detail below is what a developer needs.'),
      h('div', { class: 'row', style: 'margin:14px 0' },
        btn({ label: 'Try again', kind: 'btn-primary', onClick: () => route() }),
        btn({ label: 'Back to Overview', href: hrefFor(ws, chosen.slug, 'dashboard') })),
      h('details', null,
        h('summary', { class: 'hint' }, 'Technical detail'),
        h('pre', null, e.stack || e.message))));
    document.title = 'Problem · DR Compass';
  } finally {
    if (seq === routeSeq) outlet.removeAttribute('aria-busy');
  }
}

/** Pages that write data can ask the shell to re-read the program state. */
window.addEventListener('drcompass:data-changed', async (e) => {
  const { ws, env } = parseHash();
  if (!ws) return;
  ui.invalidateSnapshot(ws);
  // Settings can add, rename or remove an environment — the switcher itself is
  // then out of date, not just the counts.
  if (e?.detail?.environments) {
    invalidateEnvs(ws);
    route();
    return;
  }
  const envs = await envsFor(ws);
  refreshSidebar(ws, ui.scopedApi(api, { envId: resolveEnv(envs, env, ws).envId }));
});

wsSelect.addEventListener('change', () => {
  // A different workspace has different environments; its own remembered
  // choice is resolved on arrival rather than carried across from this one.
  const { page } = parseHash();
  navigate(hrefFor(wsSelect.value, null, page));
});
document.getElementById('ws-new').addEventListener('click', newWorkspaceDialog);
window.addEventListener('hashchange', route);

const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'Runs on your machine · your data stays local';

route();
initAssistant();
