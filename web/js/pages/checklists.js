// Checklists: template-based readiness gates with proof, persistence, and print.
import { h, card, badge, empty, field, modal, toast, confirmDialog } from '../ui.js';
import { aiActionRow } from '../ai-actions.js';

const KIND_LABEL = { phase0: 'Phase 0', preflight: 'Preflight', 'game-day': 'Game day', weekly: 'Weekly', custom: 'Custom' };
const KIND_BADGE = { phase0: 'err', preflight: 'warn', 'game-day': 'purple', weekly: 'accent', custom: '' };
const genId = (p) => `${p}_${Math.random().toString(16).slice(2, 10)}`;
const esc = (v) => (v === null || v === undefined) ? '' : String(v);

const PRINT_STYLE = `
@media print {
  #sidebar, .no-print, #toasts { display: none !important; }
  #outlet { padding: 0; max-width: none; }
  body { background: #fff; color: #000; }
  .card { border: 1px solid #999; background: #fff; box-shadow: none; }
  .badge { border: 1px solid #999; background: #fff; color: #000; }
  .hint { color: #444; }
  .chk-row { break-inside: avoid; }
  .progress { display: none; }
}`;

function progress(items) {
  const done = (items || []).filter((i) => i.done).length;
  const total = (items || []).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// ------------------------------------------------------------------ list

async function renderList(el, { ws, api, navigate }) {
  let lists = [];
  try { lists = (await api.get(`/w/${ws}/c/checklists`)).items || []; }
  catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }

  const newChecklist = async () => {
    let templates = [];
    try { templates = (await api.get(`/w/${ws}/templates/checklists`)).templates || []; } catch { /* optional */ }
    let chosen = null;
    const body = h('div', null,
      [{ templateId: null, templateName: 'Blank checklist', description: 'Start empty and add your own items.', kind: 'custom' }, ...templates].map((t) =>
        h('label', { class: 'card', style: 'display:block;cursor:pointer;margin-bottom:10px;padding:12px 14px' },
          h('div', { class: 'row' },
            h('input', { type: 'radio', name: 'ctpl', style: 'width:auto', onChange: () => { chosen = t; } }),
            h('strong', null, t.templateName || t.name), badge(KIND_LABEL[t.kind] || t.kind || 'custom', KIND_BADGE[t.kind] || ''),
            t.items ? h('span', { class: 'hint' }, `${t.items.length} items`) : null),
          h('p', { class: 'hint', style: 'margin:6px 0 0 24px' }, t.whenToUse || t.description || ''))));
    const ok = await modal('New checklist — choose a template', body,
      { wide: true, actions: [{ label: 'Create', kind: 'btn-primary', value: true }] });
    if (!ok) return;
    const t = chosen || { templateId: null, kind: 'custom' };
    try {
      const created = await api.post(`/w/${ws}/c/checklists`, {
        name: t.name || t.templateName || 'New checklist', kind: t.kind || 'custom',
        items: (t.items || []).map((i) => ({ ...i, id: genId('itm'), done: !!i.done })),
        updatedAt: new Date().toISOString(),
      });
      toast('Checklist created', 'ok');
      navigate(`#/${ws}/checklists/${created.id}`);
    } catch (e) { toast(e.message, 'err'); }
  };

  el.append(h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Checklists'),
      h('div', { class: 'sub' }, 'Readiness gates with proof — if you can\'t point at the proof, it isn\'t done')),
    h('button', { class: 'btn btn-primary', onClick: newChecklist }, '＋ New checklist')));

  el.append(aiActionRow({
    ws, api, label: 'AI', style: 'margin:-2px 0 16px',
    hint: 'Generated items come with the proof that shows each one is done — you approve them before the checklist is created.',
    actions: [{
      label: 'Generate a checklist',
      title: 'Build a checklist for a situation, from this workspace\'s real gaps and inventory',
      modalTitle: 'Generated checklist',
      mode: 'operations',
      context: { kind: 'checklist' },
      input: {
        title: 'Generate a checklist',
        label: 'Situation',
        placeholder: 'e.g. before the first dev recovery test, or: monthly DR hygiene for the platform team',
        hint: 'It is built from this workspace\'s components, open gaps and existing checklists — not from a generic template.',
      },
      prompt: 'Generate ONE checklist as a single create operation on "checklists" for: {{input}}\n'
        + 'Pick the closest kind (phase0|preflight|game-day|weekly|custom). 8-15 items, ordered so earlier gates make later ones '
        + 'possible. Every item needs: text (an action, objectively checkable), why (the failure it prevents — one clause), '
        + 'proof (the artifact or command output that shows it is done), and done:false. Ground items in this workspace: its '
        + 'components, tooling, open gaps and data-quality problems — cite real names where an item is about a specific thing. '
        + 'Do not duplicate items that already exist in the checklists in the context.',
    }],
  }));

  if (!lists.length) { el.append(empty('No checklists yet — start with Phase 0.')); return; }
  el.append(h('div', { class: 'grid cols-2' }, lists.map((c) => {
    const p = progress(c.items);
    return h('div', { class: 'card', style: 'cursor:pointer', onClick: () => navigate(`#/${ws}/checklists/${c.id}`) },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, c.name || '(unnamed)'), h('span', { class: 'spacer' }),
        badge(KIND_LABEL[c.kind] || c.kind || '—', KIND_BADGE[c.kind] || '')),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('div', { class: 'progress', style: 'flex:1' }, h('div', { style: `width:${p.pct}%` })),
        h('span', { class: 'hint' }, `${p.done}/${p.total}`)),
      h('p', { class: 'hint', style: 'margin-top:8px' }, c.updatedAt ? `updated ${String(c.updatedAt).slice(0, 10)}` : ''));
  })));
}

