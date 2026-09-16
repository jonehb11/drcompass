import mermaid from '/vendor/mermaid/mermaid.esm.min.mjs';
import { h, card, toast, markdown, empty, confirmDialog } from '../ui.js';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
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
  .dg-layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 14px; align-items: start; }
  @media (max-width: 1000px) { .dg-layout { grid-template-columns: 1fr; } }
  .dg-item { display: block; width: 100%; text-align: left; background: none; border: 1px solid transparent;
    border-radius: 8px; padding: 7px 10px; cursor: pointer; color: var(--text); font: 13px var(--sans); }
  .dg-item:hover { background: var(--panel2); }
  .dg-item.active { background: var(--accent-soft); border-color: rgba(79,143,247,.35); }
  .dg-item .dg-desc { display: block; font-size: 11.5px; color: var(--muted); margin-top: 1px; }
  .dg-complist { max-height: 380px; overflow-y: auto; margin-top: 8px; }
  .dg-src textarea { font-family: var(--mono); font-size: 12px; min-height: 220px; white-space: pre; }
  .mermaid-wrap svg { max-width: 100%; height: auto; }
  .dg-err pre { white-space: pre-wrap; }
  .dg-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .dg-seg button { background: none; border: 0; padding: 5px 13px; font: 600 12px var(--sans);
    color: var(--muted); cursor: pointer; }
  .dg-seg button + button { border-left: 1px solid var(--border); }
  .dg-seg button.active { background: var(--accent-soft); color: #bcd4fb; }
  .dg-canvas-host { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
    min-height: 420px; overflow: hidden; position: relative; }
  .dg-canvas-host > .loading { padding-top: 180px; }
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
    const overview = list.filter((d) => d.kind !== 'component' && !isK8s(d));
    const perComp = list.filter((d) => d.kind === 'component');
    const k8sList = list.filter(isK8s);

    // ---------- resource panel + hover badges (lazy, best-effort) ----------
    // One graph fetch for the whole page: count resources per componentId so the
    // canvas tooltip can say 'N linked resources · click for details'.
    const badgesPromise = (async () => {
      try {
        const g = await api.get(`/w/${ws}/resources/graph`);
        const counts = {};
        for (const n of Object.values(g?.nodes || {})) {
          for (const cid of n?.componentIds || []) counts[cid] = (counts[cid] || 0) + 1;
        }
        const badges = {};
        for (const [cid, c] of Object.entries(counts)) {
          badges[cid] = `${c} linked resource${c === 1 ? '' : 's'} · click for details`;
        }
        return Object.keys(badges).length ? badges : null;
      } catch { return null; } // resources backend not available yet — no badges
    })();

    async function openPanel(node) {
      try {
        const mod = await import('../resource-panel.js');
        mod.openResourcePanel({ ws, api, ui, node });
      } catch (e) { toast(`Resource panel unavailable: ${e.message || e}`, 'err'); }
    }

    const state = { id: null, name: '', serverSrc: '', edited: false, canvas: false, mode: 'mermaid' };

    // ---------- view preference (per diagram, localStorage, best-effort) ----------
    const viewKey = (id) => `drcompass.diagramView.${ws}.${id}`;
    const getViewPref = (id) => { try { return localStorage.getItem(viewKey(id)); } catch { return null; } };
    const setViewPref = (id, v) => { try { localStorage.setItem(viewKey(id), v); } catch { /* private mode etc. */ } };

    // ---------- mermaid pane (unchanged behavior) ----------
    const title = h('h2', { style: 'margin:0' }, '');
    const wrap = h('div', { class: 'mermaid-wrap', style: 'min-height:280px' });
    const notesBox = h('div', { style: 'margin-top:12px' });
    const srcArea = h('textarea', { spellcheck: 'false' });
    srcArea.readOnly = true;
    const rerenderBtn = h('button', {
      class: 'btn btn-sm btn-primary', style: 'display:none',
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
      wrap.append(h('div', { class: 'loading' }, 'Rendering…'));
      try {
        const { svg } = await mermaid.render(`dg_svg_${++renderSeq}`, src);
        wrap.innerHTML = svg;
      } catch (e) {
        document.getElementById(`dg_svg_${renderSeq}`)?.remove(); // mermaid's scratch node
        wrap.innerHTML = '';
        wrap.append(h('div', { class: 'dg-err' },
          h('p', { class: 'hint', style: 'color:var(--err); margin-bottom:8px' },
            `Mermaid failed to parse this diagram: ${e.message || e}`),
          h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'The source is shown below — you can still copy or download it.'),
          h('pre', null, src)));
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

    const toolbar = h('div', { class: 'row', style: 'margin-bottom:12px' },
      title,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onClick: () => copyText(currentSrc(), 'Mermaid source') }, 'Copy Mermaid'),
      h('button', { class: 'btn btn-sm', onClick: () => dl(`/api/w/${ws}/diagrams/${state.id}/mmd`) }, 'Download .mmd'),
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
    }

    function scheduleLayoutSave(id) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const ctrl = canvasCtl.ctrl;
        if (!ctrl || state.id !== id) return;
        try {
          await api.put(`/w/${ws}/layouts/${id}`, {
            positions: ctrl.getPositions(),
            template: ctrl.getTemplate?.() || tmplSelect.value,
          });
          if (Date.now() - lastSaveToast > 15000) { lastSaveToast = Date.now(); toast('Layout saved', 'ok'); }
        } catch (e) { toast(`Layout not saved: ${e.message}`, 'err'); }
      }, 800);
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
        const nodeBadges = await badgesPromise; // resolved once per page visit
        if (my !== canvasCtl.token || state.id !== id) return;
        canvasHost.innerHTML = '';
        const template = saved?.template || 'category-grid';
        const ctrl = await mod.createCanvas(canvasHost, {
          data,
          positions: saved?.positions || null,
          template,
          readOnly: false,
          onChange: () => scheduleLayoutSave(id),
          onNodeClick: (node) => openPanel(node),
          nodeBadges,
        });
        if (my !== canvasCtl.token || state.id !== id) { try { ctrl?.destroy?.(); } catch { } return; }
        canvasCtl.ctrl = ctrl;
        tmplSelect.value = ctrl?.getTemplate?.() || template;
      } catch (e) {
        if (my === canvasCtl.token) canvasFail(e);
      }
    }

    const canvasToolbar = h('div', { class: 'row', style: 'margin-bottom:12px' },
      titleCanvas,
      h('span', { class: 'spacer' }),
      tmplSelect,
      h('button', { class: 'btn btn-sm', onClick: () => { try { canvasCtl.ctrl?.fit?.(); } catch { } } }, 'Fit'),
      h('button', {
        class: 'btn btn-sm', onClick: async () => {
          if (!await confirmDialog('Reset this diagram’s saved layout? Nodes return to the automatic arrangement.')) return;
          try { await api.del(`/w/${ws}/layouts/${state.id}`); } catch { /* nothing saved yet */ }
          try { canvasCtl.ctrl?.resetLayout?.(); } catch { }
          toast('Layout reset', 'ok');
        },
      }, 'Reset layout'),
      h('button', {
        class: 'btn btn-sm', onClick: () => {
          let svg;
          try { svg = canvasCtl.ctrl?.exportSvg?.(); } catch (e) { toast(`SVG export failed: ${e.message || e}`, 'err'); return; }
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
      setMode(state.canvas && getViewPref(state.id) === 'icons' ? 'icons' : 'mermaid', { persist: false });
      listBox.querySelectorAll('.dg-item').forEach((b) => b.classList.toggle('active', b.dataset.id === state.id));
      history.replaceState(null, '', `#/${ws}/diagrams/${state.id}`);
      await draw(currentSrc());
    }

    // ---------- left pane ----------
    const item = (d) => h('button', { class: 'dg-item', 'data-id': d.id, onClick: () => select(d.id) },
      d.name, d.description ? h('span', { class: 'dg-desc' }, d.description) : null);

    const compBox = h('div', { class: 'dg-complist' }, perComp.map(item));
    const search = h('input', {
      placeholder: 'Filter components…',
      onInput: () => {
        const q = search.value.trim().toLowerCase();
        compBox.querySelectorAll('.dg-item').forEach((b) => {
          b.style.display = !q || b.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      },
    });
    const k8sGroup = k8sList.length
      ? [
          h('h3', { style: 'margin-bottom:6px' }, 'Kubernetes'),
          h('p', { class: 'hint', style: 'margin-bottom:6px' }, 'From the captured cluster snapshot.'),
          k8sList.map(item),
        ]
      : [
          h('h3', { style: 'margin-bottom:6px' }, 'Kubernetes'),
          h('p', { class: 'hint', style: 'margin-bottom:6px' },
            'No snapshot yet — ',
            h('a', { href: `#/${ws}/discover/k8s` }, 'capture one in Discover'), '.'),
        ];

    const listBox = h('div', null,
      card(
        h('h2', null, 'Overview diagrams'),
        overview.map(item),
        h('div', { class: 'divider' }),
        k8sGroup,
        h('div', { class: 'divider' }),
        h('h3', { style: 'margin-bottom:6px' }, 'Component dependencies'),
        h('p', { class: 'hint', style: 'margin-bottom:6px' }, 'Neighborhood view: upstream deps, dependents, outbound calls.'),
        search,
        perComp.length ? compBox : empty('No components yet — add some in Inventory.'),
      ),
      h('div', { class: 'card', style: 'margin-top:14px' },
        h('h2', null, 'Use with Lucidchart / draw.io'),
        h('ul', { style: 'margin:0 0 10px 18px; font-size:12.5px; color:var(--muted)' },
          h('li', null, 'Lucidchart: Insert → Diagram as code → Mermaid, then paste the copied Mermaid source.'),
          h('li', null, 'draw.io: download the .drawio file and open it at ', h('a', { href: 'https://app.diagrams.net', target: '_blank', rel: 'noopener' }, 'app.diagrams.net'), ' (File → Open from → Device). The AWS-shapes variant uses the official mxgraph AWS icon library.'),
          h('li', null, 'If you run a Lucidchart MCP server alongside your AI CLI, ask it to import this Mermaid source.')),
        h('pre', { style: 'font-size:11.5px; white-space:pre-wrap' }, EXAMPLE_PROMPT),
        h('button', { class: 'btn btn-sm', onClick: () => copyText(EXAMPLE_PROMPT, 'Example prompt') }, 'Copy example prompt')),
    );

    // ---------- assemble ----------
    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Diagrams'),
          h('div', { class: 'sub' }, 'Generated live from your inventory — export as Mermaid, SVG, PNG, or draw.io'))),
      h('div', { class: 'dg-layout' },
        listBox,
        card(viewRow, mermaidPane, canvasPane)),
    );

    const wanted = params?.[0];
    const initial = list.some((d) => d.id === wanted) ? wanted : 'architecture';
    await select(initial);
  },
};
