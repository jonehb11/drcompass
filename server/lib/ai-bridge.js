// Bridge to the user's local Claude Code CLI (`claude` on PATH).
// Non-interactive: `claude -p <prompt> --output-format text`. Nothing is sent
// anywhere except through the user's own CLI/auth.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from '../store.js';

const execFile = promisify(execFileCb);
const TIMEOUT_MS = 180000;
const MAX_BUFFER = 20 * 1024 * 1024;
const CONTEXT_CAP = 50 * 1024; // ~50KB of serialized workspace context
const FOCUS_CAP = 60 * 1024;   // ~60KB of focused, object-centric context

// Baked into every prompt. This is a DR tool: a confident wrong answer costs
// more than an honest "I don't know from this data".
export const QUALITY_RULES = `Ground rules — this is disaster recovery, where being wrong is expensive:
- Honest numbers. RTO/RPO are TARGETS someone agreed to. RTA/RPA are results, and they count as MEASURED only when a test recorded as "passed" produced them. Where the context carries a "measured" block, its "state" decides the words you may use: "measured" — a passed test produced it, so quote it AND name that test, its date and its passed status; "declared" — a person typed it into workspace settings, so it is NOT evidence: call it "recorded by hand, not from a test" and never "measured", "achieved" or "met"; "unmeasured" — nothing has measured it, so say "unmeasured". A run recorded as failed, canceled, planned or in-progress produced a time to FAILURE, not a recovery time — never quote its numbers as a measurement. Never invent, estimate, or round any number, and never present a target as an achievement.
- Prefer "I can't tell from this data" over a plausible guess, and say what you would need to look at. Guessing here gets people paged at 3am.
- Reference the real ids and names from the context (cmp_*, rbk_*, tst_*, gap_*, chk_*). Never invent ids, component names, ARNs, hostnames, or ticket numbers.
- Use only fields and enum values the schema defines. No new fields, no new enum values.
- Keep it tight — the reader is mid-task. No preamble, no restating the question, no filler or flattery.`;

// ------------------------------------------------- the honest-numbers view
//
// `server/lib/measured.js` is the single source of truth; it is imported
// optionally so this module keeps working without it, and the local fallback
// applies the same rule. What never happens either way is telling the model
// that a hand-typed number is a measurement.
let sharedMeasured = null;
try {
  const mod = await import('./measured.js');
  const fn = mod.measuredNumbers || mod.default?.measuredNumbers || mod.default;
  if (typeof fn === 'function') sharedMeasured = fn;
} catch { sharedMeasured = null; }

const isFiniteNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const okState = (s) => !!s && ['measured', 'declared', 'unmeasured'].includes(s.state);

function localHonestNumbers(workspace, tests) {
  const o = (workspace && workspace.objectives) || {};
  const list = Array.isArray(tests) ? tests : [];
  const slot = (key, linkKey) => {
    const passed = list
      .filter((t) => t && t.status === 'passed' && isFiniteNum(t.results?.[key]))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const linked = o[linkKey] ? passed.find((t) => t.id === o[linkKey]) : null;
    const ev = linked || passed[0] || null;
    if (ev) {
      return {
        minutes: Number(ev.results[key]), state: 'measured', source: 'test',
        test: { id: ev.id || '', name: ev.name || '', date: ev.date || '', status: 'passed', cleanRun: ev.results?.cleanRun ?? null },
        staleDays: null, stale: false, isAchievement: false, label: 'measured',
        note: 'Produced by a test recorded as passed. Quote it and name the test.',
      };
    }
    if (isFiniteNum(o[key])) {
      const echo = list
        .filter((t) => t && t.status !== 'passed' && Number(t.results?.[key]) === Number(o[key]))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;
      return {
        minutes: Number(o[key]), state: 'declared', source: 'typed', test: null,
        staleDays: null, stale: false, isAchievement: false, label: 'declared (typed, not measured)',
        note: 'Typed by a person into the Settings screen. No test in this workspace produced it, so it is NOT evidence'
          + (echo ? `. It matches test '${echo.name || echo.id}' (${echo.date || 'undated'}), which is recorded as ${echo.status}` : '')
          + '. Do not call it measured or achieved.',
      };
    }
    const anyRun = list.filter((t) => t && isFiniteNum(t.results?.[key]))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;
    return {
      minutes: null, state: 'unmeasured', source: null, test: null,
      staleDays: null, stale: false, isAchievement: false, label: 'unmeasured',
      note: anyRun
        ? `No passed test has measured this. The closest run, '${anyRun.name || anyRun.id}' (${anyRun.date || 'undated'}), is ${anyRun.status}.`
        : 'No test has measured this yet.',
    };
  };
  const rta = slot('rtaMinutes', 'rtaTestId');
  const rpa = slot('rpaMinutes', 'rpaTestId');
  const target = {
    rtoMinutes: isFiniteNum(o.rtoMinutes) ? Number(o.rtoMinutes) : null,
    rpoMinutes: isFiniteNum(o.rpoMinutes) ? Number(o.rpoMinutes) : null,
    approved: !!o.approved,
  };
  // Vocabulary and rules per docs/measured-numbers.md.
  const judge = (s, t) => (s.state !== 'measured' || s.minutes === null || t === null
    ? 'unknown' : s.minutes <= t ? 'met' : 'missed');
  const rto = judge(rta, target.rtoMinutes);
  const rpo = judge(rpa, target.rpoMinutes);
  const overall = rto === 'missed' || rpo === 'missed' ? 'missed'
    : rto === 'met' && rpo === 'met' ? 'met'
      : rto === 'met' || rpo === 'met' ? 'partial' : 'unknown';
  rta.isAchievement = rto === 'met';
  rpa.isAchievement = rpo === 'met';
  const warnings = [];
  if (rta.state === 'declared') warnings.push('The recovery time is hand-typed with no passed test behind it — it is not evidence.');
  if (rpa.state === 'declared') warnings.push('The data loss number is hand-typed with no passed test behind it — it is not evidence.');
  if (!target.approved && (target.rtoMinutes !== null || target.rpoMinutes !== null)) {
    warnings.push('The targets are not approved by the business, so they are proposals rather than commitments.');
  }
  return {
    rta, rpa, target,
    verdict: { rto, rpo, overall, why: overall === 'unknown' ? 'nothing has been measured by a passed test' : '' },
    warnings,
    legend: MEASURED_LEGEND,
  };
}

const MEASURED_LEGEND =
  'state "measured" = a test recorded as passed, and directly covering the subject, produced it — quote it and name the test; '
  + '"declared" = a person typed it into Settings, NOT evidence — say "recorded by hand, not from a test"; '
  + '"unmeasured" = nothing measured it — say "unmeasured". isAchievement is the ONLY flag that permits the word "achieved"; '
  + 'stale:true means the evidence has aged out, so say when it was measured and do not claim it currently holds. '
  + 'verdict.overall "met" requires BOTH objectives measured and inside target. '
  + 'scope says what the number is evidence FOR: scope.measuredFor names the components the test actually '
  + 'exercised, and scope.untestedCritical lists the workspace\'s most critical components that NO passed test '
  + 'has ever covered — never present a workspace number as evidence for anything in that list.';

// `components` is not decoration: at workspace level it is what decides whether
// a passed test's evidence covers this workspace or only the components it
// named (docs/measured-numbers.md — "Covers", workspace subject). Without it the
// shared rule under-claims rather than over-claims — the safe direction, but not
// the accurate one, so every caller that has the inventory should pass it.
export function honestNumbers(workspace, tests, components = []) {
  if (sharedMeasured) {
    try {
      const r = sharedMeasured(workspace, Array.isArray(tests) ? tests : [], null,
        { components: Array.isArray(components) ? components : [] });
      if (r && okState(r.rta) && okState(r.rpa)) return { ...r, legend: MEASURED_LEGEND };
    } catch { /* fall through to the local rule */ }
  }
  return localHonestNumbers(workspace, tests);
}

