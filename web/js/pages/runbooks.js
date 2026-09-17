// Runbooks: list, template-based creation, step editor, preview, recommender panel.
//
// THE CUTOVER GATE (v0.7). A runbook's L6 step is no longer a generic "verify
// the success bar" placeholder: it CONTAINS the service's declared pre-cutover
// checks — the real ones, with owners and pass criteria — and the L7 traffic
// step declares that it waits for them. A runbook whose L7 step has no populated
// gate above it is reported as blocked, in the editor, in the markdown export
// and in the recommender's gap list. The rules are shared with the Tests page
// and the server in web/js/cutover.js.
import { h, card, badge, empty, field, modal, toast, confirmDialog, markdown } from '../ui.js';
import { aiActionRow, aiButton } from '../ai-actions.js';
import {
  GATE_KINDS, auditCutoverGate, applyGateRequirements, inferGateKind, isTrafficStep,
  isVerificationStep, stepTestsFromChecklist, buildPreCutoverChecklist, gateSummary, onFailOf,
} from '../cutover.js';

const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
const LAYER_LABELS = {
  L0: 'L0 guardrails', L1: 'L1 launch', L2: 'L2 platform', L3: 'L3 data+secrets',
  L4: 'L4 apps', L5: 'L5 edge', L6: 'L6 success bar', L7: 'L7 live cutover',
};
const LAYER_KIND = { L0: '', L1: 'accent', L2: 'accent', L3: 'warn', L4: 'ok', L5: 'purple', L6: 'ok', L7: 'err' };
const TOOLING = ['arpio', 'region-switch', 'arc-routing-controls', 'elastic-dr', 'gitops-iac', 'resilience-hub', 'backup', 'other'];

const genId = (p) => `${p}_${Math.random().toString(16).slice(2, 10)}`;
const esc = (v) => (v === null || v === undefined) ? '' : String(v);

function blankStep(layer = 'L4') {
  // `gateKind`, `tests` and `requires` are additive: a step written before they
  // existed simply has none, and everything below reads them defensively.
  return {
    id: genId('stp'), layer, title: '', detail: '', command: '', verify: '', pass: '', owner: '',
    estMinutes: 10, gate: false, record: '', componentIds: [],
    gateKind: '', tests: [], requires: [],
  };
}

const GATE_LABEL = {
  '': '— not a gate —',
  [GATE_KINDS.verification]: 'L6 pre-cutover verification (holds the checks)',
  [GATE_KINDS.approval]: 'Manual approval before the cutover',
  [GATE_KINDS.traffic]: 'L7 traffic cutover (waits for the gate)',
  [GATE_KINDS.postCutover]: 'Post-cutover verification (the soak)',
};

function totalMinutes(steps) {
  return (steps || []).reduce((s, x) => s + (Number(x.estMinutes) || 0), 0);
}

function runbookToMarkdown(rb, componentsById) {
  const lines = [`# ${rb.name}`, ''];
  lines.push(`**Tooling:** ${rb.tooling || '—'} · **Scenario:** ${rb.scenario || '—'} · **Audience:** ${rb.audience || '—'}`, '');
  if ((rb.preconditions || []).length) {
    lines.push('## Preconditions', '');
    for (const p of rb.preconditions) lines.push(`- ${p}`);
    lines.push('');
  }
  // The gate is computed once, so the markdown says the same thing the editor
  // does: which step holds the checks, and which step is blocked without them.
  const audit = auditCutoverGate(rb);
  const blocked = new Set(audit.blockedIndexes);
  const gateStepNumbers = audit.verificationSteps.filter((v) => v.tests.length).map((v) => v.index + 1);

  const section = (title, steps, isForward) => {
    if (!(steps || []).length) return;
    lines.push(`## ${title} (~${totalMinutes(steps)} min)`, '');
    steps.forEach((s, i) => {
      const gateTag = isForward && isVerificationStep(s) ? ' — PRE-CUTOVER GATE' : (s.gate ? ' — GATE' : '');
      lines.push(`### ${i + 1}. [${s.layer}] ${s.title}${gateTag}`, '');
      if (isForward && blocked.has(i)) {
        lines.push(`> ⛔ **BLOCKED.** This step moves live traffic and there is no populated pre-cutover verification above it. `
          + `Do not run it: populate the L6 gate with the service's pre-cutover checks first.`, '');
      } else if (isForward && isTrafficStep(s) && gateStepNumbers.length) {
        lines.push(`> ⛔ **Do not run until step ${gateStepNumbers.join(' and ')} has passed** — every blocking pre-cutover check, `
          + 'with evidence, and the approval recorded.', '');
      }
      if (s.detail) lines.push(s.detail, '');
      if (s.command) lines.push('```', s.command, '```', '');
      // The gate's contents: the artifact the person on the bridge call works
      // through, inside the step that holds it.
      const tests = Array.isArray(s.tests) ? s.tests : [];
      if (tests.length) {
        lines.push(`**Checks that must pass here** (${gateSummary(tests)}):`, '');
        lines.push('| # | Check | Owner | Pass criterion | If it fails |', '|---|---|---|---|---|');
        tests.forEach((t, n) => lines.push(`| ${n + 1} | ${t.name || '—'} | ${t.owner || '_unowned_'} | `
          + `${t.expected || '_none recorded_'} | ${onFailOf(t) === 'block' ? '**BLOCKS THE CUTOVER**' : 'advisory'} |`));
        lines.push('');
      } else if (isForward && isVerificationStep(s)) {
        lines.push('> ⚠ This gate is EMPTY — it names no checks, so nothing here can fail. Populate it from the service\'s pre-cutover checklist.', '');
      }
      if (s.verify) lines.push(`- **Verify:** ${s.verify}`);
      if (s.pass) lines.push(`- **Pass:** ${s.pass}`);
      if (s.owner) lines.push(`- **Owner:** ${s.owner} · ~${s.estMinutes || 0} min`);
      if (s.record) lines.push(`- **Record:** ${s.record}`);
      if ((s.requires || []).length) lines.push(`- **Waits for:** ${s.requires.join(', ')}`);
      const names = (s.componentIds || []).map((id) => componentsById[id]?.name || id);
      if (names.length) lines.push(`- **Components:** ${names.join(', ')}`);
      lines.push('');
    });
  };
  section('Steps', rb.steps, true);
  section('Rollback', rb.rollback, false);
  if (rb.notes) lines.push('## Notes', '', rb.notes, '');
  return lines.join('\n');
}

/* ===========================================================================
 * DEPLOYMENT ORDER INTEGRATION
 * Two actions, both additive and both defensive — the deploy-order engine may
 * not be installed, in which case these buttons never appear at all:
 *   list   → "Generate from deployment order": POST /deploy-order/to-runbook,
 *            review the returned draft (steps grouped by wave, gates on every
 *            wave boundary), create only on confirm.
 *   editor → "Check against deployment order": compare this runbook's step
 *            order with the computed order and report the mismatches.
 * Nothing here writes without an explicit confirmation.
 * =========================================================================*/

const ORDER_MISSING_RE = /feature unavailable|no such endpoint|not implemented|cannot find module|501/i;
const orderMissing = (msg) => ORDER_MISSING_RE.test(String(msg || ''));
const oarr = (v) => (Array.isArray(v) ? v : []);
const ostr = (v) => (v === null || v === undefined ? '' : String(v));

/** Is the engine there, and does it have an order for this workspace? */
async function deployOrderAvailable(ws, api) {
  try {
    const order = await api.get(`/w/${ws}/deploy-order`);
    return order && oarr(order.waves).length ? order : null;
  } catch { return null; }
}

