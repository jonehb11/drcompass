// BLANKS — what is empty in this plan, ordered by what it costs you.
//
// A DR plan is mostly holes until somebody fills them, and the holes that matter
// are not "a field is null" — they are the sentences an auditor reads and finds
// missing. So every blank here carries three things and nothing else:
//
//   why        one line, plain, about consequence rather than schema
//   exportedIn where the hole shows up in what you hand someone
//   href       the page where it gets filled — a blank that leads nowhere is a nag
//
// Two sources, and the page always says which one it got:
//   server   GET /w/:ws/blanks  — the real model, computed beside the data
//   derived  computed in the browser from ui.snapshot() when that route is not
//            there yet. Deliberately small and deliberately labelled: it is an
//            honest subset, not a pretend implementation of the server's answer.
//
// Dismissal is local and reversible. A blank somebody has consciously accepted
// stops counting and stops shouting; it never disappears, because "we decided to
// live without it" is a different state from "it is filled in".
import { h, badge, btn, empty, snapshot, fmtMinutes } from './ui.js';
import { hrefIn } from './onboarding.js';

// ---------------------------------------------------------------- styling
const STYLE = `
.bl-groups { display: flex; flex-direction: column; gap: 16px; }
.bl-group-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.bl-group-title { font-weight: 700; font-size: 13px; }
.bl-group-why { font-size: 12px; color: var(--muted); }
.bl-row { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border);
  border-left-width: 3px; border-radius: 8px; background: var(--panel2); padding: 9px 12px; margin-bottom: 6px; }
.bl-row.blocker { border-left-color: var(--err); }
.bl-row.high { border-left-color: var(--warn); }
.bl-row.medium { border-left-color: var(--accent); }
.bl-row.low { border-left-color: var(--border); }
.bl-row.fillable { background: var(--accent-soft); }
.bl-row.dismissed { opacity: .55; }
.bl-main { flex: 1 1 auto; min-width: 0; }
.bl-label { font-weight: 650; font-size: 13px; }
.bl-why { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.bl-where { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
.bl-where b { font-weight: 600; color: var(--text); }
.bl-acts { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }
.bl-fills { font-size: 11.5px; color: var(--accent); font-weight: 650; margin-top: 4px; }
.bl-src { font-size: 11.5px; color: var(--muted); margin-bottom: 10px; }
.bl-who { font-size: 12px; color: var(--muted); margin-top: 3px; }
.bl-n { font-weight: 700; font-size: 11.5px; color: var(--text); background: var(--bg2);
  border: 1px solid var(--border); border-radius: 20px; padding: 1px 8px; margin-left: 6px; }
.bl-more { appearance: none; background: none; border: 0; padding: 0; margin-top: 4px; cursor: pointer;
  font: inherit; font-size: 11.5px; color: var(--accent); }
.bl-sub { margin: 8px 0 0 0; border-top: 1px solid var(--border); padding-top: 7px; }
.bl-sub-row { display: flex; gap: 8px; align-items: center; padding: 3px 0; font-size: 12.5px; }
.bl-sub-name { flex: 1 1 auto; min-width: 0; }
`;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('blanks-style')) return;
  document.head.append(h('style', { id: 'blanks-style' }, STYLE));
}

// ---------------------------------------------------------------- dismissal

const KEY = (ws) => `drcompass.blanks.accepted.${ws}`;

export function acceptedIds(ws) {
  try { return new Set(JSON.parse(localStorage.getItem(KEY(ws)) || '[]')); }
  catch { return new Set(); }
}

function writeAccepted(ws, set) {
  try { localStorage.setItem(KEY(ws), JSON.stringify([...set])); } catch { /* private mode — fine */ }
}

export function accept(ws, id) { const s = acceptedIds(ws); s.add(id); writeAccepted(ws, s); }
export function unaccept(ws, id) { const s = acceptedIds(ws); s.delete(id); writeAccepted(ws, s); }

// ---------------------------------------------------------------- the model

export const IMPORTANCE = ['blocker', 'high', 'medium', 'low'];
const IMP_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };
const IMP_BADGE = { blocker: 'err', high: 'warn', medium: 'accent', low: '' };

