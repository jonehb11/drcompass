// Learn — knowledge base browser. [agent: research-knowledge]
// Left: articles grouped by section. Right: rendered markdown article.
// Deep link: #/:ws/learn/:articleId

import { h, card, badge, empty, markdown } from '../ui.js';

const SECTION_ORDER = ['Start here', 'Strategies', 'Tooling', 'Running the program', 'Case studies'];
const SECTION_ICONS = {
  'Start here': '🧭',
  'Strategies': '♟️',
  'Tooling': '🧰',
  'Running the program': '🔁',
  'Case studies': '🏛️',
};

const STYLE = `
  .learn-wrap { display: grid; grid-template-columns: 268px minmax(0, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 900px) { .learn-wrap { grid-template-columns: 1fr; } }
  .learn-toc { position: sticky; top: 20px; max-height: calc(100vh - 60px); overflow-y: auto; padding: 12px 10px; }
  .learn-toc .nav-section { padding: 12px 8px 4px; }
  .learn-toc a.learn-item {
    display: flex; align-items: baseline; gap: 8px; color: var(--text);
    padding: 6px 9px; border-radius: 8px; font-size: 13px; line-height: 1.35;
  }
  .learn-toc a.learn-item:hover { background: var(--panel2); }
  .learn-toc a.learn-item.active { background: var(--accent-soft); color: #bcd4fb; }
  .learn-toc .learn-n { color: var(--muted); font-family: var(--mono); font-size: 11px; flex: none; width: 18px; }
  .learn-article { padding: 22px 28px 34px; }
  .learn-article .md h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .learn-article .md h2 { font-size: 17px; margin: 26px 0 8px; padding-top: 14px; border-top: 1px solid var(--border); }
  .learn-article .md h3 { font-size: 14.5px; margin: 18px 0 6px; }
  .learn-article .md p { margin: 9px 0; max-width: 78ch; }
  .learn-article .md ul { margin: 8px 0 8px 22px; }
  .learn-article .md li { margin: 4px 0; max-width: 75ch; }
  .learn-article .md table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0; }
  .learn-article .md th { text-align: left; color: var(--muted); font-size: 11.5px; text-transform: uppercase;
    letter-spacing: 0.05em; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .learn-article .md td { padding: 8px 10px; border-bottom: 1px solid rgba(42,50,66,.55); vertical-align: top; }
  .learn-article .md blockquote { border-left: 3px solid var(--accent); background: var(--accent-soft);
    padding: 8px 14px; border-radius: 0 8px 8px 0; margin: 12px 0; color: var(--text); max-width: 78ch; }
  .learn-article .md pre { margin: 10px 0; }
  .learn-article .md code { background: var(--bg2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
  .learn-article .md pre code { background: none; border: none; padding: 0; }
  .learn-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .learn-nav-foot { display: flex; justify-content: space-between; gap: 10px; margin-top: 26px;
    padding-top: 14px; border-top: 1px solid var(--border); }
`;

export default {
  title: 'Learn',
  async render(el, ctx) {
    const { ws, api, navigate } = ctx;
    let list;
    try {
      list = await api.get('/knowledge');
    } catch (e) {
      el.append(card(h('h2', null, 'Knowledge base unavailable'), h('p', { class: 'hint' }, e.message)));
      return;
    }
    if (!Array.isArray(list) || !list.length) {
      el.append(empty('No articles found in the knowledge base.'));
      return;
    }

    // Group by section, in canonical order (unknown sections go last).
    const sections = [...new Set([...SECTION_ORDER.filter((s) => list.some((a) => a.section === s)),
      ...list.map((a) => a.section)])];
    const current = ctx.params?.[0] && list.some((a) => a.id === ctx.params[0])
      ? ctx.params[0] : list[0].id;

    const tocLinks = new Map();
    const toc = h('nav', { class: 'card learn-toc' },
      sections.map((sec) => [
        h('div', { class: 'nav-section' }, `${SECTION_ICONS[sec] || '📄'} ${sec}`),
        list.filter((a) => a.section === sec).map((a, i) => {
          const link = h('a', {
            class: `learn-item${a.id === current ? ' active' : ''}`,
            href: `#/${ws}/learn/${a.id}`,
            title: a.title,
          }, h('span', { class: 'learn-n' }, String(i + 1).padStart(2, '0')), a.title);
          tocLinks.set(a.id, link);
          return link;
        }),
      ]));

    const articleCard = h('div', { class: 'card learn-article' }, h('div', { class: 'loading' }, 'Loading article…'));

    const show = async (id) => {
      articleCard.innerHTML = '';
      articleCard.append(h('div', { class: 'loading' }, 'Loading article…'));
      let art;
      try {
        art = await api.get(`/knowledge/${id}`);
      } catch (e) {
        articleCard.innerHTML = '';
        articleCard.append(h('h2', null, 'Article failed to load'), h('p', { class: 'hint' }, e.message));
        return;
      }
      const meta = list.find((a) => a.id === id) || {};
      const body = markdown(art.markdown);
      // Cross-article links in markdown are written as #/learn/<id>; prefix the workspace.
      body.querySelectorAll('a[href^="#/learn/"]').forEach((a) => {
        a.removeAttribute('target'); a.removeAttribute('rel');
        a.setAttribute('href', `#/${ws}/learn/${a.getAttribute('href').slice('#/learn/'.length)}`);
      });
      const idx = list.findIndex((a) => a.id === id);
      const prev = idx > 0 ? list[idx - 1] : null;
      const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
      articleCard.innerHTML = '';
      articleCard.append(
        h('div', { class: 'learn-meta' },
          badge(meta.section || 'General', 'accent'),
          h('span', { class: 'hint', style: 'font-size:12px;color:var(--muted)' }, `Article ${idx + 1} of ${list.length}`)),
        body,
        h('div', { class: 'learn-nav-foot' },
          prev
            ? h('a', { class: 'btn btn-ghost', href: `#/${ws}/learn/${prev.id}` }, `← ${prev.title}`)
            : h('span'),
          next
            ? h('a', { class: 'btn', href: `#/${ws}/learn/${next.id}` }, `${next.title} →`)
            : h('span')),
      );
      articleCard.scrollIntoView?.({ block: 'start' });
    };

    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, 'Learn'),
          h('div', { class: 'sub' },
            'Field guide: where to start, strategies, tooling, and how to run a DR program that actually recovers.'))),
      h('div', { class: 'learn-wrap' }, toc, articleCard),
    );

    await show(current);
  },
};