const PREAMBLE =
  'You are helping build a disaster recovery inventory for a DR planning tool (DR Compass). ' +
  'Answer precisely and practically, for an experienced platform/SRE audience. ' +
  'When asked about components, think about dependencies, data replication, secrets, DNS/edge, third-party calls, and restore ordering.' +
  `\n\n${QUALITY_RULES}`;

const MISSING_CLI_MSG =
  'Claude Code CLI not found on PATH — install Claude Code (https://claude.com/claude-code), sign in, then retry.';

export async function claudeCliFound() {
  try {
    await execFile('claude', ['--version'], { timeout: 15000, env: process.env });
    return true;
  } catch {
    return false;
  }
}

// Compact, capped JSON view of the workspace for prompt context.
export function serializeContext({ workspace, components, tests } = {}) {
  const compact = {
    workspace: workspace
      ? {
        name: workspace.name, regions: workspace.regions, strategy: workspace.strategy,
        // Targets only. rtaMinutes/rpaMinutes are hand-typed and would read as
        // measurements next to the targets, so they travel inside `measured`
        // with their state attached or not at all.
        objectives: {
          rtoMinutes: workspace.objectives?.rtoMinutes ?? null,
          rpoMinutes: workspace.objectives?.rpoMinutes ?? null,
          approved: !!workspace.objectives?.approved,
          notes: workspace.objectives?.notes || '',
        },
        measured: honestNumbers(workspace, tests || [], components || []),
        tooling: workspace.tooling,
      }
      : undefined,
    components: (components || []).map((c) => ({
      id: c.id, name: c.name, category: c.category, kind: c.kind,
      restoreLayer: c.restoreLayer, inRecoveryScope: c.inRecoveryScope,
      dependsOn: c.dependsOn || [],
      outboundCalls: (c.outboundCalls || []).map((o) => o.target),
      gaps: c.gaps || [],
    })),
  };
  let json = JSON.stringify(compact);
  while (json.length > CONTEXT_CAP && compact.components.length > 5) {
    compact.components = compact.components.slice(0, Math.floor(compact.components.length / 2));
    compact.truncated = true;
    json = JSON.stringify(compact);
  }
  return json.slice(0, CONTEXT_CAP);
}

async function runClaude(fullPrompt, cwd) {
  try {
    const { stdout } = await execFile('claude', ['-p', fullPrompt, '--output-format', 'text'], {
      timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: process.env,
      cwd: cwd || process.cwd(),
    });
    return { ok: true, text: stdout.toString().trim() };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, message: MISSING_CLI_MSG };
    if (e.killed || e.signal === 'SIGTERM') return { ok: false, message: `Claude CLI timed out after ${TIMEOUT_MS / 1000}s` };
    const stderr = (e.stderr || '').toString().trim().split('\n').slice(-3).join(' ');
    return { ok: false, message: `Claude CLI failed: ${(stderr || e.message || '').slice(0, 400)}` };
  }
}

// `context` may be:
//   - a string  — a pre-serialized context blob (legacy callers, unchanged), or
//   - an object — a focus selector {kind, id?, extra?} which, together with
//     `slug`, is assembled into a FOCUSED context by buildFocusedContext().
export async function ask({ prompt, context, cwd, slug } = {}) {
  if (!prompt || !String(prompt).trim()) return { ok: false, message: 'Empty prompt' };
  let blob = '';
  let label = 'Current workspace inventory (compact JSON)';
  let meta = null;
  if (typeof context === 'string') {
    blob = context;
  } else if (context && typeof context === 'object' && slug) {
    const focused = buildFocusedContext(slug, context);
    blob = focused.json;
    label = `Focused context for this ${focused.kind} (JSON)`;
    meta = { kind: focused.kind, id: focused.id, bytes: focused.bytes, truncated: focused.truncated };
  }
  let fullPrompt = PREAMBLE;
  if (blob) fullPrompt += `\n\n${label}:\n${blob}`;
  fullPrompt += `\n\n${String(prompt).trim()}`;
  const r = await runClaude(fullPrompt, cwd);
  if (!r.ok) return r;
  // `context` is additive — legacy string-context callers get the same shape as before.
  return meta ? { ok: true, answer: r.text, context: meta } : { ok: true, answer: r.text };
}

// Tolerant JSON-array extractor: take from the first '[' to the last ']'.
function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const CATEGORIES = ['compute', 'networking', 'storage', 'database', 'messaging-streaming',
  'security-secrets', 'edge-dns', 'identity-access', 'observability', 'third-party',
  'cicd-control-plane', 'other'];

function normalizeProposal(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').trim();
  if (!name) return null;
  return {
    name,
    category: CATEGORIES.includes(p.category) ? p.category : 'other',
    tier: Number.isInteger(p.tier) ? p.tier : 1,
    owner: p.owner || '', team: p.team || '',
    description: String(p.description || ''),
    kind: String(p.kind || 'other'),
    drStrategy: p.drStrategy || 'inherit',
    restoreLayer: /^L[0-7]$/.test(p.restoreLayer || '') ? p.restoreLayer : 'L4',
    replication: { mechanism: 'unknown', rpoMinutes: null, notes: '', ...(p.replication || {}) },
    inRecoveryScope: ['yes', 'no', 'partial', 'unknown'].includes(p.inRecoveryScope) ? p.inRecoveryScope : 'unknown',
    definedIn: p.definedIn || '',
    dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [],
    outboundCalls: Array.isArray(p.outboundCalls) ? p.outboundCalls : [],
    awsServices: Array.isArray(p.awsServices) ? p.awsServices : [],
    secrets: Array.isArray(p.secrets) ? p.secrets : [],
    endpoints: Array.isArray(p.endpoints) ? p.endpoints : [],
    verification: { command: '', pass: '', ...(p.verification || {}) },
    gaps: Array.isArray(p.gaps) ? p.gaps : [],
    notes: p.notes || '', tags: ['discovered', 'ai-suggested'],
  };
}

export async function suggestComponents({ workspace, components, freeText } = {}) {
  const context = serializeContext({ workspace, components });
  const fullPrompt =
    `${PREAMBLE}\n\nCurrent workspace inventory (compact JSON):\n${context}\n\n` +
    `${String(freeText || 'What components am I likely missing for a complete DR plan?').trim()}\n\n` +
    'Respond with ONLY a JSON array (no prose, no markdown fences) of proposed new components. ' +
    'Each element must have at least: "name", "category" (one of ' + CATEGORIES.join('|') + '), ' +
    '"kind", "restoreLayer" ("L0".."L7"), "description". Optional: "dependsOn" (existing component ids), ' +
    '"outboundCalls", "awsServices", "gaps", "inRecoveryScope". Output ONLY JSON.';
  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  const arr = extractJsonArray(r.text);
  if (!arr) return { ok: true, raw: r.text }; // fallback: show the raw answer
  const proposals = arr.map(normalizeProposal).filter(Boolean);
  if (!proposals.length) return { ok: true, raw: r.text };
  return { ok: true, proposals };
}

// ---------------------------------------------------------------------------
// AI copilot: propose concrete workspace operations from a free-text
// instruction, validate them server-side, let the UI apply an approved subset.

const OPS = ['create', 'update', 'delete', 'update-workspace'];
const SNAPSHOT_CAP = 120 * 1024; // ~120KB of serialized workspace snapshot

