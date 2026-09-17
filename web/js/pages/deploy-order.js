// Deployment order — the order everything has to come up in for a full service.
//
// Reads the engine at GET /api/w/:ws/deploy-order[?componentId=] (contract in
// INTEGRATION-NOTES.md, "deployment order"). The engine may not be installed:
// every fetch here degrades to a clear "not available yet" state instead of a
// broken page, and nothing on this page ever writes without a confirmation.
//
// Routes: #/:ws/deploy-order            (whole workspace)
//         #/:ws/deploy-order/:componentId  (one service's closure)

import {
  h, card, badge, empty, modal, toast, spinner, markdown, btn,
  pageHead, cardHead, sectionHead, nextStep, term, banner, fmtMinutes, aiRow,
} from '../ui.js';

const STYLE = `
  .dow-chain { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12.5px; }
  .dow-chain .dow-arrow { color: var(--muted); }
  .dow-cat { display: grid; grid-template-columns: 78px minmax(140px, 220px) 1fr; gap: 10px;
    padding: 7px 0; border-bottom: 1px solid rgba(42,50,66,.55); align-items: baseline; font-size: 12.5px; }
  .dow-cat:last-child { border-bottom: 0; }
  .dow-cat-name { font-weight: 650; }
  .dow-cat-why { color: var(--muted); line-height: 1.5; }
  .dow-wave { border: 1px solid var(--border); border-radius: 10px; background: var(--panel);
    margin-bottom: 10px; overflow: hidden; }
  .dow-wave > summary { cursor: pointer; padding: 11px 14px; display: flex; gap: 10px;
    align-items: center; flex-wrap: wrap; list-style: none; }
  .dow-wave > summary::-webkit-details-marker { display: none; }
  .dow-wave > summary:hover { background: rgba(79,143,247,.05); }
  .dow-wave-n { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11.5px;
    letter-spacing: .06em; text-transform: uppercase; }
  .dow-wave-name { font-weight: 650; }
  .dow-wave-body { padding: 4px 14px 14px; }
  .dow-catgrp { margin-top: 10px; }
  .dow-catgrp-head { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); margin: 0 0 4px; }
  .dow-item { display: block; width: 100%; text-align: left; background: var(--bg2);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px;
    cursor: pointer; color: inherit; font: inherit; }
  .dow-item:hover { border-color: var(--accent); }
  .dow-item-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .dow-item-name { font-weight: 600; font-size: 13px; }
  .dow-waits { margin: 5px 0 0; padding-left: 16px; color: var(--muted); font-size: 12px; line-height: 1.55; }
  .dow-waits li + li { margin-top: 2px; }
  .dow-none { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .dow-cycle { border: 1px solid rgba(226,86,79,.35); background: var(--err-soft);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .dow-scope { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .dow-scope select { width: auto; max-width: 320px; }
`;

const CAT_LABEL = {
  'compute': 'Compute', 'networking': 'Network', 'storage': 'Storage',
  'database': 'Data stores', 'messaging-streaming': 'Queues & streams',
  'security-secrets': 'Encryption & secrets', 'edge-dns': 'Edge & DNS',
  'identity-access': 'IAM & access', 'observability': 'Observability',
  'third-party': 'Third-party', 'cicd-control-plane': 'Registries & pipelines',
  'other': 'Other',
};
const catLabel = (c) => CAT_LABEL[c] || String(c || 'other').replace(/-/g, ' ');

const LAYER_LABEL = {
  L0: 'L0 guardrails', L1: 'L1 launch', L2: 'L2 platform', L3: 'L3 data + secrets',
  L4: 'L4 apps', L5: 'L5 edge', L6: 'L6 success bar', L7: 'L7 live cutover',
};

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
// Engine items carry notes as an array; some shapes use a plain string.
const noteText = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String).join(' · ') : str(v));
// The engine names a wave "Wave 3 · Data stores" — never print "Wave 3 · Wave 3 · …".
const bareWaveName = (name, index) => {
  const t = str(name).trim();
  return t.replace(/^wave\s*\d+\s*(?:[·:•\-–—]\s*)?/i, '').trim() || t || `Wave ${index}`;
};
// A `why` often opens with the waiting item's own name; the row already says who.
function whyText(why, subject) {
  let t = str(why).trim();
  const n = str(subject).trim();
  if (n && t.toLowerCase().startsWith(`${n.toLowerCase()} `)) t = t.slice(n.length + 1).trim();
  return t;
}
const CAT_ORDER = ['edge-dns', 'third-party', 'compute', 'networking', 'database', 'storage',
  'messaging-streaming', 'security-secrets', 'identity-access', 'cicd-control-plane', 'observability', 'other'];

