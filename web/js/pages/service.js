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
import { h, card, badge, toast, modal, markdown } from '../ui.js';

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
  .svc-ai { display:flex; gap:8px; flex-wrap:wrap; }
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
  el.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h1', null, 'Service DR profile'),
      h('div', { class: 'sub' }, 'Pick a service to see its whole disaster-recovery story in one place'))));
  if (!items.length) {
    el.append(emptyBox('No components yet',
      'The service profile reads the inventory. Add your main application, its databases and the network it lives in first.',
      [actionLink(`#/${ws}/inventory`, 'Open Inventory', { primary: true }),
        actionLink(`#/${ws}/discover/aws`, 'Discover from AWS')]));
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
}

// --------------------------------------------------------------- 1. header

function header(d, ws) {
  const c = d.service || {};
  const p = d.posture || {};
  return h('div', null,
    h('div', { class: 'svc-head' },
      h('div', { style: 'min-width:280px;flex:1' },
        h('div', { class: 'hint', style: 'margin-bottom:2px' },
          link(`#/${ws}/service`, 'Service DR profile'), ' · ', S(d.workspace?.name || ws)),
        h('h1', null, S(c.name) || '(unnamed component)'),
        h('div', { class: 'svc-badges' },
          c.kind ? badge(c.kind, 'accent') : null,
          c.tier === null || c.tier === undefined ? null : badge(`Tier ${c.tier}`, c.tier === 0 ? 'err' : c.tier === 1 ? 'warn' : ''),
          badge(catLabel(c.category)),
          c.restoreLayer ? badge(`${c.restoreLayer} — ${c.restoreLayerLabel || 'layer'}`, 'accent') : badge('no restore layer', 'warn'),
          scopeBadge(c.inRecoveryScope)),
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

function postureStrip(d) {
  const p = d.posture || {};
  const rep = p.replication || {};
  const m = p.measured;
  const verdictKind = p.verdict === 'met' ? 'ok' : p.verdict === 'missed' ? 'err' : 'warn';
  const verdictText = p.verdict === 'met' ? 'Objectives met' : p.verdict === 'missed' ? 'Objectives missed' : 'Unmeasured';
  const verdictNote = m
    ? `${m.name} · ${m.date || 'no date'} · RTA ${mins(m.rtaMinutes) || '—'} / RPA ${mins(m.rpaMinutes) || '—'}`
    : 'No completed test has measured this service — its RTA and RPO are a hypothesis.';
  const target = `target RTO ${mins(p.objectives?.rtoMinutes) || 'not set'} · RPO ${mins(p.targetRpoMinutes) || 'not set'}`;
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
    tile('Last measured', verdictText, `${verdictNote} · ${target}`, verdictKind));
}

// --------------------------------------------------------------- 3. actions

function actionRow(d, ws) {
  const cid = d.service?.id || '';
  const did = d.diagrams?.resourceMap || d.diagrams?.dependencies;
  return h('div', { class: 'svc-actions' },
    actionLink(`/api/w/${encodeURIComponent(ws)}/export/xlsx?componentId=${encodeURIComponent(cid)}`,
      '⤓ Download DR package (xlsx)', { primary: true, download: true }),
    actionLink(`#/${ws}/exports`, 'Build the full package…'),
    actionLink(`#/${ws}/inventory`, 'Open in Inventory'),
    did ? actionLink(`#/${ws}/diagrams/${did}`, 'Open full diagram') : null,
    actionLink(`#/${ws}/discover/aws`, 'Map dependencies'));
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
  return section('Weak links',
    'Computed from this service and everything in its dependency closure — out-of-scope dependencies, missing '
    + 'verifications, unreplicated secrets, manual third-party failover, untested paths, and measured RPO/RTO misses.',
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
    `Before ${S(d.service?.name)} can serve traffic, everything below must be up — in this order, L0 → L7. `
    + 'Red rows are the weak links: out of scope, unverifiable, or unreplicated.',
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
      'Security groups, subnets and AZs, IAM roles, target groups, KMS keys, certificates — the AWS resources that '
      + 'quietly decide whether a recovered service can actually talk to anything.',
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
    'The AWS resources this service is wired to, from the resource graph (2 hops). These are what break silently '
    + 'after a failover: a security group that does not exist in the recovery region, a target group with no targets.',
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
    return section('Who it talks to', 'Every outbound call is a chance to fail after failover — allowlists, egress IPs, partner endpoints.',
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
    'Third-party and partner calls are the classic failover blockers: they need allowlists, static egress IPs or a '
    + 'support ticket with days of lead time. Rows in red need a human or have no recorded failover behavior.',
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
    'The written procedure, and the evidence that it worked. A runbook step that names this service is what an '
    + 'operator will actually follow; a passed test with a measured RTA/RPA is the only proof it comes back.',
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
    'Tracked gaps for this service and everything it depends on, worst first. Each one links to where it gets fixed.',
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
    'From the captured cluster snapshot — the pods, service accounts and secret mounts behind this service. '
    + 'A secret listed here that is not replicated is a crash loop in the recovery region.',
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
    d.diagrams?.resourceMap
      ? 'This service, its dependencies and the real AWS resources behind them.'
      : 'This service and its dependency closure. Map dependencies in Discover to get the AWS resources too.',
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

// Each offer maps onto the ai-actions.js contract: mode 'answer' → a grounded
// explanation, mode 'operations' → concrete edits shown for review before any
// of them is applied. `context` is the focused selector the AI bridge expects.
const AI_ASKS = [
  {
    key: 'explain',
    label: 'Explain this service’s DR posture in plain English',
    prompt: (n) => `Explain the disaster-recovery posture of the service "${n}" in plain English, for a manager who is not an engineer. `
      + 'Use only this workspace\'s data. Cover: what it is, what it needs to come back and in what order, what is proven by tests, '
      + 'and the two or three things most likely to make a real failover fail. Be specific and honest about what is unmeasured.',
  },
  {
    key: 'breaks-first',
    label: 'What breaks first if we fail over right now?',
    prompt: (n) => `If we failed over to the recovery region right now, what breaks first for the service "${n}"? `
      + 'Walk the restore layers L0→L7 in order, name the first hard stop, then the next two. '
      + 'Ground every claim in the inventory data (recovery scope, replication, secrets, outbound calls, test findings).',
  },
  {
    key: 'runbook',
    label: 'Draft a runbook for this service',
    ops: true,
    prompt: (n) => `Draft a recovery runbook for the service "${n}" as concrete operations I can review. `
      + 'Sequence the steps by restore layer L0→L7 using its dependency closure, put a gate on every layer, '
      + 'use each component\'s verification command as that step\'s verify/pass, and include the business success bar.',
  },
  {
    key: 'missing',
    label: 'What am I missing for this service?',
    ops: true,
    prompt: (n) => `Review the DR data for the service "${n}" and tell me what is missing or inconsistent: `
      + 'undeclared dependencies, missing verifications, unreplicated secrets, outbound calls with no failover behavior, '
      + 'objectives never measured. Propose the specific edits as reviewable operations.',
  },
];

// True only when the module says AI is definitely unavailable. AI_AVAILABLE is
// a thenable in the shipped module, but a boolean or a function in earlier
// drafts — all three are handled, and "unknown" never hides the offers.
async function aiUnavailable(mod, ws, api) {
  const A = mod.AI_AVAILABLE;
  try {
    if (typeof A === 'function') return (await A({ ws, api })) === false;
    if (A && typeof A.then === 'function') return (await A) === false;
    return A === false;
  } catch { return false; }
}

async function aiRow(d, ctx) {
  const { ws, api } = ctx;
  const name = S(d.service?.name);
  const componentId = S(d.service?.id);
  let mod = null;
  try { mod = await import('../ai-actions.js'); } catch { return null; } // not shipped — stay silent
  if (!mod) return null;

  const context = { kind: 'component', id: componentId };

  // Fallback path, used only if the module has no aiButton: we own the button
  // and the result modal. Never applies anything.
  const run = async (ask) => {
    const prompt = ask.prompt(name);
    const opts = { ws, api, prompt, instruction: prompt, context, kind: 'component' };
    try {
      const fn = ask.ops && typeof mod.aiOperations === 'function' ? mod.aiOperations : mod.aiAsk;
      if (typeof fn !== 'function') { toast('AI actions expose no usable entry point', 'err'); return; }
      const out = await fn(opts);
      if (out === undefined || out === null) return;        // the module handled its own UI
      if (out.nodeType) { await modal(ask.label, out, { wide: true }); return; }
      if (out.ok === false) { toast(S(out.message) || 'AI is unavailable', 'err'); return; }
      const text = typeof out === 'string' ? out : S(out.answer || out.markdown || out.summary || out.text);
      if (text) await modal(ask.label, markdown(text), { wide: true });
      else toast('The AI returned nothing to show', 'err');
    } catch (e) { toast(S(e?.message) || 'AI action failed', 'err'); }
  };

  const hasButton = typeof mod.aiButton === 'function';
  // Without aiButton we must know availability ourselves; aiButton disables
  // itself (with an install hint) when the CLI is missing, which is better UX.
  if (!hasButton && await aiUnavailable(mod, ws, api)) return null;

  const buttons = [];
  for (const ask of AI_ASKS) {
    let node = null;
    if (hasButton) {
      try {
        node = mod.aiButton({
          ws, api, label: ask.label, modalTitle: ask.label,
          prompt: ask.prompt(name), instruction: ask.prompt(name),
          mode: ask.ops ? 'operations' : 'answer',
          context, kind: 'component', size: 'md',
        });
        if (node && typeof node.then === 'function') node = await node.catch(() => null);
      } catch { node = null; }
    }
    if (!(node && node.nodeType)) {
      if (typeof mod.aiAsk !== 'function' && typeof mod.aiOperations !== 'function') return null;
      node = h('button', { class: 'btn', onClick: () => run(ask) }, ask.label);
    }
    buttons.push(node);
  }
  if (!buttons.length) return null;
  return section('Ask the AI about this service',
    'Grounded in this workspace’s data only. Anything the AI wants to change is shown for review before it is applied.',
    null,
    h('div', { class: 'svc-ai' }, buttons));
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
      weakLinks(d, ws),
      recoveryOrder(d, ws, risksByComponent),
      attachments(d, ws),
      outbound(d, ws),
      recoverIt(d, ws),
      gapsSection(d, ws),
      k8sSection(d),
      diagramSection(d, ws, api),
    );

    // AI is optional and lazy — append when (and only if) it is actually there.
    const aiHost = h('div');
    el.append(aiHost);
    aiRow(d, ctx).then((node) => { if (node) aiHost.append(node); }).catch(() => { /* silent */ });
  },
};