const SCHEMA_CHEATSHEET = `Collection item shapes (ids are server-assigned on create — never invent them):
- components: {name, category(compute|networking|storage|database|messaging-streaming|security-secrets|edge-dns|identity-access|observability|third-party|cicd-control-plane|other), tier(int, 0=most critical), owner, team, description, kind(e.g. eks-workload, aurora, dynamodb-table), drStrategy, restoreLayer(L0..L7), replication{mechanism,rpoMinutes,notes}, inRecoveryScope(yes|no|partial|unknown), definedIn, dependsOn[existing cmp_* ids], outboundCalls[{target,type(aws-service|third-party|saas|internal|on-prem),protocol,purpose,failoverBehavior,critical}], awsServices[strings], secrets[{name,arn,replicated,notes}], endpoints[{name,url,healthCheck}], verification{command,pass}, gaps[strings], notes, tags[strings]}
- runbooks: {name, tooling, scenario, audience, preconditions[strings], steps[{id,layer(L0..L7),title,detail,command,verify,pass,owner,estMinutes,record,componentIds[],gate(bool)}], rollback[same step shape], linkedTestIds[], notes}
- tests: {name, type(recovery-test|game-day|tabletop|component-test|chaos), status(planned|in-progress|passed|failed|canceled), date(YYYY-MM-DD), runbookId, scope, appTests[{name,command,expected,componentId,critical}], timestamps{t0,tFirstAccess,t1}, results{rtaMinutes,rpaMinutes,cleanRun}, findings[{title,severity,gapId,ticket}], record(markdown)}
- checklists: {name, kind(phase0|preflight|game-day|weekly|custom), items[{id,text,why,proof,owner,done(bool)}]}
- gaps: {title, category(same list as components), class, severity(blocker|high|medium|low), componentId, status(open|accepted|resolved), ticket, notes}
- decisions: {date, title, context, decision, owner, status(decided|pending)}
- contacts: {name, role, responsibilities, contact, escalation}
Restore layers, ordered: L0 guardrails/backups green, L1 recovery launch/replication, L2 platform (cluster/nodes/mesh), L3 data + secrets, L4 applications, L5 edge/network reachability, L6 functional success bar, L7 live traffic cutover.
Workspace meta (for update-workspace): {name, org, description, regions{primary,recovery}, objectives{rtoMinutes,rpoMinutes,rtaMinutes,rpaMinutes,approved,notes}, strategy(backup-restore|pilot-light|warm-standby|active-active), tooling[arpio|region-switch|arc-routing-controls|elastic-dr|gitops-iac|resilience-hub|backup]}`;

const OPS_INSTRUCTIONS = `Respond with ONLY a JSON object of this exact shape — no prose outside the JSON, no markdown fences:
{"summary":"one line of what you propose",
 "operations":[
   {"op":"create","collection":"components|runbooks|tests|checklists|gaps|decisions|contacts","data":{...full new item...},"why":"reason"},
   {"op":"update","collection":"...","id":"cmp_x","data":{...ONLY the changed fields...},"why":"reason"},
   {"op":"delete","collection":"...","id":"cmp_x","why":"reason"},
   {"op":"update-workspace","data":{...partial workspace meta...},"why":"reason"}],
 "notes":"anything else the user should know (markdown ok)"}
Rules: for "update" send only changed fields (they are merged). Never invent ids for create ops — omit id, the server assigns it. Reference existing items by their exact id from the snapshot. If the instruction needs no data changes, return an empty operations array and answer in notes. Output valid JSON only.`;

// Slim view of a non-component item, used when the snapshot exceeds the cap.
function slimItem(it) {
  const s = { id: it.id, name: it.name || it.title || '' };
  for (const k of ['severity', 'status', 'kind', 'type', 'category', 'componentId', 'date']) {
    if (it[k] !== undefined && it[k] !== '') s[k] = it[k];
  }
  return s;
}

// Full workspace snapshot as compact JSON, capped at ~120KB: components stay
// full; other collections degrade to id/name summaries first.
function buildSnapshot(slug) {
  const workspace = store.getWorkspace(slug);
  const snap = { workspace };
  for (const col of store.COLLECTIONS) snap[col] = store.getCollection(slug, col);
  let json = JSON.stringify(snap);
  if (json.length <= SNAPSHOT_CAP) return json;
  const slim = { workspace, snapshotNote: 'Large workspace: non-component collections are truncated to id/name summaries. Components are complete.' };
  for (const col of store.COLLECTIONS) {
    slim[col] = col === 'components' ? snap[col] : snap[col].map(slimItem);
  }
  json = JSON.stringify(slim);
  if (json.length <= SNAPSHOT_CAP) return json;
  slim.components = snap.components.map((c) => ({
    id: c.id, name: c.name, category: c.category, kind: c.kind, tier: c.tier,
    restoreLayer: c.restoreLayer, inRecoveryScope: c.inRecoveryScope,
    dependsOn: c.dependsOn || [], gaps: c.gaps || [],
    verification: c.verification, description: c.description,
  }));
  slim.snapshotNote = 'Very large workspace: all collections truncated to summaries.';
  return JSON.stringify(slim).slice(0, SNAPSHOT_CAP);
}

// An empty CLI response is a different problem from a malformed one (usually a
// transient hiccup worth retrying) — say which, and always hand back the raw.
function noJsonResult(r) {
  return {
    ok: false,
    message: String(r.text || '').trim()
      ? 'The AI did not return parseable JSON.'
      : 'The Claude CLI returned an empty response — try again.',
    raw: r.text,
  };
}

// Tolerant JSON-object extractor: first '{' to last '}'.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Validate operations against the live workspace. Invalid ops are kept and
// annotated {valid:false, problem} so the UI can grey them out. Create data
// always has any model-invented id stripped.
export function validateOperations(slug, operations) {
  const idCache = {};
  const existingIds = (col) => {
    if (!idCache[col]) idCache[col] = new Set(store.getCollection(slug, col).map((x) => x.id));
    return idCache[col];
  };
  return (operations || []).map((raw) => {
    const op = { why: '', ...raw };
    const fail = (problem) => ({ ...op, valid: false, problem });
    if (!raw || typeof raw !== 'object') return { op: 'unknown', valid: false, problem: 'not an object' };
    if (!OPS.includes(op.op)) return fail(`unknown op '${op.op}'`);
    if (op.op === 'update-workspace') {
      if (!op.data || typeof op.data !== 'object' || Array.isArray(op.data) || !Object.keys(op.data).length) return fail('update-workspace needs a data object with fields to merge');
      const clean = { ...op.data };
      delete clean.slug; delete clean.createdAt; delete clean.updatedAt;
      return { ...op, data: clean, valid: true };
    }
    if (!store.COLLECTIONS.includes(op.collection)) return fail(`unknown collection '${op.collection}'`);
    if (op.op === 'create') {
      if (!op.data || typeof op.data !== 'object' || Array.isArray(op.data)) return fail('create needs a data object');
      const nameField = ['gaps', 'decisions'].includes(op.collection) ? 'title' : 'name';
      if (!String(op.data[nameField] || '').trim()) return fail(`create ${op.collection} needs a non-empty "${nameField}"`);
      const clean = { ...op.data };
      delete clean.id; // server assigns ids
      return { ...op, data: clean, valid: true };
    }
    // update / delete need an existing id
    if (!op.id || !existingIds(op.collection).has(op.id)) return fail(`no ${op.collection} item with id '${op.id || '(missing)'}'`);
    if (op.op === 'update' && (!op.data || typeof op.data !== 'object' || Array.isArray(op.data) || !Object.keys(op.data).length)) {
      return fail('update needs a data object with changed fields');
    }
    return { ...op, valid: true };
  });
}

