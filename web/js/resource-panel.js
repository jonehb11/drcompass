// DR Compass — resource detail panel (Arpio-style right-side drawer).
// openResourcePanel({ ws, api, ui, node, anchor }) shows details for:
//   - component nodes  (id 'cmp_*' / 'rec_cmp_*', or a node carrying componentId)
//   - k8s snapshot nodes (workload uids 'ns/Kind/name', 'svc:', 'ing:', 'cm:',
//     'sec:', 'pvc:', 'hpa:' prefixed ids, and the 'k8s:nodes' summary)
//   - plain/synthetic nodes (ext_*, rec_*) — whatever is known.
// Backends may not exist yet (501s) — every fetch degrades to a friendly state.

import { h, badge, toast as uiToast } from './ui.js';

const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job'];
const LS_PROFILE = 'drcompass.enrich.profile';
const LS_REGION = 'drcompass.enrich.region';

// ---------------------------------------------------------------- styles
// The panel's base styles live in web/css/app.css (.rp-*); these additions are
// injected by the module itself so no shared stylesheet has to change.
const STYLE_ID = 'rp2-styles';
const STYLES = `
.rp-section-title { display: flex; align-items: baseline; gap: 7px; }
.rp2-n { font-size: 10.5px; font-weight: 700; letter-spacing: 0; color: var(--muted);
  background: var(--bg2); border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; }
.rp2-tools { margin-left: auto; display: flex; gap: 6px; }
.rp2-tool { background: none; border: 0; color: var(--muted); cursor: pointer;
  font: 600 10.5px var(--sans); letter-spacing: .04em; text-transform: uppercase; padding: 0 2px; }
.rp2-tool:hover { color: var(--accent); }
/* group header: glyph + name + count, one scannable line */
.rp-group > summary { display: flex; align-items: center; gap: 8px; }
.rp-group > summary::-webkit-details-marker { display: none; }
.rp-group > summary::before { content: '▸'; color: var(--muted); font-size: 9px; flex: none; width: 8px; }
.rp-group[open] > summary::before { content: '▾'; }
.rp2-grp-name { min-width: 0; overflow-wrap: anywhere; }
.rp2-grp-n { margin-left: auto; flex: none; font-size: 11px; color: var(--muted); }
/* long values wrap at word boundaries first, then anywhere — never mid-token
   unless the token itself is longer than the panel */
.rp2-val { overflow-wrap: anywhere; word-break: normal; min-width: 0; }
.rp2-arn { font-family: var(--mono); font-size: 11px; line-height: 1.45; color: var(--text);
  background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 7px;
  overflow-wrap: anywhere; word-break: normal; }
.rp2-arnrow { display: flex; flex-direction: column; gap: 3px; }
.rp2-copy { align-self: flex-start; background: none; border: 1px solid var(--border); border-radius: 5px;
  color: var(--muted); cursor: pointer; font: 600 10px var(--sans); padding: 1px 6px; }
.rp2-copy:hover { color: var(--accent); border-color: var(--accent); }
.rp2-long { max-height: 96px; overflow: auto; display: block; }
.rp2-more { background: none; border: 0; color: var(--accent); cursor: pointer;
  font: 600 11px var(--sans); padding: 0; }
.rp2-empty { color: var(--muted); font-size: 12px; }
.rp2-ai { margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 6px; }
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLES;
  document.head.appendChild(s);
}

let current = null;          // { root, onKey }
const openCache = new Map(); // per-open fetch cache (cleared on close)

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export function closeResourcePanel() {
  if (!current) return;
  document.removeEventListener('keydown', current.onKey);
  const root = current.root;
  current = null;
  openCache.clear();
  root.classList.remove('open');
  setTimeout(() => root.remove(), 240);
}

function cached(key, fn) {
  if (!openCache.has(key)) openCache.set(key, fn().catch((e) => { openCache.delete(key); throw e; }));
  return openCache.get(key);
}

// ---------------------------------------------------------------- classify

function classify(node) {
  const id = String(node?.id ?? '');
  if (/^(svc|ing|cm|sec|pvc|hpa):/.test(id) || id === 'k8s:nodes') return { type: 'k8s', id };
  const uid = id.split('/');
  if (uid.length === 3 && WORKLOAD_KINDS.includes(uid[1])) return { type: 'k8s', id };
  if (node?.k8sKind) return { type: 'k8s', id };
  if (id.startsWith('cmp_')) return { type: 'component', componentId: id };
  if (id.startsWith('rec_cmp_')) return { type: 'component', componentId: id.slice('rec_'.length) };
  if (node?.componentId) return { type: 'component', componentId: node.componentId };
  return { type: 'plain', id };
}

// ---------------------------------------------------------------- open

export function openResourcePanel({ ws, api, ui, node, anchor, onExpand } = {}) {
  if (!ws || !api || !node) return;
  const toast = ui?.toast || uiToast;
  injectStyles();
  closeResourcePanel();

  const body = h('div', { class: 'rp-body' }, h('div', { class: 'loading' }, 'Loading…'));
  const titleEl = h('div', { class: 'rp-title' }, String(node.label ?? node.id ?? ''));
  const badgesEl = h('div', { class: 'rp-title-badges' });
  const root = h('div', { class: 'rp-drawer', role: 'dialog', 'aria-label': 'Resource details' },
    h('div', { class: 'rp-head' },
      h('div', { class: 'rp-head-main' }, titleEl, badgesEl),
      h('button', { class: 'rp-close', title: 'Close (Esc)', onClick: closeResourcePanel }, '✕')),
    body);
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('open'));

  const onKey = (ev) => { if (ev.key === 'Escape') closeResourcePanel(); };
  document.addEventListener('keydown', onKey);
  current = { root, onKey };

  const ctx = {
    ws, api, toast,
    setTitle(text, badges = []) {
      titleEl.textContent = text;
      badgesEl.textContent = '';
      badgesEl.append(...badges);
    },
    reopen(nextNode) { openResourcePanel({ ws, api, ui, node: nextNode, anchor, onExpand }); },
    body,
    // Optional (additive): host page callback to expand this component's
    // resource associations in-place on an active diagram canvas.
    onExpand: typeof onExpand === 'function' ? onExpand : null,
  };

  const kind = classify(node);
  const render = kind.type === 'component'
    ? renderComponent(ctx, kind.componentId, node)
    : kind.type === 'k8s'
      ? renderK8s(ctx, node)
      : Promise.resolve(renderPlain(ctx, node));
  Promise.resolve(render).catch((e) => {
    body.textContent = '';
    body.append(section('Problem', h('p', { class: 'hint', style: 'color:var(--err)' }, String(e?.message || e))));
  });
}

// ---------------------------------------------------------------- widgets

// section('Title', ...children) or section({title, count, tools}, ...children)
function section(title, ...children) {
  const spec = title && typeof title === 'object' && !title.nodeType ? title : { title };
  const head = spec.title
    ? h('div', { class: 'rp-section-title' },
      h('span', null, spec.title),
      spec.count !== undefined && spec.count !== null ? h('span', { class: 'rp2-n' }, String(spec.count)) : null,
      spec.tools ? h('span', { class: 'rp2-tools' }, spec.tools) : null)
    : null;
  return h('div', { class: 'rp-section' }, head, ...children);
}

function factRow(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return h('div', { class: 'rp-fact' },
    h('span', { class: 'rp-fact-k' }, label),
    h('span', { class: 'rp-fact-v rp2-val' }, value));
}

// A long scalar: shown truncated with a reveal, so one fat JSON detail cannot
// push the rest of the panel off screen.
const LONG_AT = 170;
function longValue(text) {
  const s = String(text);
  if (s.length <= LONG_AT) return h('span', { class: 'rp2-val' }, s);
  const short = h('span', { class: 'rp2-val' }, `${s.slice(0, LONG_AT)}… `);
  const box = h('span', { class: 'rp2-val' });
  const more = h('button', { class: 'rp2-more' }, 'show all');
  more.addEventListener('click', () => {
    box.textContent = '';
    box.append(h('span', { class: 'rp2-val rp2-long' }, s));
  });
  box.append(short, more);
  return box;
}

// ARN / long identifier: its own monospace block with a copy button, wrapping at
// word boundaries rather than breaking mid-token.
function arnRow(label, value, toast) {
  const v = String(value);
  const copy = h('button', { class: 'rp2-copy' }, 'Copy');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(v); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400); }
    catch { if (toast) toast('Clipboard unavailable', 'err'); }
  });
  return h('div', { class: 'rp-fact' },
    h('span', { class: 'rp-fact-k' }, label),
    h('span', { class: 'rp2-arnrow', style: 'flex:1; min-width:0' }, h('span', { class: 'rp2-arn' }, v), copy));
}

function chips(list, { mono = false } = {}) {
  const shown = (list || []).slice(0, 40);
  if (!shown.length) return null;
  return h('div', { class: 'rp-chips' },
    shown.map((t) => h('span', { class: `rp-chip${mono ? ' mono' : ''}` }, t)),
    (list.length > 40) ? h('span', { class: 'hint' }, `+${list.length - 40} more`) : null);
}

function linkBtn(label, onClick) {
  return h('button', { class: 'rp-link', onClick }, label);
}

// ---------------------------------------------------------------- component

const UPPER_TOKENS = new Set(['iam', 'kms', 'dns', 'vpc', 'eni', 'eip', 'alb', 'nlb', 'elb', 'sg', 'acm', 's3', 'sqs', 'sns', 'rds', 'hpa', 'nat', 'api', 'db', 'oidc', 'arn', 'ec2', 'eks', 'ecs', 'ecr',
  'nacl', 'az', 'efs', 'ebs', 'elb', 'waf', 'tls', 'ssl', 'cidr', 'asg', 'ami', 'tg', 'nlb']);

// 'iam-policy' ×3 → 'IAM Policies' (the bare-'s' version produced "Policys").
function typeLabel(type, count) {
  const words = String(type === 'other' ? 'resource' : (type || 'resource')).split(/[-_\s]+/).filter(Boolean)
    .map((w) => (UPPER_TOKENS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  let label = words.join(' ') || 'Resource';
  if (count !== 1 && !/s$/i.test(label)) {
    label = /[^aeiouAEIOU]y$/.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`;
  }
  return label;
}

