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
  return overview.concat(perComponent);
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