const COPILOT_PREAMBLE =
  'You are the AI copilot inside DR Compass, a disaster recovery planning tool. ' +
  'You edit the workspace by emitting operations. You are precise, practical, and conservative: ' +
  'propose only what the instruction asks for, referencing existing items by their exact ids.';

// ---------------------------------------------------------------------------
// AI correlation: propose links from unlinked resource-graph nodes and
// unlinked Kubernetes workloads to inventory components. Read-only — the
// /ai/correlate/apply route performs the writes the user approves.

const CORRELATE_CAP = 120 * 1024; // ~120KB of serialized correlation context

export async function correlate({ slug } = {}) {
  let components, graph, k8s;
  try {
    components = store.getCollection(slug, 'components');
    graph = store.getObject(slug, 'resource-graph');
    k8s = store.getObject(slug, 'k8s');
  } catch (e) {
    return { ok: false, message: `Could not read workspace '${slug}': ${e.message}` };
  }

  const compIndex = new Map(components.map((c) => [c.id, c]));
  const nodes = graph && typeof graph === 'object' && graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : {};
  const nodeList = Object.values(nodes).filter((n) => n && n.rid);
  const unlinkedNodes = nodeList.filter((n) => !(Array.isArray(n.componentIds) && n.componentIds.length));
  const workloads = k8s && Array.isArray(k8s.workloads) ? k8s.workloads.filter((w) => w && w.uid) : [];
  const unlinkedWorkloads = workloads.filter((w) => !w.componentId);

  if (!compIndex.size) return { ok: false, message: 'No components in the inventory yet — nothing to correlate against.' };
  if (!unlinkedNodes.length && !unlinkedWorkloads.length) {
    return {
      ok: true, links: [],
      message: 'Nothing unlinked to correlate — every discovered resource and Kubernetes workload is already linked to a component.',
    };
  }

  const compact = {
    components: components.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, category: c.category, awsServices: c.awsServices || [],
    })),
    unlinkedResources: unlinkedNodes.map((n) => ({
      rid: n.rid, type: n.type || '', name: n.name || '', service: n.service || '', region: n.region || '',
      ...(n.tags && Object.keys(n.tags).length ? { tags: n.tags } : {}),
    })),
    unlinkedWorkloads: unlinkedWorkloads.map((w) => ({
      workloadUid: w.uid, kind: w.kind || '', namespace: w.namespace || '', name: w.name || '',
      images: Array.isArray(w.images) ? w.images.slice(0, 3) : [],
    })),
  };
  let json = JSON.stringify(compact);
  while (json.length > CORRELATE_CAP && compact.unlinkedResources.length > 10) {
    compact.unlinkedResources = compact.unlinkedResources.slice(0, Math.floor(compact.unlinkedResources.length / 2));
    compact.truncated = true;
    json = JSON.stringify(compact);
  }

  const fullPrompt =
    `${PREAMBLE}\n\n` +
    'Below are (1) the DR inventory components and (2) discovered AWS resources and Kubernetes workloads ' +
    `that are NOT yet linked to any component:\n${json}\n\n` +
    'For each unlinked resource or workload that clearly belongs to one of the components, propose a link. ' +
    'Match on names, AWS services, resource types, tags, namespaces, and container images. ' +
    'Skip anything you cannot place with reasonable confidence.\n\n' +
    'Respond with ONLY a JSON object — no prose, no markdown fences — of this exact shape:\n' +
    '{"links":[{"rid":"<rid of an unlinked resource>","componentId":"<existing component id>","confidence":0.85,"why":"short reason"},' +
    '{"workloadUid":"<uid of an unlinked workload>","componentId":"<existing component id>","confidence":0.9,"why":"short reason"}]}\n' +
    'Each link has exactly one of "rid" or "workloadUid". "confidence" is a number from 0 to 1. ' +
    'Use only rids, workloadUids, and componentIds that appear above. Output valid JSON only.';

  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  const obj = extractJsonObject(r.text);
  if (!obj || !Array.isArray(obj.links)) {
    return { ok: false, message: 'The AI did not return parseable JSON with a "links" array.', raw: r.text };
  }

  const nodeById = new Map(nodeList.map((n) => [String(n.rid), n]));
  const wlById = new Map(workloads.map((w) => [String(w.uid), w]));
  const links = [];
  for (const raw of obj.links) {
    if (!raw || typeof raw !== 'object') continue;
    const rid = raw.rid !== undefined && raw.rid !== null ? String(raw.rid) : '';
    const workloadUid = raw.workloadUid !== undefined && raw.workloadUid !== null ? String(raw.workloadUid) : '';
    const componentId = String(raw.componentId || '');
    const confidence = Number(raw.confidence);
    if ((rid ? 1 : 0) + (workloadUid ? 1 : 0) !== 1) continue; // exactly one target
    if (!compIndex.has(componentId)) continue;                 // component must exist
    if (rid && !nodeById.has(rid)) continue;                   // rid must exist
    if (workloadUid && !wlById.has(workloadUid)) continue;     // workload must exist
    if (!Number.isFinite(confidence)) continue;                // confidence numeric
    const comp = compIndex.get(componentId);
    const link = {
      componentId,
      componentName: comp.name || componentId,
      confidence: Math.max(0, Math.min(1, confidence)),
      why: typeof raw.why === 'string' ? raw.why.slice(0, 300) : '',
    };
    if (rid) {
      const n = nodeById.get(rid);
      link.rid = rid;
      link.targetName = n.name || rid;
      link.targetType = n.type || 'resource';
    } else {
      const w = wlById.get(workloadUid);
      link.workloadUid = workloadUid;
      link.targetName = `${w.kind || 'Workload'}/${w.name || workloadUid}`;
      link.targetType = 'k8s-workload';
    }
    links.push(link);
  }
  return {
    ok: true, links,
    counts: { unlinkedResources: unlinkedNodes.length, unlinkedWorkloads: unlinkedWorkloads.length },
  };
}

// ---------------------------------------------------------------------------
// AI ordering assist (deployment / recovery order engine).
//
// Sends ONLY the ambiguous subgraph the engine could not resolve — the cycle
// members, the unordered items, and the low-confidence edges between them —
// never the whole workspace. Returns SUGGESTIONS; the caller never auto-applies
// them.

const ORDERING_CAP = 60 * 1024;
const ORDERING_KINDS = ['break-cycle', 'order', 'add-dependency'];

