// Dashboard — the DR program cockpit.
import { h, card, badge, empty } from '../ui.js';

const LAYERS = [
  ['L0', 'Guardrails & backups'], ['L1', 'Recovery launch'], ['L2', 'Platform'],
  ['L3', 'Data & secrets'], ['L4', 'Applications'], ['L5', 'Edge reachability'],
  ['L6', 'Functional success bar'], ['L7', 'Live traffic cutover'],
];
const SEV_ORDER = { blocker: 0, high: 1, medium: 2, low: 3 };
const STATUS_KIND = { passed: 'ok', failed: 'err', 'in-progress': 'accent', planned: '', canceled: '' };

const STYLE = `
  .dash-kpis { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); margin-bottom:14px; }
  .dash-kpis .card { padding:14px 16px; }
  .kpi-sub { font-size:11.5px; color:var(--muted); margin-top:3px; }
  .kv-ok { color:var(--ok); } .kv-warn { color:var(--warn); } .kv-err { color:var(--err); } .kv-muted { color:var(--muted); }
  .loop { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .loop .arrow { color:var(--muted); font-size:12px; }
  .loop-step { display:flex; align-items:center; gap:7px; padding:7px 12px; border-radius:999px;
    background:var(--panel2); border:1px solid var(--border); color:var(--muted); font:600 12.5px var(--sans); }
  .loop-step:hover { border-color:#3a4557; color:var(--text); }
  .loop-step.done { background:var(--ok-soft); border-color:rgba(63,178,127,.35); color:var(--ok); }
  .loop-step.current { background:var(--accent-soft); border-color:rgba(79,143,247,.5); color:#bcd4fb; }
  .loop-step .dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
  .dash-action { display:block; background:var(--panel2); border:1px solid var(--border); border-radius:10px;
    padding:11px 13px; color:var(--text); margin-bottom:8px; }
  .dash-action:hover { border-color:var(--accent); }
  .dash-action .t { font-weight:650; font-size:13px; }
  .dash-action .w { font-size:12px; color:var(--muted); margin-top:2px; line-height:1.45; }
  .layer-bar { display:flex; align-items:center; gap:8px; }
  .layer-bar .progress { flex:1; }
  .start-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); margin-top:12px; }
  .start-step { background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:14px 16px; display:block; color:var(--text); }
  .start-step:hover { border-color:var(--accent); }
  .start-step .num { font-size:11px; font-weight:700; color:var(--accent); letter-spacing:.06em; text-transform:uppercase; }
  .start-step .t { font-weight:650; margin:3px 0 4px; }
  .start-step .d { font-size:12.5px; color:var(--muted); line-height:1.45; }
`;

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return String(d); }
}

