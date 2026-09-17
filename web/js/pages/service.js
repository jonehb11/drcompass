// Service DR Profile — disaster recovery, explained ONE SERVICE AT A TIME.
//
// Everything about one component's DR story on a single page, in the order a DR
// owner actually asks the questions:
//   1  What is this, and how bad is it if it's down?     (header + posture)
//   2  What does it need to come back?                   (recovery order L0→L7)
//   3  What is it attached to?                           (resource graph)
//   4  Who does it talk to?                              (outbound calls)
//   5  How do we recover it?                             (runbooks + tests)
//   6  What's in the way?                                (gaps)
//   7  What does it look like?                           (diagram)
//   8  Act on it                                         (package, deep links)
//
// One request feeds the whole page: GET /api/w/:ws/service/:componentId.
// Route: #/:ws/service/:componentId  (no id → a service picker).
import { h, card, badge, pageHead, term, snapshot, aiRow } from '../ui.js';
import { crumbFor, nextStepFor } from '../onboarding.js';
import { fromPosture, describe, VERDICT_WORD, VERDICT_TONE } from '../measured.js';

const SCOPE_KIND = { yes: 'ok', partial: 'warn', no: 'err', unknown: '' };
const SCOPE_WORD = { yes: 'in scope', partial: 'partial scope', no: 'NOT in scope', unknown: 'scope unknown' };
const SEV_KIND = { blocker: 'err', high: 'err', medium: 'warn', low: '' };
const SEV_ORDER = { blocker: 0, high: 1, medium: 2, low: 3 };
const STATUS_KIND = { passed: 'ok', failed: 'err', 'in-progress': 'warn', planned: '', canceled: '' };
const CAT_LABEL = {
  compute: 'Compute', networking: 'Networking', storage: 'Storage', database: 'Database',
  'messaging-streaming': 'Messaging & streaming', 'security-secrets': 'Security & secrets',
  'edge-dns': 'Edge & DNS', 'identity-access': 'Identity & access', observability: 'Observability',
  'third-party': 'Third party', 'cicd-control-plane': 'CI/CD & control plane', other: 'Other',
};
// Resource-graph node types → how a human says it, grouped for section 3.
const RES_LABEL = {
  vpc: 'VPC', subnet: 'Subnets', 'availability-zone': 'Availability zones', 'route-table': 'Route tables',
  nacl: 'Network ACLs', 'internet-gateway': 'Internet gateways', 'nat-gateway': 'NAT gateways',
  'elastic-ip': 'Elastic IPs', 'vpc-endpoint': 'VPC endpoints', 'security-group': 'Security groups',
  'load-balancer': 'Load balancers', listener: 'Listeners', 'target-group': 'Target groups',
  certificate: 'Certificates', 'kms-key': 'KMS keys', secret: 'Secrets', 'iam-role': 'IAM roles',
  'iam-policy': 'IAM policies', 'instance-profile': 'Instance profiles', 'oidc-provider': 'OIDC providers',
  nodegroup: 'Node groups', 'launch-template': 'Launch templates', addon: 'Add-ons',
  'db-subnet-group': 'DB subnet groups', 'parameter-group': 'Parameter groups',
  'log-group': 'Log groups', alarm: 'Alarms', 'sns-topic': 'SNS topics', 'hosted-zone': 'Hosted zones',
  'dns-record': 'DNS records', repository: 'Repositories', 'queue-policy': 'Queue policies',
  'bucket-policy': 'Bucket policies', 'tag-match': 'Tag matches', other: 'Other resources',
};

