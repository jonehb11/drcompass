// "Where am I?" — guided DR maturity assessment with auto-save and live report.
import { h, card, badge, toast } from '../ui.js';

const STYLE = `
  .asmt-level { display:flex; align-items:center; gap:18px; }
  .asmt-level .lvl-num { font-size:44px; font-weight:750; letter-spacing:-0.03em; line-height:1; color:var(--accent); }
  .asmt-level .lvl-label { font-size:17px; font-weight:650; }
  .asmt-level .lvl-sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .asmt-pillar { margin:10px 0; }
  .asmt-pillar .row-top { display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:4px; }
  .asmt-pillar .row-top .pct { color:var(--muted); }
  .asmt-actions { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); }
  .asmt-action { display:block; background:var(--panel2); border:1px solid var(--border); border-radius:10px;
    padding:12px 14px; color:var(--text); transition:border-color .15s; }
  .asmt-action:hover { border-color:var(--accent); }
  .asmt-action .t { font-weight:650; font-size:13px; margin-bottom:4px; }
  .asmt-action .w { font-size:12px; color:var(--muted); line-height:1.45; }
  .asmt-q { padding:14px 0; border-bottom:1px solid rgba(42,50,66,.55); }
  .asmt-q:last-child { border-bottom:0; }
  .asmt-q .q-text { font-weight:600; margin-bottom:2px; }
  .asmt-q .q-help { font-size:12.5px; color:var(--muted); margin-bottom:10px; max-width:760px; }
  .asmt-seg { display:grid; gap:6px; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  .asmt-opt { text-align:left; cursor:pointer; background:var(--bg2); border:1px solid var(--border);
    border-radius:8px; padding:8px 10px; color:var(--muted); font:12px/1.4 var(--sans); }
  .asmt-opt .n { display:block; font-weight:700; font-size:11px; color:var(--muted); margin-bottom:2px; }
  .asmt-opt:hover { border-color:#3a4557; color:var(--text); }
  .asmt-opt.sel { background:var(--accent-soft); border-color:var(--accent); color:var(--text); }
  .asmt-opt.sel .n { color:var(--accent); }
  .asmt-sig { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
`;

export default {
  title: 'Assessment',
  async render(el, { ws, api }) {
    const [{ questions, pillars }, stored, report0] = await Promise.all([
      api.get(`/w/${ws}/assessment/questions`),
      api.get(`/w/${ws}/assessment`),
      api.get(`/w/${ws}/assessment/report`),
    ]);
    const answers = stored.answers || {};

    const summaryBox = h('div');

    function renderSummary(r) {
      summaryBox.innerHTML = '';
      const answered = r.answeredTotal ?? 0;
      summaryBox.append(
        h('div', { class: 'grid cols-2', style: 'align-items:stretch; margin-bottom:14px' },
          card(
            h('h2', null, 'Your maturity level'),
            h('div', { class: 'asmt-level' },
              h('div', { class: 'lvl-num' }, String(r.level)),
              h('div', null,
                h('div', { class: 'lvl-label' }, r.levelLabel),
                h('div', { class: 'lvl-sub' },
                  answered === 0
                    ? 'Answer the questions below to place yourself on the ladder (0 None → 5 Production-proven).'
                    : `${answered}/${r.questionCount} answered · levels above 2 must be earned with passed tests, not just answers.`))),
            h('div', { class: 'asmt-sig' },
              (r.signals || []).map((s) => badge(`${s.label}: ${s.value}`, s.kind === 'ok' ? 'ok' : s.kind === 'err' ? 'err' : 'warn'))),
          ),
          card(
            h('h2', null, 'Pillars'),
            (r.pillars || []).map((p) => h('div', { class: 'asmt-pillar' },
              h('div', { class: 'row-top' },
                h('span', null, p.name),
                h('span', { class: 'pct' }, p.answeredCount === 0 ? 'not started' : `${p.score}%`)),
              h('div', { class: 'progress' },
                h('div', { style: `width:${p.answeredCount ? p.score : 0}%` })))),
          ),
        ),
        (r.nextActions || []).length
          ? h('div', { style: 'margin-bottom:14px' }, card(
              h('h2', null, 'Where to start next'),
              h('p', { class: 'hint', style: 'margin-bottom:10px' },
                'The most impactful moves given your weakest pillars — each links to the page where the work happens.'),
              h('div', { class: 'asmt-actions' },
                r.nextActions.map((a) => h('a', { class: 'asmt-action', href: `#/${ws}/${a.page}` },
                  h('div', { class: 't' }, a.title),
                  h('div', { class: 'w' }, a.why))))))
          : null,
      );
    }

    let saveTimer = null;
    async function save() {
      try {
        await api.put(`/w/${ws}/assessment`, { answers });
        const r = await api.get(`/w/${ws}/assessment/report`);
        renderSummary(r);
      } catch (e) { toast(`Save failed: ${e.message}`, 'err'); }
    }
    function queueSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 350);
    }

    function questionBlock(q) {
      const opts = (q.levels || []).map((lbl, i) => {
        const b = h('button', { class: `asmt-opt${answers[q.id] === i ? ' sel' : ''}`, type: 'button' },
          h('span', { class: 'n' }, `Level ${i}`), lbl);
        b.addEventListener('click', () => {
          answers[q.id] = i;
          for (const sib of b.parentElement.children) sib.classList.remove('sel');
          b.classList.add('sel');
          queueSave();
        });
        return b;
      });
      return h('div', { class: 'asmt-q' },
        h('div', { class: 'q-text' }, q.text),
        h('div', { class: 'q-help' }, q.help || ''),
        h('div', { class: 'asmt-seg' }, opts));
    }

    const pillarCards = pillars.map((p) => {
      const qs = questions.filter((q) => q.pillar === p.id);
      return card(
        h('div', { class: 'row', style: 'margin-bottom:2px' },
          h('h2', { style: 'margin-bottom:0' }, p.name),
          h('span', { class: 'spacer' }),
          badge(`${qs.length} questions`)),
        qs.map(questionBlock));
    });

    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, 'Where am I?'),
          h('div', { class: 'sub' }, 'An honest look at your disaster-recovery maturity — and what to do about it'))),
      card(
        h('p', null,
          'Most teams don’t know where to start with disaster recovery. This assessment fixes that: answer 18 questions across six pillars — pick the level that describes ',
          h('strong', null, 'today'), ', not the plan — and DR Compass places you on the maturity ladder, ',
          'shows which pillars are weakest, and turns that into concrete next actions inside this app. Answers save automatically; come back and re-score after every test.'),
        h('p', { class: 'hint', style: 'margin-top:8px' },
          'New to RTO, RPO, or restore layers? Read the ',
          h('a', { href: `#/${ws}/learn` }, 'Learn pages'), ' first — ten minutes there makes these questions much easier.')),
      h('div', { style: 'height:14px' }),
      summaryBox,
      ...pillarCards,
    );
    renderSummary(report0);
  },
};
