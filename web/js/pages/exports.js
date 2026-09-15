import { h, card, badge, toast, empty } from '../ui.js';

const SHEETS_PREVIEW = [
  'README', 'Readiness Summary', 'Dependency Inventory', 'Outbound Calls',
  'Secrets Reconciliation', 'Gap List', 'Runbooks', 'Runbook Steps', 'Test Log',
  'App Test Catalog', 'Test Records', 'Checklists', 'Decision Log', 'People',
  'DR Options Matrix', 'Verification Catalog',
];

const CSVS = [
  ['components', 'Dependency inventory'],
  ['outbound-calls', 'Outbound calls'],
  ['secrets', 'Secrets reconciliation'],
  ['gaps', 'Gap list'],
  ['runbook-steps', 'Runbook steps'],
  ['tests', 'Test log'],
  ['checklists', 'Checklists'],
  ['decisions', 'Decision log'],
  ['contacts', 'People / contacts'],
  ['verification-catalog', 'Verification catalog'],
];

function downloadBlob(name, content) {
  const type = name.endsWith('.json') ? 'application/json'
    : name.endsWith('.md') ? 'text/markdown' : 'text/csv';
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

export default {
  title: 'Exports',
  async render(el, { ws, api }) {
    let runbooks = [];
    try { runbooks = (await api.get(`/w/${ws}/c/runbooks`)).items || []; }
    catch { /* runbooks unavailable — show empty state */ }

    const dl = (href, label, kind = '') =>
      h('a', { class: `btn ${kind}`, href }, label);

    // --- 1. Excel workbook ---
    const workbookCard = card(
      h('h2', null, 'Excel workbook'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'The flagship artifact: one styled .xlsx with the full DR picture — inventory, gaps, runbooks, tests, decisions, and the readiness summary. Hand it to leadership or open it directly in Excel or Google Sheets.'),
      h('div', { style: 'margin-bottom:14px' },
        dl(`/api/w/${ws}/export/xlsx`, 'Download workbook (.xlsx)', 'btn-primary')),
      h('div', { class: 'hint', style: 'margin-bottom:6px' }, 'Sheets included (empty sections are skipped):'),
      h('div', { class: 'row', style: 'gap:6px' },
        SHEETS_PREVIEW.map((s) => badge(s))),
    );

    // --- 2. Google Sheets / CSVs ---
    const csvCard = card(
      h('h2', null, 'Google Sheets'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Two ways in: (a) download the workbook above and open it straight in Google Sheets, or (b) download individual CSVs below and use File → Import → Upload in Sheets — the cleanest path when you only want one table.'),
      h('div', { class: 'grid cols-2', style: 'gap:8px' },
        CSVS.map(([id, label]) =>
          h('div', { class: 'row', style: 'justify-content:space-between; gap:8px' },
            h('span', { style: 'font-size:13px' }, label),
            dl(`/api/w/${ws}/export/csv/${id}`, '.csv', 'btn-sm')))),
    );

    // --- 3. Runbooks as markdown ---
    const runbookRows = runbooks.map((rb) =>
      h('div', { class: 'row', style: 'justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--border)' },
        h('div', null,
          h('div', { style: 'font-weight:600; font-size:13px' }, rb.name),
          h('div', { class: 'hint' },
            [rb.scenario, rb.audience].filter(Boolean).join(' · ') || '—')),
        dl(`/api/w/${ws}/export/runbook/${rb.id}.md`, 'Download .md', 'btn-sm')));
    const runbookCard = card(
      h('h2', null, 'Runbooks (markdown)'),
      h('p', { class: 'hint', style: 'margin-bottom:10px' },
        'Each runbook exports as a standalone .md: meta table, preconditions, ordered steps with commands and pass criteria, rollback, and a sign-off table with T0/T1/RTA blanks to fill during execution. Print it or drop it in your wiki.'),
      runbookRows.length ? runbookRows
        : empty('No runbooks yet — create one on the Runbooks page.'),
    );

    // --- 4. Everything bundle ---
    const bundleBtn = h('button', { class: 'btn btn-primary' }, 'Download everything');
    bundleBtn.addEventListener('click', async () => {
      bundleBtn.disabled = true;
      bundleBtn.textContent = 'Preparing…';
      try {
        const bundle = await api.get(`/w/${ws}/export/bundle`);
        const files = bundle.files || [];
        if (!files.length) { toast('Nothing to export yet', 'err'); return; }
        files.forEach((f, i) => setTimeout(() => downloadBlob(f.name, f.content), i * 250));
        toast(`Downloading ${files.length} files`, 'ok');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        bundleBtn.disabled = false;
        bundleBtn.textContent = 'Download everything';
      }
    });
    const bundleCard = card(
      h('h2', null, 'Everything bundle'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'All CSVs, every runbook as markdown, and workspace.json — downloaded as individual files in one go. Your browser may ask permission for multiple downloads.'),
      bundleBtn,
    );

    // --- 5. Diagrams hint ---
    const diagramsCard = card(
      h('h2', null, 'Looking for diagrams?'),
      h('p', { class: 'hint' },
        'Architecture, dependency, and failover-sequence diagrams are exported from the ',
        h('a', { href: `#/${ws}/diagrams` }, 'Diagrams page'),
        ' — as Mermaid source, draw.io XML, or SVG.'),
    );

    el.append(
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, 'Exports'),
          h('div', { class: 'sub' }, 'Turn this workspace into artifacts you can hand to leadership, auditors, and operators'))),
      h('div', { class: 'grid cols-2' },
        workbookCard, csvCard, runbookCard, bundleCard, diagramsCard),
    );
  },
};