// Flatten the order's items. Uses the deploy-order page's own exported helper
// when it is present so the two pages can never disagree about the shape.
async function orderItems(order) {
  try {
    const mod = await import('./deploy-order.js');
    if (typeof mod.flatOrderItems === 'function') return mod.flatOrderItems(order);
  } catch { /* fall through to the local reader */ }
  const out = [];
  oarr(order?.waves).forEach((w, wi) => {
    const push = (it, cat) => {
      if (!it || it.id === undefined || it.id === null) return;
      out.push({
        ...it, id: ostr(it.id), name: ostr(it.name || it.id),
        category: ostr(it.category || cat || 'other'),
        waitsFor: oarr(it.waitsFor).filter(Boolean),
        waveIndex: Number.isFinite(Number(w?.index)) ? Number(w.index) : wi + 1,
        waveName: ostr(w?.name || `Wave ${wi + 1}`),
      });
    };
    for (const b of oarr(w?.categories)) for (const it of oarr(b?.items)) push(it, b?.category);
    for (const it of oarr(w?.items)) push(it, '');
  });
  return out;
}

const unwrapDraft = (d) => (d && typeof d === 'object' ? (d.runbook || d.draft || d) : {});

/** The wave a drafted step belongs to, whatever the engine chose to call it. */
function stepWave(s) {
  for (const k of ['wave', 'waveIndex', 'waveNumber']) {
    if (Number.isFinite(Number(s?.[k]))) return Number(s[k]);
  }
  // The engine's own draft names a step "Wave 0 — Third party".
  const m = ostr(s?.waveName || s?.group || s?.section || s?.title).match(/wave\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function groupStepsByWave(steps) {
  const groups = [];
  let cur = null;
  steps.forEach((s, i) => {
    const w = stepWave(s);
    const key = w === null ? `layer:${ostr(s.layer)}` : `wave:${w}`;
    const label = w === null
      ? `${LAYER_LABELS[s.layer] || ostr(s.layer) || 'unlayered'}`
      : `Wave ${w}${ostr(s.waveName) ? ' · ' + ostr(s.waveName) : ''}`;
    if (!cur || cur.key !== key) { cur = { key, label, steps: [] }; groups.push(cur); }
    cur.steps.push({ s, i });
  });
  return groups;
}

/**
 * Review a drafted runbook and create it only on confirm. Exported so the
 * Deployment order page can hand its draft straight to the runbooks flow.
 * Returns the created runbook, or null when the reviewer backs out.
 */
export async function reviewRunbookDraft({ ws, api, draft, navigate, source = 'deployment order' }) {
  const rb = unwrapDraft(draft);
  const steps = oarr(rb.steps).map((s) => ({ ...s }));
  const rollback = oarr(rb.rollback).map((s) => ({ ...s }));
  if (!steps.length) {
    await modal('Nothing to review', h('div', null,
      h('p', null, 'The draft came back with no steps — there is nothing to create.'),
      h('p', { class: 'hint' }, 'That usually means the deployment order is empty: record what each component depends on in Inventory first.')),
      { actions: [] });
    return null;
  }
  const groups = groupStepsByWave(steps);
  // A gate on every wave boundary: the last step of each wave must not be
  // passed blind. We mark them here and say so in the review.
  const gated = [];
  for (const g of groups) {
    const last = g.steps[g.steps.length - 1];
    if (last && !last.s.gate) { last.s.gate = true; gated.push(last.i + 1); }
  }
  const total = totalMinutes(steps);

  const body = h('div', { style: 'max-height:62vh; overflow-y:auto' },
    h('p', { class: 'hint' },
      `Drafted from the ${source}. Nothing is created until you confirm — read the order, not just the words.`),
    h('div', { class: 'row', style: 'margin:10px 0' },
      badge(`${steps.length} steps`, 'accent'), badge(`${groups.length} waves`),
      badge(`~${totalMinutes(steps)} min`), rollback.length ? badge(`${rollback.length} rollback`) : badge('no rollback', 'warn')),
    h('p', { class: 'hint' }, gated.length
      ? `Gate added at each wave boundary (step${gated.length === 1 ? '' : 's'} ${gated.join(', ')}) — nobody moves to the next wave until the last one is verifiably up.`
      : 'Every wave boundary is already gated — nobody moves to the next wave until the last one is verifiably up.'),
    groups.map((g) => h('div', { style: 'margin-top:12px' },
      h('div', { class: 'row' }, h('strong', null, g.label),
        badge(`${g.steps.length} step${g.steps.length === 1 ? '' : 's'}`)),
      h('div', null, g.steps.map(({ s, i }) => h('div', {
        style: 'padding:6px 0 6px 10px; border-left:2px solid var(--border); margin-top:6px',
      },
      h('div', { class: 'row' },
        h('span', { class: 'hint', style: 'font-variant-numeric:tabular-nums' }, String(i + 1)),
        badge(s.layer || '—', LAYER_KIND[s.layer] || ''),
        h('span', { style: 'font-weight:600' }, ostr(s.title) || '(untitled step)'),
        s.gate ? badge('gate', 'warn') : null,
        Number(s.estMinutes) > 0 ? h('span', { class: 'hint' }, `~${s.estMinutes} min`) : null),
      ostr(s.detail) ? h('div', { class: 'hint', style: 'margin-top:3px' }, ostr(s.detail)) : null,
      ostr(s.verify) ? h('div', { class: 'hint', style: 'margin-top:3px' }, `Verify: ${ostr(s.verify)}${ostr(s.pass) ? ` · Pass: ${ostr(s.pass)}` : ''}`) : null))))),
    (() => {
      // Say plainly whether this draft can reach a traffic cutover without a
      // populated verification gate — before it is created, not after.
      const audit = auditCutoverGate({ steps });
      if (!audit.trafficSteps.length && !audit.verificationSteps.length) return null;
      const errs = audit.findings.filter((f) => f.severity === 'err');
      return h('div', { style: 'margin-top:14px' },
        h('div', { class: 'row' }, errs.length
          ? badge('L7 reachable without verification', 'err')
          : badge('cutover gated', 'ok')),
        errs.length
          ? h('div', { class: 'hint', style: 'margin-top:4px' }, errs.map((f) => h('div', null, f.text)))
          : null);
    })(),
    h('p', { class: 'hint', style: 'margin-top:14px' },
      'After it is created you can edit every step — and "Check against deployment order" will tell you if an edit breaks the order.'));

  const ok = await modal(`Review drafted runbook — ${ostr(rb.name) || 'from deployment order'}`, body, {
    wide: true,
    actions: [{ label: `Create runbook (${steps.length} steps, ~${total} min)`, kind: 'btn-primary', value: true }],
  });
  if (!ok) return null;

  const withIds = (list) => list.map((s) => ({
    ...blankStep(s.layer || 'L4'),
    ...s,
    id: s.id || genId('stp'),
    componentIds: [...oarr(s.componentIds)],
  }));
  const bodyOut = {
    name: ostr(rb.name) || 'Recovery in deployment order',
    tooling: ostr(rb.tooling), scenario: ostr(rb.scenario) || 'region-loss',
    audience: ostr(rb.audience) || 'operator',
    preconditions: oarr(rb.preconditions).map(ostr),
    steps: withIds(steps),
    rollback: withIds(rollback),
    linkedTestIds: [],
    notes: [ostr(rb.notes), `Generated from the computed ${source}. Re-check it with "Check against deployment order" after any edit.`].filter(Boolean).join('\n\n'),
    updatedAt: new Date().toISOString(),
  };
  try {
    const created = await api.post(`/w/${ws}/c/runbooks`, bodyOut);
    toast('Runbook created from the deployment order', 'ok');
    try { window.dispatchEvent(new CustomEvent('drcompass:data-changed')); } catch { /* shell may be absent in tests */ }
    if (typeof navigate === 'function') navigate(`#/${ws}/runbooks/${created.id}`);
    return created;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

/** The list-page action. Returns a button that hides itself when unavailable. */
function generateFromOrderBtn({ ws, api, navigate, components }) {
  const b = h('button', {
    class: 'btn', hidden: true,
    title: 'Draft a runbook whose steps are already in the computed deployment order',
    onClick: async () => {
      let componentId = '';
      if (components.length) {
        const sel = h('select', null,
          h('option', { value: '' }, 'Whole workspace — everything, in order'),
          components.map((c) => h('option', { value: c.id }, `${c.name} — this service and everything it needs`)));
        const go = await modal('Generate from deployment order', h('div', null,
          h('p', { class: 'hint', style: 'margin-bottom:12px' },
            'The draft follows the computed waves: nothing comes up before the things it mounts, reads or calls. You review every step before it is created.'),
          field('Scope', sel)), { actions: [{ label: 'Draft it', kind: 'btn-primary', value: true }] });
        if (!go) return;
        componentId = sel.value;
      }
      const label = b.textContent;
      b.disabled = true;
      b.textContent = 'Drafting…';
      try {
        const draft = await api.post(`/w/${ws}/deploy-order/to-runbook`, componentId ? { componentId } : {});
        await reviewRunbookDraft({
          ws, api, draft, navigate,
          source: componentId ? `deployment order for ${components.find((c) => c.id === componentId)?.name || componentId}` : 'deployment order',
        });
      } catch (e) {
        toast(orderMissing(e.message)
          ? 'Drafting from the deployment order is not available in this build yet.'
          : `Could not draft a runbook: ${e.message}`, 'err');
      } finally {
        b.disabled = false;
        b.textContent = label;
      }
    },
  }, '⇄ Generate from deployment order');
  deployOrderAvailable(ws, api).then((order) => { if (order) b.hidden = false; });
  return b;
}

// ---- "Check against deployment order" -----------------------------------

const rxEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pure comparison: a runbook's step order against the computed order.
 * Returns { findings:[{kind,severity,text}], mapped, unmappable, uncovered }.
 */
export function compareRunbookToOrder(rb, items) {
  const waveOf = new Map(items.map((it) => [it.id, it.waveIndex]));
  const byId = new Map(items.map((it) => [it.id, it]));
  // An order item can be a component, or a k8s object / AWS resource attributed
  // to one. A step linked to a component covers all of them.
  const byComponent = new Map();
  for (const it of items) {
    const cid = ostr(it.componentId) || (byId.has(it.id) && /^cmp_/.test(it.id) ? it.id : '');
    if (!cid) continue;
    if (!byComponent.has(cid)) byComponent.set(cid, []);
    byComponent.get(cid).push(it.id);
  }
  const steps = oarr(rb.steps);
  const stepIds = steps.map((s) => {
    const ids = [];
    for (const cid of oarr(s.componentIds).map(ostr)) {
      if (byId.has(cid)) ids.push(cid);
      for (const id of byComponent.get(cid) || []) if (!ids.includes(id)) ids.push(id);
    }
    // When a step says which wave it is ("Wave 2 — Networking"), only that
    // wave's items count for it: a step links the components that OWN the
    // resources in its wave, and most of those components also own resources in
    // later waves. Without this, one step looks like it does everything.
    const declared = stepWave(s);
    if (ids.length && declared !== null) {
      const inWave = ids.filter((id) => waveOf.get(id) === declared);
      if (inWave.length) return inWave;
    }
    if (ids.length) return ids;
    // No links on the step — fall back to naming the resource in the text.
    const text = `${ostr(s.title)} ${ostr(s.detail)} ${ostr(s.command)}`;
    const hit = [];
    for (const it of items) {
      if (it.name.length < 4) continue;
      if (new RegExp(`\\b${rxEscape(it.name)}\\b`, 'i').test(text)) hit.push(it.id);
    }
    return hit;
  });
  const firstStepOf = new Map();
  stepIds.forEach((ids, i) => ids.forEach((id) => { if (!firstStepOf.has(id)) firstStepOf.set(id, i); }));

  // Runbook steps work at SERVICE granularity, so the comparison does too: an
  // item's "owner" is its component (or itself, for a component-level item).
  // Ordering *inside* one component (which route table before which subnet) is
  // below the granularity of a runbook step and would only produce noise.
  const ownerOf = (id) => {
    const it = byId.get(ostr(id));
    if (!it) return '';
    return ostr(it.componentId) || (/^cmp_/.test(it.id) ? it.id : '');
  };
  const firstStepOfOwner = new Map();
  stepIds.forEach((ids, i) => {
    for (const id of ids) {
      const o = ownerOf(id);
      if (o && !firstStepOfOwner.has(o)) firstStepOfOwner.set(o, i);
    }
  });

  const findings = [];
  const seenText = new Set();
  const addFinding = (f) => {
    if (seenText.has(f.text)) return;
    seenText.add(f.text);
    findings.push(f);
  };
  // 1. A step does something whose prerequisite only happens later.
  stepIds.forEach((ids, i) => {
    for (const id of ids) {
      const subj = byId.get(id);
      const subjOwner = ownerOf(id);
      if (!subj || !subjOwner) continue;
      for (const w of oarr(subj.waitsFor)) {
        const wid = ostr(w?.id);
        const prereqOwner = ownerOf(wid);
        if (!prereqOwner || prereqOwner === subjOwner) continue;
        const j = firstStepOfOwner.get(prereqOwner);
        if (j === undefined || j <= i) continue;
        const why = ostr(w?.why).replace(new RegExp(`^${rxEscape(subj.name)}\\s+`, 'i'), '');
        addFinding({
          kind: 'prereq-after', severity: 'err',
          text: `Step ${i + 1} (\u201C${ostr(steps[i].title) || 'untitled'}\u201D) brings up ${subj.name} before ${ostr(w?.name || wid)}, `
            + `which only appears at step ${j + 1} — ${why || 'it has to exist first'}. The order says wave `
            + `${waveOf.get(wid) ?? '?'} comes before wave ${waveOf.get(id) ?? '?'}.`,
        });
      }
    }
  });
  // 2. Consecutive steps that run the waves backwards.
  const waveRange = stepIds.map((ids) => {
    const ws_ = ids.map((id) => waveOf.get(id)).filter((v) => Number.isFinite(v));
    return ws_.length ? { min: Math.min(...ws_), max: Math.max(...ws_) } : null;
  });
  for (let i = 0; i < waveRange.length - 1; i++) {
    const a = waveRange[i], b = waveRange[i + 1];
    if (!a || !b || a.min <= b.max) continue;
    addFinding({
      kind: 'wave-inversion', severity: 'warn',
      text: `Step ${i + 1} (“${ostr(steps[i].title) || 'untitled'}”) is wave-${a.min} work, but step ${i + 2} `
        + `(“${ostr(steps[i + 1].title) || 'untitled'}”) is wave-${b.max} work — the computed order puts step ${i + 2} first.`,
    });
  }
  // 3. Things in the order no step touches.
  const uncovered = items.filter((it) => !firstStepOf.has(it.id));
  // 4. Steps we could not map to anything in the order.
  const unmappable = steps.map((s, i) => ({ s, i })).filter(({ i }) => !stepIds[i].length);
  return { findings, mapped: steps.length - unmappable.length, unmappable, uncovered, stepIds };
}

function checkAgainstOrderBtn({ ws, api, rb }) {
  const b = h('button', {
    class: 'btn', hidden: true,
    title: 'Compare this runbook\'s step order with the computed deployment order',
    onClick: async () => {
      const label = b.textContent;
      b.disabled = true;
      b.textContent = 'Checking…';
      let order = null;
      try { order = await api.get(`/w/${ws}/deploy-order`); }
      catch (e) {
        toast(orderMissing(e.message) ? 'No deployment order engine in this build yet.' : `Could not read the order: ${e.message}`, 'err');
        b.disabled = false; b.textContent = label; return;
      }
      b.disabled = false;
      b.textContent = label;
      const items = await orderItems(order);
      if (!items.length) { toast('The computed order is empty — nothing to compare against.', 'err'); return; }
      const res = compareRunbookToOrder(rb, items);
      const sev = (s) => (s === 'err' ? 'err' : s === 'warn' ? 'warn' : '');
      const body = h('div', { style: 'max-height:62vh; overflow-y:auto' },
        h('div', { class: 'row' },
          res.findings.length
            ? badge(`${res.findings.length} mismatch${res.findings.length === 1 ? '' : 'es'}`, res.findings.some((f) => f.severity === 'err') ? 'err' : 'warn')
            : badge('order agrees', 'ok'),
          badge(`${res.mapped}/${oarr(rb.steps).length} steps matched to the order`),
          res.uncovered.length ? badge(`${res.uncovered.length} in the order, not in this runbook`, 'warn') : null),
        h('p', { class: 'hint', style: 'margin-top:8px' },
          'A step is matched to the order through its linked components (or by naming a resource in its title). Nothing here is changed for you — this is a review list.'),
        res.findings.length
          ? h('div', { style: 'margin-top:12px' }, res.findings.map((f) => h('div', {
            style: 'padding:8px 0; border-bottom:1px solid rgba(42,50,66,.55)',
          }, h('div', { class: 'row' }, badge(f.severity === 'err' ? 'out of order' : 'check this', sev(f.severity))),
          h('div', { style: 'margin-top:4px; font-size:13px; line-height:1.55' }, f.text))))
          : h('p', { style: 'margin-top:12px' }, 'Every step that could be matched is in an order the computed sequence agrees with.'),
        res.unmappable.length
          ? h('details', { style: 'margin-top:14px' },
            h('summary', { class: 'hint' }, `${res.unmappable.length} step${res.unmappable.length === 1 ? '' : 's'} could not be checked (no linked components)`),
            h('ul', { class: 'hint', style: 'margin:6px 0 0 18px' },
              res.unmappable.slice(0, 20).map(({ s, i }) => h('li', null, `Step ${i + 1}: ${ostr(s.title) || 'untitled'} — link its components in the step editor to include it`))))
          : null,
        res.uncovered.length
          ? h('details', { style: 'margin-top:10px' },
            h('summary', { class: 'hint' }, `${res.uncovered.length} thing${res.uncovered.length === 1 ? '' : 's'} in the deployment order that no step touches`),
            h('ul', { class: 'hint', style: 'margin:6px 0 0 18px' },
              res.uncovered.slice(0, 25).map((it) => h('li', null, `wave ${it.waveIndex} · ${it.name}${it.kind ? ` (${it.kind})` : ''}`))))
          : null,
        h('p', { class: 'hint', style: 'margin-top:14px' },
          h('a', { href: `#/${ws}/deploy-order` }, 'Open the deployment order'), ' to see the waves and why each item waits.'));
      await modal(`Check against deployment order — ${ostr(rb.name) || 'runbook'}`, body, { wide: true, actions: [] });
    },
  }, 'Check against deployment order');
  deployOrderAvailable(ws, api).then((order) => { if (order) b.hidden = false; });
  return b;
}

/* ===========================================================================
 * THE CUTOVER GATE
 *
 * One rule, enforced in one place: an L7 step that moves live traffic must be
 * preceded by a pre-cutover verification step that CONTAINS real checks, and by
 * an approval. `auditCutoverGate` (web/js/cutover.js) decides; this file only
 * shows what it decided and offers the one action that fixes it.
 * =========================================================================*/

/** Fetch the pre-cutover checklist, falling back to computing it in-browser. */
async function fetchChecklist(ws, api, { componentId = '', serviceId = '', envId = '', when = 'pre-cutover' } = {}) {
  const qs = new URLSearchParams({ when });
  if (componentId) qs.set('componentId', componentId);
  if (serviceId) qs.set('serviceId', serviceId);
  if (envId) qs.set('envId', envId);
  try {
    return await api.get(`/w/${ws}/pre-cutover?${qs}`);
  } catch {
    const [tests, components, meta] = await Promise.all([
      api.get(`/w/${ws}/c/tests`).then((r) => r.items || []).catch(() => []),
      api.get(`/w/${ws}/c/components`).then((r) => r.items || []).catch(() => []),
      api.get(`/w/${ws}/workspace`).catch(() => ({})),
    ]);
    let services = [];
    try { services = (await api.get(`/w/${ws}/c/services`)).items || []; } catch { services = []; }
    return buildPreCutoverChecklist({ workspace: meta, components, tests, services }, { componentId, serviceId, envId, when });
  }
}

/**
 * Put the real checks inside a gate step. Reviews before writing; returns true
 * when the step was changed.
 */
async function populateGateStep({ ws, api, rb, step, components }) {
  const when = step.gateKind === GATE_KINDS.postCutover ? 'post-cutover' : 'pre-cutover';
  const linked = (step.componentIds || [])[0] || '';
  const scopeSel = h('select', null,
    h('option', { value: '' }, 'Whole workspace — every declared check'),
    components.map((c) => h('option', { value: c.id, selected: c.id === linked }, `${c.name} — this service and what it depends on`)));
  const preview = h('div', { class: 'hint' }, 'Choose a scope to see what would go in.');
  let checklist = null;

  const load = async () => {
    preview.textContent = 'Reading the checklist…';
    checklist = await fetchChecklist(ws, api, { componentId: scopeSel.value, when });
    preview.innerHTML = '';
    if (!checklist.items.length) {
      preview.append(h('p', { style: 'color:var(--warn)' },
        `No ${when} checks are declared for this scope. Capture them on the Tests page `,
        h('a', { href: `#/${ws}/tests/pre-cutover` }, '(pre-cutover checklist)'),
        ' — a gate with nothing in it is the thing this is meant to stop.'));
      return;
    }
    preview.append(
      h('div', { class: 'row' },
        badge(`${checklist.counts.blocking} blocking`, 'err'),
        badge(`${checklist.counts.advisory} advisory`),
        badge(`${checklist.counts.owners} owner(s)`, 'accent'),
        checklist.totalEstMinutes ? badge(`~${checklist.totalEstMinutes} min`) : null),
      h('ul', { style: 'margin:8px 0 0 18px' }, checklist.items.slice(0, 12).map((i) => h('li', null,
        h('span', { style: 'font-weight:600' }, i.name),
        i.owner ? ` — ${i.owner}` : '',
        i.blocking ? ' ' : ' (advisory)',
        i.expected ? '' : h('span', { style: 'color:var(--warn)' }, ' — no pass criterion')))),
      checklist.items.length > 12 ? h('p', { class: 'hint' }, `+${checklist.items.length - 12} more`) : null);
  };
  scopeSel.addEventListener('change', load);
  const body = h('div', null,
    h('p', { class: 'hint' },
      `The step will hold the actual ${when} checks — names, owners and pass criteria — instead of telling the operator to "verify". `
      + 'Its verify/pass lines are rewritten to name them. Nothing else in the runbook changes.'),
    field('Scope', scopeSel), preview);
  load();
  const ok = await modal(`Populate the gate — ${step.title || 'verification step'}`, body,
    { wide: true, actions: [{ label: 'Put these checks in the step', kind: 'btn-primary', value: true }] });
  if (!ok || !checklist) return false;
  if (!checklist.items.length) { toast('Nothing to put in the gate', 'err'); return false; }

  step.tests = stepTestsFromChecklist(checklist);
  step.gateKind = step.gateKind || GATE_KINDS.verification;
  const blocking = step.tests.filter((t) => onFailOf(t) === 'block');
  step.verify = `Execute all ${step.tests.length} declared ${when} check(s) against the recovery region and record the evidence for each`;
  step.pass = `Every one of the ${blocking.length} blocking check(s) passed against its recorded criterion`
    + `${checklist.items.some((i) => !i.expected) ? ' — NOTE: some have no criterion written down yet' : ''}`;
  step.gate = true;
  if (!step.record) step.record = 'Per check: who ran it, the evidence, pass/fail, and the time';
  applyGateRequirements(rb);
  return true;
}

/** The editor's standing verdict on whether L7 is reachable without the gate. */
function gateBanner(rb, ws, { onFix } = {}) {
  const audit = auditCutoverGate(rb);
  if (!audit.findings.length) {
    return audit.verificationSteps.length
      ? card(h('div', { class: 'row' }, badge('cutover gated', 'ok'),
        h('span', { class: 'hint' },
          `Step ${audit.verificationSteps[0].index + 1} holds ${audit.gateTests.length} pre-cutover check(s); `
          + `the L7 step${audit.trafficSteps.length === 1 ? '' : 's'} above cannot be run until they pass.`)))
      : null;
  }
  const worst = audit.findings.some((f) => f.severity === 'err') ? 'err' : 'warn';
  return card(
    h('div', { class: 'row' },
      badge(worst === 'err' ? 'L7 is reachable without verification' : 'the gate needs work', worst),
      h('span', { class: 'spacer' }),
      onFix ? h('button', { class: 'btn btn-sm btn-primary', onClick: onFix }, 'Populate the gate') : null),
    h('div', { style: 'margin-top:8px' }, audit.findings.map((f) => h('div', {
      style: 'padding:6px 0;border-bottom:1px solid var(--border)',
    },
    h('div', { class: 'row' }, badge(f.severity === 'err' ? 'blocked' : f.severity === 'warn' ? 'check this' : 'note',
      f.severity === 'err' ? 'err' : f.severity === 'warn' ? 'warn' : '')),
    h('div', { style: 'margin-top:3px;font-size:13px;line-height:1.55' }, f.text)))),
    h('p', { class: 'hint', style: 'margin-top:10px' },
      'L6 before L7 is the ordering this product will not draft around. ',
      h('a', { href: `#/${ws}/tests/pre-cutover` }, 'See the pre-cutover checklist'),
      ' for what should be in the gate.'));
}

// ------------------------------------------------------------------ list

async function renderList(el, { ws, api, navigate }) {
  let runbooks = [], tests = [];
  try { [runbooks, tests] = await Promise.all([
    api.get(`/w/${ws}/c/runbooks`).then((r) => r.items || []),
    api.get(`/w/${ws}/c/tests`).then((r) => r.items || []),
  ]); } catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }

  const newRunbook = async () => {
    let templates = [];
    try { templates = (await api.get(`/w/${ws}/templates/runbooks`)).templates || []; } catch { /* templates optional */ }
    let chosen = null;
    const options = h('div', null,
      [{ templateId: null, templateName: 'Blank runbook', whenToUse: 'Start from nothing and write your own steps.' }, ...templates].map((t) =>
        h('label', { class: 'card', style: 'display:block;cursor:pointer;margin-bottom:10px;padding:12px 14px' },
          h('div', { class: 'row' },
            h('input', { type: 'radio', name: 'tpl', style: 'width:auto', onChange: () => { chosen = t; } }),
            h('strong', null, t.templateName || t.name || 'Template'),
            t.tooling ? badge(t.tooling, 'accent') : null,
            t.steps ? h('span', { class: 'hint' }, `${t.steps.length} steps`) : null),
          h('p', { class: 'hint', style: 'margin:6px 0 0 24px' }, t.whenToUse || t.description || ''))));
    const ok = await modal('New runbook — choose a starting point', options,
      { wide: true, actions: [{ label: 'Create', kind: 'btn-primary', value: true }] });
    if (!ok) return;
    const t = chosen || { templateId: null };
    const body = t.templateId ? {
      name: t.name || t.templateName, tooling: t.tooling || '', scenario: t.scenario || '',
      audience: t.audience || 'operator', preconditions: [...(t.preconditions || [])],
      steps: (t.steps || []).map((s) => ({ ...s, id: genId('stp'), componentIds: [...(s.componentIds || [])] })),
      rollback: (t.rollback || []).map((s) => ({ ...s, id: genId('stp'), componentIds: [...(s.componentIds || [])] })),
      linkedTestIds: [], notes: t.notes || '',
    } : { name: 'New runbook', tooling: '', scenario: '', audience: 'operator', preconditions: [], steps: [blankStep()], rollback: [], linkedTestIds: [], notes: '' };
    body.updatedAt = new Date().toISOString();
    try {
      const created = await api.post(`/w/${ws}/c/runbooks`, body);
      toast('Runbook created', 'ok');
      navigate(`#/${ws}/runbooks/${created.id}`);
    } catch (e) { toast(e.message, 'err'); }
  };

  // Components are only needed for the deployment-order scope picker — soft-fail.
  let listComponents = [];
  try { listComponents = (await api.get(`/w/${ws}/c/components`)).items || []; } catch { listComponents = []; }

  el.append(h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Runbooks'),
      h('div', { class: 'sub' }, 'Step-by-step failover and recovery-test procedures, layered L0→L7')),
    h('div', { class: 'row' },
      generateFromOrderBtn({ ws, api, navigate, components: listComponents }),
      h('button', { class: 'btn btn-primary', onClick: newRunbook }, '＋ New runbook'))));

  el.append(aiActionRow({
    ws, api, label: 'AI', style: 'margin:-2px 0 16px',
    hint: 'A drafted runbook is a starting point with real layering and gates — you review every step before it is created.',
    actions: [
      {
        label: 'Draft a runbook',
        title: 'Generate a full layered runbook for a scenario or component, from this workspace\'s inventory',
        modalTitle: 'Drafted runbook',
        mode: 'operations',
        context: { kind: 'workspace' },
        input: {
          title: 'Draft a runbook',
          label: 'Scenario or component',
          placeholder: 'e.g. loss of us-east-1, or: restore the adjudication service and its Aurora cluster',
          hint: 'Name the failure or the component. The draft uses this workspace\'s real components, tooling and regions.',
        },
        prompt: 'Draft ONE complete runbook as a single create operation on "runbooks" for: {{input}}\n'
          + 'Requirements: steps ordered by restore layer L0→L7 (guardrails → launch/replication → platform → data+secrets → '
          + 'applications → edge → functional success bar → cutover); every step has title, detail, verify and pass; '
          + 'gate:true on the steps that must not be passed blind (anything before data integrity or traffic cutover); '
          + 'componentIds referencing REAL component ids from the context; honest estMinutes per step; preconditions; '
          + 'and a rollback array that actually reverses the steps. Match the workspace tooling and regions. '
          + 'Use angle-bracket placeholders for anything not in the context and list them in notes.',
      },
      {
        label: 'What runbook am I missing?',
        title: 'Which scenarios have no runbook covering them',
        modalTitle: 'Runbook coverage',
        context: { kind: 'workspace' },
        prompt: 'Look at the runbooks in this workspace against its inventory, strategy and tooling. Which failure scenarios '
          + 'have no runbook, and which existing runbook is closest to covering each one? Answer as a short list: scenario — '
          + 'why it matters here (cite real components) — the runbook that should cover it (by name/id) or "none". '
          + 'At most 6 items, worst gap first. No generic DR advice.',
      },
    ],
  }));

  if (!runbooks.length) {
    el.append(empty('No runbooks yet — create one from a template.'));
  } else {
    el.append(h('div', { class: 'grid cols-2' }, runbooks.map((rb) => {
      const linked = tests.filter((t) => t.runbookId === rb.id || (rb.linkedTestIds || []).includes(t.id)).length;
      return h('div', { class: 'card', style: 'cursor:pointer', onClick: () => navigate(`#/${ws}/runbooks/${rb.id}`) },
        h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, rb.name || '(unnamed)'), h('span', { class: 'spacer' }),
          rb.tooling ? badge(rb.tooling, 'accent') : null),
        h('p', { class: 'hint', style: 'margin:8px 0' },
          `Scenario: ${rb.scenario || '—'} · ${(rb.steps || []).length} steps (~${totalMinutes(rb.steps)} min) · ${(rb.rollback || []).length} rollback`),
        h('div', { class: 'row' },
          badge(`${linked} linked test${linked === 1 ? '' : 's'}`),
          h('span', { class: 'hint' }, rb.updatedAt ? `updated ${String(rb.updatedAt).slice(0, 10)}` : '')));
    })));
  }

  el.append(renderRecommendPanel(ws, { api, navigate }));
}

