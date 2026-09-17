// Settings — the facts about this workspace that every other page reads.
import {
  h, card, badge, btn, field, pageHead, cardHead, term, toast, confirmDialog, nextStep,
  humanStrategy, humanTool, toolHelp, fmtMinutes, invalidateSnapshot,
} from '../ui.js';

const STRATEGIES = ['backup-restore', 'pilot-light', 'warm-standby', 'active-active'];
const TOOLING = ['arpio', 'region-switch', 'arc-routing-controls', 'elastic-dr', 'gitops-iac', 'resilience-hub', 'backup'];

export default {
  title: 'Settings',
  async render(el, { ws, api }) {
    const meta = await api.get(`/w/${ws}/workspace`);
    const o = meta.objectives || {};

    const inp = {
      name: h('input', { value: meta.name }),
      org: h('input', { value: meta.org || '' }),
      description: h('textarea', null, meta.description || ''),
      primary: h('input', { value: meta.regions?.primary || '' }),
      recovery: h('input', { value: meta.regions?.recovery || '' }),
      rto: h('input', { type: 'number', min: '0', value: o.rtoMinutes ?? '' }),
      rpo: h('input', { type: 'number', min: '0', value: o.rpoMinutes ?? '' }),
      rta: h('input', { type: 'number', min: '0', value: o.rtaMinutes ?? '' }),
      rpa: h('input', { type: 'number', min: '0', value: o.rpaMinutes ?? '' }),
      approved: h('input', { type: 'checkbox', checked: !!o.approved, style: 'width:auto' }),
      strategy: h('select', null, STRATEGIES.map((s) =>
        h('option', { value: s, selected: meta.strategy === s }, humanStrategy(s)))),
      notes: h('textarea', null, o.notes || ''),
    };
    const toolChecks = TOOLING.map((t) =>
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: (meta.tooling || []).includes(t), 'data-tool': t }),
        h('span', null,
          h('span', { class: 'cr-name' }, term(t, humanTool(t))),
          h('span', { class: 'opt-help' }, toolHelp(t)))));

    // ---------------------------------------------------------------- dirty state
    const savedState = () => JSON.stringify(collect());
    const saveBtn = btn({ label: 'Save changes', kind: 'btn-primary', disabled: true, onClick: () => save() });
    const dirtyNote = h('span', { class: 'hint' }, 'No unsaved changes.');
    const bar = h('div', { class: 'savebar' }, saveBtn, dirtyNote);
    let baseline = '';

    function collect() {
      return {
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
      };
    }

    function checkDirty() {
      const dirty = savedState() !== baseline;
      saveBtn.disabled = !dirty;
      bar.classList.toggle('dirty', dirty);
      dirtyNote.textContent = dirty
        ? 'Unsaved changes — other pages will keep using the old values until you save.'
        : 'No unsaved changes.';
    }

    async function save() {
      try {
        await api.put(`/w/${ws}/workspace`, collect());
        invalidateSnapshot(ws);
        baseline = savedState();
        checkDirty();
        toast('Saved', 'ok');
        window.dispatchEvent(new CustomEvent('drcompass:data-changed'));
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---------------------------------------------------------------- layout
    el.append(
      pageHead({
        title: 'Settings',
        purpose: 'The facts about this workspace that every other page reads: where it runs, where it comes back, what the business agreed to, and what you are recovering with.',
      }),

      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        card(
          cardHead('This workspace'),
          field('Name — the system you are responsible for recovering', inp.name),
          field('Organisation or team (optional)', inp.org),
          field('What is it, in a sentence? (shows up in exports)', inp.description),
          h('div', { class: 'divider' }),
          h('p', { class: 'hint', style: 'margin-bottom:10px' },
            'The pair of regions this plan is about. Changing them does not move anything — it only changes what the plan says.'),
          h('div', { class: 'grid cols-2' },
            field('Primary region — where it runs today', inp.primary),
            field('Recovery region — where it comes back', inp.recovery))),

        card(
          cardHead(h('h2', null, 'Targets and measurements')),
          h('p', { class: 'hint', style: 'margin-bottom:12px' },
            'Two different things that are easy to confuse. ', term('rto'), ' and ', term('rpo'),
            ' are promises the business signs off on. ', term('rta'), ' and ', term('rpa'),
            ' are what a real test measured. Only the measured numbers are evidence.'),
          h('h3', { style: 'margin-bottom:8px' }, 'Targets — what the business agreed to'),
          h('div', { class: 'grid cols-2' },
            field('Longest acceptable outage (minutes)', inp.rto),
            field('Most acceptable data loss (minutes)', inp.rpo)),
          h('label', { class: 'check-row' }, inp.approved,
            h('span', null,
              h('span', { class: 'cr-name' }, 'These targets are approved by the business'),
              h('span', { class: 'opt-help' }, 'Until someone with authority has signed off, targets are engineering guesses. The Overview page labels them as unapproved.'))),
          h('div', { class: 'divider' }),
          h('h3', { style: 'margin-bottom:8px' }, 'Measured — what your last test achieved'),
          h('p', { class: 'hint', style: 'margin-bottom:10px' },
            'Normally written here by the Tests page when you record a run. Edit by hand only to correct a mistake.'),
          h('div', { class: 'grid cols-2' },
            field('Recovery actually took (minutes)', inp.rta),
            field('Data actually lost (minutes)', inp.rpa)),
          h('div', { class: 'row', style: 'gap:8px; margin:-4px 0 12px' },
            badge(`outage: ${fmtMinutes(o.rtaMinutes)} measured vs ${fmtMinutes(o.rtoMinutes)} target`,
              o.rtaMinutes == null || o.rtoMinutes == null ? '' : o.rtaMinutes <= o.rtoMinutes ? 'ok' : 'err'),
            badge(`data loss: ${fmtMinutes(o.rpaMinutes)} measured vs ${fmtMinutes(o.rpoMinutes)} target`,
              o.rpaMinutes == null || o.rpoMinutes == null ? '' : o.rpaMinutes <= o.rpoMinutes ? 'ok' : 'err')),
          field('Notes on how these numbers were agreed or measured', inp.notes)),

        card(
          cardHead('How it comes back'),
          field('Recovery strategy', inp.strategy),
          h('p', { class: 'opt-help', style: 'margin:-6px 0 14px' },
            'Cheapest and slowest at the top, fastest and most expensive at the bottom: ',
            term('backup & restore'), ', ', term('pilot light'), ', ', term('warm standby'), ', ', term('active-active'),
            '. Hover any of them for what it means.'),
          h('div', { class: 'divider' }),
          h('h3', { style: 'margin-bottom:2px' }, 'What you are recovering with'),
          h('p', { class: 'hint', style: 'margin-bottom:6px' }, 'Tick everything actually in play. Runbook templates and exports adapt to this.'),
          ...toolChecks),

        card(
          cardHead('Connections and privacy'),
          h('div', { class: 'stack' },
            h('div', null,
              h('h3', null, 'Your data stays on this machine'),
              h('p', { class: 'opt-help' }, 'Workspaces are plain JSON files in your DR Compass home directory. Nothing is uploaded anywhere.')),
            h('div', null,
              h('h3', null, 'AWS'),
              h('p', { class: 'opt-help' }, 'Discovery uses the AWS CLI credentials and profiles already on this machine, read-only. DR Compass never stores a key.')),
            h('div', null,
              h('h3', null, 'Arpio'),
              h('p', { class: 'opt-help' }, 'A read-only API key is used for the length of one request and never written to disk.')),
            h('div', null,
              h('h3', null, 'AI features'),
              h('p', { class: 'opt-help' }, 'AI runs through the Claude Code CLI (`claude`) installed locally, and nothing is applied to your data until you review and accept it.')),
            h('div', null,
              h('h3', null, 'Lucidchart and draw.io'),
              h('p', { class: 'opt-help' }, 'Export any diagram as Mermaid or draw.io XML from the Diagrams page and paste it in.'))),
          h('div', { class: 'divider' }),
          h('a', { class: 'hint', href: `#/${ws}/discover` }, 'Set up a read-only AWS scan →')),
      ),

      bar,

      nextStep({
        title: 'Targets set?',
        body: 'Targets only mean something once a test has measured the real numbers. That is what turns this page from intentions into evidence.',
        action: { label: 'Go to Tests', href: `#/${ws}/tests` },
        alt: { label: 'Back to Overview', href: `#/${ws}/dashboard` },
      }),

      h('div', { class: 'section-head' }, h('h2', null, 'Danger zone')),
      h('div', { class: 'card danger-zone' },
        h('div', { class: 'row' },
          h('div', { style: 'flex:1; min-width:220px' },
            h('h3', null, 'Delete this workspace'),
            h('p', { class: 'opt-help' },
              'Removes the inventory, runbooks, tests, checklists and every recorded result for ',
              h('strong', null, meta.name), '. This cannot be undone.')),
          btn({
            label: 'Delete workspace', kind: 'btn-danger',
            onClick: async () => {
              const ok = await confirmDialog(`Delete '${meta.name}' and everything in it?`, {
                title: 'Delete workspace',
                confirmLabel: 'Delete permanently',
                detail: 'Every component, runbook, test result and checklist in this workspace is removed from disk. There is no undo and no backup.',
              });
              if (!ok) return;
              try {
                await api.del(`/workspaces/${ws}`);
                invalidateSnapshot(ws);
                toast('Workspace deleted');
                location.hash = '#/';
                location.reload();
              } catch (e) { toast(e.message, 'err'); }
            },
          }))),
    );

    // watch everything for changes
    baseline = savedState();
    checkDirty();
    for (const node of [...Object.values(inp), ...toolChecks.map((c) => c.querySelector('input'))]) {
      node.addEventListener('input', checkDirty);
      node.addEventListener('change', checkDirty);
    }
  },
};
