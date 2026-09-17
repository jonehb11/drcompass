// Tests & exercises: plan from the app-test catalog, execute with timestamps,
// findings → gaps, same-day record, honest RTA/RPA numbers.
import { h, card, badge, empty, field, modal, toast, confirmDialog, pageHead, btn, snapshot, invalidateSnapshot } from '../ui.js';
import { aiActionRow } from '../ai-actions.js';
import { crumbFor, nextStepFor } from '../onboarding.js';
import { measuredNumbers, describe } from '../measured.js';

const TYPES = ['recovery-test', 'game-day', 'tabletop', 'component-test', 'chaos'];
const STATUSES = ['planned', 'in-progress', 'passed', 'failed', 'canceled'];
const STATUS_KIND = { planned: 'accent', 'in-progress': 'warn', passed: 'ok', failed: 'err', canceled: '' };
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const SEV_KIND = { blocker: 'err', high: 'warn', medium: '', low: '' };

const esc = (v) => (v === null || v === undefined) ? '' : String(v);
const minsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
const fmtTs = (ts) => ts ? new Date(ts).toLocaleString() : '—';

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
        cb, h('div', null, h('div', null, t.name, ' ', t.critical ? badge('critical', 'err') : null),
          h('div', { class: 'hint' }, t.hint || ''))) };
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
    const appTests = checks.filter((c) => c.cb.checked).map(({ t }) => ({
      name: t.name, command: t.command || '', expected: t.expected || '', componentId: '', critical: !!t.critical, result: null,
    }));
    for (const c of customs) if (c.value.trim()) appTests.push({ name: c.value.trim(), command: '', expected: '', componentId: '', critical: false, result: null });
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

  el.append(pageHead({
    title: 'Tests',
    purpose: 'Rehearse the recovery and record what it actually took — every recovery time you quote should trace back to a row here.',
    crumb: crumbFor('tests', ws),
    actions: [btn({ label: '＋ Plan test', kind: 'btn-primary', onClick: planTest })],
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
    t.appTests.forEach((a, i) => {
      const mark = (r) => { a.result = a.result === r ? null : r; save(true); drawApps(); };
      appBox.append(h('div', { class: 'card', style: 'margin-bottom:8px;padding:10px 14px' },
        h('div', { class: 'row' },
          a.result === 'pass' ? badge('PASS', 'ok') : a.result === 'fail' ? badge('FAIL', 'err') : badge('—'),
          h('strong', null, a.name), a.critical ? badge('critical', 'err') : null,
          h('span', { class: 'spacer' }),
          h('button', { class: `btn btn-sm ${a.result === 'pass' ? 'btn-on' : ''}`, onClick: () => mark('pass') }, '✓ pass'),
          h('button', { class: `btn btn-sm ${a.result === 'fail' ? 'btn-danger' : ''}`, onClick: () => mark('fail') }, '✕ fail'),
          h('button', { class: 'btn btn-sm', title: 'Remove', onClick: () => { t.appTests.splice(i, 1); drawApps(); } }, '🗑')),
        a.command ? h('pre', { style: 'margin:8px 0 4px' }, h('code', null, a.command)) : null,
        a.expected ? h('p', { class: 'hint' }, `Expected: ${a.expected}`) : null));
    });
    appBox.append(h('button', { class: 'btn btn-sm', onClick: async () => {
      const nameInp = h('input', { placeholder: 'Test name' });
      const cmdInp = h('input', { placeholder: 'Command (optional)' });
      const expInp = h('input', { placeholder: 'Expected result' });
      const ok = await modal('Add app test', h('div', null, field('Name', nameInp), field('Command', cmdInp), field('Expected', expInp)),
        { actions: [{ label: 'Add', kind: 'btn-primary', value: true }] });
      if (!ok || !nameInp.value.trim()) return;
      t.appTests.push({ name: nameInp.value.trim(), command: cmdInp.value, expected: expInp.value, componentId: '', critical: false, result: null });
      drawApps();
    } }, '＋ Add app test'));
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
    if (ctx.params && ctx.params[0]) return renderDetail(el, ctx, ctx.params[0]);
    return renderList(el, ctx);
  },
};