export async function suggestOrdering({ slug, subgraph } = {}) {
  const sg = subgraph && typeof subgraph === 'object' ? subgraph : null;
  const hasWork = sg && ((Array.isArray(sg.nodes) && sg.nodes.length)
    || (Array.isArray(sg.unordered) && sg.unordered.length)
    || (Array.isArray(sg.cycles) && sg.cycles.length));
  if (!hasWork) return { ok: false, message: 'No ambiguous subgraph to reason about.' };
  let meta = null;
  try { meta = store.getWorkspace(slug); } catch { /* optional */ }

  const compact = {
    workspace: meta ? { name: meta.name, regions: meta.regions, strategy: meta.strategy } : undefined,
    nodes: sg.nodes,
    anchors: sg.anchors,
    edges: sg.edges,
    cycles: sg.cycles,
    unordered: sg.unordered,
    callOrderIssues: sg.callOrderIssues,
  };
  let json = JSON.stringify(compact);
  if (json.length > ORDERING_CAP) {
    compact.edges = (compact.edges || []).slice(0, 120);
    compact.truncated = true;
    json = JSON.stringify(compact).slice(0, ORDERING_CAP);
  }

  const fullPrompt =
    'You are helping order the deployment of AWS and Kubernetes resources for a disaster-recovery '
    + 'bring-up. An engine has already built the dependency graph; below is ONLY the part it could not '
    + 'resolve — dependency cycles it had to break, items it could not place, and start-up calls whose '
    + 'ordering is wrong or unknown.\n\n'
    + `${QUALITY_RULES}\n\n`
    + 'Ordering ground rules: an edge "from -> to" means `from` must exist (or be Ready) before `to`. '
    + '`requires` is "exists", "ready" (the workload must pass readiness, not merely be created) or '
    + '"verified" (an external precondition you cannot deploy). `confidence` is how sure the engine is '
    + 'about that edge; `setAside: true` marks an edge the engine ignored in order to produce an order.\n\n'
    + `Ambiguous subgraph (JSON):\n${json}\n\n`
    + 'For each problem, suggest the single most defensible fix. Prefer breaking the edge that is least '
    + 'likely to be a real start-up dependency, and say what would happen if you are wrong. Where two '
    + 'application workloads call each other, say plainly that production survives this through retry and '
    + 'backoff and that one side will CrashLoop until the other answers — do not pretend there is a clean order.\n\n'
    + 'Respond with ONLY a JSON object — no prose outside it, no markdown fences:\n'
    + '{"suggestions":[{"kind":"break-cycle|order|add-dependency","from":"<node id>","to":"<node id>",'
    + '"why":"one or two sentences an operator can act on","confidence":0.0-1.0}],"notes":"optional"}\n'
    + 'Use ONLY ids that appear in "nodes" or "anchors" above ("anchors" are the inventory components, offered so you can attach an unordered item to something real). '
    + 'A node with "unordered": true was not placed in any wave — its "reason" says why; the useful answer there is usually an "add-dependency" that puts it after the thing it actually needs.  "break-cycle" means remove the from->to edge; '
    + '"order" means from must come before to; "add-dependency" means a prerequisite the engine is missing. '
    + 'If a problem genuinely has no good answer from this data, say so in "notes" rather than inventing one. '
    + 'Output valid JSON only.';

  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  const obj = extractJsonObject(r.text);
  if (!obj || !Array.isArray(obj.suggestions)) {
    return { ok: false, message: 'The AI did not return parseable JSON with a "suggestions" array.', raw: r.text };
  }
  const known = new Set([
    ...(sg.nodes || []).map((n) => String(n.id)),
    ...(sg.anchors || []).map((n) => String(n.id)),
  ]);
  const nameOf = (id) => {
    const hit = [...(sg.nodes || []), ...(sg.anchors || [])].find((n) => String(n.id) === id);
    return (hit && hit.name) || id;
  };
  const suggestions = [];
  for (const raw of obj.suggestions) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = ORDERING_KINDS.includes(raw.kind) ? raw.kind : null;
    const from = String(raw.from || '');
    const to = String(raw.to || '');
    const confidence = Number(raw.confidence);
    if (!kind || !known.has(from) || !known.has(to) || from === to) continue;
    suggestions.push({
      kind, from, to,
      fromName: nameOf(from),
      toName: nameOf(to),
      why: typeof raw.why === 'string' ? raw.why.slice(0, 600) : '',
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    });
  }
  suggestions.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)
    || a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from));
  return {
    ok: true,
    suggestions,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    applied: false,
    counts: {
      nodes: sg.nodes.length, edges: (sg.edges || []).length,
      cycles: (sg.cycles || []).length, unordered: (sg.unordered || []).length,
    },
  };
}

export async function propose({ slug, instruction, page } = {}) {
  if (!instruction || !String(instruction).trim()) return { ok: false, message: 'Empty instruction' };
  let snapshot;
  try { snapshot = buildSnapshot(slug); }
  catch (e) { return { ok: false, message: `Could not read workspace '${slug}': ${e.message}` }; }
  const fullPrompt =
    `${COPILOT_PREAMBLE}\n\n` +
    `Current workspace snapshot (complete JSON):\n${snapshot}\n\n` +
    `Schema cheat-sheet:\n${SCHEMA_CHEATSHEET}\n\n` +
    (page ? `The user is currently on the "${page}" page of the app.\n\n` : '') +
    `User instruction:\n${String(instruction).trim()}\n\n` +
    OPS_INSTRUCTIONS;
  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  const obj = extractJsonObject(r.text);
  if (!obj) return noJsonResult(r);
  const operations = validateOperations(slug, Array.isArray(obj.operations) ? obj.operations : []);
  return {
    ok: true,
    summary: String(obj.summary || '').trim(),
    operations,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
  };
}

// ---------------------------------------------------------------------------
// Focused context — the quality lever behind every contextual AI action.
//
// Instead of dumping the whole workspace at the model, assemble the object the
// user is actually looking at, its immediate neighbors, workspace meta, and the
// slice of schema that matters. A focused 8KB prompt beats a 120KB one.

const LAYER_NOTE =
  'Restore layers, ordered: L0 guardrails/backups green, L1 recovery launch/replication, ' +
  'L2 platform (cluster/nodes/mesh), L3 data + secrets, L4 applications, ' +
  'L5 edge/network reachability, L6 functional success bar (a real business transaction), ' +
  'L7 live traffic cutover (game day only).';

const CATEGORY_NOTE = `component.category is one of: ${CATEGORIES.join(' | ')}.`;

const SCHEMA_NOTES = {
  component: [
    'component: {name, category, tier(int, 0 = most critical), owner, team, description, kind, drStrategy, restoreLayer(L0..L7), replication{mechanism,rpoMinutes,notes}, inRecoveryScope(yes|no|partial|unknown), definedIn, dependsOn[cmp_* ids], outboundCalls[{target,type(aws-service|third-party|saas|internal|on-prem),protocol,purpose,failoverBehavior,critical}], awsServices[], secrets[{name,arn,replicated,notes}], endpoints[{name,url,healthCheck}], verification{command,pass}, gaps[strings], notes, tags[]}',
    CATEGORY_NOTE, LAYER_NOTE,
    'verification.command must be a command a human can paste (kubectl / aws / curl / psql); verification.pass is the output that counts as recovered.',
  ].join('\n'),
  runbook: [
    'runbook: {name, tooling, scenario, audience, preconditions[strings], steps[{id,layer(L0..L7),title,detail,command,verify,pass,owner,estMinutes,record,componentIds[],gate(bool)}], rollback[same step shape], linkedTestIds[], notes}',
    LAYER_NOTE,
    'A step with gate:true must not be passed until its verify/pass criterion is met. Steps are ordered by restore layer; a step that has no verify is a step nobody can gate.',
  ].join('\n'),
  test: [
    'test: {name, type(recovery-test|game-day|tabletop|component-test|chaos), status(planned|in-progress|passed|failed|canceled), date(YYYY-MM-DD), runbookId, scope, appTests[{name,command,expected,componentId,critical,result(pass|fail|null)}], timestamps{t0,tFirstAccess,t1}, results{rtaMinutes,rpaMinutes,cleanRun}, findings[{title,severity(blocker|high|medium|low),gapId,ticket}], record(markdown)}',
    'gap: {title, category, class, severity(blocker|high|medium|low), componentId, status(open|accepted|resolved), ticket, notes}',
    'timestamps: t0 = recovery initiated, tFirstAccess = first useful access, t1 = success bar met. results.rtaMinutes = t1 - t0 (MEASURED). results.rpaMinutes = data age at t0 (MEASURED, entered by hand).',
  ].join('\n'),
  checklist: [
    'checklist: {name, kind(phase0|preflight|game-day|weekly|custom), items[{id,text,why,proof,owner,done(bool)}]}',
    'Every item needs a "proof": the artifact or command output that shows it is done. An item without proof is an opinion.',
  ].join('\n'),
  workspace: [
    'workspace: {name, org, description, regions{primary,recovery}, objectives{rtoMinutes,rpoMinutes,rtaMinutes,rpaMinutes,approved,notes}, strategy(backup-restore|pilot-light|warm-standby|active-active), tooling[arpio|region-switch|arc-routing-controls|elastic-dr|gitops-iac|resilience-hub|backup]}',
    // This line used to read "objectives.rtaMinutes/rpaMinutes are the MEASURED
    // results copied from a real test" — which is exactly what they are not.
    // They are free number inputs on the Settings screen, linked to nothing.
    'objectives.rtoMinutes/rpoMinutes are TARGETS. objectives.rtaMinutes/rpaMinutes are FREE-TEXT NUMBER FIELDS a person typed on the Settings screen: they are NOT linked to any test and are NOT evidence on their own. Ignore them for any claim about what has been achieved and read workspace.measured instead — that block is computed from the test records and states, per number, whether it is "measured" (a passed test produced it), "declared" (hand-typed, not evidence) or "unmeasured".',
    'workspace.measured: {rta:{minutes,state,test{id,name,date,status},note}, rpa:{...}, target:{rtoMinutes,rpoMinutes,approved}, verdict:{rto,rpo,overall,why}, warnings[]}. Never call a "declared" or "unmeasured" number measured, achieved or met, and always name the test beside a "measured" one.',
    CATEGORY_NOTE, LAYER_NOTE,
  ].join('\n'),
  article: [
    'The article is reference material from the app\'s knowledge base. The inventory below is the reader\'s real stack.',
    CATEGORY_NOTE, LAYER_NOTE,
  ].join('\n'),
};

