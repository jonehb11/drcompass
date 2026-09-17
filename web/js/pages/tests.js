// Tests & exercises: plan from the app-test catalog, execute with timestamps,
// findings → gaps, same-day record, honest RTA/RPA numbers.
//
// PRE-CUTOVER GATES (v0.7). A test can now say WHEN it must run relative to
// moving live traffic, who owns it, what it proves, and whether a failure stops
// the cutover. Those fields turn the app-test list into the artifact you hand
// the person on the bridge call: `#/<ws>/tests/pre-cutover`. The shared rules
// live in web/js/cutover.js, which the server reads too, so the page, the
// runbook gate and the Region-switch plan can never disagree about what must
// pass before traffic moves.
import { h, card, badge, empty, field, modal, toast, confirmDialog, pageHead, btn, snapshot, invalidateSnapshot } from '../ui.js';
import { aiActionRow, aiOperations, aiAvailable } from '../ai-actions.js';
import { crumbFor, nextStepFor } from '../onboarding.js';
import { measuredNumbers, describe } from '../measured.js';
import {
  WHEN_VALUES, WHEN_LABEL, ON_FAIL_VALUES, normalizeAppTest, whenOf, onFailOf, isBlocking,
  buildPreCutoverChecklist, checklistToMarkdown,
} from '../cutover.js';
import { parsePastedTests, normalizeParsedDrafts } from '../cutover-parse.js';

const TYPES = ['recovery-test', 'game-day', 'tabletop', 'component-test', 'chaos'];
const STATUSES = ['planned', 'in-progress', 'passed', 'failed', 'canceled'];
const STATUS_KIND = { planned: 'accent', 'in-progress': 'warn', passed: 'ok', failed: 'err', canceled: '' };
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const SEV_KIND = { blocker: 'err', high: 'warn', medium: '', low: '' };

const esc = (v) => (v === null || v === undefined) ? '' : String(v);
const minsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
const fmtTs = (ts) => ts ? new Date(ts).toLocaleString() : '—';

// ------------------------------------------------------- cutover vocabulary

const WHEN_KIND = { 'pre-cutover': 'warn', 'post-cutover': 'purple', 'recovery-test-only': '' };
const WHEN_SHORT = { 'pre-cutover': 'pre-cutover', 'post-cutover': 'post-cutover', 'recovery-test-only': 'test only' };

/** The one-glance answer to "does this stop the cutover?" */
function gateBadges(a) {
  const w = whenOf(a);
  if (w === 'recovery-test-only') return [];
  const out = [badge(WHEN_SHORT[w], WHEN_KIND[w])];
  out.push(onFailOf(a) === 'block' ? badge('BLOCKING', 'err') : badge('advisory', ''));
  return out;
}

/** The additive gate fields, as an editable block. Mutates `a` on input. */
function gateFields(a, onChange = () => {}) {
  const whenSel = h('select', { style: 'width:auto', onChange: (e) => { a.when = e.target.value; onChange(); } },
    WHEN_VALUES.map((w) => h('option', { value: w, selected: whenOf(a) === w }, `${w} — ${WHEN_LABEL[w]}`)));
  const failSel = h('select', { style: 'width:auto', onChange: (e) => { a.onFail = e.target.value; onChange(); } },
    ON_FAIL_VALUES.map((f) => h('option', { value: f, selected: onFailOf(a) === f },
      f === 'block' ? 'block the cutover' : 'advisory — record and carry on')));
  const ownerInp = h('input', { value: esc(a.owner), placeholder: 'who runs it — a person or a team', onInput: (e) => { a.owner = e.target.value; } });
  const provesInp = h('input', { value: esc(a.proves), placeholder: 'what it proves, in business terms', onInput: (e) => { a.proves = e.target.value; } });
  const evidInp = h('input', { value: esc(a.evidence), placeholder: 'what to record on the bridge call', onInput: (e) => { a.evidence = e.target.value; } });
  const estInp = h('input', { type: 'number', value: a.estMinutes ?? '', style: 'width:80px', onInput: (e) => { a.estMinutes = e.target.value === '' ? null : Number(e.target.value); } });
  return h('div', null,
    h('div', { class: 'grid cols-2' }, field('When it must run', whenSel), field('If it fails', failSel)),
    h('div', { class: 'grid cols-2' }, field('Owner', ownerInp), field('Proves', provesInp)),
    h('div', { class: 'grid cols-2' }, field('Evidence to record', evidInp), field('Minutes', estInp)));
}

/* ===========================================================================
 * CAPTURE FROM A CONVERSATION
 *
 * "I just met with a dev and he has all of his testing things." The point is
 * speed: paste the notes, get draft rows, fix the two that parsed badly, save.
 * Nothing is written until the review table is confirmed, and nothing is
 * invented — a check with no pass criterion arrives with an empty criterion and
 * a warning, never with a plausible-sounding one.
 *
 * File/document ingestion is a separate feature (owned elsewhere); this is the
 * in-page paste path, plus a defensive AI parse for prose that is not a list.
 * =========================================================================*/

const SAMPLE_NOTES = `- [ ] Claim adjudicates end to end — expect a real claim_id, not a 500. Owner: app team. BLOCKING
- [ ] Settlement import job runs (owner: batch team) -> new rows in the remittance db, blocking, ~15 min
- [ ] Redis warm — nice to have, advisory`;

async function aiParseNotes({ ws, api, text, componentId, source }) {
  const res = await aiOperations({
    ws, api,
    context: { kind: 'workspace', extra: { notes: String(text || '').slice(0, 20000) } },
    instruction: 'The user pasted notes from a conversation with the person who owns a service, about the checks that must pass '
      + 'before live traffic is moved to the recovery region. The notes are in context.extra.notes. Return ONE update-free proposal: '
      + 'a single create operation on "tests" whose appTests array holds one entry per check you can actually find in the notes. '
      + 'Each entry: name (the check, imperative and specific), expected (the literal pass criterion — leave it EMPTY if the notes '
      + 'do not give one; never invent it), proves (what it establishes in business terms), owner (who runs it, exactly as named), '
      + 'command (only if the notes contain one), when ("pre-cutover" unless the notes clearly place it after the flip, then '
      + '"post-cutover"), onFail ("block" when the notes call it blocking/must-pass or when it is plainly a gate, otherwise '
      + '"advise"), estMinutes when stated, and componentId from the real inventory when the notes name a component you can match '
      + 'with confidence — otherwise "". Do not add checks the notes do not contain. In notes, list every place you had to guess.',
  });
  if (!res || !res.ok) throw new Error(res?.message || 'The AI parse failed.');
  const op = (res.operations || []).find((o) => Array.isArray(o?.data?.appTests) && o.data.appTests.length);
  const drafts = normalizeParsedDrafts(op ? op.data.appTests : [], { componentId, source, defaultWhen: 'pre-cutover' });
  return { drafts, notes: res.notes || '', summary: res.summary || '' };
}

/**
 * The paste box + review table. Resolves to an array of normalized app tests
 * (possibly empty when the user backs out). Writes nothing itself.
 */
