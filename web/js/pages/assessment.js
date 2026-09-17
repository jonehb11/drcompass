// Assessment — an honest read on DR maturity, scored from the answers AND from
// what the workspace can actually prove. Autosaves; re-scores live.
//
// Deliberately NOT here: the "What to do next" roadmap card and the three
// "Ask AI about this workspace" prompts. Both were rendered identically on the
// Overview from the same data — the same list twice, in two places, is worse
// than the list once in the right place.
import {
  h, card, badge, btn, pageHead, cardHead, term, toast, snapshot,
} from '../ui.js';
import { crumbFor, nextStepFor } from '../onboarding.js';

// The server's signal labels are engineer-speak; say them the way an owner would.
const SIGNAL_LABEL = {
  'Components inventoried': 'Resources written down',
  'Dependencies mapped': 'Dependencies recorded',
  'Verification defined': 'Resources with a check',
  'Open blocker gaps': 'Open blockers',
  'Gap notes on components': 'Notes not yet tracked as gaps',
  'Runbooks written': 'Runbooks written',
  'Tests passed': 'Tests passed',
  'RTO target': 'Recovery time target',
  'Last achieved RTA': 'Recovery time achieved',
};
const SIGNAL_TERM = {
  'Open blocker gaps': 'blocker',
  'Verification defined': 'verification',
  'Dependencies mapped': 'dependency mapping',
  'RTO target': 'rto',
  'Last achieved RTA': 'rta',
};

const STYLE = `
  .asmt-level { display:flex; align-items:center; gap:18px; }
  .asmt-level .lvl-num { font-size:44px; font-weight:750; letter-spacing:-0.03em; line-height:1; color:var(--accent); }
  .asmt-level .lvl-label { font-size:17px; font-weight:650; }
  .asmt-level .lvl-sub { font-size:12.5px; color:var(--muted); margin-top:4px; line-height:1.5; }
  .asmt-pillar { margin:10px 0; }
  .asmt-pillar .row-top { display:flex; justify-content:space-between; gap:10px; font-size:12.5px; margin-bottom:4px; }
  .asmt-pillar .row-top .pct { color:var(--muted); white-space:nowrap; }
  .asmt-q { padding:15px 0; border-bottom:1px solid rgba(42,50,66,.55); }
  .asmt-q:last-child { border-bottom:0; }
  .asmt-q .q-text { font-weight:600; margin-bottom:3px; }
  .asmt-q .q-help { font-size:12.5px; color:var(--muted); margin-bottom:10px; max-width:76ch; line-height:1.5; }
  .asmt-seg { display:grid; gap:6px; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  .asmt-opt { text-align:left; cursor:pointer; background:var(--bg2); border:1px solid var(--border);
    border-radius:8px; padding:8px 10px; color:var(--muted); font:12px/1.4 var(--sans); }
  .asmt-opt .n { display:block; font:700 10.5px var(--mono); color:var(--muted); margin-bottom:3px; letter-spacing:.04em; }
  .asmt-opt:hover { border-color:#3a4557; color:var(--text); }
  .asmt-opt.sel { background:var(--accent-soft); border-color:var(--accent); color:var(--text); }
  .asmt-opt.sel .n { color:var(--accent); }
  .asmt-saved { font-size:11.5px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .asmt-prog-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:12px; }
  .asmt-prog-row .progress { flex:1; min-width:180px; }
  .asmt-prog-n { font:700 12px var(--mono); color:var(--muted); white-space:nowrap; }
`;

