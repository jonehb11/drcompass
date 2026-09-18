// A real MCP client over a real child process. No mocking — the stdio
// transport is half of what `mcp-conformance.test.js` is testing, so it is
// exercised, not stubbed.
//
// WHAT THIS FILE IS FOR
// ---------------------
// `node bin/drcompass.js mcp` is spawned exactly the way Claude Desktop or
// Claude Code spawns it: a child process, JSON-RPC 2.0 frames written to its
// stdin, frames read back off its stdout, stderr kept strictly separate. That
// separation is the point. An MCP client parses stdout and ONLY stdout; one
// `console.log` anywhere in the product — a discovery progress line, an export
// warning, a deprecation notice from a dependency — lands in the middle of the
// frame stream and corrupts the session for every client. So this client keeps
// every raw byte stdout ever produced (`rawStdout`) and `analyzeStdout()`
// re-parses that buffer from scratch, independently of the incremental reader,
// so a purity assertion cannot be fooled by a lenient parser.
//
// Everything here is spec-driven. It does not import a line of `server/mcp/**`;
// it knows only what the MCP specification and JSON-RPC 2.0 say, which is what
// makes it an independent check rather than a restatement of the server's own
// beliefs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(REPO, 'bin', 'drcompass.js');

// The version this harness speaks. A server may negotiate a different one —
// that is legal and tested for — but it may not invent one nobody asked for.
export const PROTOCOL_VERSION = '2025-06-18';
export const KNOWN_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const CLIENT_INFO = { name: 'drcompass-conformance-harness', version: '1.0.0' };

// A value planted in the child's environment. If it ever comes back to the
// client — in an error message, a tool result, a log line — the server is
// leaking its environment to an untrusted caller.
export const ENV_CANARY = 'drc-env-canary-3f9a2c7e';

/* ========================================================================
 * Throwaway homes
 * ======================================================================*/

