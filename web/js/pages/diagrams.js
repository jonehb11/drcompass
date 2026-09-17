import mermaid from '/vendor/mermaid/mermaid.esm.min.mjs';
import { h, card, toast, markdown, empty, confirmDialog, modal, badge, pageHead, snapshot } from '../ui.js';
import { crumbFor, nextStepFor } from '../onboarding.js';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  // Real inventories (hundreds of components + resource graphs) easily blow
  // past mermaid's defaults (maxTextSize 50k, maxEdges 500) with a hard
  // "Maximum text size in diagram exceeded" error — raise them generously.
  maxTextSize: 1_000_000,
  maxEdges: 10_000,
  flowchart: { maxEdges: 10_000 },
  themeVariables: {
    background: '#171c25',
    primaryColor: '#1d2431',
    primaryTextColor: '#e6ebf2',
    primaryBorderColor: '#2a3242',
    secondaryColor: '#12161d',
    tertiaryColor: '#171c25',
    lineColor: '#8a94a6',
    clusterBkg: '#12161d',
    clusterBorder: '#2a3242',
    edgeLabelBackground: '#171c25',
    noteBkgColor: '#1d2431',
    noteBorderColor: '#2a3242',
    noteTextColor: '#e6ebf2',
    actorBkg: '#1d2431',
    actorBorder: '#2a3242',
    actorTextColor: '#e6ebf2',
    signalColor: '#8a94a6',
    signalTextColor: '#e6ebf2',
    fontFamily: 'ui-sans-serif',
  },
});

let renderSeq = 0;

const STYLE = `
  .dg-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; align-items: start; }
  @media (max-width: 1000px) { .dg-layout { grid-template-columns: 1fr; } }
  .dg-item { display: block; width: 100%; text-align: left; background: none; border: 1px solid transparent;
    border-radius: 8px; padding: 6px 9px; cursor: pointer; color: var(--text); font: 13px var(--sans); }
  .dg-item:hover { background: var(--panel2); }
  .dg-item.active { background: var(--accent-soft); border-color: rgba(79,143,247,.35); }
  .dg-item .dg-desc { display: block; font-size: 11.5px; color: var(--muted); margin-top: 1px; }
  .dg-item-head { display: flex; align-items: baseline; gap: 6px; }
  .dg-item-name { min-width: 0; overflow-wrap: anywhere; font-weight: 550; }
  .dg-cap { flex: none; margin-left: auto; font: 600 9.5px var(--sans); letter-spacing: .04em;
    text-transform: uppercase; border-radius: 4px; padding: 1px 5px; border: 1px solid var(--border);
    color: var(--muted); white-space: nowrap; }
  .dg-cap.dg-cap-mmd { color: #c9b184; border-color: rgba(226,163,54,.3); background: var(--warn-soft); }

  /* ---- picker ---- */
  .dg-pick-head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  .dg-pick-head input { flex: 1; min-width: 0; }
  .dg-pick-count { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
  .dg-grp { border-top: 1px solid var(--border); padding-top: 9px; margin-top: 9px; }
  .dg-grp:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
  .dg-grp-head { display: flex; align-items: baseline; gap: 7px; cursor: pointer; list-style: none;
    padding: 2px 0 4px; }
  .dg-grp-head::-webkit-details-marker { display: none; }
  .dg-grp-head h3 { font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
    color: var(--muted); margin: 0; }
  .dg-grp-n { font-size: 11px; color: var(--muted); background: var(--bg2); border: 1px solid var(--border);
    border-radius: 999px; padding: 0 6px; }
  .dg-grp-chev { margin-left: auto; color: var(--muted); font-size: 10px; transition: transform .15s ease; }
  details[open] > .dg-grp-head .dg-grp-chev { transform: rotate(90deg); }
  .dg-grp-hint { font-size: 11.5px; color: var(--muted); margin: 0 0 6px; }
  .dg-grp-body { max-height: 340px; overflow-y: auto; margin-right: -4px; padding-right: 4px; }
  .dg-grp-empty { font-size: 11.5px; color: var(--muted); padding: 2px 9px 6px; }

  .dg-src textarea { font-family: var(--mono); font-size: 12px; min-height: 220px; white-space: pre; }
  .mermaid-wrap svg { max-width: 100%; height: auto; }
  .dg-err pre { white-space: pre-wrap; }
  .dg-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .dg-seg button { background: none; border: 0; padding: 5px 13px; font: 600 12px var(--sans);
    color: var(--muted); cursor: pointer; }
  .dg-seg button + button { border-left: 1px solid var(--border); }
  .dg-seg button.active { background: var(--accent-soft); color: #bcd4fb; }
  .dg-canvas-host { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
    min-height: 560px; overflow: hidden; position: relative; }
  .dg-canvas-host > .loading { padding-top: 180px; }
  .dg-ai-answer { font-size: 13.5px; line-height: 1.6; }
  .dg-ai-answer pre { white-space: pre-wrap; }
`;

const EXAMPLE_PROMPT = 'Import this Mermaid diagram into Lucidchart as a new document named '
  + '"DR architecture", then share the edit link with me:\n\n<paste the Mermaid source here>';

const CANVAS_TEMPLATES = [
  ['category-grid', 'Category grid'],
  ['layer-rows', 'Restore layers'],
  ['flow', 'Flow'],
];

