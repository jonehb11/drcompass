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

// A store is a CACHE only when what it is says so — its kind, its AWS service or
// its category. Never because of its replication mechanism: `rebuild` describes
// what happens to the store, not what the store is for. Everything in the seed
// that rebuilds cold happens to be ElastiCache, and generalising from that is
// how a settlement dead-letter queue came to be described to stakeholders as a
// cache that "simply refills".
const CACHE_RE = /(^|[^a-z])(cache|caching|elasticache|memcach|memory ?db|valkey|varnish|cdn|cloudfront)([^a-z]|$)/i;
const isCacheStore = (c) => {
  if (String(c?.category || '') === 'caching') return true;
  const sig = [c?.kind, c?.name, c?.category, ...(Array.isArray(c?.awsServices) ? c.awsServices : [])]
    .map((x) => String(x ?? '')).join(' ');
  // Redis/Valkey are caches by default but are also used as durable stores, so
  // the name has the last word: "redis (session cache)" is one, "redis stream
  // ledger" is not.
  if (/\bredis\b/i.test(sig) && !/\b(stream|ledger|queue|journal|durable|persist)/i.test(sig)) return true;
  return CACHE_RE.test(sig);
};

const rpoText = (c) => {
  const m = c.replication?.rpoMinutes;
  if (typeof m !== 'number' || !Number.isFinite(m)) return '';
  // RPO 0 means NO DATA LOSS — synchronous or zero-lag replication. It used to
  // print as "rebuilt cold" because the only zeroes in the seed sit on caches,
  // which states the exact opposite of what the field says for an S3 RTC bucket
  // or a synchronous mirror. Only the mechanism may say "rebuilt cold".
  if (m === 0) return c.replication?.mechanism === 'rebuild' ? 'rebuilt cold' : 'RPO 0 — no data loss';
  return `RPO ${m}m`;
};