async function captureFromConversation({ ws, api, components = [], defaults = {} }) {
  const today = new Date().toISOString().slice(0, 10);
  const sourceInp = h('input', { placeholder: 'e.g. Walkthrough with the adjudication dev', value: defaults.source || '' });
  const dateInp = h('input', { type: 'date', value: today });
  const compSel = h('select', null,
    h('option', { value: '' }, '— not tied to one component —'),
    components.map((c) => h('option', { value: c.id, selected: defaults.componentId === c.id }, `${c.name}${c.restoreLayer ? ` (${c.restoreLayer})` : ''}`)));
  const whenSel = h('select', { style: 'width:auto' },
    WHEN_VALUES.filter((w) => w !== 'recovery-test-only').map((w) => h('option', { value: w }, `default: ${w}`)));
  const ta = h('textarea', {
    style: 'min-height:190px;font-family:var(--mono);font-size:12.5px',
    placeholder: SAMPLE_NOTES,
  });

  const out = h('div');
  const status = h('div', { class: 'hint' });
  let drafts = [];

  const drawReview = (warnings = [], extraNote = '') => {
    out.innerHTML = '';
    if (!drafts.length) return;
    const rows = drafts.map((d, i) => {
      const nameInp = h('input', { value: esc(d.name), style: 'min-width:180px', onInput: (e) => { d.name = e.target.value; } });
      const expInp = h('input', {
        value: esc(d.expected), placeholder: 'no pass criterion in the notes',
        style: `min-width:180px${d.expected ? '' : ';border-color:var(--warn)'}`,
        onInput: (e) => { d.expected = e.target.value; },
      });
      const ownInp = h('input', { value: esc(d.owner), placeholder: 'unowned', style: 'width:120px', onInput: (e) => { d.owner = e.target.value; } });
      const whenS = h('select', { style: 'width:auto', onChange: (e) => { d.when = e.target.value; } },
        WHEN_VALUES.map((w) => h('option', { value: w, selected: d.when === w }, WHEN_SHORT[w])));
      const failS = h('select', { style: 'width:auto', onChange: (e) => { d.onFail = e.target.value; d.critical = e.target.value === 'block'; } },
        ON_FAIL_VALUES.map((f) => h('option', { value: f, selected: d.onFail === f }, f === 'block' ? 'blocking' : 'advisory')));
      const keep = h('input', { type: 'checkbox', checked: true, style: 'width:auto', onChange: (e) => { d.__keep = e.target.checked; } });
      d.__keep = true;
      return h('tr', null,
        h('td', null, keep),
        h('td', null, nameInp, d.command ? h('pre', { style: 'margin:4px 0 0' }, h('code', null, d.command)) : null,
          (d.guessed || []).length ? h('div', { class: 'hint' }, `guessed: ${d.guessed.join('; ')}`) : null),
        h('td', null, expInp),
        h('td', null, ownInp),
        h('td', null, whenS),
        h('td', null, failS),
        h('td', null, h('button', { class: 'btn btn-sm', title: 'Drop this row', onClick: () => { drafts.splice(i, 1); drawReview(warnings, extraNote); } }, '✕')));
    });
    out.append(
      h('div', { class: 'divider' }),
      h('div', { class: 'row', style: 'margin-bottom:6px' },
        badge(`${drafts.length} draft check${drafts.length === 1 ? '' : 's'}`, 'accent'),
        badge(`${drafts.filter((d) => d.onFail === 'block').length} blocking`, 'err'),
        badge(`${drafts.filter((d) => !d.expected).length} with no pass criterion`, drafts.some((d) => !d.expected) ? 'warn' : '')),
      warnings.length ? h('div', { class: 'hint', style: 'margin-bottom:6px' }, warnings.map((w) => h('div', null, `⚠ ${w}`))) : null,
      extraNote ? h('details', { style: 'margin-bottom:6px' }, h('summary', { class: 'hint' }, 'what the AI said it guessed'), h('p', { class: 'hint' }, extraNote)) : null,
      h('div', { style: 'max-height:40vh;overflow:auto' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['keep', 'Check', 'Pass criterion', 'Owner', 'When', 'If it fails', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows))),
      h('p', { class: 'hint', style: 'margin-top:6px' },
        'Nothing was invented. A blank pass criterion stayed blank — write what "passed" literally looks like, '
        + 'or this becomes a gate nobody can fail.'));
  };

  const runParse = () => {
    const res = parsePastedTests(ta.value, {
      defaultWhen: whenSel.value,
      componentId: compSel.value,
      source: `${sourceInp.value.trim() || 'conversation'}${dateInp.value ? ` (${dateInp.value})` : ''}`,
    });
    drafts = res.items;
    status.textContent = drafts.length
      ? `Parsed ${drafts.length} check(s) as a ${res.format === 'list' ? 'list' : res.format}.`
      : 'Nothing recognised.';
    drawReview(res.warnings);
  };

  const parseBtn = h('button', { class: 'btn btn-primary btn-sm', onClick: runParse }, 'Parse the notes');
  const aiBtn = h('button', {
    class: 'btn btn-sm', hidden: true,
    title: 'For prose that is not a list — the AI proposes the same draft rows, and you review them here',
    onClick: async () => {
      if (!ta.value.trim()) { toast('Paste the notes first', 'err'); return; }
      const label = aiBtn.textContent;
      aiBtn.disabled = true; aiBtn.textContent = 'Reading…';
      try {
        const { drafts: d, notes } = await aiParseNotes({
          ws, api, text: ta.value, componentId: compSel.value,
          source: `${sourceInp.value.trim() || 'conversation'}${dateInp.value ? ` (${dateInp.value})` : ''}`,
        });
        drafts = d;
        status.textContent = d.length ? `The AI proposed ${d.length} check(s) — review every row.` : 'The AI found no checks in these notes.';
        drawReview([], notes);
      } catch (e) {
        toast(e.message, 'err');
      } finally { aiBtn.disabled = false; aiBtn.textContent = label; }
    },
  }, '✦ Parse with AI');
  aiAvailable(api).then((ok) => { if (ok) aiBtn.hidden = false; }).catch(() => {});

  const body = h('div', null,
    h('p', { class: 'hint' },
      'Paste what came out of the conversation — a bulleted or numbered list, a pasted table, or Test:/Owner:/Expected: blocks. '
      + 'You review every row before anything is saved.'),
    h('div', { class: 'grid cols-2' },
      field('Where these came from', sourceInp), field('Date', dateInp),
      field('Component (optional)', compSel), field('Default timing', whenSel)),
    field('Notes', ta),
    h('div', { class: 'row', style: 'margin:-4px 0 4px' }, parseBtn, aiBtn, status),
    out);

  const ok = await modal('Capture checks from a conversation', body, {
    wide: true,
    actions: [{ label: 'Add the kept checks', kind: 'btn-primary', value: true }],
  });
  if (!ok) return [];
  const kept = drafts.filter((d) => d.__keep !== false && String(d.name || '').trim());
  if (!kept.length) { toast('Nothing kept — nothing was written', 'err'); return []; }
  return kept.map((d) => {
    const { __keep, parseNotes, guessed, ...rest } = d;
    return normalizeAppTest({ ...rest, componentId: rest.componentId || compSel.value });
  });
}

// ------------------------------------------------------------------ list

