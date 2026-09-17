// Learn — knowledge base browser. [agent: research-knowledge]
// Left: articles grouped by section. Right: rendered markdown article.
// Deep link: #/:ws/learn/:articleId

import { h, card, empty, markdown, pageHead, snapshot } from '../ui.js';
import { aiActionRow } from '../ai-actions.js';
import { crumbFor, nextStepFor } from '../onboarding.js';

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
        // The section badge and "Article N of M" used to sit here; the TOC on
        // the left already shows which section and which article is active.
        // Contextual AI: the article plus this workspace's real inventory.
        aiActionRow({
          ws, api, label: 'AI', style: 'margin:0 0 18px',
          actions: [
            {
              label: 'Explain this for my stack',
              title: 'Rewrite the article\'s point against the components in this workspace',
              modalTitle: `For my stack — ${meta.title || art.title || 'article'}`,
              context: () => ({
                kind: 'article',
                id,
                extra: { id, title: meta.title || art.title || id, section: meta.section || '', markdown: art.markdown || '' },
              }),
              prompt: 'Re-explain this article for the reader\'s actual stack (context.inventoryIndex, runbooks, tests and '
                + 'workspace meta). Under 350 words: what the article\'s core idea means for THESE components (name them by '
                + 'their real names), where their current setup already matches it, where it does not, and the two concrete '
                + 'changes that would close the distance. Skip anything in the article that does not apply to them, and say so '
                + 'in one line. If the inventory is too thin to judge, say what to record first instead of guessing.',
            },
            {
              label: 'How does this apply to me?',
              title: 'The specific actions this article implies for this workspace',
              modalTitle: 'How this applies here',
              context: () => ({
                kind: 'article',
                id,
                extra: { id, title: meta.title || art.title || id, section: meta.section || '', markdown: art.markdown || '' },
              }),
              prompt: 'From this article, list the specific actions this workspace should take — at most 5, worst-risk first. '
                + 'For each: the action, the real component/runbook/gap it touches (by name or id), and what it would prove or '
                + 'prevent. Then one line on what the article recommends that this workspace should NOT do yet, and why. '
                + 'Cite only what is in the context — no invented numbers, no generic best practices.',
            },
          ],
        }),
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
      pageHead({
        title: 'Learn',
        purpose: 'Read the short version of how DR actually works, then apply it to this workspace.',
        crumb: crumbFor('learn', ws),
      }),
      h('div', { class: 'learn-wrap' }, toc, articleCard),
    );

    await show(current);

    // Reading is not an end in itself: close every article with the program's
    // one real next action, from the same model the sidebar uses.
    // Reading is not the action. The one primary action on a Learn page is the
    // thing the reading was for.
    const snap = await snapshot(api, ws).catch(() => ({}));
    const band = nextStepFor('learn', snap, ws);
    band.querySelector('.nextstep-acts .btn')?.classList.add('btn-primary');
    el.append(band);
  },
};