function typeGlyph(type) {
  const t = String(type || '').toLowerCase();
  const map = [
    [/security.?group/, 'SG'], [/subnet/, 'SN'], [/vpc.?link/, 'VL'], [/vpc/, 'VPC'],
    [/target.?group/, 'TG'], [/listener/, 'LSN'], [/load.?balancer|\b[an]?lb\b/, 'LB'],
    [/route.?table/, 'RT'], [/nat/, 'NAT'], [/gateway/, 'GW'], [/eni|network.?interface/, 'ENI'],
    [/iam|role|policy|profile|oidc/, 'IAM'], [/kms/, 'KMS'], [/cert|acm/, 'CRT'],
    [/dns|route.?53|hosted.?zone|record/, 'DNS'], [/secret/, 'SEC'], [/bucket|s3/, 'S3'],
    [/db|rds|aurora|dynamo|table/, 'DB'], [/queue|sqs/, 'Q'], [/topic|sns/, 'T'],
    [/stream|kinesis/, 'STR'], [/alarm|log|metric|dashboard/, 'OBS'], [/volume|snapshot|efs/, 'VOL'],
  ];
  for (const [re, g] of map) if (re.test(t)) return g;
  const initials = t.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase();
  return (initials || 'R').slice(0, 3);
}

// networking → identity → data → observability → everything else
function typeRank(type) {
  const t = String(type || '').toLowerCase();
  const buckets = [
    /vpc|subnet|security|route|nat|gateway|eni|network|eip|load.?balancer|\b[an]?lb\b|target.?group|listener|endpoint|api|cloudfront|dns|hosted/,
    /iam|role|policy|profile|oidc|identity/,
    /kms|secret|cert|acm|db|rds|aurora|dynamo|s3|bucket|efs|volume|snapshot|queue|sqs|sns|topic|stream|kinesis|table|cache/,
    /cloudwatch|alarm|log|dashboard|metric|x.?ray|observ/,
  ];
  for (let i = 0; i < buckets.length; i++) if (buckets[i].test(t)) return i;
  return buckets.length;
}