const STYLE = `
  .svc-head { display:flex; gap:18px; align-items:flex-start; flex-wrap:wrap; margin-bottom:6px; }
  .svc-head h1 { font-size:24px; letter-spacing:-0.02em; }
  .svc-head .svc-sub { color:var(--muted); font-size:13px; margin-top:4px; max-width:70ch; }
  .svc-badges { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .svc-meta { display:flex; gap:18px; flex-wrap:wrap; margin-top:10px; font-size:12.5px; color:var(--muted); }
  .svc-meta b { color:var(--text); font-weight:600; }
  .svc-actions { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0 18px; }
  .svc-posture { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); margin-bottom:18px; }
  .svc-tile { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:12px 14px; }
  .svc-tile .t-k { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .svc-tile .t-v { font-size:15.5px; font-weight:650; margin-top:4px; overflow-wrap:anywhere; }
  .svc-tile .t-n { font-size:12px; color:var(--muted); margin-top:3px; }
  .svc-tile.ok { border-color:rgba(63,178,127,.4); }
  .svc-tile.warn { border-color:rgba(226,163,54,.4); }
  .svc-tile.err { border-color:rgba(226,86,79,.45); }
  .svc-sec { margin:26px 0 0; }
  .svc-sec > .s-head { display:flex; align-items:baseline; gap:10px; margin-bottom:4px; flex-wrap:wrap; }
  .svc-sec > .s-head h2 { font-size:17px; }
  .svc-sec > .s-head .s-count { font-size:12px; color:var(--muted); }
  .svc-sec > .s-q { font-size:12.5px; color:var(--muted); margin-bottom:12px; max-width:80ch; }
  .svc-weak { border:1px solid rgba(226,86,79,.4); background:var(--err-soft); border-radius:var(--radius); padding:2px 0; }
  .svc-weak.calm { border-color:rgba(63,178,127,.35); background:var(--ok-soft); padding:12px 16px; }
  .svc-risk { display:flex; gap:12px; padding:11px 16px; border-top:1px solid rgba(226,86,79,.18); align-items:flex-start; }
  .svc-risk:first-child { border-top:0; }
  .svc-risk .r-body { min-width:0; }
  .svc-risk .r-title { font-weight:650; font-size:13.5px; overflow-wrap:anywhere; }
  .svc-risk .r-detail { font-size:12.5px; color:var(--muted); margin-top:3px; max-width:95ch; }
  .svc-risk .r-link { font-size:12px; margin-top:4px; display:inline-block; }
  .svc-more { margin-top:10px; }
  .svc-layer { margin-top:14px; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; background:var(--panel); }
  .svc-layer .l-head { display:flex; gap:10px; align-items:center; padding:9px 14px; background:var(--panel2); border-bottom:1px solid var(--border); }
  .svc-layer .l-id { font:700 11.5px var(--mono); color:var(--accent); background:var(--accent-soft);
    border:1px solid rgba(79,143,247,.3); border-radius:6px; padding:2px 7px; }
  .svc-layer .l-label { font-weight:650; font-size:13px; }
  .svc-layer .l-n { font-size:11.5px; color:var(--muted); }
  .svc-dep { display:grid; gap:4px 14px; grid-template-columns:minmax(200px,2.2fr) minmax(120px,1fr) minmax(150px,1.3fr) minmax(90px,.8fr);
    padding:10px 14px; border-top:1px solid var(--border); align-items:center; font-size:12.5px; }
  .svc-dep:first-child { border-top:0; }
  .svc-dep.is-root { background:var(--accent-soft); border-left:3px solid var(--accent); padding-left:11px; }
  .svc-dep.weak { border-left:3px solid var(--err); padding-left:11px; }
  .svc-dep.soft { border-left:3px solid var(--warn); padding-left:11px; }
  .svc-dep .d-name { font-weight:600; overflow-wrap:anywhere; }
  .svc-dep .d-sub { color:var(--muted); font-size:11.5px; margin-top:1px; }
  .svc-dep .d-flags { grid-column:1 / -1; display:flex; gap:6px; flex-wrap:wrap; }
  .svc-chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600;
    background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  .svc-chip.err { background:var(--err-soft); border-color:rgba(226,86,79,.35); color:#f2938e; }
  .svc-chip.warn { background:var(--warn-soft); border-color:rgba(226,163,54,.35); color:var(--warn); }
  .svc-chip.ok { background:var(--ok-soft); border-color:rgba(63,178,127,.35); color:var(--ok); }
  .svc-chip.accent { background:var(--accent-soft); border-color:rgba(79,143,247,.3); color:#9cc0fa; }
  .svc-grp { border:1px solid var(--border); border-radius:8px; background:var(--bg2); margin-bottom:8px; }
  .svc-grp > summary { cursor:pointer; padding:8px 12px; font-size:12.5px; font-weight:600; list-style:none; display:flex; gap:8px; align-items:center; }
  .svc-grp > summary::-webkit-details-marker { display:none; }
  .svc-grp > summary:hover { color:var(--accent); }
  .svc-grp .g-n { color:var(--muted); font-weight:500; font-size:11.5px; }
  .svc-grp-body { padding:2px 12px 10px; display:flex; flex-direction:column; gap:3px; font-size:12px; }
  .svc-res { display:flex; gap:8px; align-items:baseline; }
  .svc-res .r-rid { color:var(--muted); font:11px var(--mono); overflow-wrap:anywhere; }
  .svc-empty { border:1px dashed var(--border); border-radius:var(--radius); background:var(--bg2); padding:16px 18px; }
  .svc-empty .e-t { font-weight:650; margin-bottom:4px; }
  .svc-empty .e-b { font-size:12.5px; color:var(--muted); max-width:80ch; }
  .svc-empty .e-a { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .svc-scroll { overflow-x:auto; }
  .svc-canvas { border:1px solid var(--border); border-radius:var(--radius); background:var(--bg2); min-height:440px; position:relative; }
  .svc-two { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); }
  .svc-rb { border:1px solid var(--border); border-radius:8px; padding:12px 14px; background:var(--panel); }
  .svc-rb .rb-n { font-weight:650; }
  .svc-step { font-size:12px; color:var(--muted); padding:3px 0 3px 10px; border-left:2px solid var(--border); margin-top:4px; }
  .svc-pick { display:flex; flex-direction:column; gap:2px; }
  .svc-pick a { display:flex; gap:10px; align-items:center; padding:8px 12px; border:1px solid var(--border);
    border-radius:8px; background:var(--panel); text-decoration:none; color:var(--text); font-size:13px; }
  .svc-pick a:hover { border-color:var(--accent); }
  .svc-pick .p-cat { color:var(--muted); font-size:11.5px; }
`;

// --------------------------------------------------------------- tiny helpers

const S = (v) => (v === null || v === undefined ? '' : String(v));
const mins = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v} min` : null);
const catLabel = (c) => CAT_LABEL[c] || c || 'other';
const scopeBadge = (s) => badge(SCOPE_WORD[s] || s || 'scope unknown', SCOPE_KIND[s] || '');
const chip = (text, kind = '') => h('span', { class: `svc-chip ${kind}` }, text);
const link = (href, text, cls = '') => h('a', { href, class: cls }, text);

function tile(k, v, note, kind = '') {
  return h('div', { class: `svc-tile ${kind}` },
    h('div', { class: 't-k' }, k),
    h('div', { class: 't-v' }, v),
    note ? h('div', { class: 't-n' }, note) : null);
}

function section(title, question, count, ...body) {
  return h('section', { class: 'svc-sec' },
    h('div', { class: 's-head' }, h('h2', null, title), count ? h('span', { class: 's-count' }, count) : null),
    question ? h('div', { class: 's-q' }, question) : null,
    ...body);
}

// Our own empty state: always says what is missing AND where to go fix it.
function emptyBox(title, body, actions = []) {
  return h('div', { class: 'svc-empty' },
    h('div', { class: 'e-t' }, title),
    body ? h('div', { class: 'e-b' }, body) : null,
    actions.length ? h('div', { class: 'e-a' }, actions) : null);
}

function actionLink(href, label, { primary = false, download = false, newTab = false } = {}) {
  return h('a', {
    class: `btn ${primary ? 'btn-primary' : ''}`, href,
    ...(download ? { download: '' } : {}),
    ...(newTab ? { target: '_blank', rel: 'noopener' } : {}),
  }, label);
}

// --------------------------------------------------------------- the picker

async function renderPicker(el, { ws, api }) {
  let items = [];
  try { items = (await api.get(`/w/${ws}/c/components`)).items || []; }
  catch (e) {
    el.append(card(h('h2', null, 'Inventory unavailable'), h('p', { class: 'hint' }, e.message)));
    return;
  }
  el.append(pageHead({
    title: 'Service DR profile',
    purpose: 'Pick one service to see its whole disaster-recovery story — what it needs, what is missing, how it comes back.',
    crumb: crumbFor('service', ws),
  }));
  if (!items.length) {
    el.append(emptyBox('No components yet',
      'This page reads the inventory. Add your main application, its databases and the network it lives in first.',
      [actionLink(`#/${ws}/inventory`, 'Open Inventory', { primary: true }),
        actionLink(`#/${ws}/discover/aws`, 'Discover from AWS')]));
    const snap0 = await snapshot(api, ws).catch(() => ({}));
    el.append(nextStepFor('service', snap0, ws));
    return;
  }
  const sorted = [...items].sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || S(a.name).localeCompare(S(b.name)));
  const listEl = h('div', { class: 'svc-pick' });
  const pickRow = (c) => h('a', { href: `#/${ws}/service/${c.id}` },
    h('span', { style: 'font-weight:600' }, S(c.name) || '(unnamed)'),
    h('span', { class: 'p-cat' }, catLabel(c.category)),
    c.tier === 0 || c.tier === 1 ? badge(`Tier ${c.tier}`, c.tier === 0 ? 'err' : 'warn') : null,
    c.restoreLayer ? badge(c.restoreLayer, 'accent') : null,
    scopeBadge(c.inRecoveryScope),
    h('span', { style: 'flex:1' }),
    h('span', { class: 'p-cat' }, `${(c.dependsOn || []).length} deps`));
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    const rows = sorted.filter((c) => !needle
      || [c.name, c.kind, c.category, c.owner, c.team].map(S).join(' ').toLowerCase().includes(needle));
    listEl.replaceChildren(...(rows.length
      ? rows.map(pickRow)
      : [emptyBox('Nothing matches that search', 'Try a service name, kind, owner or category.')]));
  };
  const search = h('input', {
    type: 'search', placeholder: 'Search services…', style: 'max-width:320px;margin-bottom:12px',
    onInput: (e) => draw(e.target.value),
  });
  draw('');
  el.append(search, listEl);
  // Picking one of N rows is not a "primary action", so the view's one
  // unmistakable action is the step that follows the list.
  const snap = await snapshot(api, ws).catch(() => ({}));
  const band = nextStepFor('service', snap, ws);
  band.querySelector('.nextstep-acts .btn')?.classList.add('btn-primary');
  el.append(band);
}

