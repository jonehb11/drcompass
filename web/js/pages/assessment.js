// Assessment — an honest read on DR maturity, scored from the answers AND from
// what the workspace can actually prove. Autosaves; re-scores live.
import {
  h, card, badge, empty, btn, pageHead, cardHead, term, toast, nextStep, aiRow, fmtMinutes,
} from '../ui.js';

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
    const [meta, qres, stored, report0] = await Promise.all([
      api.get(`/w/${ws}/workspace`).catch(() => ({})),
      api.get(`/w/${ws}/assessment/questions`),
      api.get(`/w/${ws}/assessment`),
      api.get(`/w/${ws}/assessment/report`),
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
                    ? h('span', null, 'Answer the questions below to place yourself on the ladder — 0 (nothing in place) to 5 (proven in production). Nothing is shared anywhere; this is for you.')
                    : h('span', null,
                        'Your ', term('maturity level'), '. Anything above 2 has to be earned with tests that actually passed, so answering optimistically will not move it.')))),
            (r.signals || []).length
              ? h('div', { style: 'margin-top:16px' },
                  h('div', { class: 'hint', style: 'margin-bottom:8px; font-weight:650' }, 'Measured from your workspace, not from your answers'),
                  h('div', { class: 'signal-grid' }, (r.signals || []).map(signalRow)))
              : null),
          card(
            cardHead('The six parts of a DR program'),
            h('p', { class: 'hint', style: 'margin-bottom:10px' }, 'The weakest bar is where the next bit of effort pays off most.'),
            (r.pillars || []).map((p) => h('div', { class: 'asmt-pillar' },
              h('div', { class: 'row-top' },
                h('span', null, p.name),
                h('span', { class: 'pct' }, p.answeredCount === 0 ? 'not started' : `${p.score}%`)),
              h('div', { class: 'progress' },
                h('div', { style: `width:${p.answeredCount ? p.score : 0}%` })))),
          ),
        ),
        (r.nextActions || []).length
          ? h('div', { style: 'margin-top:var(--s3)' }, card(
              cardHead('What to do next'),
              h('p', { class: 'hint', style: 'margin-bottom:10px' },
                'The highest-value moves given your weakest areas. Each one opens the page where the work happens — the same list appears on your Overview.'),
              h('div', { class: 'act-list' },
                r.nextActions.map((a, i) => h('a', { class: 'act-item', href: `#/${ws}/${a.page}` },
                  h('span', { class: 'act-n' }, String(i + 1)),
                  h('span', null, h('span', { class: 'act-t' }, a.title), h('span', { class: 'act-w' }, a.why)))))))
          : null,
      );

      // Never a dead end: say what this score means you should do now.
      const top = (r.nextActions || [])[0];
      footBox.replaceChildren(nextStep({
        title: answered >= qTotal ? 'Scored. Now go and change the score.' : 'You can stop any time',
        body: answered >= qTotal
          ? 'A score only moves when the underlying work does. Start with the first item above, then come back and re-score after your next test.'
          : `Answers are saved as you pick them, so you can leave and come back. ${qTotal - answered} question${qTotal - answered > 1 ? 's' : ''} left.`,
        action: top
          ? { label: top.title, href: `#/${ws}/${top.page}` }
          : { label: 'Back to Overview', href: `#/${ws}/dashboard` },
        alt: { label: 'Back to Overview', href: `#/${ws}/dashboard` },
      }));
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
      return card(
        cardHead(h('h2', null, p.name), badge(`${done}/${qs.length} answered`, done === qs.length ? 'ok' : '')),
        h('div', { class: 'asmt-scale' },
          h('b', null, '0'), 'nothing in place', h('span', null, '→'), h('b', null, '4'), 'as good as it gets',
          h('span', { class: 'spacer' }), h('span', null, 'Pick what is true today, not what is planned.')),
        qs.map(questionBlock));
    });

    // ------------------------------------------------------------------ layout
    const obj = meta?.objectives || {};
    el.append(
      h('style', null, STYLE),
      pageHead({
        title: 'Assessment',
        purpose: 'Where am I? — an honest read on your recovery program, and the shortest path to making it better.',
        actions: [
          btn({
            label: 'Jump to first unanswered', size: 'btn-sm',
            onClick: () => {
              const q = firstUnanswered();
              const node = q && document.getElementById(`q-${q.id}`);
              if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.querySelector('button')?.focus(); }
              else toast('Every question is answered.', 'ok');
            },
          }),
        ],
      }),
      card(
        h('p', null,
          `${qTotal} questions, six parts of a DR program, about ten minutes. Pick the description that matches `,
          h('strong', null, 'today'), ' — not the plan, not the intention. Your answers are scored against what this workspace can actually prove, so an optimistic answer will not flatter the result.'),
        h('div', { class: 'asmt-prog-row' }, progBar, progNum, savedFlag),
        h('p', { class: 'hint', style: 'margin-top:10px' },
          'Not sure what ', term('rto'), ', ', term('rpo'), ' or a ', term('restore layer'), ' mean? Hover any underlined word, or read the ',
          h('a', { href: `#/${ws}/learn` }, 'short explainers'), ' first.'),
      ),
      aiRow({
        ws, api, intro: 'Ask AI:',
        context: {
          workspace: { name: meta?.name, slug: ws, strategy: meta?.strategy, regions: meta?.regions },
          objectives: obj,
          objectivesReadable: {
            recoveryTimeTarget: fmtMinutes(obj.rtoMinutes), recoveryTimeAchieved: fmtMinutes(obj.rtaMinutes),
            dataLossTarget: fmtMinutes(obj.rpoMinutes), dataLossAchieved: fmtMinutes(obj.rpaMinutes),
            approved: !!obj.approved,
          },
          maturity: { level: report0.level, label: report0.levelLabel, answered: report0.answeredTotal, of: report0.questionCount },
          pillars: report0.pillars, signals: report0.signals, nextActions: report0.nextActions,
        },
        actions: [
          { label: 'Explain my DR posture in plain English', prompt: 'Using this assessment result and the measured workspace signals, explain the current disaster-recovery posture in plain English for a non-specialist. Say clearly what is proven and what is only claimed. Do not propose any data changes.' },
          { label: 'What should I do this week?', prompt: 'Based on the weakest pillars and the measured signals, what are the three most valuable things to do in the next week? Be concrete and reference the actual numbers. Do not propose any data changes.' },
          { label: 'Draft an executive summary', prompt: 'Write a short executive summary of this DR assessment for a leadership audience: maturity level and what it means, the honest recovery numbers, the biggest risks, and the ask. No unexplained jargon. Do not propose any data changes.' },
        ],
      }),
      h('div', { style: 'height:var(--s3)' }),
      summaryBox,
      h('div', { class: 'section-head' },
        h('h2', null, 'The questions'),
        h('div', { class: 'section-purpose' }, 'Six parts, scored 0–4. Answers save themselves as you pick them.')),
      ...pillarCards,
      footBox,
    );

    savedFlag.replaceChildren(h('span', { class: 'state-dot ok' }), 'Answers save automatically');
    renderSummary(report0);
  },
};
