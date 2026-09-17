// Inventory — the heart of the app: every component that must come back,
// how it's replicated, what it depends on, and how you verify it.
//
// The table answers the page's question in its FIRST column after the name:
// what does this thing depend on. Tier, outbound calls and gap notes used to be
// columns of their own; they were an em-dash on most rows, so they are now flags
// inside the name cell that appear only when they mean something.
import { h, card, badge, empty, toast, confirmDialog, field, pageHead, banner, btn, term, snapshot } from '../ui.js';
import { aiActionRow } from '../ai-actions.js';
import { crumbFor, nextStepFor } from '../onboarding.js';

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
  .row-link { display:inline-block; margin-top:3px; font-size:11.5px; font-weight:600; opacity:0; transition:opacity .12s; }
  tr:hover .row-link, .row-link:focus-visible { opacity:1; }
  @media (hover: none) { .row-link { opacity:1; } }
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
  .inv-flags { display:flex; gap:5px; flex-wrap:wrap; margin-top:4px; }
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
    const snap = await snapshot(api, ws).catch(() => ({}));
    const state = { q: '', category: '', tier: '', scope: '', needs: '', view: 'list', explore: null };
    const byId = () => Object.fromEntries(comps.map((c) => [c.id, c]));

    const body = h('div');
    const bannerBox = h('div');
    const countBadge = h('span');

    async function reload() {
      comps = (await api.get(`/w/${ws}/c/components`)).items || [];
      rerender();
    }

    // ---------------- filters ----------------
    const needsVerify = (c) => !(c.verification && c.verification.command);
    const needsLayer = (c) => !c.restoreLayer;
    function filtered() {
      const q = state.q.trim().toLowerCase();
      return comps.filter((c) => {
        if (state.category && (c.category || 'other') !== state.category) return false;
        if (state.tier !== '' && String(c.tier ?? '') !== state.tier) return false;
        if (state.scope && (c.inRecoveryScope || 'unknown') !== state.scope) return false;
        if (state.needs === 'verify' && !needsVerify(c)) return false;
        if (state.needs === 'layer' && !needsLayer(c)) return false;
        if (!q) return true;
        const hay = [c.name, c.kind, c.owner, c.team, c.description, (c.tags || []).join(' '), (c.awsServices || []).join(' ')].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    // ---------------- list view ----------------
    const COLUMNS = ['Name', 'Depends on', 'Layer', 'Scope', 'Recovered by', 'Owner'];

    function componentRow(c) {
      const idx = byId();
      const usedBy = comps.filter((o) => (o.dependsOn || []).includes(c.id));
      const rep = c.replication || {};
      const out = c.outboundCalls || [];
      const critExt = out.some((o) => o.critical && (o.type === 'third-party' || o.type === 'saas'));
      const gapsN = (c.gaps || []).length;
      const tier = c.tier ?? null;
      // Exceptions only: a chip on every row is wallpaper, a chip on the four
      // rows that have a problem is a work queue.
      const flags = [
        tier === 0 || tier === 1 ? badge(`Tier ${tier}`, tier === 0 ? 'err' : 'warn') : null,
        gapsN ? h('span', { class: 'chip err', title: (c.gaps || []).join('\n') }, `${gapsN} gap${gapsN > 1 ? 's' : ''}`) : null,
        critExt ? h('span', { class: 'chip err', title: out.filter((o) => o.critical).map((o) => o.target).join(', ') }, 'critical outbound') : null,
        !critExt && out.length ? h('span', { class: 'chip', title: out.map((o) => o.target).join(', ') }, `${out.length} outbound`) : null,
      ].filter(Boolean);
      return h('tr', { class: 'clickable', onClick: () => openEditor(c) },
        h('td', null,
          h('div', { style: 'font-weight:600' }, esc(c.name) || '(unnamed)'),
          h('div', { class: 'hint' }, esc(c.kind)),
          flags.length ? h('div', { class: 'inv-flags' }, flags) : null,
          // Straight to the one-service view: what it needs to come back,
          // what's missing, how it's recovered. Row click still opens the editor.
          h('a', {
            class: 'row-link', href: `#/${ws}/service/${c.id}`,
            title: 'Open the full DR profile for this service',
            onClick: (e) => e.stopPropagation(),
          }, 'DR profile →')),
        // The number in plain text, a chip only for the exception — a chip on
        // every row would be wallpaper again.
        h('td', null, (c.dependsOn || []).length
          ? h('span', { title: (c.dependsOn || []).map((d) => idx[d]?.name || d).join(', ') }, `${c.dependsOn.length}`)
          : h('span', { class: 'chip err' }, 'none recorded'),
          usedBy.length ? h('div', { class: 'hint', style: 'margin-top:2px' }, `used by ${usedBy.length}`) : null),
        h('td', null, c.restoreLayer ? badge(c.restoreLayer, 'accent') : h('span', { class: 'hint' }, '—')),
        h('td', null, badge(c.inRecoveryScope || 'unknown', SCOPE_KIND[c.inRecoveryScope] || '')),
        h('td', null,
          rep.mechanism ? h('div', { style: 'font-size:12.5px' }, esc(rep.mechanism)) : h('span', { class: 'hint' }, 'nothing recorded'),
          h('div', { class: 'hint' },
            rep.rpoMinutes !== null && rep.rpoMinutes !== undefined ? `RPO ${rep.rpoMinutes} min` : 'no RPO',
            needsVerify(c) ? ' · no verify' : ' · verified')),
        h('td', null, h('div', { style: 'font-size:12.5px' }, esc(c.owner) || h('span', { class: 'hint' }, '—')),
          c.team ? h('div', { class: 'hint' }, esc(c.team)) : null),
      );
    }

    function renderList() {
      const items = filtered();
      countBadge.replaceChildren(badge(`${items.length} of ${comps.length} shown`));
      if (!comps.length) {
        body.replaceChildren(card(empty({
          icon: '▤',
          title: 'Nothing recorded yet',
          body: 'Diagrams, runbooks and tests are all generated from this list. Start with your main application, its databases and the network they live in.',
          actions: [
            { label: 'Import read-only from AWS', href: `#/${ws}/discover`, kind: 'btn-primary' },
            { label: '＋ Add one by hand', onClick: () => openEditor(null), kind: '' },
          ],
        })));
        return;
      }
      if (!items.length) {
        body.replaceChildren(card(empty({
          title: 'Nothing matches the current filters',
          body: `${comps.length} resource${comps.length > 1 ? 's are' : ' is'} recorded — widen the filters to see them.`,
          action: { label: 'Clear filters', kind: '', onClick: () => clearFilters() },
        })));
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
              h('thead', null, h('tr', null, COLUMNS.map((t) => h('th', null, t)))),
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
            h('a', { class: 'hint', href: `#/${ws}/diagrams` }, 'Full graph on Diagrams →')),
          h('div', { class: 'grid cols-2' },
            h('div', null,
              h('h3', { style: 'margin-bottom:8px' }, 'Must come back first'),
              h('div', { class: 'tree' },
                (c.dependsOn || []).length ? treeNode(c, 'up', new Set([c.id]), 0) : h('div', null, treeNode(c, 'up', new Set([c.id]), 0), h('div', { class: 'hint', style: 'margin-top:4px' }, 'No upstream dependencies recorded.')))),
            h('div', null,
              h('h3', { style: 'margin-bottom:8px' }, 'Breaks without it'),
              h('div', { class: 'tree' },
                comps.some((o) => (o.dependsOn || []).includes(c.id))
                  ? treeNode(c, 'down', new Set([c.id]), 0)
                  : h('div', null, treeNode(c, 'down', new Set([c.id]), 0), h('div', { class: 'hint', style: 'margin-top:4px' }, 'Nothing depends on this component.')))))));
    }

    // ---------------- data-quality banner ----------------
    // Was two clauses of theory. Now it is a queue: the count, and a button that
    // filters the table down to exactly those rows.
    function renderBanner() {
      bannerBox.innerHTML = '';
      if (!comps.length) return;
      const noVerify = comps.filter(needsVerify).length;
      const noLayer = comps.filter(needsLayer).length;
      if (!noVerify && !noLayer) {
        bannerBox.append(banner({
          kind: 'ok',
          title: 'Every resource has a restore layer and a way to prove it recovered',
          body: 'That is what makes a runbook sequenceable and a test gateable.',
        }));
        return;
      }
      const worst = noVerify >= noLayer ? 'verify' : 'layer';
      bannerBox.append(banner({
        kind: 'warn',
        title: [noVerify ? `${noVerify} with no ${''}verification` : null,
          noLayer ? `${noLayer} with no restore layer` : null].filter(Boolean).join(' · '),
        body: h('span', null, 'A resource with no ', term('verification'),
          ' cannot gate a layer; one with no ', term('restore layer'), ' cannot be sequenced.'),
        action: {
          label: worst === 'verify' ? 'Show the unverifiable ones' : 'Show the unlayered ones',
          onClick: () => { state.needs = worst; state.view = 'list'; setView('list'); needsSel.value = worst; rerender(); },
        },
      }));
    }

    function rerender() {
      renderBanner();
      drawFilterSummary();
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

      // ---------------- contextual AI on THIS component ----------------
      // The context is a function so it is evaluated on click — the AI sees
      // what the user has typed, not what the form held when it opened.
      const editorContext = () => ({
        kind: 'component',
        id: c.id,
        extra: {
          editorDraft: {
            name: g.name.value, kind: g.kind.value, category: g.category.value,
            description: g.description.value, awsServices: awsEd.get(),
            definedIn: g.definedIn.value, notes: g.notes.value,
            restoreLayer: r.restoreLayer.value, inRecoveryScope: r.scope.value,
            replicationMechanism: r.mech.value,
            verification: { command: verCmd.value, pass: verPass.value },
          },
          note: 'editorDraft is what the user currently has typed in the editor (possibly unsaved). Proposed operations must target the saved component.',
        },
      });
      // After applying, the saved component changed underneath the form — reload
      // it from the server rather than showing stale values.
      const reopen = async () => {
        back.remove();
        await reload();
        const fresh = comps.find((x) => x.id === c.id);
        if (fresh) openEditor(fresh);
      };

      const aiRow = isNew
        ? aiActionRow({
          ws, api, label: 'AI',
          hint: 'Save the component first and the AI can edit it directly — for now it answers, you type.',
          actions: [{
            label: 'Suggest values for these fields',
            title: 'Propose category, tier, restore layer, replication, dependencies and a verification command for what you have typed so far',
            modalTitle: 'Suggested field values',
            context: () => ({ kind: 'inventory', extra: { newComponentDraft: { name: g.name.value, kind: g.kind.value, category: g.category.value, description: g.description.value, awsServices: awsEd.get() } } }),
            prompt: 'A user is adding the component in extra.newComponentDraft to this DR inventory. '
              + 'Propose values for: category, tier, restoreLayer, inRecoveryScope, replication.mechanism, '
              + 'dependsOn (existing component ids from the inventory, with names), verification.command and verification.pass. '
              + 'Answer as one compact markdown table of field | suggested value | why (one short clause). '
              + 'Where the draft is too thin to judge a field, say "needs input" and name the one thing you would need to know.',
          }],
        })
        : aiActionRow({
          ws, api, label: 'AI',
          hint: 'Proposals are reviewed before anything is written, and they apply to the SAVED component — save your own edits first, then apply.',
          onApplied: reopen,
          actions: [
            {
              label: 'Fill in what\'s missing',
              title: 'Propose description, category, tier, restore layer, replication and verification for this component only',
              modalTitle: 'Fill in what\'s missing',
              mode: 'operations',
              context: editorContext,
              prompt: 'Fill in the MISSING or "unknown" fields on this one component (see context.component) with a single '
                + 'update operation on the components collection. Rules: never overwrite a field that already has a real value; '
                + 'only touch description, category, tier, kind, restoreLayer, inRecoveryScope, replication{mechanism,rpoMinutes,notes}, '
                + 'verification{command,pass}, awsServices, definedIn; keep restoreLayer consistent with what this component depends on; '
                + 'if you cannot infer a field honestly from the context, leave it out and say why in notes.',
            },
            {
              label: 'Infer dependencies',
              title: 'Propose dependsOn edges and outbound calls from this component\'s name, kind, AWS services and the rest of the inventory',
              modalTitle: 'Inferred dependencies',
              mode: 'operations',
              context: editorContext,
              prompt: 'Infer this component\'s dependencies. Propose ONE update operation setting dependsOn to the full list '
                + '(existing dependsOn ids PLUS the ones you are adding — it replaces the array), using only component ids that exist in the context. '
                + 'Also propose outboundCalls entries for external/third-party/AWS calls this component clearly makes (the ones that silently '
                + 'fail after a region failover: allowlists, partner endpoints, SaaS). Each added edge needs a why naming the evidence you used. '
                + 'Add nothing you cannot justify from the context — a wrong dependency edge mis-orders a real recovery.',
            },
            {
              label: 'Draft verification command',
              title: 'A real kubectl/aws/curl check plus the output that counts as a pass',
              modalTitle: 'Verification command',
              mode: 'operations',
              context: editorContext,
              prompt: 'Write the verification for this component: a single command an operator can paste during a recovery test '
                + '(kubectl / aws CLI / curl / psql — match the component kind and awsServices) and a pass criterion that is the '
                + 'literal output pattern meaning "this is really recovered". Propose one update operation setting '
                + 'verification{command,pass}. Use placeholders in ANGLE BRACKETS for anything not in the context (cluster name, '
                + 'namespace, endpoint) and list those placeholders in notes — do not invent real resource names.',
            },
            {
              label: 'Explain the DR risk',
              title: 'What breaks in a real regional failover, for this component',
              modalTitle: 'DR risk for this component',
              prompt: 'Explain this component\'s disaster-recovery risk in under 200 words: what actually breaks for it in a '
                + 'regional failover, which of its dependencies or secrets are the weak link, what its replication mechanism '
                + 'does and does not protect, and the single cheapest thing to fix first. Cite real ids/names from the context. '
                + 'If its replication or scope is unknown, say that is the risk rather than guessing.',
            },
          ],
        });

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
        h('div', { style: 'margin:-6px 0 16px' }, aiRow),
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
    // Search stays visible; the four selects that are at their default almost
    // always fold into one disclosure whose closed row states what is active —
    // the pattern the Discover page already uses.
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
    const needsSel = h('select', { onChange: (e) => { state.needs = e.target.value; rerender(); } },
      h('option', { value: '' }, 'Complete or not'),
      h('option', { value: 'verify' }, 'Missing a verification'),
      h('option', { value: 'layer' }, 'Missing a restore layer'));

    const filterSummary = h('span', { class: 'hint' });
    function clearFilters() {
      state.category = ''; state.tier = ''; state.scope = ''; state.needs = ''; state.q = '';
      catSel.value = ''; tierSel.value = ''; scopeSel.value = ''; needsSel.value = ''; search.value = '';
      rerender();
    }
    function drawFilterSummary() {
      const on = [
        state.category ? CAT_LABEL[state.category] || state.category : null,
        state.tier !== '' ? `Tier ${state.tier}` : null,
        state.scope ? `scope ${state.scope}` : null,
        state.needs === 'verify' ? 'missing a verification' : state.needs === 'layer' ? 'missing a layer' : null,
      ].filter(Boolean);
      filterSummary.replaceChildren(on.length ? `${on.join(' · ')}` : 'all categories · all tiers · any scope');
    }
    const filterBox = h('details', { class: 'adv-inline' },
      h('summary', null, 'Filters ', filterSummary),
      h('div', { class: 'row', style: 'padding:10px 2px 2px' },
        catSel, tierSel, scopeSel, needsSel,
        btn({ label: 'Clear', size: 'btn-sm', kind: 'btn-ghost', onClick: clearFilters })));

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
      pageHead({
        title: 'Inventory',
        purpose: 'Record everything that has to come back and what each thing depends on — every runbook, diagram and test is built from this list.',
        crumb: crumbFor('inventory', ws),
        // An empty inventory's one unmistakable action is "import", offered by the
        // empty state below; this generic button steps aside for it.
        actions: [btn({ label: '＋ Add component', kind: comps.length ? 'btn-primary' : '', onClick: () => openEditor(null) })],
      }),
      h('div', { class: 'tabs' }, tabList, tabExp),
      bannerBox,
      h('div', { class: 'inv-toolbar' }, search, filterBox, h('span', { class: 'spacer' }), countBadge),
      aiActionRow({
        ws, api, label: 'AI', style: 'margin:-4px 0 16px',
        hint: 'Every proposal is reviewed item by item before anything is written to this workspace.',
        onApplied: reload,
        actions: [
          {
            label: 'Find gaps in this inventory',
            title: 'Turn the real weaknesses in this inventory into tracked gap items',
            modalTitle: 'Gaps found in this inventory',
            mode: 'operations',
            context: { kind: 'inventory' },
            prompt: 'Find the real disaster-recovery gaps in this inventory and propose them as create operations on the '
              + '"gaps" collection — one gap per distinct problem, worst first, at most 8. Each gap: a title naming the '
              + 'specific problem, severity, class, and componentId when it belongs to one component. Look for: components '
              + 'with no verification, no restore layer, or scope "no"/"unknown" that Tier-0 work depends on; replication '
              + 'claims with no RPO; secrets that are not replicated; third-party/outbound calls with no failover behavior; '
              + 'missing dependency edges. Skip anything already present in context.gaps. Propose nothing you cannot point at in the data.',
          },
          {
            label: 'Suggest missing components',
            title: 'Which components a complete DR inventory for this stack would have and this one does not',
            modalTitle: 'Components that may be missing',
            mode: 'operations',
            context: { kind: 'inventory' },
            prompt: 'Which components is this DR inventory missing? Propose create operations on "components" for the ones a '
              + 'complete recovery of THIS stack would need and this inventory does not have — think about the categories that '
              + 'get forgotten: secrets, DNS/edge, identity/OIDC, observability, CI/CD control plane, third-party egress, '
              + 'backup/guardrails. At most 8, each with name, category, kind, restoreLayer, description, and dependsOn using '
              + 'existing ids. Base every suggestion on something visible in the inventory (an AWS service, a dependency, an '
              + 'outbound call) and say what in the why. Do not duplicate an existing component under another name.',
          },
          {
            label: 'Review this inventory',
            title: 'A critique: what would make a real failover fail today',
            modalTitle: 'Inventory review',
            mode: 'review',
            reviewKind: 'inventory',
          },
        ],
      }),
      body,
      nextStepFor('inventory', snap, ws),
    );
    rerender();
  },
};