async function renderList(el, { ws, api, navigate }) {
  let tests = [], runbooks = [];
  try { [tests, runbooks] = await Promise.all([
    api.get(`/w/${ws}/c/tests`).then((r) => r.items || []),
    api.get(`/w/${ws}/c/runbooks`).then((r) => r.items || []),
  ]); } catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }

  const planTest = async () => {
    let catalog = [];
    try { catalog = (await api.get(`/w/${ws}/templates/app-tests`)).templates || []; } catch { /* optional */ }
    const nameInp = h('input', { placeholder: 'e.g. Dev recovery test #4' });
    const typeSel = h('select', null, TYPES.map((t) => h('option', { value: t }, t)));
    const dateInp = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const rbSel = h('select', null, h('option', { value: '' }, '— no runbook —'),
      runbooks.map((r) => h('option', { value: r.id }, r.name)));
    const scopeTa = h('textarea', { placeholder: 'What is in and out of scope; entry criteria; success bar.' });
    const checks = catalog.map((t) => {
      const cb = h('input', { type: 'checkbox', checked: !!t.critical, style: 'width:auto' });
      return { t, cb, row: h('label', { class: 'row', style: 'margin:4px 0;cursor:pointer;align-items:flex-start' },
        cb, h('div', null, h('div', { class: 'row' }, t.name, t.critical ? badge('critical', 'err') : null, ...gateBadges(t)),
          h('div', { class: 'hint' }, t.hint || ''),
          t.owner ? h('div', { class: 'hint' }, `usually run by: ${t.owner}`) : null)) };
    });
    const customBox = h('div');
    const customs = [];
    const addCustom = () => {
      const inp = h('input', { placeholder: 'Custom app test name' });
      customs.push(inp);
      customBox.append(h('div', { style: 'margin:4px 0' }, inp));
    };
    const body = h('div', null,
      h('div', { class: 'grid cols-2' }, field('Name', nameInp), field('Type', typeSel),
        field('Date', dateInp), field('Runbook', rbSel)),
      field('Scope', scopeTa),
      h('h3', { style: 'margin:8px 0 4px' }, 'App-level verification tests'),
      h('p', { class: 'hint' }, 'From the catalog — these are the business-level checks that define success, not pod counts.'),
      ...checks.map((c) => c.row),
      customBox,
      h('button', { class: 'btn btn-sm', onClick: addCustom }, '＋ custom test'));
    const ok = await modal('Plan a test', body, { wide: true, actions: [{ label: 'Create', kind: 'btn-primary', value: true }] });
    if (!ok) return;
    // The catalog's cutover classification comes across with the test — that is
    // the whole point of putting it in the catalog. `normalizeAppTest` fills the
    // rest, so a catalog entry written before these fields existed still works.
    const appTests = checks.filter((c) => c.cb.checked).map(({ t }) => normalizeAppTest({
      name: t.name, command: t.command || '', expected: t.expected || '', componentId: '', critical: !!t.critical, result: null,
      when: t.when, owner: t.owner, proves: t.proves || t.hint, onFail: t.onFail, evidence: t.evidence, estMinutes: t.estMinutes,
      source: 'app-test catalog',
    }));
    for (const c of customs) if (c.value.trim()) appTests.push(normalizeAppTest({ name: c.value.trim() }));
    try {
      const created = await api.post(`/w/${ws}/c/tests`, {
        name: nameInp.value.trim() || 'New test', type: typeSel.value, status: 'planned',
        date: dateInp.value, runbookId: rbSel.value || '', scope: scopeTa.value,
        appTests, timestamps: { t0: null, tFirstAccess: null, t1: null },
        results: { rtaMinutes: null, rpaMinutes: null, cleanRun: false },
        findings: [], record: '', updatedAt: new Date().toISOString(),
      });
      toast('Test planned', 'ok');
      navigate(`#/${ws}/tests/${created.id}`);
    } catch (e) { toast(e.message, 'err'); }
  };

  // "I just met with a dev" — straight from notes to draft checks, into a
  // record of its own, without planning a whole exercise first.
  const captureTests = async () => {
    let components = [];
    try { components = (await api.get(`/w/${ws}/c/components`)).items || []; } catch { components = []; }
    const appTests = await captureFromConversation({ ws, api, components });
    if (!appTests.length) return;
    const owners = [...new Set(appTests.map((a) => a.owner).filter(Boolean))];
    const comp = components.find((c) => c.id === appTests.find((a) => a.componentId)?.componentId);
    const pre = appTests.filter((a) => a.when === 'pre-cutover').length;
    const existing = tests.filter((t) => (t.status === 'planned' || t.purpose === 'pre-cutover'));
    const targetSel = h('select', null,
      h('option', { value: '' }, `— new record: "Cutover checks${comp ? ` — ${comp.name}` : ''}" —`),
      existing.map((t) => h('option', { value: t.id }, `add to: ${t.name}`)));
    const go = await modal('Where should these live?', h('div', null,
      h('p', { class: 'hint' }, `${appTests.length} check(s), ${pre} of them pre-cutover`
        + `${owners.length ? `, owned by ${owners.join(', ')}` : ', with no owner named'}.`),
      field('Record', targetSel)), { actions: [{ label: 'Save', kind: 'btn-primary', value: true }] });
    if (!go) return;
    try {
      if (targetSel.value) {
        const t = tests.find((x) => x.id === targetSel.value);
        const merged = [...(t.appTests || []), ...appTests];
        await api.put(`/w/${ws}/c/tests/${t.id}`, { ...t, appTests: merged, updatedAt: new Date().toISOString() });
        toast(`Added ${appTests.length} check(s) to "${t.name}"`, 'ok');
        navigate(`#/${ws}/tests/${t.id}`);
      } else {
        const created = await api.post(`/w/${ws}/c/tests`, {
          name: `Cutover checks${comp ? ` — ${comp.name}` : ''} (${new Date().toISOString().slice(0, 10)})`,
          type: 'component-test', status: 'planned', date: '', runbookId: '',
          // Additive: this record exists to hold a verification set, not to
          // measure a recovery. It never produces an RTA/RPA.
          purpose: 'pre-cutover',
          componentId: comp ? comp.id : '',
          scope: `Verification set captured from a conversation. These are the checks that must pass before traffic moves${comp ? ` for ${comp.name}` : ''} — not a timed recovery exercise.`,
          appTests,
          timestamps: { t0: null, tFirstAccess: null, t1: null },
          results: { rtaMinutes: null, rpaMinutes: null, cleanRun: false },
          findings: [], record: '', updatedAt: new Date().toISOString(),
        });
        toast(`Captured ${appTests.length} check(s)`, 'ok');
        navigate(`#/${ws}/tests/${created.id}`);
      }
    } catch (e) { toast(e.message, 'err'); }
  };

  el.append(pageHead({
    title: 'Tests',
    purpose: 'Rehearse the recovery and record what it actually took — every recovery time you quote should trace back to a row here.',
    crumb: crumbFor('tests', ws),
    actions: [
      btn({ label: 'Pre-cutover checklist', href: `#/${ws}/tests/pre-cutover`, title: 'The verifications that must pass before traffic moves, grouped by who runs them' }),
      btn({ label: '＋ From a conversation', onClick: captureTests, title: 'Paste notes from a walkthrough with whoever owns the service' }),
      btn({ label: '＋ Plan test', kind: 'btn-primary', onClick: planTest }),
    ],
  }));

  el.append(aiActionRow({
    ws, api, label: 'AI', style: 'margin:-2px 0 16px',
    hint: 'Nothing here invents a number — RTA/RPA only ever come from a test you actually ran.',
    actions: [
      {
        label: 'What should I test next?',
        title: 'The next test that would tell you the most, given what has already been proven',
        modalTitle: 'What to test next',
        context: { kind: 'workspace' },
        prompt: 'Given this workspace\'s inventory, runbooks, gaps and the tests already run, what should the next test be? '
          + 'Answer in under 250 words: the test (type and scope), the specific unknown it would resolve, which components and '
          + 'runbook it exercises (real ids/names), the app-level success bar to use, and what would make it a failure. '
          + 'Then one line: what NOT to test yet, and why. Base the recommendation on what these tests have and have not '
          + 'measured — if nothing has been measured yet, say so and start there.',
      },
      {
        label: 'Plan the next test',
        title: 'Create that test as a planned record with its app-level checks',
        modalTitle: 'Planned test',
        mode: 'operations',
        context: { kind: 'workspace' },
        onApplied: () => { window.dispatchEvent(new HashChangeEvent('hashchange')); },
        prompt: 'Propose the next recovery test for this workspace as a single create operation on "tests": status "planned", '
          + 'a date left empty or realistic, runbookId referencing a real runbook when one fits, a scope stating what is in/out '
          + 'and the success bar, and appTests that are business-level proofs (not pod counts) with componentIds from the real '
          + 'inventory. timestamps and results MUST stay null — they are measured on the day. Choose the test that closes the '
          + 'biggest unknown, and say which gap or untested runbook it addresses in the why.',
      },
    ],
  }));

  const snap = await snapshot(api, ws).catch(() => ({}));

  // The round trip made visible: what the rest of the app is quoting right
  // now, and which row here is (or is not) behind it.
  if (tests.length && snap.meta) {
    const honest = measuredNumbers(snap.meta, tests, null, { components: snap.components || [] });
    const line = (slot, label) => {
      const d = describe(slot, { targetMinutes: null, unit: label });
      return h('div', { style: 'margin:3px 0;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap' },
        badge(d.badge, d.badgeTone),
        slot.state === 'measured'
          ? h('span', null, `${label}: `, h('strong', null, d.value), ' — from ',
            h('a', { href: `#/${ws}/tests/${slot.test.id}` }, slot.test.name),
            `${slot.test.date ? ` (${slot.test.date})` : ''}, passed.`)
          : slot.state === 'declared'
            ? h('span', null, `${label}: `, h('strong', null, d.value),
              ' — typed into Settings by hand. No row below backs it.')
            : h('span', null, `${label}: not measured yet — no passed test here has produced one.`));
    };
    el.append(card(
      h('h2', { style: 'font-size:15px;margin-bottom:6px' }, 'What this workspace quotes today'),
      line(honest.rta, 'recovery time'),
      line(honest.rpa, 'data loss'),
      h('p', { class: 'hint', style: 'margin-top:8px' },
        'Open a test that passed and use ', h('strong', null, 'Record as this workspace’s measured numbers'),
        ' to make these cite it.')));
  }

  // The gate, at a glance. This is the question the product could not answer
  // before: not "have we rehearsed?" but "what has to pass before we move
  // traffic, and who does it?"
  if (tests.length) {
    const pre = buildPreCutoverChecklist(
      { workspace: snap.meta || {}, components: snap.components || [], tests, services: snap.services || [] },
      { when: 'pre-cutover' });
    el.append(card(
      h('div', { class: 'row' },
        h('h2', { style: 'font-size:15px;margin:0' }, 'Before traffic moves'),
        h('span', { class: 'spacer' }),
        btn({ label: 'Open the checklist', href: `#/${ws}/tests/pre-cutover`, size: 'sm' })),
      pre.counts.total
        ? h('div', null,
          h('div', { class: 'row', style: 'margin:8px 0' },
            badge(`${pre.counts.blocking} blocking`, 'err'),
            badge(`${pre.counts.advisory} advisory`),
            badge(`${pre.counts.owners} owner${pre.counts.owners === 1 ? '' : 's'}`, 'accent'),
            pre.totalEstMinutes ? badge(`~${pre.totalEstMinutes} min in series`) : null,
            pre.counts.proven ? badge(`${pre.counts.proven} proven by a passed test`, 'ok') : null),
          h('p', { class: 'hint' },
            'These are the checks a real cutover is gated on — the L6 verification a runbook\'s L7 step waits for.'),
          pre.warnings.length ? h('div', { class: 'hint' }, pre.warnings.slice(0, 2).map((w) => h('div', null, `⚠ ${w}`))) : null)
        : h('div', null,
          h('p', { class: 'hint', style: 'margin:8px 0' },
            'No check in this workspace says it must pass ', h('strong', null, 'before traffic moves'), '. ',
            'App tests prove a recovery test worked; nothing yet gates a real cutover — so on the day, "we verified it" is a feeling.'),
          h('div', { class: 'row' },
            btn({ label: '＋ Capture them from a conversation', kind: 'btn-primary', size: 'sm', onClick: captureTests })))));
  }

  if (!tests.length) {
    el.append(card(empty({
      icon: '⏱',
      title: 'Nothing has been rehearsed yet',
      body: 'Until one recovery has been run on the clock, every recovery time in this workspace is a hope.',
      action: { label: 'Plan the first test', onClick: planTest, kind: '' },
    })), nextStepFor('tests', snap, ws));
    return;
  }
  // Status and the measured numbers answer the page's question, so they come
  // first. "Clean run" was a column with a badge on every row, including planned
  // rows where it means nothing — it is now a chip in the Status cell, and only
  // once a run has actually happened.
  const ran = (t) => ['passed', 'failed', 'in-progress'].includes(t.status);
  const rows = tests.map((t) => h('tr', { class: 'clickable', onClick: () => navigate(`#/${ws}/tests/${t.id}`) },
    h('td', null, h('strong', null, t.name || '(unnamed)'),
      h('div', { class: 'hint' }, t.type || '—')),
    h('td', null, badge(t.status || '—', STATUS_KIND[t.status] || ''),
      ran(t) && !t.results?.cleanRun ? h('div', { style: 'margin-top:3px' }, badge('needed hands-on help', 'warn')) : null),
    // Numbers off a run that did not pass are still worth seeing — they are
    // just not measurements, and the cell says so rather than letting the
    // reader assume.
    h('td', { class: 'num' },
      h('div', null, t.results?.rtaMinutes != null ? `${t.results.rtaMinutes}m` : '—',
        ' / ', t.results?.rpaMinutes != null ? `${t.results.rpaMinutes}m` : '—'),
      (t.results?.rtaMinutes != null || t.results?.rpaMinutes != null) && t.status !== 'passed'
        ? h('div', { class: 'hint', style: 'font-weight:400' }, 'not a measurement — run did not pass')
        : null),
    h('td', null, t.date || '—'),
    h('td', { class: 'num' }, (t.findings || []).length ? String((t.findings || []).length) : '—')));
  el.append(card(h('table', { class: 'table' },
    h('thead', null, h('tr', null,
      ['Test', 'Status', 'RTA / RPA', 'Date', 'Findings'].map((x, i) => h('th', { class: i === 2 || i === 4 ? 'num' : null }, x)))),
    h('tbody', null, rows))));
  el.append(nextStepFor('tests', snap, ws));
}