// "mechanism · RPO 30m" without repeating ourselves for rebuild-type stores.
function replLabelParts(c) {
  const mech = c.replication?.mechanism || 'unknown';
  const rpo = rpoText(c);
  if (mech !== 'rebuild') return [mech, rpo].filter(Boolean);
  // Same mechanism, two entirely different consequences. Say which one this is.
  return [isCacheStore(c) ? 'rebuilt cold on failover' : 'recreated EMPTY on failover — data lost'];
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

// The `rebuild` mechanism means the store is recreated EMPTY in the recovery
// region. For a cache that is a latency problem that fixes itself. For anything
// else it is data loss, and for a queue it is every message still in it —
// which is why these two get two different sentences and the non-cache one is
// never softened. `names` is capped: this is a diagram note, not a list.
function rebuildNotes(stores, recovery) {
  const rebuilt = (stores || []).filter((c) => c.replication?.mechanism === 'rebuild' && c.inRecoveryScope !== 'no');
  if (!rebuilt.length) return [];
  const caches = rebuilt.filter(isCacheStore);
  const others = rebuilt.filter((c) => !isCacheStore(c));
  const names = (cs) => cs.slice(0, 4).map((c) => c.name).join(', ') + (cs.length > 4 ? `, and ${cs.length - 4} more` : '');
  const out = [];
  if (caches.length) {
    const one = caches.length === 1;
    out.push(`${caches.length} cache${one ? '' : 's'} (${names(caches)}) ${one ? 'is' : 'are'} marked `
      + `*rebuilt cold on failover*: ${one ? 'it carries' : 'they carry'} no data across and ${one ? 'refills' : 'refill'} from the system of record. `
      + `Budget for the cold-start read load that lands on whatever sits behind ${one ? 'it' : 'them'}.`);
  }
  if (others.length) {
    const one = others.length === 1;
    const q = others.filter((c) => /queue|sqs|dlq|dead[- ]?letter|kinesis|kafka|msk|topic|stream/i.test(`${c.kind} ${c.name}`));
    const queueLine = !q.length ? ''
      : one
        ? 'It is a queue or stream, so what is lost is every message still unprocessed in it — that is not a cold start, it is data. '
        : `${q.length} of them ${q.length === 1 ? 'is a queue or stream' : 'are queues or streams'}, so what is lost there is every message still unprocessed — that is not a cold start, it is data. `;
    out.push(`**${others.length} store${one ? '' : 's'} with mechanism \`rebuild\` ${one ? 'is' : 'are'} NOT ${one ? 'a cache' : 'caches'}: ${names(others)}.** `
      + `${one ? 'Its arrow reads' : 'Their arrows read'} *recreated EMPTY on failover*: whatever ${one ? 'it was' : 'they were'} still holding does not come across, and ${one ? 'it starts' : 'they start'} empty in ${recovery}. `
      + queueLine
      + 'This is accepted data loss: name what is lost and who signed it off, or change the mechanism. Do not present it as a refill.');
  }
  return out;
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
      ...rebuildNotes(stores, recovery),
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
    || id === 'region-pair' || id === 'data-replication' || id.startsWith('dependencies-')
    || String(id).startsWith('service-');
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

export function buildCanvasData(diagramId, data) {
  const { workspace, components } = data || {};
  if (!canvasSupported(diagramId)) return null;
  if (isServiceDiagramId(diagramId)) return buildServiceCanvas(data, serviceIdOfDiagram(diagramId));
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

/* ===========================================================================
 * ENVIRONMENTS AND SERVICES          (docs/ENV-SERVICE-MODEL.md § 3, and the
 *                                     resolver in server/lib/scope.js)
 * ---------------------------------------------------------------------------
 * A real inventory is 2,000+ protected resources spread over several
 * environments and a dozen services. A diagram of all of it is not a diagram.
 * The first and biggest readability fix is therefore not a cleverer renderer:
 * it is asking a smaller question — "adjudication, in prod" instead of
 * "everything". server/lib/scope.js resolves ?envId=/?serviceId= and hands us
 * an already-narrowed component list; everything here is pure and takes that
 * list plus the scope descriptor for labelling.
 * =========================================================================*/

// services.json is a normal `{items:[...]}` collection; the route may hand us
// the array or the raw object, and neither is required to exist.
export function workspaceServices(data) {
  const s = data?.services;
  const items = Array.isArray(s) ? s : (s && Array.isArray(s.items) ? s.items : []);
  return items.filter((x) => x && x.id);
}

export function workspaceEnvironments(data) {
  const envs = data?.workspace?.environments;
  return (Array.isArray(envs) ? envs : []).filter((e) => e && e.id);
}

const serviceOf = (c) => (c && c.serviceId ? String(c.serviceId) : '');

// Narrow a resource graph to the components in scope: a resource is in scope
// when a component in scope owns it, and an edge when both ends survive.
export function scopeResourceGraph(graph, componentIds) {
  const g = normGraph(graph);
  if (!componentIds) return graph;
  const keep = componentIds instanceof Set ? componentIds : new Set([...componentIds].map(String));
  const nodes = {};
  for (const [rid, n] of Object.entries(g.nodes)) {
    const owners = Array.isArray(n?.componentIds) ? n.componentIds.map(String) : [];
    if (owners.some((cid) => keep.has(cid))) nodes[rid] = n;
  }
  const rids = new Set(Object.keys(nodes));
  const present = (v) => typeof v === 'string' && (rids.has(v) || keep.has(v));
  const edges = g.edges.filter((e) => e && present(e.from) && present(e.to));
  return Object.keys(nodes).length ? { ...(graph || {}), nodes, edges } : {};
}

// "adjudication · Prod" — what a scoped diagram says it is scoped to.
export function scopeLabel(scope) {
  if (!scope || !scope.active) return '';
  const parts = [];
  if (scope.serviceName || scope.serviceId) parts.push(scope.serviceName || scope.serviceId);
  if (scope.envName || scope.envId) parts.push(scope.envName || scope.envId);
  return parts.join(' · ');
}

// A layout / export key that survives the layouts route's /^[\w-]{1,160}$/.
// Saved positions, expansion state and exports are per SCOPE, not per id —
// "architecture in prod" and "architecture in dev" are different pictures.
export function scopedDiagramKey(id, scope) {
  const bits = [String(id)];
  if (scope && scope.active) {
    if (scope.envId) bits.push(`env-${String(scope.envId).replace(/[^\w-]/g, '')}`);
    if (scope.serviceId) bits.push(`svc-${String(scope.serviceId).replace(/[^\w-]/g, '')}`);
  }
  return bits.join('--').slice(0, 160);
}

/* ===========================================================================
 * PER-SERVICE DIAGRAMS  —  first-class ids, not a filter someone has to find
 * =========================================================================*/

const SERVICE_PREFIX = 'service-';
export function isServiceDiagramId(id) {
  return String(id).startsWith(SERVICE_PREFIX);
}
export function serviceDiagramId(serviceId) {
  return `${SERVICE_PREFIX}${serviceId}`;
}
export function serviceIdOfDiagram(id) {
  return isServiceDiagramId(id) ? String(id).slice(SERVICE_PREFIX.length) : '';
}

// The service, everything it owns, and the one-hop neighbours OUTSIDE it —
// because "what does adjudication depend on that adjudication does not own" is
// the question a service-scoped recovery has to answer.
export function serviceNeighborhood(data, serviceId) {
  const svcs = workspaceServices(data);
  const svc = svcs.find((s) => String(s.id) === String(serviceId));
  if (!svc) return null;
  const comps = data?.components || [];
  const memberIds = new Set((Array.isArray(svc.componentIds) ? svc.componentIds : []).map(String));
  const mine = comps.filter((c) => serviceOf(c) === String(svc.id) || memberIds.has(String(c.id)));
  const mineIds = new Set(mine.map((c) => String(c.id)));
  const map = byId(comps);
  const svcName = new Map(svcs.map((s) => [String(s.id), String(s.name || s.id)]));
  const outside = new Map();
  for (const c of mine) {
    for (const dep of c.dependsOn || []) {
      if (mineIds.has(String(dep)) || !map.has(dep)) continue;
      outside.set(String(dep), { comp: map.get(dep), direction: 'depends-on' });
    }
  }
  for (const c of comps) {
    if (mineIds.has(String(c.id))) continue;
    if ((c.dependsOn || []).some((d) => mineIds.has(String(d))) && !outside.has(String(c.id))) {
      outside.set(String(c.id), { comp: c, direction: 'depended-on-by' });
    }
  }
  return { svc, mine, mineIds, outside: [...outside.values()], svcName };
}

export function serviceDiagram(data, serviceId) {
  const nb = serviceNeighborhood(data, serviceId);
  if (!nb) return null;
  const { svc, mine, mineIds, outside, svcName } = nb;
  const all = mine.concat(outside.map((o) => o.comp));
  const ids = nodeIds(all);
  const classes = newClasses();
  const lines = ['flowchart LR'];
  categoriesPresent(mine).forEach((cat, i) => {
    lines.push(`  subgraph ssg${i}["${sanitizeLabel(CATEGORY_LABEL[cat] || cat)}"]`);
    lines.push('    direction TB');
    for (const c of mine.filter((x) => (x.category || 'other') === cat)) {
      const nid = ids.get(c.id);
      lines.push(`    ${nid}["${sanitizeLabel(c.name)}"]`);
      pushTierAndThirdParty(classes, c, nid);
    }
    lines.push('  end');
  });
  for (const o of outside) {
    const nid = ids.get(o.comp.id);
    const owner = serviceOf(o.comp) ? svcName.get(serviceOf(o.comp)) || 'another service' : 'unassigned';
    lines.push(`  ${nid}["${sanitizeLabel(`${o.comp.name} · ${owner}`)}"]`);
    classes.get('ghost').push(nid);
  }
  for (const c of all) {
    for (const dep of c.dependsOn || []) {
      if (!ids.has(dep)) continue;
      if (!mineIds.has(String(c.id)) && !mineIds.has(String(dep))) continue; // ghost↔ghost
      lines.push(`  ${ids.get(c.id)} --> ${ids.get(dep)}`);
    }
  }
  let x = 0;
  for (const c of mine) {
    for (const oc of c.outboundCalls || []) {
      const xid = `sx${x++}`;
      lines.push(`  ${xid}(["${sanitizeLabel(oc.target)}"])`);
      classes.get(EXT_CLASS[oc.type] || 'extinternal').push(xid);
      const label = sanitizeLabel([oc.protocol, oc.critical ? 'critical' : ''].filter(Boolean).join(' · ') || oc.type);
      lines.push(`  ${ids.get(c.id)} -. "${label}" .-> ${xid}`);
    }
  }
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const env = workspaceEnvironments(data).find((e) => String(e.id) === String(svc.envId));
  return {
    id: serviceDiagramId(svc.id),
    name: `Service — ${svc.name}${env ? ` (${env.name || env.slug || env.id})` : ''}`,
    kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `**${svc.name}**${env ? ` in **${env.name || env.id}**` : ''} — the ${mine.length} component${mine.length === 1 ? '' : 's'} it owns, grouped by category.`,
      outside.length
        ? `Grey dashed nodes are **outside the service** (${outside.length}): what it depends on, and what depends on it. Those are the hand-offs a service-scoped recovery has to coordinate with somebody else.`
        : 'Nothing outside this service touches it — it can be recovered on its own.',
      'Dotted arrows are outbound calls leaving the inventory entirely.',
    ].join('\n\n'),
    componentIds: all.map((c) => c.id),
  };
}

export function buildServiceCanvas(data, serviceId) {
  const nb = serviceNeighborhood(data, serviceId);
  if (!nb) return null;
  const { svc, mine, mineIds, outside, svcName } = nb;
  const ghostNodes = outside.map((o) => ({
    ...canvasNode(o.comp),
    sub: `${serviceOf(o.comp) ? svcName.get(serviceOf(o.comp)) || 'other service' : 'unassigned'} · ${o.direction === 'depends-on' ? 'this service depends on it' : 'depends on this service'}`,
    ghost: true,
  }));
  const all = mine.concat(outside.map((o) => o.comp));
  const ext = outboundParts(mine);
  const edges = depEdges(all).filter((e) => mineIds.has(String(e.from)) || mineIds.has(String(e.to)));
  return {
    nodes: mine.map(canvasNode).concat(ghostNodes, ext.nodes),
    edges: edges.concat(ext.edges),
    groups: categoryGroups(mine),
    meta: {
      diagramId: serviceDiagramId(svc.id),
      name: `Service — ${svc.name}`,
      regions: data?.workspace?.regions || {},
      serviceId: String(svc.id),
      envId: svc.envId ? String(svc.envId) : null,
    },
  };
}

// Listing entries for every service (optionally only those in the env scope).
export function listServiceDiagrams(data, scope = null) {
  const svcs = workspaceServices(data);
  if (!svcs.length) return [];
  const envs = workspaceEnvironments(data);
  const envName = new Map(envs.map((e) => [String(e.id), String(e.name || e.slug || e.id)]));
  const comps = data?.components || [];
  const counts = new Map();
  for (const c of comps) {
    const k = serviceOf(c);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const wantEnv = scope && scope.active && scope.envId && scope.envId !== 'unassigned' ? String(scope.envId) : '';
  const wantSvc = scope && scope.active && scope.serviceId && scope.serviceId !== 'unassigned' ? String(scope.serviceId) : '';
  return svcs
    .filter((s) => (!wantEnv || String(s.envId || '') === wantEnv))
    .filter((s) => (!wantSvc || String(s.id) === wantSvc))
    .map((s) => {
      const n = counts.get(String(s.id))
        || (Array.isArray(s.componentIds) ? s.componentIds.length : 0);
      const env = s.envId ? envName.get(String(s.envId)) : '';
      return {
        id: serviceDiagramId(s.id),
        name: s.name || s.id,
        kind: 'service',
        section: 'Services',
        canvas: true,
        serviceId: String(s.id),
        envId: s.envId ? String(s.envId) : null,
        description: [
          `${n} component${n === 1 ? '' : 's'}`,
          env ? `in ${env}` : '',
          s.tier === 0 ? 'tier 0' : '',
        ].filter(Boolean).join(' · '),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ===========================================================================
 * MERMAID AT SCALE  —  degrade honestly instead of drawing a hairball
 * ---------------------------------------------------------------------------
 * Measured on synthetic inventories, laying each size out with the canvas's own
 * Sugiyama engine (strictly BETTER than mermaid's dagre) and measuring the
 * drawing it produces:
 *
 *   components  links   crossings/link   drawing area   Mermaid source
 *      15         14        0.0            0.9 Mpx          1.9 KB
 *      40         71        0.6            6.2 Mpx          3.6 KB
 *      60        107        0.8            6.2 Mpx          4.9 KB
 *      80        159        1.9           12.6 Mpx          6.4 KB
 *     100        204        2.5           22.5 Mpx          7.8 KB
 *     200        462        6.3          139.1 Mpx         15.8 KB
 *     500       1211       21.7          750.4 Mpx         39.8 KB
 *
 * A 1920×1080 screen is 2.1 Mpx. Up to ~70 nodes the best possible layout still
 * fits in a handful of screens and crosses itself less than once per link. Past
 * that the picture is not merely "dense", it cannot be read at any zoom: zoomed
 * out the labels are sub-pixel, zoomed in you are looking through a straw at a
 * graph whose structure is off-screen. So past that we summarise — and say so.
 * =========================================================================*/

export const MERMAID_MAX_NODES = 70;
export const MERMAID_MAX_EDGES = 140;

// Count what a generated source actually draws (node declarations + links).
export function countMermaidScale(src) {
  const text = String(src || '');
  let nodes = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('%%') || t.startsWith('subgraph') || t === 'end') continue;
    if (/^(classDef|class|style|linkStyle|direction|flowchart|graph|sequenceDiagram|autonumber|participant|Note|activate|deactivate|loop|alt|else|opt|par|rect)\b/.test(t)) continue;
    if (/^[A-Za-z_][\w:.\-/@]*\s*(\[\(|\(\[|\(\(|\{\{|\[|\(|\{)/.test(t)) nodes++;
  }
  const edges = (text.match(/--+>|-\.->|\.->|==+>/g) || []).length;
  return { nodes, edges };
}

export function mermaidTooBig(scale) {
  return !!scale && (scale.nodes > MERMAID_MAX_NODES || scale.edges > MERMAID_MAX_EDGES);
}

const EXT_NOUN = {
  'aws-service': 'AWS service', 'third-party': 'third party', 'saas': 'SaaS target',
  'on-prem': 'on-prem target', 'internal': 'internal target',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Service-level when services actually cover the components, category-level
// otherwise. Never invents a grouping: 'Unassigned' is a real bucket.
export function summaryGrouping(data, comps, wanted = 'auto') {
  const svcs = workspaceServices(data);
  const svcById = new Map(svcs.map((s) => [String(s.id), s]));
  const covered = comps.filter((c) => svcById.has(serviceOf(c))).length;
  // Rolling one service's own components up BY service produces one box, which
  // says nothing. Below three groups, category-level is the informative answer.
  const distinct = new Set(comps.map((c) => serviceOf(c)).filter((k) => svcById.has(k))).size;
  const useService = wanted === 'service'
    || (wanted !== 'category' && svcs.length > 0 && comps.length > 0
        && covered >= comps.length * 0.6 && distinct >= 3);
  if (useService) {
    // The same service name exists once per environment ("adjudication" in
    // prod, staging and dev). Unscoped, three identical boxes are a lie about
    // what is connected to what — so a colliding name carries its environment.
    const envName = new Map(workspaceEnvironments(data).map((e) => [String(e.id), String(e.name || e.slug || e.id)]));
    const seen = new Map();
    for (const s of svcs) seen.set(String(s.name || s.id), (seen.get(String(s.name || s.id)) || 0) + 1);
    const labelOfService = (s) => {
      const name = String(s?.name || '');
      if (!s) return '';
      if ((seen.get(name) || 0) > 1 && s.envId) return `${name} (${envName.get(String(s.envId)) || s.envId})`;
      return name || String(s.id);
    };
    return {
      level: 'service',
      keyOf: (c) => (svcById.has(serviceOf(c)) ? serviceOf(c) : '~unassigned'),
      labelOf: (k) => (k === '~unassigned' ? 'Unassigned' : labelOfService(svcById.get(k)) || k),
      rankOf: (k) => (k === '~unassigned' ? 999 : 0),
      noun: 'service',
    };
  }
  return {
    level: 'category',
    keyOf: (c) => String(c.category || 'other'),
    labelOf: (k) => CATEGORY_LABEL[k] || k,
    rankOf: (k) => { const i = CATEGORY_ORDER.indexOf(k); return i === -1 ? 500 : i; },
    noun: 'category',
  };
}

// The summarised model: one node per group, one aggregated link per ordered
// group pair, external targets aggregated per group and per type.
export function summarizeComponents(data, comps, wanted = 'auto') {
  const grouping = summaryGrouping(data, comps, wanted);
  const groups = new Map();
  const keyOfId = new Map();
  for (const c of comps) {
    const k = grouping.keyOf(c);
    keyOfId.set(String(c.id), k);
    if (!groups.has(k)) {
      groups.set(k, {
        key: k, label: grouping.labelOf(k), componentIds: [], count: 0, tier0: 0,
        stores: 0, notReplicated: 0, outOfScope: 0, internalLinks: 0,
        categories: new Map(), layers: new Map(), mechanisms: new Map(), externals: new Map(),
      });
    }
    const g = groups.get(k);
    g.componentIds.push(String(c.id));
    g.count++;
    if (c.tier === 0) g.tier0++;
    if (DATA_CATEGORIES.includes(c.category || '')) g.stores++;
    if (notReplicated(c)) g.notReplicated++;
    if (c.inRecoveryScope === 'no') g.outOfScope++;
    const cat = c.category || 'other';
    g.categories.set(cat, (g.categories.get(cat) || 0) + 1);
    if (c.restoreLayer) g.layers.set(c.restoreLayer, (g.layers.get(c.restoreLayer) || 0) + 1);
    const mech = c.replication?.mechanism || '';
    if (mech) g.mechanisms.set(mech, (g.mechanisms.get(mech) || 0) + 1);
    for (const oc of c.outboundCalls || []) {
      const t = String(oc.type || 'external');
      const bag = g.externals.get(t) || new Set();
      bag.add(String(oc.target || 'unnamed'));
      g.externals.set(t, bag);
    }
  }
  const pairs = new Map();
  let internal = 0;
  let crossing = 0;
  const have = new Set(comps.map((c) => String(c.id)));
  for (const c of comps) {
    for (const dep of c.dependsOn || []) {
      if (!have.has(String(dep))) continue;
      const a = keyOfId.get(String(c.id));
      const b = keyOfId.get(String(dep));
      if (a === b) { groups.get(a).internalLinks++; internal++; continue; }
      crossing++;
      const k = `${a} ${b}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const ordered = [...groups.values()].sort((x, y) =>
    grouping.rankOf(x.key) - grouping.rankOf(y.key) || y.count - x.count || x.label.localeCompare(y.label));
  const edges = [...pairs.entries()]
    .map(([k, count]) => { const [from, to] = k.split(' '); return { from, to, count }; })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    level: grouping.level, noun: grouping.noun, groups: ordered, edges,
    internalLinks: internal, crossingLinks: crossing, componentCount: comps.length,
  };
}

// "adjudication · 11 components · 3 tier-0 · 4 data stores"
function summaryNodeLabel(g, { stores = true } = {}) {
  const bits = [g.label, plural(g.count, 'component')];
  if (g.tier0) bits.push(`${g.tier0} tier-0`);
  if (stores && g.stores) bits.push(plural(g.stores, 'data store'));
  return bits.join(' · ');
}

// Shared emitter for the group-node flowcharts (architecture / dependencies /
// service map). `externals` adds one aggregated external node per target type.
// Even a summary can have too many arrows (24 services can be joined 500 ways).
// Keep the heaviest links — an arrow standing for 40 dependencies matters more
// than one standing for 1 — and record exactly what was left out.
function capSummaryEdges(sum, budget) {
  const edges = sum.edges;
  if (edges.length <= budget) return { shown: edges, hidden: 0, hiddenLinks: 0 };
  const shown = edges.slice(0, budget);
  const rest = edges.slice(budget);
  return { shown, hidden: rest.length, hiddenLinks: rest.reduce((n, e) => n + e.count, 0) };
}

function emitSummaryFlowchart(sum, { externals = false, direction = 'LR', edgeBudget = MERMAID_MAX_EDGES } = {}) {
  const lines = [`flowchart ${direction}`];
  const classes = newClasses();
  const idOf = new Map();
  sum.groups.forEach((g, i) => {
    const nid = `s${i}`;
    idOf.set(g.key, nid);
    lines.push(`  ${nid}["${sanitizeLabel(summaryNodeLabel(g))}"]`);
    if (g.tier0) classes.get('tier0').push(nid);
  });
  const extCount = externals ? sum.groups.reduce((n, g) => n + g.externals.size, 0) : 0;
  const cap = capSummaryEdges(sum, Math.max(8, edgeBudget - extCount));
  sum.edgeCap = cap;
  for (const e of cap.shown) {
    const a = idOf.get(e.from), b = idOf.get(e.to);
    if (!a || !b) continue;
    lines.push(`  ${a} -->|"${plural(e.count, 'link')}"| ${b}`);
  }
  if (externals) {
    let x = 0;
    for (const g of sum.groups) {
      for (const [type, targets] of [...g.externals.entries()].sort((p, q) => p[0].localeCompare(q[0]))) {
        const xid = `sx${x++}`;
        lines.push(`  ${xid}(["${sanitizeLabel(plural(targets.size, EXT_NOUN[type] || type))}"])`);
        classes.get(EXT_CLASS[type] || 'extinternal').push(xid);
        lines.push(`  ${idOf.get(g.key)} -. "outbound" .-> ${xid}`);
      }
    }
  }
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  return lines;
}

// What every summarised diagram has to say for itself: what was collapsed, how
// much of it, and exactly where the detail lives.
function summaryNotes(sum, { full, detailHints = [] }) {
  const biggest = sum.groups.slice(0, 5).map((g) => `${g.label} (${plural(g.count, 'component')})`).join(', ');
  return [
    `**Summarised — this is not the whole picture.** The full version of this diagram draws ${plural(full.nodes, 'node')} `
      + `and ${plural(full.edges, 'link')} (covering ${plural(sum.componentCount, 'component')}), which `
      + `does not fit in one readable flowchart (the limit is ${MERMAID_MAX_NODES} nodes / ${MERMAID_MAX_EDGES} links — past that even a perfect `
      + `layout crosses itself more than once per link and spans dozens of screens). They are rolled up into `
      + `${plural(sum.groups.length, `${sum.noun}-level node`)}; every arrow carries the number of component-to-component links it stands for.`,
    `**What was rolled up:** ${biggest}${sum.groups.length > 5 ? `, +${sum.groups.length - 5} more` : ''}. `
      + `${plural(sum.internalLinks, 'link')} inside a single ${sum.noun} are not drawn at all; `
      + `${plural(sum.crossingLinks, 'link')} cross ${sum.noun} boundaries and are aggregated into the arrows you can see.`
      + (sum.edgeCap && sum.edgeCap.hidden
        ? ` The ${sum.edgeCap.hidden} lightest aggregated arrows (${plural(sum.edgeCap.hiddenLinks, 'link')} between them) are not drawn either — the heaviest ${sum.edgeCap.shown.length} are.`
        : ''),
    `**Where the detail is** — ${[
      'the **Icon canvas** view draws every node, with filters, focus, search and level-of-detail',
      ...detailHints,
      'add `?detail=full` to this diagram\'s URL (or *Export & source → Download full .mmd*) for the un-summarised Mermaid',
    ].join('; ')}.`,
  ].join('\n\n');
}

function summaryMeta(sum, full, extra = {}) {
  return {
    level: sum.level,
    noun: sum.noun,
    groups: sum.groups.length,
    from: { nodes: full.nodes, edges: full.edges },
    to: { nodes: sum.groups.length + (extra.extraNodes || 0), edges: (sum.edgeCap ? sum.edgeCap.shown.length : sum.edges.length) + (extra.extraEdges || 0) },
    internalLinks: sum.internalLinks,
    crossingLinks: sum.crossingLinks,
    ...(sum.edgeCap && sum.edgeCap.hidden
      ? { hiddenArrows: sum.edgeCap.hidden, hiddenArrowLinks: sum.edgeCap.hiddenLinks } : {}),
    limits: { nodes: MERMAID_MAX_NODES, edges: MERMAID_MAX_EDGES },
    ...extra,
  };
}

function summarizedArchitecture(data, base, full, level) {
  const comps = data?.components || [];
  const sum = summarizeComponents(data, comps, level);
  const withExternals = String(base.id) === 'dependencies';
  const lines = emitSummaryFlowchart(sum, { externals: withExternals });
  const extNodes = withExternals ? sum.groups.reduce((n, g) => n + g.externals.size, 0) : 0;
  const isService = isServiceDiagramId(base.id);
  return {
    ...base,
    mermaid: lines.join('\n'),
    notes: [
      withExternals
        ? `**Dependency graph**, ${sum.noun}-level. Rounded nodes are aggregated outbound targets leaving the inventory.`
        : `**${isService ? 'Service map' : 'Architecture overview'}**, ${sum.noun}-level.`,
      summaryNotes(sum, {
        full,
        detailHints: sum.level === 'service'
          ? ['open a single **Service** diagram from the picker — one service in one environment is legible where everything is not']
          : ['scope the picker to one **environment**, then one **service** — that is what makes this readable'],
      }),
    ].join('\n\n'),
    summarized: summaryMeta(sum, full, { extraNodes: extNodes, extraEdges: extNodes }),
  };
}

function summarizedRestoreLayers(data, base, full, level) {
  const comps = data?.components || [];
  const sum = summarizeComponents(data, comps, level);
  const byLayer = new Map();
  for (const g of sum.groups) {
    for (const [layer, n] of g.layers) {
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer).push({ g, n });
    }
  }
  const unmapped = comps.filter((c) => !c.restoreLayer).length;
  const classes = newClasses();
  const lines = ['flowchart TB'];
  let seq = 0;
  LAYERS.forEach(([layer, label]) => {
    lines.push(`  subgraph ${layer}["${layer} · ${sanitizeLabel(label)}"]`);
    lines.push('    direction LR');
    const members = (byLayer.get(layer) || []).sort((a, b) => b.n - a.n || a.g.label.localeCompare(b.g.label));
    if (!members.length) {
      const gid = `sl${seq++}`;
      lines.push(`    ${gid}["(no components mapped)"]`);
      classes.get('ghost').push(gid);
    }
    for (const m of members) {
      const gid = `sl${seq++}`;
      lines.push(`    ${gid}["${sanitizeLabel(`${m.g.label} · ${plural(m.n, 'component')}`)}"]`);
      if (m.g.tier0) classes.get('tier0').push(gid);
    }
    lines.push('  end');
  });
  for (let i = 0; i < LAYERS.length - 1; i++) lines.push(`  ${LAYERS[i][0]} --> ${LAYERS[i + 1][0]}`);
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  return {
    ...base,
    mermaid: lines.join('\n'),
    notes: [
      `**Restore layer cake**, ${sum.noun}-level: each layer lists the ${sum.noun}s that have components in it, and how many.`,
      unmapped ? `**${plural(unmapped, 'component')}** carry no restore layer at all — they appear in no layer here, and nothing schedules them.` : '',
      summaryNotes(sum, { full, detailHints: ['the **Deployment order** diagrams turn the same data into waves you can execute'] }),
    ].filter(Boolean).join('\n\n'),
    summarized: summaryMeta(sum, full, { unmappedComponents: unmapped }),
  };
}

function summarizedRegionPair(data, base, full, level) {
  const comps = data?.components || [];
  const sum = summarizeComponents(data, comps, level);
  const primary = data?.workspace?.regions?.primary || 'primary';
  const recovery = data?.workspace?.regions?.recovery || 'recovery';
  const classes = newClasses();
  const lines = ['flowchart LR'];
  lines.push(`  subgraph SP["primary ${sanitizeLabel(primary)}"]`);
  lines.push('    direction TB');
  sum.groups.forEach((g, i) => {
    lines.push(`    p${i}["${sanitizeLabel(summaryNodeLabel(g, { stores: false }))}"]`);
    if (g.tier0) classes.get('tier0').push(`p${i}`);
  });
  lines.push('  end');
  lines.push(`  subgraph SR["recovery ${sanitizeLabel(recovery)}"]`);
  lines.push('    direction TB');
  sum.groups.forEach((g, i) => {
    const mirrored = g.count - g.outOfScope;
    lines.push(`    q${i}["${sanitizeLabel(`${g.label} · ${plural(mirrored, 'component')} mirrored`)}"]`);
    if (g.outOfScope) classes.get('notrep').push(`q${i}`);
  });
  lines.push('  end');
  sum.groups.forEach((g, i) => {
    const mech = [...g.mechanisms.entries()].sort((a, b) => b[1] - a[1])[0];
    const label = mech ? `${mech[0]}${g.mechanisms.size > 1 ? ` +${g.mechanisms.size - 1} more` : ''}` : 'no mechanism';
    lines.push(`  p${i} -->|"${sanitizeLabel(label)}"| q${i}`);
  });
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const outOfScope = sum.groups.reduce((n, g) => n + g.outOfScope, 0);
  return {
    ...base,
    mermaid: lines.join('\n'),
    notes: [
      `**Region pair** ${primary} → ${recovery}, ${sum.noun}-level. Each arrow carries the dominant replication mechanism in that ${sum.noun}.`,
      outOfScope
        ? `**${plural(outOfScope, 'component')}** are marked *not in recovery scope*: the recovery side is smaller than the primary side by exactly that much.`
        : 'Every component here has a recovery-side counterpart.',
      summaryNotes(sum, { full, detailHints: ['the **Data replication map** carries per-store mechanism and RPO'] }),
    ].join('\n\n'),
    summarized: summaryMeta(sum, full, { outOfScope }),
  };
}

function summarizedDataReplication(data, base, full, level) {
  const comps = data?.components || [];
  const stores = comps.filter((c) => DATA_CATEGORIES.includes(c.category || ''));
  const sum = summarizeComponents(data, stores, level);
  const primary = data?.workspace?.regions?.primary || 'primary';
  const recovery = data?.workspace?.regions?.recovery || 'recovery';
  const classes = newClasses();
  const lines = ['flowchart LR'];
  lines.push(`  subgraph SP["primary ${sanitizeLabel(primary)}"]`);
  lines.push('    direction TB');
  sum.groups.forEach((g, i) => {
    lines.push(`    p${i}["${sanitizeLabel(`${g.label} · ${plural(g.count, 'store')}${g.notReplicated ? ` · ${g.notReplicated} not replicated` : ''}`)}"]`);
    if (g.notReplicated) classes.get('notrep').push(`p${i}`);
  });
  lines.push('  end');
  lines.push(`  subgraph SR["recovery ${sanitizeLabel(recovery)}"]`);
  lines.push('    direction TB');
  sum.groups.forEach((g, i) => {
    const repl = g.count - g.notReplicated;
    lines.push(`    q${i}["${sanitizeLabel(`${g.label} · ${plural(repl, 'store')} with a copy`)}"]`);
  });
  lines.push('  end');
  sum.groups.forEach((g, i) => {
    const mechs = [...g.mechanisms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([m, n]) => `${m} x${n}`).join(' · ');
    lines.push(`  p${i} -->|"${sanitizeLabel(mechs || 'no mechanism')}"| q${i}`);
  });
  lines.push(...FLOW_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const notRep = sum.groups.reduce((n, g) => n + g.notReplicated, 0);
  return {
    ...base,
    mermaid: lines.join('\n'),
    notes: [
      `**Data replication**, ${sum.noun}-level: ${plural(stores.length, 'data store')} rolled up, arrows labelled with the mechanisms in use and how many stores use each.`,
      notRep
        ? `**${plural(notRep, 'store')} have no replication at all.** A count is not a substitute for reading the list — open the Icon canvas or the un-summarised source and look at every red box.`
        : 'Every store here has a replication mechanism recorded.',
      summaryNotes(sum, { full, detailHints: ['per-store RPO and mechanism live in **Inventory** and in the un-summarised source'] }),
    ].join('\n\n'),
    summarized: summaryMeta(sum, full, { notReplicated: notRep, storeCount: stores.length }),
  };
}

function summarizedResourceMap(data, base, full, level) {
  const comps = data?.components || [];
  const g = normGraph(data?.resourceGraph);
  const rids = Object.keys(g.nodes);
  const sum = summarizeComponents(data, comps, level);
  const keyOfComp = new Map();
  for (const grp of sum.groups) for (const cid of grp.componentIds) keyOfComp.set(cid, grp.key);
  const perGroup = new Map();
  const groupOfRid = new Map();
  let unlinked = 0;
  for (const [rid, n] of Object.entries(g.nodes)) {
    const owner = (Array.isArray(n?.componentIds) ? n.componentIds : []).map(String)
      .find((cid) => keyOfComp.has(cid));
    if (!owner) { unlinked++; continue; }
    const k = keyOfComp.get(owner);
    groupOfRid.set(rid, k);
    if (!perGroup.has(k)) perGroup.set(k, { total: 0, types: new Map() });
    const rec = perGroup.get(k);
    rec.total++;
    const t = String(n?.type || 'other');
    rec.types.set(t, (rec.types.get(t) || 0) + 1);
  }
  const pairs = new Map();
  const groupOf = (v) => groupOfRid.get(v) || keyOfComp.get(String(v)) || null;
  for (const e of g.edges) {
    if (!e) continue;
    const a = groupOf(e.from), b = groupOf(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a} ${b}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  const classes = new Map([['rescmp', []], ['respill', []], ['resunlinked', []]]);
  const lines = ['flowchart LR'];
  const idOf = new Map();
  // This diagram is about resources. A group with none discovered yet says
  // nothing on its own — but it must not silently disappear either, so the
  // empty ones collapse into one node that counts them.
  const withRes = sum.groups.filter((g) => (perGroup.get(g.key)?.total || 0) > 0);
  const withoutRes = sum.groups.filter((g) => (perGroup.get(g.key)?.total || 0) === 0);
  const drawn = withoutRes.length > 3 ? withRes : sum.groups;
  drawn.forEach((grp, i) => {
    const rec = perGroup.get(grp.key) || { total: 0, types: new Map() };
    const top = [...rec.types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
      .map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`).join(' · ');
    const nid = `rs${i}`;
    idOf.set(grp.key, nid);
    lines.push(`  ${nid}["${sanitizeLabel(`${grp.label} · ${plural(grp.count, 'component')} · ${plural(rec.total, 'resource')}${top ? ` (${top})` : ''}`)}"]`);
    classes.get('rescmp').push(nid);
  });
  if (drawn !== sum.groups && withoutRes.length) {
    const comps0 = withoutRes.reduce((n, g) => n + g.count, 0);
    lines.push(`  rsn["${sanitizeLabel(`${plural(withoutRes.length, sum.noun)} with no discovered resources · ${plural(comps0, 'component')}`)}"]`);
    classes.get('resunlinked').push('rsn');
  }
  if (unlinked) {
    lines.push(`  rsu["${sanitizeLabel(`Unlinked · ${plural(unlinked, 'resource')}`)}"]`);
    classes.get('resunlinked').push('rsu');
  }
  const assoc = [...pairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, count]) => { const [from, to] = k.split(' '); return { from, to, count }; });
  sum.edges = assoc;                       // the arrows this picture is about
  const cap = capSummaryEdges(sum, MERMAID_MAX_EDGES - 1);
  sum.edgeCap = cap;
  for (const e of cap.shown) {
    const x = idOf.get(e.from), y = idOf.get(e.to);
    if (!x || !y) continue;
    lines.push(`  ${x} -->|"${plural(e.count, 'association')}"| ${y}`);
  }
  lines.push(...RES_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  return {
    ...base,
    mermaid: lines.join('\n'),
    notes: [
      `**Resource map**, ${sum.noun}-level: ${plural(rids.length, 'discovered AWS resource')} across ${plural(comps.length, 'component')}, rolled up into ${plural(sum.groups.length, sum.noun)} with their dominant resource types. Arrows count the associations that cross a ${sum.noun} boundary.`,
      withoutRes.length > 3
        ? `${plural(withoutRes.length, sum.noun)} have no discovered resources at all and share one box — nothing has been enriched there yet, which is a gap in the inventory rather than an empty ${sum.noun}.`
        : '',
      unlinked ? `**${plural(unlinked, 'resource')}** are linked to no component at all — they belong to nothing in this picture. Use *AI correlate*, or link them by hand.` : '',
      summaryNotes(sum, {
        full,
        detailHints: [
          'open a **per-component resource map** (the picker\'s "Resource map — per component" group) for the 2-hop detail around one component',
          'on the Icon canvas, ⊕ on a component expands exactly its own resources',
        ],
      }),
    ].filter(Boolean).join('\n\n'),
    summarized: summaryMeta(sum, full, { resourceCount: rids.length, unlinkedResources: unlinked }),
  };
}

const SUMMARIZERS = {
  'architecture': summarizedArchitecture,
  'dependencies': summarizedArchitecture,
  'restore-layers': summarizedRestoreLayers,
  'region-pair': summarizedRegionPair,
  'data-replication': summarizedDataReplication,
  'resource-map': summarizedResourceMap,
};

// Can this diagram be summarised at all? (A sequence diagram's meaning IS the
// order of its messages; a per-component or per-service view is already the
// answer to "show me less".)
export function summarizable(id) {
  const key = String(id);
  return !!SUMMARIZERS[key] || isServiceDiagramId(key);
}

/**
 * The scale gate. Generates normally, measures what came out, and — only when
 * the result is past the point where a flowchart can carry meaning — replaces
 * it with a summary that says what it collapsed and where the detail is.
 * `detail: 'full'` opts out and hands back the full source with an `oversize`
 * marker so the reader is still told.
 */
export function applyMermaidBudget(d, data, { detail = 'auto', level = 'auto' } = {}) {
  if (!d || !d.mermaid) return d;
  const full = countMermaidScale(d.mermaid);
  const over = mermaidTooBig(full);
  const id = String(d.id);
  const oversize = over
    ? { ...full, limits: { nodes: MERMAID_MAX_NODES, edges: MERMAID_MAX_EDGES }, summarizable: summarizable(id) }
    : null;
  if (!over || String(detail) === 'full' || !summarizable(id)) {
    return { ...d, scale: full, ...(oversize ? { oversize } : {}) };
  }
  const fn = SUMMARIZERS[id] || (isServiceDiagramId(id) ? summarizedArchitecture : null);
  if (!fn) return { ...d, scale: full, ...(oversize ? { oversize } : {}) };
  // A summary is of THIS diagram, not of the workspace: a service map that
  // shows 172 components must roll up those 172, not all 2,000.
  const own = Array.isArray(d.componentIds) ? new Set(d.componentIds.map(String)) : null;
  const subject = own && own.size && own.size < (data?.components || []).length
    ? { ...data, components: (data.components || []).filter((c) => own.has(String(c.id))) }
    : data;
  let out = null;
  try {
    out = fn(subject, { id: d.id, name: d.name, kind: d.kind, componentIds: d.componentIds }, full, level);
  } catch { out = null; }
  if (!out || !out.mermaid) return { ...d, scale: full, ...(oversize ? { oversize } : {}) };
  const after = countMermaidScale(out.mermaid);
  return {
    ...out,
    scale: after,
    fullMermaid: d.mermaid,
    summarized: { ...(out.summarized || {}), to: after },
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
  // Additive: which diagrams the icon-canvas view can render, and — for the
  // whole-inventory views — roughly how big the picture is, so the page can
  // open a 2,000-component workspace on the canvas instead of on a hairball.
  // The estimate is one cheap pass over the inventory; the exact count comes
  // back with the diagram itself as `scale`.
  const comps = components || [];
  const have = new Set(comps.map((c) => String(c.id)));
  let depEdgeCount = 0;
  let outboundCount = 0;
  for (const c of comps) {
    for (const d of c.dependsOn || []) if (have.has(String(d))) depEdgeCount++;
    outboundCount += (c.outboundCalls || []).length;
  }
  const estimateFor = (id) => {
    if (id === 'architecture' || id === 'restore-layers') return { nodes: comps.length, edges: depEdgeCount };
    if (id === 'dependencies') return { nodes: comps.length + outboundCount, edges: depEdgeCount + outboundCount };
    if (id === 'region-pair') return { nodes: comps.length * 2, edges: comps.length };
    if (id === 'data-replication') {
      const stores = comps.filter((c) => DATA_CATEGORIES.includes(c.category || '')).length;
      return { nodes: stores * 2, edges: stores };
    }
    return null;
  };
  return overview.concat(perComponent).map((d) => {
    const estimate = estimateFor(d.id);
    return {
      ...d,
      canvas: canvasSupported(d.id),
      ...(estimate ? {
        estimate,
        canvasRecommended: mermaidTooBig(estimate),
        summarizes: mermaidTooBig(estimate) && summarizable(d.id),
      } : {}),
    };
  });
}

/**
 * Generate a diagram.
 *
 * `opts` is additive and optional — `generate(id, data)` behaves exactly as it
 * always has for anything that fits in a flowchart:
 *   detail: 'auto' | 'full'   — 'full' never summarises
 *   level:  'auto' | 'service' | 'category'  — how a summary groups
 */
export function generate(id, data, opts = {}) {
  const d = generateRaw(id, data);
  if (!d) return null;
  return applyMermaidBudget(d, data, opts);
}

function generateRaw(id, data) {
  switch (id) {
    case 'architecture': return architecture(data);
    case 'dependencies': return dependencies(data);
    case 'restore-layers': return restoreLayers(data);
    case 'failover-sequence': return failoverSequence(data);
    case 'region-pair': return regionPair(data);
    case 'data-replication': return dataReplication(data);
    default:
      if (id.startsWith('dependencies-')) return componentDependencies(data, id.slice('dependencies-'.length));
      if (isServiceDiagramId(id)) return serviceDiagram(data, serviceIdOfDiagram(id));
      if (isK8sDiagramId(id)) return generateK8s(id, data);
      if (isResourceMapId(id)) return generateResourceMap(id, data);
      // Proposed-solution diagrams, drawn from an uploaded document's extracted
      // model (data.solutionModels — see the SOLUTION DOCUMENTS section below).
      if (isSolutionDiagramId(id)) return generateSolution(id, data);
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

/* =====================================================================
 * PER-DIAGRAM draw.io  (journey report problem 9b)
 * ---------------------------------------------------------------------
 * `architecture`, `dependencies`, `restore-layers`, `region-pair` and
 * `resource-map` used to export the SAME file: the route handed
 * drawioXml() a component subset and drawioXml() only ever draws the
 * architecture view (category swimlanes + dependsOn edges). Five diagrams,
 * one picture, differing only in the `modified=` timestamp — and
 * `resource-map.drawio` carried 13 component boxes while the page
 * advertised 52 resources.
 *
 * The product already has one structured model per diagram: the
 * icon-canvas data (`{nodes, edges, groups, meta}`) that
 * buildCanvasData / buildK8sCanvasData / buildResourceMapCanvasData /
 * buildDeployOrderCanvasData produce, and that the browser canvas renders.
 * So draw.io is rendered from THAT, not from the component list: each
 * diagram's own nodes, its own groups and its own edges.
 *
 * Two deliberate exceptions:
 *   * `architecture` still goes through drawioXml / drawioXmlIcons, so the
 *     shipped docs/examples/architecture.drawio and every existing
 *     "byte-identical" claim about the architecture export hold;
 *   * a diagram with no canvas model is REFUSED with a sentence saying why,
 *     instead of quietly returning a different picture. Today that is
 *     `failover-sequence`, which is a mermaid sequence diagram: draw.io has
 *     no faithful equivalent, and drawing its participants as boxes would
 *     lose the ordering that IS the diagram.
 * ===================================================================*/

// Diagrams that cannot be rendered faithfully in draw.io, and why. The message
// is shown to the user, so it says what to use instead.
export const DRAWIO_UNSUPPORTED = {
  'failover-sequence': 'The failover sequence is a time-ordered sequence diagram — its meaning is the ORDER '
    + 'of the messages, which draw.io\'s box-and-arrow model cannot carry. Rather than hand you a different '
    + 'picture under this name, DR Compass refuses it: use the .mmd (Mermaid) or .svg export for this diagram.',
};

export function drawioSupported(diagramId) {
  return !Object.prototype.hasOwnProperty.call(DRAWIO_UNSUPPORTED, String(diagramId));
}

// Canvas data for any diagram id, whichever builder owns it.
export function canvasForDiagram(diagramId, data) {
  const id = String(diagramId);
  if (isDeployOrderId(id)) return buildDeployOrderCanvasData(id, data);
  if (isK8sDiagramId(id)) return buildK8sCanvasData(id, data);
  if (isResourceMapId(id)) return buildResourceMapCanvasData(id, data);
  if (isSolutionDiagramId(id)) return buildSolutionCanvasData(id, data);
  if (canvasSupported(id)) return buildCanvasData(id, data);
  return null;
}

const NEUTRAL = ['#f5f5f5', '#666666'];
// A group id tells us which palette the lane should use: category groups are
// `cat_<category>`, everything else (restore layers, regions, waves, namespaces,
// per-component resource clusters) gets the neutral lane.
function laneColors(group) {
  const gid = String(group?.id || '');
  if (gid.startsWith('cat_')) return DRAWIO_FILL[gid.slice(4)] || NEUTRAL;
  return NEUTRAL;
}

const nodeColors = (n) => DRAWIO_FILL[n?.category] || NEUTRAL;

// One node box. `aws` swaps the rounded rect for the official mxgraph.aws4
// resource icon when the node's kind maps to one (unknown kinds keep the rect,
// so the file always opens).
function drawioNodeCell(n, { parentId, x, y, w, h, aws }) {
  const label = [n.label, n.sub].filter(Boolean).join(aws ? '\n' : '\n');
  const [fill, stroke] = nodeColors(n);
  const dashed = n.category === 'third-party' || n.kind === 'external' || n.external ? 'dashed=1;' : '';
  const bold = n.tier === 0 ? 'strokeWidth=2;fontStyle=1;' : '';
  const icon = aws ? AWS4_ICON[n.kind] : null;
  if (icon) {
    const [resIcon, iconFill] = icon;
    return `<mxCell id="${escapeXml('n_' + n.id)}" value="${escapeXml(label)}" `
      + `style="sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=${iconFill};strokeColor=none;dashed=0;`
      + `verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;aspect=fixed;`
      + `shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${resIcon};" `
      + `vertex="1" parent="${escapeXml(parentId)}"><mxGeometry x="${x}" y="${y}" width="${h}" height="${h}" as="geometry"/></mxCell>`;
  }
  return `<mxCell id="${escapeXml('n_' + n.id)}" value="${escapeXml(label)}" `
    + `style="rounded=1;whiteSpace=wrap;html=1;fillColor=${n.small ? '#fbfbfb' : '#ffffff'};strokeColor=${stroke};`
    + `${dashed}${bold}fontSize=${n.small ? 10 : 12};" `
    + `vertex="1" parent="${escapeXml(parentId)}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}

const EDGE_STYLE = {
  dependency: 'edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;strokeColor=#6b7a90;endArrow=blockThin;',
  outbound: 'edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;strokeColor=#3f7fb2;dashed=1;endArrow=blockThin;',
  order: 'edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;strokeColor=#9673a6;endArrow=blockThin;',
};

/**
 * Render one canvas model ({nodes, edges, groups, meta}) as diagrams.net
 * mxGraph XML: a swimlane per group, every node inside its group, every edge
 * drawn with its own label. This is what makes each diagram's .drawio its own
 * picture instead of a copy of the architecture view.
 */
export function drawioFromCanvas(canvas, { workspace, diagramId, aws = false } = {}) {
  const nodes = [];
  const seen = new Set();
  for (const n of arr(canvas?.nodes)) {
    const id = String(n?.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ ...n, id });
  }
  const byNodeId = new Map(nodes.map((n) => [n.id, n]));

  // Group membership: a node belongs to the FIRST group that claims it, so a
  // node can never be drawn twice.
  const claimed = new Set();
  const lanes = [];
  for (const g of arr(canvas?.groups)) {
    const ids = arr(g?.nodeIds).map(String).filter((id) => byNodeId.has(id) && !claimed.has(id));
    for (const id of ids) claimed.add(id);
    if (ids.length) lanes.push({ id: String(g.id || `grp_${lanes.length}`), label: String(g.label || ''), ids });
  }
  const loose = nodes.filter((n) => !claimed.has(n.id)).map((n) => n.id);
  if (loose.length) lanes.push({ id: 'grp_ungrouped', label: 'Not grouped', ids: loose });

  const GAP = 12, TITLE = 30, LANE_GAP_X = 44, LANE_GAP_Y = 44, X0 = 40, Y0 = 40, MAX_ROW_W = 2600;
  const cells = [];
  let x = X0, y = Y0, rowH = 0;
  for (const lane of lanes) {
    const members = lane.ids.map((id) => byNodeId.get(id));
    const cw = Math.max(...members.map((n) => (n.small ? 150 : 200)));
    const ch = Math.max(...members.map((n) => (n.small ? 34 : 46)));
    const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(members.length))));
    const rows = Math.ceil(members.length / cols);
    const laneW = cols * (cw + GAP) + GAP;
    const laneH = TITLE + rows * (ch + GAP) + GAP;
    if (x > X0 && x + laneW > MAX_ROW_W) { x = X0; y += rowH + LANE_GAP_Y; rowH = 0; }
    const [fill, stroke] = laneColors(lane);
    cells.push(
      `<mxCell id="${escapeXml(lane.id)}" value="${escapeXml(lane.label)}" `
      + `style="swimlane;rounded=1;startSize=${TITLE};horizontal=1;fillColor=${aws ? 'none' : fill};`
      + `strokeColor=${stroke};fontStyle=1;fontSize=13;" `
      + `vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${laneW}" height="${laneH}" as="geometry"/></mxCell>`);
    members.forEach((n, i) => {
      cells.push(drawioNodeCell(n, {
        parentId: lane.id,
        x: GAP + (i % cols) * (cw + GAP),
        y: TITLE + GAP + Math.floor(i / cols) * (ch + GAP),
        w: cw, h: ch, aws,
      }));
    });
    x += laneW + LANE_GAP_X;
    rowH = Math.max(rowH, laneH);
  }

  let e = 0;
  for (const edge of arr(canvas?.edges)) {
    const from = String(edge?.from ?? ''), to = String(edge?.to ?? '');
    if (!byNodeId.has(from) || !byNodeId.has(to)) continue;
    const style = EDGE_STYLE[edge.kind] || EDGE_STYLE.dependency;
    const label = truncate(String(edge.label ?? ''), 40);
    cells.push(
      `<mxCell id="e${e++}" value="${escapeXml(label)}" style="${style}" `
      + `edge="1" parent="1" source="${escapeXml('n_' + from)}" target="${escapeXml('n_' + to)}">`
      + `<mxGeometry relative="1" as="geometry"/></mxCell>`);
  }

  const id = String(diagramId || canvas?.meta?.diagramId || 'diagram');
  const title = String(canvas?.meta?.name || id);
  const name = escapeXml(`${workspace?.name || 'DR Compass'} — ${title}${aws ? ' (AWS icons)' : ''}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<mxfile host="drcompass" modified="${escapeXml(new Date().toISOString())}" agent="DR Compass" version="21.6.5" type="device">\n`
    + `  <diagram id="${escapeXml(id)}${aws ? '-aws' : ''}" name="${name}">\n`
    + `    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">\n`
    + `      <root>\n`
    + `        <mxCell id="0"/>\n`
    + `        <mxCell id="1" parent="0"/>\n`
    + cells.map((c) => `        ${c}`).join('\n') + '\n'
    + `      </root>\n`
    + `    </mxGraphModel>\n`
    + `  </diagram>\n`
    + `</mxfile>\n`;
}

/**
 * The one entry point the route uses. Returns
 *   { ok: true, xml }                      — this diagram's own picture, or
 *   { ok: false, status, message }         — a refusal that says why.
 *
 * `data` is the route's loaded bag ({workspace, components, runbooks,
 * k8sSnapshot, resourceGraph} and, for deployment-order ids, deployOrder).
 */
export function drawioForDiagram(diagramId, data, { aws = false } = {}) {
  const id = String(diagramId);
  const workspace = data?.workspace;

  if (!drawioSupported(id)) {
    return { ok: false, status: 409, message: DRAWIO_UNSUPPORTED[id] };
  }

  // The architecture view keeps its original renderer, byte for byte.
  if (id === 'architecture') {
    const components = data?.components || [];
    return {
      ok: true,
      xml: aws
        ? drawioXmlIcons({ workspace, components, diagramId: 'architecture' })
        : drawioXml({ workspace, components }),
    };
  }

  const canvas = canvasForDiagram(id, data);
  if (!canvas || !arr(canvas.nodes).length) {
    return {
      ok: false,
      status: 404,
      message: `Diagram '${id}' has nothing to draw in draw.io — it has no structured node/edge model in this `
        + 'workspace (the snapshot, resource graph or deployment order it is built from is missing or empty). '
        + 'Rather than export a different diagram under this name, DR Compass refuses it.',
    };
  }
  return { ok: true, xml: drawioFromCanvas(canvas, { workspace, diagramId: id, aws }) };
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

// ---------------------------------------------------------------- deployment order
// Diagrams generated from the DEPLOYMENT / RECOVERY ORDER computed by
// server/lib/deploy-order.js. This module never imports that engine: the route
// hands the already-computed order in as `data.deployOrder`, so everything here
// keeps working (by returning null / an empty list) when the engine is absent.
//
// Engine contract consumed here (see INTEGRATION-NOTES.md, "deployment order"):
//   { waves:[{index, name, layer, categories:[{category, items:[{id,name,kind,
//       category,tier,tierName,layer,waitsFor:[{id,name,why}],provenance,notes}]}],
//       parallelizable, estMinutes}],
//     categoryOrder:[{category, firstWave, rationale}],
//     cycles:[{nodes, suggestedBreak, why}], unordered:[], stats:{}, generatedAt }
// Every field is treated as optional and shape-checked before use.

export function hasDeployOrder(order) {
  return !!(order && typeof order === 'object' && Array.isArray(order.waves) && order.waves.length);
}

export const DEPLOY_ORDER_ID = 'deploy-order';
const DEPLOY_ORDER_PREFIX = 'deploy-order-';
const STARTUP_PREFIX = 'startup-dependencies-';

export function isDeployOrderId(id) {
  const s = String(id ?? '');
  return s === DEPLOY_ORDER_ID || s.startsWith(DEPLOY_ORDER_PREFIX) || s.startsWith(STARTUP_PREFIX);
}

/**
 * What a deploy-order diagram id refers to.
 *   'deploy-order'                     -> { kind:'order',   componentId:'' }
 *   'deploy-order-cmp_x'               -> { kind:'order',   componentId:'cmp_x' }
 *   'startup-dependencies-cmp_x'       -> { kind:'startup', componentId:'cmp_x' }
 * Anything else -> null.
 */
export function deployOrderScope(id) {
  const s = String(id ?? '');
  if (s === DEPLOY_ORDER_ID) return { kind: 'order', componentId: '' };
  if (s.startsWith(DEPLOY_ORDER_PREFIX)) {
    const cid = s.slice(DEPLOY_ORDER_PREFIX.length);
    return cid ? { kind: 'order', componentId: cid } : null;
  }
  if (s.startsWith(STARTUP_PREFIX)) {
    const cid = s.slice(STARTUP_PREFIX.length);
    return cid ? { kind: 'startup', componentId: cid } : null;
  }
  return null;
}

const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

// ---- normalization -------------------------------------------------------
// One tolerant read of the engine's payload. Items are flattened out of their
// category buckets (keeping the bucket's category when the item omits one),
// de-duplicated by id across the whole order, and sorted inside a wave by
// category rank then name so the output is byte-stable for a given input.

// The engine writes operator-readable notes as an array; older/simpler shapes
// use a plain string. Either way we want one line.
const noteText = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String).join(' · ') : String(v ?? ''));

function normDeployItem(raw, fallbackCategory) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
  if (!id) return null;
  const waitsFor = (Array.isArray(raw.waitsFor) ? raw.waitsFor : [])
    .map((w) => {
      if (!w) return null;
      if (typeof w === 'string') return { id: w, name: w, why: '', requires: '' };
      const wid = w.id === undefined || w.id === null ? '' : String(w.id);
      if (!wid) return null;
      return {
        id: wid, name: String(w.name || wid), why: String(w.why || ''),
        requires: String(w.requires || ''), binding: w.binding === true,
      };
    })
    .filter(Boolean);
  return {
    id,
    name: String(raw.name || id),
    kind: String(raw.kind || ''),
    category: String(raw.category || fallbackCategory || 'other'),
    tier: numOrNull(raw.tier),
    tierName: String(raw.tierName || ''),
    layer: String(raw.layer || ''),
    waitsFor,
    provenance: String(raw.provenance || ''),
    notes: noteText(raw.notes),
    // Contract extras: what the item really is, and which inventory component it
    // belongs to (a k8s object / resource-graph node carries its owner here, and
    // that is what resolves an icon for it).
    componentId: String(raw.componentId || ''),
    source: String(raw.source || ''),
    action: String(raw.action || ''),
    readinessGate: raw.readinessGate === true,
    inCycle: raw.inCycle === true,
    reason: String(raw.reason || ''),
    verify: String(raw.verify || ''),
  };
}

// A wave name from the engine already reads "Wave 3 · Data stores" — strip that
// prefix so labels never say "Wave 3 · Wave 3 · Data stores".
function bareWaveName(name, index) {
  const s = String(name ?? '').trim();
  const stripped = s.replace(/^wave\s*\d+\s*(?:[·:•\-–—]\s*)?/i, '').trim();
  return stripped || s || `Wave ${index}`;
}

// suggestedBreak is an EDGE ({from,to,why}) in the published contract; older
// drafts passed a node. Normalize both into ids + something readable.
function normBreak(b) {
  if (!b) return null;
  if (typeof b === 'string') return { from: b, to: '', text: b };
  if (typeof b !== 'object') return null;
  const from = String(b.from ?? b.id ?? '');
  const to = String(b.to ?? '');
  const text = from && to ? `${from} → ${to}` : (from || to || '');
  return text ? { from, to, text, why: String(b.why || '') } : null;
}

export function normDeployOrder(order) {
  const waves = [];
  const seen = new Set();
  const rawWaves = Array.isArray(order?.waves) ? order.waves : [];
  rawWaves.forEach((w, i) => {
    if (!w || typeof w !== 'object') return;
    const items = [];
    const push = (raw, cat) => {
      const it = normDeployItem(raw, cat);
      if (!it || seen.has(it.id)) return;
      seen.add(it.id);
      items.push(it);
    };
    for (const bucket of (Array.isArray(w.categories) ? w.categories : [])) {
      if (!bucket || typeof bucket !== 'object') continue;
      for (const raw of (Array.isArray(bucket.items) ? bucket.items : [])) push(raw, bucket.category);
    }
    // Tolerated shape: a wave that carries its items directly.
    for (const raw of (Array.isArray(w.items) ? w.items : [])) push(raw, '');
    items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      || String(a.category).localeCompare(String(b.category))
      || String(a.name).localeCompare(String(b.name))
      || a.id.localeCompare(b.id));
    const idx = Number.isFinite(Number(w.index)) ? Number(w.index) : i + 1;
    waves.push({
      index: idx,
      name: bareWaveName(w.name, idx),
      layer: String(w.layer || ''),
      layerLabel: String(w.layerLabel || ''),
      needsReview: w.needsReview === true,
      parallelizable: w.parallelizable !== false,
      estMinutes: numOrNull(w.estMinutes),
      items,
    });
  });
  const cycles = (Array.isArray(order?.cycles) ? order.cycles : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      nodes: (Array.isArray(c.nodes) ? c.nodes : []).map((n) => (n && typeof n === 'object' ? String(n.id ?? n.name ?? '') : String(n))).filter(Boolean),
      names: (Array.isArray(c.nodes) ? c.nodes : []).map((n) => (n && typeof n === 'object' ? String(n.name ?? n.id ?? '') : String(n))).filter(Boolean),
      suggestedBreak: normBreak(c.suggestedBreak),
      why: String(c.why || ''),
    }));
  const unordered = (Array.isArray(order?.unordered) ? order.unordered : [])
    .map((u) => normDeployItem(typeof u === 'string' ? { id: u, name: u } : u, ''))
    .filter(Boolean);
  const categoryOrder = (Array.isArray(order?.categoryOrder) ? order.categoryOrder : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      category: String(c.category || 'other'),
      label: String(c.label || ''),
      firstWave: numOrNull(c.firstWave),
      rationale: String(c.rationale || ''),
    }));
  return {
    waves, cycles, unordered, categoryOrder,
    stats: order && typeof order.stats === 'object' && order.stats ? order.stats : {},
    engineNotes: (Array.isArray(order?.notes) ? order.notes : []).map(String).filter(Boolean),
    callIssues: (Array.isArray(order?.callOrderIssues) ? order.callOrderIssues : []).filter((x) => x && typeof x === 'object'),
    generatedAt: order?.generatedAt ? String(order.generatedAt) : '',
  };
}

const deployItems = (o) => o.waves.flatMap((w) => w.items);

/** "Wave 3 · Data stores · 6 resources · can run in parallel" */
export function deployWaveLabel(w) {
  const n = w.items.length;
  return [
    `Wave ${w.index}`,
    w.name,
    `${n} resource${n === 1 ? '' : 's'}`,
    w.parallelizable && n > 1 ? 'can run in parallel' : (n > 1 ? 'run in order' : null),
  ].filter(Boolean).join(' · ');
}

// Everything in the order that belongs to one inventory component: the
// component's own item plus the k8s objects / AWS resources attributed to it.
function itemsOfComponent(all, componentId) {
  return all.filter((it) => it.id === componentId || it.componentId === componentId);
}

/**
 * Narrow a workspace-wide order to one component's closure: the component plus
 * everything it (transitively) waits for, plus anything waiting on it. Pure —
 * used when the engine cannot scope the order itself.
 */
export function scopeDeployOrder(order, componentId) {
  const o = normDeployOrder(order);
  const all = deployItems(o);
  const byItemId = new Map(all.map((it) => [it.id, it]));
  const seeds = itemsOfComponent(all, componentId);
  if (!seeds.length) return null;
  const keep = new Set(seeds.map((it) => it.id));
  for (const s of seeds) {
    for (const w of s.waitsFor) if (byItemId.has(w.id)) keep.add(w.id);
  }
  const walk = (id) => {
    for (const w of byItemId.get(id)?.waitsFor || []) {
      if (byItemId.has(w.id) && !keep.has(w.id)) { keep.add(w.id); walk(w.id); }
    }
  };
  for (const s of seeds) walk(s.id);
  const seedIds = new Set(seeds.map((it) => it.id));
  for (const it of all) if ((it.waitsFor || []).some((w) => seedIds.has(w.id))) keep.add(it.id);
  const waves = o.waves
    .map((w) => ({ ...w, items: w.items.filter((it) => keep.has(it.id)) }))
    .filter((w) => w.items.length);
  if (!waves.length) return null;
  return {
    ...o, waves,
    unordered: o.unordered.filter((it) => keep.has(it.id)),
    cycles: o.cycles.filter((c) => c.nodes.some((n) => keep.has(n))),
  };
}

// ---- listing -------------------------------------------------------------

/**
 * List entries — only when a deployment order actually exists. Per-component
 * entries only for components that appear in the order (deploy-order-<id>) or
 * that have something to say about pod startup (startup-dependencies-<id>).
 */
export function listDeployOrderDiagrams(data) {
  const order = data?.deployOrder;
  if (!hasDeployOrder(order)) return [];
  const o = normDeployOrder(order);
  const comps = data?.components || [];
  const items = deployItems(o);
  // A component counts as "in the order" when its own item is there, or when a
  // k8s object / AWS resource in the order is attributed to it.
  const inOrder = new Set(items.flatMap((it) => [it.id, it.componentId].filter(Boolean)));
  const waveCount = o.waves.length;
  const out = [{
    id: DEPLOY_ORDER_ID,
    name: 'Deployment order — waves',
    kind: 'deploy-order', section: 'Deployment order', canvas: true,
    description: `${waveCount} wave${waveCount === 1 ? '' : 's'} · ${items.length} resource${items.length === 1 ? '' : 's'}`
      + (o.cycles.length ? ` · ${o.cycles.length} cycle${o.cycles.length === 1 ? '' : 's'} to break` : '')
      + (o.unordered.length ? ` · ${o.unordered.length} unordered` : ''),
  }];
  for (const c of comps) {
    if (!inOrder.has(c.id)) continue;
    const scoped = scopeDeployOrder(order, c.id);
    const n = scoped ? deployItems(scoped).length : 0;
    out.push({
      id: `${DEPLOY_ORDER_PREFIX}${c.id}`,
      name: `${c.name} — deployment order`,
      kind: 'component', section: 'Deployment order', canvas: true,
      description: `${n} resource${n === 1 ? '' : 's'} in its closure · ${scoped ? scoped.waves.length : 0} wave${scoped && scoped.waves.length === 1 ? '' : 's'}`,
    });
  }
  for (const c of comps) {
    const f = startupFacts(data, c.id);
    if (!f || (!f.mounts.length && !f.calls.length)) continue;
    out.push({
      id: `${STARTUP_PREFIX}${c.id}`,
      name: `${c.name} — startup dependencies`,
      kind: 'component', section: 'Deployment order', canvas: true,
      description: `${f.mounts.length} mounted/pulled · ${f.calls.length} called at startup`
        + (f.externalCount ? ` · ${f.externalCount} external precondition${f.externalCount === 1 ? '' : 's'}` : ''),
    });
  }
  return out;
}

// ---- the order, as a picture --------------------------------------------

function deployOrderNode(it, comp, wave) {
  const waits = it.waitsFor.length;
  return {
    id: it.id,
    label: it.name,
    sub: [
      it.kind || comp?.kind || '',
      it.action && it.action !== 'deploy' ? it.action : '',
      waits ? `waits for ${waits}` : 'no prerequisites',
    ].filter(Boolean).join(' · '),
    kind: it.kind || comp?.kind || '',
    category: it.category || comp?.category || 'other',
    awsServices: comp?.awsServices || [],
    tier: it.tier !== null ? it.tier : (typeof comp?.tier === 'number' ? comp.tier : null),
    layer: it.layer || comp?.restoreLayer || '',
    wave: wave.index,
    waveName: wave.name,
    provenance: it.provenance || '',
    notes: it.notes || '',
  };
}

const preNodeId = (id) => `pre_${slugify(id)}`;

// The engine's `why` often opens with the waiting item's own name ("acme-irsa
// attaches policy X"). On an edge that subject is already the arrow's tail, so
// dropping it leaves room for the part that carries the meaning.
function whyText(why, subjectName) {
  let t = String(why ?? '').trim();
  const s = String(subjectName ?? '').trim();
  if (s && t.toLowerCase().startsWith(`${s.toLowerCase()} `)) t = t.slice(s.length + 1).trim();
  return t || 'must exist first';
}

function unknownPrereqNode(w) {
  return {
    id: preNodeId(w.id),
    label: w.name || w.id,
    sub: 'outside the order — verify, cannot deploy',
    kind: 'external',
    category: 'third-party',
    awsServices: [], tier: null, layer: '',
  };
}

/** Canvas data for 'deploy-order' / 'deploy-order-<componentId>'. */
export function buildDeployOrderCanvas(data, componentId = '') {
  const raw = componentId ? scopeDeployOrder(data?.deployOrder, componentId) : data?.deployOrder;
  if (!hasDeployOrder(raw)) return null;
  const o = componentId ? raw : normDeployOrder(raw);
  const comps = data?.components || [];
  const cmap = byId(comps);
  const focus = componentId ? cmap.get(componentId) : null;
  if (componentId && !focus) return null;

  const nodes = [];
  const groups = [];
  const present = new Set();
  for (const w of o.waves) {
    const ids = [];
    for (const it of w.items) {
      nodes.push(deployOrderNode(it, cmap.get(it.componentId || it.id), w));
      present.add(it.id);
      ids.push(it.id);
    }
    if (ids.length) groups.push({ id: `wave_${w.index}`, label: deployWaveLabel(w), nodeIds: ids });
  }
  // Unordered items are shown, never hidden — they are the honest part.
  if (o.unordered.length) {
    const ids = [];
    for (const it of o.unordered) {
      if (present.has(it.id)) continue;
      nodes.push({ ...deployOrderNode(it, cmap.get(it.componentId || it.id), { index: 0, name: 'not ordered' }), sub: (it.reason || 'not ordered yet') + ' — needs a decision' });
      present.add(it.id);
      ids.push(it.id);
    }
    if (ids.length) groups.push({ id: 'wave_unordered', label: `Not ordered yet · ${ids.length} item${ids.length === 1 ? '' : 's'} · needs a decision`, nodeIds: ids });
  }
  // Prerequisites the order does not contain become explicit external nodes, so
  // every edge in the picture resolves to something you can see.
  const extIds = [];
  const edges = [];
  for (const it of deployItems(o).concat(o.unordered)) {
    for (const w of it.waitsFor) {
      let to = w.id;
      if (!present.has(to)) {
        to = preNodeId(w.id);
        if (!present.has(to)) {
          nodes.push(unknownPrereqNode(w));
          present.add(to);
          extIds.push(to);
        }
      }
      edges.push({
        from: it.id, to,
        kind: extIds.includes(to) ? 'outbound' : 'dependency',
        label: truncate(whyText(w.why, it.name), 64),
      });
    }
  }
  if (extIds.length) groups.push({ id: 'wave_external', label: `External preconditions · ${extIds.length} · verify, cannot be deployed`, nodeIds: extIds });

  const name = componentId ? `Deployment order — ${focus.name}` : 'Deployment order — waves';
  return {
    nodes, edges, groups,
    meta: {
      diagramId: componentId ? `${DEPLOY_ORDER_PREFIX}${componentId}` : DEPLOY_ORDER_ID,
      name,
      regions: data?.workspace?.regions || {},
      waves: o.waves.length,
      note: deployOrderNote(o),
      engineNotes: o.engineNotes.slice(0, 3),
      // The wave bands read as ordered rows under the 'layer-rows' template.
      suggestedTemplate: 'layer-rows',
    },
  };
}

function deployOrderNote(o) {
  const parts = [`${o.waves.length} wave${o.waves.length === 1 ? '' : 's'} — everything inside one wave can be deployed at the same time; arrows are the real prerequisites, not the wave boundaries.`];
  if (o.cycles.length) parts.push(`${o.cycles.length} dependency cycle${o.cycles.length === 1 ? '' : 's'} could not be ordered — see the Deployment order page.`);
  if (o.unordered.length) parts.push(`${o.unordered.length} item${o.unordered.length === 1 ? '' : 's'} could not be placed in a wave.`);
  if (o.callIssues.length) parts.push(`${o.callIssues.length} startup call${o.callIssues.length === 1 ? '' : 's'} could not be made safe by ordering alone.`);
  return parts.join(' ');
}

const DEPLOY_CAT_COLOR = {
  'compute': '#e8873c', 'database': '#4f8ff7', 'storage': '#3fb27f',
  'networking': '#9d7bf5', 'messaging-streaming': '#e2a336',
  'security-secrets': '#e2564f', 'edge-dns': '#58c1d4',
  'identity-access': '#d46bb8', 'observability': '#7ec97e',
  'cicd-control-plane': '#8a94a6', 'third-party': '#8a94a6', 'other': '#8a94a6',
};
const deployCatClass = (cat) => `dcat${String(cat || 'other').replace(/[^a-z0-9]/gi, '')}`;
// Same colour language as the icon canvas, so a category reads the same in both.
const DEPLOY_CLASSDEFS = Object.entries(DEPLOY_CAT_COLOR)
  .map(([cat, color]) => `classDef ${deployCatClass(cat)} stroke:${color},stroke-width:2px`)
  .concat([
    'classDef dwaitext fill:#3a2f22,stroke:#e2a336,stroke-dasharray:6 3,color:#e2a336',
    'classDef dunordered fill:#3a2224,stroke:#e2564f,color:#f2938e',
  ]);

/** Mermaid for 'deploy-order' / 'deploy-order-<componentId>'. */
export function deployOrderMermaid(data, componentId = '') {
  const canvas = buildDeployOrderCanvas(data, componentId);
  if (!canvas) return null;
  const o = componentId ? scopeDeployOrder(data.deployOrder, componentId) : normDeployOrder(data.deployOrder);
  const nodeById = new Map(canvas.nodes.map((n) => [String(n.id), n]));
  const mid = new Map();
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `d${seq++}`); return mid.get(id); };
  const classes = new Map();
  const addClass = (name, id) => {
    if (!classes.has(name)) classes.set(name, []);
    classes.get(name).push(id);
  };
  const lines = ['flowchart TB'];
  canvas.groups.forEach((grp, gi) => {
    const ids = grp.nodeIds.filter((id) => nodeById.has(String(id)));
    if (!ids.length) return;
    lines.push(`  subgraph dw${gi}["${sanitizeLabel(grp.label)}"]`);
    lines.push('    direction LR');
    for (const id of ids) {
      const n = nodeById.get(String(id));
      const m = nid(String(id));
      lines.push(`    ${m}["${sanitizeLabel(truncate(`${n.label}${n.kind ? ' · ' + n.kind : ''}`, 52))}"]`);
      if (grp.id === 'wave_external') addClass('dwaitext', m);
      else if (grp.id === 'wave_unordered') addClass('dunordered', m);
      else addClass(deployCatClass(n.category), m);
    }
    lines.push('  end');
  });
  for (const e of canvas.edges) {
    const a = mid.get(String(e.from)), b = mid.get(String(e.to));
    if (!a || !b) continue;
    const why = sanitizeLabel(e.label || '');
    lines.push(why && why !== 'unnamed' ? `  ${a} -->|"${why}"| ${b}` : `  ${a} --> ${b}`);
  }
  lines.push(...DEPLOY_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));

  const catLine = o.categoryOrder.length
    ? o.categoryOrder.map((c) => CATEGORY_LABEL[c.category] || c.category).join(' → ')
    : '';
  const notes = [
    '**Deployment order** — the order everything has to come up in for a full service. Each band is a wave: everything inside a wave can be deployed at the same time; an arrow is a real prerequisite ("this waits for that, because…"), so the bands carry the sequence and the arrows carry the reason.',
    catLine ? `Category order: ${catLine}.` : '',
    o.cycles.length
      ? `⚠ ${o.cycles.length} dependency cycle${o.cycles.length === 1 ? '' : 's'}: ${o.cycles.slice(0, 3).map((c) => (c.names.length ? c.names.join(' → ') : c.nodes.join(' → '))).join('; ')}. Break one edge (the Deployment order page suggests which) before trusting this order.`
      : '',
    o.unordered.length ? `⚠ ${o.unordered.length} item${o.unordered.length === 1 ? '' : 's'} could not be placed in a wave — they are shown in their own band.` : '',
    o.callIssues.length ? `⚠ ${o.callIssues.length} startup call${o.callIssues.length === 1 ? '' : 's'} the order could not make safe (a pod that would start before something it calls) — the Deployment order page lists each one.` : '',
    'Amber dashed = a prerequisite outside this order: you verify it, you cannot deploy it.',
    ...o.engineNotes.slice(0, 2),
  ].filter(Boolean);

  const cmpIds = canvas.nodes
    .filter((n) => (data.components || []).some((c) => c.id === n.id))
    .map((n) => String(n.id));
  return {
    id: canvas.meta.diagramId,
    name: canvas.meta.name,
    kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: notes.join('\n\n'),
    componentIds: cmpIds,
  };
}

// ---- pod startup: what it mounts vs what it calls ------------------------
// The picture the owner asked for: "before pods come up — pods are making
// outbound calls and mounting things, those need to be up and ready
// beforehand." Left side = must exist and be mounted/pulled first. Right side =
// what the workload calls the moment it boots. External preconditions are
// marked distinctly because they cannot be deployed, only verified.

const MOUNT_CATEGORIES = new Set(['security-secrets', 'identity-access']);
const VOLUME_RE = /pvc|persistentvolume|volume|efs|ebs|filesystem|file-system|disk/i;
const REGISTRY_RE = /registry|ecr|image|artifact/i;

function startupWhy(cat, kind, name) {
  const k = `${kind || ''} ${name || ''}`;
  if (cat === 'security-secrets') return ['mount', 'reads at startup'];
  if (cat === 'identity-access') return ['mount', 'assumes this role at startup'];
  if (cat === 'storage') return VOLUME_RE.test(k) ? ['mount', 'mounts at startup'] : ['call', 'reads objects at startup'];
  if (cat === 'cicd-control-plane') return REGISTRY_RE.test(k) ? ['mount', 'pulls images'] : ['call', 'must be reachable at startup'];
  if (cat === 'networking') return ['mount', 'must exist before the pod is scheduled'];
  if (cat === 'database') return ['call', 'opens connection on boot'];
  if (cat === 'messaging-streaming') return ['call', 'connects on boot'];
  if (cat === 'edge-dns') return ['call', 'must resolve at startup'];
  if (cat === 'third-party') return ['call', 'partner allowlist required'];
  if (cat === 'compute') return ['call', 'calls at startup'];
  return ['call', 'must be up first'];
}

const EXTERNAL_OUTBOUND = new Set(['third-party', 'saas', 'on-prem']);

// The engine writes `why` for an operator ("reads secret … at startup", "pulls
// images from this registry", "waits for … pods to be Ready"). That wording is
// the best signal for which side of the picture a prerequisite belongs on, so it
// wins over the category rule.
// Strong signals first: "must exist / must be Ready / schedulable / admission
// webhook / mounts / pulls / reads / assumes" put a prerequisite on the left
// (it has to be up before the pod starts); "calls / connects / resolves /
// allowlist / publishes / consumes" put it on the right. Anything else falls
// through to the category rule.
const WHY_MOUNT_RE = /must (?:already )?(?:exist|be ready)|schedulable|capacity|admission webhook|mounts?\b|pull|reads?\b|assumes|attaches|encrypt|namespace .* must/i;
const WHY_CALL_RE = /calls?\b|connect|reach|resolves?\b|allowlist|whitelist|query|publish|consume/i;
function sideFromWhy(why) {
  const s = String(why || '');
  if (!s) return '';
  if (WHY_MOUNT_RE.test(s)) return 'mount';
  if (WHY_CALL_RE.test(s)) return 'call';
  return '';
}

/**
 * Pure classification of one component's startup preconditions, from the
 * deployment order (waitsFor + why), the inventory (dependsOn, secrets,
 * outboundCalls) and the k8s snapshot (configmaps, secrets, PVCs, service
 * account, images). Deterministic: everything is sorted before it is returned.
 */
export function startupFacts(data, componentId) {
  const comps = data?.components || [];
  const cmap = byId(comps);
  const focus = cmap.get(componentId);
  if (!focus) return null;
  const snap = data?.k8sSnapshot;
  const order = hasDeployOrder(data?.deployOrder) ? normDeployOrder(data.deployOrder) : null;
  const orderItem = order ? deployItems(order).find((it) => it.id === componentId) : null;

  const mounts = new Map();
  const calls = new Map();
  // First writer wins, by id AND by label: the same secret can arrive from the
  // order (k8s:ns/Secret/name), the snapshot (sec:ns/name) and the inventory
  // (sec:name) — the operator should see it once.
  const seenLabels = new Set();
  // "adjudication-config" and "adjudication-config (adjudication-service)" are
  // the same ConfigMap seen from two sources.
  const labelKey = (l) => String(l || '').replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  const add = (side, node) => {
    const bag = side === 'mount' ? mounts : calls;
    const lkey = labelKey(node.label);
    if (bag.has(node.id)) {
      if (!bag.get(node.id).why && node.why) bag.set(node.id, node);
      return;
    }
    if (lkey && seenLabels.has(lkey)) return;
    if (lkey) seenLabels.add(lkey);
    bag.set(node.id, node);
  };
  const fromComponent = (c, why) => {
    const [side, defWhy] = startupWhy(c.category || 'other', c.kind, c.name);
    add(side, {
      id: c.id, label: c.name, sub: c.kind || CATEGORY_LABEL[c.category] || 'component',
      kind: c.kind || '', category: c.category || 'other', awsServices: c.awsServices || [],
      tier: typeof c.tier === 'number' ? c.tier : null, layer: c.restoreLayer || '',
      why: why || defWhy, external: false,
    });
  };

  // 1. The deployment order's prerequisites, with the engine's own wording — for
  // the component itself AND for every k8s object / AWS resource attributed to
  // it, which is where the real pod-startup detail lives.
  const allItems = order ? deployItems(order) : [];
  const itemById = new Map(allItems.map((it) => [it.id, it]));
  const mine = order ? itemsOfComponent(allItems, componentId) : [];
  const mineIds = new Set(mine.map((it) => it.id));
  for (const src of mine) {
    for (const w of src.waitsFor) {
      if (mineIds.has(w.id)) continue; // one of its own parts, not a dependency
      const target = itemById.get(w.id);
      const c = cmap.get(target?.componentId || w.id);
      const category = target?.category || c?.category || 'other';
      const kind = target?.kind || c?.kind || '';
      const name = target?.name || w.name || w.id;
      const external = (target && (target.source === 'external' || /external/.test(target.kind)))
        || (!target && !c);
      const [catSide, defWhy] = startupWhy(category, kind, name);
      const side = sideFromWhy(w.why) || catSide;
      add(side, {
        id: w.id, label: name,
        sub: external ? (kind || 'outside the inventory — verify') : (kind || CATEGORY_LABEL[category] || 'prerequisite'),
        kind: kind || (external ? 'external' : ''),
        category: external ? 'third-party' : category,
        awsServices: c?.awsServices || [],
        tier: target?.tier ?? (typeof c?.tier === 'number' ? c.tier : null),
        layer: target?.layer || c?.restoreLayer || '',
        why: w.why || defWhy, external: !!external,
      });
    }
  }
  // 2. Declared dependencies.
  for (const dep of focus.dependsOn || []) {
    const c = cmap.get(dep);
    if (c) fromComponent(c, '');
  }
  // 3. Secrets recorded on the component itself.
  for (const s of focus.secrets || []) {
    const nm = typeof s === 'string' ? s : String(s?.name || '');
    if (!nm) continue;
    add('mount', {
      id: `sec:${nm}`, label: nm, sub: 'secret', kind: 'k8s-secret', category: 'security-secrets',
      awsServices: [], tier: null, layer: '',
      why: (typeof s === 'object' && s?.replicated === 'no') ? 'reads at startup — NOT replicated' : 'reads at startup',
      external: false,
    });
  }
  // 4. The k8s workloads behind this component: the real mount picture.
  const workloads = arr(snap?.workloads).filter((w) => w && w.componentId === componentId);
  for (const w of workloads) {
    const ns = w.namespace || 'default';
    for (const name of arr(w.configmaps)) {
      add('mount', { id: cmId(ns, name), label: name, sub: 'ConfigMap', kind: 'k8s-configmap', category: 'other', awsServices: [], tier: null, layer: '', why: 'reads at startup', external: false });
    }
    for (const name of arr(w.secrets)) {
      add('mount', { id: secId(ns, name), label: name, sub: 'Secret', kind: 'k8s-secret', category: 'security-secrets', awsServices: [], tier: null, layer: '', why: 'mounted at startup', external: false });
    }
    if (w.serviceAccount) {
      add('mount', { id: `sa:${ns}/${w.serviceAccount}`, label: w.serviceAccount, sub: 'ServiceAccount / IRSA role', kind: 'k8s-serviceaccount', category: 'identity-access', awsServices: ['IAM'], tier: null, layer: '', why: 'assumes this role at startup', external: false });
    }
    for (const img of arr(w.images)) {
      // If a registry is already a prerequisite (the engine's ECR item, or an
      // inventory component), the image host adds nothing but noise.
      if ([...mounts.values()].some((x) => x.category === 'cicd-control-plane')) break;
      const repo = String(img).split('@')[0].split(':')[0];
      const host = repo.includes('/') ? repo.slice(0, repo.indexOf('/')) : repo;
      const isRegistry = host.includes('.') || host.includes(':');
      add('mount', {
        id: `reg:${isRegistry ? host : 'docker.io'}`,
        label: isRegistry ? host : 'docker.io',
        sub: 'image registry', kind: 'container-registry', category: 'cicd-control-plane',
        awsServices: /\.ecr\./.test(host) ? ['ECR'] : [], tier: null, layer: '',
        why: 'pulls images', external: !/\.ecr\./.test(host),
      });
    }
    for (const p of arr(snap?.pvcs)) {
      if (!p || p.namespace !== ns || !p.name) continue;
      const bound = p.boundTo && (p.boundTo === w.name || p.boundTo === w.uid || String(w.uid).endsWith(`/${p.boundTo}`));
      if (!bound) continue;
      add('mount', { id: pvcId(p), label: p.name, sub: [p.size, p.storageClass].filter(Boolean).join(' · ') || 'PVC', kind: 'k8s-pvc', category: 'storage', awsServices: [], tier: null, layer: '', why: 'mounts at startup', external: false });
    }
    // In-cluster services this workload's namespace exposes are called by name.
    for (const s of arr(snap?.services)) {
      if (!s || s.namespace !== ns || !s.name) continue;
      if (arr(s.targets).includes(w.uid)) continue; // its own service, not a dependency
      if (!arr(s.targets).length) continue;
      const ownerCid = arr(s.targets).map((uid) => arr(snap?.workloads).find((x) => x && x.uid === uid)).find((x) => x && x.componentId && x.componentId !== componentId);
      if (!ownerCid) continue;
      add('call', { id: svcId(s), label: s.name, sub: `in-cluster service · ${s.type || 'ClusterIP'}`, kind: 'k8s-service', category: 'compute', awsServices: [], tier: null, layer: '', why: 'calls at startup', external: false });
    }
  }
  // 5. Outbound calls — the third-party endpoints that must be reachable.
  for (const oc of focus.outboundCalls || []) {
    if (!oc || !oc.target) continue;
    const external = EXTERNAL_OUTBOUND.has(String(oc.type || ''));
    const allowlist = /allowlist|whitelist/i.test(String(oc.failoverBehavior || ''));
    add('call', {
      id: `ext_${slugify(oc.target)}`, label: String(oc.target),
      sub: [oc.type || 'external', oc.protocol || ''].filter(Boolean).join(' · '),
      kind: 'external', category: external ? 'third-party' : 'other', awsServices: [], tier: null, layer: '',
      why: allowlist ? 'partner allowlist required' : (oc.purpose ? `opens connection on boot — ${oc.purpose}` : 'opens connection on boot'),
      external,
    });
  }

  const bySort = (a, b) => String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id));
  const mountList = [...mounts.values()].sort(bySort);
  const callList = [...calls.values()].sort(bySort);
  return {
    focus,
    workloads,
    mounts: mountList,
    calls: callList,
    externalCount: mountList.filter((x) => x.external).length + callList.filter((x) => x.external).length,
    wave: orderItem ? (order.waves.find((w) => w.items.some((it) => it.id === componentId))?.index ?? null) : null,
  };
}

const startupNode = (x) => ({
  id: x.id, label: x.label, sub: x.external ? `${x.sub} · verify only` : x.sub,
  kind: x.kind, category: x.external ? 'third-party' : x.category,
  awsServices: x.awsServices || [], tier: x.tier ?? null, layer: x.layer || '',
  external: !!x.external, why: x.why,
});

/** Canvas data for 'startup-dependencies-<componentId>'. */
export function buildStartupCanvas(data, componentId) {
  const f = startupFacts(data, componentId);
  if (!f) return null;
  if (!f.mounts.length && !f.calls.length) return null;
  const c = f.focus;
  const centre = {
    id: c.id, label: c.name,
    sub: [c.kind || CATEGORY_LABEL[c.category] || 'workload', f.wave ? `wave ${f.wave}` : ''].filter(Boolean).join(' · '),
    kind: c.kind || '', category: c.category || 'compute', awsServices: c.awsServices || [],
    tier: typeof c.tier === 'number' ? c.tier : null, layer: c.restoreLayer || '',
  };
  const nodes = [centre];
  const edges = [];
  const mountIds = [];
  const callIds = [];
  const extIds = [];
  for (const m of f.mounts) {
    if (m.id === c.id) continue;
    nodes.push(startupNode(m));
    (m.external ? extIds : mountIds).push(m.id);
    edges.push({ from: c.id, to: m.id, kind: m.external ? 'outbound' : 'dependency', label: truncate(whyText(m.why, c.name), 56) });
  }
  for (const k of f.calls) {
    if (k.id === c.id) continue;
    nodes.push(startupNode(k));
    (k.external ? extIds : callIds).push(k.id);
    edges.push({ from: c.id, to: k.id, kind: k.external ? 'outbound' : 'dependency', label: truncate(whyText(k.why, c.name), 56) });
  }
  const groups = [];
  if (mountIds.length) groups.push({ id: 'grp_mounts', label: `Must exist and be mounted first · ${mountIds.length}`, nodeIds: mountIds });
  groups.push({ id: 'grp_workload', label: 'The workload', nodeIds: [c.id] });
  if (callIds.length) groups.push({ id: 'grp_calls', label: `Called the moment it starts · ${callIds.length}`, nodeIds: callIds });
  if (extIds.length) groups.push({ id: 'grp_ext', label: `External preconditions · ${extIds.length} · verify, cannot be deployed`, nodeIds: extIds });
  return {
    nodes, edges, groups,
    meta: {
      diagramId: `${STARTUP_PREFIX}${componentId}`,
      name: `Startup dependencies — ${c.name}`,
      regions: data?.workspace?.regions || {},
      note: `${mountIds.length + extIds.length} thing${mountIds.length + extIds.length === 1 ? '' : 's'} must be up and ready before this starts; ${callIds.length} are called the moment it does.`,
    },
  };
}

/** Mermaid for 'startup-dependencies-<componentId>'. */
export function startupMermaid(data, componentId) {
  const canvas = buildStartupCanvas(data, componentId);
  if (!canvas) return null;
  const f = startupFacts(data, componentId);
  const nodeById = new Map(canvas.nodes.map((n) => [String(n.id), n]));
  const mid = new Map();
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `s${seq++}`); return mid.get(id); };
  const classes = new Map();
  const addClass = (name, id) => {
    if (!classes.has(name)) classes.set(name, []);
    classes.get(name).push(id);
  };
  const lines = ['flowchart LR'];
  canvas.groups.forEach((grp, gi) => {
    const ids = grp.nodeIds.filter((id) => nodeById.has(String(id)));
    if (!ids.length) return;
    lines.push(`  subgraph sg${gi}["${sanitizeLabel(grp.label)}"]`);
    lines.push('    direction TB');
    for (const id of ids) {
      const n = nodeById.get(String(id));
      const m = nid(String(id));
      lines.push(`    ${m}["${sanitizeLabel(truncate(`${n.label}${n.sub ? ' · ' + n.sub : ''}`, 56))}"]`);
      if (n.external) addClass('dwaitext', m);
      else addClass(deployCatClass(n.category), m);
    }
    lines.push('  end');
  });
  for (const e of canvas.edges) {
    const a = mid.get(String(e.from)), b = mid.get(String(e.to));
    if (!a || !b) continue;
    const why = sanitizeLabel(e.label || '');
    lines.push(why && why !== 'unnamed' ? `  ${a} -->|"${why}"| ${b}` : `  ${a} --> ${b}`);
  }
  lines.push(...DEPLOY_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));
  const mountCount = f.mounts.length;
  const callCount = f.calls.length;
  return {
    id: canvas.meta.diagramId,
    name: canvas.meta.name,
    kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: [
      `**Startup dependencies — ${sanitizeLabel(f.focus.name)}.** Before this comes up, ${mountCount} thing${mountCount === 1 ? '' : 's'} must already exist and be mountable (secrets, config, volumes, its role, the image registry). The moment it starts it calls ${callCount} thing${callCount === 1 ? '' : 's'} — a pod that boots before those are ready crash-loops, which is why they sit earlier in the deployment order.`,
      'Every arrow is labelled with *why* ("reads at startup", "pulls images", "opens connection on boot", "partner allowlist required").',
      'Amber dashed = an external precondition: you verify it before the cutover, you cannot deploy it.',
      f.workloads.length
        ? `Mount facts come from ${f.workloads.length} Kubernetes workload${f.workloads.length === 1 ? '' : 's'} in the captured snapshot.`
        : 'No Kubernetes workload is linked to this component, so the mount side comes from the inventory (secrets, dependencies) only — capture a cluster snapshot in Discover for the real pod picture.',
    ].join('\n\n'),
    componentIds: [f.focus.id],
  };
}

// ---- dispatchers ---------------------------------------------------------

export function buildDeployOrderCanvasData(diagramId, data) {
  if (!hasDeployOrder(data?.deployOrder)) return null;
  const scope = deployOrderScope(diagramId);
  if (!scope) return null;
  if (scope.kind === 'startup') return buildStartupCanvas(data, scope.componentId);
  return buildDeployOrderCanvas(data, scope.componentId);
}

export function generateDeployOrder(diagramId, data) {
  if (!hasDeployOrder(data?.deployOrder)) return null;
  const scope = deployOrderScope(diagramId);
  if (!scope) return null;
  if (scope.kind === 'startup') return startupMermaid(data, scope.componentId);
  return deployOrderMermaid(data, scope.componentId);
}

/* =====================================================================
 * SOLUTION DOCUMENTS  →  the proposed failover, as a picture
 * ---------------------------------------------------------------------
 * A user uploads a proposed solution ("QuickSave failover using ARC Region
 * switch"). server/lib/solution-context.js reads it with the AI, validates
 * the result against the inventory and stores a `solution-model/1` under the
 * workspace object 'solution-models'. This section draws THAT model.
 *
 * Same arrangement as the deployment order: this module never imports the
 * extractor. The route hands the already-stored models in as
 * `data.solutionModels` ({ [documentId]: model }), so everything here keeps
 * working — by listing nothing and returning null — when no document has
 * been read yet.
 *
 * Two rules the picture must keep:
 *   * PROVENANCE. Every node carries `provenance` — the sentence of the
 *     document it came from, and whether that sentence was found in the
 *     document verbatim. The mermaid notes print the same citations.
 *   * VAGUENESS IS DRAWN, NOT FILLED IN. A step whose components the
 *     document never names becomes a node that SAYS the document does not
 *     say, rather than a node with plausible components in it. An unmatched
 *     name becomes a dashed "not in your inventory" node, never a component.
 * ===================================================================*/

export const SOLUTION_PREFIX = 'solution-';

export function isSolutionDiagramId(id) {
  return String(id ?? '').startsWith(SOLUTION_PREFIX);
}
export function solutionDocumentId(id) {
  return isSolutionDiagramId(id) ? String(id).slice(SOLUTION_PREFIX.length) : '';
}

/** Shape-check a stored model without importing the extractor. */
export function hasSolutionModel(model) {
  return !!(model && typeof model === 'object' && !Array.isArray(model)
    && String(model.schema || '').startsWith('solution-model/')
    && model.documentId);
}

function solutionModels(data) {
  const bag = data?.solutionModels;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {};
  const out = {};
  for (const [k, v] of Object.entries(bag)) if (hasSolutionModel(v)) out[k] = v;
  return out;
}

export function solutionModelFor(data, diagramId) {
  const docId = solutionDocumentId(diagramId);
  if (!docId) return null;
  return solutionModels(data)[docId] || null;
}

const solOrchLabel = (m) => String(m?.orchestration?.label || 'Orchestration not stated');

export function listSolutionDiagrams(data) {
  const models = Object.values(solutionModels(data));
  if (!models.length) return [];
  return models
    .sort((a, b) => String(b.extractedAt || '').localeCompare(String(a.extractedAt || '')))
    .map((m) => {
      const steps = arr(m.steps).length;
      const gates = arr(m.gates).length;
      const conflicts = arr(m.conflicts).length;
      const unmatched = arr(m.components?.unmatched).length;
      return {
        id: `${SOLUTION_PREFIX}${m.documentId}`,
        name: `Proposed failover — ${m.documentName || m.documentId}`,
        kind: 'solution', section: 'Proposed solutions', canvas: true,
        description: [
          solOrchLabel(m),
          `${steps} step${steps === 1 ? '' : 's'}`,
          gates ? `${gates} approval gate${gates === 1 ? '' : 's'}` : 'no approval gate',
          conflicts ? `⚠ ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : '',
          unmatched ? `⚠ ${unmatched} unmatched` : '',
          'unreviewed proposal',
        ].filter(Boolean).join(' · '),
      };
    });
}

// ---- nodes ---------------------------------------------------------------

const solProv = (ev) => ({
  quote: truncate(String(ev?.quote || ''), 300),
  sentenceIndex: ev?.sentenceIndex ?? null,
  verified: !!ev?.verified,
});

// A citation that could not be found in the document is said out loud on the
// node itself. A reviewer should not have to open a panel to learn that.
const solCite = (ev) => (ev && ev.quote
  ? (ev.verified ? `“${truncate(ev.quote, 70)}”` : `⚠ cites a sentence not in the document: “${truncate(ev.quote, 50)}”`)
  : '⚠ no sentence cited');

const solCompNodeId = (stepId, key) => `${stepId}__${slugify(key)}`;

function solStepNode(s, comps) {
  const cat = s.components.map((c) => comps.get(c.componentId)?.category).find(Boolean) || 'other';
  const bits = [
    `step ${s.order}`,
    s.action && s.action !== 'other' ? s.action : '',
    s.actor ? `by ${truncate(s.actor, 26)}` : '',
  ].filter(Boolean);
  return {
    id: s.id,
    label: truncate(s.title, 60),
    sub: [bits.join(' · '), s.vague ? `⚠ vague — ${truncate(s.vagueWhy, 70)}` : '', solCite(s.evidence)].filter(Boolean).join('\n'),
    kind: 'solution-step',
    category: cat,
    awsServices: [],
    tier: null, layer: '',
    solutionRole: 'step',
    stepOrder: s.order,
    vague: !!s.vague,
    provenance: solProv(s.evidence),
  };
}

function solComponentNode(stepId, ref, comp, conflict) {
  return {
    id: solCompNodeId(stepId, ref.componentId),
    label: truncate(comp.name, 48),
    sub: [
      [comp.kind || '', comp.restoreLayer || '', comp.replication?.mechanism ? `repl: ${comp.replication.mechanism}` : ''].filter(Boolean).join(' · '),
      ref.match === 'fuzzy' || ref.match === 'alias'
        ? `⚠ matched by name similarity to “${truncate(ref.documentName, 34)}” — confirm` : '',
      conflict ? `⚠ conflict — document: ${truncate(conflict.documentClaim, 44)}` : '',
      conflict ? `   inventory: ${truncate(conflict.inventoryFact, 44)}` : '',
    ].filter(Boolean).join('\n'),
    kind: comp.kind || '',
    category: comp.category || 'other',
    awsServices: comp.awsServices || [],
    tier: typeof comp.tier === 'number' ? comp.tier : null,
    layer: comp.restoreLayer || '',
    componentId: comp.id,
    solutionRole: conflict ? 'component-conflict' : 'component',
    matchQuality: ref.match,
  };
}

function solUnmatchedNode(stepId, ref) {
  return {
    id: solCompNodeId(stepId, `x-${ref.documentName}`),
    label: truncate(ref.documentName, 48),
    sub: '⚠ named in the document\nnot in your inventory — nothing was created',
    kind: 'external',
    category: 'third-party',
    awsServices: [], tier: null, layer: '',
    solutionRole: 'unmatched',
    documentName: ref.documentName,
  };
}

/** Canvas data for `solution-<documentId>`. */
export function buildSolutionCanvas(data, diagramId) {
  const m = solutionModelFor(data, diagramId);
  if (!m) return null;
  const comps = byId(data?.components || []);
  const conflictByComp = new Map();
  for (const c of arr(m.conflicts)) {
    if (c && c.componentId && !conflictByComp.has(c.componentId)) conflictByComp.set(c.componentId, c);
  }

  const nodes = [];
  const edges = [];
  const groups = [];
  const present = new Set();
  const add = (n) => { if (!present.has(n.id)) { nodes.push(n); present.add(n.id); } return n.id; };

  // 1. Pre-cutover conditions — verify before anything executes.
  const preIds = [];
  for (const p of arr(m.preCutoverConditions)) {
    preIds.push(add({
      id: p.id,
      label: truncate(p.text, 58),
      sub: ['must be TRUE before execution starts — verify, do not create', solCite(p.evidence)].join('\n'),
      kind: 'precondition', category: 'other', awsServices: [], tier: null, layer: 'L0',
      solutionRole: 'pre-cutover',
      provenance: solProv(p.evidence),
    }));
  }
  if (preIds.length) {
    groups.push({
      id: 'sol_pre',
      label: `Pre-cutover conditions · ${preIds.length} · from the document · verify, cannot be executed`,
      nodeIds: preIds,
    });
  }

  // 2. The document's own sequence, one band per step, gates between bands.
  const gatesAfter = new Map();
  for (const g of arr(m.gates)) {
    if (g.afterStep === null || g.afterStep === undefined) continue;
    if (!gatesAfter.has(g.afterStep)) gatesAfter.set(g.afterStep, []);
    gatesAfter.get(g.afterStep).push(g);
  }
  const gateNode = (g) => ({
    id: g.id,
    label: truncate(`Approval — ${g.title}`, 58),
    sub: [
      g.approver ? `approver: ${truncate(g.approver, 40)}` : '⚠ the document does not name who approves',
      g.blocking ? 'blocking — nothing past this runs until it is approved' : '⚠ the document marks this gate non-blocking',
      solCite(g.evidence),
    ].filter(Boolean).join('\n'),
    kind: 'approval', category: 'other', awsServices: [], tier: null, layer: 'L6',
    solutionRole: 'gate',
    provenance: solProv(g.evidence),
  });

  let prevFlowId = '';
  const stepList = arr(m.steps);
  for (const s of stepList) {
    const stepId = add(solStepNode(s, comps));
    const bandIds = [stepId];
    for (const ref of arr(s.components)) {
      const comp = ref.componentId ? comps.get(ref.componentId) : null;
      const nid = comp
        ? add(solComponentNode(s.id, ref, comp, conflictByComp.get(ref.componentId) || null))
        : add(solUnmatchedNode(s.id, ref));
      bandIds.push(nid);
      edges.push({
        from: stepId, to: nid,
        kind: comp ? 'dependency' : 'outbound',
        label: comp ? (s.action && s.action !== 'other' ? s.action : 'acts on') : 'named, not in inventory',
      });
    }
    if (!arr(s.components).length) {
      // The vagueness is the picture. Draw it rather than guess what it touches.
      const vid = add({
        id: `${s.id}__vague`,
        label: 'the document does not say',
        sub: 'which components this step acts on\n— get the answer, do not fill it in',
        kind: 'external', category: 'other', awsServices: [], tier: null, layer: '',
        solutionRole: 'vague',
      });
      bandIds.push(vid);
      edges.push({ from: stepId, to: vid, kind: 'outbound', label: 'unspecified' });
    }
    groups.push({ id: `sol_s${s.order}`, label: `Step ${s.order} · ${truncate(s.title, 56)}`, nodeIds: bandIds });
    if (prevFlowId) edges.push({ from: prevFlowId, to: stepId, kind: 'dependency', label: 'then' });
    prevFlowId = stepId;
    for (const g of gatesAfter.get(s.order) || []) {
      const gid = add(gateNode(g));
      groups.push({ id: `sol_g_${slugify(g.id)}`, label: `Approval gate · ${truncate(g.title, 54)}`, nodeIds: [gid] });
      edges.push({ from: prevFlowId, to: gid, kind: 'dependency', label: 'holds for approval' });
      prevFlowId = gid;
    }
  }
  // Pre-cutover conditions gate the first step.
  if (preIds.length && stepList.length) {
    for (const pid of preIds) edges.push({ from: pid, to: stepList[0].id, kind: 'dependency', label: 'must be true first' });
  }

  // Gates the document never placed in the sequence.
  const unplaced = arr(m.gates).filter((g) => g.afterStep === null || g.afterStep === undefined);
  if (unplaced.length) {
    const ids = unplaced.map((g) => add(gateNode(g)));
    groups.push({
      id: 'sol_gates_unplaced',
      label: `Approval gates the document does not place in the sequence · ${ids.length}`,
      nodeIds: ids,
    });
  }

  // 3. What a reviewer has to resolve before any of this is applied.
  const reviewIds = [];
  for (const c of arr(m.conflicts)) {
    reviewIds.push(add({
      id: c.id,
      label: truncate(`Conflict — ${c.componentName || c.kind}`, 58),
      sub: [
        `document: ${truncate(c.documentClaim, 60)}`,
        `inventory: ${truncate(c.inventoryFact, 60)}`,
        `${c.severity || 'medium'} · unresolved`,
        solCite(c.evidence),
      ].join('\n'),
      kind: 'conflict', category: 'security-secrets', awsServices: [], tier: null, layer: '',
      solutionRole: 'conflict',
      conflictKind: c.kind,
      componentId: c.componentId || null,
      provenance: solProv(c.evidence),
    }));
  }
  for (const u of arr(m.components?.unmatched)) {
    reviewIds.push(add({
      id: `solunm_${slugify(u.documentName)}`,
      label: truncate(u.documentName, 58),
      sub: 'named in the document · matches nothing in this inventory\nadd the component, or correct the document',
      kind: 'external', category: 'third-party', awsServices: [], tier: null, layer: '',
      solutionRole: 'unmatched',
    }));
  }
  if (reviewIds.length) {
    groups.push({
      id: 'sol_review',
      label: `Resolve before applying · ${reviewIds.length} · document vs inventory`,
      nodeIds: reviewIds,
    });
  }

  // Every conflict points at the step that raised it, so the picture connects.
  for (const c of arr(m.conflicts)) {
    if (!c.componentId) continue;
    const s = stepList.find((st) => arr(st.components).some((ref) => ref.componentId === c.componentId));
    if (s && present.has(c.id) && present.has(s.id)) {
      edges.push({ from: c.id, to: s.id, kind: 'outbound', label: 'blocks this step' });
    }
  }

  const regions = {
    primary: m.regions?.primary || data?.workspace?.regions?.primary || '',
    recovery: m.regions?.recovery || data?.workspace?.regions?.recovery || '',
  };
  return {
    nodes,
    edges: edges.filter((e) => present.has(e.from) && present.has(e.to)),
    groups: groups.filter((g) => g.nodeIds.length),
    meta: {
      diagramId: `${SOLUTION_PREFIX}${m.documentId}`,
      name: `Proposed failover — ${m.documentName || m.documentId}`,
      regions,
      documentId: m.documentId,
      documentName: m.documentName || '',
      orchestration: m.orchestration?.id || 'unknown',
      orchestrationLabel: solOrchLabel(m),
      reviewStatus: m.review?.status || 'unreviewed',
      extractedAt: m.extractedAt || '',
      counts: {
        steps: stepList.length,
        gates: arr(m.gates).length,
        preCutover: preIds.length,
        conflicts: arr(m.conflicts).length,
        unmatched: arr(m.components?.unmatched).length,
        vague: stepList.filter((s) => s.vague).length,
      },
      note: solutionNote(m),
      // The step bands read as an ordered sequence top to bottom.
      suggestedTemplate: 'layer-rows',
    },
  };
}

function solutionNote(m) {
  const parts = [
    `Drawn from the uploaded document "${m.documentName || m.documentId}" — a PROPOSAL, not your inventory. Nothing here has been applied.`,
    `It proposes ${solOrchLabel(m)}.`,
  ];
  const c = arr(m.conflicts).length, u = arr(m.components?.unmatched).length;
  if (c) parts.push(`${c} claim${c === 1 ? '' : 's'} contradict${c === 1 ? 's' : ''} the inventory.`);
  if (u) parts.push(`${u} name${u === 1 ? '' : 's'} in the document match nothing here.`);
  return parts.join(' ');
}

export function buildSolutionCanvasData(diagramId, data) {
  return buildSolutionCanvas(data, diagramId);
}

// ---- mermaid -------------------------------------------------------------

const SOL_CLASSDEFS = [
  'classDef solstep fill:#1e2836,stroke:#4f8ff7,stroke-width:2px',
  'classDef solgate fill:#3a2f22,stroke:#e2a336,stroke-width:2.5px,color:#e2a336',
  'classDef solpre fill:#1f2b28,stroke:#3fb27f,stroke-dasharray:4 3,color:#7ed9b0',
  'classDef solcomp stroke:#8a94a6',
  'classDef solconflict fill:#3a2224,stroke:#e2564f,stroke-width:2px,color:#f2938e',
  'classDef solunmatched fill:transparent,stroke:#9d7bf5,stroke-dasharray:6 4,color:#c4a8ff',
  'classDef solvague fill:transparent,stroke:#8a94a6,stroke-dasharray:3 3,color:#8a94a6',
];

const SOL_ROLE_CLASS = {
  'step': 'solstep',
  'gate': 'solgate',
  'pre-cutover': 'solpre',
  'component': 'solcomp',
  'component-conflict': 'solconflict',
  'conflict': 'solconflict',
  'unmatched': 'solunmatched',
  'vague': 'solvague',
};

/** Mermaid for `solution-<documentId>`. */
export function solutionMermaid(data, diagramId) {
  const canvas = buildSolutionCanvas(data, diagramId);
  if (!canvas) return null;
  const m = solutionModelFor(data, diagramId);
  const nodeById = new Map(canvas.nodes.map((n) => [String(n.id), n]));
  const mid = new Map();
  let seq = 0;
  const nid = (id) => { if (!mid.has(id)) mid.set(id, `s${seq++}`); return mid.get(id); };
  const classes = new Map();
  const addClass = (name, id) => {
    if (!classes.has(name)) classes.set(name, []);
    classes.get(name).push(id);
  };

  const lines = ['flowchart TB'];
  canvas.groups.forEach((grp, gi) => {
    const ids = grp.nodeIds.filter((id) => nodeById.has(String(id)));
    if (!ids.length) return;
    lines.push(`  subgraph sg${gi}["${sanitizeLabel(truncate(grp.label, 90))}"]`);
    lines.push('    direction LR');
    for (const id of ids) {
      const n = nodeById.get(String(id));
      const mn = nid(String(id));
      // Mermaid gets one line per node, so the line that carries a WARNING wins
      // over the descriptive one — a conflict must be readable in the picture,
      // not only in the canvas tooltip and the notes.
      const subLines = String(n.sub || '').split('\n').filter(Boolean);
      const first = subLines.find((l) => l.trim().startsWith('⚠')) || subLines[0] || '';
      const label = truncate(`${n.label}${first ? ' · ' + first : ''}`, 74);
      const shape = n.solutionRole === 'gate' ? ['{"', '"}'] : ['["', '"]'];
      lines.push(`    ${mn}${shape[0]}${sanitizeLabel(label)}${shape[1]}`);
      addClass(SOL_ROLE_CLASS[n.solutionRole] || 'solcomp', mn);
    }
    lines.push('  end');
  });
  for (const e of canvas.edges) {
    const a = mid.get(String(e.from)), b = mid.get(String(e.to));
    if (!a || !b) continue;
    const label = sanitizeLabel(truncate(e.label || '', 40));
    lines.push(label && label !== 'unnamed' ? `  ${a} -->|"${label}"| ${b}` : `  ${a} --> ${b}`);
  }
  lines.push(...SOL_CLASSDEFS.map((l) => '  ' + l), ...classLines(classes).map((l) => '  ' + l));

  // ---- notes: the honest frame, then the citations -----------------------
  const cited = [];
  for (const s of arr(m.steps)) {
    if (!s.evidence?.quote) continue;
    cited.push(`- Step ${s.order} (${s.title}) — ${s.evidence.verified ? '' : '⚠ NOT FOUND IN THE DOCUMENT: '}"${truncate(s.evidence.quote, 150)}"`);
  }
  for (const g of arr(m.gates)) {
    if (!g.evidence?.quote) continue;
    cited.push(`- Gate (${g.title}) — ${g.evidence.verified ? '' : '⚠ NOT FOUND IN THE DOCUMENT: '}"${truncate(g.evidence.quote, 150)}"`);
  }
  for (const p of arr(m.preCutoverConditions)) {
    if (!p.evidence?.quote) continue;
    cited.push(`- Pre-cutover — ${p.evidence.verified ? '' : '⚠ NOT FOUND IN THE DOCUMENT: '}"${truncate(p.evidence.quote, 150)}"`);
  }

  const notes = [
    `**This is a proposal, not your inventory.** It is drawn from the uploaded document **"${m.documentName || m.documentId}"**, which proposes **${solOrchLabel(m)}** for ${canvas.meta.regions.primary || '?'} → ${canvas.meta.regions.recovery || '?'}. Review status: **${canvas.meta.reviewStatus}** — nothing in this picture has been applied to the workspace.`,
    'Each band is a step in the order the document executes it. Diamonds are approval gates the document names. Green dashed nodes are conditions that must already be true before execution starts — you verify those, you cannot execute them.',
    arr(m.targets).length
      ? `Objectives quoted by the document (${arr(m.targets).map((t) => `${String(t.kind).toUpperCase()} ${t.minutes ?? '?'} min`).join(', ')}) are **targets somebody wrote down**, not measurements. Nothing in a proposal is evidence that anything recovers.`
      : '',
    arr(m.conflicts).length
      ? `⚠ **${arr(m.conflicts).length} conflict${arr(m.conflicts).length === 1 ? '' : 's'} with your inventory** — shown in the "Resolve before applying" band: `
        + arr(m.conflicts).slice(0, 4).map((c) => `${c.componentName || c.kind}: document says ${c.documentClaim}, inventory says ${c.inventoryFact}`).join('; ') + '.'
      : '',
    arr(m.components?.unmatched).length
      ? `⚠ ${arr(m.components.unmatched).length} name${arr(m.components.unmatched).length === 1 ? '' : 's'} in the document match nothing in this inventory (${arr(m.components.unmatched).slice(0, 4).map((u) => `"${u.documentName}"`).join(', ')}) — nothing was created for them.`
      : '',
    canvas.meta.counts.vague
      ? `${canvas.meta.counts.vague} step${canvas.meta.counts.vague === 1 ? '' : 's'} ${canvas.meta.counts.vague === 1 ? 'is' : 'are'} vague in the document; ${canvas.meta.counts.vague === 1 ? 'it is' : 'they are'} drawn as vague rather than filled in.`
      : '',
    arr(m.injectionAttempts).length
      ? `⚠ ${arr(m.injectionAttempts).length} passage${arr(m.injectionAttempts).length === 1 ? '' : 's'} in this document ${arr(m.injectionAttempts).length === 1 ? 'was' : 'were'} written as an instruction to an AI rather than as part of the plan. ${arr(m.injectionAttempts).length === 1 ? 'It was' : 'They were'} recorded and ignored — the document is data here, never a prompt.`
      : '',
    arr(m.components?.notMentioned).filter((c) => c.tier === 0).length
      ? `⚠ Tier-0 components this document never mentions: ${arr(m.components.notMentioned).filter((c) => c.tier === 0).slice(0, 5).map((c) => c.componentName).join(', ')}.`
      : '',
    cited.length ? `**Where each element came from** (every one cites a sentence you can check):\n${cited.slice(0, 40).join('\n')}` : '',
  ].filter(Boolean);

  const cmpIds = [...new Set(canvas.nodes.map((n) => n.componentId).filter(Boolean))];
  return {
    id: canvas.meta.diagramId,
    name: canvas.meta.name,
    kind: 'flowchart',
    mermaid: lines.join('\n'),
    notes: notes.join('\n\n'),
    componentIds: cmpIds,
  };
}

export function generateSolution(diagramId, data) {
  return solutionMermaid(data, diagramId);
}