const FOCUS_KINDS = ['component', 'runbook', 'test', 'checklist', 'workspace', 'article', 'inventory'];

const clip = (s, n) => {
  const str = s === null || s === undefined ? '' : String(s);
  return str.length > n ? `${str.slice(0, n)}… [truncated]` : str;
};

const compSummary = (c) => ({
  id: c.id, name: c.name, category: c.category, kind: c.kind, tier: c.tier ?? null,
  restoreLayer: c.restoreLayer || '', inRecoveryScope: c.inRecoveryScope || 'unknown',
  dependsOn: c.dependsOn || [],
  hasVerification: !!(c.verification && c.verification.command),
  gapCount: (c.gaps || []).length,
});

const compNeighbor = (c) => ({
  ...compSummary(c),
  description: clip(c.description, 400),
  replication: c.replication || null,
  awsServices: c.awsServices || [],
  verification: c.verification || null,
});

const rbSummary = (rb) => ({
  id: rb.id, name: rb.name, tooling: rb.tooling || '', scenario: rb.scenario || '',
  steps: (rb.steps || []).length, rollbackSteps: (rb.rollback || []).length,
  gatedSteps: (rb.steps || []).filter((s) => s && s.gate).length,
  stepsWithoutVerify: (rb.steps || []).filter((s) => s && !String(s.verify || '').trim()).length,
  estMinutes: (rb.steps || []).reduce((n, s) => n + (Number(s && s.estMinutes) || 0), 0),
});

const testSummary = (t) => ({
  id: t.id, name: t.name, type: t.type, status: t.status, date: t.date || '',
  runbookId: t.runbookId || '',
  results: t.results || null,
  findings: (t.findings || []).map((f) => ({ title: f.title, severity: f.severity, gapId: f.gapId || '' })),
  appTestCount: (t.appTests || []).length,
  hasRecord: !!String(t.record || '').trim(),
});

const chkSummary = (c) => ({
  id: c.id, name: c.name, kind: c.kind,
  items: (c.items || []).length,
  done: (c.items || []).filter((i) => i && i.done).length,
  itemsWithoutProof: (c.items || []).filter((i) => i && !String(i.proof || '').trim()).length,
});

const wsMeta = (w, tests, components = []) => (w ? {
  slug: w.slug, name: w.name, org: w.org || '', description: clip(w.description, 600),
  regions: w.regions || null, objectives: w.objectives || null,
  // The block the model must actually read for any claim about achievement.
  // Never omitted, so there is no context shape in which the raw objectives
  // are the only numbers on offer.
  measured: honestNumbers(w, tests || [], components || []),
  strategy: w.strategy || '', tooling: w.tooling || [],
} : null);

function readAll(slug) {
  const out = { workspace: null, components: [], runbooks: [], tests: [], checklists: [], gaps: [], decisions: [], contacts: [] };
  try { out.workspace = store.getWorkspace(slug); } catch { /* keep null */ }
  for (const col of store.COLLECTIONS) {
    try { out[col] = store.getCollection(slug, col) || []; } catch { out[col] = []; }
  }
  return out;
}

function dataQuality(all) {
  const c = all.components;
  return {
    components: c.length,
    withoutVerification: c.filter((x) => !(x.verification && x.verification.command)).length,
    withoutRestoreLayer: c.filter((x) => !x.restoreLayer).length,
    notInRecoveryScope: c.filter((x) => x.inRecoveryScope === 'no').length,
    scopeUnknown: c.filter((x) => (x.inRecoveryScope || 'unknown') === 'unknown').length,
    tier0: c.filter((x) => x.tier === 0).length,
    openGaps: all.gaps.filter((g) => (g.status || 'open') === 'open').length,
    runbooks: all.runbooks.length,
    testsRun: all.tests.filter((t) => ['passed', 'failed'].includes(t.status)).length,
    testsPlanned: all.tests.filter((t) => t.status === 'planned').length,
  };
}