/* ===========================================================================
 * THE PRE-CUTOVER CHECKLIST  —  #/<ws>/tests/pre-cutover
 *
 * The artifact you hand the person on the bridge call: the ordered list of
 * verifications that must pass before traffic moves, grouped by who runs them,
 * with the pass criteria the people who own the services actually gave you.
 *
 * It is DERIVED, never stored: change an app test's `when` and the checklist
 * changes. The server computes the same list at GET /w/:ws/pre-cutover so the
 * runbook gate, the Region-switch plan and the exporters read one thing; this
 * page prefers that endpoint and falls back to computing it in the browser when
 * the recommender is not mounted.
 * =========================================================================*/

function copyToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText) { navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = h('textarea', { value: text, style: 'position:fixed;left:-9999px;top:0' });
    document.body.append(ta); ta.select?.();
    const ok = document.execCommand?.('copy'); ta.remove();
    return !!ok;
  } catch { return false; }
}

async function renderPreCutover(el, { ws, api, navigate }) {
  let tests = [], components = [], services = [], meta = {};
  try {
    [tests, components, meta] = await Promise.all([
      api.get(`/w/${ws}/c/tests`).then((r) => r.items || []),
      api.get(`/w/${ws}/c/components`).then((r) => r.items || []),
      api.get(`/w/${ws}/workspace`).catch(() => ({})),
    ]);
  } catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }
  try { services = (await api.get(`/w/${ws}/c/services`)).items || []; } catch { services = []; }
  const environments = Array.isArray(meta.environments) ? meta.environments : [];

  const state = { serviceId: '', componentId: '', envId: meta.defaultEnvId || '', when: 'pre-cutover' };

  const svcSel = h('select', { style: 'width:auto', onChange: (e) => { state.serviceId = e.target.value; if (e.target.value) state.componentId = ''; cmpSel.value = ''; refresh(); } },
    h('option', { value: '' }, services.length ? '— all services —' : '— no services defined —'),
    services.map((s) => h('option', { value: s.id }, s.name || s.slug || s.id)));
  const cmpSel = h('select', { style: 'width:auto', onChange: (e) => { state.componentId = e.target.value; if (e.target.value) { state.serviceId = ''; svcSel.value = ''; } refresh(); } },
    h('option', { value: '' }, '— whole workspace —'),
    components.map((c) => h('option', { value: c.id }, `${c.name}${c.restoreLayer ? ` (${c.restoreLayer})` : ''}`)));
  const envSel = h('select', { style: 'width:auto', onChange: (e) => { state.envId = e.target.value; refresh(); } },
    h('option', { value: '' }, environments.length ? '— all environments —' : '— single environment —'),
    environments.map((e2) => h('option', { value: e2.id, selected: state.envId === e2.id }, e2.name || e2.slug || e2.id)));
  const whenSel = h('select', { style: 'width:auto', onChange: (e) => { state.when = e.target.value; refresh(); } },
    h('option', { value: 'pre-cutover' }, 'before traffic moves (the gate)'),
    h('option', { value: 'post-cutover' }, 'after traffic moves (the soak)'));

  const out = h('div');

  const localBuild = () => buildPreCutoverChecklist({ workspace: meta, components, tests, services }, { ...state });

  const draw = (c) => {
    out.innerHTML = '';
    const scopeName = c.scope.serviceName || c.scope.componentName || 'the whole workspace';

    out.append(card(
      h('div', { class: 'row' },
        h('h2', { style: 'margin:0;font-size:16px' },
          c.when === 'pre-cutover' ? 'Must pass before traffic moves' : 'Must pass after traffic moves'),
        h('span', { class: 'spacer' }),
        badge(`${c.counts.blocking} blocking`, c.counts.blocking ? 'err' : ''),
        badge(`${c.counts.advisory} advisory`),
        c.totalEstMinutes ? badge(`~${c.totalEstMinutes} min in series`) : null),
      h('p', { class: 'hint', style: 'margin-top:6px' },
        `${scopeName}${c.scope.envName ? ` · ${c.scope.envName}` : ''}`,
        c.scope.componentCount ? ` · ${c.scope.componentCount} component(s) in scope` : '',
        c.scope.depsCount != null ? ` (the service and the ${c.scope.depsCount} thing(s) it depends on)` : ''),
      c.warnings.length
        ? h('div', { style: 'margin-top:8px' }, c.warnings.map((w) => h('div', { class: 'hint' }, `⚠ ${w}`)))
        : null,
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', {
          class: 'btn btn-sm',
          onClick: () => toast(copyToClipboard(checklistToMarkdown(c)) ? 'Checklist copied as markdown' : 'Could not copy — use the .md link', 'ok'),
        }, 'Copy for the bridge call'),
        h('a', {
          class: 'btn btn-sm', target: '_blank',
          href: `/api/w/${ws}/pre-cutover?format=md&when=${encodeURIComponent(c.when)}`
            + `${state.serviceId ? `&serviceId=${encodeURIComponent(state.serviceId)}` : ''}`
            + `${state.componentId ? `&componentId=${encodeURIComponent(state.componentId)}` : ''}`
            + `${state.envId ? `&envId=${encodeURIComponent(state.envId)}` : ''}`,
        }, 'Open as .md'),
        h('a', { class: 'btn btn-sm', href: `#/${ws}/runbooks` }, 'Put it in a runbook’s L6 gate →'))));

    if (!c.items.length) {
      out.append(card(empty({
        icon: '🚦',
        title: 'Nothing gates the cutover yet',
        body: 'An app test only becomes a gate when somebody says it must pass before traffic moves. '
          + 'Open a test and set "When it must run" on its checks — or capture a set straight from the person who owns the service.',
        action: { label: 'Back to tests', href: `#/${ws}/tests` },
      })));
      return;
    }

    // Ordered by phase, grouped by owner — because the bridge call hands each
    // group to one named person, and the phases say what order to work in.
    for (const g of c.groups) {
      out.append(card(
        h('div', { class: 'row' },
          h('h3', { style: 'margin:0;font-size:14px' }, g.owner),
          g.named ? null : badge('nobody named', 'warn'),
          h('span', { class: 'spacer' }),
          badge(`${g.blocking} blocking`, g.blocking ? 'err' : ''),
          g.advisory ? badge(`${g.advisory} advisory`) : null,
          g.estMinutes ? badge(`~${g.estMinutes} min`) : null),
        h('div', { class: 'divider' }),
        g.items.map((i) => h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--border)' },
          h('div', { class: 'row' },
            h('span', { class: 'hint', style: 'font-variant-numeric:tabular-nums;width:22px' }, String(i.order)),
            h('strong', null, i.name),
            i.blocking ? badge('BLOCKING', 'err') : badge('advisory'),
            i.componentName ? badge(i.componentName, 'accent') : null,
            i.layer ? badge(i.layer) : null,
            i.proven ? badge('proven by a passed test', 'ok') : null,
            i.failedLastRun ? badge('failed last run', 'err') : null),
          i.proves ? h('div', { class: 'hint', style: 'margin-top:3px' }, `Proves: ${i.proves}`) : null,
          i.command ? h('pre', { style: 'margin:6px 0 2px' }, h('code', null, i.command)) : null,
          h('div', { class: 'hint', style: 'margin-top:3px' },
            i.expected
              ? h('span', null, h('strong', null, 'Pass: '), i.expected)
              : h('span', { style: 'color:var(--warn)' }, '⚠ no pass criterion recorded — nobody can fail this check')),
          i.evidence ? h('div', { class: 'hint' }, `Record: ${i.evidence}`) : null,
          h('div', { class: 'hint', style: 'margin-top:3px' },
            'From ', h('a', { href: `#/${ws}/tests/${i.from[0].testId}` }, i.from[0].testName),
            i.lastRun ? ` · last run: ${i.lastRun.result || '—'}${i.lastRun.date ? ` (${i.lastRun.date})` : ''}` : ' · never run',
            i.source ? ` · source: ${i.source}` : '')))));
    }

    out.append(card(
      h('h3', { style: 'margin:0 0 6px;font-size:14px' }, 'The gate'),
      h('ol', { class: 'hint', style: 'margin-left:18px;line-height:1.7' },
        h('li', null, `Every one of the ${c.counts.blocking} blocking checks passes, with its evidence written down.`),
        h('li', null, 'A named decision-maker approves the cutover in writing, with the reason and the time.'),
        h('li', null, 'Only then does the L7 traffic step run — and a runbook whose L7 step has no populated gate above it is flagged as blocked.'))));
  };

  const refresh = async () => {
    out.innerHTML = '';
    out.append(h('p', { class: 'hint' }, 'Building the checklist…'));
    const qs = new URLSearchParams({ when: state.when });
    if (state.serviceId) qs.set('serviceId', state.serviceId);
    if (state.componentId) qs.set('componentId', state.componentId);
    if (state.envId) qs.set('envId', state.envId);
    try {
      draw(await api.get(`/w/${ws}/pre-cutover?${qs}`));
    } catch {
      // The recommender router may not be mounted in this build — the rule is
      // shared code, so the browser can answer the same question itself.
      draw(localBuild());
    }
  };

  el.append(pageHead({
    title: 'Pre-cutover checklist',
    purpose: 'What must pass before you move live traffic — the verification gate between “the recovery region is up” and “we cut over”.',
    crumb: h('a', { href: `#/${ws}/tests`, class: 'page-crumb' }, '← All tests'),
  }));
  el.append(card(h('div', { class: 'grid cols-2' },
    field('Service', svcSel), field('Component (and everything it depends on)', cmpSel),
    field('Environment', envSel), field('Timing', whenSel))));
  el.append(out);
  await refresh();
}

