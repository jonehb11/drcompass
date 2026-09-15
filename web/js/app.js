import { api } from './api.js';
import * as ui from './ui.js';
import { h, toast, modal, field } from './ui.js';

const PAGES = ['dashboard', 'assessment', 'inventory', 'diagrams', 'runbooks', 'tests', 'checklists', 'discover', 'exports', 'learn', 'settings'];
const outlet = document.getElementById('outlet');
const wsSelect = document.getElementById('ws-select');
let workspaces = [];

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { ws: parts[0] || null, page: parts[1] || 'dashboard', params: parts.slice(2) };
}
export function navigate(hash) { location.hash = hash; }

async function loadWorkspaces() {
  workspaces = await api.get('/workspaces');
  wsSelect.innerHTML = '';
  for (const w of workspaces) wsSelect.append(h('option', { value: w.slug }, w.name));
}

async function newWorkspaceDialog() {
  const name = h('input', { placeholder: 'e.g. Payments Platform' });
  const slug = h('input', { placeholder: 'e.g. payments' });
  const primary = h('input', { value: 'us-east-1' });
  const recovery = h('input', { value: 'us-west-2' });
  const ok = await modal('New workspace', h('div', null,
    field('Name', name), field('Slug (letters, numbers, dashes)', slug),
    h('div', { class: 'grid cols-2' }, field('Primary region', primary), field('Recovery region', recovery)),
  ), { actions: [{ label: 'Create', kind: 'btn-primary', value: true }] });
  if (!ok) return;
  try {
    const ws = await api.post('/workspaces', {
      slug: slug.value.trim() || name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: name.value.trim() || slug.value.trim(),
      regions: { primary: primary.value.trim(), recovery: recovery.value.trim() },
    });
    await loadWorkspaces();
    navigate(`#/${ws.slug}/assessment`);
    toast(`Workspace '${ws.name}' created — start with the assessment`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function route() {
  let { ws, page, params } = parseHash();
  if (!workspaces.length) await loadWorkspaces().catch(() => {});
  if (!ws || !workspaces.some((w) => w.slug === ws)) {
    ws = workspaces[0]?.slug;
    if (!ws) { outlet.innerHTML = ''; outlet.append(ui.empty('No workspaces yet — create one with ＋')); return; }
    location.replace(`#/${ws}/${page}`);
    return;
  }
  if (!PAGES.includes(page)) page = 'dashboard';
  wsSelect.value = ws;
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === page);
    a.href = `#/${ws}/${a.dataset.page}`;
  });
  outlet.innerHTML = '';
  outlet.append(h('div', { class: 'loading' }, 'Loading…'));
  try {
    const mod = (await import(`./pages/${page}.js`)).default;
    const ctx = { ws, api, ui, params, navigate };
    const el = h('div');
    await mod.render(el, ctx);
    outlet.innerHTML = '';
    outlet.append(el);
    document.title = `${mod.title || page} · DR Compass`;
  } catch (e) {
    console.error(e);
    outlet.innerHTML = '';
    outlet.append(ui.card(h('h2', null, 'This page failed to load'), h('pre', null, e.stack || e.message)));
  }
}

wsSelect.addEventListener('change', () => {
  const { page } = parseHash();
  navigate(`#/${wsSelect.value}/${page}`);
});
document.getElementById('ws-new').addEventListener('click', newWorkspaceDialog);
window.addEventListener('hashchange', route);
route();