// ------------------------------------------------------- recommend panel

function renderRecommendPanel(ws, { api, navigate }) {
  const out = h('div');
  const VERDICT_KIND = { 'in-use': 'accent', recommended: 'ok', consider: 'warn', 'not-needed': '', ok: 'ok', stretch: 'warn', mismatch: 'err' };

  const run = async () => {
    out.innerHTML = '';
    out.append(h('p', { class: 'hint' }, 'Analyzing inventory…'));
    let rec;
    try { rec = await api.post(`/w/${ws}/recommend`, {}); }
    catch (e) { out.innerHTML = ''; out.append(h('p', { class: 'hint' }, `Recommender unavailable: ${e.message}`)); return; }
    out.innerHTML = '';

    const fit = rec.strategy?.fit || [];
    out.append(h('h3', { style: 'margin:12px 0 6px' }, `Strategy fit (current: ${rec.strategy?.current || '—'})`),
      ...fit.map((f) => h('div', { class: 'row', style: 'margin:4px 0' },
        badge(f.strategyId, f.strategyId === rec.strategy?.current ? 'accent' : ''),
        badge(f.verdict, VERDICT_KIND[f.verdict] || ''), h('span', { class: 'hint' }, f.why))));

    out.append(h('h3', { style: 'margin:14px 0 6px' }, 'Tooling verdicts'),
      ...(rec.tooling || []).map((t) => h('div', { class: 'row', style: 'margin:4px 0' },
        badge(t.name || t.id, VERDICT_KIND[t.verdict] || ''), badge(t.verdict, VERDICT_KIND[t.verdict] || ''),
        h('span', { class: 'hint' }, t.why))));

    const rs = rec.regionSwitch;
    out.append(h('h3', { style: 'margin:14px 0 6px' }, 'Region switch plan skeleton'));
    if (!rs?.applicable || !rs.plan) {
      out.append(h('p', { class: 'hint' }, rs?.why || 'Not applicable.'));
    } else {
      out.append(h('p', { class: 'hint' }, `${rs.plan.name} · mode ${rs.plan.mode} · ${rs.plan.regions.join(' → ')}. ${rs.why}`));
      const g = rs.plan.gate || {};
      out.append(h('div', { class: 'row', style: 'margin:6px 0' },
        g.populated
          ? badge(`gate populated: ${g.testCount} check(s), ${g.blockingCount} blocking`, 'ok')
          : badge('gate is a placeholder — no pre-cutover checks declared', 'err'),
        g.verificationOrder ? badge(`verify at #${g.verificationOrder}`, 'accent') : null,
        g.approvalOrder ? badge(`approve at #${g.approvalOrder}`, 'warn') : null,
        g.trafficOrders?.length ? badge(`traffic at #${g.trafficOrders.join(', #')}`, 'err') : null,
        g.populated ? null : h('a', { class: 'hint', href: `#/${ws}/tests/pre-cutover` }, 'capture them →')));
      out.append(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['#', 'Layer', 'Block', 'Components', 'Notes'].map((x) => h('th', null, x)))),
        h('tbody', null, (rs.plan.steps || []).map((s) => h('tr', null,
          h('td', null, String(s.order)), h('td', null, badge(s.layer, LAYER_KIND[s.layer] || '')),
          h('td', null, s.blockType,
            s.gateKind === GATE_KINDS.verification ? h('div', null, badge(`${(s.tests || []).length} checks`, (s.tests || []).length ? 'ok' : 'err')) : null,
            (s.requires || []).length ? h('div', { class: 'hint' }, `waits for: ${s.requires.join(', ')}`) : null),
          h('td', null, (s.components || []).join(', ')),
          h('td', { class: 'hint' }, s.notes || ''))))));
      out.append(h('div', { style: 'margin-top:10px' }, h('button', {
        class: 'btn', onClick: async () => {
          const body = {
            name: rs.plan.name, tooling: 'region-switch', scenario: 'region-loss', audience: 'operator',
            preconditions: [
              'Region switch plan built and healthy in BOTH regions',
              // ARC Region switch has no practice mode (that is zonal autoshift).
              // A rehearsal is a real graceful execution in a planned window.
              'Plan rehearsed this quarter with a graceful execution in a planned window',
              'Plan contains Manual approval blocks before the data promotion and before the traffic block — an execution cannot be paused mid-flight without them',
              rs.plan.gate?.populated
                ? `The L6 gate names the ${rs.plan.gate.testCount} declared pre-cutover check(s) (${rs.plan.gate.blockingCount} blocking); every blocking one passes before the approval is sought`
                : 'NO pre-cutover checks are declared yet — the L6 gate in this runbook is a placeholder until they are captured (Tests → pre-cutover checklist)',
            ],
            steps: (rs.plan.steps || []).map((s) => ({
              ...blankStep(s.layer), title: s.name, detail: s.notes || '',
              // NEVER overwrite the generator's own verify/pass. Some steps are
              // not execution blocks at all (l6-verification, manual-approval),
              // and clobbering them destroys the L6 pass criterion — the gate
              // that stops a traffic cutover before the business transaction
              // has been proven.
              verify: s.verify || `Execution block '${s.blockType}' reports complete`,
              pass: s.pass || 'Block green in the execution report',
              gate: s.gate ?? true,
              estMinutes: s.estMinutes ?? null,
              // The gate travels with the plan: which step holds the checks,
              // which checks they are, and what the traffic step waits for.
              gateKind: s.gateKind || '',
              tests: Array.isArray(s.tests) ? s.tests : [],
              requires: Array.isArray(s.requires) ? s.requires : [],
            })),
            rollback: [{ ...blankStep('L0'), title: 'Reverse plan execution (failback)', detail: 'Run the plan in the reverse direction in a planned window with its own approval.', gate: true }],
            linkedTestIds: [], notes: 'Generated from the recommender’s Region switch plan skeleton — flesh out commands and per-block owners.',
            updatedAt: new Date().toISOString(),
          };
          try {
            const created = await api.post(`/w/${ws}/c/runbooks`, body);
            toast('Runbook created from plan', 'ok');
            navigate(`#/${ws}/runbooks/${created.id}`);
          } catch (e) { toast(e.message, 'err'); }
        },
      }, 'Create runbook from this plan')));
    }

    const gd = rec.gapsDetected || [];
    out.append(h('h3', { style: 'margin:14px 0 6px' }, `Auto-detected gaps (${gd.length})`),
      gd.length ? h('div', null, gd.map((g) => h('div', { class: 'row', style: 'margin:4px 0' },
        badge(g.severity, g.severity === 'blocker' ? 'err' : g.severity === 'high' ? 'warn' : ''),
        h('span', null, g.title), h('span', { class: 'hint' }, g.why))))
        : h('p', { class: 'hint' }, 'Nothing detected — either the inventory is clean or it is empty.'));
  };

  return card(
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Recommend'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-primary', onClick: run }, 'Analyze workspace')),
    h('p', { class: 'hint', style: 'margin-top:6px' },
      'Scores strategy fit against your RTO/RPO, gives tooling verdicts from the actual inventory, sketches a Region switch plan from restore layers, and flags gaps.'),
    out);
}