const GROUP = {
  blocker: ['Blocking', 'Somebody reading your plan stops at these. They are not optional.'],
  high: ['Worth filling now', 'Each of these is a question you will be asked and cannot answer today.'],
  medium: ['Would make the plan better', 'Not fatal. Fills in detail that makes the rest usable.'],
  low: ['Nice to have', 'Cosmetic or optional. Accept them and move on if they do not apply.'],
};

/** Where a blank gets filled. The server may say; otherwise it is derived. */
export function blankHref(b, ws) {
  if (b && typeof b.href === 'string' && b.href) return b.href;
  if (b && typeof b.page === 'string' && b.page) {
    return b.page === 'service' && b.subject?.id
      ? hrefIn(ws, 'service', b.subject.id)
      : hrefIn(ws, b.page);
  }
  const field = String(b?.field || '');
  const kind = String(b?.kind || '');
  const type = String(b?.subject?.type || '');
  if (/^objectives|^rto|^rpo|regions|strategy|tooling/.test(field) || kind === 'objective') {
    return type === 'service' && b.subject?.id ? hrefIn(ws, 'service', b.subject.id) : hrefIn(ws, 'settings');
  }
  if (/^rta|^rpa|test/.test(field) || kind === 'test' || kind === 'evidence') return hrefIn(ws, 'tests');
  if (kind === 'runbook' || /runbook|steps/.test(field)) return hrefIn(ws, 'runbooks');
  if (kind === 'checklist') return hrefIn(ws, 'checklists');
  if (type === 'service' && b.subject?.id) return hrefIn(ws, 'service', b.subject.id);
  if (type === 'component') return hrefIn(ws, 'inventory');
  return hrefIn(ws, 'settings');
}

/** Tolerate a server that omits fields, and never throw on a shape surprise. */
function normalize(raw, i) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const importance = IMPORTANCE.includes(b.importance) ? b.importance : 'medium';
  const subject = b.subject && typeof b.subject === 'object' ? b.subject : {};
  return {
    ...b,
    id: String(b.id || `${b.kind || 'blank'}:${b.field || i}:${subject.id || ''}` || `blank-${i}`),
    kind: String(b.kind || 'field'),
    field: String(b.field || ''),
    label: String(b.label || b.field || 'an empty field'),
    why: String(b.why || ''),
    importance,
    subject: {
      type: String(subject.type || 'workspace'),
      id: subject.id ?? null,
      name: String(subject.name || ''),
    },
    exportedIn: Array.isArray(b.exportedIn) ? b.exportedIn.filter((x) => typeof x === 'string') : [],
  };
}

function countsOf(items) {
  const byImportance = {};
  const byKind = {};
  for (const b of items) {
    byImportance[b.importance] = (byImportance[b.importance] || 0) + 1;
    byKind[b.kind] = (byKind[b.kind] || 0) + 1;
  }
  return { total: items.length, byImportance, byKind };
}

// ------------------------------------------------------- the derived fallback
//
// Only what the browser already knows for certain from ui.snapshot(). Counts are
// grouped — "31 resources have no restore layer" is one decision, not 31 rows —
// which is also the rule the full view follows.

const EXEC = 'Executive Summary';
const BRIEF = 'How we fail this over';