// Returns {kind, id, json, bytes, truncated} — `json` is always a string.
export function buildFocusedContext(slug, selector = {}) {
  const sel = selector && typeof selector === 'object' ? selector : {};
  let kind = FOCUS_KINDS.includes(sel.kind) ? sel.kind : 'workspace';
  const id = sel.id ? String(sel.id) : '';
  const all = readAll(slug);
  const ctx = { focus: { kind, id: id || undefined }, workspace: wsMeta(all.workspace, all.tests, all.components) };
  const openGaps = all.gaps.filter((g) => (g.status || 'open') !== 'resolved')
    .map((g) => ({ id: g.id, title: g.title, severity: g.severity, class: g.class || '', componentId: g.componentId || '', status: g.status || 'open' }));

  const notFound = (what) => { ctx.focusProblem = `No ${what} with id '${id}' in this workspace — answer from the workspace context instead, and say so.`; };

  if (kind === 'component') {
    const c = all.components.find((x) => x.id === id);
    if (!c) { notFound('component'); kind = 'workspace'; } else {
      ctx.component = c;
      ctx.dependsOn = (c.dependsOn || []).map((d) => {
        const n = all.components.find((x) => x.id === d);
        return n ? compNeighbor(n) : { id: d, missing: true };
      });
      ctx.usedBy = all.components.filter((o) => (o.dependsOn || []).includes(c.id)).map(compSummary);
      ctx.trackedGaps = all.gaps.filter((g) => g.componentId === c.id)
        .map((g) => ({ id: g.id, title: g.title, severity: g.severity, status: g.status || 'open' }));
      ctx.appearsInRunbookSteps = all.runbooks.flatMap((rb) => (rb.steps || [])
        .filter((s) => (s.componentIds || []).includes(c.id))
        .map((s) => ({ runbookId: rb.id, runbook: rb.name, layer: s.layer, title: s.title, verify: s.verify || '', pass: s.pass || '', gate: !!s.gate })));
      ctx.appearsInTests = all.tests.flatMap((t) => (t.appTests || [])
        .filter((a) => a.componentId === c.id)
        .map((a) => ({ testId: t.id, test: t.name, appTest: a.name, expected: a.expected || '', result: a.result ?? null })));
      ctx.inventoryIndex = all.components.filter((x) => x.id !== c.id).map(compSummary);
    }
  } else if (kind === 'runbook') {
    const rb = all.runbooks.find((x) => x.id === id);
    if (!rb) { notFound('runbook'); kind = 'workspace'; } else {
      ctx.runbook = rb;
      const ids = new Set((rb.steps || []).concat(rb.rollback || []).flatMap((s) => s.componentIds || []));
      ctx.referencedComponents = all.components.filter((c) => ids.has(c.id)).map(compNeighbor);
      ctx.linkedTests = all.tests.filter((t) => t.runbookId === rb.id || (rb.linkedTestIds || []).includes(t.id)).map(testSummary);
      ctx.inventoryIndex = all.components.filter((c) => !ids.has(c.id)).map(compSummary);
      ctx.openGaps = openGaps;
    }
  } else if (kind === 'test') {
    const t = all.tests.find((x) => x.id === id);
    if (!t) { notFound('test'); kind = 'workspace'; } else {
      ctx.test = { ...t, record: clip(t.record, 12000) };
      const rb = all.runbooks.find((x) => x.id === t.runbookId);
      ctx.runbook = rb ? {
        id: rb.id, name: rb.name, tooling: rb.tooling, scenario: rb.scenario,
        preconditions: rb.preconditions || [],
        steps: (rb.steps || []).map((s) => ({ id: s.id, layer: s.layer, title: s.title, verify: s.verify || '', pass: s.pass || '', gate: !!s.gate, estMinutes: s.estMinutes ?? null, componentIds: s.componentIds || [] })),
        rollbackSteps: (rb.rollback || []).length,
      } : null;
      const compIds = new Set((t.appTests || []).map((a) => a.componentId).filter(Boolean));
      ctx.referencedComponents = all.components.filter((c) => compIds.has(c.id)).map(compNeighbor);
      ctx.findingGaps = all.gaps.filter((g) => (t.findings || []).some((f) => f.gapId === g.id));
      ctx.otherTests = all.tests.filter((x) => x.id !== t.id).map(testSummary);
      ctx.inventoryIndex = all.components.map(compSummary);
    }
  } else if (kind === 'checklist') {
    const cl = all.checklists.find((x) => x.id === id);
    if (!cl && id) { notFound('checklist'); } else if (cl) ctx.checklist = cl;
    ctx.otherChecklists = all.checklists.filter((x) => !cl || x.id !== cl.id).map(chkSummary);
    ctx.openGaps = openGaps;
    ctx.dataQuality = dataQuality(all);
    ctx.inventoryIndex = all.components.map(compSummary);
    ctx.runbooks = all.runbooks.map(rbSummary);
  } else if (kind === 'article') {
    ctx.article = {
      id: id || (sel.extra && sel.extra.id) || '',
      title: (sel.extra && sel.extra.title) || '',
      section: (sel.extra && sel.extra.section) || '',
      markdown: clip(sel.extra && sel.extra.markdown, 22000),
    };
    ctx.inventoryIndex = all.components.map(compSummary);
    ctx.dataQuality = dataQuality(all);
    ctx.runbooks = all.runbooks.map(rbSummary);
    ctx.tests = all.tests.map(testSummary);
  }

  if (kind === 'workspace' || kind === 'inventory') {
    ctx.inventory = all.components.map(kind === 'inventory' ? compNeighbor : compSummary);
    ctx.runbooks = all.runbooks.map(rbSummary);
    ctx.tests = all.tests.map(testSummary);
    ctx.checklists = all.checklists.map(chkSummary);
    ctx.gaps = all.gaps.map((g) => ({ id: g.id, title: g.title, severity: g.severity, status: g.status || 'open', class: g.class || '', componentId: g.componentId || '', notes: clip(g.notes, 300) }));
    ctx.decisions = all.decisions.map((d) => ({ id: d.id, date: d.date, title: d.title, status: d.status }));
    ctx.dataQuality = dataQuality(all);
  }

  ctx.schemaNotes = SCHEMA_NOTES[kind] || SCHEMA_NOTES.workspace;
  if (sel.extra && typeof sel.extra === 'object' && kind !== 'article') {
    try { ctx.extra = JSON.parse(clip(JSON.stringify(sel.extra), 8000).replace(/… \[truncated\]$/, '')); }
    catch { ctx.extra = { note: 'extra context omitted (too large or not serializable)' }; }
  }

  let json = JSON.stringify(ctx);
  let truncated = false;
  // Degrade the widest lists first, then hard-slice as a last resort.
  if (json.length > FOCUS_CAP && Array.isArray(ctx.inventoryIndex)) {
    ctx.inventoryIndex = ctx.inventoryIndex.map((c) => ({ id: c.id, name: c.name, kind: c.kind, restoreLayer: c.restoreLayer }));
    truncated = true;
    json = JSON.stringify(ctx);
  }
  if (json.length > FOCUS_CAP && Array.isArray(ctx.inventory)) {
    ctx.inventory = ctx.inventory.map(compSummary);
    truncated = true;
    json = JSON.stringify(ctx);
  }
  if (json.length > FOCUS_CAP) {
    ctx.contextNote = 'Context was truncated to fit — some neighbors are missing. Say so if it affects the answer.';
    truncated = true;
    json = JSON.stringify(ctx).slice(0, FOCUS_CAP);
  }
  return { kind, id, json, bytes: json.length, truncated };
}

// ---------------------------------------------------------------------------
// draft: the generic "make me a thing" endpoint behind every contextual button
// that writes data. Same operation shape and validation as propose(), but with
// a focused context instead of the whole-workspace snapshot.

export async function draft({ slug, kind, instruction, context } = {}) {
  if (!instruction || !String(instruction).trim()) return { ok: false, message: 'Empty instruction' };
  let focused;
  try { focused = buildFocusedContext(slug, context || { kind: kind || 'workspace' }); }
  catch (e) { return { ok: false, message: `Could not read workspace '${slug}': ${e.message}` }; }
  const fullPrompt =
    `${COPILOT_PREAMBLE}\n\n${QUALITY_RULES}\n\n` +
    `Focused context — the ${focused.kind} the user is working on, its neighbors, and workspace meta (JSON):\n${focused.json}\n\n` +
    `Schema cheat-sheet (the ONLY fields that exist):\n${SCHEMA_CHEATSHEET}\n\n` +
    `User instruction:\n${String(instruction).trim()}\n\n` +
    OPS_INSTRUCTIONS;
  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  const obj = extractJsonObject(r.text);
  if (!obj) return noJsonResult(r);
  const operations = validateOperations(slug, Array.isArray(obj.operations) ? obj.operations : []);
  return {
    ok: true,
    summary: String(obj.summary || '').trim(),
    operations,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    context: { kind: focused.kind, id: focused.id, bytes: focused.bytes, truncated: focused.truncated },
  };
}

// ---------------------------------------------------------------------------
// review: a critique of one object. Read-only — returns markdown plus
// structured findings the UI can list by severity.