// --------------------------------------------------------------- 1. header

function header(d, ws) {
  const c = d.service || {};
  const p = d.posture || {};
  return h('div', null,
    h('div', { class: 'svc-head' },
      h('div', { style: 'min-width:280px;flex:1' },
        // "What led here" in the shared crumb style. The workspace name used to
        // be repeated here; it is in the sidebar switcher on every screen.
        h('a', { class: 'page-crumb', href: `#/${ws}/service` }, '← All service profiles'),
        h('h1', null, S(c.name) || '(unnamed component)'),
        // Restore layer and recovery scope used to be badges here too. They are
        // posture tiles 40px below, where each one carries the consequence
        // ("cannot be sequenced in a runbook" / "this service may not come
        // back") — so the tiles keep them and the header does not repeat them.
        h('div', { class: 'svc-badges' },
          c.kind ? badge(c.kind, 'accent') : null,
          c.tier === null || c.tier === undefined ? null : badge(`Tier ${c.tier}`, c.tier === 0 ? 'err' : c.tier === 1 ? 'warn' : ''),
          badge(catLabel(c.category))),
        c.description ? h('div', { class: 'svc-sub' }, c.description) : null,
        h('div', { class: 'svc-meta' },
          h('span', null, 'Owner ', h('b', null, S(c.owner) || '—'), c.team ? ` · ${c.team}` : ''),
          h('span', null, 'Recovery ', h('b', null, `${S(p.regions?.primary) || '?'} → ${S(p.regions?.recovery) || '?'}`)),
          c.definedIn ? h('span', null, 'Defined in ', h('b', null, c.definedIn)) : null,
          h('span', null, h('b', null, String(d.counts?.deps ?? 0)), ' dependencies · ',
            d.counts?.downstream
              ? h('span', null, h('b', null, String(d.counts.downstream)), ' components break without it')
              : h('span', null, 'nothing else depends on it'))))));
}

// --------------------------------------------------------------- 2. posture

/** "47 min (Dev recovery test #2 — Aug 28, 2026 — passed)" or the honest alternative. */
function numberLine(slot, label) {
  const d = describe(slot, { targetMinutes: null });
  if (slot.state === 'measured') return `${label} ${d.valueWithProvenance}`;
  if (slot.state === 'declared') return `${label} ${d.value} recorded by hand — not from a test`;
  return `${label} not measured`;
}

function postureStrip(d) {
  const p = d.posture || {};
  const rep = p.replication || {};
  // Provenance comes off the route when the server supplies it; otherwise
  // fromPosture() derives the same shape and — crucially — refuses to call a
  // failed, indirect or hand-typed number a measurement. The tile used to read
  // "Objectives met" off a verdict that a FAILED test, or a sibling service's
  // test sharing a runbook, could satisfy.
  const honest = fromPosture(p, null);
  const verdictKind = VERDICT_TONE[honest.verdict.overall] || 'warn';
  const verdictText = VERDICT_WORD[honest.verdict.overall] || 'Not measured yet';
  const target = `target RTO ${mins(honest.target.rtoMinutes) || 'not set'} · RPO ${mins(honest.target.rpoMinutes) || 'not set'}`;
  // The common truth for most components: nothing passed has ever covered
  // them. Say that first, whether the workspace has hand-recorded numbers
  // sitting on top of it or nothing at all.
  const nothingMeasured = honest.rta.state !== 'measured' && honest.rpa.state !== 'measured';
  const verdictNote = nothingMeasured
    ? `No passed test covers this service. ${
      honest.rta.state === 'declared' || honest.rpa.state === 'declared'
        ? `${numberLine(honest.rta, 'RTA')} · ${numberLine(honest.rpa, 'RPA')}. `
        : ''}${target}`
    : `${numberLine(honest.rta, 'RTA')} · ${numberLine(honest.rpa, 'RPA')} · ${target}`;
  return h('div', { class: 'svc-posture' },
    tile('DR strategy', S(p.drStrategy) || 'not set',
      p.strategySource === 'workspace' ? 'inherited from the workspace' : 'set on this service'),
    tile('Replication', S(rep.mechanism) || 'none recorded',
      rep.rpoMinutes !== null && rep.rpoMinutes !== undefined ? `RPO ${rep.rpoMinutes} min` : 'no RPO recorded',
      rep.mechanism ? '' : 'warn'),
    tile('Restore layer', S(p.restoreLayer) || 'unassigned', S(p.restoreLayerLabel) || 'cannot be sequenced in a runbook',
      p.restoreLayer ? '' : 'warn'),
    tile('Recovery scope', SCOPE_WORD[p.inRecoveryScope] || 'unknown',
      p.inRecoveryScope === 'yes' ? 'covered by the recovery plan' : 'this service may not come back',
      SCOPE_KIND[p.inRecoveryScope] === 'ok' ? 'ok' : SCOPE_KIND[p.inRecoveryScope] || 'warn'),
    tile('Measured for this service', verdictText, verdictNote, verdictKind));
}

