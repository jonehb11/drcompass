// Inventory — the heart of the app: every component that must come back,
// how it's replicated, what it depends on, and how you verify it.
import { h, card, badge, empty, toast, confirmDialog, field } from '../ui.js';

const CATEGORIES = [
  ['compute', 'Compute'], ['networking', 'Networking'], ['storage', 'Storage'],
  ['database', 'Database'], ['messaging-streaming', 'Messaging & streaming'],
  ['security-secrets', 'Security & secrets'], ['edge-dns', 'Edge & DNS'],
  ['identity-access', 'Identity & access'], ['observability', 'Observability'],
  ['third-party', 'Third party'], ['cicd-control-plane', 'CI/CD & control plane'],
  ['other', 'Other'],
];
const CAT_LABEL = Object.fromEntries(CATEGORIES);
const LAYERS = [
  ['L0', 'L0 — Guardrails & backups'], ['L1', 'L1 — Recovery launch'],
  ['L2', 'L2 — Platform'], ['L3', 'L3 — Data & secrets'],
  ['L4', 'L4 — Applications'], ['L5', 'L5 — Edge reachability'],
  ['L6', 'L6 — Functional success bar'], ['L7', 'L7 — Live traffic cutover'],
];
const SCOPES = ['yes', 'partial', 'no', 'unknown'];
const SCOPE_KIND = { yes: 'ok', partial: 'warn', no: 'err', unknown: '' };
const DR_STRATEGIES = ['inherit', 'backup-restore', 'pilot-light', 'warm-standby', 'active-active'];
const OUT_TYPES = ['aws-service', 'third-party', 'saas', 'internal', 'on-prem'];

const STYLE = `
  .inv-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
  .inv-toolbar input[type=search] { width:220px; }
  .inv-toolbar select { width:auto; }
  .inv-cat-head { display:flex; align-items:center; gap:10px; margin:22px 0 8px; }
  .inv-cat-head:first-child { margin-top:0; }
  .inv-cat-head h3 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .inv-cat-head .line { flex:1; height:1px; background:var(--border); }
  .chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600;
    background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  .chip.err { background:var(--err-soft); border-color:rgba(226,86,79,.35); color:var(--err); }
  .inv-banner { display:flex; gap:10px; align-items:baseline; background:var(--warn-soft);
    border:1px solid rgba(226,163,54,.35); border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:13px; }
  .inv-banner .b-title { font-weight:650; color:var(--warn); white-space:nowrap; }
  .dep-chip { display:inline-flex; align-items:center; gap:6px; background:var(--panel2); border:1px solid var(--border);
    border-radius:999px; padding:3px 10px; font-size:12px; margin:0 6px 6px 0; }
  .dep-chip button { background:none; border:0; color:var(--muted); cursor:pointer; font-size:13px; padding:0; line-height:1; }
  .dep-chip button:hover { color:var(--err); }
  .dep-chip.ro { color:var(--muted); }
  .ed-section { border-top:1px solid var(--border); padding-top:14px; margin-top:16px; }
  .ed-section > h3 { margin-bottom:2px; }
  .ed-section .sec-hint { font-size:12px; color:var(--muted); margin-bottom:10px; }
  .mini-table { width:100%; border-collapse:collapse; }
  .mini-table th { text-align:left; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; padding:4px 6px 4px 0; }
  .mini-table td { padding:3px 6px 3px 0; vertical-align:middle; }
  .mini-table input, .mini-table select { padding:5px 8px; font-size:12.5px; }
  .mini-table .rm { background:none; border:0; color:var(--muted); cursor:pointer; font-size:15px; }
  .mini-table .rm:hover { color:var(--err); }
  .tree { font-size:13px; }
  .tree .tnode { padding:3px 0; }
  .tree .tname { cursor:pointer; color:var(--text); }
  .tree .tname:hover { color:var(--accent); }
  .tree .tmeta { color:var(--muted); font-size:11.5px; margin-left:6px; }
  .tree .cyc { color:var(--warn); font-size:11.5px; }
`;

const esc = (s) => String(s ?? '');

