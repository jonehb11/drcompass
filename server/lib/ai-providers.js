// Which local AI CLI does DR Compass talk to?
//
// DR Compass has always shelled out to `claude`. This module makes that a
// CHOICE: Claude Code, Cursor CLI, Kiro, Amazon Q, Gemini CLI, Codex, Ollama,
// aider — or a `custom` command the user types in, which is the escape hatch
// for anything not listed and for any built-in descriptor that has gone stale.
//
// ---------------------------------------------------------------------------
// THE HONESTY RULE
// ---------------------------------------------------------------------------
// Only ONE invocation in this file was actually run and observed working on a
// real machine: `claude -p <prompt> --output-format text`, which is what this
// repo has always used. Everything else is a BEST GUESS at a one-shot/headless
// flag set, taken from each tool's public docs at the time of writing, and
// those CLIs change their flags. So:
//
//   * every unconfirmed descriptor is `verified: false` and carries a note
//     saying so in plain English;
//   * detection does not take the descriptor's word for it — when the binary
//     exists, we run its `--help` (short timeout, stdin closed so it can never
//     drop into an interactive prompt) and PROBE for the exact flags the
//     descriptor wants to use. What we report is what we found;
//   * a provider whose flags are not in its own help text is reported as
//     "found, but the invocation could not be confirmed — run Test", never as
//     working;
//   * `testProvider()` sends a trivial prompt and reports what actually came
//     back. A provider is only ever described as confirmed after that has
//     succeeded on THIS machine.
//
// Nothing here ever builds a shell string. Every child process is spawned with
// an argument ARRAY — prompts carry the user's own document text and must
// never be parsed by a shell.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 180000;          // same default as ai-bridge's runClaude
const MAX_BUFFER = 20 * 1024 * 1024;
const HELP_TIMEOUT_MS = 8000;
const VERSION_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 120000;

// A prompt longer than this does not go on argv. macOS ARG_MAX is ~1MB for the
// whole argument+environment block, and DR Compass routinely sends 50-200KB of
// context (document ingestion, console scope) — comfortably under, but a big
// pasted design document is not. Above this we switch to stdin if the provider
// can take it, and refuse with a clear message if it cannot. We never truncate
// a prompt: a silently shortened DR document is worse than an error.
const ARGV_PROMPT_LIMIT = 120 * 1024;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
//
// Descriptor shape:
//   id           stable key, also what the UI and the config file store
//   name         product name, as the user would go and install it
//   cliLabel     how the tool is named inside an error sentence
//   bin          the executable we look for on PATH
//   docsUrl      where to go to install it
//   versionArgs  argv for detection (must be non-interactive and fast)
//   input        'argv' | 'stdin' — how the prompt is delivered by default
//   argv(p)      arg array for argv delivery, prompt inlined
//   stdinArgv()  arg array for stdin delivery, or null if it has none
//   helpProbe    flags we expect to see in `--help` if the descriptor is right
//   verified     true ONLY for a shape actually observed working
//   notes        plain English, shown in the UI

