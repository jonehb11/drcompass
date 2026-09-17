// Settings — the facts about this workspace that every other page reads.
import {
  h, card, btn, badge, field, pageHead, cardHead, term, toast, confirmDialog, snapshot, modal,
  humanStrategy, humanTool, toolHelp, invalidateSnapshot, fmtMinutes, fmtDate,
  environmentsOf, slugify, envBadge, RESERVED_ENV_SLUGS,
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

/* ===========================================================================
 * ENVIRONMENTS
 * A workspace is one system; an environment is one ACCOUNT that system runs in
 * and is recovered separately. They live in workspace.json (contract §2), so
 * the write path that always exists is `PUT /w/:ws/workspace` — the dedicated
 * routes are preferred when the build has them.
 * ======================================================================== */

/** Which slugs are already taken, plus the words a route could not parse. */
function slugProblem(slug, items, selfId) {
  if (!slug) return 'A short name is required — it appears in every link.';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return 'Use lowercase letters, numbers and dashes.';
  if (RESERVED_ENV_SLUGS.includes(slug)) {
    return `'${slug}' is a reserved word in a DR Compass link — pick another, e.g. '${slug}-env'.`;
  }
  if (items.some((e) => e.slug === slug && e.id !== selfId)) return `Another environment already uses '${slug}'.`;
  return null;
}

async function environmentDialog(existing, items) {
  const e = existing || {};
  const inp = {
    name: h('input', { value: e.name || '', placeholder: 'Production' }),
    slug: h('input', { value: e.slug || '', placeholder: 'prod' }),
    primary: h('input', { value: e.regions?.primary || '', placeholder: 'us-east-1' }),
    recovery: h('input', { value: e.regions?.recovery || '', placeholder: 'us-west-2' }),
    accountId: h('input', { value: e.accountId || '', placeholder: '123456789012' }),
    awsProfile: h('input', { value: e.awsProfile || '', placeholder: 'acme-pharmacy-prod' }),
    kubeContext: h('input', { value: e.kubeContext || '', placeholder: 'arn:aws:eks:…/acme-pharmacy-prod' }),
    isProduction: h('input', { type: 'checkbox', checked: !!e.isProduction, style: 'width:auto' }),
    notes: h('input', { value: e.notes || '', placeholder: 'Anything the next person needs to know' }),
  };
  let slugTouched = !!e.slug;
  inp.slug.addEventListener('input', () => { slugTouched = true; });
  inp.name.addEventListener('input', () => { if (!slugTouched) inp.slug.value = slugify(inp.name.value); });

  const ok = await modal(existing ? `Edit ${e.name || 'environment'}` : 'New environment', h('div', null,
    h('p', { class: 'hint', style: 'margin-bottom:12px' },
      'One environment per account this system runs in. Each is discovered, planned and recovered separately — '
      + 'and the short name becomes part of every link, so a colleague can be sent straight to the right one.'),
    h('div', { class: 'grid cols-2' },
      field('Name', inp.name),
      field('Short name for links (lowercase, no spaces)', inp.slug)),
    h('div', { class: 'grid cols-2' },
      field('Primary region — where it runs today', inp.primary),
      field('Recovery region — where it comes back', inp.recovery)),
    h('div', { class: 'divider' }),
    h('p', { class: 'hint', style: 'margin-bottom:10px' },
      'How DR Compass reads THIS environment. Both are read-only and stay on your machine.'),
    h('div', { class: 'grid cols-2' },
      field('AWS profile that scans it', inp.awsProfile),
      field('kubectl context that snapshots it', inp.kubeContext)),
    h('div', { class: 'grid cols-2' },
      field('AWS account id (informational)', inp.accountId),
      field('Notes', inp.notes)),
    h('label', { class: 'check-row' }, inp.isProduction,
      h('span', null,
        h('span', { class: 'cr-name' }, 'This is production'),
        h('span', { class: 'opt-help' },
          'The switcher turns red and says so whenever this environment is selected. Mark exactly the one that serves real customers.'))),
  ), { wide: true, actions: [{ label: existing ? 'Save environment' : 'Add environment', kind: 'btn-primary', value: true }] });
  if (!ok) return null;

  const name = inp.name.value.trim();
  const slug = slugify(inp.slug.value || name);
  const problem = slugProblem(slug, items, e.id);
  if (!name) { toast('An environment needs a name.', 'err'); return null; }
  if (problem) { toast(problem, 'err'); return null; }
  return {
    ...e,
    name, slug,
    regions: { primary: inp.primary.value.trim(), recovery: inp.recovery.value.trim() },
    accountId: inp.accountId.value.trim(),
    awsProfile: inp.awsProfile.value.trim(),
    kubeContext: inp.kubeContext.value.trim(),
    isProduction: inp.isProduction.checked,
    notes: inp.notes.value.trim(),
  };
}

/* ===========================================================================
 * AI TOOL
 * Every AI feature in DR Compass shells out to a CLI on this machine. Which
 * one is a choice: Claude Code, Cursor, Kiro, Amazon Q, Gemini, Codex, Ollama,
 * or a custom command.
 *
 * The one rule this card exists to enforce: it must never claim a tool works.
 * Only ONE invocation was ever observed working (`claude -p … --output-format
 * text`); every other flag set is a best guess taken from public docs, and
 * those CLIs change. So a provider is shown as confirmed ONLY after the server
 * has actually run a prompt through it on this machine and got an answer back.
 * Everything else says "unverified — run Test", in as many words.
 * ========================================================================= */

const STATUS_BADGE = {
  confirmed: ['confirmed — tested here', 'ok'],
  ok: ['found', 'ok'],
  unconfirmed: ['unverified', 'warn'],
  'not-installed': ['not installed', ''],
  'not-configured': ['not set up', ''],
};

function aiToolCard({ ws, api }) {
  const box = card();
  const list = h('div', { class: 'stack' });
  const result = h('div', { style: 'margin-top:10px' });
  let data = null;
  let chosen = null;          // provider id the radios currently show
  const custom = {
    bin: h('input', { placeholder: 'mytool' }),
    args: h('input', { placeholder: '-p {prompt} --output-format text' }),
    input: h('select', null,
      h('option', { value: 'argv' }, 'On the command line ({prompt})'),
      h('option', { value: 'stdin' }, 'On standard input')),
  };

  const say = (msg, kind) => {
    result.replaceChildren(msg ? h('div', { class: 'hint' }, badge(kind === 'err' ? 'failed' : 'result', kind === 'err' ? 'err' : 'ok'), ' ', msg) : '');
  };

  function selectionBody() {
    if (chosen !== 'custom') return { id: chosen };
    return {
      id: 'custom',
      bin: custom.bin.value.trim(),
      argsTemplate: custom.args.value,
      input: custom.input.value,
    };
  }

  async function save() {
    try {
      const r = await api.put(`/w/${ws}/ai/provider`, selectionBody());
      toast(`AI tool set to ${r.selected?.name || chosen}`);
      await load();
    } catch (e) { say(e.message, 'err'); }
  }

  async function test() {
    say('Running a one-word prompt through it — this can take a few seconds…');
    try {
      const r = await api.post(`/w/${ws}/ai/provider/test`, selectionBody());
      if (r.ok) {
        result.replaceChildren(h('div', { class: 'hint' },
          badge('works', 'ok'), ' ',
          `${r.provider?.name || chosen} answered in ${(r.ms / 1000).toFixed(1)}s. It said: `,
          h('code', null, r.line || '(nothing printed)')));
        await load();
      } else {
        say(r.message || 'It did not answer.', 'err');
      }
    } catch (e) { say(e.message, 'err'); }
  }

  function draw() {
    list.replaceChildren();
    if (!data) { list.append(h('div', { class: 'loading' }, 'Looking for AI CLIs on PATH…')); return; }

    for (const p of data.providers) {
      const [label, tone] = STATUS_BADGE[p.status] || ['unknown', ''];
      const radio = h('input', {
        type: 'radio', name: 'ai-provider', value: p.id,
        ...(chosen === p.id ? { checked: 'checked' } : {}),
        ...(p.status === 'not-installed' ? { disabled: 'disabled' } : {}),
      });
      radio.addEventListener('change', () => { chosen = p.id; draw(); });

      const row = h('label', { class: 'check-row' }, radio,
        h('span', null,
          h('span', { class: 'cr-name' },
            p.name, ' ', badge(label, tone),
            p.version ? h('span', { class: 'opt-help' }, ' ', h('code', null, p.version)) : null),
          h('span', { class: 'opt-help' }, p.statusText),
          p.status === 'unconfirmed'
            ? h('span', { class: 'opt-help' },
              h('strong', null, 'DR Compass has not confirmed this command. '), p.notes)
            : null,
          p.path ? h('span', { class: 'opt-help' }, h('code', null, p.path)) : null));
      list.append(row);

      if (p.id === 'custom' && chosen === 'custom') {
        list.append(h('div', { style: 'padding:2px 0 8px 26px' },
          field('Command', custom.bin),
          field(`Arguments — put ${data.promptToken} where the prompt goes`, custom.args),
          field('Where the prompt goes', custom.input),
          h('p', { class: 'opt-help' },
            'Run ', h('code', null, '<your tool> --help'), ' and copy its one-shot / headless flags in here. '
            + 'In standard-input mode leave the placeholder out entirely.')));
      }
    }

    if (data.envOverride) {
      list.append(h('p', { class: 'hint', style: 'margin-top:8px' },
        badge('env override', 'accent'), ' ',
        h('code', null, 'DRCOMPASS_AI_CLI'), ' is set in this server\'s environment and wins over anything chosen here.'));
    }
  }

  async function load() {
    try {
      data = await api.get(`/w/${ws}/ai/providers`);
      if (!chosen) chosen = data.selected?.id || null;
      const sel = data.selected?.selection;
      if (sel && sel.id === 'custom') {
        if (!custom.bin.value) custom.bin.value = sel.bin || '';
        if (!custom.args.value) custom.args.value = sel.argsTemplate || '';
        custom.input.value = sel.input || 'argv';
      }
    } catch (e) {
      data = { providers: [], promptToken: '{prompt}' };
      say(e.message, 'err');
    }
    draw();
  }

  box.append(
    cardHead(h('h2', null, 'AI tool')),
    h('p', { class: 'hint', style: 'margin-bottom:10px' },
      'Every AI feature here — ask, propose, draft, review, document ingestion, the copilot — shells out to a CLI '
      + 'on this machine, with your account. Pick the one you have installed. Nothing is routed through DR Compass.'),
    h('p', { class: 'opt-help', style: 'margin-bottom:12px' },
      h('strong', null, 'Only the Claude Code command has been confirmed working. '),
      'The flags for the other tools are best guesses from their docs and they change between releases — a tool marked ',
      badge('unverified', 'warn'), ' may simply fail when you use it. Press ', h('strong', null, 'Test'),
      ' first: that runs a real one-word prompt and shows you exactly what came back.'),
    list,
    h('div', { class: 'divider' }),
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
      btn({ label: 'Use this tool', kind: 'btn-primary', onClick: save }),
      btn({ label: 'Test', onClick: test, title: 'Sends "Reply with the single word OK and nothing else." and shows the real answer' })),
    result,
    h('p', { class: 'opt-help', style: 'margin-top:10px' },
      'This choice is saved for this workspace. Without one, DR Compass uses the machine default, and failing that '
      + 'the first known CLI it finds on PATH (preferring ', h('code', null, 'claude'), ').'));

  load();
  return box;
}