export default {
  title: 'Dashboard',
  async render(el, { ws, api }) {
    const get = (p) => api.get(p).catch(() => null);
    const [meta, compRes, gapRes, testRes, rbkRes, chkRes, report] = await Promise.all([
      api.get(`/w/${ws}/workspace`),
      get(`/w/${ws}/c/components`), get(`/w/${ws}/c/gaps`), get(`/w/${ws}/c/tests`),
      get(`/w/${ws}/c/runbooks`), get(`/w/${ws}/c/checklists`),
      get(`/w/${ws}/assessment/report`),
    ]);
    const comps = compRes?.items || [];
    const gaps = gapRes?.items || [];
    const tests = testRes?.items || [];
    const runbooks = rbkRes?.items || [];
    const checklists = chkRes?.items || [];
    const obj = meta.objectives || {};

    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, meta.name || 'Dashboard'),
          h('div', { class: 'sub' },
            `${meta.regions?.primary || '?'} → ${meta.regions?.recovery || '?'} · strategy: ${meta.strategy || 'unset'}`))),
    );

    // ---------- brand-new workspace: warm walkthrough ----------
    const brandNew = comps.length === 0 && runbooks.length === 0 && tests.length === 0 && (report?.answeredTotal ?? 0) === 0;
    if (brandNew) {
      el.append(card(
        h('h2', null, 'Welcome — start here'),
        h('p', null,
          'This workspace is empty, which is the right place to start. DR Compass takes you from "we should have a DR plan" to a tested, evidence-backed recovery program. Three steps to get moving:'),
        h('div', { class: 'start-grid' },
          h('a', { class: 'start-step', href: `#/${ws}/assessment` },
            h('div', { class: 'num' }, 'Step 1'),
            h('div', { class: 't' }, 'Take the assessment'),
            h('div', { class: 'd' }, '18 honest questions place you on the maturity ladder and generate your personal roadmap. ~10 minutes.')),
          h('a', { class: 'start-step', href: `#/${ws}/inventory` },
            h('div', { class: 'num' }, 'Step 2'),
            h('div', { class: 't' }, 'Build the inventory'),
            h('div', { class: 'd' }, 'List what must come back after a disaster — services, databases, queues, secrets, third parties — and how they depend on each other.')),
          h('a', { class: 'start-step', href: `#/${ws}/learn` },
            h('div', { class: 'num' }, 'Step 3'),
            h('div', { class: 't' }, 'Learn the method'),
            h('div', { class: 'd' }, 'Restore layers, RTO vs RTA, the test loop — short reads that explain how the whole program fits together.'))),
        h('p', { class: 'hint', style: 'margin-top:12px' },
          'Prefer to explore first? The example workspace "Acme Pharmacy" in the workspace switcher shows a fully built-out program.'),
      ));
      return;
    }

    // ---------- KPI hero row ----------
    const rto = obj.rtoMinutes, rta = obj.rtaMinutes, rpo = obj.rpoMinutes, rpa = obj.rpaMinutes;
    const timeKpi = (achieved, target, aName, tName) => {
      if (achieved === null || achieved === undefined) {
        return { value: 'unmeasured', cls: 'kv-muted', sub: target != null ? `${tName} target ${target} min — no test has measured ${aName} yet` : `no ${tName} target, no measurement` };
      }
      if (target === null || target === undefined) return { value: `${achieved} min`, cls: 'kv-warn', sub: `${aName} measured, but no ${tName} target to compare against` };
      const cls = achieved <= target ? 'kv-ok' : achieved <= target * 1.5 ? 'kv-warn' : 'kv-err';
      return { value: `${achieved} / ${target}`, cls, sub: `${aName} achieved vs ${tName} target (min)${obj.approved ? '' : ' · targets not approved'}` };
    };
    const rtaK = timeKpi(rta, rto, 'RTA', 'RTO');
    const rpaK = timeKpi(rpa, rpo, 'RPA', 'RPO');
    const openBlockers = gaps.filter((g) => g.severity === 'blocker' && g.status !== 'resolved' && g.status !== 'accepted');
    const scope = { yes: 0, partial: 0, no: 0, unknown: 0 };
    for (const c of comps) scope[c.inRecoveryScope in scope ? c.inRecoveryScope : 'unknown']++;
    const datedTests = tests.filter((t) => t.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const lastRun = datedTests.find((t) => ['passed', 'failed', 'in-progress'].includes(t.status));

    const kpi = (value, label, cls = '', sub = '') => card(h('div', { class: 'kpi' },
      h('div', { class: `kpi-value ${cls}` }, value),
      h('div', { class: 'kpi-label' }, label),
      sub ? h('div', { class: 'kpi-sub' }, sub) : null));

    el.append(h('div', { class: 'dash-kpis' },
      kpi(report ? `${report.level} — ${report.levelLabel}` : '—', 'Maturity level', '',
        report ? `${report.answeredTotal}/${report.questionCount} assessment answers` : 'assessment unavailable'),
      kpi(rtaK.value, 'Recovery time (RTA vs RTO)', rtaK.cls, rtaK.sub),
      kpi(rpaK.value, 'Data loss (RPA vs RPO)', rpaK.cls, rpaK.sub),
      kpi(String(openBlockers.length), 'Open blocker gaps', openBlockers.length ? 'kv-err' : 'kv-ok',
        openBlockers.length ? 'must close or accept before go-live' : 'nothing blocking'),
      kpi(String(comps.length), 'Components', '',
        `in scope: ${scope.yes} yes · ${scope.partial} partial · ${scope.no} no`),
      kpi(lastRun ? fmtDate(lastRun.date) : 'never', 'Last test run', lastRun ? (lastRun.status === 'passed' ? 'kv-ok' : lastRun.status === 'failed' ? 'kv-err' : '') : 'kv-muted',
        lastRun ? `${lastRun.name || lastRun.type} — ${lastRun.status}` : 'no test has been run yet'),
    ));

    // ---------- "Where you are" program loop ----------
    const passed = tests.filter((t) => t.status === 'passed');
    const phase0 = checklists.filter((c) => c.kind === 'phase0');
    const phase0Done = phase0.some((c) => (c.items || []).length > 0 && c.items.every((i) => i.done));
    const gameDayDone = passed.some((t) => t.type === 'game-day');
    const steps = [
      { name: 'Inventory', page: 'inventory', done: comps.length > 5 },
      { name: 'Strategy', page: 'settings', done: !!meta.strategy && rto !== null && rto !== undefined },
      { name: 'Runbook', page: 'runbooks', done: runbooks.length > 0 },
      { name: 'Phase 0', page: 'checklists', done: phase0Done },
      { name: 'Test loop', page: 'tests', done: passed.length >= 1 },
      { name: 'Game day', page: 'tests', done: gameDayDone },
      { name: 'Decision gate', page: 'settings', done: gameDayDone && !!obj.approved && openBlockers.length === 0 },
    ];
    let currentSeen = false;
    const loopChips = [];
    steps.forEach((s, i) => {
      const isCurrent = !s.done && !currentSeen && (currentSeen = true);
      if (i) loopChips.push(h('span', { class: 'arrow' }, '→'));
      loopChips.push(h('a', { class: `loop-step ${s.done ? 'done' : isCurrent ? 'current' : ''}`, href: `#/${ws}/${s.page}`, title: s.done ? 'done' : isCurrent ? 'you are here' : 'not started' },
        h('span', { class: 'dot' }), s.name, s.done ? '✓' : null));
    });
    el.append(card(
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('h2', { style: 'margin-bottom:0' }, 'Where you are in the program'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, 'green = done · blue = current step')),
      h('div', { class: 'loop' }, loopChips)));

    // ---------- middle grid: next actions + readiness by layer ----------
    const layerRows = LAYERS.map(([id, name]) => {
      const inLayer = comps.filter((c) => c.restoreLayer === id);
      const verified = inLayer.filter((c) => c.verification && c.verification.command);
      const pctV = inLayer.length ? Math.round((verified.length / inLayer.length) * 100) : 0;
      return h('tr', null,
        h('td', null, badge(id, 'accent'), ' ', h('span', { style: 'font-size:12.5px' }, name)),
        h('td', { style: 'text-align:right; white-space:nowrap' }, String(inLayer.length)),
        h('td', { style: 'min-width:140px' }, inLayer.length
          ? h('div', { class: 'layer-bar' },
              h('div', { class: 'progress' }, h('div', { style: `width:${pctV}%; background:${pctV >= 60 ? 'var(--ok)' : pctV > 0 ? 'var(--warn)' : 'var(--err)'}` })),
              h('span', { class: 'hint', style: 'white-space:nowrap' }, `${verified.length}/${inLayer.length}`))
          : h('span', { class: 'hint' }, '—')));
    });
    const unlayered = comps.filter((c) => !c.restoreLayer).length;

    el.append(h('div', { class: 'grid cols-2', style: 'margin-top:14px; align-items:start' },
      card(
        h('h2', null, 'Next actions'),
        report && (report.nextActions || []).length
          ? report.nextActions.map((a) => h('a', { class: 'dash-action', href: `#/${ws}/${a.page}` },
              h('div', { class: 't' }, a.title), h('div', { class: 'w' }, a.why)))
          : h('div', null, empty('Take the assessment to generate your roadmap.'),
              h('div', { style: 'text-align:center' }, h('a', { class: 'btn btn-primary', href: `#/${ws}/assessment` }, 'Start assessment')))),
      card(
        h('h2', null, 'Readiness by restore layer'),
        h('p', { class: 'hint', style: 'margin-bottom:8px' },
          'Components per layer, and how many have a verification defined — the bar is your ability to gate each layer.'),
        h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Layer'), h('th', { style: 'text-align:right' }, 'Components'), h('th', null, 'Verified'))),
          h('tbody', null, layerRows)),
        unlayered ? h('p', { class: 'hint', style: 'margin-top:8px' },
          `${unlayered} component${unlayered > 1 ? 's have' : ' has'} no restore layer assigned — `,
          h('a', { href: `#/${ws}/inventory` }, 'fix in Inventory')) : null),
    ));

    // ---------- bottom grid: gaps + tests ----------
    const topGaps = [...gaps]
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
        || (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
      .slice(0, 5);
    const compGapNotes = comps.filter((c) => (c.gaps || []).length);
    const recentTests = datedTests.slice(0, 5);

    el.append(h('div', { class: 'grid cols-2', style: 'margin-top:14px; align-items:start' },
      card(
        h('div', { class: 'row', style: 'margin-bottom:8px' },
          h('h2', { style: 'margin-bottom:0' }, 'Top gaps'),
          h('span', { class: 'spacer' }),
          h('a', { class: 'hint', href: `#/${ws}/tests` }, 'gaps come from tests →')),
        topGaps.length
          ? h('table', { class: 'table' }, h('tbody', null, topGaps.map((g) => h('tr', null,
              h('td', null, badge(g.severity || 'gap', g.severity === 'blocker' ? 'err' : g.severity === 'high' ? 'warn' : '')),
              h('td', null, g.title || '(untitled)',
                g.status && g.status !== 'open' ? h('span', { class: 'hint' }, `  · ${g.status}`) : null)))))
          : compGapNotes.length
            ? h('div', null,
                h('p', { class: 'hint', style: 'margin-bottom:8px' }, `No tracked gap items yet, but ${compGapNotes.length} component${compGapNotes.length > 1 ? 's carry' : ' carries'} gap notes:`),
                h('table', { class: 'table' }, h('tbody', null, compGapNotes.slice(0, 5).map((c) => h('tr', null,
                  h('td', null, h('a', { href: `#/${ws}/inventory` }, c.name)),
                  h('td', { class: 'hint' }, (c.gaps || [])[0]))))))
            : empty('No gaps recorded. Run a test — it will find some.')),
      card(
        h('div', { class: 'row', style: 'margin-bottom:8px' },
          h('h2', { style: 'margin-bottom:0' }, 'Tests'),
          h('span', { class: 'spacer' }),
          h('a', { class: 'hint', href: `#/${ws}/tests` }, 'all tests →')),
        recentTests.length
          ? h('table', { class: 'table' }, h('tbody', null, recentTests.map((t) => h('tr', null,
              h('td', null, h('a', { href: `#/${ws}/tests` }, t.name || t.type || 'test'),
                h('div', { class: 'hint' }, `${t.type || ''}${t.results?.rtaMinutes != null ? ` · RTA ${t.results.rtaMinutes} min` : ''}`)),
              h('td', { style: 'white-space:nowrap' }, fmtDate(t.date)),
              h('td', null, badge(t.status || 'planned', STATUS_KIND[t.status] || ''))))))
          : h('div', null, empty('No tests yet — an untested plan is a hypothesis.'),
              h('div', { style: 'text-align:center' }, h('a', { class: 'btn', href: `#/${ws}/tests` }, 'Plan a test')))),
    ));
  },
};
