import { h, field, toast, confirmDialog, card, badge } from '../ui.js';

const STRATEGIES = ['backup-restore', 'pilot-light', 'warm-standby', 'active-active'];
const TOOLING = ['arpio', 'region-switch', 'arc-routing-controls', 'elastic-dr', 'gitops-iac', 'resilience-hub', 'backup'];

export default {
  title: 'Settings',
  async render(el, { ws, api, navigate }) {
    const meta = await api.get(`/w/${ws}/workspace`);
    const inp = {
      name: h('input', { value: meta.name }),
      org: h('input', { value: meta.org || '' }),
      description: h('textarea', null, meta.description || ''),
      primary: h('input', { value: meta.regions?.primary || '' }),
      recovery: h('input', { value: meta.regions?.recovery || '' }),
      rto: h('input', { type: 'number', value: meta.objectives?.rtoMinutes ?? '' }),
      rpo: h('input', { type: 'number', value: meta.objectives?.rpoMinutes ?? '' }),
      rta: h('input', { type: 'number', value: meta.objectives?.rtaMinutes ?? '' }),
      rpa: h('input', { type: 'number', value: meta.objectives?.rpaMinutes ?? '' }),
      approved: h('input', { type: 'checkbox', checked: !!meta.objectives?.approved, style: 'width:auto' }),
      strategy: h('select', null, STRATEGIES.map((s) => h('option', { value: s, selected: meta.strategy === s }, s))),
      notes: h('textarea', null, meta.objectives?.notes || ''),
    };
    const toolChecks = TOOLING.map((t) =>
      h('label', { class: 'row', style: 'gap:8px; margin:4px 0; cursor:pointer' },
        h('input', { type: 'checkbox', checked: (meta.tooling || []).includes(t), 'data-tool': t, style: 'width:auto' }), t));

    const save = async () => {
      try {
        await api.put(`/w/${ws}/workspace`, {
          name: inp.name.value, org: inp.org.value, description: inp.description.value,
          regions: { primary: inp.primary.value, recovery: inp.recovery.value },
          objectives: {
            rtoMinutes: inp.rto.value === '' ? null : Number(inp.rto.value),
            rpoMinutes: inp.rpo.value === '' ? null : Number(inp.rpo.value),
            rtaMinutes: inp.rta.value === '' ? null : Number(inp.rta.value),
            rpaMinutes: inp.rpa.value === '' ? null : Number(inp.rpa.value),
            approved: inp.approved.checked, notes: inp.notes.value,
          },
          strategy: inp.strategy.value,
          tooling: toolChecks.map((c) => c.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.tool),
        });
        toast('Saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };

    el.append(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'),
        h('div', { class: 'sub' }, 'Workspace identity, objectives, and DR tooling'))),
      h('div', { class: 'grid cols-2' },
        card(h('h2', null, 'Workspace'),
          field('Name', inp.name), field('Organization', inp.org), field('Description', inp.description),
          h('div', { class: 'grid cols-2' }, field('Primary region', inp.primary), field('Recovery region', inp.recovery))),
        card(h('h2', null, 'Objectives'),
          h('p', { class: 'hint', style: 'margin-bottom:10px' },
            'RTO/RPO are targets the business signs off on. RTA/RPA are what your last test actually measured — the only numbers you should quote until targets are approved.'),
          h('div', { class: 'grid cols-2' },
            field('RTO target (min)', inp.rto), field('RPO target (min)', inp.rpo),
            field('RTA achieved (min)', inp.rta), field('RPA achieved (min)', inp.rpa)),
          h('label', { class: 'row', style: 'gap:8px;cursor:pointer' }, inp.approved, 'Objectives approved by the business'),
          field('Notes', inp.notes)),
        card(h('h2', null, 'Strategy & tooling'),
          field('DR strategy', inp.strategy),
          h('div', { class: 'divider' }),
          h('h3', { style: 'margin-bottom:6px' }, 'Tooling in play'), ...toolChecks),
        card(h('h2', null, 'Integrations'),
          h('p', { class: 'hint' }, 'AWS discovery uses your local AWS CLI credentials/profiles — nothing is stored by DR Compass. The Arpio read-only API key is used per-request and never written to disk. AI discovery shells out to your local Claude Code CLI (`claude`).'),
          h('div', { class: 'divider' }),
          h('p', { class: 'hint' }, 'Lucidchart: export any diagram as Mermaid or draw.io XML from the Diagrams page, or paste Mermaid into Lucid directly. If you run a Lucidchart MCP server with your AI CLI, ask it to import the generated Mermaid.')),
      ),
      h('div', { class: 'row', style: 'margin-top:16px' },
        h('button', { class: 'btn btn-primary', onClick: save }, 'Save settings'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-danger', onClick: async () => {
            if (!(await confirmDialog(`Delete workspace '${meta.name}' and all of its data?`))) return;
            await api.del(`/workspaces/${ws}`);
            toast('Workspace deleted');
            location.hash = '#/'; location.reload();
          },
        }, 'Delete workspace')),
    );
  },
};