/**
 * The provenance of this service's two numbers, spelled out under the strip —
 * including the case that is true for most components: no passed test covers
 * them, which is a to-do, not a failure.
 */
function provenanceNote(d, ws) {
  const p = d.posture || {};
  const honest = fromPosture(p, null);
  const row = (slot, label, unit) => {
    const de = describe(slot, { targetMinutes: null, unit });
    const t = slot.test;
    return h('div', { style: 'margin:4px 0;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap' },
      badge(de.badge, de.badgeTone),
      h('div', { style: 'flex:1;min-width:0;font-size:12.5px' },
        h('span', null, h('strong', null, `${label}: `),
          slot.state === 'measured'
            ? h('span', null, de.value, ' — from ',
              t?.id ? link(`#/${ws}/tests/${t.id}`, S(t.name) || 'the test') : (S(t?.name) || 'the test'),
              `${t?.date ? ` (${t.date})` : ''}, passed.`)
            : slot.state === 'declared'
              ? h('span', null, de.value, ' — recorded by hand on the workspace, not measured for this service.')
              : h('span', null, 'not measured.')),
        slot.note ? h('div', { class: 'hint', style: 'margin-top:2px' }, S(slot.note)) : null));
  };
  const warn = (honest.warnings || []).filter(Boolean);
  const la = honest.lastAttempt;
  return h('div', { class: 'svc-empty', style: 'margin:-6px 0 18px' },
    h('div', { class: 'e-t' }, 'Where these numbers come from'),
    row(honest.rta, 'Recovery time', 'recovery time'),
    row(honest.rpa, 'Data loss', 'data loss'),
    // The last run that touched this service, named as a run and nothing more.
    // It is the thing a reader will otherwise assume produced the numbers.
    la && la.status !== 'passed'
      ? h('div', { class: 'hint', style: 'margin-top:8px' },
        'Last test covering this service: ',
        la.id ? link(`#/${ws}/tests/${la.id}`, S(la.name) || 'a test') : (S(la.name) || 'a test'),
        `${la.date ? ` (${la.date})` : ''} — `, h('strong', null, S(la.status) || 'not passed'),
        '. Its numbers are a reading from a run that did not reach the success bar, not a measurement.')
      : null,
    warn.length
      ? h('div', { class: 'hint', style: 'margin-top:8px' }, warn.map((wtxt) => h('div', null, `• ${S(wtxt)}`)))
      : null,
    honest.rta.state !== 'measured' || honest.rpa.state !== 'measured'
      ? h('div', { class: 'e-a' },
        link(`#/${ws}/tests`, 'Plan a test that covers this service →', 'hint'))
      : null);
}

// --------------------------------------------------------------- 3. actions

// ONE primary action plus the one place you go to change what is on this page.
// "Open full diagram" already lives in the diagram section below, "Map
// dependencies" already lives in the attachments empty state, and "Build the
// full package" is the end-of-page next step — five competing buttons with no
// hierarchy told the user nothing about which one mattered.
function actionRow(d, ws) {
  const cid = d.service?.id || '';
  return h('div', { class: 'svc-actions' },
    actionLink(`/api/w/${encodeURIComponent(ws)}/export/xlsx?componentId=${encodeURIComponent(cid)}`,
      '⤓ Download this service’s DR package', { primary: true, download: true }),
    // The order this service's pieces have to come back in.
    cid ? actionLink(`#/${ws}/deploy-order/${cid}`, 'Deployment order') : null,
    actionLink(`#/${ws}/inventory`, 'Edit in Inventory'));
}

// ----------------------------------------------------- 4. risks / weak links

function riskRow(risk, ws, rootId) {
  return h('div', { class: 'svc-risk' },
    badge(risk.severity, SEV_KIND[risk.severity] || ''),
    h('div', { class: 'r-body' },
      h('div', { class: 'r-title' }, S(risk.title)),
      risk.detail ? h('div', { class: 'r-detail' }, S(risk.detail)) : null,
      risk.componentId && risk.componentId !== rootId
        ? link(`#/${ws}/service/${risk.componentId}`, `Open ${S(risk.componentName) || 'component'} →`, 'r-link hint')
        : null));
}

function weakLinks(d, ws) {
  const rootId = S(d.service?.id);
  const risks = Array.isArray(d.risks) ? d.risks : [];
  const loud = risks.filter((r) => r.severity === 'blocker' || r.severity === 'high');
  const quiet = risks.filter((r) => r.severity !== 'blocker' && r.severity !== 'high');
  const body = [];
  if (!risks.length) {
    body.push(h('div', { class: 'svc-weak calm' },
      h('div', { style: 'font-weight:650;color:var(--ok)' }, 'No weak links found for this service'),
      h('div', { class: 'hint', style: 'margin-top:4px' },
        'Every dependency is in scope with a verification, every secret is replicated, and a test has measured it. '
        + 'That is rare — re-check after the next inventory change.')));
  } else {
    if (loud.length) body.push(h('div', { class: 'svc-weak' }, loud.map((r) => riskRow(r, ws, rootId))));
    if (quiet.length) {
      body.push(h('details', { class: 'svc-grp svc-more' },
        h('summary', null, `${quiet.length} more finding${quiet.length === 1 ? '' : 's'} (medium / low)`,
          h('span', { class: 'g-n' }, 'data-quality work that will bite later')),
        h('div', { class: 'svc-grp-body' }, quiet.map((r) => riskRow(r, ws, rootId)))));
    }
  }
  return section(h('span', null, 'Weak links across its ', term('dependency closure')),
    null,
    risks.length ? `${d.counts?.weakLinks || 0} blocker/high · ${risks.length} total` : 'clean',
    ...body);
}

// --------------------------------------------- 5. the recovery order (L0→L7)