// ---------------------------------------------------------------- detail

async function renderDetail(el, { ws, api, navigate }, id) {
  let lists = [];
  try { lists = (await api.get(`/w/${ws}/c/checklists`)).items || []; }
  catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }
  const cl = lists.find((x) => x.id === id);
  if (!cl) { el.append(empty('Checklist not found.'), h('p', { style: 'text-align:center' }, h('a', { href: `#/${ws}/checklists` }, '← All checklists'))); return; }
  cl.items = cl.items || [];

  el.append(h('style', null, PRINT_STYLE));

  const save = async (silent = true) => {
    cl.updatedAt = new Date().toISOString();
    try { await api.put(`/w/${ws}/c/checklists/${cl.id}`, cl); if (!silent) toast('Checklist saved', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  const barBox = h('div', { class: 'row', style: 'margin:6px 0 14px' });
  const itemsBox = h('div');

  const drawBar = () => {
    const p = progress(cl.items);
    barBox.innerHTML = '';
    barBox.append(
      h('div', { class: 'progress', style: 'flex:1' }, h('div', { style: `width:${p.pct}%; background:${p.pct === 100 ? 'var(--ok)' : 'var(--accent)'}` })),
      h('span', { class: 'hint' }, `${p.done}/${p.total} done (${p.pct}%)`));
  };

  const editItem = async (item) => {
    const inp = {
      text: h('input', { value: esc(item.text) }),
      why: h('textarea', { style: 'min-height:60px' }, esc(item.why)),
      proof: h('input', { value: esc(item.proof) }),
      owner: h('input', { value: esc(item.owner) }),
    };
    const ok = await modal(item.id ? 'Edit item' : 'Add item', h('div', null,
      field('Item', inp.text), field('Why it matters', inp.why),
      field('Proof (what shows it is done)', inp.proof), field('Owner', inp.owner)),
      { actions: [{ label: 'Save', kind: 'btn-primary', value: true }] });
    if (!ok) return null;
    return { text: inp.text.value, why: inp.why.value, proof: inp.proof.value, owner: inp.owner.value };
  };

  const drawItems = () => {
    itemsBox.innerHTML = '';
    if (!cl.items.length) itemsBox.append(h('p', { class: 'hint' }, 'No items yet.'));
    cl.items.forEach((item, i) => {
      const cb = h('input', {
        type: 'checkbox', checked: !!item.done, style: 'width:auto;margin-top:3px',
        onChange: async (e) => { item.done = e.target.checked; await save(); drawBar(); row.style.opacity = item.done ? '0.75' : '1'; },
      });
      const row = h('div', { class: 'card chk-row', style: `margin-bottom:8px;padding:10px 14px;${item.done ? 'opacity:.75' : ''}` },
        h('div', { class: 'row', style: 'align-items:flex-start' },
          cb,
          h('div', { style: 'flex:1' },
            h('div', null, h('strong', { style: item.done ? 'text-decoration:line-through' : '' }, item.text || '(empty item)')),
            item.why ? h('div', { class: 'hint', style: 'margin-top:3px' }, 'Why: ', item.why) : null,
            item.proof ? h('div', { class: 'hint', style: 'margin-top:2px' }, 'Proof: ', item.proof) : null),
          item.owner ? badge(item.owner) : null,
          h('span', { class: 'row no-print' },
            h('button', { class: 'btn btn-sm', onClick: async () => {
              const v = await editItem(item);
              if (v) { Object.assign(item, v); await save(); drawItems(); }
            } }, '✎'),
            h('button', { class: 'btn btn-sm', onClick: async () => {
              cl.items.splice(i, 1); await save(); drawItems(); drawBar();
            } }, '✕'))));
      itemsBox.append(row);
    });
    itemsBox.append(h('button', { class: 'btn no-print', style: 'margin-top:6px', onClick: async () => {
      const v = await editItem({});
      if (v && v.text.trim()) { cl.items.push({ id: genId('itm'), ...v, done: false }); await save(); drawItems(); drawBar(); }
    } }, '＋ Add item'));
  };

  drawBar(); drawItems();

  el.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('a', { href: `#/${ws}/checklists`, class: 'hint no-print' }, '← All checklists'),
        h('h1', { style: 'margin-top:4px' }, cl.name || '(unnamed checklist)'),
        h('div', { class: 'sub' }, KIND_LABEL[cl.kind] || cl.kind || '')),
      h('div', { class: 'row no-print' },
        h('button', { class: 'btn', onClick: () => window.print() }, '🖨 Print'),
        h('button', { class: 'btn', onClick: async () => {
          if (!(await confirmDialog('Reset all items to not-done?'))) return;
          cl.items.forEach((i) => { i.done = false; });
          await save(); drawItems(); drawBar();
          toast('Checklist reset', 'ok');
        } }, 'Reset all'),
        h('button', { class: 'btn btn-danger', onClick: async () => {
          if (!(await confirmDialog(`Delete checklist '${cl.name}'?`))) return;
          try { await api.del(`/w/${ws}/c/checklists/${cl.id}`); toast('Checklist deleted'); navigate(`#/${ws}/checklists`); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Delete'))),
    h('div', { class: 'no-print' }, aiActionRow({
      ws, api, label: 'AI', style: 'margin:0 0 4px',
      hint: 'Applying reloads this checklist from disk. Nothing is added until you approve it.',
      actions: [
        {
          label: 'Add the items I\'m missing',
          title: 'Compare this checklist against the templates and the workspace\'s actual gaps',
          modalTitle: 'Items this checklist is missing',
          mode: 'operations',
          context: () => ({ kind: 'checklist', id: cl.id, extra: { liveItems: cl.items } }),
          prompt: 'What is this checklist missing? Propose ONE update operation on "checklists" setting the full "items" array: '
            + 'every existing item kept EXACTLY as it is (same id, text, why, proof, owner, done), plus the new items appended in '
            + 'the right order. New items must come from this workspace\'s real situation — its open gaps, components without '
            + 'verification or restore layers, replication with no RPO, secrets, edge/DNS, third-party egress, and the kind of '
            + `checklist this is (${cl.kind || 'custom'}). Each new item needs text, why, proof, done:false. Add at most 8, and `
            + 'skip anything an existing item already covers — say what you skipped in notes.',
        },
        {
          label: 'Review this checklist',
          title: 'Are these items verifiable, in the right order, and do they have real proof?',
          modalTitle: `Review — ${cl.name || 'checklist'}`,
          mode: 'review',
          reviewKind: 'checklist',
          reviewId: cl.id,
        },
      ],
    })),
    barBox,
    itemsBox,
  );
}

export default {
  title: 'Checklists',
  async render(el, ctx) {
    if (ctx.params && ctx.params[0]) return renderDetail(el, ctx, ctx.params[0]);
    return renderList(el, ctx);
  },
};
