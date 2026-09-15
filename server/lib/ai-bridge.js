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

const PREAMBLE =
  'You are helping build a disaster recovery inventory for a DR planning tool (DR Compass). ' +
  'Answer precisely and practically, for an experienced platform/SRE audience. ' +
  'When asked about components, think about dependencies, data replication, secrets, DNS/edge, third-party calls, and restore ordering.';

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
export function serializeContext({ workspace, components } = {}) {
  const compact = {
    workspace: workspace
      ? { name: workspace.name, regions: workspace.regions, strategy: workspace.strategy, objectives: workspace.objectives, tooling: workspace.tooling }
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

export async function ask({ prompt, context, cwd } = {}) {
  if (!prompt || !String(prompt).trim()) return { ok: false, message: 'Empty prompt' };
  let fullPrompt = PREAMBLE;
  if (context) fullPrompt += `\n\nCurrent workspace inventory (compact JSON):\n${context}`;
  fullPrompt += `\n\n${String(prompt).trim()}`;
  const r = await runClaude(fullPrompt, cwd);
  return r.ok ? { ok: true, answer: r.text } : r;
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
  if (!obj) return { ok: false, message: 'The AI did not return parseable JSON.', raw: r.text };
  const operations = validateOperations(slug, Array.isArray(obj.operations) ? obj.operations : []);
  return {
    ok: true,
    summary: String(obj.summary || '').trim(),
    operations,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
  };
}