function depFlags(c, risksFor) {
  const flags = [];
  if (c.inRecoveryScope !== 'yes') flags.push(chip(SCOPE_WORD[c.inRecoveryScope] || 'scope unknown', c.inRecoveryScope === 'no' ? 'err' : 'warn'));
  if (!c.hasVerification) flags.push(chip('no verification', 'warn'));
  if (!c.restoreLayer) flags.push(chip('no restore layer', 'warn'));
  if (c.secretsAtRisk) flags.push(chip(`${c.secretsAtRisk} secret${c.secretsAtRisk === 1 ? '' : 's'} unconfirmed`, 'err'));
  if (!c.replication?.mechanism) flags.push(chip('no replication mechanism', 'warn'));
  if (c.criticalOutboundCount) flags.push(chip(`${c.criticalOutboundCount} critical outbound`, ''));
  for (const r of risksFor) {
    if (r.rule === 'manual-third-party-failover') flags.push(chip('manual partner failover', 'err'));
    if (r.rule === 'manual-cutover') flags.push(chip('manual cutover', 'err'));
  }
  return flags;
}

function depRow(c, ws, risksByComponent) {
  const risksFor = (risksByComponent.get(c.id) || []);
  const worst = risksFor.reduce((a, r) => Math.min(a, SEV_ORDER[r.severity] ?? 9), 9);
  const cls = c.isRoot ? 'is-root' : worst <= 1 ? 'weak' : worst === 2 ? 'soft' : '';
  const rep = c.replication || {};
  const flags = depFlags(c, risksFor);
  return h('div', { class: `svc-dep ${cls}` },
    h('div', null,
      h('div', { class: 'd-name' },
        c.isRoot ? h('span', null, S(c.name), ' ', badge('this service', 'accent'))
          : link(`#/${ws}/service/${c.id}`, S(c.name) || c.id)),
      h('div', { class: 'd-sub' },
        [catLabel(c.category), c.kind, c.tier === null ? '' : `Tier ${c.tier}`,
          c.direct === false ? 'indirect' : (c.isRoot ? '' : 'direct dependency')].filter(Boolean).join(' · '))),
    h('div', null, scopeBadge(c.inRecoveryScope)),
    h('div', null,
      h('div', null, S(rep.mechanism) || h('span', { class: 'hint' }, 'no mechanism')),
      h('div', { class: 'd-sub' }, rep.rpoMinutes === null || rep.rpoMinutes === undefined ? 'no RPO' : `RPO ${rep.rpoMinutes} min`)),
    h('div', null, c.hasVerification
      ? h('span', { title: c.verification?.command || '' }, badge('verified', 'ok'))
      : badge('no verify', 'warn')),
    flags.length ? h('div', { class: 'd-flags' }, flags) : null);
}

function recoveryOrder(d, ws, risksByComponent) {
  const groups = Array.isArray(d.closure?.byLayer) ? d.closure.byLayer : [];
  const body = [];
  if (!groups.length || !(d.counts?.deps > 0)) {
    body.push(emptyBox(`No dependencies recorded for ${S(d.service?.name)}`,
      'Nothing is listed as required before this service can serve traffic — which is almost never true. '
      + 'Add its cluster, database, cache, queues and secrets as dependencies so a runbook can sequence them.',
      [actionLink(`#/${ws}/inventory`, 'Add dependencies in Inventory', { primary: true }),
        actionLink(`#/${ws}/discover/aws`, 'Discover from AWS')]));
  } else {
    for (const g of groups) {
      body.push(h('div', { class: 'svc-layer' },
        h('div', { class: 'l-head' },
          h('span', { class: 'l-id' }, g.layer || '—'),
          h('span', { class: 'l-label' }, S(g.label)),
          h('span', { class: 'l-n' }, `${g.components.length} component${g.components.length === 1 ? '' : 's'}`)),
        g.components.map((c) => depRow(c, ws, risksByComponent))));
    }
  }
  const dangling = d.closure?.danglingDepIds || [];
  if (dangling.length) {
    body.push(h('div', { class: 'hint', style: 'margin-top:10px;color:var(--warn)' },
      `${dangling.length} dependency id${dangling.length === 1 ? '' : 's'} on this component no longer exist in the inventory `
      + `(deleted components leave the reference behind): ${dangling.join(', ')}`));
  }
  if (Array.isArray(d.dependents) && d.dependents.length) {
    body.push(h('div', { style: 'margin-top:16px' },
      h('div', { class: 'hint', style: 'margin-bottom:6px' },
        `Used by — ${d.dependents.length} component${d.dependents.length === 1 ? '' : 's'} break directly without this service`
        + (d.impact?.transitiveCount ? ` (${d.impact.transitiveCount} including knock-on effects)` : '')),
      h('div', { class: 'row' }, d.dependents.map((c) => link(`#/${ws}/service/${c.id}`, S(c.name), 'svc-chip accent')))));
  }
  const n = d.counts?.deps || 0;
  return section('What it needs to come back',
    'In this order, L0 → L7. Red rows are the weak links.',
    `${n} component${n === 1 ? '' : 's'} in the closure`,
    ...body);
}

// --------------------------------------------------- 6. resource attachments

function attachments(d, ws) {
  const g = d.graph || {};
  const counts = g.countsByType || {};
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  if (!types.length) {
    return section('What it is attached to',
      'The AWS resources that decide whether a recovered service can talk to anything.',
      'nothing mapped',
      emptyBox(g.hasGraph ? 'No resources mapped to this service yet' : 'No resource graph yet',
        g.hasGraph
          ? `The workspace graph holds ${g.workspaceNodeCount} resource(s), but none is linked to this component. `
            + 'Run deep enrichment for it in Discover → AWS → Map dependencies.'
          : 'Deep enrichment reads the real associations (security groups, subnets, IAM, target groups, KMS, certs) '
            + 'from your account — read-only — so the recovery plan stops guessing.',
        [actionLink(`#/${ws}/discover/aws`, 'Discover → Map dependencies', { primary: true })]));
  }
  const nodes = g.nodes || {};
  const byType = new Map();
  for (const [rid, n] of Object.entries(nodes)) {
    const t = S(n?.type) || 'other';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push({ rid, n });
  }
  const groups = types.map((t) => {
    const rows = (byType.get(t) || []).sort((a, b) => S(a.n?.name || a.rid).localeCompare(S(b.n?.name || b.rid)));
    return h('details', { class: 'svc-grp' },
      h('summary', null, RES_LABEL[t] || t, h('span', { class: 'g-n' }, `${counts[t]}`)),
      h('div', { class: 'svc-grp-body' }, rows.map(({ rid, n }) => h('div', { class: 'svc-res' },
        h('span', null, S(n?.name) || rid),
        n?.service ? h('span', { class: 'g-n' }, S(n.service)) : null,
        h('span', { class: 'r-rid' }, rid)))));
  });
  return section('What it is attached to',
    'From the resource graph, 2 hops out — these are what break silently after a failover.',
    `${g.nodeCount} resource${g.nodeCount === 1 ? '' : 's'} · ${types.length} type${types.length === 1 ? '' : 's'}`,
    h('div', null, groups),
    h('div', { class: 'hint', style: 'margin-top:6px' },
      g.updatedAt ? `Graph last enriched ${S(g.updatedAt).slice(0, 10)} · ` : '',
      link(`#/${ws}/discover/aws`, 'refresh in Discover → AWS')));
}