const REGISTRY = [
  {
    id: 'claude',
    name: 'Claude Code',
    cliLabel: 'Claude CLI',
    bin: 'claude',
    docsUrl: 'https://claude.com/claude-code',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['-p', prompt, '--output-format', 'text'],
    stdinArgv: () => ['-p', '--output-format', 'text'],
    helpProbe: ['-p', '--output-format'],
    verified: true,
    notes: 'Confirmed. This is the invocation DR Compass has always used, and it '
      + 'was run end to end on this machine.',
  },
  {
    id: 'cursor-agent',
    name: 'Cursor CLI',
    cliLabel: 'Cursor CLI',
    bin: 'cursor-agent',
    docsUrl: 'https://cursor.com/cli',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['-p', prompt, '--output-format', 'text'],
    stdinArgv: () => ['-p', '--output-format', 'text'],
    helpProbe: ['-p'],
    verified: false,
    notes: 'Best guess: `cursor-agent -p <prompt> --output-format text`. Not '
      + 'confirmed — Cursor changes these flags between releases. Run Test before '
      + 'relying on it, and use a custom command if the test fails.',
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    cliLabel: 'Kiro CLI',
    bin: 'kiro',
    docsUrl: 'https://kiro.dev',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['chat', '--no-interactive', prompt],
    stdinArgv: () => ['chat', '--no-interactive'],
    helpProbe: ['chat', '--no-interactive'],
    verified: false,
    notes: 'Best guess: `kiro chat --no-interactive <prompt>`. NOT confirmed — I '
      + 'have not seen this CLI run. Run Test; if it fails, read `kiro --help` and '
      + 'enter the real command as a custom provider.',
  },
  {
    id: 'q',
    name: 'Amazon Q Developer CLI',
    cliLabel: 'Amazon Q CLI',
    bin: 'q',
    docsUrl: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['chat', '--no-interactive', '--trust-all-tools', prompt],
    stdinArgv: () => ['chat', '--no-interactive', '--trust-all-tools'],
    helpProbe: ['chat', '--no-interactive'],
    verified: false,
    notes: 'Best guess: `q chat --no-interactive --trust-all-tools <prompt>`. Not '
      + 'confirmed. Note that --trust-all-tools lets Q run tools without asking — '
      + 'DR Compass only ever asks it questions, but you should know it is there.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    cliLabel: 'Gemini CLI',
    bin: 'gemini',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['-p', prompt, '--output-format', 'text'],
    stdinArgv: () => ['-p', '', '--output-format', 'text'],
    helpProbe: ['-p', '--output-format'],
    verified: false,
    notes: 'Flags `-p` and `--output-format text` were found in this machine\'s '
      + '`gemini --help`, so the shape is right for that version — but a live run '
      + 'has not been observed succeeding, so it stays unverified. Run Test.',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    cliLabel: 'Codex CLI',
    bin: 'codex',
    docsUrl: 'https://github.com/openai/codex',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['exec', prompt],
    stdinArgv: () => ['exec', '-'],
    helpProbe: ['exec'],
    verified: false,
    notes: 'Best guess: `codex exec <prompt>`. Not confirmed. Codex writes files '
      + 'in its working directory by default — check its sandbox settings before '
      + 'pointing DR Compass at it.',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    cliLabel: 'Ollama',
    bin: 'ollama',
    docsUrl: 'https://ollama.com',
    versionArgs: ['--version'],
    input: 'stdin',
    // `ollama run <model>` with no prompt argument reads the prompt from stdin.
    // The model name is the part we cannot guess, so it is configurable and
    // defaults to something most people pull first.
    argv: (prompt, opts = {}) => ['run', opts.model || process.env.DRCOMPASS_AI_MODEL || 'llama3', prompt],
    stdinArgv: (opts = {}) => ['run', opts.model || process.env.DRCOMPASS_AI_MODEL || 'llama3'],
    helpProbe: ['run'],
    verified: false,
    notes: 'Best guess: `ollama run <model>` with the prompt on stdin. The MODEL '
      + 'name is a guess (llama3) — set DRCOMPASS_AI_MODEL, or use a custom command '
      + 'naming the model you actually pulled. A small local model will struggle '
      + 'with the long, strict prompts DR Compass sends.',
  },
  {
    id: 'aider',
    name: 'Aider',
    cliLabel: 'Aider',
    bin: 'aider',
    docsUrl: 'https://aider.chat',
    versionArgs: ['--version'],
    input: 'argv',
    argv: (prompt) => ['--message', prompt, '--no-auto-commits', '--yes'],
    stdinArgv: null,
    helpProbe: ['--message'],
    verified: false,
    notes: 'Best guess: `aider --message <prompt> --no-auto-commits --yes`. Not '
      + 'confirmed. Aider is an EDITOR — it may try to change files in the working '
      + 'directory. Prefer one of the ask-style CLIs for DR Compass.',
  },
];

// The escape hatch, and deliberately a first-class provider rather than an
// afterthought: if every descriptor above is wrong, this is the one that works.
export const CUSTOM_ID = 'custom';

