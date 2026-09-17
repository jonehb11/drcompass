// Diagram generators — turn workspace inventory into Mermaid + draw.io XML.
// Every generator takes ({workspace, components, runbooks}) and returns
// { id, name, kind, mermaid, notes, componentIds } (componentIds = real
// components that appear in the picture, used to subset the drawio export).

// ---------------------------------------------------------------- constants

const CATEGORY_ORDER = [
  'edge-dns', 'third-party', 'compute', 'networking', 'database', 'storage',
  'messaging-streaming', 'security-secrets', 'identity-access',
  'cicd-control-plane', 'observability', 'other',
];

const CATEGORY_LABEL = {
  'compute': 'Compute',
  'networking': 'Networking',
  'storage': 'Storage',
  'database': 'Databases',
  'messaging-streaming': 'Messaging & streaming',
  'security-secrets': 'Security & secrets',
  'edge-dns': 'Edge & DNS',
  'identity-access': 'Identity & access',
  'observability': 'Observability',
  'third-party': 'Third-party',
  'cicd-control-plane': 'CI/CD & control plane',
  'other': 'Other',
};

const LAYERS = [
  ['L0', 'Guardrails & backups'],
  ['L1', 'Recovery launch'],
  ['L2', 'Platform'],
  ['L3', 'Data & secrets'],
  ['L4', 'Applications'],
  ['L5', 'Edge reachability'],
  ['L6', 'Functional success bar'],
  ['L7', 'Live cutover'],
];

const TOOL_NAME = {
  'arpio': 'Arpio',
  'region-switch': 'AWS Region Switch',
  'arc-routing-controls': 'ARC routing controls',
  'elastic-dr': 'AWS Elastic DR',
  'gitops-iac': 'GitOps IaC',
  'resilience-hub': 'Resilience Hub',
  'backup': 'AWS Backup',
};

const DATA_CATEGORIES = ['database', 'storage', 'messaging-streaming'];

// ---------------------------------------------------------------- helpers