// ---------------------------------------------------------------- detail

function recordSkeleton(t, runbookName) {
  const f = (t.findings || []).map((x) => `- **${x.severity}** — ${x.title}${x.ticket ? ` (${x.ticket})` : ''}`).join('\n') || '- (none yet)';
  const apps = (t.appTests || []).map((a) => `| ${a.name} | ${a.critical ? 'yes' : 'no'} | ${a.result || '—'} |`).join('\n');
  return `# ${t.name} — ${t.date || ''}

## Summary
Status: **${t.status}**. Clean run: **${t.results?.cleanRun ? 'yes' : 'no'}**.

- T0 (recovery initiated): ${t.timestamps?.t0 || '—'}
- First access: ${t.timestamps?.tFirstAccess || '—'}
- T1 (success bar met): ${t.timestamps?.t1 || '—'}
- **RTA: ${t.results?.rtaMinutes ?? '—'} min** · **RPA: ${t.results?.rpaMinutes ?? '—'} min** (recovery point age at T0)
- Runbook: ${runbookName || t.runbookId || '—'}

## App-level tests
| Test | Critical | Result |
|---|---|---|
${apps || '| — | — | — |'}

## The ugly parts
(write what actually went wrong, in order, while it still hurts — the misleading error, the wrong flag, the thing you almost did)

## What passed

## Findings
${f}

## Follow-ups
- (each finding → gap or ticket or runbook edit; name the owner)
`;
}