/**
 * Every item in the order, flattened out of its wave + category buckets.
 * Exported (as flatOrderItems) because the runbooks page compares a runbook's
 * step order against exactly this list.
 */
function flatItems(order) {
  const out = [];
  arr(order?.waves).forEach((w, wi) => {
    const push = (it, cat) => {
      if (!it || it.id === undefined || it.id === null) return;
      const waveIndex = Number.isFinite(Number(w?.index)) ? Number(w.index) : wi + 1;
      out.push({
        ...it,
        id: str(it.id),
        name: str(it.name || it.id),
        category: str(it.category || cat || 'other'),
        componentId: str(it.componentId),
        notes: noteText(it.notes),
        waitsFor: arr(it.waitsFor).filter(Boolean),
        waveIndex,
        waveName: bareWaveName(w?.name, waveIndex),
      });
    };
    for (const b of arr(w?.categories)) for (const it of arr(b?.items)) push(it, b?.category);
    for (const it of arr(w?.items)) push(it, '');
  });
  return out;
}

export const flatOrderItems = flatItems;

const MISSING_RE = /feature unavailable|no such endpoint|not implemented|cannot find module|501/i;
const isMissing = (msg) => MISSING_RE.test(str(msg));

// ---------------------------------------------------------------- explain

/**
 * The full prerequisite chain for one item. Tries the engine's explain endpoint
 * and falls back to what the order itself already tells us, so the modal is
 * never empty and never throws.
 */
function chainFromOrder(items, id, depth = 0, seen = new Set()) {
  const it = items.find((x) => x.id === id);
  if (!it || seen.has(id) || depth > 6) return [];
  seen.add(id);
  const rows = [];
  for (const w of it.waitsFor) {
    const wid = str(w?.id);
    const target = items.find((x) => x.id === wid);
    rows.push({
      depth,
      name: str(w?.name || target?.name || wid),
      why: str(w?.why),
      wave: target ? target.waveIndex : null,
    });
    rows.push(...chainFromOrder(items, wid, depth + 1, seen));
  }
  return rows;
}

function renderExplain(payload, fallbackRows, item) {
  const box = h('div');
  const text = str(payload?.markdown || payload?.explanation || payload?.answer || payload?.summary);
  if (text) box.append(markdown(text));

  // Accept any of the array shapes the engine might use for the chain.
  const rows = arr(payload?.chain).length ? arr(payload.chain)
    : arr(payload?.prerequisites).length ? arr(payload.prerequisites)
      : arr(payload?.waitsFor).length ? arr(payload.waitsFor)
        : arr(payload?.steps);
  if (rows.length) {
    box.append(h('ul', { class: 'dow-waits', style: 'margin-top:10px' }, rows.map((r) => {
      if (typeof r === 'string') return h('li', null, r);
      const name = str(r?.name || r?.id);
      const why = str(r?.why || r?.reason);
      const wave = r?.wave ?? r?.waveIndex;
      return h('li', null,
        h('strong', null, name || '(unnamed)'),
        wave !== undefined && wave !== null ? h('span', { class: 'hint' }, ` · wave ${wave}`) : null,
        why ? ` — ${why}` : '');
    })));
  }
  if (!text && !rows.length) {
    box.append(
      h('p', { class: 'hint' }, `Straight from the computed order — this is what ${item.name} waits for, and what those wait for in turn:`),
      fallbackRows.length
        ? h('ul', { class: 'dow-waits' }, fallbackRows.map((r) => h('li', { style: `margin-left:${r.depth * 14}px` },
          h('strong', null, r.name),
          r.wave ? h('span', { class: 'hint' }, ` · wave ${r.wave}`) : null,
          r.why ? ` — ${r.why}` : '')))
        : h('p', { class: 'hint' }, 'Nothing has to exist before this one — it can go in the first wave it appears in.'));
  }
  // "…and these are waiting on it" — the other half of the honest answer.
  const unlocks = arr(payload?.unlocks);
  if (unlocks.length) {
    box.append(
      h('p', { class: 'hint', style: 'margin-top:12px' }, `${unlocks.length} thing${unlocks.length === 1 ? '' : 's'} cannot start until this one is up:`),
      h('ul', { class: 'dow-waits' }, unlocks.slice(0, 8).map((u) => h('li', null,
        h('strong', null, str(u?.name || u?.id)),
        Number.isFinite(Number(u?.wave)) ? h('span', { class: 'hint' }, ` · wave ${u.wave}`) : null,
        str(u?.why) ? ` — ${str(u.why)}` : ''))
        .concat(unlocks.length > 8 ? [h('li', { class: 'hint' }, `+${unlocks.length - 8} more`)] : [])));
  }
  if (payload && payload.note) box.append(h('p', { class: 'hint', style: 'margin-top:10px' }, str(payload.note)));
  return box;
}