const REVIEW_KINDS = ['runbook', 'test', 'component', 'checklist', 'inventory', 'plan', 'workspace'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'];

const REVIEW_FOCUS = {
  runbook: 'Review this runbook as an operator who will be woken at 3am to run it. Check: steps ordered by restore layer (a step that needs data before the data layer is restored is a defect); every step has a verify AND a pass criterion; gates on the steps that must not be passed blind; a rollback path that actually reverses the steps; realistic per-step timings that add up to something compatible with the RTO target; the components it touches versus the components in the inventory it silently omits; secrets, DNS/edge, and third-party allowlists (the usual silent failures); who owns each step.',
  test: 'Review this test as an auditor. Check: whether the measured RTA/RPA are actually measured (timestamps present) or missing; whether the app-level tests define a real business success bar rather than pod counts; whether failures were recorded honestly and each finding became a gap or ticket; whether the record covers what went wrong, not just what passed; whether the claimed status matches the evidence.',
  component: 'Review this component\'s DR readiness. Check: replication mechanism and whether its RPO is credible; whether it is in recovery scope; whether dependencies are complete (data stores, secrets, queues, DNS, third-party endpoints); whether the verification command would really prove recovery and whether its pass criterion is checkable; whether its restore layer is consistent with what it depends on.',
  checklist: 'Review this checklist as a gate. Check: whether each item is objectively verifiable with a named proof; whether items are ordered so earlier gates make later ones possible; what the workspace\'s real gaps and data-quality problems suggest is missing.',
  inventory: 'Review this inventory for completeness and honesty. Check: missing categories (secrets, DNS/edge, identity, observability, CI/CD control plane, third-party egress); components with no verification or no restore layer; components out of recovery scope that Tier-0 work depends on; dependency edges that are obviously missing; replication claims with no RPO.',
  plan: 'Review this DR plan end to end: strategy versus the RTO/RPO targets, tooling fit, whether runbooks cover the declared scenarios, whether tests have actually measured anything, and which gaps make the stated objectives unachievable today.',
  workspace: 'Review this DR program: objectives versus measured results, inventory completeness, runbook and test coverage, and the open gaps that matter most.',
};

export async function review({ slug, kind, id } = {}) {
  const k = REVIEW_KINDS.includes(kind) ? kind : 'workspace';
  const focusKind = k === 'plan' ? 'workspace' : k;
  let focused;
  try { focused = buildFocusedContext(slug, { kind: focusKind, id }); }
  catch (e) { return { ok: false, message: `Could not read workspace '${slug}': ${e.message}` }; }
  const fullPrompt =
    'You are reviewing disaster recovery artifacts inside DR Compass. You are a rigorous, ' +
    'specific reviewer: every finding names the thing that is wrong and what to do about it. ' +
    'You do not pad the review with praise, and you do not invent problems to look thorough.\n\n' +
    `${QUALITY_RULES}\n\n` +
    `Focused context (JSON):\n${focused.json}\n\n` +
    `Schema notes:\n${SCHEMA_NOTES[focusKind] || SCHEMA_NOTES.workspace}\n\n` +
    `What to review:\n${REVIEW_FOCUS[k] || REVIEW_FOCUS.workspace}\n\n` +
    'Respond with ONLY a JSON object — no prose outside it, no markdown fences:\n' +
    '{"markdown":"the review, as tight markdown the reader can act on",' +
    '"findings":[{"severity":"blocker|high|medium|low|info","title":"short, specific","detail":"what is wrong, which id it affects, and the fix"}]}\n' +
    'Order findings worst-first. Use "blocker" only for something that would make a real recovery fail. ' +
    'If the artifact is genuinely sound, return few or no findings and say so in the markdown. Output valid JSON only.';
  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  const obj = extractJsonObject(r.text);
  if (!obj) {
    if (!String(r.text || '').trim()) return noJsonResult(r);
    // Still useful: hand back the prose as the review body.
    return { ok: true, kind: k, id: id || '', markdown: r.text, findings: [], parsed: false };
  }
  const findings = (Array.isArray(obj.findings) ? obj.findings : [])
    .map((f) => (f && typeof f === 'object' ? {
      severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
      title: clip(f.title, 200),
      detail: clip(f.detail, 1200),
    } : null))
    .filter((f) => f && f.title);
  return {
    ok: true, kind: k, id: id || '', parsed: true,
    markdown: typeof obj.markdown === 'string' ? obj.markdown : '',
    findings,
    context: { kind: focused.kind, bytes: focused.bytes, truncated: focused.truncated },
  };
}

// ---------------------------------------------------------------------------
// narrative: prose for humans (exec summary, posture, weekly plan). Markdown,
// grounded in the workspace's real gaps/tests, with the honest-numbers rule
// stated twice because this is the output most likely to be pasted into a deck.

const NARRATIVES = {
  'executive-summary': {
    title: 'Executive summary',
    brief: 'Write a one-page executive summary of this DR program for a leadership audience that is not on the platform team. ' +
      'Lead with where recovery stands today, not with activity. Cover: what the program protects, the agreed RTO/RPO targets and whether anything has been MEASURED against them, ' +
      'what has actually been tested and what the test found, the top risks by business impact (cite the real gaps by title), and what is being done next. ' +
      'Sections: Where we stand · What we have proven · Top risks · What changes next. Under 600 words.',
  },
  posture: {
    title: 'Recovery posture',
    brief: 'Write a technical posture assessment for the platform/SRE team that owns this recovery. ' +
      'Cover: strategy versus targets, inventory completeness (name the categories or components that are missing verification, restore layers, or recovery scope), ' +
      'replication and data-loss exposure, runbook coverage per scenario, test evidence (which test, which date, what it measured), and the gaps that would make a real failover fail. ' +
      'Be blunt about what is unproven. Sections: Summary · Inventory · Data · Runbooks · Evidence · What would fail today. Under 900 words.',
  },
  'weekly-plan': {
    title: 'Weekly plan',
    brief: 'Write next week\'s DR plan for the team: at most 7 concrete actions, worst-risk first, each one a single week-sized task with a named artifact it produces ' +
      '(a gap closed, a verification command added, a runbook step written, a test scheduled). Cite the real component/gap/runbook ids or names each action touches, ' +
      'and say what it unblocks. End with "Not this week" — the things you are deliberately deferring and why. Under 500 words.',
  },
};

export const NARRATIVE_KINDS = Object.keys(NARRATIVES);

export async function narrative({ slug, kind } = {}) {
  const spec = NARRATIVES[kind];
  if (!spec) return { ok: false, message: `Unknown narrative kind '${kind}' — expected one of ${NARRATIVE_KINDS.join(', ')}` };
  let focused;
  try { focused = buildFocusedContext(slug, { kind: 'workspace' }); }
  catch (e) { return { ok: false, message: `Could not read workspace '${slug}': ${e.message}` }; }
  const fullPrompt =
    'You are writing a disaster recovery document inside DR Compass, from a real workspace\'s data. ' +
    'Everything you write must be traceable to the JSON below.\n\n' +
    `${QUALITY_RULES}\n\n` +
    `Workspace context (JSON):\n${focused.json}\n\n` +
    `Schema notes:\n${SCHEMA_NOTES.workspace}\n\n` +
    `Document to write: ${spec.title}\n${spec.brief}\n\n` +
    'Hard rules for this document:\n' +
    '- Never state an RTO or RPO number that is not in workspace.objectives, and always label it as a target.\n' +
    '- Quote RTA/RPA only from a test\'s results (name the test and its date). If results are null, write "unmeasured" — never estimate.\n' +
    '- Cite the workspace\'s real gaps, tests, runbooks, and components by their actual titles/names. Do not invent examples.\n' +
    '- If the data cannot support a section, say what is missing in one line instead of filling it with generalities.\n' +
    '- No cover letter, no "as an AI", no closing pleasantries.\n\n' +
    'Respond with the document as markdown only — starting with a single "# " heading.';
  const r = await runClaude(fullPrompt);
  if (!r.ok) return r;
  if (!String(r.text || '').trim()) return noJsonResult(r);
  let md = r.text;
  // Strip an accidental fence wrapper.
  const fence = md.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fence) md = fence[1];
  return {
    ok: true, kind, title: spec.title, markdown: md.trim(),
    context: { bytes: focused.bytes, truncated: focused.truncated },
  };
}