export default {
  title: 'Diagrams',
  async render(el, { ws, api, ui, params }) {
    let list;
    try { list = await api.get(`/w/${ws}/diagrams`); }
    catch (e) { el.append(card(h('h2', null, 'Diagrams unavailable'), h('p', { class: 'hint' }, e.message))); return; }
    const isK8s = (d) => d.kind === 'k8s' || d.section === 'k8s';
    const isRmap = (d) => d.kind === 'resource-map';
    const overview = list.filter((d) => d.kind !== 'component' && !isK8s(d) && !isRmap(d));
    const perComp = list.filter((d) => d.kind === 'component');
    const k8sList = list.filter(isK8s);
    const rmapList = list.filter(isRmap);
    const rmapMain = rmapList.filter((d) => !/^resource-map-./.test(String(d.id)));
    const rmapPerComp = rmapList.filter((d) => /^resource-map-./.test(String(d.id)));

    // ---------- resource graph: badges + expandability (one fetch, best-effort) ----------
    // Pretty type names for association summaries ('security-group' ×2 → '2 security groups').
    const TYPE_UPPER = new Set(['iam', 'kms', 'dns', 'vpc', 'eni', 'eip', 'alb', 'nlb', 'elb',
      'sg', 'acm', 's3', 'sqs', 'sns', 'rds', 'hpa', 'nat', 'api', 'db', 'oidc', 'arn', 'ec2', 'eks', 'ecs', 'ecr',
      'nacl', 'az', 'efs', 'ebs', 'waf', 'tls', 'cidr', 'asg', 'ami']);
    function prettyTypeCount(type, count) {
      const words = String(type === 'other' ? 'resource' : type || 'resource')
        .split(/[-_\s]+/).filter(Boolean)
        .map((w) => (TYPE_UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
      let label = words.join(' ') || 'resource';
      if (count !== 1 && !/s$/i.test(label)) {
        label = /[^aeiou]y$/i.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`;
      }
      return `${count} ${label}`;
    }

    // Pure: full graph -> {componentId: multi-line association summary}.
    function buildAssociationBadges(graph) {
      const perCompTypes = new Map(); // cid -> Map(type -> count)
      for (const n of Object.values(graph?.nodes || {})) {
        if (!n) continue;
        for (const cid of n.componentIds || []) {
          if (!perCompTypes.has(cid)) perCompTypes.set(cid, new Map());
          const m = perCompTypes.get(cid);
          const t = n.type || 'other';
          m.set(t, (m.get(t) || 0) + 1);
        }
      }
      const badges = {};
      for (const [cid, m] of perCompTypes) {
        const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const shown = sorted.slice(0, 4).map(([t, c]) => prettyTypeCount(t, c));
        const extra = sorted.length > 4 ? ` · +${sorted.length - 4} more` : '';
        badges[cid] = `${shown.join(' · ')}${extra}\n⊕ expand associations · click for details`;
      }
      return badges;
    }

    // One full-graph fetch per page visit: computes hover badges, which
    // components are expandable, and how many nodes are still unlinked.
    const graphState = { badges: null, expandableIds: null, unlinkedCount: 0 };
    async function loadGraph() {
      try {
        const g = await api.get(`/w/${ws}/resources/graph`);
        const badges = buildAssociationBadges(g);
        graphState.badges = Object.keys(badges).length ? badges : null;
        const ids = new Set();
        let unlinked = 0;
        for (const n of Object.values(g?.nodes || {})) {
          const cids = Array.isArray(n?.componentIds) ? n.componentIds : [];
          if (!cids.length) unlinked++;
          for (const cid of cids) ids.add(String(cid));
        }
        graphState.expandableIds = ids.size ? [...ids] : null;
        graphState.unlinkedCount = unlinked;
      } catch { /* resources backend not available yet — no badges, nothing expandable */ }
      return graphState;
    }
    let graphPromise = loadGraph().then((gs) => { updateCorrelateBtns(); return gs; });

    async function openPanel(node) {
      try {
        const mod = await import('../resource-panel.js');
        // 'Show on diagram' only when an icon canvas is live and can expand.
        const onExpand = typeof canvasCtl.expandComponent === 'function'
          ? (componentId) => canvasCtl.expandComponent(componentId)
          : undefined;
        mod.openResourcePanel({ ws, api, ui, node, onExpand });
      } catch (e) { toast(`Resource panel unavailable: ${e.message || e}`, 'err'); }
    }

    const state = { id: null, name: '', serverSrc: '', edited: false, canvas: false, mode: 'mermaid' };

    // ---------- view preference (per diagram, localStorage, best-effort) ----------
    const viewKey = (id) => `drcompass.diagramView.${ws}.${id}`;
    const getViewPref = (id) => { try { return localStorage.getItem(viewKey(id)); } catch { return null; } };
    const setViewPref = (id, v) => { try { localStorage.setItem(viewKey(id), v); } catch { /* private mode etc. */ } };

    // Last-viewed diagram per workspace, so returning to the page resumes where
    // the reader left off instead of always snapping back to 'architecture'.
    const lastKey = `drcompass.lastDiagram.${ws}`;
    const getLastDiagram = () => { try { return localStorage.getItem(lastKey); } catch { return null; } };
    const setLastDiagram = (id) => { try { localStorage.setItem(lastKey, id); } catch { /* private mode */ } };

    // Canvas filter/focus/declutter state per diagram. The layouts endpoint
    // stores only positions/template/expandedState (it whitelists those three
    // keys), so this rides in localStorage alongside the view preference.
    const canvasViewKey = (id) => `drcompass.canvasView.${ws}.${id}`;
    const getCanvasView = (id) => {
      try {
        const raw = localStorage.getItem(canvasViewKey(id));
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch { return null; }
    };
    const setCanvasView = (id, v) => {
      try { localStorage.setItem(canvasViewKey(id), JSON.stringify(v || {})); }
      catch { /* private mode / quota */ }
    };

    // ---------- AI actions (parallel agent ships web/js/ai-actions.js) ----------
    // Everything here is defensive: the module may not exist yet, may export a
    // different shape than expected, or may present its own UI. Nothing is ever
    // applied automatically — these are answer-only actions.
    let aiModPromise = null;
    function loadAi() {
      if (!aiModPromise) {
        aiModPromise = import('../ai-actions.js').catch(() => null);
      }
      return aiModPromise;
    }
    async function aiReady() {
      const mod = await loadAi();
      if (!mod) return null;
      try {
        const flag = mod.AI_AVAILABLE;
        if (flag === undefined || flag === null) return mod;         // not advertised — try anyway
        const value = typeof flag === 'function' ? await flag() : await flag;
        return value === false ? null : mod;
      } catch { return mod; }
    }

    // Fallback path only — used when ai-actions.js exists but exposes no
    // aiButton. Answer-only, rendered in a modal.
    async function askAi({ question, context, heading }) {
      const mod = await aiReady();
      if (!mod || typeof mod.aiAsk !== 'function') {
        toast('AI actions are not available in this build yet', 'err');
        return;
      }
      let res;
      try {
        res = await mod.aiAsk({ ws, api, prompt: question, context });
      } catch (e) {
        toast(`AI unavailable: ${e?.message || e}`, 'err');
        return;
      }
      if (res === undefined || res === null) return; // the module presented its own UI
      if (typeof res === 'object' && res.ok === false) {
        toast(res.message || 'The AI could not answer that', 'err');
        return;
      }
      const text = typeof res === 'string' ? res : (res.answer ?? res.markdown ?? '');
      if (!text) { toast('The AI returned no answer', 'err'); return; }
      await modal(heading, h('div', { class: 'dg-ai-answer' }, markdown(String(text))), { wide: true });
    }

    // Build an AI action. Prefers the shared `aiButton` primitive (it owns the
    // modal, the CLI-missing disabled state and error reporting) per the
    // ai-first-class contract in INTEGRATION-NOTES; falls back to our own button.
    // `contextFn` MUST be synchronous — aiButton evaluates it at click time.
    // `ref` (optional) is kept pointing at the LIVE element, because the shared
    // primitive's button replaces ours — callers that toggle `disabled` (e.g.
    // the node-level action) must act on whichever button is actually mounted.
    function makeAiButton({ label, title: btnTitle, prompt, contextFn, modalTitle, ref, startDisabled = false }) {
      const btn = h('button', {
        class: 'btn btn-sm', title: btnTitle, style: 'display:none',
        onClick: async () => {
          const context = contextFn();
          if (!context) return; // the context builder already said why
          const orig = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Asking…';
          try { await askAi({ question: prompt, context, heading: modalTitle }); }
          finally { btn.disabled = false; btn.textContent = orig; }
        },
      }, label);
      if (startDisabled) btn.disabled = true;
      aiButtons.push(btn);
      if (ref) ref.el = btn;
      // Reveal only once we know an AI module exists.
      aiReady().then((mod) => {
        if (!mod) return;
        btn.style.display = '';
        if (typeof mod.aiButton !== 'function') return;
        try {
          const custom = mod.aiButton({
            ws, api, label, title: btnTitle,
            mode: 'answer', glyph: '✦',
            prompt,
            context: () => contextFn() || { kind: 'workspace' },
            modalTitle,
          });
          if (custom && custom.nodeType === 1 && btn.parentNode) {
            if (btn.disabled) custom.disabled = true;
            btn.replaceWith(custom);
            const i = aiButtons.indexOf(btn);
            if (i !== -1) aiButtons[i] = custom;
            if (ref) ref.el = custom;
          }
        } catch { /* keep our own button */ }
      }).catch(() => {});
      return btn;
    }
    const aiButtons = [];

    // The node-level action is only meaningful with a node selected, so it stays
    // disabled until the canvas reports a selection.
    const nodeAiRef = { el: null };
    function setNodeAiEnabled(on) {
      const el = nodeAiRef.el;
      if (!el) return;
      el.disabled = !on;
      el.setAttribute('title', on
        ? 'Ask the AI what the selected node’s failure takes down (answer only)'
        : 'Select a node on the canvas first');
    }

    // Structural facts about the CURRENT diagram, gathered SYNCHRONOUSLY (the
    // shared aiButton evaluates context at click time and does not await it).
    // Live canvas stats when the canvas is mounted; otherwise this cache, filled
    // when a diagram is selected AND an AI module exists — so a build without
    // AI makes no extra request.
    const canvasFactCache = new Map(); // diagramId -> facts
    async function prefetchCanvasFacts(id) {
      if (canvasFactCache.has(id)) return;
      try {
        const cd = await api.get(`/w/${ws}/diagrams/${id}/canvas`);
        const nodes = Array.isArray(cd?.nodes) ? cd.nodes : [];
        const edges = Array.isArray(cd?.edges) ? cd.edges : [];
        const deg = new Map();
        for (const e of edges) {
          for (const side of [e?.from, e?.to]) {
            if (side === undefined || side === null) continue;
            deg.set(String(side), (deg.get(String(side)) || 0) + 1);
          }
        }
        const labelOf = (nid) => nodes.find((n) => String(n?.id) === String(nid))?.label || nid;
        canvasFactCache.set(id, {
          nodes: nodes.length,
          edges: edges.length,
          mostConnected: [...deg.entries()]
            .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
            .slice(0, 8)
            .map(([nid, n]) => `${labelOf(nid)} (${n} links)`),
          tier0: nodes.filter((n) => n && n.tier === 0).map((n) => n.label || n.id).slice(0, 12),
        });
      } catch { /* not canvas-capable or unavailable — the mermaid excerpt still helps */ }
    }

    // Turn canvas node ids into human labels (the mount records the map).
    function nameList(ids) {
      const labels = canvasCtl.labels;
      return ids.map((id) => (labels && labels.get(String(id))) || String(id));
    }

    // Compact, factual facts about the current diagram. `extra` is capped at
    // ~8KB by the AI bridge, so this stays lean and never ships the inventory.
    function diagramFacts() {
      const d = list.find((x) => x.id === state.id) || {};
      const facts = {
        diagramId: state.id,
        diagramName: state.name,
        diagramKind: d.kind || '',
        description: d.description || '',
        viewing: state.mode === 'icons' ? 'icon canvas' : 'mermaid',
      };
      let stats = null;
      try { stats = canvasCtl.ctrl?.getStats?.() || null; } catch { /* canvas not mounted */ }
      if (stats) {
        facts.nodes = stats.nodes;
        facts.edges = stats.edges;
        facts.layout = stats.template;
        facts.sharedInfrastructure = nameList(stats.hubs || []).slice(0, 12);
        if (stats.hidden && (stats.hidden.nodes || stats.hidden.edges)) facts.hiddenByFilters = stats.hidden;
      } else {
        const cached = canvasFactCache.get(state.id);
        if (cached) Object.assign(facts, cached);
      }
      const src = currentSrc();
      if (src) facts.mermaid = src.length > 3000 ? `${src.slice(0, 3000)}\n… (truncated)` : src;
      return facts;
    }

    // Diagram-level context: no single inventory object is the subject, so the
    // selector is the workspace and the diagram facts ride in `extra`.
    const diagramContext = () => ({ kind: 'workspace', extra: diagramFacts() });

    // Node-level context: when the selected node maps to an inventory component,
    // use that component as the selector so the bridge pulls in its real
    // neighbors; otherwise fall back to the workspace.
    function selectedNodeContext() {
      const node = (() => { try { return canvasCtl.ctrl?.getSelectedNode?.() || null; } catch { return null; } })();
      if (!node) { toast('Select a node on the canvas first', 'err'); return null; }
      const componentId = resolveComponentId(node);
      const extra = diagramFacts();
      extra.selectedNode = {
        id: node.id,
        label: node.label,
        kind: node.kind || node.rtype || '',
        category: node.category || '',
        tier: node.tier ?? null,
        restoreLayer: node.layer || '',
      };
      try {
        const facts = canvasCtl.dependencyFacts?.(node.id);
        if (facts) extra.selectedNode.dependencies = facts;
      } catch { /* engine without dependencyFacts */ }
      return componentId
        ? { kind: 'component', id: componentId, extra }
        : { kind: 'workspace', extra };
    }

    // ---------- Lucidchart-safe Mermaid ----------
    async function copyForLucid() {
      if (!state.id) return;
      try {
        const r = await api.get(`/w/${ws}/diagrams/${state.id}?flavor=lucid`);
        const src = r?.mermaid || '';
        if (!src.trim()) { toast('No Lucid-safe Mermaid for this diagram', 'err'); return; }
        await navigator.clipboard.writeText(src);
        const warn = Array.isArray(r?.lucidWarnings) ? r.lucidWarnings : [];
        toast(warn.length
          ? `Lucid-safe Mermaid copied — ${warn[0]}`
          : 'Lucid-safe Mermaid copied — in Lucidchart use Diagram as code → Mermaid and paste', 'ok');
        if (warn.length > 1) {
          await modal('Copied for Lucidchart', h('div', null,
            h('p', { class: 'hint', style: 'margin-bottom:8px' },
              'Pasted into Lucidchart via Diagram as code → Mermaid. The Lucid-safe flavor drops styling '
              + 'directives, flattens nested groups and transliterates labels to ASCII, because Lucid’s '
              + 'importer fails the whole diagram on any unsupported construct.'),
            h('ul', { style: 'margin:0 0 0 18px; font-size:12.5px; color:var(--muted)' },
              warn.map((w) => h('li', null, w)))), { wide: true });
        }
      } catch (e) {
        toast(`Could not build the Lucid-safe Mermaid: ${e.message || e}`, 'err');
      }
    }

    // ---------- mermaid pane (unchanged behavior) ----------
    const title = h('h2', { style: 'margin:0' }, '');
    const wrap = h('div', { class: 'mermaid-wrap', style: 'min-height:280px' });
    const notesBox = h('div', { style: 'margin-top:12px' });
    const srcArea = h('textarea', { spellcheck: 'false' });
    srcArea.readOnly = true;
    const rerenderBtn = h('button', {
      class: 'btn btn-sm', style: 'display:none',
      onClick: () => { state.edited = srcArea.value !== state.serverSrc; draw(srcArea.value); },
    }, 'Re-render');
    const resetBtn = h('button', {
      class: 'btn btn-sm', style: 'display:none',
      onClick: () => { srcArea.value = state.serverSrc; state.edited = false; draw(state.serverSrc); },
    }, 'Reset');
    const editBtn = h('button', {
      class: 'btn btn-sm', onClick: () => {
        srcArea.readOnly = !srcArea.readOnly;
        const editing = !srcArea.readOnly;
        editBtn.textContent = editing ? 'Stop editing' : 'Edit & re-render locally';
        rerenderBtn.style.display = editing ? '' : 'none';
        resetBtn.style.display = editing ? '' : 'none';
      },
    }, 'Edit & re-render locally');
    const srcPanel = h('div', { class: 'dg-src', style: 'display:none; margin-top:12px' },
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('span', { class: 'hint' }, 'Mermaid source (server-generated; local edits are not saved)'),
        h('span', { class: 'spacer' }), editBtn, rerenderBtn, resetBtn),
      srcArea);

    const currentSrc = () => (state.edited ? srcArea.value : state.serverSrc);

    async function draw(src) {
      wrap.innerHTML = '';
      if (!src || !String(src).trim()) { // e.g. canvas-only diagrams (resource maps)
        wrap.append(h('div', { class: 'hint', style: 'padding:32px 8px' },
          state.canvas ? 'This diagram has no Mermaid form — use the Icon canvas view.' : 'Nothing to render for this diagram.'));
        return;
      }
      // Very large sources render slowly and read poorly in Mermaid — the
      // icon canvas is built for that scale. Warn (but still render) above
      // ~150KB; genuinely huge sources get a canvas nudge instead of a hang.
      if (src.length > 150_000 && state.canvas) {
        wrap.append(h('div', { class: 'hint', style: 'padding:6px 8px 10px' },
          `Large diagram (${Math.round(src.length / 1024)}KB of Mermaid) — the Icon canvas view handles this scale much better. Rendering anyway…`));
      }
      wrap.append(h('div', { class: 'loading' }, 'Rendering…'));
      try {
        const { svg } = await mermaid.render(`dg_svg_${++renderSeq}`, src);
        wrap.innerHTML = svg;
      } catch (e) {
        document.getElementById(`dg_svg_${renderSeq}`)?.remove(); // mermaid's scratch node
        wrap.innerHTML = '';
        const sizeIssue = /maximum text size|too many edges|maxEdges/i.test(String(e.message || e));
        wrap.append(h('div', { class: 'dg-err' },
          h('p', { class: 'hint', style: 'color:var(--err); margin-bottom:8px' },
            sizeIssue
              ? `This diagram is too large for the Mermaid renderer (${Math.round(src.length / 1024)}KB source).`
              : `Mermaid failed to parse this diagram: ${e.message || e}`),
          sizeIssue && state.canvas
            ? h('p', { class: 'hint', style: 'margin-bottom:8px' },
                'Switch to the Icon canvas view above — it is built for large inventories (drag, zoom, focus mode). The Mermaid source below can still be copied or downloaded for tools without a size limit.')
            : h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'The source is shown below — you can still copy or download it.'),
          h('details', null, h('summary', { class: 'hint', style: 'cursor:pointer' }, 'Show Mermaid source'),
            h('pre', null, src.length > 400_000 ? src.slice(0, 400_000) + '\n… (truncated for display)' : src))));
      }
    }

    const dl = (url) => { const a = h('a', { href: url }); document.body.append(a); a.click(); a.remove(); };
    const dlBlob = (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    const copyText = async (text, what) => {
      try { await navigator.clipboard.writeText(text); toast(`${what} copied to clipboard`, 'ok'); }
      catch { toast('Clipboard unavailable — select and copy from the source panel', 'err'); }
    };

    // ---------- AI correlate (link unlinked resources / workloads to components) ----------
    const correlateBtns = [];
    function updateCorrelateBtns() {
      const active = list.find((x) => x.id === state.id);
      const show = active?.kind === 'resource-map' || graphState.unlinkedCount > 0;
      for (const b of correlateBtns) b.style.display = show ? '' : 'none';
    }
    function makeCorrelateBtn() {
      const b = h('button', {
        class: 'btn btn-sm', style: 'display:none',
        title: 'Ask your local Claude Code CLI to link unlinked resources and workloads to components',
        onClick: () => runCorrelate(b),
      }, '✨ AI correlate');
      correlateBtns.push(b);
      return b;
    }

    // Download every diagram (SVG + draw.io + Mermaid) as one zip — the same
    // builder the Exports page uses, imported lazily so this page stays light.
    function makeDiagramPackBtn() {
      const b = h('button', {
        class: 'btn btn-sm',
        title: 'Download all diagrams as a zip (SVG, draw.io and Mermaid)',
        onClick: async () => {
          const label = b.textContent;
          b.disabled = true;
          b.textContent = 'Packing…';
          try {
            const { buildDiagramPack } = await import('./exports.js');
            let done = 0;
            // onStep(label) -> {ok, skip, fail}: report progress on the button.
            const onStep = (label) => {
              b.textContent = `Packing… ${String(label || '').slice(0, 26)}`;
              const tick = () => { done += 1; b.textContent = `Packing… (${done})`; };
              return { ok: tick, skip: tick, fail: tick };
            };
            await buildDiagramPack({ ws, api, scope: null, onStep });
            toast('Diagram pack downloaded', 'ok');
          } catch (e) {
            toast(`Could not build the diagram pack: ${e.message || e}`, 'err');
          } finally {
            b.disabled = false;
            b.textContent = label;
          }
        },
      }, '⤓ All diagrams');
      return b;
    }

    async function runCorrelate(btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Correlating…';
      try {
        const r = await api.post(`/w/${ws}/ai/correlate`, {});
        if (!r?.ok) { toast(r?.message || 'AI correlation failed', 'err'); return; }
        if (!Array.isArray(r.links) || !r.links.length) {
          toast(r.message || 'The AI proposed no links — nothing it could place confidently.', 'ok');
          return;
        }
        await showCorrelateModal(r.links);
      } catch (e) {
        // 503 when the Claude CLI is absent — api.js surfaces the server's message.
        toast(`AI correlate unavailable: ${e.message || e}`, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    async function showCorrelateModal(links) {
      const rows = links.map((l) => {
        const conf = Math.max(0, Math.min(1, Number(l.confidence) || 0));
        const cb = h('input', { type: 'checkbox', checked: conf >= 0.7, style: 'margin-top:3px' });
        const bar = h('div', { style: 'height:6px; width:90px; border-radius:3px; background:var(--panel2); overflow:hidden' },
          h('div', { style: `height:100%; width:${Math.round(conf * 100)}%; background:${conf >= 0.7 ? 'var(--ok, #3fb27f)' : 'var(--warn, #e2a336)'}` }));
        const el = h('label', { style: 'display:flex; gap:10px; align-items:flex-start; padding:8px 4px; border-bottom:1px solid var(--border); cursor:pointer' },
          cb,
          h('div', { style: 'flex:1; min-width:0' },
            h('div', null,
              h('span', { style: 'font-weight:600' }, l.targetName || l.rid || l.workloadUid || '?'),
              ' ', badge(l.workloadUid ? 'k8s workload' : (l.targetType || 'resource')), ' → ',
              h('span', { style: 'font-weight:600' }, l.componentName || l.componentId)),
            l.why ? h('div', { class: 'hint', style: 'margin-top:2px' }, l.why) : null),
          h('div', { style: 'display:flex; flex-direction:column; align-items:flex-end; gap:3px' },
            bar, h('span', { class: 'hint' }, `${Math.round(conf * 100)}%`)));
        return { l, cb, el };
      });
      const res = await modal('AI-proposed links',
        h('div', null,
          h('p', { class: 'hint', style: 'margin-bottom:8px' },
            'Review each proposed link — high-confidence (≥70%) rows are pre-checked. Nothing is written until you apply.'),
          h('div', { style: 'max-height:420px; overflow-y:auto' }, rows.map((r) => r.el))),
        {
          wide: true,
          actions: [{
            label: 'Apply selected', kind: 'btn-primary',
            onClick: async () => {
              const sel = rows.filter((r) => r.cb.checked).map(({ l }) => ({
                ...(l.rid ? { rid: l.rid } : { workloadUid: l.workloadUid }),
                componentId: l.componentId,
              }));
              if (!sel.length) { toast('Nothing selected', 'err'); return undefined; }
              try { return await api.post(`/w/${ws}/ai/correlate/apply`, { links: sel }); }
              catch (e) { toast(`Apply failed: ${e.message || e}`, 'err'); return undefined; }
            },
          }],
        });
      if (!res) return; // cancelled
      const n = res.applied?.length ?? 0;
      const failed = res.errors?.length ?? 0;
      toast(`${n} link${n === 1 ? '' : 's'} applied${failed ? `, ${failed} failed` : ''}`, failed ? 'err' : 'ok');
      graphPromise = loadGraph().then((gs) => { updateCorrelateBtns(); return gs; });
      await graphPromise;
      select(state.id); // refresh badges / canvas / mermaid for the new links
    }

    const toolbar = h('div', { class: 'row', style: 'margin-bottom:12px' },
      title,
      h('span', { class: 'spacer' }),
      makeAiButton({
        label: 'Explain this diagram',
        title: 'Ask the AI what this diagram shows, in DR terms (answer only — nothing is applied)',
        modalTitle: 'Explain this diagram',
        prompt: 'Explain this DR Compass diagram to a disaster-recovery reviewer: what am I looking at, '
          + 'what do the nodes and arrows mean here, and what should I conclude about recovery order and '
          + 'dependencies? The diagram itself is described in the context (its nodes, links, shared '
          + 'infrastructure and Mermaid source). Be concrete about THIS diagram, not about diagrams in general.',
        contextFn: diagramContext,
      }),
      makeAiButton({
        label: 'Weakest link?',
        title: 'Ask the AI which dependency in this picture is the biggest DR risk',
        modalTitle: 'Weakest link in this diagram',
        prompt: 'Looking only at what this diagram shows (see the context), what is the weakest link for '
          + 'disaster recovery? Name the single riskiest node or dependency, say why (single point of failure, '
          + 'unreplicated store, third-party with no failover, shared infrastructure everything depends on), '
          + 'and what you would verify next. If the diagram does not contain enough information, say so '
          + 'rather than guessing.',
        contextFn: diagramContext,
      }),
      // ONE unmistakable action (the thing people came to do with a diagram),
      // and the six export variants behind a disclosure instead of eleven
      // equal-weight buttons in a row. Nothing is removed.
      h('button', { class: 'btn btn-sm btn-primary', onClick: () => copyText(currentSrc(), 'Mermaid source') }, 'Copy Mermaid'),
      h('details', { class: 'adv-inline adv-menu' },
        h('summary', null, 'Export & source'),
        h('div', { class: 'row', style: 'padding:9px 10px' },
          h('button', {
            class: 'btn btn-sm', title: 'Copy a Lucidchart-safe version (no styling directives, flat groups, ASCII labels)',
            onClick: copyForLucid,
          }, 'Copy for Lucidchart'),
          h('button', { class: 'btn btn-sm', onClick: () => dl(`/api/w/${ws}/diagrams/${state.id}/mmd`) }, 'Download .mmd'),
          h('button', {
            class: 'btn btn-sm', title: 'Download the Lucidchart-safe Mermaid source',
            onClick: () => dl(`/api/w/${ws}/diagrams/${state.id}/mmd?flavor=lucid`),
          }, 'Download .mmd (Lucid)'),
          h('button', { class: 'btn btn-sm', onClick: () => dl(`/api/w/${ws}/diagrams/${state.id}/drawio`) }, 'Download .drawio'),
          h('button', {
            class: 'btn btn-sm', onClick: () => {
              const svg = wrap.querySelector('svg');
              if (!svg) { toast('Nothing rendered to download', 'err'); return; }
              const xml = new XMLSerializer().serializeToString(svg);
              dlBlob(new Blob([xml], { type: 'image/svg+xml' }), `${state.id}.svg`);
            },
          }, 'Download .svg'),
          h('button', { class: 'btn btn-sm', onClick: () => select(state.id) }, 'Regenerate'),
          h('button', { class: 'btn btn-sm', onClick: () => { srcPanel.style.display = srcPanel.style.display === 'none' ? '' : 'none'; } }, 'Source'),
          makeDiagramPackBtn())),
      makeCorrelateBtn(),
    );

    const mermaidPane = h('div', null, toolbar, wrap, srcPanel, notesBox);

    // ---------- icon-canvas pane ----------
    const canvasCtl = { ctrl: null, token: 0 };
    let saveTimer = null;
    let lastSaveToast = 0;

    const titleCanvas = h('h2', { style: 'margin:0' }, '');
    const canvasHost = h('div', { class: 'dg-canvas-host' });
    const tmplSelect = h('select', {
      style: 'width:auto',
      onChange: () => {
        const ctrl = canvasCtl.ctrl;
        if (!ctrl) return;
        try { ctrl.setTemplate(tmplSelect.value); } catch (e) { toast(`Template failed: ${e.message || e}`, 'err'); return; }
        scheduleLayoutSave(state.id);
      },
    }, CANVAS_TEMPLATES.map(([v, label]) => h('option', { value: v }, label)));

    function destroyCanvas() {
      clearTimeout(saveTimer); saveTimer = null;
      try { canvasCtl.ctrl?.destroy?.(); } catch { /* engine cleanup is best-effort */ }
      canvasCtl.ctrl = null;
      canvasCtl.expandComponent = null;
      canvasCtl.dependencyFacts = null;
      canvasCtl.labels = null;
      setNodeAiEnabled(false);
    }

    function scheduleLayoutSave(id) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const ctrl = canvasCtl.ctrl;
        if (!ctrl || state.id !== id) return;
        try {
          const body = {
            positions: ctrl.getPositions(),
            template: ctrl.getTemplate?.() || tmplSelect.value,
          };
          // Additive key: which nodes are expanded. Older layouts routes
          // simply ignore unknown body keys — backward compatible.
          try {
            const es = ctrl.getExpandedState?.();
            if (es !== undefined && es !== null) body.expandedState = es;
          } catch { /* engine without expansion support */ }
          await api.put(`/w/${ws}/layouts/${id}`, body);
          if (Date.now() - lastSaveToast > 15000) { lastSaveToast = Date.now(); toast('Layout saved', 'ok'); }
        } catch (e) { toast(`Layout not saved: ${e.message}`, 'err'); }
      }, 800);
    }

    // Saved expandedState may be an array of node ids or an {id: truthy} map.
    function expandedIdsFrom(es) {
      if (Array.isArray(es)) return es.map(String);
      if (es && typeof es === 'object') return Object.keys(es).filter((k) => es[k]);
      return [];
    }

    // node -> componentId whose resource subgraph should be expanded.
    function resolveComponentId(node) {
      const id = String(node?.id ?? '');
      if (id.startsWith('cmp_')) return id;
      if (id.startsWith('rec_cmp_')) return id.slice('rec_'.length);
      return node?.componentId ? String(node.componentId) : null;
    }

    function canvasFail(e) {
      destroyCanvas();
      canvasHost.innerHTML = '';
      canvasHost.append(h('div', { style: 'padding:22px' },
        h('h3', { style: 'margin-bottom:6px' }, 'Icon canvas engine unavailable'),
        h('p', { class: 'hint', style: 'margin-bottom:6px' },
          'The icon-canvas module could not be loaded — it may not be installed yet. The Mermaid view still works.'),
        h('p', { class: 'hint', style: 'color:var(--err)' }, String(e?.message || e))));
      toast('Icon canvas unavailable — showing Mermaid view', 'err');
      setMode('mermaid', { persist: false });
    }

    async function mountCanvas() {
      const my = ++canvasCtl.token;
      destroyCanvas();
      const id = state.id;
      canvasHost.innerHTML = '';
      canvasHost.append(h('div', { class: 'loading' }, 'Loading icon canvas…'));
      let mod;
      try { mod = await import('../diagram-canvas.js'); }
      catch (e) { if (my === canvasCtl.token) canvasFail(e); return; }
      try {
        const data = await api.get(`/w/${ws}/diagrams/${id}/canvas`);
        let saved = null;
        try { saved = await api.get(`/w/${ws}/layouts/${id}`); } catch { /* no saved layout yet */ }
        const gs = await graphPromise; // resolved once per page visit
        if (my !== canvasCtl.token || state.id !== id) return;
        canvasHost.innerHTML = '';
        const template = saved?.template || 'category-grid';

        // --- in-diagram expansion state (per canvas mount / diagram view) ---
        const engineCanExpand = typeof mod.graphToCanvasNodes === 'function';
        const subgraphCache = new Map(); // componentId -> Promise<subgraph>
        const idRefs = new Map();        // canvas node id -> refcount (base + injections)
        for (const n of (Array.isArray(data?.nodes) ? data.nodes : [])) idRefs.set(String(n?.id), 1);
        const injectedByParent = new Map(); // parent node id -> [injected ids]
        let ctrlRef = null;

        function fetchSubgraph(cid) {
          if (!subgraphCache.has(cid)) {
            subgraphCache.set(cid,
              api.get(`/w/${ws}/resources/graph?componentId=${encodeURIComponent(cid)}`)
                .catch((e) => { subgraphCache.delete(cid); throw e; }));
          }
          return subgraphCache.get(cid);
        }

        // ⊕ expand (or ⊖ collapse) the resource associations behind a node.
        async function expandOnCanvas(node, { silent = false, save = true } = {}) {
          const ctrl = ctrlRef;
          const nodeId = String(node?.id ?? '');
          if (!ctrl || typeof ctrl.expandNode !== 'function' || !engineCanExpand) return false;
          const cid = resolveComponentId(node);
          if (!cid) { if (!silent) toast('No inventory component behind this node', 'err'); return false; }
          if (typeof ctrl.isExpanded === 'function' && ctrl.isExpanded(nodeId)) {
            if (silent) return true; // re-expansion pass: already expanded
            try { ctrl.collapseNode?.(nodeId); } catch { /* engine handles its own state */ }
            for (const iid of injectedByParent.get(nodeId) || []) {
              const c = (idRefs.get(iid) || 1) - 1;
              if (c <= 0) idRefs.delete(iid); else idRefs.set(iid, c);
            }
            injectedByParent.delete(nodeId);
            if (save) scheduleLayoutSave(id);
            return true;
          }
          let sub;
          try { sub = await fetchSubgraph(cid); }
          catch (e) { if (!silent) toast(`Associations unavailable: ${e.message || e}`, 'err'); return false; }
          if (ctrlRef !== ctrl || my !== canvasCtl.token) return false; // canvas replaced mid-fetch
          let converted;
          try { converted = mod.graphToCanvasNodes(sub, nodeId, new Set(idRefs.keys())); }
          catch (e) { if (!silent) toast(`Could not build the resource view: ${e.message || e}`, 'err'); return false; }
          const newNodes = Array.isArray(converted?.nodes) ? converted.nodes : [];
          if (!newNodes.length) {
            if (!silent) toast('No discovered resources for this component yet — try Enrich from AWS in its panel', 'err');
            return false;
          }
          try { ctrl.expandNode(nodeId, { nodes: newNodes, edges: Array.isArray(converted?.edges) ? converted.edges : [] }); }
          catch (e) { if (!silent) toast(`Expand failed: ${e.message || e}`, 'err'); return false; }
          const ids = newNodes.map((n) => String(n?.id));
          injectedByParent.set(nodeId, ids);
          for (const iid of ids) idRefs.set(iid, (idRefs.get(iid) || 0) + 1);
          if (save) scheduleLayoutSave(id);
          return true;
        }

        const activeMeta = list.find((x) => x.id === id) || {};
        const ctrl = await mod.createCanvas(canvasHost, {
          data,
          positions: saved?.positions || null,
          template,
          readOnly: false,
          onChange: () => scheduleLayoutSave(id),
          onNodeClick: (node) => openPanel(node),
          nodeBadges: gs.badges,
          // Additive opts — an older engine ignores anything it does not know.
          title: data?.meta?.name || activeMeta.name || state.name || id,
          subtitle: [activeMeta.description, data?.meta?.truncated ? data.meta.note : '']
            .filter(Boolean).join(' · '),
          view: getCanvasView(id) || undefined,
          onViewChange: (v) => setCanvasView(id, v),
          onSelect: (node) => setNodeAiEnabled(!!node),
          // Engine contract (may not have landed yet — extra opts are ignored
          // by older engines): ⊕/⊖ affordances on expandable nodes.
          expandableIds: engineCanExpand && gs.expandableIds ? gs.expandableIds : undefined,
          onExpandRequest: (node) => { expandOnCanvas(node); },
        });
        if (my !== canvasCtl.token || state.id !== id) { try { ctrl?.destroy?.(); } catch { } return; }
        ctrlRef = ctrl;
        canvasCtl.ctrl = ctrl;
        canvasCtl.labels = new Map((Array.isArray(data?.nodes) ? data.nodes : [])
          .map((n) => [String(n?.id), String(n?.label ?? n?.id ?? '')]));
        tmplSelect.value = ctrl?.getTemplate?.() || template;

        // Dependency facts for the node-level AI action (pure function in the
        // layout module; guarded because an older engine may not export it).
        canvasCtl.dependencyFacts = (nodeId) => {
          try {
            if (typeof mod.dependencyFacts !== 'function') return null;
            const f = mod.dependencyFacts(data, String(nodeId));
            const nameOf = (nid) => (Array.isArray(data?.nodes)
              ? (data.nodes.find((n) => String(n?.id) === String(nid))?.label || nid) : nid);
            return {
              dependsOn: f.dependsOn.map(nameOf),
              dependedOnBy: f.dependents.map(nameOf),
              outboundCalls: f.outbound.map(nameOf),
              blastRadiusCount: f.blastRadius.length,
              blastRadius: f.blastRadius.slice(0, 24).map(nameOf),
            };
          } catch { return null; }
        };

        // Panel → canvas bridge: expand a component's associations by id.
        canvasCtl.expandComponent = (engineCanExpand && typeof ctrl?.expandNode === 'function')
          ? (componentId) => {
              const cid = String(componentId || '');
              const nid = idRefs.has(cid) ? cid : (idRefs.has(`rec_${cid}`) ? `rec_${cid}` : null);
              if (!nid) { toast('That component is not on this diagram', 'err'); return; }
              const node = (Array.isArray(data?.nodes) ? data.nodes : []).find((n) => String(n?.id) === nid)
                || { id: nid, componentId: cid };
              expandOnCanvas(node);
            }
          : null;

        // Re-expand persisted nodes BEFORE re-applying saved positions so
        // injected-node positions stick (engine-dependent; all guarded).
        const savedExpanded = expandedIdsFrom(saved?.expandedState);
        if (savedExpanded.length && engineCanExpand && typeof ctrl?.expandNode === 'function') {
          const baseNodes = Array.isArray(data?.nodes) ? data.nodes : [];
          for (const nodeId of savedExpanded) {
            if (my !== canvasCtl.token || state.id !== id) return;
            const node = baseNodes.find((n) => String(n?.id) === nodeId) || { id: nodeId };
            try { await expandOnCanvas(node, { silent: true, save: false }); }
            catch { /* stale id / graph changed — skip */ }
          }
          if (my !== canvasCtl.token || state.id !== id) return;
          try {
            if (saved?.positions && typeof ctrl.setPositions === 'function') ctrl.setPositions(saved.positions);
            ctrl.fit?.();
          } catch { /* older engine — auto-layout for injected nodes */ }
        }
      } catch (e) {
        if (my === canvasCtl.token) canvasFail(e);
      }
    }

    // Enabled only while a node is selected on the canvas.
    const nodeAiBtn = makeAiButton({
      label: 'What breaks if this fails?',
      title: 'Select a node on the canvas, then ask the AI what its failure takes down',
      modalTitle: 'What breaks if this fails?',
      prompt: 'The selected node (see context.extra.selectedNode) has failed in the primary region. Walk '
        + 'through the blast radius: what stops working immediately, what degrades, which restore layers are '
        + 'blocked, and what the recovery order implies. Use only the dependency facts provided — do not '
        + 'invent RTO/RPO numbers.',
      contextFn: selectedNodeContext,
      ref: nodeAiRef,
      startDisabled: true,
    });

    const canvasToolbar = h('div', { class: 'row', style: 'margin-bottom:12px' },
      titleCanvas,
      h('span', { class: 'spacer' }),
      nodeAiBtn,
      makeCorrelateBtn(),
      tmplSelect,
      h('button', {
        class: 'btn btn-sm', onClick: async () => {
          if (!await confirmDialog('Reset this diagram’s saved layout? Nodes return to the automatic arrangement.')) return;
          try { await api.del(`/w/${ws}/layouts/${state.id}`); } catch { /* nothing saved yet */ }
          try { canvasCtl.ctrl?.resetLayout?.(); } catch { }
          toast('Layout reset', 'ok');
        },
      }, 'Reset layout'),
      h('button', {
        class: 'btn btn-sm', onClick: async () => {
          if (!canvasCtl.ctrl?.exportSvg) { toast('Nothing rendered to download', 'err'); return; }
          let svg;
          // exportSvg is async (icons are inlined as data URIs) — awaiting it is
          // what makes the downloaded file real SVG rather than "[object Promise]".
          try { svg = await canvasCtl.ctrl.exportSvg(); }
          catch (e) { toast(`SVG export failed: ${e.message || e}`, 'err'); return; }
          if (!svg) { toast('Nothing rendered to download', 'err'); return; }
          dlBlob(new Blob([svg], { type: 'image/svg+xml' }), `${state.id}-icons.svg`);
        },
      }, 'Download SVG'),
      h('button', {
        class: 'btn btn-sm', onClick: async () => {
          if (!canvasCtl.ctrl?.exportPng) { toast('Nothing rendered to download', 'err'); return; }
          try { dlBlob(await canvasCtl.ctrl.exportPng(2), `${state.id}-icons.png`); }
          catch (e) { toast(`PNG export failed: ${e.message || e}`, 'err'); }
        },
      }, 'Download PNG'),
      h('button', { class: 'btn btn-sm', onClick: () => dl(`/api/w/${ws}/diagrams/${state.id}/drawio?style=aws`) }, 'Download draw.io (AWS shapes)'),
    );

    const canvasPane = h('div', { style: 'display:none' },
      canvasToolbar,
      canvasHost,
      h('p', { class: 'hint', style: 'margin-top:8px' },
        'Drag nodes to arrange — connections follow. Your layout is saved per diagram; Reset restores the auto-layout.'));

    // ---------- view toggle ----------
    const segMermaid = h('button', { onClick: () => setMode('mermaid') }, 'Mermaid');
    const segCanvas = h('button', { onClick: () => setMode('icons') }, 'Icon canvas');
    const viewRow = h('div', { class: 'row', style: 'margin-bottom:12px; display:none' },
      h('div', { class: 'dg-seg' }, segMermaid, segCanvas),
      h('span', { class: 'hint' }, 'Icon canvas: draggable AWS-style icon diagram'));

    function setMode(mode, { persist = true } = {}) {
      if (mode === 'icons' && !state.canvas) mode = 'mermaid';
      state.mode = mode;
      segMermaid.classList.toggle('active', mode === 'mermaid');
      segCanvas.classList.toggle('active', mode === 'icons');
      mermaidPane.style.display = mode === 'mermaid' ? '' : 'none';
      canvasPane.style.display = mode === 'icons' ? '' : 'none';
      if (persist && state.canvas) setViewPref(state.id, mode);
      if (mode === 'icons') mountCanvas();
      else destroyCanvas();
    }

    async function select(id, { refetch = true } = {}) {
      if (refetch) {
        try {
          const d = await api.get(`/w/${ws}/diagrams/${id}`);
          state.id = d.id; state.name = d.name; state.serverSrc = d.mermaid; state.edited = false;
          title.textContent = d.name;
          titleCanvas.textContent = d.name;
          srcArea.value = d.mermaid;
          notesBox.innerHTML = '';
          if (d.notes) notesBox.append(markdown(d.notes));
        } catch (e) { toast(e.message, 'err'); return; }
      }
      state.canvas = !!list.find((x) => x.id === state.id)?.canvas;
      viewRow.style.display = state.canvas ? '' : 'none';
      // Prefer icons when the user chose it before, or when the diagram is
      // canvas-only (no mermaid source — e.g. resource maps).
      setMode(state.canvas && (getViewPref(state.id) === 'icons' || !state.serverSrc) ? 'icons' : 'mermaid', { persist: false });
      let activeBtn = null;
      listBox.querySelectorAll('.dg-item').forEach((b) => {
        const on = b.dataset.id === state.id;
        b.classList.toggle('active', on);
        if (on) activeBtn = b;
      });
      // Make sure the active row is actually reachable: open its group and, in a
      // scrolling group, bring it into view.
      if (activeBtn) {
        const det = activeBtn.closest('details');
        if (det && !det.open) det.open = true;
        const scroller = activeBtn.closest('.dg-grp-body');
        if (scroller) {
          const top = activeBtn.offsetTop - scroller.offsetTop;
          if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 40) {
            scroller.scrollTop = Math.max(0, top - 60);
          }
        }
      }
      setLastDiagram(state.id);
      // Warm the AI's structural facts, but only when an AI module actually
      // exists — otherwise this costs a request nobody asked for.
      if (list.find((x) => x.id === state.id)?.canvas) {
        aiReady().then((mod) => { if (mod) prefetchCanvasFacts(state.id); }).catch(() => {});
      }
      updateCorrelateBtns();
      history.replaceState(null, '', `#/${ws}/diagrams/${state.id}`);
      await draw(currentSrc());
    }

    // ---------- left pane: picker that scales to 53+ diagrams ----------
    // Grouped by PURPOSE, each group counted, searchable across everything, with
    // the long per-component lists behind a disclosure. Capability is explicit:
    // 'canvas' = has an icon-canvas view, 'mermaid only' = Mermaid-capable only.
    // Only the EXCEPTION is marked. A badge on all 53 rows was wallpaper; the
    // fact worth knowing before you click is "this one has no icon view".
    const capBadge = (d) => (d.canvas
      ? null
      : h('span', { class: 'dg-cap dg-cap-mmd', title: 'Mermaid only — no icon-canvas view' }, 'mermaid'));

    const item = (d) => h('button', {
      class: 'dg-item', 'data-id': d.id, 'data-search': `${d.name} ${d.description || ''} ${d.id}`.toLowerCase(),
      title: d.description || d.name,
      onClick: () => select(d.id),
    },
    h('span', { class: 'dg-item-head' }, h('span', { class: 'dg-item-name' }, d.name), capBadge(d)),
    d.description ? h('span', { class: 'dg-desc' }, d.description) : null);

    // Overview splits into "the estate" and "failover story" so the six
    // top-level diagrams stop reading as one undifferentiated block.
    const ESTATE_IDS = ['architecture', 'dependencies', 'restore-layers'];
    const estate = overview.filter((d) => ESTATE_IDS.includes(d.id));
    const failover = overview.filter((d) => !ESTATE_IDS.includes(d.id));

    const groupDefs = [
      {
        key: 'estate', title: 'The estate', open: true, scroll: false,
        hint: 'What exists and what depends on what.',
        items: estate,
      },
      {
        key: 'failover', title: 'Failover story', open: true, scroll: false,
        hint: 'Sequence, region pair, and where data does (not) replicate.',
        items: failover,
      },
      {
        key: 'rmap', title: 'Resource map', open: false, scroll: false,
        hint: 'Discovered AWS resources and their associations.',
        items: rmapMain,
        empty: h('p', { class: 'dg-grp-empty' },
          'No resource graph yet — run ', h('a', { href: `#/${ws}/discover/aws` }, 'Discover → AWS → Deep enrichment'), '.'),
      },
      {
        key: 'rmapComp', title: 'Resource map — per component', open: false, scroll: true,
        hint: 'The 2-hop subgraph around one component.',
        items: rmapPerComp,
      },
      {
        key: 'k8s', title: 'Kubernetes', open: false, scroll: true,
        hint: 'From the captured cluster snapshot.',
        items: k8sList,
        empty: h('p', { class: 'dg-grp-empty' },
          'No snapshot yet — ', h('a', { href: `#/${ws}/discover/k8s` }, 'capture one in Discover'), '.'),
      },
      {
        key: 'perComp', title: 'Component dependencies', open: false, scroll: true,
        hint: 'Neighborhood view: upstream deps, dependents, outbound calls.',
        items: perComp,
        empty: empty('No components yet — add some in Inventory.'),
      },
    ].filter((g) => g.items.length || g.empty);

    const groupEls = [];
    for (const g of groupDefs) {
      const body = h('div', { class: g.scroll ? 'dg-grp-body' : '' },
        g.items.length ? g.items.map(item) : (g.empty || null));
      const countEl = h('span', { class: 'dg-grp-n' }, String(g.items.length));
      const det = h('details', { class: 'dg-grp', open: g.open ? '' : null },
        h('summary', { class: 'dg-grp-head' },
          h('h3', null, g.title), countEl, h('span', { class: 'dg-grp-chev' }, '▶')),
        g.hint ? h('p', { class: 'dg-grp-hint' }, g.hint) : null,
        body);
      groupEls.push({ def: g, det, body, countEl });
    }

    const pickerCount = h('span', { class: 'dg-pick-count' }, `${list.length} diagrams`);
    const pickerSearch = h('input', {
      type: 'search', placeholder: 'Search all diagrams…',
      title: 'Filters every group at once; groups with matches open automatically',
      onInput: () => applyPickerFilter(),
    });

    function applyPickerFilter() {
      const q = pickerSearch.value.trim().toLowerCase();
      let shown = 0;
      for (const { def, det, body, countEl } of groupEls) {
        let visible = 0;
        body.querySelectorAll('.dg-item').forEach((b) => {
          const hit = !q || (b.dataset.search || '').includes(q);
          b.style.display = hit ? '' : 'none';
          if (hit) visible++;
        });
        countEl.textContent = q ? `${visible}/${def.items.length}` : String(def.items.length);
        // Hide a group entirely when nothing in it matches; open the ones that do.
        det.style.display = q && !visible ? 'none' : '';
        if (q) det.open = visible > 0;
        else if (!det.dataset.userToggled) det.open = !!def.open;
        shown += visible;
      }
      pickerCount.textContent = q ? `${shown} of ${list.length}` : `${list.length} diagrams`;
    }
    for (const { det } of groupEls) {
      det.addEventListener('toggle', () => { det.dataset.userToggled = '1'; });
    }

    const listBox = h('div', null,
      card(
        h('div', { class: 'dg-pick-head' }, pickerSearch, pickerCount),
        groupEls.map((g) => g.det),
      ),
      // Reference documentation that used to sit permanently open in the rail of
      // a page you came to in order to look at a picture. Same words, one click.
      h('details', { class: 'card adv-inline', style: 'margin-top:14px' },
        h('summary', null, 'Use with Lucidchart / draw.io'),
        h('div', { style: 'padding-top:10px' },
          h('ul', { style: 'margin:0 0 10px 18px; font-size:12.5px; color:var(--muted)' },
            h('li', null, 'Lucidchart: Insert → Diagram as code → Mermaid, then paste the copied Mermaid source.'),
            h('li', null, 'draw.io: download the .drawio file and open it at ', h('a', { href: 'https://app.diagrams.net', target: '_blank', rel: 'noopener' }, 'app.diagrams.net'), ' (File → Open from → Device). The AWS-shapes variant uses the official mxgraph AWS icon library.'),
            h('li', null, 'If you run a Lucidchart MCP server alongside your AI CLI, ask it to import this Mermaid source.')),
          h('pre', { style: 'font-size:11.5px; white-space:pre-wrap' }, EXAMPLE_PROMPT),
          h('button', { class: 'btn btn-sm', onClick: () => copyText(EXAMPLE_PROMPT, 'Example prompt') }, 'Copy example prompt'))),
    );

    // ---------- assemble ----------
    el.append(
      h('style', null, STYLE),
      pageHead({
        title: 'Diagrams',
        purpose: 'See how your inventory actually connects, and export the picture for a review or a doc.',
        crumb: crumbFor('diagrams', ws),
      }),
      h('div', { class: 'dg-layout' },
        listBox,
        card(viewRow, mermaidPane, canvasPane)),
    );

    // Deep link wins, then the last diagram this workspace was looking at, then
    // the architecture overview.
    const wanted = params?.[0];
    const remembered = getLastDiagram();
    const initial = list.some((d) => d.id === wanted) ? wanted
      : (remembered && list.some((d) => d.id === remembered) ? remembered : 'architecture');
    await select(initial);

    const snap = await snapshot(api, ws).catch(() => ({}));
    el.append(nextStepFor('diagrams', snap, ws));
  },
};
