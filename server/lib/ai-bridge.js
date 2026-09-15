// Bridge to the user's local Claude Code CLI (`claude` on PATH).
// Non-interactive: `claude -p <prompt> --output-format text`. Nothing is sent
// anywhere except through the user's own CLI/auth.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

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