function derive(snap, ws) {
  const out = [];
  const add = (b) => out.push(b);
  const c = snap.counts || {};
  const o = snap.objectives || {};
  const meta = snap.meta || {};
  const comps = snap.components || [];
  const inScope = comps.filter((x) => x.inRecoveryScope === 'yes');
  const subject = { type: 'workspace', id: null, name: meta.name || 'this workspace' };

  if (o.rtoMinutes === null || o.rtoMinutes === undefined) {
    add({
      id: 'w:objectives.rtoMinutes', kind: 'objective', field: 'objectives.rtoMinutes', subject,
      label: 'No recovery time target (RTO)',
      why: 'Every other number in the plan is judged against this one. Without it nothing can be called on target or off it.',
      importance: 'blocker', exportedIn: [EXEC, BRIEF, 'Assessment'],
    });
  }
  if (o.rpoMinutes === null || o.rpoMinutes === undefined) {
    add({
      id: 'w:objectives.rpoMinutes', kind: 'objective', field: 'objectives.rpoMinutes', subject,
      label: 'No data-loss target (RPO)',
      why: 'How much data the business can afford to lose decides the replication you need. Nobody has written it down.',
      importance: 'blocker', exportedIn: [EXEC, BRIEF],
    });
  }
  if ((o.rtoMinutes !== null && o.rtoMinutes !== undefined) && !o.approved) {
    add({
      id: 'w:objectives.approved', kind: 'objective', field: 'objectives.approved', subject,
      label: 'Targets are not approved by the business',
      why: `Until somebody with authority signs off, ${fmtMinutes(o.rtoMinutes)} is an engineering guess with a number on it.`,
      importance: 'high', exportedIn: [EXEC, 'Assessment'],
    });
  }
  if (!meta.regions || !meta.regions.primary || !meta.regions.recovery) {
    add({
      id: 'w:regions', kind: 'workspace', field: 'regions', subject,
      label: 'No region pair set',
      why: 'The plan cannot say where you recover to, so no diagram, runbook or export can say it either.',
      importance: 'high', exportedIn: [EXEC, BRIEF, 'Dependencies'],
    });
  }
  if (!meta.strategy) {
    add({
      id: 'w:strategy', kind: 'workspace', field: 'strategy', subject,
      label: 'No recovery strategy chosen',
      why: 'Backup-and-restore, pilot light, warm standby and active-active cost and recover very differently. The plan does not commit to one.',
      importance: 'medium', exportedIn: [EXEC, BRIEF],
    });
  }
  if (!(snap.passedTests || []).length) {
    add({
      id: 'w:measured', kind: 'evidence', field: 'rtaMinutes', subject,
      label: 'Nothing has been measured — no test has passed',
      why: 'Every recovery number in the exports is a target until a test produces a real one. This is the difference between a plan and evidence.',
      importance: 'blocker', exportedIn: [EXEC, BRIEF, 'Tests'],
    });
  } else if (!snap.gameDayPassed) {
    add({
      id: 'w:gameday', kind: 'evidence', field: 'game-day', subject,
      label: 'No game day has passed',
      why: 'A technical test proves the machinery. What is unproven is the part with people in it: who decides, who is awake, who tells the customer.',
      importance: 'high', exportedIn: [EXEC, 'Tests'],
    });
  }
  if (!c.runbooks) {
    add({
      id: 'w:runbooks', kind: 'runbook', field: 'runbooks', subject,
      label: 'No runbook exists',
      why: 'Nobody can follow this plan at 3am, because it has no steps.',
      importance: 'blocker', exportedIn: ['Runbook Steps', BRIEF],
    });
  } else if (!snap.hasRunbookSteps) {
    add({
      id: 'w:runbook-steps', kind: 'runbook', field: 'steps', subject,
      label: 'The runbook has no steps in it',
      why: 'A named runbook with nothing inside it reads as a plan in the export and is not one.',
      importance: 'blocker', exportedIn: ['Runbook Steps', BRIEF],
    });
  }
  if (!c.components) {
    add({
      id: 'w:inventory', kind: 'component', field: 'components', subject,
      label: 'Nothing is in the inventory',
      why: 'A recovery plan can only cover what is written down. Everything downstream is built from this list.',
      importance: 'blocker', exportedIn: ['Dependencies', 'Resource Graph'],
    });
    return out;
  }

  const noTier = inScope.filter((x) => !x.tier && x.tier !== 0);
  if (noTier.length) {
    add({
      id: 'c:tier', kind: 'component', field: 'tier',
      subject: { type: 'workspace', id: null, name: `${noTier.length} resources` },
      label: `${noTier.length} in-scope resource${noTier.length === 1 ? ' has' : 's have'} no tier`,
      why: 'Tier is what decides the order things come back in and what the business is promised about each one.',
      importance: 'high', exportedIn: ['Dependencies', 'Resource Graph', EXEC],
      sample: noTier.slice(0, 4).map((x) => x.name),
    });
  }
  const noLayer = inScope.filter((x) => !x.restoreLayer);
  if (noLayer.length) {
    add({
      id: 'c:restoreLayer', kind: 'component', field: 'restoreLayer',
      subject: { type: 'workspace', id: null, name: `${noLayer.length} resources` },
      label: `${noLayer.length} in-scope resource${noLayer.length === 1 ? ' has' : 's have'} no restore layer`,
      why: 'Without a layer a resource cannot be sequenced, so it is silently missing from the recovery order.',
      importance: 'high', exportedIn: ['Dependencies', 'Runbook Steps'],
      sample: noLayer.slice(0, 4).map((x) => x.name),
    });
  }
  const noVerify = inScope.filter((x) => !(x.verification && x.verification.command));
  if (noVerify.length) {
    add({
      id: 'c:verification', kind: 'component', field: 'verification',
      subject: { type: 'workspace', id: null, name: `${noVerify.length} resources` },
      label: `${noVerify.length} in-scope resource${noVerify.length === 1 ? ' has' : 's have'} no way to prove it came back`,
      why: 'Without a check, "it is up" is somebody\'s opinion at the worst possible moment.',
      importance: 'medium', exportedIn: ['Verification Catalog', 'Runbook Steps'],
      sample: noVerify.slice(0, 4).map((x) => x.name),
    });
  }
  const noDeps = inScope.filter((x) => !(Array.isArray(x.dependsOn) && x.dependsOn.length));
  if (noDeps.length && inScope.length > 2) {
    add({
      id: 'c:dependsOn', kind: 'component', field: 'dependsOn',
      subject: { type: 'workspace', id: null, name: `${noDeps.length} resources` },
      label: `${noDeps.length} in-scope resource${noDeps.length === 1 ? ' has' : 's have'} no dependencies recorded`,
      why: 'Recovery order comes from dependencies. Anything sitting alone in the graph is something nobody has wired up yet.',
      importance: 'medium', exportedIn: ['Dependencies', 'Resource Graph'],
      sample: noDeps.slice(0, 4).map((x) => x.name),
    });
  }

  for (const s of snap.services || []) {
    const so = s.objectives || {};
    if (so.rtoMinutes === null || so.rtoMinutes === undefined) {
      add({
        id: `s:${s.id}:rto`, kind: 'objective', field: 'objectives.rtoMinutes',
        subject: { type: 'service', id: s.id, name: s.name || 'a service' },
        label: 'No recovery time target of its own',
        why: 'A service without its own target is judged against the workspace number, which is usually the wrong promise for it.',
        importance: 'medium', exportedIn: [EXEC, BRIEF],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- loading

const byImportance = (a, b) =>
  (IMP_RANK[a.importance] ?? 9) - (IMP_RANK[b.importance] ?? 9)
  || String(a.label).localeCompare(String(b.label));

/**
 * @returns {Promise<{items, counts, source:'server'|'derived'|'none', note:string}>}
 * Never throws: a 404, a 500 or a shape surprise all degrade to the derived set.
 */
export async function loadBlanks(api, ws, { serviceId = null } = {}) {
  let res = null;
  try {
    const q = serviceId ? `?serviceId=${encodeURIComponent(serviceId)}` : '';
    res = await api.get(`/w/${ws}/blanks${q}`);
  } catch { res = null; }

  if (res && Array.isArray(res.items)) {
    const items = res.items.map(normalize).sort(byImportance);
    return {
      items,
      counts: res.counts && typeof res.counts === 'object' ? { ...countsOf(items), ...res.counts } : countsOf(items),
      source: 'server',
      note: '',
    };
  }

  const snap = await snapshot(api, ws).catch(() => null);
  if (!snap || !snap.ok) {
    return { items: [], counts: countsOf([]), source: 'none', note: 'This workspace could not be read.' };
  }
  const items = derive(snap, ws).map(normalize).sort(byImportance);
  return {
    items,
    counts: countsOf(items),
    source: 'derived',
    note: 'Worked out in the browser from this workspace\'s own data, because this build\'s server has no /blanks route yet. '
      + 'It is an honest subset — the big holes, grouped — not everything a full scan would find.',
  };
}

// ---------------------------------------------------------------- rendering

// A blanks list straight out of the engine is one row per field per component,
// and reads as a wall: "Tier-0 component with no test" fourteen times over. The
// user's decision is not fourteen decisions, it is one — "do I go and write
// tests for these fourteen things" — so identical blanks are clustered into one
// row that names them, and the individual rows live one click inside it.
const CLUSTER_AT = 3;

function cluster(items) {
  const order = [];
  const by = new Map();
  for (const b of items) {
    const key = `${b.importance} ${b.kind} ${b.label}`;
    if (!by.has(key)) { by.set(key, []); order.push(key); }
    by.get(key).push(b);
  }
  return order.map((k) => by.get(k))
    .map((group) => (group.length >= CLUSTER_AT
      ? { cluster: true, items: group, head: group[0] }
      : group.map((b) => ({ cluster: false, items: [b], head: b })))).flat();
}

const nameOf = (b) => b.subject.name || b.subject.id || 'this workspace';

/** The "why" paragraph, behind a toggle — the row itself stays one line. */
function whyToggle(text) {
  if (!text) return null;
  const p = h('div', { class: 'bl-why' }, text);
  p.hidden = true;
  const b = h('button', { class: 'bl-more', type: 'button' }, 'why this matters');
  b.addEventListener('click', () => {
    p.hidden = !p.hidden;
    b.textContent = p.hidden ? 'why this matters' : 'hide';
  });
  return h('div', null, b, p);
}

function actions(b, { ws, accepted, onChange }) {
  return accepted
    ? btn({ label: 'Un-accept', kind: 'btn-ghost', size: 'btn-sm', onClick: () => { unaccept(ws, b.id); onChange(); } })
    : h('span', { class: 'bl-acts' },
      btn({ label: 'Fill it', size: 'btn-sm', href: blankHref(b, ws) }),
      btn({
        label: 'Accept', kind: 'btn-ghost', size: 'btn-sm',
        title: 'We have decided to live without this. It stops counting and stops asking.',
        onClick: () => { accept(ws, b.id); onChange(); },
      }));
}

function row(entry, { ws, fills, onChange }) {
  const b = entry.head;
  const many = entry.cluster;
  const list = entry.items;
  const isAccepted = b.accepted;
  const fillable = fills && list.some((x) => fills.has(x.id));
  const subjects = list.map(nameOf);
  const shown = subjects.slice(0, 5).join(', ');

  // The individual blanks inside a cluster — named, and each still its own
  // decision, because "accept all fourteen" should never be the only option.
  const sub = h('div', { class: 'bl-sub' },
    list.map((x) => h('div', { class: 'bl-sub-row' },
      h('span', { class: 'bl-sub-name' }, nameOf(x)),
      actions(x, { ws, accepted: x.accepted, onChange }))));
  sub.hidden = true;
  const subToggle = h('button', { class: 'bl-more', type: 'button' }, `show all ${list.length}`);
  subToggle.addEventListener('click', () => {
    sub.hidden = !sub.hidden;
    subToggle.textContent = sub.hidden ? `show all ${list.length}` : 'hide';
  });

  return h('div', { class: `bl-row ${b.importance} ${fillable ? 'fillable' : ''} ${isAccepted ? 'dismissed' : ''}` },
    h('div', { class: 'bl-main' },
      h('div', { class: 'bl-label' },
        badge(b.importance, IMP_BADGE[b.importance] ?? ''), ' ', b.label,
        many ? h('span', { class: 'bl-n' }, `×${list.length}`) : null,
        // Always name the subject when there is one. The engine files an
        // environment under subject.type 'workspace', so keying off the type
        // made "No RTO target" for the service and for the production
        // environment render as two identical rows.
        !many && b.subject.name ? h('span', { class: 'hint' }, ` · ${b.subject.name}`) : null),
      many
        ? h('div', { class: 'bl-who' }, shown, list.length > 5 ? `, +${list.length - 5} more` : '')
        : null,
      Array.isArray(b.sample) && b.sample.length
        ? h('div', { class: 'bl-who' }, `for example: ${b.sample.join(', ')}…`)
        : null,
      b.exportedIn.length
        ? h('div', { class: 'bl-where' }, 'Shows up in ', h('b', null, b.exportedIn.join(' · ')))
        : h('div', { class: 'bl-where' }, 'Not printed in an export — it blocks work inside the app.'),
      fillable
        ? h('div', { class: 'bl-fills' }, 'the document you just read can fill this')
        : null,
      whyToggle(b.why),
      many ? h('div', null, subToggle, sub) : null),
    h('div', { class: 'bl-acts' },
      many && !isAccepted
        ? h('span', { class: 'bl-acts' },
          btn({ label: 'Fill them', size: 'btn-sm', href: blankHref(b, ws) }),
          btn({
            label: `Accept all ${list.length}`, kind: 'btn-ghost', size: 'btn-sm',
            title: 'We have decided to live without all of these. They stop counting and stop asking.',
            onClick: () => { for (const x of list) accept(ws, x.id); onChange(); },
          }))
        : actions(b, { ws, accepted: isAccepted, onChange })));
}

/**
 * The whole view: loads, groups by importance, and repaints itself on accept.
 *
 *   el.append(blanksView({ ws, api, fills, head: true }));
 *
 * `fills` is an optional Set of blank ids the document just read can fill —
 * those rows are lifted to the top of their group and say so.
 */
export function blanksView({ ws, api, fills = null, onCounts = null } = {}) {
  ensureStyle();
  const box = h('div');
  box.replaceChildren(h('div', { class: 'hint' }, 'Looking for what is missing…'));

  async function load() {
    const res = await loadBlanks(api, ws);
    paint(res);
    if (onCounts) { try { onCounts(res); } catch { /* cosmetic */ } }
  }

  function paint(res) {
    const acc = acceptedIds(ws);
    const all = res.items.map((b) => ({ ...b, accepted: acc.has(b.id) }));
    const open = all.filter((b) => !b.accepted);
    const accepted = all.filter((b) => b.accepted);

    const parts = [];
    if (res.source === 'derived' || res.source === 'none') {
      parts.push(h('div', { class: 'bl-src' }, res.note));
    }

    if (!open.length) {
      parts.push(empty({
        icon: accepted.length ? '👍' : '✅',
        title: accepted.length ? 'Nothing left that you have not accepted' : 'Nothing obvious is missing',
        body: accepted.length
          ? `${accepted.length} blank${accepted.length === 1 ? ' is' : 's are'} accepted below. Everything else is filled in.`
          : 'Every field this view checks has something in it. That is not the same as being tested — the numbers still need a passing test behind them.',
        action: { label: 'Go and measure it', href: hrefIn(ws, 'tests'), kind: '' },
      }));
    } else {
      const groups = h('div', { class: 'bl-groups' });
      for (const imp of IMPORTANCE) {
        const inGroup = open.filter((b) => b.importance === imp);
        if (!inGroup.length) continue;
        if (fills) inGroup.sort((a, b) => Number(fills.has(b.id)) - Number(fills.has(a.id)));
        const entries = cluster(inGroup);
        const [title, why] = GROUP[imp];
        const rows = h('div', null, entries.map((e) => row(e, { ws, fills, onChange: () => paint(res) })));
        // Only the two groups that cost something are open on arrival. "Would
        // make the plan better" is real work, but it is not what somebody came
        // to this screen to be told.
        const foldable = imp === 'medium' || imp === 'low';
        rows.hidden = foldable;
        const head = h('div', { class: 'bl-group-head' },
          h('span', { class: 'bl-group-title' },
            `${title} (${inGroup.length}${entries.length < inGroup.length ? ` in ${entries.length} decisions` : ''})`),
          h('span', { class: 'bl-group-why' }, why));
        if (foldable) {
          const t = h('button', { class: 'bl-more', type: 'button' }, 'show');
          t.addEventListener('click', () => {
            rows.hidden = !rows.hidden;
            t.textContent = rows.hidden ? 'show' : 'hide';
          });
          head.append(t);
        }
        groups.append(h('div', null, head, rows));
      }
      parts.push(groups);
    }

    if (accepted.length) {
      const body = h('div', { style: 'margin-top:8px' },
        cluster(accepted).map((e) => row(e, { ws, fills, onChange: () => paint(res) })));
      body.hidden = true;
      const toggle = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' },
        `Show ${accepted.length} accepted`);
      toggle.addEventListener('click', () => {
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? `Show ${accepted.length} accepted` : 'Hide accepted';
      });
      parts.push(h('div', { style: 'margin-top:14px' }, toggle, body));
    }

    box.replaceChildren(...parts);
  }

  load();
  return box;
}

/** The one-line summary the Documents tab strip and the Overview both use. */
export function blanksSummary(counts) {
  const total = counts?.total || 0;
  if (!total) return 'nothing missing';
  const blockers = counts.byImportance?.blocker || 0;
  return blockers
    ? `${total} blank${total === 1 ? '' : 's'} · ${blockers} blocking`
    : `${total} blank${total === 1 ? '' : 's'}`;
}