// ------------------------------------------------------- 7. outbound calls

function outbound(d, ws) {
  const calls = Array.isArray(d.outboundCalls) ? d.outboundCalls : [];
  if (!calls.length) {
    return section('Who it talks to', 'Every outbound call is a chance to fail after failover.',
      'none recorded',
      emptyBox('No outbound calls recorded',
        'Almost every service calls something. Add them on the component (Inventory → Outbound calls), or import a '
        + 'firewall/flow export in Discover → Network flows to discover them from real traffic.',
        [actionLink(`#/${ws}/inventory`, 'Add outbound calls', { primary: true }),
          actionLink(`#/${ws}/discover/network`, 'Import network flows')]));
  }
  const rows = calls.map((o) => {
    const external = o.type === 'third-party' || o.type === 'saas' || o.type === 'on-prem';
    const risky = external && (o.critical || !o.failoverBehavior || /manual|allow ?-?list|ticket/i.test(S(o.failoverBehavior)));
    return h('tr', { style: risky ? 'background:var(--err-soft)' : null },
      h('td', null,
        h('div', { style: 'font-weight:600' }, S(o.target) || '(unnamed)'),
        h('div', { class: 'hint' },
          o.own ? 'called by this service' : `via ${S(o.componentName)}`,
          o.workload ? ` · ${S(o.workload)}` : '', o.pod ? ` · pod ${S(o.pod)}` : '')),
      h('td', null, badge(S(o.type) || 'internal', external ? 'warn' : ''),
        o.critical ? h('div', { style: 'margin-top:3px' }, badge('critical', 'err')) : null),
      h('td', null, [S(o.protocol), o.port === null || o.port === undefined ? '' : `:${o.port}`].join('') || '—'),
      h('td', null, S(o.purpose) || h('span', { class: 'hint' }, '—')),
      h('td', null, o.failoverBehavior
        ? h('span', { style: risky ? 'color:#f2938e' : null }, S(o.failoverBehavior))
        : badge('not recorded', 'warn'),
      o.resolvedComponentId && o.resolvedScope && o.resolvedScope !== 'yes'
        ? h('div', { style: 'margin-top:4px' },
          link(`#/${ws}/service/${o.resolvedComponentId}`,
            `${S(o.resolvedComponentName)} — ${SCOPE_WORD[o.resolvedScope] || o.resolvedScope}`, 'hint'))
        : null),
      h('td', null, o.observedCount ? `${o.observedCount}×` : h('span', { class: 'hint' }, '—')));
  });
  const ext = calls.filter((o) => o.type === 'third-party' || o.type === 'saas').length;
  return section('Who it talks to',
    'Rows in red need a human, or have no recorded failover behaviour.',
    `${calls.length} call${calls.length === 1 ? '' : 's'}${ext ? ` · ${ext} third-party/SaaS` : ''}`,
    h('div', { class: 'svc-scroll' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null,
          ['Destination', 'Type', 'Protocol', 'Purpose', 'Failover behavior', 'Observed'].map((t) => h('th', null, t)))),
        h('tbody', null, rows))));
}

// -------------------------------------------------------- 8. recover it

function runbookCard(rb, ws) {
  return h('div', { class: 'svc-rb' },
    h('div', { class: 'row' },
      h('span', { class: 'rb-n' }, S(rb.name)),
      rb.tooling ? badge(rb.tooling, 'accent') : null,
      rb.covers === 'direct' ? badge('names this service', 'ok') : badge('covers its dependencies', '')),
    h('div', { class: 'hint', style: 'margin-top:4px' },
      `${rb.steps} step${rb.steps === 1 ? '' : 's'}`,
      rb.gates ? ` · ${rb.gates} gate${rb.gates === 1 ? '' : 's'}` : '',
      rb.estMinutes ? ` · ~${rb.estMinutes} min end-to-end` : '',
      rb.rollbackSteps ? ` · ${rb.rollbackSteps} rollback` : '',
      rb.scenario ? ` · ${rb.scenario}` : ''),
    (rb.serviceSteps || []).length
      ? h('div', { style: 'margin-top:8px' },
        h('div', { class: 'hint' }, 'Steps that name this service:'),
        rb.serviceSteps.map((s) => h('div', { class: 'svc-step' },
          h('b', { style: 'color:var(--text)' }, `${s.layer ? `[${s.layer}] ` : ''}${S(s.title)}`),
          s.gate ? ' · GATE' : '', s.estMinutes ? ` · ${s.estMinutes} min` : '',
          s.pass ? h('div', null, `pass when: ${S(s.pass)}`) : null)))
      : null,
    h('div', { class: 'row', style: 'margin-top:10px' },
      actionLink(`#/${ws}/runbooks`, 'Open runbook'),
      actionLink(`/api/w/${encodeURIComponent(ws)}/export/runbook/${encodeURIComponent(rb.id)}.md`, '⤓ Markdown', { download: true })));
}