async function explainItem({ ws, api, item, items }) {
  const body = h('div', null, spinner('Following the prerequisite chain…'));
  const p = modal(`${item.name} — why it sits in wave ${item.waveIndex}`, body, { wide: true, actions: [] });
  const fallback = chainFromOrder(items, item.id);
  let payload = null;
  try {
    payload = await api.get(`/w/${ws}/deploy-order/explain/${encodeURIComponent(item.id)}`);
  } catch (e) {
    payload = null;
    body.replaceChildren(
      h('p', { class: 'hint' }, isMissing(e.message)
        ? 'The engine cannot explain single items yet — here is the chain from the order itself.'
        : `Explain failed (${e.message}) — here is the chain from the order itself.`),
      renderExplain(null, fallback, item));
    return p;
  }
  body.replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      badge(`wave ${item.waveIndex}`, 'accent'),
      item.layer ? badge(LAYER_LABEL[item.layer] || item.layer, 'purple') : null,
      badge(catLabel(item.category)),
      item.kind ? h('span', { class: 'hint' }, item.kind) : null),
    renderExplain(payload, fallback, item));
  return p;
}

// ---------------------------------------------------------------- AI assist

async function askAiToResolve({ ws, api, payload, title }) {
  const body = h('div', null, spinner('Asking your local AI…'));
  modal(title, body, { wide: true, actions: [] });
  let res;
  try {
    res = await api.post(`/w/${ws}/deploy-order/ai-assist`, payload);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'hint' }, isMissing(e.message)
      ? 'AI assist is not wired up yet in this build.'
      : `AI assist failed: ${e.message}`));
    return;
  }
  const text = str(res?.markdown || res?.answer || res?.summary || res?.message);
  const list = arr(res?.suggestions).length ? arr(res.suggestions) : arr(res?.options);
  const kids = [];
  if (text) kids.push(markdown(text));
  if (list.length) {
    kids.push(h('ul', { class: 'dow-waits', style: 'margin-top:10px' }, list.map((s) => h('li', null,
      typeof s === 'string' ? s : [h('strong', null, str(s?.title || s?.break || s?.id || 'suggestion')),
        str(s?.why || s?.detail) ? ` — ${str(s.why || s.detail)}` : '']))));
  }
  if (!kids.length) kids.push(h('pre', { style: 'white-space:pre-wrap;font-size:12px' }, JSON.stringify(res, null, 2)));
  kids.push(h('p', { class: 'hint', style: 'margin-top:12px' },
    'Suggestions only — nothing has been changed. Edit the dependency in Inventory if you agree with it.'));
  body.replaceChildren(...kids);
}

// ---------------------------------------------------------------- sections

function categoryOrderCard(order) {
  const rows = arr(order?.categoryOrder).filter(Boolean);
  if (!rows.length) return null;
  const chain = h('div', { class: 'dow-chain' });
  rows.forEach((c, i) => {
    chain.append(badge(str(c.label) || catLabel(c.category), i === 0 ? 'accent' : ''));
    if (i < rows.length - 1) chain.append(h('span', { class: 'dow-arrow' }, '→'));
  });
  return card(
    cardHead('Category order', h('span', { class: 'hint' }, `${rows.length} categories`)),
    h('p', { class: 'hint', style: 'margin-bottom:10px' },
      'The shape of every deployment: identity and encryption before the things they protect, network before what sits in it, data before the apps that read it, traffic last.'),
    chain,
    h('div', { style: 'margin-top:12px' }, rows.map((c) => h('div', { class: 'dow-cat' },
      h('span', null, Number.isFinite(Number(c.firstWave)) ? badge(`wave ${Number(c.firstWave)}`, '') : badge('—')),
      h('span', { class: 'dow-cat-name' }, str(c.label) || catLabel(c.category)),
      h('span', { class: 'dow-cat-why' }, str(c.rationale) || 'No rationale recorded for this category.')))),
  );
}

