// Runbooks: list, template-based creation, step editor, preview, recommender panel.
import { h, card, badge, empty, field, modal, toast, confirmDialog, markdown } from '../ui.js';
import { aiActionRow, aiButton } from '../ai-actions.js';

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
  return { id: genId('stp'), layer, title: '', detail: '', command: '', verify: '', pass: '', owner: '', estMinutes: 10, gate: false, record: '', componentIds: [] };
}

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
  const section = (title, steps) => {
    if (!(steps || []).length) return;
    lines.push(`## ${title} (~${totalMinutes(steps)} min)`, '');
    steps.forEach((s, i) => {
      lines.push(`### ${i + 1}. [${s.layer}] ${s.title}${s.gate ? ' — GATE' : ''}`, '');
      if (s.detail) lines.push(s.detail, '');
      if (s.command) lines.push('```', s.command, '```', '');
      if (s.verify) lines.push(`- **Verify:** ${s.verify}`);
      if (s.pass) lines.push(`- **Pass:** ${s.pass}`);
      if (s.owner) lines.push(`- **Owner:** ${s.owner} · ~${s.estMinutes || 0} min`);
      if (s.record) lines.push(`- **Record:** ${s.record}`);
      const names = (s.componentIds || []).map((id) => componentsById[id]?.name || id);
      if (names.length) lines.push(`- **Components:** ${names.join(', ')}`);
      lines.push('');
    });
  };
  section('Steps', rb.steps);
  section('Rollback', rb.rollback);
  if (rb.notes) lines.push('## Notes', '', rb.notes, '');
  return lines.join('\n');
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

  el.append(h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Runbooks'),
      h('div', { class: 'sub' }, 'Step-by-step failover and recovery-test procedures, layered L0→L7')),
    h('button', { class: 'btn btn-primary', onClick: newRunbook }, '＋ New runbook')));

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
      out.append(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['#', 'Layer', 'Block', 'Components', 'Notes'].map((x) => h('th', null, x)))),
        h('tbody', null, (rs.plan.steps || []).map((s) => h('tr', null,
          h('td', null, String(s.order)), h('td', null, badge(s.layer, LAYER_KIND[s.layer] || '')),
          h('td', null, s.blockType), h('td', null, (s.components || []).join(', ')),
          h('td', { class: 'hint' }, s.notes || ''))))));
      out.append(h('div', { style: 'margin-top:10px' }, h('button', {
        class: 'btn', onClick: async () => {
          const body = {
            name: rs.plan.name, tooling: 'region-switch', scenario: 'region-loss', audience: 'operator',
            preconditions: ['Region switch plan built and healthy in BOTH regions', 'Plan practiced in practice mode this quarter'],
            steps: (rs.plan.steps || []).map((s) => ({
              ...blankStep(s.layer), title: s.name, detail: s.notes || '',
              verify: `Execution block '${s.blockType}' reports complete`, pass: 'Block green in the execution report',
              gate: true, estMinutes: 15,
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

    return h('div', { class: 'card', style: 'margin-bottom:10px; padding:12px 14px' },
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
      compChips);
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
    stepsSection('Steps', rb.steps, 'No steps yet.'),
    stepsSection('Rollback', rb.rollback, 'No rollback steps — a runbook without a way back is a one-way door.'),
  );
}

export default {
  title: 'Runbooks',
  async render(el, ctx) {
    if (ctx.params && ctx.params[0]) return renderEditor(el, ctx, ctx.params[0]);
    return renderList(el, ctx);
  },
};