function testCard(t, ws) {
  const failed = (t.appTests || []).filter((a) => a.result === 'fail');
  return h('div', { class: 'svc-rb' },
    h('div', { class: 'row' },
      h('span', { class: 'rb-n' }, S(t.name)),
      badge(S(t.status), STATUS_KIND[t.status] || ''),
      t.covers === 'direct' ? badge('tested this service', 'ok') : badge(`via ${t.covers}`, '')),
    h('div', { class: 'hint', style: 'margin-top:4px' },
      [S(t.date) || 'no date', S(t.type),
        t.rtaMinutes === null ? 'RTA unmeasured' : `RTA ${t.rtaMinutes} min`,
        t.rpaMinutes === null ? 'RPA unmeasured' : `RPA ${t.rpaMinutes} min`,
        t.cleanRun ? 'clean run' : 'not a clean run'].filter(Boolean).join(' · ')),
    (t.appTests || []).length
      ? h('div', { style: 'margin-top:8px' },
        h('div', { class: 'hint' }, 'App tests in this service’s closure:'),
        t.appTests.map((a) => h('div', { class: 'svc-step' },
          a.result ? badge(a.result, a.result === 'pass' ? 'ok' : 'err') : badge('no result', ''),
          ' ', h('span', { style: a.forService ? 'color:var(--text);font-weight:600' : null }, S(a.name)),
          a.componentName ? h('span', { class: 'hint' }, ` — ${S(a.componentName)}`) : null)))
      : null,
    (t.findings || []).length
      ? h('div', { style: 'margin-top:8px' },
        h('div', { class: 'hint' }, 'Findings:'),
        t.findings.map((f) => h('div', { class: 'svc-step' },
          badge(S(f.severity), SEV_KIND[f.severity] || ''), ' ', S(f.title),
          f.ticket ? h('span', { class: 'hint' }, ` · ${S(f.ticket)}`) : null)))
      : null,
    failed.length && t.status === 'failed'
      ? h('div', { class: 'hint', style: 'margin-top:6px;color:#f2938e' },
        `${failed.length} app test${failed.length === 1 ? '' : 's'} failed — this service has no passing recovery evidence from this run.`)
      : null,
    h('div', { class: 'row', style: 'margin-top:10px' }, actionLink(`#/${ws}/tests`, 'Open in Tests')));
}

function recoverIt(d, ws) {
  const rbs = Array.isArray(d.runbooks) ? d.runbooks : [];
  const tests = Array.isArray(d.tests) ? d.tests : [];
  const left = rbs.length
    ? h('div', { class: 'grid' }, rbs.map((rb) => runbookCard(rb, ws)))
    : emptyBox('No runbook covers this service',
      'Nothing written down means the recovery happens from memory, at 3am, by whoever is awake. Start from a '
      + 'template on the Runbooks page — it will pre-fill the L0→L7 steps from this service’s dependencies.',
      [actionLink(`#/${ws}/runbooks`, 'Draft a runbook', { primary: true })]);
  const right = tests.length
    ? h('div', { class: 'grid' }, tests.map((t) => testCard(t, ws)))
    : emptyBox('No test has covered this service',
      'An untested recovery path is a hypothesis. Plan a component test, or add this service to the app-test list of '
      + 'the next recovery test so its RTA and RPA get measured.',
      [actionLink(`#/${ws}/tests`, 'Plan a test', { primary: true })]);
  return section('How we recover it',
    'The written procedure, and the evidence that it worked.',
    `${rbs.length} runbook${rbs.length === 1 ? '' : 's'} · ${tests.length} test${tests.length === 1 ? '' : 's'}`,
    h('div', { class: 'svc-two' },
      h('div', null, h('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Runbooks'), left),
      h('div', null, h('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Tests & exercises'), right)));
}

// ------------------------------------------------------------ 9. gaps

function gapsSection(d, ws) {
  const gaps = Array.isArray(d.gaps) ? d.gaps : [];
  const inline = Array.isArray(d.inlineGaps) ? d.inlineGaps : [];
  if (!gaps.length && !inline.length) {
    return section('What’s in the way', 'Tracked gaps for this service and its closure, worst first.', 'none',
      emptyBox('No gaps recorded for this service',
        'Either it is genuinely clean, or nobody has written the problems down yet. Findings from a failed test '
        + 'become gaps — that is how the loop closes.',
        [actionLink(`#/${ws}/tests`, 'Open Tests & gaps', { primary: true })]));
  }
  const rows = gaps.map((g) => h('tr', null,
    h('td', null, badge(S(g.severity), SEV_KIND[g.severity] || '')),
    h('td', null,
      h('div', { style: 'font-weight:600' }, S(g.title)),
      g.notes ? h('div', { class: 'hint', style: 'max-width:70ch' }, S(g.notes)) : null),
    h('td', null, g.componentId
      ? link(`#/${ws}/service/${g.componentId}`, S(g.componentName) || g.componentId)
      : h('span', { class: 'hint' }, 'workspace-wide'),
    g.forService ? h('div', null, badge('this service', 'accent')) : null),
    h('td', null, badge(S(g.status), g.status === 'open' ? 'warn' : g.status === 'resolved' ? 'ok' : '')),
    h('td', null, S(g.class) || '—', g.ticket ? h('div', { class: 'hint' }, S(g.ticket)) : null),
    h('td', null, actionLink(`#/${ws}/tests`, 'Fix →'))));
  const open = gaps.filter((g) => g.status === 'open').length;
  return section('What’s in the way',
    'Worst first. Each one links to where it gets fixed.',
    `${open} open · ${gaps.length} total`,
    gaps.length
      ? h('div', { class: 'svc-scroll' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Severity', 'Gap', 'Component', 'Status', 'Class', ''].map((t) => h('th', null, t)))),
        h('tbody', null, rows)))
      : null,
    inline.length
      ? h('details', { class: 'svc-grp', style: 'margin-top:12px' },
        h('summary', null, `${inline.length} untracked note${inline.length === 1 ? '' : 's'} on components`,
          h('span', { class: 'g-n' }, 'written on the component, not yet a tracked gap')),
        h('div', { class: 'svc-grp-body' }, inline.map((g) => h('div', null,
          g.forService ? badge('this service', 'accent') : null, ' ',
          link(`#/${ws}/service/${g.componentId}`, S(g.componentName), 'hint'), ' — ', S(g.text)))))
      : null);
}

// ------------------------------------------------------------ 10. k8s

function k8sSection(d) {
  const ws = Array.isArray(d.k8sWorkloads) ? d.k8sWorkloads : [];
  if (!ws.length) return null;
  const rows = ws.map((w) => h('tr', null,
    h('td', null,
      h('div', { style: w.forService ? 'font-weight:650' : null }, `${S(w.namespace)}/${S(w.name)}`),
      h('div', { class: 'hint' }, S(w.kind), w.forService ? ' · this service' : ` · ${S(w.componentName)}`)),
    h('td', null, w.replicas ? `${w.replicas.ready ?? '?'} / ${w.replicas.desired ?? '?'}` : '—'),
    h('td', null, S(w.serviceAccount) || '—'),
    h('td', null, (w.secrets || []).length ? w.secrets.join(', ') : h('span', { class: 'hint' }, '—')),
    h('td', { class: 'hint', style: 'overflow-wrap:anywhere' }, (w.images || []).join(' '))));
  return section('Kubernetes workloads',
    'A secret listed here that is not replicated is a crash loop in the recovery region.',
    `${ws.length} workload${ws.length === 1 ? '' : 's'}`,
    h('div', { class: 'svc-scroll' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Workload', 'Ready', 'Service account', 'Secrets', 'Images'].map((t) => h('th', null, t)))),
      h('tbody', null, rows))));
}