export default {
  title: 'Assessment',
  async render(el, { ws, api }) {
    const [meta, qres, stored, report0, snap] = await Promise.all([
      api.get(`/w/${ws}/workspace`).catch(() => ({})),
      api.get(`/w/${ws}/assessment/questions`),
      api.get(`/w/${ws}/assessment`),
      api.get(`/w/${ws}/assessment/report`),
      snapshot(api, ws).catch(() => ({})),
    ]);
    const { questions, pillars } = qres;
    const answers = stored.answers || {};
    const qTotal = questions.length;

    const summaryBox = h('div');
    const footBox = h('div');
    const savedFlag = h('span', { class: 'asmt-saved' });
    const progBar = h('div', { class: 'progress' }, h('div', { style: 'width:0%' }));
    const progNum = h('span', { class: 'asmt-prog-n' });

    const firstUnanswered = () => questions.find((q) => !Number.isInteger(answers[q.id]));

    function renderProgress(r) {
      const n = r?.answeredTotal ?? 0;
      const pct = qTotal ? Math.round((n / qTotal) * 100) : 0;
      progBar.firstChild.setAttribute('style', `width:${pct}%`);
      progNum.textContent = `${n} of ${qTotal} answered`;
    }

    function signalRow(s) {
      const label = SIGNAL_LABEL[s.label] || s.label;
      const tk = SIGNAL_TERM[s.label];
      return h('div', { class: 'signal' },
        h('span', { class: 'signal-k' }, tk ? term(tk, label) : label),
        h('span', { class: `signal-v ${s.kind === 'ok' ? 'ok' : s.kind === 'err' ? 'err' : 'warn'}` }, s.value));
    }

    function renderSummary(r) {
      renderProgress(r);
      const answered = r.answeredTotal ?? 0;
      // Weakest first — the order IS the advice, so no sentence is needed to
      // explain that the weakest bar is where effort pays off.
      const pillars = [...(r.pillars || [])].sort((a, b) =>
        (a.answeredCount ? a.score : -1) - (b.answeredCount ? b.score : -1) || String(a.name).localeCompare(String(b.name)));
      const weakest = pillars.find((p) => p.answeredCount) || null;
      summaryBox.replaceChildren(
        h('div', { class: 'grid cols-2', style: 'align-items:stretch' },
          card(
            cardHead('Where you stand'),
            h('div', { class: 'asmt-level' },
              h('div', { class: 'lvl-num' }, String(r.level)),
              h('div', null,
                h('div', { class: 'lvl-label' }, r.levelLabel),
                h('div', { class: 'lvl-sub' },
                  answered === 0
                    ? 'Answer below to place yourself: 0 (nothing in place) to 5 (proven in production).'
                    : h('span', null, 'Your ', term('maturity level'), ' — above 2 has to be earned with tests that passed.')))),
            (r.signals || []).length
              ? h('div', { style: 'margin-top:16px' },
                  h('div', { class: 'hint', style: 'margin-bottom:8px; font-weight:650' }, 'Measured from your workspace, not from your answers'),
                  h('div', { class: 'signal-grid' }, (r.signals || []).map(signalRow)))
              : null),
          card(
            cardHead('The six parts of a DR program', h('span', { class: 'hint' }, 'weakest first')),
            pillars.map((p) => h('div', { class: 'asmt-pillar' },
              h('div', { class: 'row-top' },
                h('span', null, p.name, weakest && p === weakest ? badge('weakest', 'warn') : null),
                h('span', { class: 'pct' }, p.answeredCount === 0 ? 'not started' : `${p.score}%`)),
              h('div', { class: 'progress' },
                h('div', { style: `width:${p.answeredCount ? p.score : 0}%` })))),
          ),
        ),
      );

      // Never a dead end. The target is the report's own top action when there
      // is one, otherwise the program's single next action — both from the one
      // progression model in onboarding.js.
      // Exactly one primary action per view: the header button owns it while
      // there are questions left to answer, this band owns it once there are not.
      const band = nextStepFor('assessment', { ...snap, report: r }, ws, answered >= qTotal ? {} : {
        title: 'You can stop any time',
        body: `Answers save as you pick them. ${qTotal - answered} question${qTotal - answered > 1 ? 's' : ''} left.`,
      });
      if (answered >= qTotal) band.querySelector('.nextstep-acts .btn')?.classList.add('btn-primary');
      footBox.replaceChildren(band);
    }

    let saveTimer = null;
    async function save() {
      savedFlag.replaceChildren(h('span', { class: 'spin' }), 'Saving…');
      try {
        await api.put(`/w/${ws}/assessment`, { answers });
        const r = await api.get(`/w/${ws}/assessment/report`);
        renderSummary(r);
        savedFlag.replaceChildren(h('span', { class: 'state-dot ok' }), 'All answers saved');
        window.dispatchEvent(new CustomEvent('drcompass:data-changed'));
      } catch (e) {
        savedFlag.replaceChildren(h('span', { class: 'state-dot err' }), 'Not saved');
        toast(`Could not save: ${e.message}`, 'err');
      }
    }
    function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 350); }

    function questionBlock(q) {
      const opts = (q.levels || []).map((lbl, i) => {
        const b = h('button', {
          class: `asmt-opt${answers[q.id] === i ? ' sel' : ''}`, type: 'button',
          'aria-pressed': answers[q.id] === i ? 'true' : 'false',
        }, h('span', { class: 'n' }, String(i)), lbl);
        b.addEventListener('click', () => {
          answers[q.id] = i;
          for (const sib of b.parentElement.children) { sib.classList.remove('sel'); sib.setAttribute('aria-pressed', 'false'); }
          b.classList.add('sel');
          b.setAttribute('aria-pressed', 'true');
          queueSave();
        });
        return b;
      });
      return h('div', { class: 'asmt-q', id: `q-${q.id}` },
        h('div', { class: 'q-text' }, q.text),
        q.help ? h('div', { class: 'q-help' }, q.help) : null,
        h('div', { class: 'asmt-seg', role: 'group', 'aria-label': q.text }, opts));
    }

    const pillarCards = pillars.map((p) => {
      const qs = questions.filter((q) => q.pillar === p.id);
      const done = qs.filter((q) => Number.isInteger(answers[q.id])).length;
      // The 0→4 scale legend is stated ONCE, above the questions — it used to be
      // repeated on all six cards.
      return card(
        cardHead(h('h2', null, p.name), badge(`${done}/${qs.length} answered`, done === qs.length ? 'ok' : '')),
        qs.map(questionBlock));
    });

    // ------------------------------------------------------------------ layout
    el.append(
      h('style', null, STYLE),
      pageHead({
        title: 'Assessment',
        purpose: 'Score the six parts of your DR program honestly, and see which one to fix first.',
        crumb: crumbFor('assessment', ws),
        actions: [
          btn({
            label: firstUnanswered() ? 'Answer the next question' : 'Jump to first unanswered',
            kind: firstUnanswered() ? 'btn-primary' : '',
            onClick: () => {
              const q = firstUnanswered();
              const node = q && document.getElementById(`q-${q.id}`);
              if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.querySelector('button')?.focus(); }
              else toast('Every question is answered.', 'ok');
            },
          }),
        ],
      }),
      card(h('div', { class: 'asmt-prog-row' }, progBar, progNum, savedFlag)),
      h('div', { style: 'height:var(--s3)' }),
      summaryBox,
      h('div', { class: 'section-head' },
        h('h2', null, 'The questions'),
        h('div', { class: 'section-purpose' },
          'Pick what is true ', h('strong', null, 'today'), ' — 0 nothing in place, 4 as good as it gets. Answers save themselves.')),
      ...pillarCards,
      footBox,
    );

    savedFlag.replaceChildren(h('span', { class: 'state-dot ok' }), 'Answers save automatically');
    renderSummary(report0);
  },
};