function itemRow({ ws, api, item, items }) {
  const waits = item.waitsFor;
  const REQ = { ready: 'must be Ready, not just created', verified: 'must be verified first' };
  return h('button', {
    class: 'dow-item', type: 'button',
    title: 'What this waits for, all the way down',
    onClick: () => explainItem({ ws, api, item, items }),
  },
  h('div', { class: 'dow-item-head' },
    h('span', { class: 'dow-item-name' }, item.name),
    item.kind ? badge(item.kind) : null,
    item.tier === 0 || /tier 0/i.test(str(item.tierName)) ? badge(str(item.tierName) || 'tier 0', 'err') : null,
    item.layer ? badge(LAYER_LABEL[item.layer] || item.layer, 'purple') : null,
    item.action === 'verify' ? badge('verify only — cannot be deployed', 'warn') : null,
    item.action === 'coordinate' ? badge('needs coordination', 'warn') : null,
    item.readinessGate ? badge('others wait for it to be Ready', 'accent') : null,
    item.inCycle ? badge('in a cycle', 'err') : null,
    item.provenance ? h('span', { class: 'hint' }, str(item.provenance).replace(/-/g, ' ')) : null),
  waits.length
    ? h('ul', { class: 'dow-waits' }, waits.slice(0, 6).map((w) => {
      const why = whyText(w?.why, item.name);
      const req = REQ[str(w?.requires)];
      return h('li', null,
        'waits for ', h('strong', null, str(w?.name || w?.id)),
        why ? ` — ${why}` : ' — it has to exist first',
        req && !/ready|verified/i.test(why) ? h('span', { class: 'hint' }, ` (${req})`) : null);
    }).concat(waits.length > 6 ? [h('li', { class: 'hint' }, `+${waits.length - 6} more — click to see the whole chain`)] : []))
    : h('div', { class: 'dow-none' }, 'Nothing has to exist before this — it is a starting point.'),
  item.notes ? h('div', { class: 'dow-none' }, str(item.notes)) : null);
}

function waveCard({ ws, api, wave, index, items }) {
  const idx = Number.isFinite(Number(wave?.index)) ? Number(wave.index) : index + 1;
  const own = items.filter((it) => it.waveIndex === idx);
  const byCat = new Map();
  for (const it of own) {
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it);
  }
  const cats = [...byCat.keys()].sort((a, b) => {
    const ra = CAT_ORDER.indexOf(a), rb = CAT_ORDER.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.localeCompare(b);
  });
  const n = own.length;
  const body = h('div', { class: 'dow-wave-body' },
    cats.map((cat) => [cat, byCat.get(cat)]).map(([cat, list]) => h('div', { class: 'dow-catgrp' },
      h('p', { class: 'dow-catgrp-head' }, `${catLabel(cat)} · ${list.length}`),
      list.map((it) => itemRow({ ws, api, item: it, items })))),
    n ? null : h('p', { class: 'hint' }, 'This wave came back empty — nothing to deploy in it.'));
  return h('details', { class: 'dow-wave', open: index < 3 ? '' : null },
    h('summary', null,
      h('span', { class: 'dow-wave-n' }, `Wave ${idx}`),
      h('span', { class: 'dow-wave-name' }, bareWaveName(wave?.name, idx)),
      wave?.layer ? badge(str(wave.layerLabel) || LAYER_LABEL[wave.layer] || wave.layer, 'purple') : null,
      badge(`${n} resource${n === 1 ? '' : 's'}`),
      wave?.parallelizable !== false && n > 1 ? badge('can run in parallel', 'ok') : (n > 1 ? badge('run in order', 'warn') : null),
      wave?.needsReview ? badge('needs review — a cycle was broken here', 'warn') : null,
      Number(wave?.estMinutes) > 0 ? h('span', { class: 'hint' }, `~${fmtMinutes(wave.estMinutes)}`) : null),
    body);
}

/** Name for an item id, for the cycle/edge rows. */
function nameFor(items, id, cycleNodes = []) {
  const hit = items.find((x) => x.id === str(id));
  if (hit) return hit.name;
  const n = cycleNodes.find((x) => x && typeof x === 'object' && str(x.id) === str(id));
  return n ? str(n.name || n.id) : str(id);
}