// ------------------------------------------------------------ 11. diagram

function diagramSection(d, ws, api) {
  const did = d.diagrams?.resourceMap || d.diagrams?.dependencies;
  const host = h('div', { class: 'svc-canvas' }, h('div', { class: 'loading', style: 'padding:22px' }, 'Loading diagram…'));
  const sec = section('What it looks like',
    d.diagrams?.resourceMap ? null : 'Map dependencies in Discover to get the AWS resources too.',
    null,
    host,
    h('div', { class: 'hint', style: 'margin-top:8px' },
      link(`#/${ws}/diagrams/${did}`, 'Open in Diagrams'), ' — full canvas, drag-to-arrange, Mermaid and draw.io export'));

  // Lazy: never block the page on the canvas engine, never break without it.
  (async () => {
    let mod;
    let ctrl = null;
    const fallback = (msg) => {
      host.replaceChildren(h('div', { style: 'padding:22px' },
        h('div', { style: 'font-weight:650;margin-bottom:4px' }, 'Diagram not shown inline'),
        h('div', { class: 'hint', style: 'margin-bottom:10px' }, msg),
        actionLink(`#/${ws}/diagrams/${did}`, 'Open it on the Diagrams page', { primary: true })));
    };
    try { mod = await import('../diagram-canvas.js'); }
    catch (e) { fallback(`The icon-canvas engine could not be loaded (${e.message}).`); return; }
    let data;
    try { data = await api.get(`/w/${ws}/diagrams/${encodeURIComponent(did)}/canvas`); }
    catch (e) { fallback(`This diagram is not available yet (${e.message}).`); return; }
    try {
      host.replaceChildren();
      host.style.minHeight = '440px';
      ctrl = await mod.createCanvas(host, { data, readOnly: true, template: 'layer-rows' });
    } catch (e) { fallback(`The diagram could not be rendered (${e.message}).`); return; }
    // No unmount hook in the router — tear down when the route changes.
    const off = () => {
      try { ctrl?.destroy?.(); } catch { /* engine owns its own state */ }
      window.removeEventListener('hashchange', off);
    };
    window.addEventListener('hashchange', off);
  })();

  return sec;
}

// ------------------------------------------------------------ 12. AI row
// The four asks, through the SHARED ui.aiRow() helper. This used to be ~110
// lines of bespoke machinery — its own AI_ASKS table, an aiUnavailable() probe
// that handled three historical shapes of AI_AVAILABLE, a hand-rolled result
// modal and a fallback button — all to do what ui.aiRow() already does for every
// other page, including degrading invisibly when ai-actions.js is absent.
function aiSection(d, ws, api) {
  const name = S(d.service?.name);
  const asks = [
    ['Explain this service\u2019s DR posture in plain English', 'answer',
      `Explain the disaster-recovery posture of the service "${name}" in plain English, for a manager who is not an engineer. `
      + 'Use only this workspace\'s data. Cover: what it is, what it needs to come back and in what order, what is proven by tests, '
      + 'and the two or three things most likely to make a real failover fail. Be specific and honest about what is unmeasured.'],
    ['What breaks first if we fail over right now?', 'answer',
      `If we failed over to the recovery region right now, what breaks first for the service "${name}"? `
      + 'Walk the restore layers L0\u2192L7 in order, name the first hard stop, then the next two. '
      + 'Ground every claim in the inventory data (recovery scope, replication, secrets, outbound calls, test findings).'],
    ['Draft a runbook for this service', 'operations',
      `Draft a recovery runbook for the service "${name}" as concrete operations I can review. `
      + 'Sequence the steps by restore layer L0\u2192L7 using its dependency closure, put a gate on every layer, '
      + 'use each component\'s verification command as that step\'s verify/pass, and include the business success bar.'],
    ['What am I missing for this service?', 'operations',
      `Review the DR data for the service "${name}" and tell me what is missing or inconsistent: `
      + 'undeclared dependencies, missing verifications, unreplicated secrets, outbound calls with no failover behavior, '
      + 'objectives never measured. Propose the specific edits as reviewable operations.'],
  ];
  return section('Ask the AI about this service',
    'Grounded in this workspace\u2019s data only; nothing is applied without your review.',
    null,
    aiRow({
      ws, api, intro: 'Ask AI:',
      context: { kind: 'component', id: S(d.service?.id) },
      actions: asks.map(([label, mode, prompt]) => ({ label, mode, prompt })),
    }));
}


// ------------------------------------------------------------ page module

export default {
  title: 'Service DR profile',
  async render(el, ctx) {
    const { ws, api, params } = ctx;
    el.append(h('style', null, STYLE));
    const cid = S(params?.[0]);
    if (!cid) { await renderPicker(el, ctx); return; }

    let d;
    try { d = await api.get(`/w/${ws}/service/${encodeURIComponent(cid)}`); }
    catch (e) {
      el.append(card(
        h('h2', null, 'This service profile could not be loaded'),
        h('p', { class: 'hint', style: 'margin:6px 0 12px' }, S(e?.message) || 'unknown error'),
        h('div', { class: 'row' },
          actionLink(`#/${ws}/service`, 'Pick another service', { primary: true }),
          actionLink(`#/${ws}/inventory`, 'Open Inventory'))));
      return;
    }

    const risksByComponent = new Map();
    for (const r of (Array.isArray(d.risks) ? d.risks : [])) {
      if (!r.componentId) continue;
      if (!risksByComponent.has(r.componentId)) risksByComponent.set(r.componentId, []);
      risksByComponent.get(r.componentId).push(r);
    }

    el.append(
      header(d, ws),
      actionRow(d, ws),
      postureStrip(d),
      provenanceNote(d, ws),
      weakLinks(d, ws),
      recoveryOrder(d, ws, risksByComponent),
      attachments(d, ws),
      outbound(d, ws),
      recoverIt(d, ws),
      gapsSection(d, ws),
      k8sSection(d),
      diagramSection(d, ws, api),
    );

    // ui.aiRow() returns synchronously and fills itself in (or stays invisible)
    // when ai-actions.js is present — no lazy-append dance needed here.
    el.append(aiSection(d, ws, api));

    // Never a dead end: the same progression model as every other page.
    const snap = await snapshot(api, ws).catch(() => ({}));
    el.append(nextStepFor('service', snap, ws));
  },
};