// Make any string safe inside a double-quoted mermaid label.
export function sanitizeLabel(s) {
  return String(s ?? '')
    .replace(/"/g, "'")
    .replace(/[\[{]/g, '(')
    .replace(/[\]}]/g, ')')
    .replace(/[<>]/g, '')
    .replace(/[;\r\n|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'unnamed';
}

// Free text on a sequenceDiagram line (runs to end of line, unquoted).
function seqText(s) {
  return String(s ?? '')
    .replace(/[;\r\n]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, n = 64) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function byId(components) {
  return new Map(components.map((c) => [c.id, c]));
}

// Stable short node ids: component id -> c0, c1, ...
function nodeIds(components) {
  const m = new Map();
  components.forEach((c, i) => m.set(c.id, `c${i}`));
  return m;
}

function categoriesPresent(components) {
  const present = new Set(components.map((c) => c.category || 'other'));
  const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
  for (const c of present) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

function toolName(workspace) {
  const t = (workspace?.tooling || [])[0];
  return TOOL_NAME[t] || 'DR tool';
}

const rpoText = (c) =>
  c.replication?.rpoMinutes === 0 ? 'rebuilt cold' :
  c.replication?.rpoMinutes ? `RPO ${c.replication.rpoMinutes}m` : '';

// "mechanism · RPO 30m" without repeating ourselves for rebuild-type stores.
function replLabelParts(c) {
  const mech = c.replication?.mechanism || 'unknown';
  const rpo = rpoText(c);
  return mech === 'rebuild' ? ['rebuilt cold on failover'] : [mech, rpo].filter(Boolean);
}

// Shared classDefs tuned to the app's dark palette.
const FLOW_CLASSDEFS = [
  'classDef tier0 stroke:#e2a336,stroke-width:2.5px',
  'classDef thirdparty stroke-dasharray:6 4,stroke:#9d7bf5',
  'classDef notrep fill:#3a2224,stroke:#e2564f,color:#f2938e',
  'classDef ghost fill:transparent,stroke:#2a3242,stroke-dasharray:3 3,color:#8a94a6',
  'classDef extaws stroke:#4f8ff7,stroke-dasharray:4 3',
  'classDef extthird stroke:#9d7bf5,stroke-dasharray:6 4',
  'classDef extsaas stroke:#3fb27f,stroke-dasharray:4 3',
  'classDef extonprem stroke:#e2a336,stroke-dasharray:4 3',
  'classDef extinternal stroke:#8a94a6,stroke-dasharray:4 3',
];

function classLines(classes) {
  // classes: Map className -> [nodeIds]
  const out = [];
  for (const [name, ids] of classes) if (ids.length) out.push(`class ${ids.join(',')} ${name}`);
  return out;
}

function pushTierAndThirdParty(classes, comp, nid) {
  if (comp.tier === 0) classes.get('tier0').push(nid);
  if ((comp.category || '') === 'third-party') classes.get('thirdparty').push(nid);
}

function newClasses() {
  return new Map([
    ['tier0', []], ['thirdparty', []], ['notrep', []], ['ghost', []],
    ['extaws', []], ['extthird', []], ['extsaas', []], ['extonprem', []], ['extinternal', []],
  ]);
}

const EXT_CLASS = {
  'aws-service': 'extaws', 'third-party': 'extthird', 'saas': 'extsaas',
  'on-prem': 'extonprem', 'internal': 'extinternal',
};

// ---------------------------------------------------------------- generators

export function architecture({ components }) {
  const ids = nodeIds(components);
  const classes = newClasses();
  const lines = ['flowchart LR'];
  const cats = categoriesPresent(components);
  cats.forEach((cat, i) => {
    lines.push(`  subgraph sg${i}["${sanitizeLabel(CATEGORY_LABEL[cat] || cat)}"]`);
    lines.push('    direction TB');
    for (const c of components.filter((x) => (x.category || 'other') === cat)) {
      const nid = ids.get(c.id);
      lines.push(`    ${nid}["${sanitizeLabel(c.name)}"]`);
      pushTierAndThirdParty(classes, c, nid);
    }
    lines.push('  end');
  });
  for (const c of components)
    for (const dep of c.dependsOn || [])
      if (ids.has(dep)) lines.push(`  ${ids.get(c.id)} --> ${ids.get(dep)}`);
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  return {
    id: 'architecture', name: 'Architecture overview', kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      '**How to read it** — components grouped by category; an arrow `A --> B` means *A depends on B*.',
      '',
      '- **Amber border** = tier-0 (business-critical) component.',
      '- **Dashed purple border** = third-party dependency you do not operate.',
    ].join('\n'),
    componentIds: components.map((c) => c.id),
  };
}

export function dependencies({ components }) {
  const ids = nodeIds(components);
  const classes = newClasses();
  const lines = ['flowchart LR'];
  for (const c of components) {
    const nid = ids.get(c.id);
    lines.push(`  ${nid}["${sanitizeLabel(c.name)}"]`);
    pushTierAndThirdParty(classes, c, nid);
  }
  // Synthetic nodes for distinct outbound targets.
  const extIds = new Map(); // target string -> node id
  let x = 0;
  const edges = [];
  for (const c of components) {
    for (const dep of c.dependsOn || [])
      if (ids.has(dep)) edges.push(`  ${ids.get(c.id)} --> ${ids.get(dep)}`);
    for (const oc of c.outboundCalls || []) {
      const key = `${oc.target}|${oc.type}`;
      if (!extIds.has(key)) {
        const xid = `x${x++}`;
        extIds.set(key, xid);
        lines.push(`  ${xid}(["${sanitizeLabel(oc.target)}"])`);
        classes.get(EXT_CLASS[oc.type] || 'extinternal').push(xid);
      }
      const label = sanitizeLabel([oc.protocol, oc.critical ? 'critical' : ''].filter(Boolean).join(' · ') || oc.type);
      edges.push(`  ${ids.get(c.id)} -. "${label}" .-> ${extIds.get(key)}`);
    }
  }
  lines.push(...edges, ...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  return {
    id: 'dependencies', name: 'Dependency graph', kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      '**Legend**',
      '',
      '- Solid arrow `A --> B`: A depends on B (declared `dependsOn`).',
      '- Dotted arrow to a rounded node: an **outbound call** leaving the inventory, labeled with protocol (and `critical` when flagged).',
      '- Rounded node border color = target type: **blue** AWS service, **purple dashed** third-party, **green** SaaS, **amber** on-prem, **grey** internal.',
      '- Amber border = tier-0 component.',
    ].join('\n'),
    componentIds: components.map((c) => c.id),
  };
}

// The component, all transitive upstream deps, direct dependents, outbound calls.
export function componentDependencies({ components }, componentId) {
  const map = byId(components);
  const focus = map.get(componentId);
  if (!focus) return null;
  const keep = new Set([componentId]);
  const walk = (id) => {
    for (const dep of map.get(id)?.dependsOn || [])
      if (map.has(dep) && !keep.has(dep)) { keep.add(dep); walk(dep); }
  };
  walk(componentId);
  const dependents = components.filter((c) => (c.dependsOn || []).includes(componentId)).map((c) => c.id);
  dependents.forEach((d) => keep.add(d));
  const subset = components.filter((c) => keep.has(c.id));
  const ids = nodeIds(subset);
  const classes = newClasses();
  classes.set('focus', []);
  const lines = ['flowchart LR'];
  for (const c of subset) {
    const nid = ids.get(c.id);
    lines.push(`  ${nid}["${sanitizeLabel(c.name)}"]`);
    pushTierAndThirdParty(classes, c, nid);
    if (c.id === componentId) classes.get('focus').push(nid);
  }
  const edges = [];
  for (const c of subset)
    for (const dep of c.dependsOn || [])
      if (keep.has(dep)) edges.push(`  ${ids.get(c.id)} --> ${ids.get(dep)}`);
  let x = 0;
  for (const oc of focus.outboundCalls || []) {
    const xid = `x${x++}`;
    lines.push(`  ${xid}(["${sanitizeLabel(oc.target)}"])`);
    classes.get(EXT_CLASS[oc.type] || 'extinternal').push(xid);
    const label = sanitizeLabel([oc.protocol, oc.critical ? 'critical' : ''].filter(Boolean).join(' · ') || oc.type);
    edges.push(`  ${ids.get(componentId)} -. "${label}" .-> ${xid}`);
  }
  lines.push(...edges, ...FLOW_CLASSDEFS.map((l) => '  ' + l),
    '  classDef focus stroke:#4f8ff7,stroke-width:3px,fill:#1c2a44',
    ...classLines(classes).map((l) => '  ' + l));
  return {
    id: `dependencies-${componentId}`, name: `Dependencies — ${focus.name}`, kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `**${focus.name}** (blue, bold border) with everything it transitively depends on (downstream arrows), the components that depend directly on it, and its outbound calls (dotted).`,
      dependents.length ? `Direct dependents: ${dependents.map((d) => map.get(d)?.name).join(', ')}.` : 'Nothing in the inventory depends on it directly.',
    ].join('\n\n'),
    componentIds: subset.map((c) => c.id),
  };
}

export function restoreLayers({ components }) {
  const classes = newClasses();
  const ids = nodeIds(components);
  const lines = ['flowchart TB'];
  LAYERS.forEach(([layer, label], i) => {
    lines.push(`  subgraph ${layer}["${layer} · ${sanitizeLabel(label)}"]`);
    lines.push('    direction LR');
    const inLayer = components.filter((c) => c.restoreLayer === layer);
    if (!inLayer.length) {
      const gid = `g${i}`;
      lines.push(`    ${gid}["(no components mapped)"]`);
      classes.get('ghost').push(gid);
    }
    for (const c of inLayer) {
      const nid = ids.get(c.id);
      lines.push(`    ${nid}["${sanitizeLabel(c.name)}"]`);
      pushTierAndThirdParty(classes, c, nid);
      if (c.inRecoveryScope === 'no') classes.get('notrep').push(nid);
    }
    lines.push('  end');
  });
  for (let i = 0; i < LAYERS.length - 1; i++)
    lines.push(`  ${LAYERS[i][0]} --> ${LAYERS[i + 1][0]}`);
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  return {
    id: 'restore-layers', name: 'Restore layer cake', kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      'The restore order: each layer must be verifiably up before the next one starts.',
      '',
      '- **L0–L1** happen before/at declaration (guardrails green, recovery launch).',
      '- **L6** is the business success bar (a real transaction end-to-end).',
      '- **L7** is live cutover — game day only, never in routine tests.',
      '- **Red** = component not in recovery scope; **amber border** = tier-0.',
    ].join('\n'),
    componentIds: components.map((c) => c.id),
  };
}

export function failoverSequence({ workspace, components, runbooks }) {
  const tool = toolName(workspace);
  const P = { Op: 'Operator', DR: tool, Plat: 'Platform', Data: 'Data', Apps: 'Apps', Edge: 'Edge', Part: 'Partner' };
  const layerActor = { L0: 'DR', L1: 'DR', L2: 'Plat', L3: 'Data', L4: 'Apps', L5: 'Edge', L6: 'Part', L7: 'Edge' };
  const lines = ['sequenceDiagram', '  autonumber'];
  for (const [id, label] of Object.entries(P)) lines.push(`  participant ${id} as ${seqText(label)}`);

  const rb = (runbooks || []).find((r) => Array.isArray(r.steps) && r.steps.length);
  const notesExtra = [];
  if (rb) {
    notesExtra.push(`Generated from runbook **${rb.name}** (${rb.steps.length} steps).`);
    for (const s of rb.steps) {
      const actor = layerActor[s.layer] || 'Plat';
      const title = truncate(seqText(`${s.layer ? s.layer + ' ' : ''}${s.title}`), 70);
      lines.push(`  Op->>${actor}: ${title}`);
      if (s.verify) lines.push(`  Note over ${actor}: verify — ${truncate(seqText(s.verify), 60)}`);
      if (s.gate) lines.push(`  ${actor}-->>Op: gate passed${s.record ? ' — record ' + truncate(seqText(s.record), 40) : ''}`);
    }
  } else {
    notesExtra.push('No runbook with steps exists yet — this sequence is derived from the restore layers of your components. Author a runbook to make it exact.');
    const inLayer = (l) => components.filter((c) => c.restoreLayer === l && c.inRecoveryScope !== 'no');
    const nameList = (l, n = 3) => {
      const cs = inLayer(l);
      const names = cs.slice(0, n).map((c) => seqText(c.name));
      return names.join(', ') + (cs.length > n ? ` +${cs.length - n} more` : '');
    };
    const verif = (l) => inLayer(l).map((c) => c.verification?.pass).filter(Boolean)[0];
    lines.push('  Op->>DR: Declare DR event — pick aligned recovery point');
    if (inLayer('L0').length) lines.push(`  Note over Op,DR: L0 preflight green — ${truncate(nameList('L0'), 60)}`);
    if (inLayer('L1').length) lines.push(`  DR->>DR: L1 launch recovery — ${truncate(nameList('L1'), 60)}`);
    const steps = [
      ['L2', 'DR', 'Plat', 'L2 bring up platform'],
      ['L3', 'DR', 'Data', 'L3 restore data and secrets'],
      ['L4', 'Plat', 'Apps', 'L4 start applications'],
      ['L5', 'Apps', 'Edge', 'L5 open edge reachability'],
    ];
    for (const [l, from, to, verb] of steps) {
      const cs = inLayer(l);
      if (!cs.length) continue;
      lines.push(`  ${from}->>${to}: ${verb} — ${truncate(nameList(l), 55)}`);
      const v = verif(l);
      if (v) lines.push(`  Note over ${to}: verify — ${truncate(seqText(v), 60)}`);
    }
    if (inLayer('L6').length) {
      lines.push(`  Edge->>Part: L6 success bar — ${truncate(nameList('L6'), 55)}`);
      const v = verif('L6');
      lines.push(`  Part-->>Op: ${truncate(seqText(v || 'business transaction completes end-to-end'), 65)}`);
    }
    const l7 = components.filter((c) => c.restoreLayer === 'L7');
    if (l7.length) {
      lines.push(`  Op->>Edge: L7 live cutover (game day only) — ${truncate(l7.map((c) => seqText(c.name)).join(', '), 50)}`);
      lines.push('  Note over Edge,Part: partner allowlists and DNS TTLs decide how fast this lands');
    }
    lines.push('  Op->>Op: record T0 / first-access / T1 timestamps for RTA-RPA');
  }
  return {
    id: 'failover-sequence', name: 'Failover sequence', kind: 'sequence',
    mermaid: lines.join('\n'),
    notes: [
      `The failover story, layer by layer, with **${tool}** as the recovery tool. Participants are the layer buckets (platform, data, apps, edge, partner) rather than individual components.`,
      ...notesExtra,
    ].join('\n\n'),
    componentIds: components.map((c) => c.id),
  };
}

export function regionPair({ workspace, components }) {
  const primary = workspace?.regions?.primary || 'primary';
  const recovery = workspace?.regions?.recovery || 'recovery';
  const key = components.filter((c) =>
    c.tier === 0 || DATA_CATEGORIES.includes(c.category || ''));
  const shown = key.filter((c) => (c.category || '') !== 'third-party');
  const classes = newClasses();
  const lines = ['flowchart LR'];
  const pid = new Map(), rid = new Map();
  shown.forEach((c, i) => { pid.set(c.id, `p${i}`); rid.set(c.id, `r${i}`); });

  lines.push(`  subgraph P["${sanitizeLabel(primary)} · primary"]`);
  lines.push('    direction TB');
  for (const c of shown) {
    lines.push(`    ${pid.get(c.id)}["${sanitizeLabel(c.name)}"]`);
    if (c.tier === 0) classes.get('tier0').push(pid.get(c.id));
  }
  lines.push('  end');
  lines.push(`  subgraph R["${sanitizeLabel(recovery)} · recovery"]`);
  lines.push('    direction TB');
  for (const c of shown) {
    const nid = rid.get(c.id);
    lines.push(`    ${nid}["${sanitizeLabel(c.name)}"]`);
    if (c.inRecoveryScope === 'no') classes.get('notrep').push(nid);
    else if (c.tier === 0) classes.get('tier0').push(nid);
  }
  lines.push('  end');

  const edges = [];
  const redEdges = [];
  for (const c of shown) {
    if (!DATA_CATEGORIES.includes(c.category || '')) continue;
    if (c.inRecoveryScope === 'no' || !c.replication?.mechanism || ['none', 'n/a', 'n/a-global', 'unknown'].includes(c.replication.mechanism)) {
      redEdges.push(edges.length);
      edges.push(`  ${pid.get(c.id)} -. "NOT REPLICATED" .-> ${rid.get(c.id)}`);
    } else {
      const label = sanitizeLabel(replLabelParts(c).join(' · '));
      edges.push(`  ${pid.get(c.id)} -->|"${label}"| ${rid.get(c.id)}`);
    }
  }
  // DNS / edge flip.
  const dnsComp = components.find((c) => (c.category || '') === 'edge-dns' && c.restoreLayer === 'L7')
    || components.find((c) => (c.category || '') === 'edge-dns');
  lines.push(`  dns(("${sanitizeLabel(dnsComp ? dnsComp.name : 'DNS / edge flip')}"))`);
  const pEntry = shown.find((c) => (c.category || '') === 'edge-dns' && c.id !== dnsComp?.id);
  const pTarget = pEntry ? pid.get(pEntry.id) : 'P';
  const rTarget = pEntry ? rid.get(pEntry.id) : 'R';
  edges.push(`  dns -->|"steady state"| ${pTarget}`);
  redEdges.push(edges.length);
  edges.push(`  dns -. "flip on failover" .-> ${rTarget}`);
  lines.push(...edges, ...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  for (const i of redEdges) lines.push(`  linkStyle ${i} stroke:#e2564f,color:#e2564f`);
  return {
    id: 'region-pair', name: `Region pair — ${primary} → ${recovery}`, kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `Tier-0 components and data stores mirrored across **${primary}** (primary) and **${recovery}** (recovery). Data-store arrows carry the replication mechanism and RPO; red means no replication path exists today.`,
      'The circle is the public entry — DNS/edge flips from primary to recovery at L7 (live cutover).',
    ].join('\n\n'),
    componentIds: shown.map((c) => c.id).concat(dnsComp && !pid.has(dnsComp.id) ? [dnsComp.id] : []),
  };
}

export function dataReplication({ workspace, components }) {
  const primary = workspace?.regions?.primary || 'primary';
  const recovery = workspace?.regions?.recovery || 'recovery';
  const stores = components.filter((c) => DATA_CATEGORIES.includes(c.category || ''));
  const classes = newClasses();
  const lines = ['flowchart LR'];
  lines.push(`  subgraph P["${sanitizeLabel(primary)} · primary"]`);
  lines.push('    direction TB');
  stores.forEach((c, i) => {
    lines.push(`    p${i}["${sanitizeLabel(c.name)}"]`);
    if (c.inRecoveryScope === 'no') classes.get('notrep').push(`p${i}`);
    else if (c.tier === 0) classes.get('tier0').push(`p${i}`);
  });
  lines.push('  end');
  lines.push(`  subgraph R["${sanitizeLabel(recovery)} · recovery"]`);
  lines.push('    direction TB');
  stores.forEach((c, i) => {
    if (c.inRecoveryScope === 'no') {
      lines.push(`    r${i}["${sanitizeLabel(c.name)} — NOT REPLICATED"]`);
      classes.get('notrep').push(`r${i}`);
    } else {
      lines.push(`    r${i}["${sanitizeLabel(c.name)}"]`);
      if (c.tier === 0) classes.get('tier0').push(`r${i}`);
    }
  });
  lines.push('  end');
  const edges = [];
  const redEdges = [];
  stores.forEach((c, i) => {
    if (c.inRecoveryScope === 'no') {
      redEdges.push(edges.length);
      edges.push(`  p${i} -. "NOT REPLICATED" .-> r${i}`);
    } else {
      const mech = c.replication?.mechanism || 'unknown';
      const label = sanitizeLabel(replLabelParts(c).concat(c.inRecoveryScope === 'partial' ? ['partial scope'] : []).join(' · '));
      if (['none', 'unknown'].includes(mech)) {
        redEdges.push(edges.length);
        edges.push(`  p${i} -. "${label}" .-> r${i}`);
      } else {
        edges.push(`  p${i} -->|"${label}"| r${i}`);
      }
    }
  });
  lines.push(...edges, ...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  for (const i of redEdges) lines.push(`  linkStyle ${i} stroke:#e2564f,color:#e2564f`);
  const worst = stores.filter((c) => c.inRecoveryScope !== 'no' && c.replication?.rpoMinutes)
    .reduce((m, c) => Math.max(m, c.replication.rpoMinutes), 0);
  return {
    id: 'data-replication', name: 'Data replication map', kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `Every database, storage, and messaging/streaming component, ${primary} → ${recovery}. Edge labels show the replication mechanism and configured RPO; **red** stores have no replication path and will come back empty (or not at all).`,
      worst ? `Worst configured RPO across replicated stores: **${worst} minutes** — your realized RPA can only be worse than this.` : '',
      stores.some((c) => c.replication?.mechanism === 'rebuild') ? 'Stores marked *rebuilt cold on failover* are caches — they carry no data across and simply refill.' : '',
    ].filter(Boolean).join('\n\n'),
    componentIds: stores.map((c) => c.id),
  };
}

// ---------------------------------------------------------------- canvas data
// Structured node/edge/group JSON for the icon-canvas engine (client-side
// rendering — no mermaid involved). Labels are plain text.

const CANVAS_UNSUPPORTED = new Set(['failover-sequence']);

export function canvasSupported(id) {
  if (CANVAS_UNSUPPORTED.has(id)) return false;
  return id === 'architecture' || id === 'dependencies' || id === 'restore-layers'
    || id === 'region-pair' || id === 'data-replication' || id.startsWith('dependencies-');
}

function slugify(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'target';
}

function canvasNode(c) {
  const isData = DATA_CATEGORIES.includes(c.category || '');
  return {
    id: c.id,
    label: c.name,
    sub: isData ? replLabelParts(c).join(' · ') : (c.kind || ''),
    kind: c.kind || '',
    category: c.category || 'other',
    awsServices: c.awsServices || [],
    tier: typeof c.tier === 'number' ? c.tier : null,
    layer: c.restoreLayer || '',
  };
}

function extNode(target, type) {
  return {
    id: `ext_${slugify(target)}`,
    label: target,
    sub: type || 'external',
    kind: 'external',
    category: 'third-party',
    awsServices: [],
    tier: null,
    layer: '',
  };
}

function categoryGroups(comps) {
  return categoriesPresent(comps).map((cat) => ({
    id: `cat_${cat}`,
    label: CATEGORY_LABEL[cat] || cat,
    nodeIds: comps.filter((c) => (c.category || 'other') === cat).map((c) => c.id),
  }));
}

function depEdges(comps) {
  const have = new Set(comps.map((c) => c.id));
  const edges = [];
  for (const c of comps)
    for (const dep of c.dependsOn || [])
      if (have.has(dep)) edges.push({ from: c.id, to: dep, kind: 'dependency' });
  return edges;
}

function outboundParts(comps) {
  // Distinct synthetic external nodes + outbound edges for a component set.
  const nodes = new Map(); // node id -> node
  const edges = [];
  for (const c of comps) {
    for (const oc of c.outboundCalls || []) {
      const n = extNode(oc.target, oc.type);
      if (!nodes.has(n.id)) nodes.set(n.id, n);
      edges.push({ from: c.id, to: n.id, kind: 'outbound', label: oc.type || 'external' });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

// A grey-side mirror placeholder for region-pair / data-replication views.
function recTwin(c) {
  return { ...canvasNode(c), id: `rec_${c.id}`, sub: c.kind || 'recovery copy' };
}

const notReplicated = (c) =>
  c.inRecoveryScope === 'no' || !c.replication?.mechanism
  || ['none', 'n/a', 'n/a-global', 'unknown'].includes(c.replication.mechanism);

export function buildCanvasData(diagramId, { workspace, components }) {
  if (!canvasSupported(diagramId)) return null;
  const comps = components || [];
  const meta = (name) => ({ diagramId, name, regions: workspace?.regions || {} });

  if (diagramId === 'architecture') {
    return {
      nodes: comps.map(canvasNode),
      edges: depEdges(comps),
      groups: categoryGroups(comps),
      meta: meta('Architecture overview'),
    };
  }

  if (diagramId === 'dependencies') {
    const ext = outboundParts(comps);
    return {
      nodes: comps.map(canvasNode).concat(ext.nodes),
      edges: depEdges(comps).concat(ext.edges),
      groups: categoryGroups(comps),
      meta: meta('Dependency graph'),
    };
  }

  if (diagramId.startsWith('dependencies-')) {
    const componentId = diagramId.slice('dependencies-'.length);
    const map = byId(comps);
    const focus = map.get(componentId);
    if (!focus) return null;
    const keep = new Set([componentId]);
    const walk = (id) => {
      for (const dep of map.get(id)?.dependsOn || [])
        if (map.has(dep) && !keep.has(dep)) { keep.add(dep); walk(dep); }
    };
    walk(componentId);
    for (const c of comps) if ((c.dependsOn || []).includes(componentId)) keep.add(c.id);
    const subset = comps.filter((c) => keep.has(c.id));
    const ext = outboundParts([focus]);
    return {
      nodes: subset.map(canvasNode).concat(ext.nodes),
      edges: depEdges(subset).concat(ext.edges),
      groups: categoryGroups(subset),
      meta: meta(`Dependencies — ${focus.name}`),
    };
  }

  if (diagramId === 'restore-layers') {
    return {
      nodes: comps.map(canvasNode),
      edges: depEdges(comps),
      groups: LAYERS.map(([layer, label]) => ({
        id: layer,
        label: `${layer} · ${label}`,
        nodeIds: comps.filter((c) => c.restoreLayer === layer).map((c) => c.id),
      })),
      meta: meta('Restore layer cake'),
    };
  }

  if (diagramId === 'region-pair') {
    const primary = workspace?.regions?.primary || 'primary';
    const recovery = workspace?.regions?.recovery || 'recovery';
    const mirrored = comps.filter((c) => ['yes', 'partial'].includes(c.inRecoveryScope));
    const nodes = comps.map(canvasNode).concat(mirrored.map(recTwin));
    const edges = mirrored.map((c) => ({
      from: c.id, to: `rec_${c.id}`, kind: 'outbound',
      label: c.replication?.mechanism || 'replication',
    }));
    return {
      nodes, edges,
      groups: [
        { id: 'grp_primary', label: `primary ${primary}`, nodeIds: comps.map((c) => c.id) },
        { id: 'grp_recovery', label: `recovery ${recovery}`, nodeIds: mirrored.map((c) => `rec_${c.id}`) },
      ],
      meta: meta(`Region pair — ${primary} → ${recovery}`),
    };
  }

  if (diagramId === 'data-replication') {
    const primary = workspace?.regions?.primary || 'primary';
    const recovery = workspace?.regions?.recovery || 'recovery';
    const stores = comps.filter((c) => DATA_CATEGORIES.includes(c.category || ''));
    const nodes = [];
    const edges = [];
    const recIds = [];
    for (const c of stores) {
      if (notReplicated(c)) {
        nodes.push({ ...canvasNode(c), sub: '⚠ not replicated' });
      } else {
        nodes.push(canvasNode(c));
        nodes.push(recTwin(c));
        recIds.push(`rec_${c.id}`);
        edges.push({
          from: c.id, to: `rec_${c.id}`, kind: 'outbound',
          label: replLabelParts(c).join(' · '),
        });
      }
    }
    return {
      nodes, edges,
      groups: [
        { id: 'grp_primary', label: `primary ${primary}`, nodeIds: stores.map((c) => c.id) },
        { id: 'grp_recovery', label: `recovery ${recovery}`, nodeIds: recIds },
      ],
      meta: meta('Data replication map'),
    };
  }

  return null;
}

// ---------------------------------------------------------------- kubernetes
// Diagrams generated from a captured cluster snapshot (stored as the 'k8s'
// workspace object by the discovery agent). Everything here is defensive:
// the snapshot may be missing, empty, or partially filled.

function arr(v) { return Array.isArray(v) ? v : []; }

export function hasK8sSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return false;
  return !!(snap.capturedAt || arr(snap.workloads).length || arr(snap.namespaces).length);
}

export function isK8sDiagramId(id) {
  return id === 'k8s-cluster' || String(id).startsWith('k8s-namespace-');
}

// Workload Kind -> icon-manifest kind key (map.kinds in the icon manifest).
const K8S_WORKLOAD_ICON = {
  'Deployment': 'k8s-deployment',
  'StatefulSet': 'k8s-statefulset',
  'DaemonSet': 'k8s-daemonset',
  'CronJob': 'k8s-cronjob',
  'Job': 'k8s-cronjob',
};

const svcId = (s) => `svc:${s.namespace}/${s.name}`;
const ingId = (i) => `ing:${i.namespace}/${i.name}`;
const cmId = (ns, name) => `cm:${ns}/${name}`;
const secId = (ns, name) => `sec:${ns}/${name}`;
const pvcId = (p) => `pvc:${p.namespace}/${p.name}`;
const hpaId = (hp) => `hpa:${hp.namespace}/${hp.name}`;

function workloadSub(w, { linked = true } = {}) {
  const parts = [];
  const d = w.replicas?.desired, rdy = w.replicas?.ready;
  if (d !== undefined && d !== null) parts.push(`${rdy ?? 0}/${d} ready`);
  else if (w.kind) parts.push(w.kind);
  if (linked && w.componentId) parts.push('linked');
  return parts.join(' · ');
}

function k8sWorkloadNode(w, category) {
  return {
    id: w.uid, label: w.name, sub: workloadSub(w),
    kind: K8S_WORKLOAD_ICON[w.kind] || 'k8s-deployment',
    category, namespace: w.namespace, k8sKind: w.kind,
    componentId: w.componentId || null,
    awsServices: [], tier: null, layer: '',
  };
}

function k8sServiceNode(s, category) {
  return {
    id: svcId(s), label: s.name, sub: s.type || 'ClusterIP',
    kind: 'k8s-service', category, namespace: s.namespace, k8sKind: 'Service',
    awsServices: [], tier: null, layer: '',
  };
}

function k8sIngressNode(i, category) {
  const hosts = arr(i.hosts).join(', ');
  return {
    id: ingId(i), label: i.name, sub: truncate(hosts || i.class || 'ingress', 34),
    kind: 'k8s-ingress', category, namespace: i.namespace, k8sKind: 'Ingress',
    awsServices: [], tier: null, layer: '',
  };
}

function k8sNodesSummary(snap) {
  const n = snap.nodes || {};
  const types = arr(n.instanceTypes).slice(0, 3).join(', ');
  const sub = [
    n.count ? `${n.readyCount ?? '?'}/${n.count} nodes ready` : 'nodes',
    types,
  ].filter(Boolean).join(' · ');
  return {
    id: 'k8s:nodes', label: snap.clusterName || 'cluster nodes', sub: truncate(sub, 40),
    kind: 'k8s-node', category: 'cluster', k8sKind: 'Node',
    awsServices: [], tier: null, layer: '',
  };
}

// Edges shared by both k8s canvas views (only between ids present in `have`).
function k8sRoutingEdges(snap, have) {
  const edges = [];
  for (const i of arr(snap.ingresses)) {
    const iid = ingId(i);
    if (!have.has(iid)) continue;
    for (const b of arr(i.backends)) {
      const sid = `svc:${i.namespace}/${b.service}`;
      if (!have.has(sid)) continue;
      edges.push({ from: iid, to: sid, kind: 'outbound', label: truncate(arr(i.hosts)[0] || 'routes-to', 28) });
    }
  }
  for (const s of arr(snap.services)) {
    const sid = svcId(s);
    if (!have.has(sid)) continue;
    for (const uid of arr(s.targets)) {
      if (have.has(uid)) edges.push({ from: sid, to: uid, kind: 'dependency' });
    }
  }
  return edges;
}

// ---- canvas builders ----

export function buildK8sClusterCanvas({ workspace, k8sSnapshot: snap }) {
  const nsNames = [...new Set([
    ...arr(snap.namespaces).map((n) => n.name),
    ...arr(snap.workloads).map((w) => w.namespace),
    ...arr(snap.services).map((s) => s.namespace),
    ...arr(snap.ingresses).map((i) => i.namespace),
  ].filter(Boolean))];

  const nodes = [k8sNodesSummary(snap)];
  const groups = [{ id: 'grp_cluster', label: `cluster${snap.clusterName ? ' · ' + snap.clusterName : ''}`, nodeIds: ['k8s:nodes'] }];

  for (const ns of nsNames) {
    const ids = [];
    for (const w of arr(snap.workloads).filter((w) => w.namespace === ns && w.uid)) {
      nodes.push(k8sWorkloadNode(w, ns)); ids.push(w.uid);
    }
    for (const s of arr(snap.services).filter((s) => s.namespace === ns && s.name)) {
      nodes.push(k8sServiceNode(s, ns)); ids.push(svcId(s));
    }
    for (const i of arr(snap.ingresses).filter((i) => i.namespace === ns && i.name)) {
      nodes.push(k8sIngressNode(i, ns)); ids.push(ingId(i));
    }
    if (ids.length) groups.push({ id: `ns_${ns}`, label: `ns · ${ns}`, nodeIds: ids });
  }

  const have = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: k8sRoutingEdges(snap, have),
    groups,
    meta: { diagramId: 'k8s-cluster', name: 'Kubernetes cluster', regions: workspace?.regions || {} },
  };
}

export function buildK8sNamespaceCanvas({ workspace, k8sSnapshot: snap }, ns) {
  const workloads = arr(snap.workloads).filter((w) => w.namespace === ns && w.uid);
  const services = arr(snap.services).filter((s) => s.namespace === ns && s.name);
  const ingresses = arr(snap.ingresses).filter((i) => i.namespace === ns && i.name);
  const pvcs = arr(snap.pvcs).filter((p) => p.namespace === ns && p.name);
  const hpas = arr(snap.hpas).filter((hp) => hp.namespace === ns && hp.name);
  if (!workloads.length && !services.length && !ingresses.length) return null;

  const nodes = [];
  const groups = [];
  const addGroup = (id, label, ids) => { if (ids.length) groups.push({ id, label, nodeIds: ids }); };

  const ingIds = ingresses.map((i) => { nodes.push(k8sIngressNode(i, 'edge-dns')); return ingId(i); });
  const svcIds = services.map((s) => { nodes.push(k8sServiceNode(s, 'networking')); return svcId(s); });
  const wIds = workloads.map((w) => { nodes.push(k8sWorkloadNode(w, 'compute')); return w.uid; });

  // config + secrets referenced by this namespace's workloads
  const cms = new Map(), secs = new Map();
  for (const w of workloads) {
    for (const name of arr(w.configmaps)) if (!cms.has(name)) cms.set(name, cmId(ns, name));
    for (const name of arr(w.secrets)) if (!secs.has(name)) secs.set(name, secId(ns, name));
  }
  for (const [name, id] of cms) nodes.push({ id, label: name, sub: 'ConfigMap', kind: 'k8s-configmap', category: 'other', namespace: ns, k8sKind: 'ConfigMap', awsServices: [], tier: null, layer: '' });
  for (const [name, id] of secs) nodes.push({ id, label: name, sub: 'Secret', kind: 'k8s-secret', category: 'security-secrets', namespace: ns, k8sKind: 'Secret', awsServices: [], tier: null, layer: '' });

  const pvcIds = pvcs.map((p) => {
    nodes.push({ id: pvcId(p), label: p.name, sub: [p.size, p.storageClass].filter(Boolean).join(' · ') || 'PVC', kind: 'k8s-pvc', category: 'storage', namespace: ns, k8sKind: 'PersistentVolumeClaim', awsServices: [], tier: null, layer: '' });
    return pvcId(p);
  });
  const hpaIds = hpas.map((hp) => {
    nodes.push({ id: hpaId(hp), label: hp.name, sub: `${hp.min ?? '?'}–${hp.max ?? '?'} replicas`, kind: 'k8s-hpa', category: 'observability', namespace: ns, k8sKind: 'HorizontalPodAutoscaler', awsServices: [], tier: null, layer: '' });
    return hpaId(hp);
  });

  addGroup('grp_ing', 'Ingress', ingIds);
  addGroup('grp_svc', 'Services', svcIds);
  addGroup('grp_wl', 'Workloads', wIds);
  addGroup('grp_cfg', 'Config & secrets', [...cms.values(), ...secs.values()]);
  addGroup('grp_pvc', 'Storage', pvcIds);
  addGroup('grp_hpa', 'Autoscaling', hpaIds);

  const have = new Set(nodes.map((n) => n.id));
  const edges = k8sRoutingEdges(snap, have);
  const matchWorkload = (target) => workloads.find((w) =>
    w.name === target || w.uid === target || String(w.uid).endsWith(`/${target}`));
  for (const w of workloads) {
    for (const name of arr(w.configmaps)) if (have.has(cmId(ns, name))) edges.push({ from: w.uid, to: cmId(ns, name), kind: 'outbound', label: 'uses' });
    for (const name of arr(w.secrets)) if (have.has(secId(ns, name))) edges.push({ from: w.uid, to: secId(ns, name), kind: 'outbound', label: 'mounts' });
  }
  for (const p of pvcs) {
    const w = p.boundTo ? matchWorkload(p.boundTo) : null;
    if (w) edges.push({ from: w.uid, to: pvcId(p), kind: 'outbound', label: 'mounts' });
  }
  for (const hp of hpas) {
    const w = hp.target ? matchWorkload(hp.target) : null;
    if (w) edges.push({ from: hpaId(hp), to: w.uid, kind: 'outbound', label: 'scales' });
  }

  return {
    nodes, edges, groups,
    meta: { diagramId: `k8s-namespace-${ns}`, name: `Namespace — ${ns}`, regions: workspace?.regions || {} },
  };
}

export function buildK8sCanvasData(diagramId, data) {
  const snap = data?.k8sSnapshot;
  if (!hasK8sSnapshot(snap)) return null;
  if (diagramId === 'k8s-cluster') return buildK8sClusterCanvas(data);
  if (diagramId.startsWith('k8s-namespace-')) return buildK8sNamespaceCanvas(data, diagramId.slice('k8s-namespace-'.length));
  return null;
}

// ---- mermaid builders ----

const K8S_CLASSDEFS = [
  'classDef k8swl stroke:#4f8ff7',
  'classDef k8ssvc stroke:#3fb27f',
  'classDef k8sing stroke:#e2a336',
  'classDef k8scfg stroke:#8a94a6,stroke-dasharray:4 3',
  'classDef k8slinked stroke:#4f8ff7,stroke-width:2.5px',
];

export function k8sCluster({ k8sSnapshot: snap }) {
  const lines = ['flowchart LR'];
  const classes = new Map([['k8swl', []], ['k8ssvc', []], ['k8sing', []], ['k8slinked', []]]);
  const mid = new Map(); // canvas id -> mermaid id
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `k${seq++}`); return mid.get(id); };

  const n = snap.nodes || {};
  lines.push(`  subgraph CL["cluster${snap.clusterName ? ' · ' + sanitizeLabel(snap.clusterName) : ''}"]`);
  lines.push(`    ${nid('k8s:nodes')}["${sanitizeLabel(`${n.readyCount ?? '?'}/${n.count ?? '?'} nodes ready`)}"]`);
  lines.push('  end');

  const nsNames = [...new Set([
    ...arr(snap.namespaces).map((x) => x.name),
    ...arr(snap.workloads).map((w) => w.namespace),
    ...arr(snap.services).map((s) => s.namespace),
    ...arr(snap.ingresses).map((i) => i.namespace),
  ].filter(Boolean))];

  nsNames.forEach((ns, i) => {
    lines.push(`  subgraph NS${i}["ns · ${sanitizeLabel(ns)}"]`);
    lines.push('    direction TB');
    for (const w of arr(snap.workloads).filter((w) => w.namespace === ns && w.uid)) {
      const m = nid(w.uid);
      lines.push(`    ${m}["${sanitizeLabel(`${w.name} · ${workloadSub(w, { linked: false }) || w.kind}`)}"]`);
      classes.get(w.componentId ? 'k8slinked' : 'k8swl').push(m);
    }
    for (const s of arr(snap.services).filter((s) => s.namespace === ns && s.name)) {
      const m = nid(svcId(s));
      lines.push(`    ${m}(["${sanitizeLabel(`${s.name} · ${s.type || 'ClusterIP'}`)}"])`);
      classes.get('k8ssvc').push(m);
    }
    for (const i2 of arr(snap.ingresses).filter((x) => x.namespace === ns && x.name)) {
      const m = nid(ingId(i2));
      lines.push(`    ${m}{{"${sanitizeLabel(i2.name)}"}}`);
      classes.get('k8sing').push(m);
    }
    lines.push('  end');
  });

  const edges = k8sRoutingEdges(snap, new Set(mid.keys()));
  for (const e of edges) {
    if (e.kind === 'outbound') lines.push(`  ${nid(e.from)} -. "${sanitizeLabel(e.label || 'routes-to')}" .-> ${nid(e.to)}`);
    else lines.push(`  ${nid(e.from)} --> ${nid(e.to)}`);
  }
  lines.push(...K8S_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));

  const linked = arr(snap.workloads).map((w) => w.componentId).filter(Boolean);
  return {
    id: 'k8s-cluster', name: 'Kubernetes cluster', kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `Live snapshot of **${snap.clusterName || 'the cluster'}**${snap.capturedAt ? ` captured ${snap.capturedAt}` : ''}${snap.context ? ` (context \`${snap.context}\`)` : ''}.`,
      '',
      '- Rectangles = workloads (bold blue border = linked to an inventory component).',
      '- Rounded = Services, hexagon = Ingress; dotted arrows = ingress routing, solid = service → workload selection.',
      '- Pick a namespace diagram for configmaps, secrets, PVCs, and autoscalers.',
    ].join('\n'),
    componentIds: [...new Set(linked)],
  };
}

export function k8sNamespace(data, ns) {
  const snap = data.k8sSnapshot;
  const canvas = buildK8sNamespaceCanvas(data, ns);
  if (!canvas) return null;
  const lines = ['flowchart LR'];
  const classes = new Map([['k8swl', []], ['k8ssvc', []], ['k8sing', []], ['k8scfg', []], ['k8slinked', []]]);
  const mid = new Map();
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `k${seq++}`); return mid.get(id); };
  const CLASS_BY_KIND = {
    'k8s-service': 'k8ssvc', 'k8s-ingress': 'k8sing',
    'k8s-configmap': 'k8scfg', 'k8s-secret': 'k8scfg', 'k8s-pvc': 'k8scfg', 'k8s-hpa': 'k8scfg',
  };
  for (const g of canvas.groups) {
    lines.push(`  subgraph ${g.id}["${sanitizeLabel(g.label)}"]`);
    lines.push('    direction TB');
    for (const id of g.nodeIds) {
      const node = canvas.nodes.find((x) => x.id === id);
      if (!node) continue;
      const m = nid(id);
      const label = sanitizeLabel(node.sub ? `${node.label} · ${node.sub}` : node.label);
      if (node.kind === 'k8s-service') lines.push(`    ${m}(["${label}"])`);
      else if (node.kind === 'k8s-ingress') lines.push(`    ${m}{{"${label}"}}`);
      else lines.push(`    ${m}["${label}"]`);
      const cls = node.componentId ? 'k8slinked' : (CLASS_BY_KIND[node.kind] || 'k8swl');
      classes.get(cls).push(m);
    }
    lines.push('  end');
  }
  for (const e of canvas.edges) {
    if (e.kind === 'outbound') lines.push(`  ${nid(e.from)} -. "${sanitizeLabel(e.label || '')}" .-> ${nid(e.to)}`);
    else lines.push(`  ${nid(e.from)} --> ${nid(e.to)}`);
  }
  lines.push(...K8S_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const linked = arr(snap.workloads).filter((w) => w.namespace === ns).map((w) => w.componentId).filter(Boolean);
  return {
    id: `k8s-namespace-${ns}`, name: `Namespace — ${ns}`, kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `Everything captured in namespace **${ns}**: workloads, Services, Ingress, plus the ConfigMaps/Secrets they use, PVC mounts, and HPA scaling targets.`,
      'Edge labels: *uses* (configmap), *mounts* (secret/PVC), *scales* (HPA). Bold blue border = workload linked to an inventory component.',
    ].join('\n\n'),
    componentIds: [...new Set(linked)],
  };
}

export function listK8sDiagrams(snap) {
  if (!hasK8sSnapshot(snap)) return [];
  const workloads = arr(snap.workloads);
  const nsNames = [...new Set([
    ...arr(snap.namespaces).map((n) => n.name),
    ...workloads.map((w) => w.namespace),
  ].filter(Boolean))];
  const out = [{
    id: 'k8s-cluster',
    name: `Kubernetes cluster${snap.clusterName ? ' — ' + snap.clusterName : ''}`,
    kind: 'k8s', section: 'k8s', canvas: true,
    description: `${workloads.length} workloads across ${nsNames.length} namespace${nsNames.length === 1 ? '' : 's'}`,
  }];
  for (const ns of nsNames) {
    const inNs = workloads.filter((w) => w.namespace === ns).length;
    out.push({
      id: `k8s-namespace-${ns}`, name: `Namespace — ${ns}`,
      kind: 'k8s', section: 'k8s', canvas: true,
      description: `${inNs} workload${inNs === 1 ? '' : 's'} · configmaps, secrets, PVCs, HPAs`,
    });
  }
  return out;
}

export function generateK8s(id, data) {
  if (!hasK8sSnapshot(data?.k8sSnapshot)) return null;
  if (id === 'k8s-cluster') return k8sCluster(data);
  if (id.startsWith('k8s-namespace-')) return k8sNamespace(data, id.slice('k8s-namespace-'.length));
  return null;
}

// ---------------------------------------------------------------- resource map
// Diagrams generated from the deep-enrichment resource graph (workspace
// object 'resource-graph', shape { updatedAt, nodes:{rid:node}, edges:[...] };
// see server/lib/aws-enrich.js). Everything here is additive and defensive:
// the graph may be missing, empty, or reference components that were deleted.

export function hasResourceGraph(graph) {
  return !!(graph && graph.nodes && typeof graph.nodes === 'object'
    && Object.keys(graph.nodes).length);
}

export function isResourceMapId(id) {
  return id === 'resource-map' || String(id).startsWith('resource-map-');
}

// Above this many graph nodes the full map degrades to components + counts so
// the canvas stays usable.
export const RESOURCE_MAP_CAP = 220;

function normGraph(graph) {
  return {
    nodes: graph && graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : {},
    edges: graph && Array.isArray(graph.edges) ? graph.edges : [],
  };
}

// Per-component linked-resource counts (via node.componentIds).
function resourceCounts(g) {
  const counts = {};
  for (const n of Object.values(g.nodes)) {
    for (const cid of n.componentIds || []) counts[cid] = (counts[cid] || 0) + 1;
  }
  return counts;
}

// Components that appear in the graph at all (componentIds or edge endpoints).
function touchedComponentIds(g) {
  const touched = new Set(Object.keys(resourceCounts(g)));
  for (const e of g.edges) {
    for (const v of [e && e.from, e && e.to]) {
      if (typeof v === 'string' && v.startsWith('cmp_')) touched.add(v);
    }
  }
  return touched;
}

// A graph node as a compact canvas pill. The pseudo-category ('~res <label>')
// only steers the category-grid auto-layout so each cluster gets its own
// column band; awsServices lets 'other'-typed primary nodes (S3 bucket, SQS
// queue, EKS control plane…) resolve a real service icon.
function smallResourceNode(rid, n, clusterLabel) {
  return {
    id: rid,
    label: n.name || rid,
    sub: n.type || 'resource',
    small: true,
    rtype: n.type || 'other',
    category: `~res ${clusterLabel}`,
    awsServices: n.service ? [n.service] : [],
    componentIds: n.componentIds || [],
    service: n.service || '',
  };
}

const graphEdgeToCanvas = (e) => ({
  from: e.from, to: e.to, kind: 'dependency', label: e.relation || '',
});

// Full map: component nodes (normal, grouped by category) + every graph node
// as a small pill clustered per owning component (first componentId that still
// exists; edges connect the rest), unlinked nodes in an 'Unlinked' group.
export function buildResourceMapCanvas({ workspace, components, resourceGraph }) {
  const comps = components || [];
  const g = normGraph(resourceGraph);
  const rids = Object.keys(g.nodes);
  const compMap = byId(comps);
  const meta = { diagramId: 'resource-map', name: 'Resource map', regions: workspace?.regions || {} };

  if (rids.length > RESOURCE_MAP_CAP) {
    const counts = resourceCounts(g);
    const nodes = comps.map((c) => {
      const n = canvasNode(c);
      const k = counts[c.id] || 0;
      return { ...n, sub: k ? `${k} linked resource${k === 1 ? '' : 's'}` : n.sub };
    });
    return {
      nodes,
      edges: depEdges(comps),
      groups: categoryGroups(comps),
      meta: {
        ...meta,
        truncated: true,
        note: `Resource graph has ${rids.length} nodes (cap ${RESOURCE_MAP_CAP}) — showing components with per-component counts. Open a per-component resource map for detail.`,
      },
    };
  }

  const nodes = comps.map(canvasNode);
  const clusters = new Map(); // owner cid | '~unlinked' -> group
  for (const rid of rids) {
    const n = g.nodes[rid];
    const owner = (n.componentIds || []).find((cid) => compMap.has(cid)) || null;
    const key = owner || '~unlinked';
    const label = owner ? compMap.get(owner).name : 'Unlinked';
    nodes.push(smallResourceNode(rid, n, label));
    if (!clusters.has(key)) {
      clusters.set(key, { id: owner ? `res_${owner}` : 'res_unlinked', label, nodeIds: [] });
    }
    clusters.get(key).nodeIds.push(rid);
  }
  const present = new Set(nodes.map((x) => String(x.id)));
  const edges = depEdges(comps).concat(
    g.edges
      .filter((e) => e && present.has(String(e.from)) && present.has(String(e.to)))
      .map(graphEdgeToCanvas));
  return {
    nodes,
    edges,
    groups: categoryGroups(comps).concat([...clusters.values()]),
    meta,
  };
}

// Per-component map: the component + its 2-hop subgraph (same walk the
// resources route uses: undirected 2-hop reach plus attribute-like leaves —
// AZ / certificate / KMS key — riding along one extra hop). Small nodes are
// grouped by AWS service.
export function buildComponentResourceMapCanvas({ workspace, components, resourceGraph }, componentId) {
  const comps = components || [];
  const g = normGraph(resourceGraph);
  const compMap = byId(comps);
  const focus = compMap.get(componentId);
  if (!focus) return null;

  const adj = new Map();
  const push = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of g.edges) {
    if (!e || e.from === undefined || e.to === undefined) continue;
    push(String(e.from), String(e.to));
    push(String(e.to), String(e.from));
  }
  const dist = new Map([[componentId, 0]]);
  const queue = [componentId];
  // Seed from membership as well as edges: a resource can be attributed to a
  // component via componentIds without an explicit cmp→rid edge (enrichment
  // records some associations that way). Without this, components like
  // secrets/VPC/IAM/KMS list a resource map but generate an empty one.
  for (const [rid, n] of Object.entries(g.nodes)) {
    if (Array.isArray(n?.componentIds) && n.componentIds.includes(componentId) && !dist.has(rid)) {
      dist.set(rid, 1);
      queue.push(rid);
    }
  }
  while (queue.length) {
    const v = queue.shift();
    const d = dist.get(v);
    if (d >= 2) continue;
    for (const nb of adj.get(v) || []) {
      if (!dist.has(nb)) { dist.set(nb, d + 1); queue.push(nb); }
    }
  }
  const LEAF_TYPES = new Set(['availability-zone', 'certificate', 'kms-key']);
  for (const e of g.edges) {
    if (!e) continue;
    const from = String(e.from), to = String(e.to);
    if (dist.has(from) && !dist.has(to) && g.nodes[to] && LEAF_TYPES.has(g.nodes[to].type)) {
      dist.set(to, 3);
    }
  }

  const rids = [...dist.keys()].filter((k) => g.nodes[k]);
  if (!rids.length) return null; // component has no presence in the graph
  const cmpIds = [...dist.keys()].filter((k) => k.startsWith('cmp_') && compMap.has(k));

  const nodes = cmpIds.map((cid) => canvasNode(compMap.get(cid)));
  const byService = new Map();
  for (const rid of rids) {
    const n = g.nodes[rid];
    const svc = n.service || 'AWS';
    nodes.push(smallResourceNode(rid, n, svc));
    if (!byService.has(svc)) byService.set(svc, []);
    byService.get(svc).push(rid);
  }
  const present = new Set(nodes.map((x) => String(x.id)));
  const edges = g.edges
    .filter((e) => e && present.has(String(e.from)) && present.has(String(e.to)))
    .map(graphEdgeToCanvas);
  const groups = [{ id: 'grp_components', label: 'Components', nodeIds: cmpIds }]
    .concat([...byService.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([svc, ids]) => ({ id: `svc_${slugify(svc)}`, label: svc, nodeIds: ids })));
  return {
    nodes, edges, groups,
    meta: { diagramId: `resource-map-${componentId}`, name: `Resource map — ${focus.name}`, regions: workspace?.regions || {} },
  };
}

export function buildResourceMapCanvasData(diagramId, data) {
  if (!hasResourceGraph(data?.resourceGraph)) return null;
  if (diagramId === 'resource-map') return buildResourceMapCanvas(data);
  if (String(diagramId).startsWith('resource-map-')) {
    return buildComponentResourceMapCanvas(data, String(diagramId).slice('resource-map-'.length));
  }
  return null;
}

// ---- mermaid builders (so the Mermaid/Icon-canvas toggle works) ----

const RES_CLASSDEFS = [
  'classDef rescmp stroke:#4f8ff7,stroke-width:2px',
  'classDef respill fill:#171c25,stroke:#2a3242,color:#8a94a6',
  'classDef resunlinked stroke:#e2a336,stroke-dasharray:4 3',
];

function resourceMapMermaidFull({ components, resourceGraph }) {
  const comps = components || [];
  const g = normGraph(resourceGraph);
  const rids = Object.keys(g.nodes);
  const compMap = byId(comps);
  const classes = new Map([['rescmp', []], ['respill', []], ['resunlinked', []]]);
  const mid = new Map();
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `r${seq++}`); return mid.get(id); };
  const lines = ['flowchart LR'];
  const notes = [];

  if (rids.length > RESOURCE_MAP_CAP) {
    const counts = resourceCounts(g);
    for (const c of comps) {
      const m = nid(c.id);
      lines.push(`  ${m}["${sanitizeLabel(`${c.name} · ${counts[c.id] || 0} resources`)}"]`);
      classes.get('rescmp').push(m);
    }
    for (const c of comps) {
      for (const dep of c.dependsOn || []) {
        if (mid.has(dep)) lines.push(`  ${nid(c.id)} --> ${nid(dep)}`);
      }
    }
    notes.push(`The resource graph holds **${rids.length} nodes** — above the ${RESOURCE_MAP_CAP}-node cap, so this map shows components with per-component resource counts. Open a per-component resource map for detail.`);
  } else {
    // owner = first componentId that still exists; null = unlinked
    const owned = new Map();
    for (const rid of rids) {
      const n = g.nodes[rid];
      const owner = (n.componentIds || []).find((cid) => compMap.has(cid)) || null;
      if (!owned.has(owner)) owned.set(owner, []);
      owned.get(owner).push(rid);
    }
    let gi = 0;
    for (const c of comps) {
      if (!owned.has(c.id)) continue;
      lines.push(`  subgraph rg${gi}["${sanitizeLabel(c.name)}"]`);
      lines.push('    direction TB');
      const m = nid(c.id);
      lines.push(`    ${m}["${sanitizeLabel(c.name)}"]`);
      classes.get('rescmp').push(m);
      for (const rid of owned.get(c.id)) {
        const n = g.nodes[rid];
        const rm = nid(rid);
        lines.push(`    ${rm}["${sanitizeLabel(truncate(`${n.name || rid} · ${n.type || 'resource'}`, 48))}"]`);
        classes.get('respill').push(rm);
      }
      lines.push('  end');
      gi++;
    }
    for (const c of comps) {
      if (owned.has(c.id)) continue;
      const m = nid(c.id);
      lines.push(`  ${m}["${sanitizeLabel(c.name)}"]`);
      classes.get('rescmp').push(m);
    }
    if (owned.has(null)) {
      lines.push(`  subgraph rgu["Unlinked"]`);
      lines.push('    direction TB');
      for (const rid of owned.get(null)) {
        const n = g.nodes[rid];
        const rm = nid(rid);
        lines.push(`    ${rm}["${sanitizeLabel(truncate(`${n.name || rid} · ${n.type || 'resource'}`, 48))}"]`);
        classes.get('resunlinked').push(rm);
      }
      lines.push('  end');
    }
    for (const e of g.edges) {
      if (!e || !mid.has(e.from) || !mid.has(e.to)) continue;
      const rel = sanitizeLabel(e.relation || '');
      lines.push(rel && rel !== 'unnamed'
        ? `  ${nid(e.from)} -->|"${rel}"| ${nid(e.to)}`
        : `  ${nid(e.from)} --> ${nid(e.to)}`);
    }
    notes.push(`Every discovered AWS resource (**${rids.length}**), clustered by the component it belongs to; edge labels carry the association relation (secured-by, in-subnet, encrypted-by…). Amber-dashed nodes were found by tag scan but are not linked to any component yet.`);
  }
  lines.push(...RES_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const shownCmp = comps.filter((c) => mid.has(c.id)).map((c) => c.id);
  return {
    id: 'resource-map', name: 'Resource map', kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      '**Resource map** — the full deep-enrichment graph from Discover → AWS → Deep enrichment. Switch to the Icon canvas view to expand and rearrange it interactively.',
      ...notes,
    ].join('\n\n'),
    componentIds: shownCmp,
  };
}

function resourceMapMermaidComponent(data, componentId) {
  const canvas = buildComponentResourceMapCanvas(data, componentId);
  if (!canvas) return null;
  const classes = new Map([['rescmp', []], ['respill', []]]);
  const mid = new Map();
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `r${seq++}`); return mid.get(id); };
  const nodeById = new Map(canvas.nodes.map((n) => [String(n.id), n]));
  const lines = ['flowchart LR'];
  canvas.groups.forEach((grp, gi) => {
    if (!grp.nodeIds.length) return;
    lines.push(`  subgraph rg${gi}["${sanitizeLabel(grp.label)}"]`);
    lines.push('    direction TB');
    for (const id of grp.nodeIds) {
      const node = nodeById.get(String(id));
      if (!node) continue;
      const m = nid(String(id));
      const label = node.small
        ? truncate(`${node.label} · ${node.rtype || node.sub || ''}`, 48)
        : node.label;
      lines.push(`    ${m}["${sanitizeLabel(label)}"]`);
      classes.get(node.small ? 'respill' : 'rescmp').push(m);
    }
    lines.push('  end');
  });
  for (const e of canvas.edges) {
    if (!mid.has(String(e.from)) || !mid.has(String(e.to))) continue;
    const rel = sanitizeLabel(e.label || '');
    lines.push(rel && rel !== 'unnamed'
      ? `  ${nid(String(e.from))} -->|"${rel}"| ${nid(String(e.to))}`
      : `  ${nid(String(e.from))} --> ${nid(String(e.to))}`);
  }
  lines.push(...RES_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const cmpIds = canvas.nodes.filter((n) => !n.small).map((n) => String(n.id));
  return {
    id: `resource-map-${componentId}`, name: canvas.meta.name, kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `Everything AWS knows to be attached to this component within **2 hops** (plus AZ / certificate / KMS leaves one hop further): security groups, subnets, IAM, target groups, listeners, keys, logs… grouped by AWS service.`,
      'Switch to the Icon canvas view for the draggable version — or expand the component in any other canvas diagram with its ⊕ control.',
    ].join('\n\n'),
    componentIds: cmpIds,
  };
}

export function generateResourceMap(id, data) {
  if (!hasResourceGraph(data?.resourceGraph)) return null;
  if (id === 'resource-map') return resourceMapMermaidFull(data);
  if (String(id).startsWith('resource-map-')) {
    return resourceMapMermaidComponent(data, String(id).slice('resource-map-'.length));
  }
  return null;
}

// List entries — only when the graph store is non-empty; per-component entries
// only for components that actually appear in the graph.
export function listResourceMapDiagrams(components, graph) {
  if (!hasResourceGraph(graph)) return [];
  const comps = components || [];
  const g = normGraph(graph);
  const rids = Object.keys(g.nodes);
  const counts = resourceCounts(g);
  const touched = touchedComponentIds(g);
  const withRes = comps.filter((c) => touched.has(c.id));
  const out = [{
    id: 'resource-map', name: 'Resource map', kind: 'resource-map',
    section: 'Resource map', canvas: true,
    description: `${rids.length} AWS resource${rids.length === 1 ? '' : 's'} across ${withRes.length} component${withRes.length === 1 ? '' : 's'}${rids.length > RESOURCE_MAP_CAP ? ' · summarized (large graph)' : ''}`,
  }];
  for (const c of withRes) {
    const direct = counts[c.id]
      || g.edges.filter((e) => e && (e.from === c.id || e.to === c.id)).length;
    out.push({
      id: `resource-map-${c.id}`, name: c.name, kind: 'resource-map',
      section: 'Resource map', canvas: true,
      description: `${direct} linked resource${direct === 1 ? '' : 's'} · 2-hop subgraph`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- listing

export function listDiagrams(components) {
  const overview = [
    { id: 'architecture', name: 'Architecture overview', kind: 'overview', description: 'Components grouped by category, with dependencies' },
    { id: 'dependencies', name: 'Dependency graph', kind: 'overview', description: 'Full digraph including outbound calls to external targets' },
    { id: 'restore-layers', name: 'Restore layer cake', kind: 'overview', description: 'What must come up in what order, L0 → L7' },
    { id: 'failover-sequence', name: 'Failover sequence', kind: 'overview', description: 'The failover story, layer by layer' },
    { id: 'region-pair', name: 'Region pair', kind: 'overview', description: 'Primary vs recovery region with replication arrows' },
    { id: 'data-replication', name: 'Data replication map', kind: 'overview', description: 'Per-store mechanism, RPO, and unreplicated stores' },
  ];
  const perComponent = (components || []).map((c) => ({
    id: `dependencies-${c.id}`,
    name: c.name,
    kind: 'component',
    description: `${CATEGORY_LABEL[c.category] || c.category || 'other'}${c.tier === 0 ? ' · tier 0' : ''}`,
  }));
  // Additive: which diagrams the icon-canvas view can render.
  return overview.concat(perComponent).map((d) => ({ ...d, canvas: canvasSupported(d.id) }));
}

export function generate(id, data) {
  switch (id) {
    case 'architecture': return architecture(data);
    case 'dependencies': return dependencies(data);
    case 'restore-layers': return restoreLayers(data);
    case 'failover-sequence': return failoverSequence(data);
    case 'region-pair': return regionPair(data);
    case 'data-replication': return dataReplication(data);
    default:
      if (id.startsWith('dependencies-')) return componentDependencies(data, id.slice('dependencies-'.length));
      if (isK8sDiagramId(id)) return generateK8s(id, data);
      if (isResourceMapId(id)) return generateResourceMap(id, data);
      return null;
  }
}

// ---------------------------------------------------------------- draw.io

const DRAWIO_FILL = {
  'compute': ['#dae8fc', '#6c8ebf'],
  'networking': ['#e1d5e7', '#9673a6'],
  'storage': ['#ffe6cc', '#d79b00'],
  'database': ['#d5e8d4', '#82b366'],
  'messaging-streaming': ['#fff2cc', '#d6b656'],
  'security-secrets': ['#f8cecc', '#b85450'],
  'edge-dns': ['#b1ddf0', '#10739e'],
  'identity-access': ['#ffe6cc', '#d79b00'],
  'observability': ['#e6e6e6', '#666666'],
  'third-party': ['#f5f5f5', '#666666'],
  'cicd-control-plane': ['#d0cee2', '#56517e'],
  'other': ['#f5f5f5', '#666666'],
};

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Valid diagrams.net mxGraph XML for the architecture view: swimlane per
// category, rounded component boxes, dependsOn edges, simple grid layout.
export function drawioXml({ workspace, components }) {
  const comps = components || [];
  const cats = categoriesPresent(comps);
  const BOX_W = 200, BOX_H = 46, GAP = 10, LANE_W = BOX_W + 2 * GAP, TITLE = 30;
  const COLS = 4, X0 = 40, Y0 = 40, XGAP = 60, YGAP = 50;

  const cells = [];
  const laneOf = new Map(); // category -> lane cell id
  // Grid placement: rows of up to COLS lanes; row height = tallest lane in row.
  let y = Y0;
  for (let r = 0; r * COLS < cats.length; r++) {
    const row = cats.slice(r * COLS, r * COLS + COLS);
    let rowH = 0;
    row.forEach((cat, ci) => {
      const inCat = comps.filter((c) => (c.category || 'other') === cat);
      const h = TITLE + inCat.length * (BOX_H + GAP) + GAP;
      rowH = Math.max(rowH, h);
      const laneId = `lane_${cat}`;
      laneOf.set(cat, laneId);
      const [fill, stroke] = DRAWIO_FILL[cat] || DRAWIO_FILL.other;
      cells.push(
        `<mxCell id="${escapeXml(laneId)}" value="${escapeXml(CATEGORY_LABEL[cat] || cat)}" ` +
        `style="swimlane;rounded=1;startSize=${TITLE};horizontal=1;fillColor=${fill};strokeColor=${stroke};fontStyle=1;fontSize=13;" ` +
        `vertex="1" parent="1"><mxGeometry x="${X0 + ci * (LANE_W + XGAP)}" y="${y}" width="${LANE_W}" height="${h}" as="geometry"/></mxCell>`
      );
      inCat.forEach((c, i) => {
        const dashed = cat === 'third-party' ? 'dashed=1;' : '';
        const bold = c.tier === 0 ? 'strokeWidth=2;fontStyle=1;' : '';
        cells.push(
          `<mxCell id="${escapeXml('n_' + c.id)}" value="${escapeXml(c.name)}" ` +
          `style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${stroke};${dashed}${bold}fontSize=12;" ` +
          `vertex="1" parent="${escapeXml(laneId)}"><mxGeometry x="${GAP}" y="${TITLE + GAP + i * (BOX_H + GAP)}" width="${BOX_W}" height="${BOX_H}" as="geometry"/></mxCell>`
        );
      });
    });
    y += rowH + YGAP;
  }
  const have = new Set(comps.map((c) => c.id));
  let e = 0;
  for (const c of comps)
    for (const dep of c.dependsOn || [])
      if (have.has(dep))
        cells.push(
          `<mxCell id="e${e++}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;strokeColor=#6b7a90;endArrow=blockThin;" ` +
          `edge="1" parent="1" source="${escapeXml('n_' + c.id)}" target="${escapeXml('n_' + dep)}"><mxGeometry relative="1" as="geometry"/></mxCell>`
        );

  const name = escapeXml(`${workspace?.name || 'DR Compass'} — architecture`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="drcompass" modified="${escapeXml(new Date().toISOString())}" agent="DR Compass" version="21.6.5" type="device">\n` +
    `  <diagram id="architecture" name="${name}">\n` +
    `    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">\n` +
    `      <root>\n` +
    `        <mxCell id="0"/>\n` +
    `        <mxCell id="1" parent="0"/>\n` +
    cells.map((c) => `        ${c}`).join('\n') + '\n' +
    `      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>\n`;
}