/**
 * The startup calls ordering could not make safe — a pod that would come up
 * before something it calls on boot. This is the owner's CrashLoop case, stated
 * plainly instead of buried.
 */
function callIssuesSection({ ws, api, order, items }) {
  const issues = arr(order?.callOrderIssues).filter(Boolean);
  if (!issues.length) return null;
  const SEV = { blocker: 'err', high: 'warn', medium: '' };
  const KIND_LABEL = {
    'startup-order': 'starts too early',
    'external-precondition': 'outside your control',
    'unresolved-target': 'target not in the inventory',
    'unclassified-critical': 'critical call, unclear timing',
  };
  const box = card(cardHead(`Startup calls this order cannot make safe (${issues.length})`,
    h('span', { class: 'hint' }, 'pods calling things that are not up yet')));
  box.append(h('p', { class: 'hint', style: 'margin-bottom:10px' },
    'These are outbound calls a workload makes as it boots. Ordering alone cannot fix them — either the dependency moves, or the call has to tolerate a retry, or someone outside has to make it ready before the cutover.'));
  box.append(h('div', null, issues.map((i) => h('div', { style: 'padding:8px 0; border-bottom:1px solid rgba(42,50,66,.55)' },
    h('div', { class: 'row' },
      badge(str(i.severity) || 'high', SEV[str(i.severity)] ?? 'warn'),
      badge(KIND_LABEL[str(i.kind)] || str(i.kind) || 'call issue'),
      h('strong', null, str(i.componentName) || str(i.componentId) || 'a workload'),
      h('span', { class: 'hint' }, '→'),
      h('span', null, str(i.target) || 'its target'),
      Number.isFinite(Number(i.callerWave)) && Number.isFinite(Number(i.calleeWave))
        ? h('span', { class: 'hint' }, `wave ${i.callerWave} calls wave ${i.calleeWave}`) : null),
    str(i.why) ? h('div', { style: 'margin-top:4px; font-size:12.5px; line-height:1.55' }, str(i.why)) : null,
    str(i.suggestion) ? h('div', { class: 'hint', style: 'margin-top:3px' }, `What to do: ${str(i.suggestion)}`) : null))));
  box.append(h('div', { class: 'row', style: 'margin-top:10px' }, btn({
    label: 'Ask AI how to sequence these', size: 'btn-sm',
    onClick: () => askAiToResolve({
      ws, api, title: 'Startup calls that will not work in this order',
      payload: { kind: 'call-order', callOrderIssues: issues, question: 'For each of these startup calls, what is the safest fix: move the dependency earlier, make the caller retry, or verify it out of band? Be specific about which.' },
    }),
  })));
  void items;
  return box;
}