// '4 security groups, 6 subnets, 2 IAM roles' — compact context for the AI.
function resourceTypeSummary(resources) {
  const counts = new Map();
  for (const r of (resources || [])) {
    const t = r?.type || 'resource';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 14)
    .map(([t, c]) => `${c} ${typeLabel(t, c).toLowerCase()}`);
}

function tagList(tags) {
  return Object.entries(tags || {}).map(([k, v]) => (v === '' || v === null || v === undefined) ? k : `${k}=${v}`);
}

function resourceRow(res, toast) {
  const details = Object.entries(res.details || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const tags = tagList(res.tags);
  return h('details', { class: 'rp-res' },
    h('summary', null,
      h('span', { class: 'rp-glyph' }, typeGlyph(res.type)),
      h('span', { class: 'rp-res-name' }, res.name || res.rid),
      h('span', { class: 'rp-res-rid mono', title: res.rid }, res.rid)),
    h('div', { class: 'rp-res-body' },
      res.arn ? arnRow('ARN', res.arn, toast) : null,
      res.rid && res.rid !== res.name ? arnRow('Resource id', res.rid, toast) : null,
      res.region ? factRow('Region', res.region) : null,
      res.service ? factRow('Service', res.service) : null,
      res.source ? factRow('Source', res.source) : null,
      details.map(([k, v]) => factRow(k, longValue(typeof v === 'object' ? JSON.stringify(v) : String(v)))),
      tags.length ? h('div', { style: 'margin-top:6px' }, chips(tags)) : null));
}

async function renderComponent(ctx, componentId, originNode) {
  const { ws, api, body } = ctx;
  const [compsR, graphR] = await Promise.allSettled([
    cached(`components:${ws}`, () => api.get(`/w/${ws}/c/components`)),
    api.get(`/w/${ws}/resources/graph?componentId=${encodeURIComponent(componentId)}`),
  ]);
  const components = compsR.status === 'fulfilled' ? (compsR.value?.items || []) : [];
  const comp = components.find((c) => c.id === componentId);
  const graph = graphR.status === 'fulfilled' ? graphR.value : null;
  const graphErr = graphR.status === 'rejected' ? String(graphR.reason?.message || graphR.reason) : null;

  const name = comp?.name || originNode?.label || componentId;
  ctx.setTitle(name, [
    comp?.kind ? badge(comp.kind, 'accent') : null,
    comp && typeof comp.tier === 'number' ? badge(`tier ${comp.tier}`, comp.tier === 0 ? 'warn' : '') : null,
  ].filter(Boolean));

  body.textContent = '';

  if (!comp && compsR.status === 'fulfilled') {
    body.append(section(null, h('p', { class: 'hint' }, `Component ${componentId} is not in the inventory (it may have been removed).`)));
  } else if (compsR.status === 'rejected') {
    body.append(section(null, h('p', { class: 'hint', style: 'color:var(--warn)' }, `Could not load the inventory: ${compsR.reason?.message || compsR.reason}`)));
  }

  // 0 — show on diagram (only when the host page can expand on an active canvas)
  if (ctx.onExpand) {
    const fn = ctx.onExpand;
    body.append(h('div', { style: 'padding: 2px 0 8px' },
      h('button', {
        class: 'btn btn-sm',
        onClick: () => {
          closeResourcePanel();
          try { fn(componentId); } catch { /* host page handles its own errors */ }
        },
      }, '⊕ Show on diagram')));
  }

  // 0b — AI (answer only), per the ai-first-class contract in
  // INTEGRATION-NOTES: `aiButton` owns the modal, the CLI-missing disabled state
  // and error reporting. The module is shipped by a parallel agent and may not
  // exist yet, so it is imported lazily and this degrades to nothing at all.
  {
    const aiRow = h('div', { class: 'rp2-ai' });
    body.append(aiRow);
    (async () => {
      let mod = null;
      try { mod = await import('./ai-actions.js'); } catch { return; }
      if (!mod) return;
      const usedBy = components.filter((c) => (c.dependsOn || []).includes(componentId)).map((c) => c.name);
      // Facts the prompt is allowed to rely on. The bridge already pulls the
      // component and its neighbors in from `kind`/`id`; `extra` adds what only
      // this panel knows (the discovered-resource rollup).
      const buildContext = () => ({
        kind: 'component',
        id: componentId,
        extra: {
          dependedOnBy: usedBy,
          outboundCalls: (comp?.outboundCalls || []).map((oc) => oc.target).filter(Boolean),
          discoveredResources: resourceTypeSummary(resources),
        },
      });
      const prompt = `${name} has failed in the primary region. What breaks, what degrades, which restore `
        + 'layers are blocked, and what should be verified first? Use only the facts provided — do not '
        + 'invent RTO/RPO numbers.';

      if (typeof mod.aiButton === 'function') {
        try {
          const btn = mod.aiButton({
            ws, api,
            label: 'What breaks if this fails?',
            title: 'Ask the AI what this component’s failure takes down (answer only)',
            mode: 'answer', glyph: '✦',
            prompt,
            context: buildContext,
            modalTitle: `What breaks if ${name} fails?`,
          });
          if (btn && btn.nodeType === 1) { aiRow.append(btn); return; }
        } catch { /* fall through to our own button */ }
      }
      if (typeof mod.aiAsk !== 'function') return;
      try {
        const flag = mod.AI_AVAILABLE;
        if (flag !== undefined && flag !== null) {
          const value = typeof flag === 'function' ? await flag() : await flag;
          if (value === false) return;
        }
      } catch { /* not advertised — try anyway */ }
      const btn = h('button', { class: 'btn btn-sm' }, 'What breaks if this fails?');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Asking…';
        try {
          const res = await mod.aiAsk({ ws, api, prompt, context: buildContext() });
          if (res === undefined || res === null) return; // module showed its own UI
          if (typeof res === 'object' && res.ok === false) {
            ctx.toast(res.message || 'The AI could not answer that', 'err');
            return;
          }
          const text = typeof res === 'string' ? res : (res.answer ?? res.markdown ?? '');
          if (!text) { ctx.toast('The AI returned no answer', 'err'); return; }
          const out = h('div', { class: 'rp2-val', style: 'font-size:12.5px; line-height:1.6; white-space:pre-wrap' }, String(text));
          aiRow.after(section({ title: 'AI — blast radius' }, out));
        } catch (e) {
          ctx.toast(`AI unavailable: ${e?.message || e}`, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
      aiRow.append(btn);
    })().catch(() => { /* AI is strictly optional */ });
  }

  // 1 — quick facts
  if (comp) {
    body.append(section('Quick facts',
      h('div', { class: 'rp-facts' },
        factRow('Category', comp.category || 'other'),
        factRow('Restore layer', comp.restoreLayer || ''),
        factRow('Recovery scope', comp.inRecoveryScope || 'unknown'),
        factRow('Replication', [comp.replication?.mechanism, comp.replication?.rpoMinutes ? `RPO ${comp.replication.rpoMinutes}m` : ''].filter(Boolean).join(' · ')),
        factRow('Owner', [comp.owner, comp.team].filter(Boolean).join(' · ')))));
  }

  // 2 — associated resources (from the resource graph)
  const resources = graph ? Object.values(graph.nodes || {}).filter((n) => n && n.rid && !String(n.rid).startsWith('cmp_')) : [];
  const resBox = h('div');
  const expandAll = h('button', { class: 'rp2-tool', title: 'Open every resource-type group' }, 'Expand all');
  const collapseAll = h('button', { class: 'rp2-tool', title: 'Close every resource-type group' }, 'Collapse all');
  const setAllGroups = (open) => {
    resBox.querySelectorAll('details.rp-group').forEach((d) => { d.open = open; });
  };
  expandAll.addEventListener('click', () => setAllGroups(true));
  collapseAll.addEventListener('click', () => setAllGroups(false));
  body.append(section({
    title: 'Associated resources',
    count: resources.length || null,
    tools: resources.length ? [expandAll, collapseAll] : null,
  }, resBox));

  const renderResources = () => {
    resBox.textContent = '';
    if (!resources.length) {
      if (graphErr) {
        resBox.append(h('p', { class: 'hint', style: 'color:var(--warn); margin-bottom:8px' },
          `Resource graph unavailable: ${graphErr}`));
      } else {
        resBox.append(h('p', { class: 'hint', style: 'margin-bottom:8px' },
          'No AWS resources discovered for this component yet.'));
      }
      buildEnrichForm(ctx, componentId, resBox);
      return;
    }
    const byType = new Map();
    for (const r of resources) {
      const t = r.type || 'resource';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(r);
    }
    const types = [...byType.keys()].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
    for (const t of types) {
      const rows = byType.get(t).slice().sort((a, b) => String(a.name || a.rid).localeCompare(String(b.name || b.rid)));
      resBox.append(h('details', { class: 'rp-group', open: types.length <= 3 ? true : null },
        h('summary', null,
          h('span', { class: 'rp-glyph' }, typeGlyph(t)),
          h('span', { class: 'rp2-grp-name' }, typeLabel(t, rows.length)),
          h('span', { class: 'rp2-grp-n' }, String(rows.length))),
        rows.map((r) => resourceRow(r, ctx.toast))));
    }
    // 3 — tags rollup
    const allTags = [...new Set(resources.flatMap((r) => tagList(r.tags)))];
    if (allTags.length) body.append(section({ title: 'Tags (across resources)', count: allTags.length }, chips(allTags)));
  };
  renderResources();

  // 4 — relationships
  if (comp) {
    const nameOf = (id) => components.find((c) => c.id === id)?.name || id;
    const usedBy = components.filter((c) => (c.dependsOn || []).includes(componentId));
    const depBtns = (comp.dependsOn || []).map((d) =>
      linkBtn(nameOf(d), () => ctx.reopen({ id: d, label: nameOf(d) })));
    const usedBtns = usedBy.map((c) =>
      linkBtn(c.name, () => ctx.reopen({ id: c.id, label: c.name })));
    const outbound = (comp.outboundCalls || []).map((oc) =>
      h('div', { class: 'rp-out' },
        h('span', null, oc.target || 'external'),
        h('span', { class: 'hint' }, [oc.type, oc.protocol].filter(Boolean).join(' · ')),
        oc.critical ? badge('critical', 'err') : null));
    body.append(section({ title: 'Relationships', count: depBtns.length + usedBtns.length + outbound.length || null },
      depBtns.length ? h('div', { class: 'rp-rel' }, h('span', { class: 'rp-fact-k' }, `Depends on (${depBtns.length})`), h('div', { class: 'rp-links' }, depBtns)) : null,
      usedBtns.length ? h('div', { class: 'rp-rel' }, h('span', { class: 'rp-fact-k' }, `Used by (${usedBtns.length})`), h('div', { class: 'rp-links' }, usedBtns)) : null,
      outbound.length ? h('div', { class: 'rp-rel' }, h('span', { class: 'rp-fact-k' }, 'Outbound calls'), h('div', null, outbound)) : null,
      (!depBtns.length && !usedBtns.length && !outbound.length) ? h('p', { class: 'hint' }, 'No declared relationships.') : null));
  }
}

// 5 — inline enrich form (only shown when the graph is empty/unavailable)
function buildEnrichForm(ctx, componentId, host) {
  const { ws, api, toast } = ctx;
  const form = h('div', { class: 'rp-enrich' });
  host.append(form);

  (async () => {
    let profiles = [];
    try {
      const p = await cached('profiles', () => api.get('/discover/aws/profiles'));
      profiles = Array.isArray(p?.profiles) ? p.profiles : [];
    } catch { /* profile listing unavailable — free-form input below */ }
    let primaryRegion = '';
    try {
      const meta = await cached(`workspace:${ws}`, () => api.get(`/w/${ws}/workspace`));
      primaryRegion = meta?.regions?.primary || '';
    } catch { /* fine — leave region blank */ }

    const savedProfile = lsGet(LS_PROFILE);
    const profileInput = profiles.length
      ? h('select', null, profiles.map((p) => {
          const name = typeof p === 'string' ? p : (p?.name || '');
          return h('option', { value: name, selected: name === savedProfile ? '' : null }, name);
        }))
      : h('input', { placeholder: 'AWS profile', value: savedProfile || '' });
    const regionInput = h('input', { placeholder: 'region', value: lsGet(LS_REGION) || primaryRegion });
    const goBtn = h('button', { class: 'btn btn-sm btn-primary' }, 'Enrich from AWS');
    const status = h('div', { class: 'hint', style: 'margin-top:6px' });
    const errBox = h('div', { class: 'rp-chips', style: 'margin-top:6px' });

    goBtn.addEventListener('click', async () => {
      const profile = String(profileInput.value || '').trim();
      const region = String(regionInput.value || '').trim();
      if (!region) { toast('Enter a region first', 'err'); return; }
      lsSet(LS_PROFILE, profile);
      lsSet(LS_REGION, region);
      goBtn.disabled = true;
      goBtn.textContent = 'Enriching…';
      status.textContent = 'Discovering resources — this can take a minute.';
      errBox.textContent = '';
      try {
        const out = await api.post(`/w/${ws}/resources/enrich`, { componentIds: [componentId], profile, region });
        const added = out?.addedNodes ?? 0, updated = out?.updatedNodes ?? 0;
        toast(`Enriched: ${added} added, ${updated} updated`, 'ok');
        for (const e of out?.errors || []) errBox.append(badge(String(e).slice(0, 120), 'warn'));
        if (out?.errors?.length) {
          status.textContent = 'Finished with warnings — refreshing…';
          setTimeout(() => ctx.reopen({ id: componentId }), 1200);
        } else {
          ctx.reopen({ id: componentId }); // re-fetch graph + re-render
        }
      } catch (e) {
        goBtn.disabled = false;
        goBtn.textContent = 'Enrich from AWS';
        status.textContent = '';
        errBox.append(badge(String(e?.message || e).slice(0, 160), 'warn'));
      }
    });

    form.append(
      h('div', { class: 'rp-enrich-row' },
        h('label', { class: 'field', style: 'flex:1; margin:0' }, h('span', null, 'AWS profile'), profileInput),
        h('label', { class: 'field', style: 'flex:1; margin:0' }, h('span', null, 'Region'), regionInput)),
      h('div', { style: 'margin-top:8px' }, goBtn),
      status, errBox);
  })().catch((e) => {
    form.append(h('p', { class: 'hint', style: 'color:var(--warn)' }, `Enrich unavailable: ${e?.message || e}`));
  });
}

// ---------------------------------------------------------------- k8s nodes

function getSnapshot(ctx) {
  return cached(`k8s:${ctx.ws}`, () => ctx.api.get(`/w/${ctx.ws}/k8s`));
}

const A = (v) => (Array.isArray(v) ? v : []);

async function renderK8s(ctx, node) {
  const { body } = ctx;
  let snap = null, snapErr = null;
  try { snap = await getSnapshot(ctx); } catch (e) { snapErr = String(e?.message || e); }

  const id = String(node.id ?? '');
  body.textContent = '';

  const compLink = (componentId) => componentId
    ? section('Inventory', h('div', { class: 'rp-links' },
        linkBtn(`Linked component: ${componentId}`, () => ctx.reopen({ id: componentId }))))
    : null;

  if (snapErr || !snap || typeof snap !== 'object' || !Object.keys(snap).length) {
    ctx.setTitle(String(node.label ?? id), [node.k8sKind ? badge(node.k8sKind, 'accent') : null].filter(Boolean));
    body.append(section(null,
      h('p', { class: 'hint', style: snapErr ? 'color:var(--warn)' : '' },
        snapErr ? `Kubernetes snapshot unavailable: ${snapErr}` : 'No Kubernetes snapshot captured yet — capture one in Discover → Kubernetes.'),
      node.sub ? h('p', { class: 'hint' }, node.sub) : null));
    if (node.componentId) body.append(compLink(node.componentId));
    return;
  }

  // cluster nodes summary
  if (id === 'k8s:nodes') {
    ctx.setTitle(snap.clusterName || 'Cluster nodes', [badge('Nodes', 'accent')]);
    const n = snap.nodes || {};
    body.append(section('Cluster',
      h('div', { class: 'rp-facts' },
        factRow('Cluster', snap.clusterName || ''),
        factRow('Context', snap.context || ''),
        factRow('Captured', snap.capturedAt || ''),
        factRow('Source', snap.source || ''),
        factRow('Nodes', n.count !== undefined ? `${n.readyCount ?? '?'}/${n.count} ready` : ''),
        factRow('Instance types', A(n.instanceTypes).join(', ')),
        factRow('Namespaces', String(A(snap.namespaces).length || '')),
        factRow('Workloads', String(A(snap.workloads).length || '')))));
    return;
  }

  const [prefix, rest] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : [null, id];
  const nsName = (s) => s.split('/')[0];
  const shortName = (s) => s.split('/').slice(1).join('/');

  // -- workload (uid ns/Kind/name)
  if (!prefix || !['svc', 'ing', 'cm', 'sec', 'pvc', 'hpa'].includes(prefix)) {
    const w = A(snap.workloads).find((x) => x.uid === id) || null;
    if (!w) {
      ctx.setTitle(String(node.label ?? id));
      body.append(section(null, h('p', { class: 'hint' }, 'This object is no longer in the captured snapshot.')));
      return;
    }
    ctx.setTitle(w.name, [badge(w.kind || 'Workload', 'accent'), badge(w.namespace, 'purple')]);
    const services = A(snap.services).filter((s) => A(s.targets).includes(w.uid));
    const svcNames = new Set(services.map((s) => s.name));
    const ingresses = A(snap.ingresses).filter((i) =>
      i.namespace === w.namespace && A(i.backends).some((b) => svcNames.has(b.service)));
    body.append(
      section('Workload', h('div', { class: 'rp-facts' },
        factRow('Namespace', w.namespace),
        factRow('Kind', w.kind),
        factRow('Replicas', w.replicas ? `${w.replicas.ready ?? 0}/${w.replicas.desired ?? '?'} ready` : ''),
        factRow('Service account', w.serviceAccount || ''))),
      A(w.images).length ? section('Images', h('div', null, A(w.images).map((img) => h('div', { class: 'mono rp-wrap', style: 'font-size:11.5px; margin:2px 0' }, img)))) : null,
      (A(w.configmaps).length || A(w.secrets).length)
        ? section('Config & secrets',
            A(w.configmaps).length ? h('div', { class: 'rp-rel' }, h('span', { class: 'rp-fact-k' }, 'ConfigMaps'), chips(A(w.configmaps), { mono: true })) : null,
            A(w.secrets).length ? h('div', { class: 'rp-rel' }, h('span', { class: 'rp-fact-k' }, 'Secrets'), chips(A(w.secrets), { mono: true })) : null)
        : null,
      services.length ? section('Exposed by',
        services.map((s) => h('div', { class: 'rp-out' },
          linkBtn(s.name, () => ctx.reopen({ id: `svc:${s.namespace}/${s.name}` })),
          h('span', { class: 'hint' }, [s.type || 'ClusterIP', A(s.ports).map((p) => `${p.port}→${p.targetPort}`).join(', ')].filter(Boolean).join(' · '))))) : null,
      ingresses.length ? section('Ingress hosts',
        chips([...new Set(ingresses.flatMap((i) => A(i.hosts)))], { mono: true })
          || h('p', { class: 'hint' }, ingresses.map((i) => i.name).join(', '))) : null,
      Object.keys(w.labels || {}).length ? section('Labels', chips(tagList(w.labels))) : null,
      compLink(w.componentId));
    return;
  }

  // -- service / ingress / configmap / secret / pvc / hpa
  const ns = nsName(rest), name = shortName(rest);

  if (prefix === 'svc') {
    const s = A(snap.services).find((x) => x.namespace === ns && x.name === name);
    ctx.setTitle(name, [badge('Service', 'accent'), badge(ns, 'purple')]);
    if (!s) { body.append(section(null, h('p', { class: 'hint' }, 'Service not found in the snapshot.'))); return; }
    const targets = A(s.targets).map((uid) => A(snap.workloads).find((w) => w.uid === uid)).filter(Boolean);
    const ingresses = A(snap.ingresses).filter((i) => i.namespace === ns && A(i.backends).some((b) => b.service === name));
    body.append(
      section('Service', h('div', { class: 'rp-facts' },
        factRow('Namespace', ns),
        factRow('Type', s.type || 'ClusterIP'),
        factRow('Ports', A(s.ports).map((p) => `${p.port} → ${p.targetPort}`).join(', ')),
        factRow('Selector', tagList(s.selector).join(', ')))),
      targets.length ? section('Targets', h('div', { class: 'rp-links' },
        targets.map((w) => linkBtn(`${w.kind}/${w.name}`, () => ctx.reopen({ id: w.uid }))))) : null,
      ingresses.length ? section('Routed by', h('div', { class: 'rp-links' },
        ingresses.map((i) => linkBtn(i.name, () => ctx.reopen({ id: `ing:${i.namespace}/${i.name}` }))))) : null);
    return;
  }

  if (prefix === 'ing') {
    const i = A(snap.ingresses).find((x) => x.namespace === ns && x.name === name);
    ctx.setTitle(name, [badge('Ingress', 'accent'), badge(ns, 'purple')]);
    if (!i) { body.append(section(null, h('p', { class: 'hint' }, 'Ingress not found in the snapshot.'))); return; }
    body.append(
      section('Ingress', h('div', { class: 'rp-facts' },
        factRow('Namespace', ns),
        factRow('Class', i.class || ''))),
      A(i.hosts).length ? section('Hosts', chips(A(i.hosts), { mono: true })) : null,
      A(i.backends).length ? section('Backends', h('div', { class: 'rp-links' },
        A(i.backends).map((b) => linkBtn(`${b.service}:${b.port}`, () => ctx.reopen({ id: `svc:${ns}/${b.service}` }))))) : null);
    return;
  }

  if (prefix === 'pvc') {
    const p = A(snap.pvcs).find((x) => x.namespace === ns && x.name === name);
    ctx.setTitle(name, [badge('PVC', 'accent'), badge(ns, 'purple')]);
    body.append(section('PersistentVolumeClaim', h('div', { class: 'rp-facts' },
      factRow('Namespace', ns),
      factRow('Size', p?.size || ''),
      factRow('Storage class', p?.storageClass || ''),
      factRow('Bound to', p?.boundTo || ''))));
    return;
  }

  if (prefix === 'hpa') {
    const hp = A(snap.hpas).find((x) => x.namespace === ns && x.name === name);
    ctx.setTitle(name, [badge('HPA', 'accent'), badge(ns, 'purple')]);
    body.append(section('HorizontalPodAutoscaler', h('div', { class: 'rp-facts' },
      factRow('Namespace', ns),
      factRow('Target', hp?.target || ''),
      factRow('Replicas', hp ? `${hp.min ?? '?'} – ${hp.max ?? '?'}` : ''))));
    return;
  }

  // configmap / secret
  const kindName = prefix === 'cm' ? 'ConfigMap' : 'Secret';
  ctx.setTitle(name, [badge(kindName, 'accent'), badge(ns, 'purple')]);
  const users = A(snap.workloads).filter((w) => w.namespace === ns
    && A(prefix === 'cm' ? w.configmaps : w.secrets).includes(name));
  body.append(
    section(kindName, h('div', { class: 'rp-facts' }, factRow('Namespace', ns), factRow('Name', name))),
    users.length ? section('Used by', h('div', { class: 'rp-links' },
      users.map((w) => linkBtn(`${w.kind}/${w.name}`, () => ctx.reopen({ id: w.uid }))))) : null);
}

// ---------------------------------------------------------------- plain nodes

function renderPlain(ctx, node) {
  const { body } = ctx;
  const id = String(node.id ?? '');
  const flavor = id.startsWith('ext_') ? 'External target'
    : id.startsWith('rec_') ? 'Recovery-side mirror'
    : 'Diagram node';
  ctx.setTitle(String(node.label ?? id), [badge(flavor)].filter(Boolean));
  body.textContent = '';
  body.append(section('Known details', h('div', { class: 'rp-facts' },
    factRow('Kind', node.kind || ''),
    factRow('Category', node.category || ''),
    factRow('Info', node.sub || ''),
    factRow('Node id', h('span', { class: 'mono' }, id)))),
    h('p', { class: 'hint', style: 'padding:0 2px' },
      id.startsWith('ext_')
        ? 'This is a synthetic node for an outbound-call target outside the inventory — details live on the component that calls it.'
        : 'No further detail is tracked for this node.'));
}

export default { openResourcePanel, closeResourcePanel };