// Back-compat alias per spec wording.
export const toDrawio = drawioXml;

// ------------------------------------------------- draw.io with AWS shapes
// Official diagrams.net AWS 2024 resource icons (mxgraph.aws4 built-in shape
// library). resIcon names and category fill colors verified against the
// jgraph/drawio source (Sidebar-AWS4.js). Unknown kinds fall back to a plain
// rounded rect so the file always opens cleanly.

const AWS4_ICON = {
  'eks-cluster': ['eks', '#ED7100'],
  'eks-workload': ['eks', '#ED7100'],
  'ecs-service': ['ecs', '#ED7100'],
  'lambda': ['lambda', '#ED7100'],
  'ecr': ['ecr', '#ED7100'],
  'aurora-postgres': ['aurora', '#C925D1'],
  'elasticache-redis': ['elasticache', '#C925D1'],
  'dynamodb': ['dynamodb', '#C925D1'],
  's3': ['s3', '#7AA116'],
  'sqs': ['sqs', '#E7157B'],
  'api-gateway': ['api_gateway', '#E7157B'],
  'kinesis': ['kinesis', '#8C4FFF'],
  'vpc': ['vpc', '#8C4FFF'],
  'route53': ['route_53', '#8C4FFF'],
  'secrets-manager': ['secrets_manager', '#DD344C'],
  'iam': ['identity_and_access_management', '#DD344C'],
  'kms': ['key_management_service', '#DD344C'],
  'acm': ['certificate_manager', '#DD344C'],
  'transfer': ['transfer_family', '#01A88D'],
  'observability': ['cloudwatch_2', '#E7157B'],
  'cloudwatch': ['cloudwatch_2', '#E7157B'],
};

