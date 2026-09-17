// Settings — the facts about this workspace that every other page reads.
import {
  h, card, btn, field, pageHead, cardHead, term, toast, confirmDialog, snapshot,
  humanStrategy, humanTool, toolHelp, invalidateSnapshot,
} from '../ui.js';
import { crumbFor, nextStepFor } from '../onboarding.js';

const STRATEGIES = ['backup-restore', 'pilot-light', 'warm-standby', 'active-active'];
const TOOLING = ['arpio', 'region-switch', 'arc-routing-controls', 'elastic-dr', 'gitops-iac', 'resilience-hub', 'backup'];

export default {
  title: 'Settings',
  async render(el, { ws, api }) {
    const meta = await api.get(`/w/${ws}/workspace`);
    const o = meta.objectives || {};
    const snap = await snapshot(api, ws).catch(() => ({}));

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
        purpose: 'Set the facts every other page reads: the region pair, the targets the business agreed to, and what you recover with.',
        crumb: crumbFor('settings', ws),
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
            'Only the measured numbers are evidence: ', term('rto'), ' / ', term('rpo'), ' are promises, ',
            term('rta'), ' / ', term('rpa'), ' are results.'),
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
            'Written here by the Tests page. Edit by hand only to correct a mistake.'),
          h('div', { class: 'grid cols-2' },
            field('Recovery actually took (minutes)', inp.rta),
            field('Data actually lost (minutes)', inp.rpa)),
          // The two "measured vs target" badges that used to sit here were
          // computed from the SAVED values at page load, so they went stale the
          // moment you typed in the fields above them. The Overview tiles carry
          // the live comparison.
          field('Notes on how these numbers were agreed or measured', inp.notes)),

        card(
          cardHead('How it comes back'),
          field('Recovery strategy', inp.strategy),
          h('p', { class: 'opt-help', style: 'margin:-6px 0 14px' },
            'Cheapest and slowest first: ',
            term('backup & restore'), ', ', term('pilot light'), ', ', term('warm standby'), ', ', term('active-active'), '.'),
          h('div', { class: 'divider' }),
          h('h3', { style: 'margin-bottom:2px' }, 'What you are recovering with'),
          h('p', { class: 'hint', style: 'margin-bottom:6px' }, 'Runbook templates and exports adapt to what you tick.'),
          ...toolChecks),

        // Five headings of reassurance nobody reads twice, and nothing in it is
        // actionable — but it IS the answer to "does this thing phone home?", so
        // it stays, collapsed, with the whole answer on the closed row.
        card(
          cardHead('Connections and privacy'),
          h('p', { class: 'opt-help' },
            'Everything runs on this machine. Workspaces are plain JSON files in your DR Compass home directory, '
            + 'cloud reads are read-only, and no key is ever written to disk.'),
          h('details', { class: 'adv-inline', style: 'margin-top:10px' },
            h('summary', null, 'Per-integration detail'),
            h('div', { class: 'stack', style: 'padding:10px 2px 2px' },
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
                h('p', { class: 'opt-help' }, 'Export any diagram as Mermaid or draw.io XML from the Diagrams page and paste it in.')))),
          h('div', { class: 'divider' }),
          h('a', { class: 'hint', href: `#/${ws}/discover` }, 'Set up a read-only AWS scan →')),
      ),

      bar,

      nextStepFor('settings', snap, ws),

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