function honestySection({ ws, api, order, items }) {
  const cycles = arr(order?.cycles).filter(Boolean);
  const unordered = arr(order?.unordered).filter(Boolean);
  if (!cycles.length && !unordered.length) {
    return card(
      cardHead('Cycles and unplaced items'),
      h('p', { class: 'hint' }, 'None — every resource landed in a wave and nothing depends on itself in a loop. That is what a trustworthy order looks like.'));
  }
  const box = card(cardHead('Cycles and unplaced items',
    h('span', { class: 'hint' }, 'the honest part of this page')));
  box.append(h('p', { class: 'hint', style: 'margin-bottom:12px' },
    'These could not be ordered automatically. A cycle means two things each claim to need the other first — a human has to decide which edge is not really a startup requirement.'));

  for (const c of cycles) {
    const names = arr(c.nodes).map((n) => (n && typeof n === 'object' ? str(n.name || n.id) : str(n))).filter(Boolean);
    const sb = c.suggestedBreak;
    let brk = '';
    let brkWhy = '';
    if (sb && typeof sb === 'object') {
      if (sb.from !== undefined || sb.to !== undefined) {
        brk = `${nameFor(items, sb.from, c.nodes)} → ${nameFor(items, sb.to, c.nodes)}`;
        brkWhy = str(sb.why);
      } else {
        brk = str(sb.name || sb.id);
      }
    } else if (sb) {
      brk = str(sb);
    }
    box.append(h('div', { class: 'dow-cycle' },
      h('div', { class: 'row' }, badge('cycle', 'err'),
        h('strong', null, names.length ? names.join(' → ') + ' → ' + names[0] : 'unnamed cycle')),
      str(c.why) ? h('p', { class: 'hint', style: 'margin-top:6px' }, str(c.why)) : null,
      brk ? h('p', { style: 'margin-top:6px; font-size:12.5px' },
        'Suggested break: ', h('strong', null, brk),
        brkWhy ? h('span', { class: 'hint' }, ` — ${brkWhy}`) : null) : null,
      h('div', { class: 'row', style: 'margin-top:8px' },
        btn({
          label: 'Ask AI to resolve', size: 'btn-sm',
          title: 'Ask your local AI which edge is not really a startup requirement (suggestions only)',
          onClick: () => askAiToResolve({
            ws, api, title: 'How to break this cycle',
            payload: { kind: 'cycle', cycle: c, nodes: arr(c.nodes), question: 'Which edge in this cycle is not a real startup requirement, and what should be deployed after the fact instead?' },
          }),
        }))));
  }

  if (unordered.length) {
    box.append(h('h3', { style: 'margin:14px 0 6px; font-size:13.5px' }, `Could not be placed in a wave (${unordered.length})`));
    box.append(h('div', null, unordered.map((u) => {
      const name = typeof u === 'object' ? str(u.name || u.id) : str(u);
      const why = typeof u === 'object' ? str(u.why || u.reason || u.notes) : '';
      return h('div', { class: 'row', style: 'padding:6px 0; border-bottom:1px solid rgba(42,50,66,.55)' },
        badge('unordered', 'warn'), h('span', null, name),
        why ? h('span', { class: 'hint' }, why) : h('span', { class: 'hint' }, 'no prerequisite information — record what it needs in Inventory'));
    })));
    box.append(h('div', { class: 'row', style: 'margin-top:10px' }, btn({
      label: 'Ask AI where these belong', size: 'btn-sm',
      onClick: () => askAiToResolve({
        ws, api, title: 'Where the unplaced items belong',
        payload: { kind: 'unordered', unordered, question: 'For each of these, which wave should it go in and what does it most likely depend on? Say what you are unsure about.' },
      }),
    })));
  }
  void items;
  return box;
}

// ---------------------------------------------------------------- page

async function createRunbookFromOrder({ ws, api, componentId, navigate }) {
  let draft;
  try {
    draft = await api.post(`/w/${ws}/deploy-order/to-runbook`, componentId ? { componentId } : {});
  } catch (e) {
    toast(isMissing(e.message)
      ? 'Runbook drafting from the order is not available in this build yet.'
      : `Could not draft a runbook: ${e.message}`, 'err');
    return;
  }
  try {
    const mod = await import('./runbooks.js');
    const review = mod.reviewRunbookDraft || mod.default?.reviewRunbookDraft;
    if (typeof review === 'function') {
      await review({ ws, api, draft, navigate, source: componentId ? `deployment order — ${componentId}` : 'deployment order' });
      return;
    }
  } catch { /* fall through to the raw preview below */ }
  await modal('Runbook draft', h('div', { style: 'max-height:60vh;overflow:auto' },
    h('p', { class: 'hint' }, 'The runbooks page could not open its review flow, so here is the raw draft. Nothing has been created.'),
    h('pre', { style: 'white-space:pre-wrap;font-size:12px' }, JSON.stringify(draft, null, 2))), { wide: true, actions: [] });
}

function notAvailable(el, { ws, message, componentId }) {
  const missing = isMissing(message);
  el.append(empty({
    icon: '🧱',
    title: missing ? 'Deployment order is not available in this build yet' : 'No deployment order yet',
    body: missing
      ? 'The engine that computes the order (server/lib/deploy-order.js) is not installed here. Everything else in DR Compass works — this page lights up the moment it lands.'
      : `${message || 'It is computed from your inventory and resource graph.'} Record what each thing depends on in Inventory, or run a read-only scan in Discover, and the order falls out of it.`,
    action: componentId
      ? { label: 'Whole workspace order', href: `#/${ws}/deploy-order` }
      : { label: 'Open Inventory', href: `#/${ws}/inventory` },
    actions: componentId ? [] : [{ label: 'Discover what you have', href: `#/${ws}/discover` }],
  }));
  el.append(nextStep({
    title: 'What this page will show',
    body: 'Waves: what can be deployed at the same time, and what has to wait — a VPC before an EKS cluster, subnets and IAM before that, secrets and data before the pods that mount and call them.',
    action: { label: 'See the restore layer cake instead', href: `#/${ws}/diagrams/restore-layers` },
    alt: { label: 'Runbooks', href: `#/${ws}/runbooks` },
  }));
}