export function drawioXmlIcons({ workspace, components, diagramId = 'architecture' }) {
  const comps = components || [];
  const cats = categoriesPresent(comps);
  const ICON = 78, LABEL_H = 34, GAP = 14;
  const CELL_H = ICON + LABEL_H + GAP;
  const LANE_W = 240, TITLE = 30;
  const COLS = 4, X0 = 40, Y0 = 40, XGAP = 60, YGAP = 50;
  const ICON_X = Math.round((LANE_W - ICON) / 2);

  const cells = [];
  let y = Y0;
  for (let r = 0; r * COLS < cats.length; r++) {
    const row = cats.slice(r * COLS, r * COLS + COLS);
    let rowH = 0;
    row.forEach((cat, ci) => {
      const inCat = comps.filter((c) => (c.category || 'other') === cat);
      const h = TITLE + GAP + inCat.length * CELL_H;
      rowH = Math.max(rowH, h);
      const laneId = `lane_${cat}`;
      const [, stroke] = DRAWIO_FILL[cat] || DRAWIO_FILL.other;
      cells.push(
        `<mxCell id="${escapeXml(laneId)}" value="${escapeXml(CATEGORY_LABEL[cat] || cat)}" ` +
        `style="swimlane;rounded=1;startSize=${TITLE};horizontal=1;fillColor=none;strokeColor=${stroke};fontStyle=1;fontSize=13;" ` +
        `vertex="1" parent="1"><mxGeometry x="${X0 + ci * (LANE_W + XGAP)}" y="${y}" width="${LANE_W}" height="${h}" as="geometry"/></mxCell>`
      );
      inCat.forEach((c, i) => {
        const icon = AWS4_ICON[c.kind];
        const cy = TITLE + GAP + i * CELL_H;
        if (icon) {
          const [resIcon, fill] = icon;
          cells.push(
            `<mxCell id="${escapeXml('n_' + c.id)}" value="${escapeXml(c.name)}" ` +
            `style="sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=${fill};strokeColor=none;dashed=0;` +
            `verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;` +
            `shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${resIcon};" ` +
            `vertex="1" parent="${escapeXml(laneId)}"><mxGeometry x="${ICON_X}" y="${cy}" width="${ICON}" height="${ICON}" as="geometry"/></mxCell>`
          );
        } else {
          const dashed = cat === 'third-party' ? 'dashed=1;' : '';
          const [fill, stroke2] = DRAWIO_FILL[cat] || DRAWIO_FILL.other;
          cells.push(
            `<mxCell id="${escapeXml('n_' + c.id)}" value="${escapeXml(c.name)}" ` +
            `style="rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke2};${dashed}fontSize=12;fontColor=#232F3E;` +
            `verticalLabelPosition=bottom;verticalAlign=top;align=center;" ` +
            `vertex="1" parent="${escapeXml(laneId)}"><mxGeometry x="${ICON_X}" y="${cy}" width="${ICON}" height="${ICON}" as="geometry"/></mxCell>`
          );
        }
      });
    });
    y += rowH + YGAP;
  }
  const have = new Set(comps.map((c) => c.id));
  let e = 0;
  for (const c of comps)
    for (const dep of c.dependsOn || [])
      if (have.has(dep))
        cells.push(
          `<mxCell id="e${e++}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;strokeColor=#6b7a90;endArrow=blockThin;" ` +
          `edge="1" parent="1" source="${escapeXml('n_' + c.id)}" target="${escapeXml('n_' + dep)}"><mxGeometry relative="1" as="geometry"/></mxCell>`
        );

  const name = escapeXml(`${workspace?.name || 'DR Compass'} — ${diagramId} (AWS icons)`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="drcompass" modified="${escapeXml(new Date().toISOString())}" agent="DR Compass" version="21.6.5" type="device">\n` +
    `  <diagram id="${escapeXml(diagramId)}-aws" name="${name}">\n` +
    `    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">\n` +
    `      <root>\n` +
    `        <mxCell id="0"/>\n` +
    `        <mxCell id="1" parent="0"/>\n` +
    cells.map((c) => `        ${c}`).join('\n') + '\n' +
    `      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>\n`;
}

// ---------------------------------------------------------------- Lucidchart
// Lucid's "Diagram as code → Mermaid" importer accepts a NARROWER subset than
// mermaid.js, and it fails the WHOLE diagram on any unsupported construct (no
// partial render, no useful error text). So the lucid flavor is a conservative
// transform of our normal output, targeting the intersection of Lucid's two
// import paths (SVG rendering AND copy/paste-to-editable-shapes):
//
//   allowed : `flowchart LR|TD`, `sequenceDiagram`, one level of
//             `subgraph id["Label"]`, `id["Label"]`, `id{"Label"}`,
//             `A --> B`, `A -- text --> B`, `participant X as Label`,
//             `A->>B: text`, `A-->>B: text`, `%%` comments
//   removed : classDef / class / style / linkStyle (a hard syntax error in
//             Lucid), `%%{init}%%` and YAML frontmatter, `direction` inside a
//             subgraph, nested subgraphs (flattened into the label), HTML tags,
//             stadium/hexagon/circle/cylinder shapes, `-->|label|`,
//             `-. label .->`, `==>`, `---`, autonumber, Note over,
//             non-ASCII characters, and edges between subgraph containers.
//
// Everything here is additive: the default flavor is untouched.

export const LUCID_MAX_NODES = 60;

// Transliterate to ASCII and strip everything Lucid's parser can trip on.
// `mode` 'label' (goes inside double quotes) or 'edge' (bare after `--`).
export function lucidText(s, mode = 'label') {
  let t = String(s ?? '');
  const map = [
    [/[→⇒⟶]/g, '->'], [/[←⇐⟵]/g, '<-'],
    [/[↔⇔]/g, '<->'],
    [/[·•●]/g, '-'], [/[–—‒]/g, '-'],
    [/[‘’‛]/g, "'"], [/[“”„]/g, "'"],
    [/…/g, '...'], [/[⚠❗❕]/g, '!'],
    [/[✓✔]/g, 'ok'], [/✗/g, 'x'],
    [/[⊕⊖⊗]/g, '+'], [/ /g, ' '],
    [/[×]/g, 'x'], [/[≥]/g, '>='], [/[≤]/g, '<='],
  ];
  for (const [re, to] of map) t = t.replace(re, to);
  // Drop HTML tags and markdown-string backticks entirely.
  t = t.replace(/<[^>]*>/g, ' ').replace(/`/g, '');
  // Anything still non-ASCII (emoji, CJK, box drawing) goes.
  t = t.replace(/[^\x20-\x7E]/g, '');
  // Characters that break Mermaid/Lucid label parsing. `>` survives in label
  // mode so a transliterated arrow still reads as "->"; edge mode (bare text
  // after `--`) strips it below, because there it could read as arrow syntax.
  t = t.replace(/[#]/g, 'no.').replace(/[|;]/g, ' ')
    .replace(/[[\]{}<]/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/"/g, "'")
    .replace(/:/g, ' -');
  if (mode === 'edge') {
    // A bare edge label must not contain quotes, commas or dash runs that could
    // read as arrow syntax.
    t = t.replace(/'/g, '').replace(/,/g, ' ').replace(/-{2,}/g, '-').replace(/[=>]/g, ' ');
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

const LUCID_DROP_LINE = /^\s*(classDef|class|style|linkStyle|autonumber)\b/;
const LUCID_DIRECTIVE = /^\s*%%\{[\s\S]*\}%%\s*$/;

// Pull `id SHAPE` node declarations apart. Returns {id, label} or null.
function parseNodeDecl(line) {
  const m = line.match(/^([A-Za-z_][\w:.\-/@]*)\s*(\[\(|\(\(|\(\[|\{\{|\[|\(|\{)\s*"?([\s\S]*?)"?\s*(\)\]|\)\)|\]\)|\}\}|\]|\)|\})\s*$/);
  if (!m) return null;
  return { id: m[1], label: m[3], open: m[2] };
}

// Mermaid allows declaring a node inline in an edge line (`a["A"] --> b["B"]`).
// Register any such declarations and return the line with bare ids, so the edge
// matchers below see the simple form. The inner pattern cannot cross a closing
// bracket, which keeps `a["A"] --> b["B"]` from matching as one giant label.
const INLINE_DECL_RE = /([A-Za-z_][\w:.\-/@]*)(\[\(|\(\[|\(\(|\{\{|\[|\(|\{)\s*"?([^\]})"]*)"?\s*(\)\]|\]\)|\)\)|\}\}|\]|\)|\})/g;
function extractInlineDecls(line, register) {
  let found = false;
  const stripped = line.replace(INLINE_DECL_RE, (whole, id, open, label) => {
    found = true;
    register(id, label);
    return id;
  });
  return found ? stripped : null;
}

// Edge forms we know how to rewrite, most specific first.
const EDGE_FORMS = [
  // A -->|"label"| B   /  A ==>|label| B  /  A ---|label| B
  { re: /^([A-Za-z_][\w:.\-/@]*)\s*(?:-->|==>|---|-\.-|-\.->)\s*\|\s*"?([\s\S]*?)"?\s*\|\s*([A-Za-z_][\w:.\-/@]*)\s*$/, from: 1, label: 2, to: 3 },
  // A -. "label" .-> B
  { re: /^([A-Za-z_][\w:.\-/@]*)\s*-\.\s*"?([\s\S]*?)"?\s*\.->\s*([A-Za-z_][\w:.\-/@]*)\s*$/, from: 1, label: 2, to: 3 },
  // A -- label --> B  /  A == label ==> B
  { re: /^([A-Za-z_][\w:.\-/@]*)\s*(?:--|==)\s+([^->|]+?)\s+(?:-->|==>)\s*([A-Za-z_][\w:.\-/@]*)\s*$/, from: 1, label: 2, to: 3 },
  // A --> B  /  A ==> B  /  A -.-> B  /  A --- B
  { re: /^([A-Za-z_][\w:.\-/@]*)\s*(?:-->|==>|-\.->|---|-\.-)\s*([A-Za-z_][\w:.\-/@]*)\s*$/, from: 1, label: 0, to: 2 },
];

function parseEdge(line) {
  for (const f of EDGE_FORMS) {
    const m = line.match(f.re);
    if (!m) continue;
    return { from: m[f.from], to: m[f.to], label: f.label ? (m[f.label] || '') : '' };
  }
  return null;
}

// Turn a generated Mermaid source into the Lucid-safe flavor.
// Returns { mermaid, warnings, stats }.
export function toLucidMermaid(src, opts = {}) {
  const warnings = [];
  const name = opts.name ? lucidText(opts.name) : '';
  const raw = String(src ?? '');
  if (!raw.trim()) return { mermaid: '', warnings: ['the diagram has no Mermaid source'], stats: { nodes: 0, edges: 0, subgraphs: 0 } };

  // Strip YAML frontmatter and init directives outright.
  let body = raw.replace(/^\s*---[\s\S]*?---\s*/m, (m) => { warnings.push('YAML frontmatter removed (not supported in Lucid’s editable-shapes import)'); return ''; });
  const lines = body.split(/\r?\n/);

  const header = (lines.find((l) => l.trim() !== '') || '').trim();
  const isSequence = /^sequenceDiagram\b/.test(header);

  if (isSequence) return lucidSequence(lines, { name, warnings });

  // ---- flowchart ----
  let dir = 'LR';
  const hm = header.match(/^(?:flowchart|graph)\s+([A-Za-z]{2})\b/);
  if (hm) {
    const d = hm[1].toUpperCase();
    if (d === 'TB' || d === 'TD') dir = 'TD';
    else if (d === 'LR') dir = 'LR';
    else { dir = d === 'RL' ? 'LR' : 'TD'; warnings.push(`direction ${d} rewritten to ${dir} (Lucid documents only LR and TD)`); }
  } else if (!/^(?:flowchart|graph)\b/.test(header)) {
    warnings.push(`unrecognized diagram header "${lucidText(header).slice(0, 40)}" — emitted as a flowchart`);
  }

  const nodes = new Map();     // id -> label
  const subgraphIds = new Set();
  const groups = [];           // {id, label, nodeIds: []}
  const loose = [];            // node ids not in any group
  const edges = [];            // {from, to, label}
  const comments = [];
  let dropped = { styling: 0, direction: 0, nested: 0, groupEdges: 0, unparsed: 0 };
  const stack = [];            // open subgraph labels (for flattening)
  let gseq = 0;

  const addNode = (id, label, groupRef) => {
    const prefix = stack.length > 1 ? `${stack.slice(1).map((s) => s.label).join(' / ')} - ` : '';
    const text = lucidText(`${prefix}${label ?? id}`) || lucidText(String(id)) || 'node';
    if (!nodes.has(id)) nodes.set(id, text);
    if (groupRef) groupRef.nodeIds.push(id);
    else loose.push(id);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === header) continue;
    if (LUCID_DIRECTIVE.test(line)) { dropped.styling++; continue; }
    if (LUCID_DROP_LINE.test(line)) { dropped.styling++; continue; }
    if (/^%%/.test(line)) { const c = lucidText(line.replace(/^%%+/, '')); if (c) comments.push(c); continue; }
    if (/^direction\s+/i.test(line)) { dropped.direction++; continue; }

    const sg = line.match(/^subgraph\s+(?:([A-Za-z_][\w:.\-/@]*)\s*)?(?:\[\s*"?([\s\S]*?)"?\s*\]|"([\s\S]*?)")?\s*$/);
    if (sg) {
      const label = sg[2] ?? sg[3] ?? sg[1] ?? 'group';
      if (stack.length === 0) {
        const g = { id: `lg${gseq++}`, label: lucidText(label) || 'group', nodeIds: [], srcId: sg[1] || null };
        groups.push(g);
        if (sg[1]) subgraphIds.add(sg[1]);
        stack.push(g);
      } else {
        // nested: keep the grouping in the child labels instead of nesting boxes
        dropped.nested++;
        if (sg[1]) subgraphIds.add(sg[1]);
        stack.push({ id: null, label: lucidText(label) || 'group', nodeIds: stack[0].nodeIds });
      }
      continue;
    }
    if (/^end$/i.test(line)) { stack.pop(); continue; }

    const group = stack.length ? stack[0] : null;
    // A link token decides whether this is an edge line. Our generators strip
    // `<`/`>` from labels, so a `-->` in the line is always real syntax.
    // Covers `-->`, `==>`, `---`, `-.-`, `-.->`, the dotted-with-label form
    // `A -. "x" .-> B`, and `A -- x --> B` / `A == x ==> B`.
    const hasLink = /-->|==>|---|-\.-|\.->/.test(line) || /\s-\.\s/.test(line) || /\s(?:--|==)\s/.test(line);

    if (!hasLink) {
      const decl = parseNodeDecl(line);
      if (decl) { addNode(decl.id, decl.label, group); continue; }
      dropped.unparsed++;
      continue;
    }

    const edge = parseEdge(line);
    if (edge) { edges.push(edge); continue; }

    // `a["A"] --> b["B"]`: register the inline declarations, then re-try as an
    // edge between bare ids.
    const stripped = extractInlineDecls(line, (id, label) => addNode(id, label, group));
    if (stripped) {
      const e2 = parseEdge(stripped.trim());
      if (e2) { edges.push(e2); continue; }
      if (/^[A-Za-z_][\w:.\-/@]*$/.test(stripped.trim())) continue; // it was just a declaration
    }

    dropped.unparsed++;
  }

  // Edges that reference a subgraph CONTAINER (e.g. restore-layers' L0 --> L1)
  // cannot be expressed in Lucid-safe Mermaid — drop them and say so.
  const keptEdges = [];
  for (const e of edges) {
    if (subgraphIds.has(e.from) || subgraphIds.has(e.to)) { dropped.groupEdges++; continue; }
    if (!nodes.has(e.from) || !nodes.has(e.to)) { dropped.unparsed++; continue; }
    keptEdges.push(e);
  }

  if (dropped.styling) warnings.push(`${dropped.styling} styling/directive line${dropped.styling === 1 ? '' : 's'} removed (classDef / class / style / linkStyle / %%{init}%% are a syntax error in Lucid)`);
  if (dropped.direction) warnings.push(`${dropped.direction} in-subgraph "direction" line${dropped.direction === 1 ? '' : 's'} removed`);
  if (dropped.nested) warnings.push(`${dropped.nested} nested subgraph${dropped.nested === 1 ? '' : 's'} flattened — the nesting is folded into the node labels`);
  if (dropped.groupEdges) warnings.push(`${dropped.groupEdges} group-to-group edge${dropped.groupEdges === 1 ? '' : 's'} dropped (Lucid cannot link subgraph containers) — the group order is listed in a comment`);
  if (dropped.unparsed) warnings.push(`${dropped.unparsed} line${dropped.unparsed === 1 ? '' : 's'} could not be expressed in the Lucid-safe subset and were dropped`);

  const out = [];
  out.push(`%% DR Compass${name ? ` - ${name}` : ''} - Lucidchart-safe flavor`);
  out.push('%% Paste into Lucidchart: Insert > Diagram as code > Mermaid');
  for (const c of comments.slice(0, 4)) out.push(`%% ${c}`);
  if (dropped.groupEdges && groups.length) {
    out.push(`%% group order: ${groups.map((g) => g.label).join(' -> ')}`);
  }

  // --- size guard -----------------------------------------------------------
  const cap = Number.isFinite(opts.maxNodes) ? opts.maxNodes : LUCID_MAX_NODES;
  if (nodes.size > cap) {
    if (groups.length > 1) {
      warnings.push(`summarized for Lucid: ${nodes.size} nodes exceeded the ${cap}-node guard, so each group is one node with its internal link count`);
      out.push(`flowchart ${dir}`);
      const groupOf = new Map();
      groups.forEach((g) => g.nodeIds.forEach((id) => groupOf.set(id, g.id)));
      const looseGroup = loose.length ? { id: 'lgx', label: 'Ungrouped', nodeIds: loose } : null;
      if (looseGroup) loose.forEach((id) => groupOf.set(id, looseGroup.id));
      const all = looseGroup ? groups.concat([looseGroup]) : groups;
      const internal = new Map(all.map((g) => [g.id, 0]));
      const between = new Map();
      for (const e of keptEdges) {
        const a = groupOf.get(e.from), b = groupOf.get(e.to);
        if (a === undefined || b === undefined) continue;
        if (a === b) { internal.set(a, (internal.get(a) || 0) + 1); continue; }
        const k = `${a}|${b}`;
        between.set(k, (between.get(k) || 0) + 1);
      }
      for (const g of all) {
        const inner = internal.get(g.id) || 0;
        const label = `${g.label} - ${g.nodeIds.length} node${g.nodeIds.length === 1 ? '' : 's'}${inner ? `, ${inner} internal link${inner === 1 ? '' : 's'}` : ''}`;
        out.push(`${g.id}["${label}"]`);
      }
      for (const [k, n] of [...between.entries()].sort()) {
        const [a, b] = k.split('|');
        out.push(n > 1 ? `${a} -- ${n} links --> ${b}` : `${a} --> ${b}`);
      }
      return {
        mermaid: out.join('\n') + '\n',
        warnings,
        stats: { nodes: all.length, edges: between.size, subgraphs: 0, summarized: true, sourceNodes: nodes.size },
      };
    }
    warnings.push(`large diagram: ${nodes.size} nodes (above the ${cap}-node guard) — Lucid gives no partial render, so consider a per-component diagram instead`);
  }

  // --- normal emission ------------------------------------------------------
  out.push(`flowchart ${dir}`);
  const emitted = new Set();
  for (const g of groups) {
    const members = g.nodeIds.filter((id) => nodes.has(id) && !emitted.has(id));
    if (!members.length) continue;
    out.push(`subgraph ${g.id}["${g.label}"]`);
    for (const id of members) { out.push(`  ${id}["${nodes.get(id)}"]`); emitted.add(id); }
    out.push('end');
  }
  for (const id of nodes.keys()) {
    if (emitted.has(id)) continue;
    out.push(`${id}["${nodes.get(id)}"]`);
    emitted.add(id);
  }
  for (const e of keptEdges) {
    const label = lucidText(e.label, 'edge');
    out.push(label ? `${e.from} -- ${label} --> ${e.to}` : `${e.from} --> ${e.to}`);
  }
  return {
    mermaid: out.join('\n') + '\n',
    warnings,
    stats: { nodes: nodes.size, edges: keptEdges.length, subgraphs: groups.length, summarized: false },
  };
}

// Sequence diagrams: participants + one-way arrows only. `Note over` becomes a
// self-message on the first actor so the verification text is not lost, and
// autonumber is dropped (undocumented in Lucid).
function lucidSequence(lines, { name, warnings }) {
  const out = [];
  out.push(`%% DR Compass${name ? ` - ${name}` : ''} - Lucidchart-safe flavor`);
  out.push('%% Paste into Lucidchart: Insert > Diagram as code > Mermaid');
  out.push('sequenceDiagram');
  let notes = 0, dropped = 0, styling = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^sequenceDiagram\b/.test(line)) continue;
    if (LUCID_DIRECTIVE.test(line) || LUCID_DROP_LINE.test(line)) { styling++; continue; }
    if (/^%%/.test(line)) continue;
    const p = line.match(/^participant\s+([A-Za-z_][\w]*)\s+as\s+(.+)$/);
    if (p) { out.push(`  participant ${p[1]} as ${lucidText(p[2], 'edge') || p[1]}`); continue; }
    const pOnly = line.match(/^participant\s+([A-Za-z_][\w]*)\s*$/);
    if (pOnly) { out.push(`  participant ${pOnly[1]}`); continue; }
    const note = line.match(/^Note\s+(?:over|left of|right of)\s+([A-Za-z_][\w]*)(?:\s*,\s*[A-Za-z_][\w]*)?\s*:\s*(.+)$/i);
    if (note) {
      const text = lucidText(note[2]);
      if (text) { out.push(`  ${note[1]}->>${note[1]}: ${text}`); notes++; }
      continue;
    }
    const msg = line.match(/^([A-Za-z_][\w]*)\s*(->>|-->>|->|-->|<<->>|<<-->>)\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (msg) {
      const arrow = msg[2] === '-->' || msg[2] === '-->>' ? '-->>' : '->>';
      const text = lucidText(msg[4]) || 'step';
      if (msg[2] === '<<->>' || msg[2] === '<<-->>') {
        // Lucid does not support bidirectional arrows — emit both directions.
        out.push(`  ${msg[1]}${arrow}${msg[3]}: ${text}`);
        out.push(`  ${msg[3]}${arrow}${msg[1]}: ${text}`);
        warnings.push('a bidirectional sequence arrow was split into two one-way arrows (Lucid does not support <<->>)');
      } else {
        out.push(`  ${msg[1]}${arrow}${msg[3]}: ${text}`);
      }
      continue;
    }
    if (/^(loop|alt|else|opt|par|and|end|activate|deactivate|rect)\b/i.test(line)) { dropped++; continue; }
    dropped++;
  }
  if (styling) warnings.push(`${styling} directive/styling line${styling === 1 ? '' : 's'} removed (including autonumber, which Lucid does not document)`);
  if (notes) warnings.push(`${notes} "Note over" line${notes === 1 ? '' : 's'} converted to self-messages (Lucid does not document notes)`);
  if (dropped) warnings.push(`${dropped} unsupported sequence line${dropped === 1 ? '' : 's'} dropped (blocks like loop/alt are not in Lucid's documented subset)`);
  return { mermaid: out.join('\n') + '\n', warnings, stats: { nodes: 0, edges: 0, subgraphs: 0, sequence: true } };
}

// Structural lint: returns a list of violations of the Lucid-safe subset.
// Used by the test suite and available to callers that want to assert.
export function lintLucidMermaid(src) {
  const bad = [];
  const text = String(src ?? '');
  const lines = text.split(/\r?\n/);
  if (/%%\{/.test(text)) bad.push('contains an %%{init}%% directive');
  if (/^\s*---\s*$/m.test(text)) bad.push('contains YAML frontmatter');
  if (/<[a-zA-Z/!][^>]*>/.test(text)) bad.push('contains an HTML tag');
  if (/[^\x20-\x7E\n\r\t]/.test(text)) bad.push('contains non-ASCII characters');
  let depth = 0, sawHeader = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const at = `line ${i + 1}: `;
    if (/^%%/.test(line)) return;
    if (!sawHeader) {
      if (/^(flowchart|graph)\s+(LR|TD)$/.test(line) || /^sequenceDiagram$/.test(line)) { sawHeader = true; return; }
      if (/^(flowchart|graph)\b/.test(line)) { bad.push(`${at}header must be "flowchart LR" or "flowchart TD"`); sawHeader = true; return; }
      bad.push(`${at}unexpected first statement "${line.slice(0, 40)}"`);
      sawHeader = true;
      return;
    }
    if (/^(classDef|class|style|linkStyle|autonumber)\b/.test(line)) { bad.push(`${at}styling/directive line`); return; }
    if (/^direction\b/.test(line)) { bad.push(`${at}direction inside the diagram`); return; }
    if (/^subgraph\b/.test(line)) {
      depth++;
      if (depth > 1) bad.push(`${at}nested subgraph`);
      if (!/^subgraph\s+[A-Za-z_][\w:.\-/@]*\["[^"]*"\]$/.test(line)) bad.push(`${at}subgraph must be: subgraph id["Label"]`);
      return;
    }
    if (/^end$/.test(line)) { depth = Math.max(0, depth - 1); return; }
    // node declaration
    if (/^[A-Za-z_][\w:.\-/@]*\["[^"]*"\]$/.test(line) || /^[A-Za-z_][\w:.\-/@]*\{"[^"]*"\}$/.test(line)) return;
    // allowed edges
    if (/^[A-Za-z_][\w:.\-/@]*\s-->\s[A-Za-z_][\w:.\-/@]*$/.test(line)) return;
    if (/^[A-Za-z_][\w:.\-/@]*\s--\s[^|"#<>]+\s-->\s[A-Za-z_][\w:.\-/@]*$/.test(line)) return;
    // sequence statements
    if (/^participant\s+\w+(\s+as\s+[^"#|]+)?$/.test(line)) return;
    if (/^\w+(->>|-->>)\w+:\s?.*$/.test(line)) return;
    if (/\|/.test(line)) { bad.push(`${at}pipe edge-label syntax`); return; }
    if (/-\.|==>|---/.test(line)) { bad.push(`${at}dotted/thick/open link`); return; }
    if (/\(\[|\{\{|\(\(|\[\(/.test(line)) { bad.push(`${at}unsupported node shape`); return; }
    bad.push(`${at}not in the Lucid-safe subset: "${line.slice(0, 48)}"`);
  });
  if (depth !== 0) bad.push('unbalanced subgraph/end');
  return bad;
}

// Convenience wrapper: take a generated diagram object and return its Lucid
// flavor (mermaid + warnings). Keeps routes/diagrams.js thin.
export function lucidFlavor(d, opts = {}) {
  if (!d) return null;
  const { mermaid, warnings, stats } = toLucidMermaid(d.mermaid, { name: d.name, ...opts });
  return { ...d, mermaid, lucidWarnings: warnings, lucidStats: stats, flavor: 'lucid' };
}