export function makeHome(label = 'drc-mcp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

export function rmHome(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * A directory of tripwire executables placed FIRST on the child's PATH.
 *
 * `aws-discovery.js` and `k8s-discovery.js` reach the outside world by
 * `execFile('aws', …)` / `execFile('kubectl', …)` — a bare PATH lookup. So a
 * shim named `aws` that appends to a file and exits non-zero is a direct,
 * deterministic answer to "did anything actually try to scan my account?"
 * without ever touching a real account: the marker file is either empty or it
 * is not.
 *
 * Returns { dir, marker, fired() }.
 */
export function makeTripwire() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-tripwire-'));
  const marker = path.join(dir, 'fired.log');
  fs.writeFileSync(marker, '');
  for (const bin of ['aws', 'aws-vault', 'kubectl', 'claude', 'codex', 'gemini', 'llm', 'ollama']) {
    const p = path.join(dir, bin);
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s %s\\n' "${bin}" "$*" >> ${JSON.stringify(marker)}\nexit 1\n`);
    fs.chmodSync(p, 0o755);
  }
  return {
    dir,
    marker,
    fired() {
      try { return fs.readFileSync(marker, 'utf8').trim(); } catch { return ''; }
    },
    cleanup() { rmHome(dir); },
  };
}

/* ========================================================================
 * stdout purity — re-parsed from raw bytes, on its own terms
 * ======================================================================*/

export function isRpcMessage(v) {
  if (Array.isArray(v)) return v.length > 0 && v.every(isRpcMessage);
  if (!v || typeof v !== 'object') return false;
  if (v.jsonrpc !== '2.0') return false;
  const isRequest = typeof v.method === 'string';
  const isReply = ('result' in v) || ('error' in v);
  return isRequest || isReply;
}

/**
 * Decompose everything the server wrote to stdout into protocol frames.
 *
 * The MCP stdio transport is newline-delimited JSON: one message per line, no
 * embedded newlines, nothing else on the stream. LSP-style `Content-Length`
 * framing is accepted here too (and reported), because a server that chose it
 * is non-conforming for MCP but is not producing *garbage* — those are two
 * different findings and the harness should be able to tell them apart.
 *
 * `offenders` is the list of byte ranges that are not protocol. Any entry is a
 * corrupted session for every real client.
 */
export function analyzeStdout(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  if (!text.length) return { framing: 'none', frames: [], offenders: [], bytes: 0 };

  if (/^\s*Content-Length:/i.test(text)) {
    const frames = [];
    const offenders = [];
    let rest = text;
    while (rest.length) {
      const m = /^Content-Length:[ \t]*(\d+)[ \t]*\r?\n(?:[^\r\n]*\r?\n)*?\r?\n/i.exec(rest);
      if (!m) {
        if (rest.trim()) offenders.push({ where: 'after frame ' + frames.length, reason: 'not a Content-Length header', text: rest.slice(0, 200) });
        break;
      }
      const body = rest.slice(m[0].length, m[0].length + Number(m[1]));
      try {
        const v = JSON.parse(body);
        if (isRpcMessage(v)) frames.push(v);
        else offenders.push({ where: 'frame ' + frames.length, reason: 'not a JSON-RPC message', text: body.slice(0, 200) });
      } catch (e) {
        offenders.push({ where: 'frame ' + frames.length, reason: 'body is not JSON: ' + e.message, text: body.slice(0, 200) });
      }
      rest = rest.slice(m[0].length + Number(m[1]));
    }
    return { framing: 'content-length', frames, offenders, bytes: text.length };
  }

  const frames = [];
  const offenders = [];
  const lines = text.split('\n');
  const tail = lines.pop();
  lines.forEach((line, i) => {
    const t = line.replace(/\r$/, '');
    if (!t.trim()) return; // a blank separator line is inert, not corruption
    try {
      const v = JSON.parse(t);
      if (isRpcMessage(v)) frames.push(v);
      else offenders.push({ where: `line ${i + 1}`, reason: 'valid JSON but not a JSON-RPC message', text: t.slice(0, 300) });
    } catch (e) {
      offenders.push({ where: `line ${i + 1}`, reason: 'not JSON: ' + e.message, text: t.slice(0, 300) });
    }
  });
  if (tail && tail.trim()) {
    try {
      const v = JSON.parse(tail);
      if (isRpcMessage(v)) frames.push(v);
      else offenders.push({ where: 'trailing bytes', reason: 'valid JSON but not a JSON-RPC message', text: tail.slice(0, 300) });
    } catch (e) {
      offenders.push({ where: 'trailing bytes', reason: 'unterminated non-JSON output: ' + e.message, text: tail.slice(0, 300) });
    }
  }
  return { framing: 'ndjson', frames, offenders, bytes: text.length };
}

/* ========================================================================
 * The client
 * ======================================================================*/

class RpcError extends Error {}

export class McpClient {
  constructor({ args = [], home, env = {}, cwd = REPO, timeout = 15000, tripwire = null } = {}) {
    this.args = args;
    this.home = home || makeHome();
    this.ownsHome = !home;
    this.extraEnv = env;
    this.cwd = cwd;
    this.timeout = timeout;
    this.tripwire = tripwire;

    this.child = null;
    this.rawStdout = [];
    this.rawStderr = [];
    this._buf = '';
    this._nextId = 1;
    this.pending = new Map();      // id -> {resolve, reject, method}
    this.frames = [];              // every parsed inbound message, in order
    this.repliesById = new Map();  // id -> [messages] (duplicates are findings)
    this.serverRequests = [];      // server -> client requests (sampling, roots…)
    this.serverNotifications = [];
    this.exited = null;            // {code, signal} once gone
    this.startError = null;
    this.transcript = [];          // [{dir:'->'|'<-', at, text}] for reporting
  }

  get stdout() { return Buffer.concat(this.rawStdout); }
  get stderr() { return Buffer.concat(this.rawStderr).toString('utf8'); }

  async start() {
    const env = {
      ...process.env,
      DRCOMPASS_HOME: this.home,
      // Never a fixed port: if the MCP command also boots the HTTP app, 0 makes
      // the OS pick, so two test files can never collide.
      DRCOMPASS_PORT: '0',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      DRCOMPASS_CANARY: ENV_CANARY,
      AWS_ACCESS_KEY_ID: 'AKIA' + 'CANARY0000000000',
      AWS_SECRET_ACCESS_KEY: ENV_CANARY,
      AWS_EC2_METADATA_DISABLED: 'true',
      ...this.extraEnv,
    };
    if (this.tripwire) env.PATH = `${this.tripwire.dir}${path.delimiter}${env.PATH || ''}`;

    this.child = spawn(process.execPath, [CLI, 'mcp', ...this.args], {
      cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (b) => { this.rawStdout.push(b); this._feed(b.toString('utf8')); });
    this.child.stderr.on('data', (b) => { this.rawStderr.push(b); });
    this.child.on('error', (e) => { this.startError = e; this._failAll(e); });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      this._failAll(new RpcError(`mcp server exited (code=${code} signal=${signal}) before answering`));
    });
    // stdin EPIPE after the child dies must not take the test runner with it.
    this.child.stdin.on('error', () => {});
    return this;
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _feed(chunk) {
    this._buf += chunk;
    // Header framing, if that is what this server chose.
    for (;;) {
      const h = /^Content-Length:[ \t]*(\d+)[ \t]*\r?\n(?:[^\r\n]*\r?\n)*?\r?\n/i.exec(this._buf);
      if (h) {
        const len = Number(h[1]);
        if (this._buf.length < h[0].length + len) return;
        const body = this._buf.slice(h[0].length, h[0].length + len);
        this._buf = this._buf.slice(h[0].length + len);
        this._deliver(body);
        continue;
      }
      const nl = this._buf.indexOf('\n');
      if (nl < 0) return;
      const line = this._buf.slice(0, nl).replace(/\r$/, '');
      this._buf = this._buf.slice(nl + 1);
      if (line.trim()) this._deliver(line);
    }
  }

  _deliver(text) {
    this.transcript.push({ dir: '<-', at: Date.now(), text: text.slice(0, 4000) });
    let msg;
    try { msg = JSON.parse(text); } catch { return; } // garbage is caught by analyzeStdout
    const each = Array.isArray(msg) ? msg : [msg];
    if (Array.isArray(msg)) this.frames.push(msg);
    for (const m of each) {
      if (!Array.isArray(msg)) this.frames.push(m);
      if (m && typeof m === 'object' && 'id' in m && m.id !== null && (('result' in m) || ('error' in m))) {
        const key = String(m.id);
        if (!this.repliesById.has(key)) this.repliesById.set(key, []);
        this.repliesById.get(key).push(m);
        const p = this.pending.get(key);
        if (p) { this.pending.delete(key); p.resolve(m); }
      } else if (m && typeof m === 'object' && typeof m.method === 'string') {
        if ('id' in m && m.id !== null) this.serverRequests.push(m);
        else this.serverNotifications.push(m);
      }
    }
  }

  _write(text) {
    this.transcript.push({ dir: '->', at: Date.now(), text: text.slice(0, 4000) });
    if (this.child && this.child.stdin.writable) this.child.stdin.write(text);
  }

  /** Send exactly these bytes. Used for malformed-JSON and framing probes. */
  writeRaw(text) { this._write(text); }

  send(msg) { this._write(JSON.stringify(msg) + '\n'); }

  /** Fire a request without awaiting it — for in-flight/ordering tests. */
  fire(method, params, id = this._nextId++) {
    const key = String(id);
    const p = new Promise((resolve, reject) => this.pending.set(key, { resolve, reject, method }));
    this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    return { id, promise: p };
  }

  async request(method, params, { timeout = this.timeout, id } = {}) {
    const { id: usedId, promise } = this.fire(method, params, id === undefined ? this._nextId++ : id);
    let timer;
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => {
        this.pending.delete(String(usedId));
        rej(new RpcError(`timeout after ${timeout}ms waiting for ${method} (id=${usedId}); stderr: ${this.stderr.slice(-400)}`));
      }, timeout);
      timer.unref?.();
    });
    try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /** Let the stream settle so "no response arrived" means something. */
  async idle(ms = 350) {
    await new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  }

  /** The full MCP handshake. Returns the initialize result. */
  async connect({ protocolVersion = PROTOCOL_VERSION, capabilities = {}, timeout } = {}) {
    const res = await this.request('initialize', {
      protocolVersion,
      capabilities,
      clientInfo: CLIENT_INFO,
    }, { timeout });
    if (res.error) throw new RpcError(`initialize failed: ${JSON.stringify(res.error)}`);
    this.initializeResult = res.result;
    this.notify('notifications/initialized');
    await this.idle(120);
    return res.result;
  }

  async listTools(timeout) {
    const all = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {}, { timeout });
      if (res.error) throw new RpcError(`tools/list failed: ${JSON.stringify(res.error)}`);
      for (const t of res.result?.tools || []) all.push(t);
      cursor = res.result?.nextCursor;
      if (!cursor) break;
    }
    this.tools = all;
    return all;
  }

  callTool(name, args, opts) {
    return this.request('tools/call', { name, arguments: args ?? {} }, opts);
  }

  alive() { return !!this.child && this.exited === null; }

  /** Never leave a child behind — called from `finally`, including on failure. */
  async close() {
    if (!this.child) { if (this.ownsHome) rmHome(this.home); return; }
    if (this.exited === null) {
      try { this.child.stdin.end(); } catch { /* already gone */ }
      const gone = await new Promise((resolve) => {
        if (this.exited !== null) return resolve(true);
        const t = setTimeout(() => resolve(false), 1500);
        t.unref?.();
        this.child.once('exit', () => { clearTimeout(t); resolve(true); });
      });
      if (!gone) {
        try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 800); t.unref?.();
          this.child.once('exit', () => { clearTimeout(t); resolve(); });
        });
      }
    }
    try { this.child.stdout.destroy(); this.child.stderr.destroy(); } catch { /* fine */ }
    if (this.ownsHome) rmHome(this.home);
  }
}