const CUSTOM_DESCRIPTOR = {
  id: CUSTOM_ID,
  name: 'Custom command',
  cliLabel: 'the configured AI CLI',
  bin: '',
  docsUrl: '',
  versionArgs: ['--version'],
  input: 'argv',
  helpProbe: [],
  verified: false,
  notes: 'Any command that reads a prompt and prints an answer. Put {prompt} where '
    + 'the prompt goes for argv mode, or choose stdin mode and leave it out.',
};

export function listProviders() {
  return REGISTRY.map((p) => ({ ...p }));
}

export function providerById(id) {
  if (id === CUSTOM_ID) return { ...CUSTOM_DESCRIPTOR };
  const found = REGISTRY.find((p) => p.id === id);
  return found ? { ...found } : null;
}

// ---------------------------------------------------------------------------
// PATH lookup, without spawning anything
// ---------------------------------------------------------------------------

export function whichSync(bin) {
  if (!bin) return null;
  // An explicit path (./foo, /usr/bin/foo) is used as given.
  if (bin.includes('/')) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return path.resolve(bin);
    } catch { return null; }
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const full = path.join(d, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------
//
// Always an argv array. `stdinText` of null means "close stdin immediately",
// which is also what stops a CLI we do not know from sitting at an interactive
// prompt forever.

function runProcess(bin, args, { cwd, timeoutMs, stdinText = null } = {}) {
  return new Promise((resolve) => {
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
    let child;
    try {
      child = spawn(bin, Array.isArray(args) ? args : [], {
        cwd: cwd || process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e && e.message || e), error: e, timedOut: false });
      return;
    }

    let out = '';
    let err = '';
    let outBytes = 0;
    let done = false;
    let timedOut = false;
    let spawnError = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      // A CLI that ignores SIGTERM must not hold the request open forever.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
    }, limit);

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, error: spawnError, timedOut });
    };

    child.stdout.on('data', (b) => {
      outBytes += b.length;
      if (outBytes <= MAX_BUFFER) out += b.toString();
    });
    child.stderr.on('data', (b) => { if (err.length < 64 * 1024) err += b.toString(); });
    child.on('error', (e) => { spawnError = e; finish(null); });
    child.on('close', (code) => finish(code));

    // stdin: write the prompt if there is one, then always close, so nothing
    // can block waiting for input.
    child.stdin.on('error', () => { /* EPIPE when the child exits early */ });
    if (stdinText !== null && stdinText !== undefined) child.stdin.end(String(stdinText));
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
//
// Global default lives in <DRCOMPASS_HOME>/config.json. Per-workspace override
// lives on the workspace object as `aiProvider`. Reading NEVER writes: a user
// who only ever looks at the settings page ends up with no config file at all.

