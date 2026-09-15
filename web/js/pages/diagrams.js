import mermaid from '/vendor/mermaid/mermaid.esm.min.mjs';
import { h, card, toast, markdown, empty } from '../ui.js';

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
`;

const EXAMPLE_PROMPT = 'Import this Mermaid diagram into Lucidchart as a new document named '
  + '"DR architecture", then share the edit link with me:\n\n<paste the Mermaid source here>';

export default {
  title: 'Diagrams',
  async render(el, { ws, api, params }) {
    let list;
    try { list = await api.get(`/w/${ws}/diagrams`); }
    catch (e) { el.append(card(h('h2', null, 'Diagrams unavailable'), h('p', { class: 'hint' }, e.message))); return; }
    const overview = list.filter((d) => d.kind !== 'component');
    const perComp = list.filter((d) => d.kind === 'component');

    const state = { id: null, name: '', serverSrc: '', edited: false };

    // ---------- right pane ----------
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

    async function select(id, { refetch = true } = {}) {
      if (refetch) {
        try {
          const d = await api.get(`/w/${ws}/diagrams/${id}`);
          state.id = d.id; state.name = d.name; state.serverSrc = d.mermaid; state.edited = false;
          title.textContent = d.name;
          srcArea.value = d.mermaid;
          notesBox.innerHTML = '';
          if (d.notes) notesBox.append(markdown(d.notes));
        } catch (e) { toast(e.message, 'err'); return; }
      }
      listBox.querySelectorAll('.dg-item').forEach((b) => b.classList.toggle('active', b.dataset.id === state.id));
      history.replaceState(null, '', `#/${ws}/diagrams/${state.id}`);
      await draw(currentSrc());
    }

    const dl = (url) => { const a = h('a', { href: url }); document.body.append(a); a.click(); a.remove(); };
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
          const blob = new Blob([xml], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: `${state.id}.svg` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        },
      }, 'Download .svg'),
      h('button', { class: 'btn btn-sm', onClick: () => select(state.id) }, 'Regenerate'),
      h('button', { class: 'btn btn-sm', onClick: () => { srcPanel.style.display = srcPanel.style.display === 'none' ? '' : 'none'; } }, 'Source'),
    );

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
    const listBox = h('div', null,
      card(
        h('h2', null, 'Overview diagrams'),
        overview.map(item),
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
          h('li', null, 'draw.io: download the .drawio file and open it at ', h('a', { href: 'https://app.diagrams.net', target: '_blank', rel: 'noopener' }, 'app.diagrams.net'), ' (File → Open from → Device).'),
          h('li', null, 'If you run a Lucidchart MCP server alongside your AI CLI, ask it to import this Mermaid source.')),
        h('pre', { style: 'font-size:11.5px; white-space:pre-wrap' }, EXAMPLE_PROMPT),
        h('button', { class: 'btn btn-sm', onClick: () => copyText(EXAMPLE_PROMPT, 'Example prompt') }, 'Copy example prompt')),
    );

    // ---------- assemble ----------
    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Diagrams'),
          h('div', { class: 'sub' }, 'Generated live from your inventory — export as Mermaid, SVG, or draw.io'))),
      h('div', { class: 'dg-layout' },
        listBox,
        card(toolbar, wrap, srcPanel, notesBox)),
    );

    const wanted = params?.[0];
    const initial = list.some((d) => d.id === wanted) ? wanted : 'architecture';
    await select(initial);
  },
};