async function renderDetail(el, { ws, api, navigate }, id) {
  let tests = [], runbooks = [];
  try { [tests, runbooks] = await Promise.all([
    api.get(`/w/${ws}/c/tests`).then((r) => r.items || []),
    api.get(`/w/${ws}/c/runbooks`).then((r) => r.items || []),
  ]); } catch (e) { el.append(card(h('p', { class: 'hint' }, e.message))); return; }
  const t = tests.find((x) => x.id === id);
  if (!t) { el.append(empty('Test not found.'), h('p', { style: 'text-align:center' }, h('a', { href: `#/${ws}/tests` }, '← All tests'))); return; }
  t.appTests = t.appTests || []; t.findings = t.findings || [];
  t.timestamps = t.timestamps || { t0: null, tFirstAccess: null, t1: null };
  t.results = t.results || { rtaMinutes: null, rpaMinutes: null, cleanRun: false };
  const runbook = runbooks.find((r) => r.id === t.runbookId);

  const save = async (silent) => {
    t.updatedAt = new Date().toISOString();
    try { await api.put(`/w/${ws}/c/tests/${t.id}`, t); if (!silent) toast('Test saved', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  // --- header / status
  const statusSel = h('select', { style: 'width:auto', onChange: (e) => { t.status = e.target.value; save(true); drawHead(); } },
    STATUSES.map((s) => h('option', { value: s, selected: t.status === s }, s)));
  const headSub = h('div', { class: 'sub' });
  const drawHead = () => {
    headSub.innerHTML = '';
    headSub.append(`${t.type} · ${t.date || 'no date'} · `,
      runbook ? h('a', { href: `#/${ws}/runbooks/${runbook.id}` }, runbook.name) : 'no runbook');
  };
  drawHead();

  // --- timestamps + results
  const tsBox = h('div');
  const rpaInp = h('input', {
    type: 'number', value: t.results.rpaMinutes ?? '', style: 'width:110px',
    onInput: (e) => { t.results.rpaMinutes = e.target.value === '' ? null : Number(e.target.value); },
  });
  const cleanCb = h('input', { type: 'checkbox', checked: !!t.results.cleanRun, style: 'width:auto', onChange: (e) => { t.results.cleanRun = e.target.checked; } });
  const drawTs = () => {
    tsBox.innerHTML = '';
    const mk = (key, label, note) => h('div', { class: 'row', style: 'margin:6px 0' },
      h('button', { class: 'btn btn-sm', onClick: () => {
        t.timestamps[key] = new Date().toISOString();
        if (t.timestamps.t0 && t.timestamps.t1) t.results.rtaMinutes = minsBetween(t.timestamps.t0, t.timestamps.t1);
        save(true); drawTs();
      } }, label),
      h('span', { class: 'mono', style: 'font-family:var(--mono)' }, fmtTs(t.timestamps[key])),
      h('span', { class: 'hint' }, note));
    tsBox.append(
      mk('t0', 'Mark T0', 'recovery initiated — the clock starts'),
      mk('tFirstAccess', 'Mark first access', 'first useful access to the recovered environment'),
      mk('t1', 'Mark T1 (success bar)', 'business transaction succeeded end-to-end'),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('span', { class: 'kpi' }, h('span', { class: 'kpi-value' }, t.results.rtaMinutes != null ? `${t.results.rtaMinutes}m` : '—'),
          h('span', { class: 'kpi-label' }, 'RTA (auto: T1 − T0)')),
        h('div', { style: 'margin-left:24px' },
          field('RPA (minutes)', rpaInp),
          h('p', { class: 'hint', style: 'margin-top:-6px' }, 'Enter manually: recovery point age at T0 — how old the data was.')),
        h('label', { class: 'row', style: 'gap:6px;cursor:pointer;margin-left:24px' }, cleanCb, 'clean run (no manual intervention)')));
  };
  drawTs();

  // "Copy to workspace objectives" used to send two bare digits into a
  // free-text Settings field, which is how a failed test's 47 minutes ended up
  // on the dashboard as a green measurement. It now records the test's
  // IDENTITY alongside the numbers, and it refuses to promote a run that did
  // not pass — a run that never reached the success bar has no recovery time.
  const recordAsMeasured = async () => {
    if (t.results.rtaMinutes == null && t.results.rpaMinutes == null) { toast('No RTA/RPA measured yet', 'err'); return; }
    if (t.status !== 'passed') {
      toast(`This test is ${t.status || 'not passed'} — only a passed run can set the measured numbers`, 'err');
      return;
    }
    const what = [
      t.results.rtaMinutes != null ? `recovery time ${t.results.rtaMinutes} min` : null,
      t.results.rpaMinutes != null ? `data loss ${t.results.rpaMinutes} min` : null,
    ].filter(Boolean).join(' and ');
    const ok = await confirmDialog(
      `Record ${what} as this workspace's measured numbers, from "${t.name || 'this test'}"?`, {
        title: 'Record as measured',
        confirmLabel: 'Record from this test',
        detail: 'The workspace will cite this test by name, date and status wherever the numbers appear — '
          + 'the Overview tiles, Settings, the workbook, the executive summary and the AI context. '
          + `Editing the numbers by hand in Settings afterwards breaks the link and drops them back to "recorded by hand".`
          + (t.results.cleanRun ? '' : ' Note: this run is not marked a clean run, so it needed hands-on help.'),
      });
    if (!ok) return;
    try {
      const meta = await api.get(`/w/${ws}/workspace`);
      const prev = meta.objectives || {};
      await api.put(`/w/${ws}/workspace`, {
        objectives: {
          ...prev,
          rtaMinutes: t.results.rtaMinutes, rpaMinutes: t.results.rpaMinutes,
          rtaTestId: t.results.rtaMinutes != null ? t.id : '',
          rpaTestId: t.results.rpaMinutes != null ? t.id : '',
          measuredAt: t.date || '',
        },
      });
      invalidateSnapshot(ws);
      toast(`Recorded as measured, citing "${t.name || 'this test'}"`, 'ok');
      window.dispatchEvent(new CustomEvent('drcompass:data-changed'));
    } catch (e) { toast(e.message, 'err'); }
  };

  // --- app tests
  const appBox = h('div');
  const drawApps = () => {
    appBox.innerHTML = '';
    if (!t.appTests.length) appBox.append(h('p', { class: 'hint' }, 'No app-level tests — the success bar is undefined.'));

    // The cutover summary for THIS record: how many of its checks are gates.
    const pre = t.appTests.filter((a) => whenOf(a) === 'pre-cutover');
    const post = t.appTests.filter((a) => whenOf(a) === 'post-cutover');
    const unclassified = t.appTests.length - pre.length - post.length;
    if (t.appTests.length) {
      appBox.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
        pre.length ? badge(`${pre.length} pre-cutover (${pre.filter(isBlocking).length} blocking)`, 'warn') : null,
        post.length ? badge(`${post.length} post-cutover`, 'purple') : null,
        unclassified ? badge(`${unclassified} recovery-test only`, '') : null,
        pre.length ? h('a', { class: 'hint', href: `#/${ws}/tests/pre-cutover` }, 'see the whole gate →') : null));
    }

    t.appTests.forEach((a, i) => {
      const mark = (r) => { a.result = a.result === r ? null : r; save(true); drawApps(); };
      const badgeRow = h('div', { class: 'row' },
        a.result === 'pass' ? badge('PASS', 'ok') : a.result === 'fail' ? badge('FAIL', 'err') : badge('—'),
        h('strong', null, a.name),
        a.critical ? badge('critical', 'err') : null,
        ...gateBadges(a),
        a.owner ? badge(a.owner, 'accent') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: `btn btn-sm ${a.result === 'pass' ? 'btn-on' : ''}`, onClick: () => mark('pass') }, '✓ pass'),
        h('button', { class: `btn btn-sm ${a.result === 'fail' ? 'btn-danger' : ''}`, onClick: () => mark('fail') }, '✕ fail'),
        h('button', { class: 'btn btn-sm', title: 'Remove', onClick: () => { t.appTests.splice(i, 1); drawApps(); } }, '🗑'));
      appBox.append(h('div', { class: 'card', style: 'margin-bottom:8px;padding:10px 14px' },
        badgeRow,
        a.command ? h('pre', { style: 'margin:8px 0 4px' }, h('code', null, a.command)) : null,
        a.expected ? h('p', { class: 'hint' }, `Expected: ${a.expected}`) : null,
        a.proves ? h('p', { class: 'hint' }, `Proves: ${a.proves}`) : null,
        // The gate fields sit behind a disclosure so the common case (mark it
        // pass or fail) stays one click, and classifying it is one more.
        h('details', { style: 'margin-top:6px' },
          h('summary', { class: 'hint' }, whenOf(a) === 'recovery-test-only'
            ? 'Classify this check — does it gate a real cutover?'
            : `Gate: ${WHEN_SHORT[whenOf(a)]} · ${onFailOf(a) === 'block' ? 'blocking' : 'advisory'}`),
          gateFields(a, () => { save(true); drawApps(); }))));
    });

    appBox.append(h('div', { class: 'row', style: 'margin-top:4px' },
      h('button', { class: 'btn btn-sm', onClick: async () => {
        const draft = normalizeAppTest({ when: 'recovery-test-only' });
        const nameInp = h('input', { placeholder: 'Test name', onInput: (e) => { draft.name = e.target.value; } });
        const cmdInp = h('input', { placeholder: 'Command (optional)', onInput: (e) => { draft.command = e.target.value; } });
        const expInp = h('input', { placeholder: 'Expected result — what "passed" literally looks like', onInput: (e) => { draft.expected = e.target.value; } });
        const ok = await modal('Add app test', h('div', null,
          field('Name', nameInp), field('Command', cmdInp), field('Expected', expInp),
          h('div', { class: 'divider' }), gateFields(draft)),
        { wide: true, actions: [{ label: 'Add', kind: 'btn-primary', value: true }] });
        if (!ok || !draft.name.trim()) return;
        t.appTests.push(normalizeAppTest(draft));
        drawApps();
      } }, '＋ Add app test'),
      h('button', { class: 'btn btn-sm', title: 'Paste notes from a walkthrough with whoever owns the service', onClick: async () => {
        let comps = [];
        try { comps = (await api.get(`/w/${ws}/c/components`)).items || []; } catch { comps = []; }
        const added = await captureFromConversation({ ws, api, components: comps, defaults: { componentId: t.componentId || '' } });
        if (!added.length) return;
        t.appTests.push(...added);
        await save(true);
        toast(`Added ${added.length} check(s)`, 'ok');
        drawApps();
      } }, '＋ From a conversation')));
  };
  drawApps();

  // --- findings
  const findBox = h('div');
  const drawFindings = () => {
    findBox.innerHTML = '';
    if (!t.findings.length) findBox.append(h('p', { class: 'hint' }, 'No findings yet. A test with zero findings usually means the record was not written honestly.'));
    t.findings.forEach((f, i) => {
      findBox.append(h('div', { class: 'row', style: 'margin:6px 0;align-items:flex-start' },
        h('select', { style: 'width:auto', onChange: (e) => { f.severity = e.target.value; } },
          SEVERITIES.map((s) => h('option', { value: s, selected: f.severity === s }, s))),
        h('input', { value: esc(f.title), placeholder: 'What went wrong', style: 'flex:2;min-width:200px', onInput: (e) => { f.title = e.target.value; } }),
        h('input', { value: esc(f.ticket), placeholder: 'Ticket', style: 'width:130px', onInput: (e) => { f.ticket = e.target.value; } }),
        f.gapId
          ? badge(`gap: ${f.gapId}`, 'ok')
          : h('button', { class: 'btn btn-sm', title: 'Create a gap from this finding', onClick: async () => {
              if (!f.title.trim()) { toast('Give the finding a title first', 'err'); return; }
              try {
                const gap = await api.post(`/w/${ws}/c/gaps`, {
                  title: f.title, category: 'other', class: 'test-finding',
                  severity: f.severity || 'medium', componentId: '', status: 'open',
                  ticket: f.ticket || '', notes: `From test '${t.name}' (${t.date || ''}).`,
                });
                f.gapId = gap.id; await save(true);
                toast('Gap created', 'ok'); drawFindings();
              } catch (e) { toast(e.message, 'err'); }
            } }, '→ create gap'),
        h('button', { class: 'btn btn-sm', onClick: () => { t.findings.splice(i, 1); drawFindings(); } }, '✕')));
    });
    findBox.append(h('button', { class: 'btn btn-sm', onClick: () => { t.findings.push({ title: '', severity: 'high', gapId: '', ticket: '' }); drawFindings(); } }, '＋ Add finding'));
  };
  drawFindings();

  // --- record
  const recordTa = h('textarea', { style: 'min-height:320px;font-family:var(--mono);font-size:12.5px', onInput: (e) => { t.record = e.target.value; } }, esc(t.record));
  const genSkeleton = async () => {
    if (t.record && t.record.trim() && !(await confirmDialog('Replace the current record with a fresh skeleton?'))) return;
    t.record = recordSkeleton(t, runbook?.name);
    recordTa.value = t.record;
    toast('Skeleton generated — now write the ugly parts', 'ok');
  };

  el.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('a', { href: `#/${ws}/tests`, class: 'page-crumb' }, '← All tests'),
        h('h1', { style: 'margin-top:4px' }, t.name || '(unnamed test)'), headSub),
      h('div', { class: 'row' },
        statusSel,
        h('button', {
          class: 'btn btn-danger', onClick: async () => {
            if (!(await confirmDialog(`Delete test '${t.name}'?`))) return;
            try { await api.del(`/w/${ws}/c/tests/${t.id}`); toast('Test deleted'); navigate(`#/${ws}/tests`); }
            catch (e) { toast(e.message, 'err'); }
          },
        }, 'Delete'),
        h('button', { class: 'btn btn-primary', onClick: () => save(false) }, 'Save'))),
    aiActionRow({
      ws, api, label: 'AI', style: 'margin:0 0 16px',
      hint: 'Applying reloads this test from disk — click Save first so your marks and findings are not lost.',
      actions: [
        {
          label: 'Write the test record',
          title: 'Draft the markdown narrative from the timestamps, app-test results and findings — honest about failures',
          modalTitle: 'Test record',
          mode: 'operations',
          context: () => ({
            kind: 'test',
            id: t.id,
            extra: {
              liveEdits: { timestamps: t.timestamps, results: t.results, appTests: t.appTests, findings: t.findings, status: t.status },
              note: 'liveEdits may contain marks the user has not saved yet — prefer them over context.test where they differ.',
            },
          }),
          prompt: 'Write this test\'s record as ONE update operation on "tests" setting the "record" field to markdown. '
            + 'Build it from the timestamps, app-test results and findings that are actually present. Sections: Summary · '
            + 'App-level tests (table: test, critical, result) · What actually went wrong (in order — the misleading error, the '
            + 'wrong flag, the thing that was almost done; this is the section that earns the record) · What passed · Findings · '
            + 'Follow-ups. Quote RTA and RPA only from results, labelled as measured, and write "unmeasured" where they are '
            + 'null — never derive or estimate them. If a test failed, say so plainly in the first line of the summary. '
            + 'Do not invent events that are not in the data: where the record needs detail only the operator has, leave an '
            + 'explicit "(fill in: …)" prompt.',
        },
        {
          label: 'Turn findings into gaps',
          title: 'Promote this test\'s findings to tracked gap items',
          modalTitle: 'Findings → gaps',
          mode: 'operations',
          context: () => ({ kind: 'test', id: t.id, extra: { liveFindings: t.findings } }),
          prompt: 'Turn this test\'s findings into tracked gaps: one create operation on "gaps" per finding that does not already '
            + `have a gapId and is not already an open gap in the context. Each gap: title (the specific problem, not the symptom), `
            + `severity carried over from the finding, class, componentId when the finding clearly belongs to one component from `
            + `the inventory, status "open", ticket copied if present, and notes citing this test by name and date. `
            + 'Skip findings that are duplicates of each other or of an existing gap, and say which you skipped in notes.',
        },
        {
          label: 'Review this test',
          title: 'Audit: are the numbers measured, is the success bar real, were failures recorded honestly',
          modalTitle: `Review — ${t.name || 'test'}`,
          mode: 'review',
          reviewKind: 'test',
          reviewId: t.id,
        },
      ],
    }),
    t.scope ? card(h('h2', null, 'Scope'), h('p', { class: 'hint' }, t.scope)) : null,
    card(h('h2', null, 'Timestamps & results'), tsBox,
      h('div', { class: 'divider' }),
      // The path from "this test passed" to "these are the measured numbers",
      // made explicit — including when it is closed, and why.
      h('div', { class: 'row', style: 'align-items:flex-start' },
        h('button', {
          class: t.status === 'passed' ? 'btn btn-primary' : 'btn',
          disabled: t.status !== 'passed',
          title: t.status === 'passed' ? '' : `Only a passed run can set the workspace's measured numbers`,
          onClick: recordAsMeasured,
        }, 'Record as this workspace’s measured numbers'),
        h('div', { class: 'hint', style: 'flex:1;min-width:220px' },
          t.status === 'passed'
            ? h('span', null,
              'The workspace will cite ', h('strong', null, t.name || 'this test'),
              `${t.date ? ` (${t.date})` : ''} — passed — beside the numbers everywhere they appear.`)
            : h('span', null,
              'Closed because this test is ', h('strong', null, t.status || 'not passed'), '. ',
              'A run that did not reach the success bar has a time to failure, not a recovery time, '
              + 'so it can never become a measured number. Mark it passed only when a real business '
              + 'transaction succeeded end to end.'))),
      // Anyone can still write a number into Settings by hand; say plainly what
      // that number will be labelled when they do.
      h('p', { class: 'hint', style: 'margin:10px 0 0' },
        'A number typed straight into ', h('a', { href: `#/${ws}/settings` }, 'Settings'),
        ' stays labelled “recorded by hand, not from a test” — it is never shown as measured or achieved.')),
    card(h('h2', null, 'App-level verification'), appBox),
    card(h('h2', null, 'Findings'), findBox),
    card(h('h2', null, 'Test record'),
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('button', { class: 'btn btn-sm', onClick: genSkeleton }, 'Generate skeleton'),
        h('span', { class: 'hint' }, 'Write it the same day, including the ugly parts.')),
      recordTa),
  );

  const snap = await snapshot(api, ws).catch(() => ({}));
  el.append(nextStepFor('tests', snap, ws, t.status === 'passed' ? {} : {
    title: `This test is ${t.status}`,
    body: t.status === 'failed'
      ? 'A failed test is the most valuable one you will run. Turn each finding into a tracked gap so it cannot be quietly forgotten.'
      : 'Mark T0 when the recovery starts and T1 when a real business transaction succeeds — that subtraction is the only honest recovery time.',
    action: t.status === 'failed'
      ? { label: 'Back to all tests', href: `#/${ws}/tests` }
      : { label: 'Check the preflight gate', href: `#/${ws}/checklists` },
    alt: { label: 'Back to Overview', href: `#/${ws}/dashboard` },
  }));
}

export default {
  title: 'Tests',
  async render(el, ctx) {
    // `pre-cutover` is a view, not a test id — no workspace can hold a test
    // whose id is that, because ids are generated with a `tst_` prefix.
    if (ctx.params && ctx.params[0] === 'pre-cutover') return renderPreCutover(el, ctx);
    if (ctx.params && ctx.params[0]) return renderDetail(el, ctx, ctx.params[0]);
    return renderList(el, ctx);
  },
};
