import { api } from './api.js';
import * as ui from './ui.js';
import { h, toast, modal, field, btn } from './ui.js';
import { initAssistant } from './assistant.js';
import { firstRunWelcome, programProgress } from './onboarding.js';

const PAGES = ['dashboard', 'assessment', 'inventory', 'service', 'diagrams', 'runbooks', 'tests', 'checklists', 'discover', 'exports', 'learn', 'settings'];

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
let workspaces = [];
let loadError = null;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { ws: parts[0] || null, page: parts[1] || 'dashboard', params: parts.slice(2) };
}
export function navigate(hash) { location.hash = hash; }

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
      'One workspace per system you are responsible for recovering. Everything else — inventory, runbooks, tests — lives inside it. All of this can be changed later.'),
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
  setSlot('tests', snap.lastTest
    ? h('span', { class: 'nx-pair' }, ui.dot(ui.statusKind(snap.lastTest.status), `last test ${snap.lastTest.status}`), navCount(c.tests))
    : (c.tests ? navCount(c.tests) : ui.dot('warn', 'never tested')));
  setSlot('settings', (obj.rtoMinutes === null || obj.rtoMinutes === undefined || !obj.approved)
    ? ui.dot('warn', obj.rtoMinutes == null ? 'no recovery target set' : 'targets not approved')
    : null);

  // ---- workspace posture: name is in the select, this is the "how are we doing"
  const m = snap.meta || {};
  const prog = programProgress(snap, ws);
  if (!posture) return;
  posture.replaceChildren(
    h('div', { class: 'wp-regions' },
      h('span', null, m.regions?.primary || 'region?'),
      h('span', { class: 'wp-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', null, m.regions?.recovery || 'region?')),
    h('div', { class: 'wp-line' },
      ui.humanStrategy(m.strategy),
      rep ? h('span', null, ' · ', h('span', { class: `wp-lvl lvl-${rep.level}` }, `Level ${rep.level}`)) : null),
    prog.complete
      ? h('div', { class: 'wp-line wp-ok' }, ui.dot('ok'), ' All five foundations done')
      : h('a', { class: 'wp-prog', href: `#/${ws}/dashboard` },
          h('span', { class: 'progress wp-bar' }, h('div', { style: `width:${Math.round((prog.done / prog.total) * 100)}%` })),
          h('span', { class: 'wp-prog-t' }, `Getting started ${prog.done}/${prog.total}`)),
  );
}

async function refreshSidebar(ws) {
  try {
    const snap = await ui.snapshot(api, ws);
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
  let { ws, page, params } = parseHash();

  if (!workspaces.length) {
    try { await loadWorkspaces(); } catch { /* handled below */ }
  }
  if (!ws || !workspaces.some((w) => w.slug === ws)) {
    ws = workspaces[0]?.slug;
    if (!ws) { showFirstRun(); return; }
    location.replace(`#/${ws}/${PAGES.includes(page) ? page : 'dashboard'}`);
    return;
  }
  if (!PAGES.includes(page)) page = 'dashboard';
  wsSelect.value = ws;

  document.querySelectorAll('#nav a').forEach((a) => {
    const on = a.dataset.page === page;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    a.href = `#/${ws}/${a.dataset.page}`;
  });

  outlet.setAttribute('aria-busy', 'true');
  outlet.replaceChildren(ui.skeleton({ rows: 4, label: 'Loading page' }));
  // Fresh facts once per navigation; the page's own ui.snapshot() call shares
  // this in-flight request rather than fanning out again.
  ui.invalidateSnapshot(ws);
  refreshSidebar(ws);

  // Let the outgoing page tear down first: pages that mount a diagram canvas
  // (or any long-lived listener) leak the engine otherwise. A page opts in by
  // returning a cleanup function from render(), or by exporting destroy().
  await runPageCleanup();

  try {
    const mod = (await import(`./pages/${page}.js`)).default;
    const ctx = { ws, api, ui, params, navigate };
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
        btn({ label: 'Back to Overview', href: `#/${ws}/dashboard` })),
      h('details', null,
        h('summary', { class: 'hint' }, 'Technical detail'),
        h('pre', null, e.stack || e.message))));
    document.title = 'Problem · DR Compass';
  } finally {
    if (seq === routeSeq) outlet.removeAttribute('aria-busy');
  }
}

/** Pages that write data can ask the shell to re-read the program state. */
window.addEventListener('drcompass:data-changed', () => {
  const { ws } = parseHash();
  if (!ws) return;
  ui.invalidateSnapshot(ws);
  refreshSidebar(ws);
});

wsSelect.addEventListener('change', () => {
  const { page } = parseHash();
  navigate(`#/${wsSelect.value}/${page}`);
});
document.getElementById('ws-new').addEventListener('click', newWorkspaceDialog);
window.addEventListener('hashchange', route);

const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'Runs on your machine · your data stays local';

route();
initAssistant();