export default {
  title: 'Deployment order',
  async render(el, ctx) {
    const { ws, api, params, navigate } = ctx;
    const componentId = str(params && params[0]);
    el.append(h('style', null, STYLE));

    // Components are only used for the scope picker and names — soft-fail.
    let components = [];
    try { components = (await api.get(`/w/${ws}/c/components`)).items || []; } catch { components = []; }
    const focus = components.find((c) => c.id === componentId) || null;

    const diagramId = componentId ? `deploy-order-${componentId}` : 'deploy-order';
    const head = pageHead({
      title: componentId ? `Deployment order — ${focus ? focus.name : componentId}` : 'Deployment order',
      purpose: 'The order everything has to come up in for a full service: anything in the same wave can be deployed at the same time, and anything in a later wave is waiting on something real in an earlier one.',
      actions: [
        { label: 'View as diagram', href: `#/${ws}/diagrams/${diagramId}` },
        { label: 'Workbook export', kind: 'btn-ghost', href: `#/${ws}/exports` },
      ],
    });
    el.append(head);

    // A scope that names something this workspace does not have is a dead end —
    // say so instead of rendering a service page with no service.
    if (componentId && !focus && components.length) {
      el.append(empty({
        icon: '🔍',
        title: 'No service with that id in this workspace',
        body: `Nothing in the inventory has the id "${componentId}". It may have been renamed or deleted since that link was made.`,
        action: { label: 'Whole workspace order', href: `#/${ws}/deploy-order` },
        actions: [{ label: 'Open Inventory', href: `#/${ws}/inventory` }],
      }));
      return;
    }

    let order;
    try {
      const q = componentId ? `?componentId=${encodeURIComponent(componentId)}` : '';
      order = await api.get(`/w/${ws}/deploy-order${q}`);
    } catch (e) {
      notAvailable(el, { ws, message: e.message, componentId });
      return;
    }
    if (!order || !arr(order.waves).length) {
      notAvailable(el, { ws, message: str(order?.message) || 'No deployment order yet — it is computed from your inventory and resource graph.', componentId });
      return;
    }

    const items = flatItems(order);
    const waves = arr(order.waves);
    const inOrder = new Set(items.map((it) => it.id));

    // ---- scope switch ----
    const sel = h('select', {
      title: 'Whole workspace, or one service and everything it needs',
      onChange: () => navigate(sel.value ? `#/${ws}/deploy-order/${sel.value}` : `#/${ws}/deploy-order`),
    },
    h('option', { value: '' }, 'Whole workspace'),
    components
      .filter((c) => !componentId || inOrder.has(c.id) || c.id === componentId)
      .map((c) => h('option', { value: c.id, selected: c.id === componentId }, c.name)));
    el.append(card(
      h('div', { class: 'dow-scope' },
        h('span', { class: 'hint' }, 'Scope'), sel,
        componentId ? badge('one service and everything it needs', 'accent') : badge('everything in this workspace'),
        h('span', { class: 'spacer' }),
        btn({
          label: 'Create a runbook from this order', kind: 'btn-primary', size: 'btn-sm',
          title: 'Draft a layered runbook from these waves — you review every step before anything is created',
          onClick: () => createRunbookFromOrder({ ws, api, componentId, navigate }),
        })),
      h('p', { class: 'hint', style: 'margin-top:8px' },
        componentId
          ? 'Scoped to this service\'s closure: itself, everything it waits for, and anything waiting on it.'
          : 'Every resource in the workspace, in the order it has to be brought up.'),
    ));

    // The engine may not support scoping — if the answer came back without the
    // service in it, say that rather than passing the whole estate off as one
    // service's closure.
    if (componentId && !inOrder.has(componentId)) {
      el.append(banner({
        kind: 'warn',
        title: 'This is the whole workspace order, not just this service',
        body: `The order that came back does not contain ${focus ? focus.name : componentId}, so nothing could be narrowed down to it. Everything below is the full order.`,
        action: { label: 'Whole workspace view', href: `#/${ws}/deploy-order` },
      }));
    }

    // ---- honest header stats ----
    const stats = order.stats && typeof order.stats === 'object' ? order.stats : {};
    const cycles = arr(order.cycles).filter(Boolean);
    const unordered = arr(order.unordered).filter(Boolean);
    const issues = arr(order.callOrderIssues).filter(Boolean);
    const parts = [
      cycles.length ? `${cycles.length} dependency cycle${cycles.length === 1 ? '' : 's'}` : '',
      unordered.length ? `${unordered.length} unplaced item${unordered.length === 1 ? '' : 's'}` : '',
      issues.length ? `${issues.length} unsafe startup call${issues.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    if (parts.length) {
      el.append(banner({
        kind: issues.some((i) => str(i.severity) === 'blocker') ? 'err' : 'warn',
        title: parts.join(' · '),
        body: 'The order below is still useful, but it is not complete until these are resolved. Each one is listed in full further down this page.',
      }));
    }
    // What the engine itself wants the operator to know (e.g. no Kubernetes
    // snapshot, so pod-level prerequisites could not be modelled at all).
    for (const note of arr(order.notes).slice(0, 3)) {
      if (!str(note)) continue;
      el.append(banner({ kind: 'info', title: 'About this order', body: str(note) }));
    }
    const inputs = order.inputs && typeof order.inputs === 'object' ? order.inputs : {};
    el.append(h('div', { class: 'row', style: 'margin:0 0 14px' },
      badge(`${waves.length} wave${waves.length === 1 ? '' : 's'}`, 'accent'),
      badge(`${items.length} resource${items.length === 1 ? '' : 's'}`),
      Number.isFinite(Number(stats.longestChain)) ? badge(`longest chain ${stats.longestChain}`) : null,
      str(inputs.k8s) === 'absent' ? badge('no Kubernetes snapshot', 'warn') : null,
      Number(stats.estMinutes) > 0 ? badge(`~${fmtMinutes(stats.estMinutes)} end to end`) : null,
      h('span', { class: 'hint' }, 'Items in the same wave can go in parallel. '),
      term('restore layer'),
      order.generatedAt ? h('span', { class: 'hint' }, ` · computed ${String(order.generatedAt).slice(0, 19).replace('T', ' ')}`) : null));

    el.append(aiRow({
      ws, api, intro: 'Ask AI:',
      context: { kind: 'workspace', extra: { componentId: componentId || null, waves: waves.length } },
      actions: [
        {
          label: 'Explain this order',
          prompt: 'Explain this workspace\'s computed deployment order in plain English for an operator who has never seen it: '
            + 'what goes first and why, which waves can run in parallel, and where the risk of going out of order is highest. '
            + 'Use the real component names. At most 10 short lines.',
        },
        {
          label: 'What could break during this sequence?',
          prompt: 'Walk this deployment order wave by wave and name the places it realistically breaks: a pod that starts before '
            + 'the secret it mounts exists, a service that opens a database connection on boot before the database is reachable, '
            + 'a partner allowlist that has to be requested days earlier. For each: what breaks, the symptom an operator would '
            + 'see, and what to check before moving on. Cite real components. At most 8 items, worst first.',
        },
        {
          label: 'What\'s missing from this order?',
          prompt: 'Look at this deployment order against the inventory and the resource graph. What is missing or wrong: resources '
            + 'nothing depends on that clearly should be depended on, prerequisites that are not recorded anywhere (IAM, KMS, '
            + 'certificates, image registries, VPC endpoints), and anything in a wave that is too early or too late. '
            + 'Answer as a short list: the gap — why it matters here — what to record to fix it. No generic DR advice.',
        },
      ],
    }));

    const catCard = categoryOrderCard(order);
    if (catCard) el.append(catCard);

    el.append(sectionHead('The waves',
      'Top to bottom is the order. Inside a wave, items are grouped by category — everything in one wave can be deployed at the same time. Click any item to see what it waits for, all the way down.'));
    const wavesBox = h('div');
    waves.forEach((w, i) => wavesBox.append(waveCard({ ws, api, wave: w, index: i, items })));
    el.append(wavesBox);

    const callIssues = callIssuesSection({ ws, api, order, items });
    if (callIssues) el.append(callIssues);
    el.append(honestySection({ ws, api, order, items }));

    el.append(nextStep({
      title: 'Turn the order into something someone can follow at 3am',
      body: 'A runbook generated from these waves starts with the order already right — gates on every wave boundary, so nobody moves on before the last wave is actually up.',
      action: {
        label: 'Create a runbook from this order',
        onClick: () => createRunbookFromOrder({ ws, api, componentId, navigate }),
      },
      alt: { label: 'See it as a diagram', href: `#/${ws}/diagrams/${diagramId}` },
    }));
  },
};