/**
 * Run `fn` against a live server and guarantee the child dies, whatever `fn`
 * does — including throwing an assertion, which is the path most likely to
 * leave a process behind.
 */
export async function withServer(opts, fn) {
  const client = new McpClient(opts);
  try {
    await client.start();
    return await fn(client);
  } finally {
    await client.close();
  }
}

/* ========================================================================
 * Availability probe
 * ======================================================================*/

let _probe = null;

/**
 * Is `drcompass mcp` a thing yet?
 *
 * Behavioural, not structural: the server exists if and only if it spawns and
 * answers `initialize`. A missing subcommand, a crash on boot and a server that
 * hangs are all "not yet" — each with the reason spelled out, so `npm test`
 * stays green and honest rather than green and quiet.
 */
export async function probeMcp() {
  if (_probe) return _probe;
  _probe = (async () => {
    const home = makeHome('drc-mcp-probe-');
    const client = new McpClient({ home, timeout: 12000 });
    try {
      await client.start();
      const res = await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO,
      }, { timeout: 12000 });
      if (res.error) {
        return { ok: false, reason: `\`drcompass mcp\` answered initialize with an error: ${JSON.stringify(res.error)}` };
      }
      return { ok: true, initializeResult: res.result, stderr: client.stderr };
    } catch (e) {
      const err = client.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      const exit = client.exited ? ` (exit code ${client.exited.code}${client.exited.signal ? '/' + client.exited.signal : ''})` : '';
      return {
        ok: false,
        reason: `\`node bin/drcompass.js mcp\` did not answer initialize${exit}: ${e.message.split(';')[0]}${err ? ` — stderr: ${err}` : ''}`,
      };
    } finally {
      await client.close();
      rmHome(home);
    }
  })();
  return _probe;
}

/**
 * Does the server accept a flag at all? A server that exits on an unknown
 * option must not turn the with-writes suite red — it turns it into a skip
 * with the reason attached.
 */
export async function probeFlag(flag) {
  const home = makeHome('drc-mcp-flag-');
  const client = new McpClient({ home, args: [flag], timeout: 12000 });
  try {
    await client.start();
    const res = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO,
    }, { timeout: 12000 });
    if (res.error) return { ok: false, reason: `initialize with ${flag} errored: ${JSON.stringify(res.error)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `${flag} is not accepted: ${e.message.split(';')[0]} — stderr: ${client.stderr.trim().slice(-240)}` };
  } finally {
    await client.close();
    rmHome(home);
  }
}