export default {
  title: 'Inventory',
  async render(el, { ws, api }) {
    let comps = (await api.get(`/w/${ws}/c/components`)).items || [];
    const state = { q: '', category: '', tier: '', scope: '', view: 'list', explore: null };
    const byId = () => Object.fromEntries(comps.map((c) => [c.id, c]));

    const body = h('div');
    const bannerBox = h('div');
    const countBadge = h('span');

    async function reload() {
      comps = (await api.get(`/w/${ws}/c/components`)).items || [];
      rerender();
    }

    // ---------------- filters ----------------
    function filtered() {
      const q = state.q.trim().toLowerCase();
      return comps.filter((c) => {
        if (state.category && (c.category || 'other') !== state.category) return false;
        if (state.tier !== '' && String(c.tier ?? '') !== state.tier) return false;
        if (state.scope && (c.inRecoveryScope || 'unknown') !== state.scope) return false;
        if (!q) return true;
        const hay = [c.name, c.kind, c.owner, c.team, c.description, (c.tags || []).join(' '), (c.awsServices || []).join(' ')].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    // ---------------- list view ----------------
    function componentRow(c) {
      const idx = byId();
      const usedBy = comps.filter((o) => (o.dependsOn || []).includes(c.id));
      const rep = c.replication || {};
      const out = c.outboundCalls || [];
      const critExt = out.some((o) => o.critical && (o.type === 'third-party' || o.type === 'saas'));
      const gapsN = (c.gaps || []).length;
      const tier = c.tier ?? null;
      return h('tr', { class: 'clickable', onClick: () => openEditor(c) },
        h('td', null,
          h('div', { style: 'font-weight:600' }, esc(c.name) || '(unnamed)'),
          h('div', { class: 'hint' }, esc(c.kind))),
        h('td', null, tier === null ? h('span', { class: 'hint' }, '—')
          : badge(`Tier ${tier}`, tier === 0 ? 'err' : tier === 1 ? 'warn' : '')),
        h('td', null, c.restoreLayer ? badge(c.restoreLayer, 'accent') : h('span', { class: 'hint' }, '—')),
        h('td', null, badge(c.inRecoveryScope || 'unknown', SCOPE_KIND[c.inRecoveryScope] || '')),
        h('td', null,
          rep.mechanism ? h('div', { style: 'font-size:12.5px' }, esc(rep.mechanism)) : h('span', { class: 'hint' }, '—'),
          rep.rpoMinutes !== null && rep.rpoMinutes !== undefined ? h('div', { class: 'hint' }, `RPO ${rep.rpoMinutes} min`) : null),
        h('td', null, (c.dependsOn || []).length
          ? h('span', { class: 'chip', title: (c.dependsOn || []).map((d) => idx[d]?.name || d).join(', ') }, `${c.dependsOn.length} deps`)
          : h('span', { class: 'hint' }, '—'),
          usedBy.length ? h('div', { class: 'hint', style: 'margin-top:2px' }, `used by ${usedBy.length}`) : null),
        h('td', null, out.length
          ? h('span', { class: `chip ${critExt ? 'err' : ''}`, title: out.map((o) => o.target).join(', ') }, `${out.length} out${critExt ? ' ⚠' : ''}`)
          : h('span', { class: 'hint' }, '—')),
        h('td', null, gapsN ? h('span', { class: 'chip err', title: (c.gaps || []).join('\n') }, `${gapsN} gap${gapsN > 1 ? 's' : ''}`) : h('span', { class: 'hint' }, '—')),
        h('td', null, h('div', { style: 'font-size:12.5px' }, esc(c.owner) || h('span', { class: 'hint' }, '—')),
          c.team ? h('div', { class: 'hint' }, esc(c.team)) : null),
      );
    }

    function renderList() {
      const items = filtered();
      countBadge.replaceChildren(badge(`${items.length} of ${comps.length} shown`));
      if (!comps.length) {
        body.replaceChildren(card(
          h('h2', null, 'No components yet'),
          h('p', null, 'The inventory is the seed of everything — diagrams, runbooks, and tests are all generated from it. Start with the obvious: your main application, its databases, and the network they live in. Add dependencies as you go.'),
          h('p', { class: 'hint', style: 'margin:8px 0 12px' }, 'Tip: the Discover page can propose components from your AWS account; the example workspace shows what a finished inventory looks like.'),
          h('button', { class: 'btn btn-primary', onClick: () => openEditor(null) }, '＋ Add your first component')));
        return;
      }
      if (!items.length) {
        body.replaceChildren(empty('No components match the current filters.'));
        return;
      }
      const frag = h('div');
      const seen = new Set();
      const catOrder = [...CATEGORIES.map(([id]) => id)];
      for (const c of items) if (!CAT_LABEL[c.category || 'other']) catOrder.push(c.category);
      for (const cat of catOrder) {
        if (seen.has(cat)) continue; seen.add(cat);
        const group = items.filter((c) => (c.category || 'other') === cat)
          .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || esc(a.name).localeCompare(esc(b.name)));
        if (!group.length) continue;
        frag.append(
          h('div', { class: 'inv-cat-head' },
            h('h3', null, CAT_LABEL[cat] || cat),
            badge(String(group.length)),
            h('div', { class: 'line' })),
          h('div', { style: 'overflow-x:auto' },
            h('table', { class: 'table' },
              h('thead', null, h('tr', null,
                ['Name', 'Tier', 'Layer', 'Scope', 'Replication', 'Depends on', 'Outbound', 'Gaps', 'Owner'].map((t) => h('th', null, t)))),
              h('tbody', null, group.map(componentRow)))));
      }
      body.replaceChildren(frag);
    }

    // ---------------- dependency explorer ----------------
    function treeNode(c, dir, path, depth) {
      const idx = byId();
      const kids = dir === 'up'
        ? (c.dependsOn || []).map((id) => idx[id]).filter(Boolean)
        : comps.filter((o) => (o.dependsOn || []).includes(c.id));
      const node = h('div', { class: 'tnode', style: `margin-left:${depth * 18}px` },
        h('span', null, depth ? '└ ' : ''),
        h('span', { class: 'tname', onClick: () => openEditor(c) }, esc(c.name)),
        h('span', { class: 'tmeta' },
          `${c.restoreLayer || '?'}${c.tier !== null && c.tier !== undefined ? ` · T${c.tier}` : ''}`));
      const out = [node];
      if (depth > 8) return out;
      for (const k of kids) {
        if (path.has(k.id)) {
          out.push(h('div', { class: 'tnode cyc', style: `margin-left:${(depth + 1) * 18}px` }, `↩ ${esc(k.name)} (cycle)`));
          continue;
        }
        out.push(...treeNode(k, dir, new Set([...path, k.id]), depth + 1));
      }
      return out;
    }

    function renderExplorer() {
      countBadge.replaceChildren(badge(`${comps.length} components`));
      if (!comps.length) { body.replaceChildren(empty('Add components first — the explorer walks their dependency graph.')); return; }
      const sorted = [...comps].sort((a, b) => esc(a.name).localeCompare(esc(b.name)));
      if (!state.explore || !comps.some((c) => c.id === state.explore)) state.explore = sorted[0].id;
      const sel = h('select', { style: 'max-width:340px', onChange: (e) => { state.explore = e.target.value; renderExplorer(); } },
        sorted.map((c) => h('option', { value: c.id, selected: c.id === state.explore }, c.name)));
      const c = byId()[state.explore];
      body.replaceChildren(
        card(
          h('div', { class: 'row', style: 'margin-bottom:12px' },
            h('span', { style: 'font-weight:600' }, 'Component:'), sel,
            h('span', { class: 'spacer' }),
            h('span', { class: 'hint' }, 'Click any name to open its editor · Diagrams page draws the full graph')),
          h('div', { class: 'grid cols-2' },
            h('div', null,
              h('h3', { style: 'margin-bottom:2px' }, 'Depends on (upstream)'),
              h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'Everything below must be restored before this component can work.'),
              h('div', { class: 'tree' },
                (c.dependsOn || []).length ? treeNode(c, 'up', new Set([c.id]), 0) : h('div', null, treeNode(c, 'up', new Set([c.id]), 0), h('div', { class: 'hint', style: 'margin-top:4px' }, 'No upstream dependencies recorded.')))),
            h('div', null,
              h('h3', { style: 'margin-bottom:2px' }, 'Used by (downstream)'),
              h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'Everything below breaks if this component is not recovered.'),
              h('div', { class: 'tree' },
                comps.some((o) => (o.dependsOn || []).includes(c.id))
                  ? treeNode(c, 'down', new Set([c.id]), 0)
                  : h('div', null, treeNode(c, 'down', new Set([c.id]), 0), h('div', { class: 'hint', style: 'margin-top:4px' }, 'Nothing depends on this component.')))))));
    }

    // ---------------- data-quality banner ----------------
    function renderBanner() {
      bannerBox.innerHTML = '';
      if (!comps.length) return;
      const noVerify = comps.filter((c) => !(c.verification && c.verification.command)).length;
      const noLayer = comps.filter((c) => !c.restoreLayer).length;
      const parts = [];
      if (noVerify) parts.push(`${noVerify} component${noVerify > 1 ? 's have' : ' has'} no verification — a layer you can’t verify is a layer you can’t gate.`);
      if (noLayer) parts.push(`${noLayer} missing a restore layer — unlayered components can’t be sequenced in a runbook.`);
      if (!parts.length) return;
      bannerBox.append(h('div', { class: 'inv-banner' },
        h('span', { class: 'b-title' }, 'Data quality'),
        h('span', null, parts.join(' '))));
    }

    function rerender() {
      renderBanner();
      if (state.view === 'list') renderList(); else renderExplorer();
    }

    // ---------------- editor helpers ----------------
    function miniTable(defs, items, addLabel) {
      const rows = [];
      const tbody = h('tbody');
      const makeRow = (item = {}) => {
        const inputs = {};
        const tr = h('tr', null,
          defs.map((d) => {
            let inp;
            if (d.type === 'select') inp = h('select', null, d.options.map((o) => h('option', { value: o, selected: (item[d.key] ?? d.options[0]) === o }, o)));
            else if (d.type === 'check') inp = h('input', { type: 'checkbox', checked: !!item[d.key], style: 'width:auto' });
            else if (d.type === 'number') inp = h('input', { type: 'number', value: item[d.key] ?? '' });
            else inp = h('input', { value: esc(item[d.key]), placeholder: d.label });
            inputs[d.key] = inp;
            return h('td', { style: d.width ? `width:${d.width}` : null }, inp);
          }),
          h('td', { style: 'width:24px' }, h('button', { class: 'rm', title: 'Remove row', onClick: () => { tr.remove(); rows.splice(rows.indexOf(row), 1); } }, '✕')));
        const row = { inputs };
        rows.push(row);
        tbody.append(tr);
      };
      for (const it of items || []) makeRow(it);
      const elx = h('div', null,
        h('table', { class: 'mini-table' },
          h('thead', null, h('tr', null, defs.map((d) => h('th', null, d.label)), h('th'))),
          tbody),
        h('button', { class: 'btn btn-sm', style: 'margin-top:6px', onClick: () => makeRow() }, addLabel || '＋ Add row'));
      const collect = () => rows.map(({ inputs }) => {
        const o = {};
        let hasText = false;
        for (const d of defs) {
          const inp = inputs[d.key];
          if (d.type === 'check') o[d.key] = inp.checked;
          else if (d.type === 'number') o[d.key] = inp.value === '' ? null : Number(inp.value);
          else { o[d.key] = inp.value.trim(); if (o[d.key]) hasText = true; }
        }
        return hasText ? o : null;
      }).filter(Boolean);
      return { el: elx, collect };
    }

    function tagInput(items, placeholder) {
      let tags = [...(items || [])];
      const chips = h('div');
      const draw = () => {
        chips.replaceChildren(...tags.map((t) => h('span', { class: 'dep-chip' }, t,
          h('button', { title: 'remove', onClick: () => { tags = tags.filter((x) => x !== t); draw(); } }, '✕'))));
      };
      draw();
      const inp = h('input', {
        placeholder: placeholder || 'type and press Enter',
        onKeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = inp.value.trim();
          if (v && !tags.includes(v)) { tags.push(v); draw(); }
          inp.value = '';
        },
      });
      return { el: h('div', null, chips, inp), get: () => tags };
    }

    // ---------------- editor modal ----------------
    function openEditor(existing) {
      const c = existing ? JSON.parse(JSON.stringify(existing)) : {
        name: '', category: 'compute', tier: 1, kind: '', owner: '', team: '', description: '',
        drStrategy: 'inherit', restoreLayer: '', inRecoveryScope: 'unknown',
        replication: { mechanism: '', rpoMinutes: null, notes: '' },
        definedIn: '', dependsOn: [], outboundCalls: [], awsServices: [], secrets: [],
        endpoints: [], verification: { command: '', pass: '' }, gaps: [], notes: '', tags: [],
      };
      const isNew = !existing;
      const idx = byId();

      // General
      const g = {
        name: h('input', { value: esc(c.name), placeholder: 'e.g. orders-service' }),
        kind: h('input', { value: esc(c.kind), placeholder: 'e.g. eks-workload, aurora-postgres' }),
        category: h('select', null, CATEGORIES.map(([id, lbl]) => h('option', { value: id, selected: (c.category || 'other') === id }, lbl))),
        tier: h('select', null, [['', '— none —'], ['0', 'Tier 0 — critical path'], ['1', 'Tier 1 — important'], ['2', 'Tier 2 — deferrable'], ['3', 'Tier 3 — best effort']]
          .map(([v, lbl]) => h('option', { value: v, selected: String(c.tier ?? '') === v }, lbl))),
        owner: h('input', { value: esc(c.owner) }),
        team: h('input', { value: esc(c.team) }),
        description: h('textarea', null, esc(c.description)),
        definedIn: h('input', { value: esc(c.definedIn), placeholder: 'e.g. terraform/services/orders' }),
        notes: h('textarea', null, esc(c.notes)),
      };
      const tagsEd = tagInput(c.tags, 'add tag + Enter');

      // Recovery
      const rep = c.replication || {};
      const r = {
        drStrategy: h('select', null, DR_STRATEGIES.map((s) => h('option', { value: s, selected: (c.drStrategy || 'inherit') === s }, s === 'inherit' ? 'inherit (workspace strategy)' : s))),
        restoreLayer: h('select', null, [h('option', { value: '', selected: !c.restoreLayer }, '— unassigned —'),
          LAYERS.map(([id, lbl]) => h('option', { value: id, selected: c.restoreLayer === id }, lbl))]),
        scope: h('select', null, SCOPES.map((s) => h('option', { value: s, selected: (c.inRecoveryScope || 'unknown') === s }, s))),
        mech: h('input', { value: esc(rep.mechanism), placeholder: 'e.g. arpio-snapshot, aurora-global, iac, rebuild, none' }),
        rpo: h('input', { type: 'number', value: rep.rpoMinutes ?? '', placeholder: 'minutes' }),
        repNotes: h('input', { value: esc(rep.notes) }),
      };

      // Dependencies
      let deps = [...(c.dependsOn || [])];
      const depChips = h('div');
      const drawDeps = () => {
        depChips.replaceChildren(...(deps.length
          ? deps.map((id) => h('span', { class: 'dep-chip' }, idx[id]?.name || id,
              h('button', { title: 'remove', onClick: () => { deps = deps.filter((d) => d !== id); drawDeps(); } }, '✕')))
          : [h('span', { class: 'hint' }, 'No dependencies yet.')]));
      };
      drawDeps();
      const depOptions = () => comps.filter((o) => o.id !== c.id && !deps.includes(o.id))
        .sort((a, b) => esc(a.name).localeCompare(esc(b.name)));
      const depSel = h('select', { style: 'max-width:300px' });
      const refreshDepSel = () => depSel.replaceChildren(...depOptions().map((o) => h('option', { value: o.id }, o.name)));
      refreshDepSel();
      const usedBy = comps.filter((o) => o.id !== c.id && (o.dependsOn || []).includes(c.id));

      // Mini-tables
      const outEd = miniTable([
        { key: 'target', label: 'Target' },
        { key: 'type', label: 'Type', type: 'select', options: OUT_TYPES, width: '110px' },
        { key: 'protocol', label: 'Protocol', width: '90px' },
        { key: 'purpose', label: 'Purpose' },
        { key: 'failoverBehavior', label: 'Failover behavior' },
        { key: 'critical', label: 'Crit', type: 'check', width: '36px' },
      ], c.outboundCalls, '＋ Add outbound call');
      const awsEd = tagInput(c.awsServices, 'e.g. EKS — press Enter');
      const secEd = miniTable([
        { key: 'name', label: 'Name' },
        { key: 'arn', label: 'ARN' },
        { key: 'replicated', label: 'Replicated', type: 'select', options: ['unknown', 'yes', 'no'], width: '100px' },
        { key: 'notes', label: 'Notes' },
      ], c.secrets, '＋ Add secret');
      const epEd = miniTable([
        { key: 'name', label: 'Name', width: '140px' },
        { key: 'url', label: 'URL' },
        { key: 'healthCheck', label: 'Health check' },
      ], c.endpoints, '＋ Add endpoint');
      const gapEd = miniTable([{ key: 'text', label: 'Gap' }], (c.gaps || []).map((t) => ({ text: t })), '＋ Add gap');
      const v = c.verification || {};
      const verCmd = h('input', { value: esc(v.command), placeholder: 'e.g. kubectl get deploy -n orders' });
      const verPass = h('input', { value: esc(v.pass), placeholder: 'what output means "recovered"' });

      const section = (title, hint, ...kids) => h('div', { class: 'ed-section' },
        h('h3', null, title), hint ? h('div', { class: 'sec-hint' }, hint) : null, ...kids);

      const back = h('div', { class: 'modal-back' });
      back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
      const closeBtn = h('button', { class: 'btn btn-ghost', onClick: () => back.remove() }, 'Cancel');

      async function save() {
        const name = g.name.value.trim();
        if (!name) { toast('Name is required', 'err'); return; }
        const payload = {
          ...c,
          name, kind: g.kind.value.trim(), category: g.category.value,
          tier: g.tier.value === '' ? null : Number(g.tier.value),
          owner: g.owner.value.trim(), team: g.team.value.trim(),
          description: g.description.value, definedIn: g.definedIn.value.trim(),
          notes: g.notes.value, tags: tagsEd.get(),
          drStrategy: r.drStrategy.value, restoreLayer: r.restoreLayer.value || '',
          inRecoveryScope: r.scope.value,
          replication: { mechanism: r.mech.value.trim(), rpoMinutes: r.rpo.value === '' ? null : Number(r.rpo.value), notes: r.repNotes.value.trim() },
          dependsOn: deps,
          outboundCalls: outEd.collect(),
          awsServices: awsEd.get(),
          secrets: secEd.collect(),
          endpoints: epEd.collect(),
          verification: { command: verCmd.value.trim(), pass: verPass.value.trim() },
          gaps: gapEd.collect().map((o) => o.text),
        };
        try {
          if (isNew) await api.post(`/w/${ws}/c/components`, payload);
          else await api.put(`/w/${ws}/c/components/${c.id}`, payload);
          toast(isNew ? `Component '${name}' added` : 'Saved', 'ok');
          back.remove();
          await reload();
        } catch (e) { toast(e.message, 'err'); }
      }

      async function del() {
        if (!(await confirmDialog(`Delete component '${c.name}'? References from other components' dependencies will remain and show as unknown ids.`))) return;
        try {
          await api.del(`/w/${ws}/c/components/${c.id}`);
          toast('Component deleted');
          back.remove();
          await reload();
        } catch (e) { toast(e.message, 'err'); }
      }

      const box = h('div', { class: 'modal wide', style: 'max-height:88vh; overflow-y:auto' },
        h('h2', null, isNew ? 'New component' : `Edit — ${esc(c.name)}`),
        h('div', { class: 'grid cols-2' },
          field('Name *', g.name), field('Kind', g.kind),
          field('Category', g.category), field('Tier', g.tier),
          field('Owner', g.owner), field('Team', g.team)),
        field('Description', g.description),
        h('div', { class: 'grid cols-2' }, field('Defined in (IaC path)', g.definedIn), field('Tags', tagsEd.el)),
        field('Notes', g.notes),

        section('Recovery', 'How this component comes back in the recovery region.',
          h('div', { class: 'grid cols-2' },
            field('DR strategy', r.drStrategy), field('Restore layer', r.restoreLayer),
            field('In recovery scope', r.scope), field('Replication mechanism', r.mech),
            field('Replication RPO (min)', r.rpo), field('Replication notes', r.repNotes))),

        section('Dependencies', 'What must be up before this component works. Click a chip to remove it.',
          depChips,
          h('div', { class: 'row', style: 'margin-top:8px' }, depSel,
            h('button', {
              class: 'btn btn-sm', onClick: () => {
                if (depSel.value) { deps.push(depSel.value); drawDeps(); refreshDepSel(); }
              },
            }, '＋ Add dependency')),
          usedBy.length ? h('div', { style: 'margin-top:10px' },
            h('div', { class: 'sec-hint' }, 'Used by (read-only — edit on the other component):'),
            usedBy.map((o) => h('span', { class: 'dep-chip ro' }, o.name))) : null),

        section('Outbound calls', 'External calls this component makes — the ones that silently fail after failover (allowlists, egress IPs, partner endpoints).', outEd.el),
        section('AWS services', 'Managed services this component uses.', awsEd.el),
        section('Secrets', 'Secrets this component reads at startup or runtime. Missing secrets are the most common cause of failed recovery tests.', secEd.el),
        section('Endpoints', 'How to reach this component, and its health check.', epEd.el),
        section('Verification', 'The command that proves this component actually recovered — and the output that counts as a pass.',
          h('div', { class: 'grid cols-2' }, field('Command', verCmd), field('Pass criterion', verPass))),
        section('Gaps', 'Known problems with recovering this component. Promote serious ones to tracked gap items via the Tests page.', gapEd.el),

        h('div', { class: 'modal-actions', style: 'justify-content:flex-start' },
          isNew ? null : h('button', { class: 'btn btn-danger', onClick: del }, 'Delete'),
          h('span', { class: 'spacer' }),
          closeBtn,
          h('button', { class: 'btn btn-primary', onClick: save }, isNew ? 'Add component' : 'Save changes')),
      );
      back.append(box);
      document.body.append(back);
      g.name.focus();
    }

    // ---------------- toolbar + page ----------------
    const search = h('input', { type: 'search', placeholder: 'Search name, kind, owner, tag…', onInput: (e) => { state.q = e.target.value; rerender(); } });
    const catSel = h('select', { onChange: (e) => { state.category = e.target.value; rerender(); } },
      h('option', { value: '' }, 'All categories'),
      CATEGORIES.map(([id, lbl]) => h('option', { value: id }, lbl)));
    const tierSel = h('select', { onChange: (e) => { state.tier = e.target.value; rerender(); } },
      h('option', { value: '' }, 'All tiers'),
      ['0', '1', '2', '3'].map((t) => h('option', { value: t }, `Tier ${t}`)));
    const scopeSel = h('select', { onChange: (e) => { state.scope = e.target.value; rerender(); } },
      h('option', { value: '' }, 'Any scope'),
      SCOPES.map((s) => h('option', { value: s }, `scope: ${s}`)));

    const tabList = h('span', { class: 'tab active' }, 'Components');
    const tabExp = h('span', { class: 'tab' }, 'Dependency explorer');
    const setView = (v) => {
      state.view = v;
      tabList.classList.toggle('active', v === 'list');
      tabExp.classList.toggle('active', v === 'explorer');
      rerender();
    };
    tabList.addEventListener('click', () => setView('list'));
    tabExp.addEventListener('click', () => setView('explorer'));

    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, 'Inventory'),
          h('div', { class: 'sub' }, 'Everything that must come back after a disaster — and how you’ll know it did')),
        h('button', { class: 'btn btn-primary', onClick: () => openEditor(null) }, '＋ Add component')),
      h('div', { class: 'tabs' }, tabList, tabExp),
      bannerBox,
      h('div', { class: 'inv-toolbar' }, search, catSel, tierSel, scopeSel, h('span', { class: 'spacer' }), countBadge),
      body,
    );
    rerender();
  },
};