// ---------------------------------------------------------------- editor

async function renderEditor(el, { ws, api, navigate }, id) {
  let items = [], components = [];
  try { [items, components] = await Promise.all([
    api.get(`/w/${ws}/c/runbooks`).then((r) => r.items || []),
    api.get(`/w/${ws}/c/components`).then((r) => r.items || []),
  ]); } catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }
  const rb = items.find((x) => x.id === id);
  if (!rb) { el.append(empty('Runbook not found.'), h('p', { style: 'text-align:center' }, h('a', { href: `#/${ws}/runbooks` }, '← All runbooks'))); return; }
  rb.steps = rb.steps || []; rb.rollback = rb.rollback || []; rb.preconditions = rb.preconditions || [];
  const componentsById = Object.fromEntries(components.map((c) => [c.id, c]));

  const save = async () => {
    rb.updatedAt = new Date().toISOString();
    try { await api.put(`/w/${ws}/c/runbooks/${rb.id}`, rb); toast('Runbook saved', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  // --- metadata inputs
  const nameInp = h('input', { value: esc(rb.name), onInput: (e) => { rb.name = e.target.value; } });
  const toolSel = h('select', { onChange: (e) => { rb.tooling = e.target.value; } },
    h('option', { value: '' }, '— tooling —'),
    TOOLING.map((t) => h('option', { value: t, selected: rb.tooling === t }, t)));
  const scenInp = h('input', { value: esc(rb.scenario), placeholder: 'e.g. region-loss', onInput: (e) => { rb.scenario = e.target.value; } });
  const audInp = h('input', { value: esc(rb.audience), placeholder: 'e.g. operator', onInput: (e) => { rb.audience = e.target.value; } });
  const notesTa = h('textarea', { onInput: (e) => { rb.notes = e.target.value; } }, esc(rb.notes));

  const precondBox = h('div');
  const drawPreconds = () => {
    precondBox.innerHTML = '';
    rb.preconditions.forEach((p, i) => precondBox.append(h('div', { class: 'row', style: 'margin:4px 0' },
      h('input', { value: p, onInput: (e) => { rb.preconditions[i] = e.target.value; } }),
      h('button', { class: 'btn btn-sm', onClick: () => { rb.preconditions.splice(i, 1); drawPreconds(); } }, '✕'))));
    precondBox.append(h('button', { class: 'btn btn-sm', style: 'margin-top:4px', onClick: () => { rb.preconditions.push(''); drawPreconds(); } }, '＋ precondition'));
  };
  drawPreconds();

  // The gate banner re-reads the runbook every time anything changes, so it is
  // never stale after an edit.
  const gateBox = h('div');
  let redrawSteps = () => {};
  const drawGate = () => {
    gateBox.innerHTML = '';
    const b = gateBanner(rb, ws, {
      onFix: async () => {
        const audit = auditCutoverGate(rb);
        let step = audit.verificationSteps[0]?.step;
        if (!step) {
          // No gate at all: insert one immediately before the first traffic step.
          const at = audit.trafficSteps.length ? audit.trafficSteps[0].index : rb.steps.length;
          step = {
            ...blankStep('L6'),
            title: 'GATE: pre-cutover verification — before any traffic moves',
            detail: 'Run the declared pre-cutover checks against the recovery region using the DIRECT endpoint plus a Host header. '
              + 'No public DNS is touched here, so everything up to this point is still reversible.',
            gate: true, gateKind: GATE_KINDS.verification, estMinutes: 20, tests: [],
          };
          rb.steps.splice(at, 0, step);
          // An approval belongs between the gate and the traffic step.
          if (!audit.approvalSteps.length && audit.trafficSteps.length) {
            rb.steps.splice(at + 1, 0, {
              ...blankStep('L7'),
              title: 'APPROVAL GATE: authorize the live-traffic cutover',
              detail: 'The named decision-maker is shown the results of the gate above and approves in writing, with the reason and the time.',
              verify: 'Approval recorded with approver name, timestamp, reason and the checks they were shown',
              pass: 'Approved by the named decision-maker — or declined, which leaves traffic where it is',
              gate: true, gateKind: GATE_KINDS.approval, requires: [GATE_KINDS.verification], estMinutes: 5,
            });
          }
        }
        const changed = await populateGateStep({ ws, api, rb, step, components });
        redrawSteps();
        drawGate();
        if (changed) toast('Gate populated — save the runbook to keep it', 'ok');
      },
    });
    if (b) gateBox.append(b);
  };

  // --- step editor (shared by steps + rollback)
  function stepCard(list, s, i, redraw) {
    const compChips = h('div', { class: 'row', style: 'margin-top:6px' });
    const drawChips = () => {
      compChips.innerHTML = '';
      (s.componentIds || []).forEach((cid, ci) => compChips.append(
        h('span', { class: 'badge' }, componentsById[cid]?.name || cid, ' ',
          h('a', { style: 'cursor:pointer', onClick: () => { s.componentIds.splice(ci, 1); drawChips(); } }, '✕'))));
      const sel = h('select', { style: 'width:auto;max-width:220px' },
        h('option', { value: '' }, '＋ link component'),
        components.filter((c) => !(s.componentIds || []).includes(c.id))
          .map((c) => h('option', { value: c.id }, c.name)));
      sel.addEventListener('change', () => { if (sel.value) { (s.componentIds = s.componentIds || []).push(sel.value); drawChips(); } });
      compChips.append(sel);
    };
    drawChips();

    // --- the cutover-gate controls (forward steps only; a rollback step is
    // never the gate that holds back a cutover).
    const isForward = list === rb.steps;
    const audit = isForward ? auditCutoverGate(rb) : null;
    const blocked = !!audit && audit.blockedIndexes.includes(i);
    const suggestion = isForward && !s.gateKind ? inferGateKind(s) : '';
    const gateSel = h('select', {
      style: 'width:auto',
      title: 'What role this step plays in the traffic cutover',
      onChange: (e) => { s.gateKind = e.target.value; applyGateRequirements(rb); redraw(); drawGate(); },
    }, ['', GATE_KINDS.verification, GATE_KINDS.approval, GATE_KINDS.traffic, GATE_KINDS.postCutover]
      .map((k) => h('option', { value: k, selected: (s.gateKind || '') === k }, GATE_LABEL[k])));

    const gateTests = Array.isArray(s.tests) ? s.tests : [];
    const populateBtn = h('button', {
      class: gateTests.length ? 'btn btn-sm' : 'btn btn-sm btn-primary',
      title: 'Put the service\'s declared pre-cutover checks inside this step',
      onClick: async () => {
        if (await populateGateStep({ ws, api, rb, step: s, components })) { redraw(); drawGate(); toast('Gate populated — save to keep it', 'ok'); }
      },
    }, gateTests.length ? 'Re-populate from the checklist' : 'Populate from the pre-cutover checklist');

    const gateBlock = !isForward ? null : h('div', { style: 'margin-top:8px' },
      h('div', { class: 'row' },
        h('span', { class: 'hint' }, 'Cutover role'), gateSel,
        (isVerificationStep(s) || s.gateKind === GATE_KINDS.postCutover) ? populateBtn : null,
        suggestion ? h('button', {
          class: 'btn btn-sm',
          title: 'This step looks like it already plays that role — tag it so the gate check can see it',
          onClick: () => { s.gateKind = suggestion; applyGateRequirements(rb); redraw(); drawGate(); },
        }, `Mark as ${GATE_LABEL[suggestion].replace(/ \(.*$/, '')}`) : null),
      blocked ? h('div', { class: 'hint', style: 'color:var(--err);margin-top:4px' },
        '⛔ This step moves live traffic and no populated verification gate comes before it — it must not be run.') : null,
      (isTrafficStep(s) && (s.requires || []).length) ? h('div', { class: 'hint', style: 'margin-top:4px' },
        `Waits for: ${s.requires.join(', ')}`) : null,
      gateTests.length ? h('details', { style: 'margin-top:6px' },
        h('summary', { class: 'hint' }, `${gateTests.length} check(s) in this gate — ${gateSummary(gateTests)}`),
        h('div', { style: 'max-height:240px;overflow:auto;margin-top:4px' }, gateTests.map((t, ti) => h('div', {
          style: 'padding:4px 0;border-bottom:1px solid var(--border)',
        },
        h('div', { class: 'row' },
          h('span', { class: 'hint', style: 'width:20px' }, String(ti + 1)),
          h('span', { style: 'font-weight:600' }, ostr(t.name)),
          onFailOf(t) === 'block' ? badge('BLOCKING', 'err') : badge('advisory'),
          t.owner ? badge(t.owner, 'accent') : badge('unowned', 'warn'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm', title: 'Remove this check from the gate', onClick: () => { gateTests.splice(ti, 1); redraw(); drawGate(); } }, '✕')),
        h('div', { class: 'hint' }, t.expected ? `Pass: ${t.expected}` : '⚠ no pass criterion recorded'))))) : null,
      (isVerificationStep(s) && !gateTests.length) ? h('div', { class: 'hint', style: 'color:var(--warn);margin-top:4px' },
        '⚠ This gate is empty — it names no checks, so nothing here can fail.') : null);

    return h('div', { class: `card${blocked ? ' card-err' : ''}`, style: `margin-bottom:10px; padding:12px 14px${blocked ? ';border-color:var(--err)' : ''}` },
      h('div', { class: 'row' },
        h('span', { class: 'hint', style: 'width:20px;font-weight:700' }, String(i + 1)),
        h('select', { style: 'width:auto', onChange: (e) => { s.layer = e.target.value; } },
          LAYERS.map((L) => h('option', { value: L, selected: s.layer === L }, LAYER_LABELS[L]))),
        h('input', { value: esc(s.title), placeholder: 'Step title', style: 'flex:1;min-width:180px', onInput: (e) => { s.title = e.target.value; } }),
        h('label', { class: 'row', style: 'gap:4px;cursor:pointer;white-space:nowrap' },
          h('input', { type: 'checkbox', checked: !!s.gate, style: 'width:auto', onChange: (e) => { s.gate = e.target.checked; } }), 'gate'),
        h('input', { type: 'number', value: s.estMinutes ?? '', title: 'estimated minutes', style: 'width:70px', onInput: (e) => { s.estMinutes = e.target.value === '' ? null : Number(e.target.value); } }),
        aiButton({
          ws, api, label: '', glyph: '✦', size: 'sm',
          title: 'Expand this step into operator-grade detail (answer only — nothing is written)',
          modalTitle: `Expand step: ${s.title || `step ${i + 1}`}`,
          context: () => ({ kind: 'runbook', id: rb.id, extra: { step: s, position: i + 1, isRollbackStep: list === rb.rollback } }),
          prompt: 'Expand the single step in context.extra.step into something an operator can execute at 3am. Give, as short '
            + 'markdown sections: Detail (what to do and why, 2-4 sentences), Command (a real command for this stack — '
            + 'kubectl/aws/curl/psql — with angle-bracket placeholders for anything not in the context), Verify (how to check '
            + 'it worked), Pass (the literal output that counts as success), and Watch out for (the one way this step usually '
            + 'goes wrong here). Stay inside this step\'s restore layer — do not fold in the next step\'s work. '
            + 'Invent no resource names; list any placeholder the operator must fill in.',
        }),
        h('button', { class: 'btn btn-sm', title: 'Move up', disabled: i === 0, onClick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); } }, '↑'),
        h('button', { class: 'btn btn-sm', title: 'Move down', disabled: i === list.length - 1, onClick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; redraw(); } }, '↓'),
        h('button', { class: 'btn btn-sm', title: 'Insert step below', onClick: () => { list.splice(i + 1, 0, blankStep(s.layer)); redraw(); } }, '＋'),
        h('button', { class: 'btn btn-sm btn-danger', title: 'Delete step', onClick: () => { list.splice(i, 1); redraw(); } }, '✕')),
      h('div', { class: 'grid cols-2', style: 'margin-top:8px' },
        field('Detail', h('textarea', { style: 'min-height:60px', onInput: (e) => { s.detail = e.target.value; } }, esc(s.detail))),
        h('div', null,
          field('Command', h('input', { class: 'mono', style: 'font-family:var(--mono)', value: esc(s.command), onInput: (e) => { s.command = e.target.value; } })),
          field('Verify', h('input', { value: esc(s.verify), onInput: (e) => { s.verify = e.target.value; } })),
          field('Pass criterion', h('input', { value: esc(s.pass), onInput: (e) => { s.pass = e.target.value; } })))),
      h('div', { class: 'grid cols-2' },
        field('Owner', h('input', { value: esc(s.owner), onInput: (e) => { s.owner = e.target.value; } })),
        field('Record (what to write down)', h('input', { value: esc(s.record), onInput: (e) => { s.record = e.target.value; } }))),
      compChips,
      gateBlock);
  }

  function stepsSection(title, list, emptyLabel) {
    const box = h('div');
    const head = h('div', { class: 'row' });
    const redraw = () => {
      box.innerHTML = ''; head.innerHTML = '';
      head.append(h('h2', { style: 'margin:0' }, title), h('span', { class: 'spacer' }),
        badge(`~${totalMinutes(list)} min total`, 'accent'));
      if (!list.length) box.append(h('p', { class: 'hint' }, emptyLabel));
      list.forEach((s, i) => box.append(stepCard(list, s, i, redraw)));
      box.append(h('button', { class: 'btn', onClick: () => { list.push(blankStep(list.length ? list[list.length - 1].layer : 'L4')); redraw(); } }, '＋ Add step'));
    };
    if (list === rb.steps) redrawSteps = () => { redraw(); };
    redraw();
    return card(head, h('div', { class: 'divider' }), box);
  }

  const preview = () => {
    modal('Runbook preview', h('div', { style: 'max-height:70vh;overflow-y:auto' }, markdown(runbookToMarkdown(rb, componentsById))),
      { wide: true, actions: [] });
  };

  el.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('a', { href: `#/${ws}/runbooks`, class: 'hint' }, '← All runbooks'),
        h('h1', { style: 'margin-top:4px' }, rb.name || '(unnamed runbook)'),
        h('div', { class: 'sub' }, `${rb.steps.length} steps · ~${totalMinutes(rb.steps)} min · updated ${String(rb.updatedAt || '').slice(0, 10) || '—'}`)),
      h('div', { class: 'row' },
        checkAgainstOrderBtn({ ws, api, rb }),
        h('button', { class: 'btn', onClick: preview }, 'Preview as runbook'),
        h('a', { class: 'btn', href: `/api/w/${ws}/export/runbook/${rb.id}.md`, target: '_blank' }, 'Export .md'),
        h('button', {
          class: 'btn btn-danger', onClick: async () => {
            if (!(await confirmDialog(`Delete runbook '${rb.name}'?`))) return;
            try { await api.del(`/w/${ws}/c/runbooks/${rb.id}`); toast('Runbook deleted'); navigate(`#/${ws}/runbooks`); }
            catch (e) { toast(e.message, 'err'); }
          },
        }, 'Delete'),
        h('button', { class: 'btn btn-primary', onClick: save }, 'Save'))),
    aiActionRow({
      ws, api, label: 'AI', style: 'margin:0 0 16px',
      hint: 'Applying an AI proposal reloads this runbook from disk — save your own edits first. The ✦ on each step expands that step without writing anything.',
      actions: [
        {
          label: 'Review this runbook',
          title: 'Critique: missing verifications, unsafe ordering, no rollback, timing that does not add up',
          modalTitle: `Review — ${rb.name || 'runbook'}`,
          mode: 'review',
          reviewKind: 'runbook',
          reviewId: rb.id,
        },
        {
          label: 'Generate rollback steps',
          title: 'A rollback path that actually reverses these steps',
          modalTitle: 'Rollback steps',
          mode: 'operations',
          context: { kind: 'runbook', id: rb.id },
          prompt: 'This runbook\'s rollback path is missing or thin. Propose ONE update operation on "runbooks" setting the '
            + 'full "rollback" array: the steps that get this stack back to the primary region (or back to a safe state) in '
            + 'reverse order of the forward steps — highest layer undone first. Every rollback step needs title, detail, '
            + 'verify, pass, an honest estMinutes, and gate:true wherever traffic or data is involved. Keep any existing '
            + 'rollback steps that are still correct. Say in notes what a human must decide before rolling back.',
        },
        {
          label: 'Draft a test plan from this runbook',
          title: 'Create a test whose app-level checks prove this runbook actually worked',
          modalTitle: 'Test plan from this runbook',
          mode: 'operations',
          context: { kind: 'runbook', id: rb.id },
          prompt: `Draft a recovery test for this runbook as a single create operation on "tests" (runbookId "${rb.id}", `
            + 'status "planned", timestamps and results left null — they are measured during the run, never pre-filled). '
            + 'The appTests array is the point: business-level checks that prove the recovery really worked (a real transaction '
            + 'end to end), each with name, command, expected, componentId from the real inventory, and critical. Also write a '
            + 'scope that states what is in and out, the entry criteria, and the success bar. Do not put an RTA/RPA number '
            + 'anywhere — those are measured on the day.',
        },
      ],
    }),
    card(h('h2', null, 'Metadata'),
      h('div', { class: 'grid cols-2' },
        field('Name', nameInp), field('Tooling', toolSel),
        field('Scenario', scenInp), field('Audience', audInp)),
      field('Notes', notesTa),
      h('h3', { style: 'margin:8px 0 4px' }, 'Preconditions'), precondBox),
    gateBox,
    stepsSection('Steps', rb.steps, 'No steps yet.'),
    stepsSection('Rollback', rb.rollback, 'No rollback steps — a runbook without a way back is a one-way door.'),
  );
  drawGate();
}

export default {
  title: 'Runbooks',
  async render(el, ctx) {
    if (ctx.params && ctx.params[0]) return renderEditor(el, ctx, ctx.params[0]);
    return renderList(el, ctx);
  },
};