export default {
  title: 'Settings',
  async render(el, ctx) {
    const { ws, api } = ctx;
    const wapi = api.raw || api;
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

    // ---------------------------------------------------------------- environments
    let envState = environmentsOf(meta);
    const envCard = card();
    // Every component in the workspace, whatever environment it is in or is
    // not. The scoped snapshot cannot see the ones with no environment at all.
    let allComponents = await wapi.get(`/w/${ws}/c/components`).then((r) => r.items || [], () => []);
    let orphans = allComponents.filter((c) => !c.envId).length;

    /** One write path that always exists, plus the dedicated routes when the
     *  build has them. Either way the workspace is the source of truth. */
    async function saveEnvironments(items, defaultEnvId) {
      const next = items.map((e) => ({ ...e, id: e.id || `env_${slugify(e.slug || e.name) || Math.random().toString(16).slice(2, 8)}` }));
      const dflt = next.some((e) => e.id === defaultEnvId) ? defaultEnvId : (next[0]?.id || null);
      await wapi.put(`/w/${ws}/workspace`, { environments: next, defaultEnvId: dflt });
      envState = environmentsOf({ environments: next, defaultEnvId: dflt });
      invalidateSnapshot(ws);
      // The shell rebuilds the switcher from this, not from a cached copy.
      window.dispatchEvent(new CustomEvent('drcompass:data-changed', { detail: { environments: true } }));
      drawEnvironments();
    }

    async function addEnvironment() {
      const made = await environmentDialog(null, envState.items);
      if (!made) return;
      const items = [...envState.items];
      if (made.isProduction) for (const e of items) e.isProduction = false;
      // A dedicated router owns id minting and normalisation when it exists.
      const created = await wapi.post(`/w/${ws}/environments`, made).catch(() => null);
      if (created && created.id) {
        invalidateSnapshot(ws);
        const fresh = await wapi.get(`/w/${ws}/workspace`);
        envState = environmentsOf(fresh);
        window.dispatchEvent(new CustomEvent('drcompass:data-changed', { detail: { environments: true } }));
        drawEnvironments();
        toast(`Environment '${made.name}' added`, 'ok');
        return;
      }
      items.push({ ...made, id: `env_${slugify(made.slug)}` });
      await saveEnvironments(items, envState.defaultEnvId || items[0].id);
      toast(`Environment '${made.name}' added`, 'ok');
    }

    async function editEnvironment(env) {
      const edited = await environmentDialog(env, envState.items);
      if (!edited) return;
      const items = envState.items.map((e) => (e.id === env.id ? edited : (edited.isProduction ? { ...e, isProduction: false } : e)));
      await saveEnvironments(items, envState.defaultEnvId);
      toast('Saved', 'ok');
    }

    async function removeEnvironment(env) {
      // Components pointing at a removed environment would become invisible in
      // every scoped view, so say the number and then genuinely release them.
      const inIt = allComponents.filter((c) => String(c.envId || '') === String(env.id));
      const ok = await confirmDialog(`Remove the '${env.name}' environment?`, {
        title: 'Remove environment',
        confirmLabel: 'Remove environment',
        detail: inIt.length
          ? `${inIt.length} component${inIt.length > 1 ? 's are' : ' is'} recorded in it. Nothing is deleted — they go back to having no environment, `
            + 'and you can assign them again from the Inventory.'
          : 'Nothing is recorded in it, so nothing else changes.',
      });
      if (!ok) return;
      await wapi.del(`/w/${ws}/environments/${env.id}`).catch(() => null);
      const items = envState.items.filter((e) => e.id !== env.id);
      await saveEnvironments(items, envState.defaultEnvId === env.id ? (items[0]?.id || null) : envState.defaultEnvId);
      // Release the components whatever path did the delete — idempotent.
      for (const c of inIt) {
        await wapi.put(`/w/${ws}/c/components/${c.id}`, { envId: null }).catch(() => null);
      }
      allComponents = await wapi.get(`/w/${ws}/c/components`).then((r) => r.items || [], () => allComponents);
      orphans = allComponents.filter((c) => !c.envId).length;
      drawEnvironments();
      toast(inIt.length ? `Removed — ${inIt.length} component${inIt.length > 1 ? 's' : ''} now have no environment` : 'Environment removed');
    }

    function drawEnvironments() {
      envCard.replaceChildren(
        cardHead(h('h2', null, 'Environments'),
          envState.items.length
            ? btn({ label: '＋ Add environment', size: 'btn-sm', onClick: addEnvironment })
            : null),
        h('p', { class: 'hint', style: 'margin-bottom:12px' },
          'Dev, staging and prod are different accounts that are recovered separately. '
          + 'Add them and every page — inventory, diagrams, runbooks, exports — can be asked for one environment at a time, '
          + 'and the link you send a colleague opens on the same one.'),
      );

      if (!envState.items.length) {
        envCard.append(
          h('p', { class: 'opt-help', style: 'margin-bottom:12px' },
            'This workspace is single-environment: everything in it describes one account, and nothing has changed. '
            + 'Adding environments does not re-import anything — components stay unassigned until you assign them.'),
          btn({ label: '＋ Add the first environment', onClick: addEnvironment }));
        return;
      }

      for (const e of envState.items) {
        const isDefault = envState.defaultEnvId === e.id;
        envCard.append(h('div', { class: `env-row ${e.isProduction ? 'is-prod' : ''}` },
          h('div', { class: 'env-row-main' },
            h('div', { class: 'env-row-name' },
              envBadge(e),
              h('code', null, `/${e.slug}`),
              isDefault ? badge('opens by default', 'accent') : null),
            h('div', { class: 'env-row-meta' },
              e.regions?.primary || e.regions?.recovery
                ? h('span', { class: 'mono' }, `${e.regions.primary || 'region?'} → ${e.regions.recovery || 'region?'}`)
                : h('span', null, 'no regions set'),
              e.awsProfile ? h('span', null, ' · AWS profile ', h('code', null, e.awsProfile)) : null,
              e.kubeContext ? h('span', null, ' · kube ', h('code', null, e.kubeContext)) : null,
              e.accountId ? h('span', null, ' · account ', h('code', null, e.accountId)) : null),
            e.notes ? h('div', { class: 'opt-help' }, e.notes) : null),
          h('div', { class: 'env-row-acts' },
            isDefault ? null : btn({
              label: 'Open by default', size: 'btn-sm', kind: 'btn-ghost',
              title: 'The environment this workspace opens on',
              onClick: () => saveEnvironments(envState.items, e.id),
            }),
            btn({ label: 'Edit', size: 'btn-sm', onClick: () => editEnvironment(e) }),
            btn({ label: 'Remove', size: 'btn-sm', kind: 'btn-ghost', onClick: () => removeEnvironment(e) }))));
      }

      if (!envState.prod) {
        envCard.append(h('p', { class: 'hint', style: 'margin-top:12px' },
          'None of these is marked as production. Marking one turns the switcher red whenever it is selected — '
          + 'which is the whole point of having the switcher.'));
      }
      // Deliberately the UNSCOPED count: a component with no environment is
      // invisible in every scoped view, which is exactly why this card is where
      // it has to be reported.
      if (orphans) {
        envCard.append(h('p', { class: 'hint', style: 'margin-top:10px' },
          h('a', { href: `#/${ws}/all/inventory` },
            `${orphans} component${orphans > 1 ? 's are' : ' is'} not in any environment yet — assign them →`)));
      }
    }
    drawEnvironments();

    // ---------------------------------------------------------------- layout
    el.append(
      pageHead({
        title: 'Settings',
        purpose: 'Set the facts every other page reads: the region pair, the targets the business agreed to, and what you recover with.',
        crumb: crumbFor('settings', ws),
      }),

      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        envCard,

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
                h('p', { class: 'opt-help' }, 'AI runs through an agentic CLI installed on this machine — Claude Code by default, or whichever tool you pick under "AI tool" above — and nothing is applied to your data until you review and accept it.')),
              h('div', null,
                h('h3', null, 'Lucidchart and draw.io'),
                h('p', { class: 'opt-help' }, 'Export any diagram as Mermaid or draw.io XML from the Diagrams page and paste it in.')))),
          h('div', { class: 'divider' }),
          h('a', { class: 'hint', href: `#/${ws}/discover` }, 'Set up a read-only AWS scan →')),
      ),

      // [ai-providers] Which local AI CLI every AI feature runs through.
      aiToolCard({ ws, api }),

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
