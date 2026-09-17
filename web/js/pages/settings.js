// Settings — the facts about this workspace that every other page reads.
import {
  h, card, btn, badge, field, pageHead, cardHead, term, toast, confirmDialog, snapshot,
  humanStrategy, humanTool, toolHelp, invalidateSnapshot, fmtMinutes, fmtDate,
} from '../ui.js';
import { crumbFor, nextStepFor } from '../onboarding.js';
import { measuredNumbers, describe } from '../measured.js';

const STRATEGIES = ['backup-restore', 'pilot-light', 'warm-standby', 'active-active'];
const TOOLING = ['arpio', 'region-switch', 'arc-routing-controls', 'elastic-dr', 'gitops-iac', 'resilience-hub', 'backup'];

/**
 * One unmistakable row per number: where the SAVED value came from, and
 * whether a passed test says something different. The badges that used to live
 * here read "47 min measured vs 60 min target" in green off a hand-typed
 * field — the exact claim this card must never make again.
 */
function provenanceRow(slot, { label, unit, ws }) {
  const d = describe(slot, { targetMinutes: null, unit });
  const kids = [badge(d.badge, d.badgeTone), h('span', null, h('strong', null, label), ' ')];

  if (slot.state === 'measured') {
    const t = slot.test || {};
    kids.push(h('span', null,
      `${fmtMinutes(slot.minutes)} — from `,
      h('a', { href: `#/${ws}/tests/${t.id}` }, t.name || 'the test'),
      `${t.date ? ` (${fmtDate(t.date)})` : ''}, recorded as passed.`));
    if (slot.conflictsWithTyped) {
      kids.push(h('div', { class: 'hint', style: 'margin-top:3px' },
        h('strong', null, 'These disagree: '),
        `the box above says ${fmtMinutes(slot.typedMinutes)}, the passed test measured ${fmtMinutes(slot.minutes)}. `
        + 'Every export and the Overview quote the test.'));
    }
  } else if (slot.state === 'declared') {
    kids.push(h('span', null, `${fmtMinutes(slot.minutes)} — typed here, with no test behind it.`));
    kids.push(h('div', { class: 'hint', style: 'margin-top:3px' }, slot.note));
  } else {
    kids.push(h('span', null, 'nothing recorded, and no passed test has measured it.'));
    kids.push(h('div', { class: 'hint', style: 'margin-top:3px' }, slot.note));
  }
  return h('div', { style: 'margin:6px 0;font-size:12.5px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap' },
    kids[0], h('div', { style: 'min-width:0;flex:1' }, ...kids.slice(1)));
}

function provenanceBadges(honest, ws) {
  return h('div', { style: 'margin:4px 0 14px' },
    provenanceRow(honest.rta, { label: 'Recovery time:', unit: 'recovery time', ws }),
    provenanceRow(honest.rpa, { label: 'Data loss:', unit: 'data loss', ws }),
    h('p', { class: 'hint', style: 'margin-top:6px' },
      'Only a number marked ', badge('measured — passed test', 'ok'),
      ' may be quoted as an achievement. ',
      h('a', { href: `#/${ws}/tests` }, 'Record one from a test →')));
}

export default {
  title: 'Settings',
  async render(el, { ws, api }) {
    const meta = await api.get(`/w/${ws}/workspace`);
    const o = meta.objectives || {};
    const snap = await snapshot(api, ws).catch(() => ({}));
    // What these two fields ARE, as opposed to what they claim. Computed from
    // the saved values, which is exactly right here: this card is about the
    // provenance of what is on disk, not about what is half-typed in the box.
    const honest = measuredNumbers(meta, snap.tests || [], null, { components: snap.components || [] });

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
          ...o,
          rtoMinutes: inp.rto.value === '' ? null : Number(inp.rto.value),
          rpoMinutes: inp.rpo.value === '' ? null : Number(inp.rpo.value),
          rtaMinutes: inp.rta.value === '' ? null : Number(inp.rta.value),
          rpaMinutes: inp.rpa.value === '' ? null : Number(inp.rpa.value),
          // The link to the test that produced the number survives a save of
          // the other fields, but editing the number by hand breaks it — the
          // edited value is no longer what that test measured.
          rtaTestId: inp.rta.value === String(o.rtaMinutes ?? '') ? (o.rtaTestId || '') : '',
          rpaTestId: inp.rpa.value === String(o.rpaMinutes ?? '') ? (o.rpaTestId || '') : '',
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
            term('rto'), ' / ', term('rpo'), ' are promises. ', term('rta'), ' / ', term('rpa'),
            ' are results — and only count as evidence when a test that passed produced them.'),
          h('h3', { style: 'margin-bottom:8px' }, 'Targets — what the business agreed to'),
          h('div', { class: 'grid cols-2' },
            field('Longest acceptable outage (minutes)', inp.rto),
            field('Most acceptable data loss (minutes)', inp.rpo)),
          h('label', { class: 'check-row' }, inp.approved,
            h('span', null,
              h('span', { class: 'cr-name' }, 'These targets are approved by the business'),
              h('span', { class: 'opt-help' }, 'Until someone with authority has signed off, targets are engineering guesses. The Overview page labels them as unapproved.'))),
          h('div', { class: 'divider' }),
          h('h3', { style: 'margin-bottom:8px' }, 'Recorded by hand'),
          // The one line that stops this card manufacturing evidence: these two
          // boxes are a notebook, not a measurement. The Tests page writes them
          // when you record a run, and typing one here does not make it a result.
          h('p', { class: 'hint', style: 'margin-bottom:10px' },
            'The ', h('a', { href: `#/${ws}/tests` }, 'Tests page'), ' writes these when you record a run, and links them to that test. ',
            h('strong', null, 'Typing a number here does not make it evidence'),
            ' — keep the box for a result measured somewhere DR Compass cannot see, and say where in the notes.'),
          h('div', { class: 'grid cols-2' },
            field('Recovery time recorded (minutes)', inp.rta),
            field('Data loss recorded (minutes)', inp.rpa)),
          // Status of what is SAVED. Never green, never "achieved" — a badge
          // here says where the number came from, and (H-1) whether a passed
          // test disagrees with it.
          provenanceBadges(honest, ws),
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