function configPath() {
  return path.join(store.homeDir(), 'config.json');
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

// ---------------------------------------------------------------------------
// Selection shapes
// ---------------------------------------------------------------------------
//
// A selection is `{ id }` for a built-in, or
// `{ id: 'custom', bin, argsTemplate, input }` for the escape hatch.

function splitTemplate(template) {
  // A tiny shell-less tokenizer: whitespace separates arguments, quotes group
  // them. This is NOT a shell — nothing is expanded, globbed or substituted,
  // and the result goes straight into an argv array.
  const src = String(template ?? '');
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

export const PROMPT_TOKEN = '{prompt}';

// Hard validation. Returns {ok:true, selection} or {ok:false, message}.
export function validateSelection(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const id = String(cfg.id || '').trim();
  if (!id) return { ok: false, message: 'id required — pick a provider id, or "custom".' };

  if (id !== CUSTOM_ID) {
    const d = providerById(id);
    if (!d) {
      return {
        ok: false,
        message: `unknown provider '${id}' — known ids: ${REGISTRY.map((p) => p.id).join(', ')}, custom.`,
      };
    }
    return { ok: true, selection: { id } };
  }

  const bin = String(cfg.bin || '').trim();
  if (!bin) return { ok: false, message: 'bin required for a custom provider — the command to run, e.g. "mytool".' };
  const input = cfg.input === 'stdin' ? 'stdin' : 'argv';
  const argsTemplate = String(cfg.argsTemplate ?? '');
  const hasToken = argsTemplate.includes(PROMPT_TOKEN);

  if (input === 'argv' && !hasToken) {
    return {
      ok: false,
      message: `argsTemplate must contain ${PROMPT_TOKEN} in argv mode — that is where DR Compass puts the prompt. `
        + `Example: -p ${PROMPT_TOKEN} --output-format text. If your tool reads the prompt from standard input, choose stdin mode instead.`,
    };
  }
  if (input === 'stdin' && hasToken) {
    return {
      ok: false,
      message: `remove ${PROMPT_TOKEN} from argsTemplate in stdin mode — the prompt is written to the command's standard input, not to its arguments.`,
    };
  }

  const resolved = whichSync(bin);
  if (!resolved) {
    return {
      ok: false,
      message: `'${bin}' was not found on PATH (and is not an executable file at that path). `
        + 'Install it, or give the full path to the executable.',
    };
  }

  const name = String(cfg.name || '').trim().slice(0, 60);
  return { ok: true, selection: { id: CUSTOM_ID, bin, argsTemplate, input, ...(name ? { name } : {}) } };
}

// Turn a selection into something runnable. Never throws.
function materialize(selection) {
  if (!selection || !selection.id) return null;
  if (selection.id !== CUSTOM_ID) {
    const d = providerById(selection.id);
    if (!d) return null;
    return {
      id: d.id,
      name: d.name,
      cliLabel: d.cliLabel,
      bin: d.bin,
      docsUrl: d.docsUrl,
      input: d.input,
      verified: d.verified,
      notes: d.notes,
      buildArgv: (prompt) => d.argv(prompt, selection),
      buildStdinArgv: d.stdinArgv ? () => d.stdinArgv(selection) : null,
      selection,
    };
  }
  const bin = String(selection.bin || '').trim();
  if (!bin) return null;
  const input = selection.input === 'stdin' ? 'stdin' : 'argv';
  const tokens = splitTemplate(selection.argsTemplate);
  const label = selection.name || bin;
  return {
    id: CUSTOM_ID,
    name: label,
    cliLabel: label,
    bin,
    docsUrl: '',
    input,
    verified: false,
    notes: CUSTOM_DESCRIPTOR.notes,
    buildArgv: (prompt) => tokens.map((t) => (t.includes(PROMPT_TOKEN) ? t.split(PROMPT_TOKEN).join(prompt) : t)),
    // A custom command can always take stdin — that is the mode the user picked
    // when they said stdin, and for an argv template we still have the tokens.
    buildStdinArgv: input === 'stdin'
      ? () => tokens.slice()
      : null,
    selection,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
//
//   DRCOMPASS_AI_CLI  →  workspace override  →  global default  →  auto-detect
//
// Auto-detect prefers `claude` when it is on PATH, so a machine that has only
// ever used Claude Code behaves byte-for-byte as it did before this module
// existed. Auto-detect uses a PATH lookup, not a subprocess — it runs on every
// AI call and must be free.

function envSelection() {
  const raw = String(process.env.DRCOMPASS_AI_CLI || '').trim();
  if (!raw) return null;
  const known = providerById(raw);
  if (known && raw !== CUSTOM_ID) return { id: raw, source: 'env' };
  // Anything else is treated as a command: a bare name or a path.
  const argsTemplate = process.env.DRCOMPASS_AI_ARGS !== undefined
    ? String(process.env.DRCOMPASS_AI_ARGS)
    : PROMPT_TOKEN;
  const input = String(process.env.DRCOMPASS_AI_INPUT || '').trim() === 'stdin' ? 'stdin' : 'argv';
  return {
    id: CUSTOM_ID,
    bin: raw,
    argsTemplate: input === 'stdin' ? argsTemplate.split(PROMPT_TOKEN).join('').trim() : argsTemplate,
    input,
    source: 'env',
  };
}

function workspaceSelection(slug) {
  if (!slug) return null;
  let meta = null;
  try { meta = store.getWorkspace(slug); } catch { return null; }
  const sel = meta && meta.aiProvider;
  if (!sel || typeof sel !== 'object' || !sel.id) return null;
  return { ...sel, source: 'workspace' };
}

function globalSelection() {
  const sel = readConfig()?.ai?.provider;
  if (!sel || typeof sel !== 'object' || !sel.id) return null;
  return { ...sel, source: 'global' };
}

function autoSelection() {
  if (whichSync('claude')) return { id: 'claude', source: 'auto' };
  for (const p of REGISTRY) {
    if (whichSync(p.bin)) return { id: p.id, source: 'auto' };
  }
  return null;
}

// The selection in force, with where it came from. Reading never writes.
export function getSelectedProvider(slug) {
  const chain = [envSelection(), workspaceSelection(slug), globalSelection(), autoSelection()];
  for (const sel of chain) {
    if (!sel) continue;
    const runnable = materialize(sel);
    if (!runnable) continue;
    return { ...runnable, source: sel.source || 'global' };
  }
  return null;
}

// slug === null/undefined sets the GLOBAL default; a slug sets the per-workspace
// override. `{id:'inherit'}` on a workspace clears the override.
export function setSelectedProvider(slug, cfg) {
  if (slug && cfg && String(cfg.id || '') === 'inherit') {
    const meta = store.getWorkspace(slug);
    const next = { ...meta };
    delete next.aiProvider;
    // saveWorkspace merges, so an explicit null is how a key is cleared.
    store.saveWorkspace(slug, { ...next, aiProvider: null });
    return { ok: true, scope: 'workspace', selection: null };
  }

  const v = validateSelection(cfg);
  if (!v.ok) return { ok: false, message: v.message };

  if (slug) {
    store.getWorkspace(slug); // 404 if missing
    store.saveWorkspace(slug, { aiProvider: v.selection });
    return { ok: true, scope: 'workspace', selection: v.selection };
  }
  const conf = readConfig();
  conf.ai = { ...(conf.ai || {}), provider: v.selection };
  writeConfig(conf);
  return { ok: true, scope: 'global', selection: v.selection };
}

// A live test result, recorded so the UI can say "confirmed on this machine on
// <date>" rather than repeating a descriptor's claim. Written only from
// testProvider(), never from a read.
function recordTestResult(id, result) {
  if (!id) return;
  const conf = readConfig();
  conf.ai = conf.ai || {};
  conf.ai.tested = conf.ai.tested || {};
  conf.ai.tested[id] = {
    ok: !!result.ok,
    at: new Date().toISOString(),
    ...(result.ms ? { ms: result.ms } : {}),
    ...(result.line ? { line: String(result.line).slice(0, 200) } : {}),
    ...(result.message ? { message: String(result.message).slice(0, 300) } : {}),
  };
  try { writeConfig(conf); } catch { /* a failed record must not fail the test */ }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function probeHelp(bin, wanted) {
  if (!wanted || !wanted.length) return { helpRead: false, found: [], missing: [] };
  const r = await runProcess(bin, ['--help'], { timeoutMs: HELP_TIMEOUT_MS });
  const text = `${r.stdout}\n${r.stderr}`;
  if (!text.trim()) return { helpRead: false, found: [], missing: wanted.slice() };
  const found = [];
  const missing = [];
  for (const flag of wanted) {
    // Word-ish match so `-p` does not match inside `--prompt`.
    const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s,\\[(|'"\`])${esc}([\\s,.\\])|'"\`=]|$)`, 'm');
    (re.test(text) ? found : missing).push(flag);
  }
  return { helpRead: true, found, missing };
}

async function probeVersion(bin, versionArgs) {
  const r = await runProcess(bin, versionArgs || ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  if (r.error || r.timedOut) return null;
  const line = `${r.stdout}`.trim().split('\n')[0] || `${r.stderr}`.trim().split('\n')[0] || '';
  return line ? line.slice(0, 120) : (r.code === 0 ? 'installed' : null);
}

/**
 * Probe PATH, versions and help text for every known provider.
 * Returns the full list with an honest status on each one.
 */
export async function detectProviders(slug) {
  const selected = getSelectedProvider(slug);
  const tested = readConfig()?.ai?.tested || {};

  const rows = await Promise.all(REGISTRY.map(async (d) => {
    const binPath = whichSync(d.bin);
    const row = {
      id: d.id,
      name: d.name,
      bin: d.bin,
      docsUrl: d.docsUrl,
      input: d.input,
      supportsStdin: !!d.stdinArgv,
      declaredVerified: !!d.verified,
      notes: d.notes,
      installed: !!binPath,
      path: binPath || null,
      version: null,
      helpRead: false,
      flagsFound: [],
      flagsMissing: [],
      lastTest: tested[d.id] || null,
      status: 'not-installed',
      statusText: 'Not on PATH.',
    };
    if (!binPath) return row;

    const [version, help] = await Promise.all([
      probeVersion(binPath, d.versionArgs),
      probeHelp(binPath, d.helpProbe),
    ]);
    row.version = version;
    row.helpRead = help.helpRead;
    row.flagsFound = help.found;
    row.flagsMissing = help.missing;

    const liveOk = row.lastTest && row.lastTest.ok;
    if (liveOk) {
      row.status = 'confirmed';
      row.statusText = `Confirmed by a test on this machine (${String(row.lastTest.at).slice(0, 10)}).`;
    } else if (help.helpRead && help.missing.length) {
      row.status = 'unconfirmed';
      row.statusText = `Found, but the invocation could not be confirmed — ${help.missing.join(' and ')} `
        + `${help.missing.length > 1 ? 'are' : 'is'} not in its own --help. Run Test.`;
    } else if (!d.verified) {
      row.status = 'unconfirmed';
      row.statusText = help.helpRead
        ? 'Found, and its help mentions the flags DR Compass would use — but the invocation has not been confirmed. Run Test.'
        : 'Found, but its help could not be read, so the invocation could not be confirmed. Run Test.';
    } else {
      row.status = 'ok';
      row.statusText = 'Found, and this invocation is the one DR Compass has always used.';
    }
    return row;
  }));

  // The custom entry always appears, so the escape hatch is never hidden.
  const customSel = selected && selected.id === CUSTOM_ID ? selected.selection : null;
  rows.push({
    id: CUSTOM_ID,
    name: CUSTOM_DESCRIPTOR.name,
    bin: customSel ? customSel.bin : '',
    docsUrl: '',
    input: customSel ? (customSel.input || 'argv') : 'argv',
    supportsStdin: true,
    declaredVerified: false,
    notes: CUSTOM_DESCRIPTOR.notes,
    installed: customSel ? !!whichSync(customSel.bin) : false,
    path: customSel ? whichSync(customSel.bin) : null,
    version: null,
    helpRead: false,
    flagsFound: [],
    flagsMissing: [],
    lastTest: tested[CUSTOM_ID] || null,
    status: customSel ? (tested[CUSTOM_ID]?.ok ? 'confirmed' : 'unconfirmed') : 'not-configured',
    statusText: customSel
      ? (tested[CUSTOM_ID]?.ok
        ? `Confirmed by a test on this machine (${String(tested[CUSTOM_ID].at).slice(0, 10)}).`
        : 'Configured, but not yet confirmed — run Test.')
      : 'Any command that takes a prompt and prints an answer.',
    argsTemplate: customSel ? (customSel.argsTemplate || '') : '',
  });

  return {
    providers: rows,
    selected: selected
      ? {
        id: selected.id,
        name: selected.name,
        bin: selected.bin,
        input: selected.input,
        source: selected.source,
        verified: selected.verified,
        selection: selected.selection,
      }
      : null,
    envOverride: !!String(process.env.DRCOMPASS_AI_CLI || '').trim(),
    promptToken: PROMPT_TOKEN,
  };
}

// ---------------------------------------------------------------------------
// Messages — these are the sentences ai-bridge used to own
// ---------------------------------------------------------------------------

export function missingCliMessage(provider) {
  if (!provider) {
    return 'No local AI CLI is configured — DR Compass runs every AI feature through a CLI on this machine. '
      + 'Install one (Claude Code: https://claude.com/claude-code) or pick the one you have in Settings → AI tool.';
  }
  if (provider.id === CUSTOM_ID) {
    return `'${provider.bin}' not found on PATH — check the command in Settings → AI tool.`;
  }
  return `${provider.name} CLI not found on PATH — install ${provider.name} (${provider.docsUrl}), sign in, then retry.`;
}

export function timeoutMessage(provider, limitMs, longHint) {
  const label = provider ? provider.cliLabel : 'The AI CLI';
  return `${label} timed out after ${limitMs / 1000}s${longHint || ''}`;
}

export function failureMessage(provider, detail) {
  const label = provider ? provider.cliLabel : 'The AI CLI';
  return `${label} failed: ${String(detail || '').slice(0, 400)}`;
}

// ---------------------------------------------------------------------------
// aiCliFound — the provider-aware replacement for claudeCliFound()
// ---------------------------------------------------------------------------

export async function aiCliFound(slug) {
  const provider = getSelectedProvider(slug);
  if (!provider) return false;
  const binPath = whichSync(provider.bin);
  if (!binPath) return false;
  if (provider.id === CUSTOM_ID) return true; // it is on PATH; that is all we can honestly say
  const d = providerById(provider.id);
  const r = await runProcess(binPath, (d && d.versionArgs) || ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  return !r.error && !r.timedOut;
}

// ---------------------------------------------------------------------------
// runAi — the one function the rest of the app calls
// ---------------------------------------------------------------------------

/**
 * @param {string} fullPrompt   the complete prompt, already assembled
 * @param {object} opts         {cwd, timeoutMs, slug}
 * @returns {Promise<{ok:true,text:string,provider:object}|{ok:false,message:string,provider:object|null}>}
 *
 * Error normalisation matches ai-bridge's runClaude exactly:
 *   ENOENT   → "<name> CLI not found on PATH — install <name> (<docs>), sign in, then retry."
 *   timeout  → "<label> timed out after Ns" (+ the long-timeout hint above the default)
 *   anything → "<label> failed: <last 3 stderr lines, capped at 400 chars>"
 */
export async function runAi(fullPrompt, { cwd, timeoutMs, slug } = {}) {
  const provider = getSelectedProvider(slug);
  const info = provider
    ? { id: provider.id, name: provider.name, bin: provider.bin, input: provider.input, verified: provider.verified, source: provider.source }
    : null;

  if (!provider) return { ok: false, message: missingCliMessage(null), provider: null };

  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
  const prompt = String(fullPrompt ?? '');

  // Choose the delivery mode. argv is the default because that is what the
  // known-good invocation uses; a very large prompt moves to stdin, and if the
  // provider has no stdin path we say so instead of truncating.
  let args;
  let stdinText = null;
  const tooBigForArgv = Buffer.byteLength(prompt, 'utf8') > ARGV_PROMPT_LIMIT;

  if (provider.input === 'stdin' || tooBigForArgv) {
    if (provider.buildStdinArgv) {
      args = provider.buildStdinArgv();
      stdinText = prompt;
    } else if (!tooBigForArgv) {
      args = provider.buildArgv(prompt);
    } else {
      const kb = Math.round(Buffer.byteLength(prompt, 'utf8') / 1024);
      return {
        ok: false,
        provider: info,
        message: `This prompt is ${kb} KB, which is too long to pass on the command line, and ${provider.name} `
          + 'has no standard-input mode configured in DR Compass. Use a shorter excerpt, or configure this tool as a '
          + 'custom command in stdin mode (Settings → AI tool).',
      };
    }
  } else {
    args = provider.buildArgv(prompt);
  }

  const binPath = whichSync(provider.bin) || provider.bin;
  const r = await runProcess(binPath, args, { cwd, timeoutMs: limit, stdinText });

  if (r.error && r.error.code === 'ENOENT') {
    return { ok: false, message: missingCliMessage(provider), provider: info };
  }
  if (r.timedOut) {
    const hint = limit > TIMEOUT_MS
      ? ' — the document may be too long to read in one pass. Try a shorter excerpt, or split it.'
      : '';
    return { ok: false, message: timeoutMessage(provider, limit, hint), provider: info };
  }
  if (r.error) {
    return { ok: false, message: failureMessage(provider, r.error.message), provider: info };
  }
  if (r.code !== 0) {
    const stderr = String(r.stderr || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, message: failureMessage(provider, stderr || `exited with code ${r.code}`), provider: info };
  }
  return { ok: true, text: String(r.stdout || '').trim(), provider: info };
}

// ---------------------------------------------------------------------------
// testProvider — the button that tells the truth
// ---------------------------------------------------------------------------

const TEST_PROMPT = 'Reply with the single word OK and nothing else.';

/**
 * Send a trivial prompt through a provider and report what actually came back.
 * `idOrCfg` is a provider id, a full custom selection object, or omitted for
 * whatever is currently selected.
 */
export async function testProvider(idOrCfg, { slug, timeoutMs } = {}) {
  let provider;
  if (!idOrCfg) {
    provider = getSelectedProvider(slug);
    if (!provider) return { ok: false, message: missingCliMessage(null), provider: null };
  } else {
    const cfg = typeof idOrCfg === 'string' ? { id: idOrCfg } : idOrCfg;
    const v = validateSelection(cfg);
    if (!v.ok) return { ok: false, message: v.message, provider: null };
    provider = materialize(v.selection);
    if (!provider) return { ok: false, message: `could not build a command for '${cfg.id}'`, provider: null };
  }

  const info = { id: provider.id, name: provider.name, bin: provider.bin, input: provider.input };
  const binPath = whichSync(provider.bin);
  if (!binPath) {
    const out = { ok: false, message: missingCliMessage(provider), provider: info };
    recordTestResult(provider.id, out);
    return out;
  }

  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TEST_TIMEOUT_MS;
  const started = Date.now();
  const useStdin = provider.input === 'stdin' && provider.buildStdinArgv;
  const args = useStdin ? provider.buildStdinArgv() : provider.buildArgv(TEST_PROMPT);
  const r = await runProcess(binPath, args, { timeoutMs: limit, stdinText: useStdin ? TEST_PROMPT : null });
  const ms = Date.now() - started;

  let out;
  if (r.error && r.error.code === 'ENOENT') {
    out = { ok: false, ms, message: missingCliMessage(provider), provider: info };
  } else if (r.timedOut) {
    out = { ok: false, ms, message: timeoutMessage(provider, limit, ''), provider: info };
  } else if (r.error) {
    out = { ok: false, ms, message: failureMessage(provider, r.error.message), provider: info };
  } else {
    const text = String(r.stdout || '').trim();
    const line = text.split('\n').find((l) => l.trim()) || '';
    const stderr = String(r.stderr || '').trim().split('\n').slice(-3).join(' ');
    if (r.code !== 0) {
      out = {
        ok: false, ms, provider: info, line: line.slice(0, 300),
        message: failureMessage(provider, stderr || `exited with code ${r.code}`),
      };
    } else if (!text) {
      out = {
        ok: false, ms, provider: info,
        message: `${provider.cliLabel} ran and exited cleanly but printed nothing. `
          + (stderr ? `Its error output said: ${stderr.slice(0, 200)}` : 'Check that it is signed in.'),
      };
    } else {
      out = {
        ok: true, ms, provider: info,
        line: line.slice(0, 300),
        raw: text.slice(0, 1000),
        // We do NOT require the word OK — a chatty CLI that answers is working.
        looksRight: /\bok\b/i.test(line),
      };
    }
  }
  recordTestResult(provider.id, out);
  return out;
}

export const _internals = { splitTemplate, materialize, runProcess, ARGV_PROMPT_LIMIT };
