// The MCP server's one and only way of reaching DR Compass.
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A PILE OF IMPORTS
// ----------------------------------------------------------
// The rule for this server is: call the product, never re-implement it. That
// sounds like "import the libs" until you read routes/exports.js, where
// `executiveMarkdown`, `briefMarkdown`, `runbookMarkdown`, `runbookQuickRef`
// and the CSV writer are module-private to the ROUTER. They are not exported
// and they are not in server/lib/. An MCP server that wanted an executive
// summary by importing libraries would have to write its own renderer — and a
// second renderer is exactly how the workbook and the markdown start telling
// different stories about the same plan. The same is true of the honest-numbers
// guard: it runs inside the POST /ai/apply handler, not in a helper anyone can
// call, and it is REPORTED from there too.
//
// So the MCP server speaks to the real Express app. Every tool is one HTTP
// request against the same routers the browser uses. There is exactly one
// implementation of every number, every markdown file and every guard note.
//
// WHY A UNIX SOCKET AND NOT A PORT
// --------------------------------
// bin/drcompass.js binds 127.0.0.1 on purpose and says, at length, why: this
// product has no login, and its AI-tool setting can name any executable on the
// machine. An MCP server is launched as a background child process by a client
// — nobody is watching it — so quietly opening a second unauthenticated TCP
// port for the lifetime of a chat session would be strictly worse than what
// that comment warns about, and no user asked for it.
//
// A UNIX domain socket in a 0700 directory under the OS temp dir is reachable
// only by this user, is not on the network at all, is not discoverable by port
// scan, and is unlinked on exit. node:http speaks it natively via
// `socketPath`, so the request path is real HTTP end to end — real headers,
// real Content-Disposition, real streaming for the xlsx, the real express
// error handler. On Windows the equivalent is a named pipe, which node:http
// also accepts through `socketPath`.
//
// Nothing here writes to stdout. See server/mcp/stdio.js.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let handle = null;

function pickSocketPath() {
  if (process.platform === 'win32') {
    return { socketPath: `\\\\.\\pipe\\drcompass-mcp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`, dir: null };
  }
  // 0700 by mkdtemp's own default on every platform node supports, but be
  // explicit: the socket inside it is the whole access-control story.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drcompass-mcp-'));
  fs.chmodSync(dir, 0o700);
  return { socketPath: path.join(dir, 'api.sock'), dir };
}

/**
 * Boot the real Express app on a private socket. Idempotent.
 * @returns {Promise<{socketPath: string, close: () => Promise<void>}>}
 */
export async function startApi() {
  if (handle) return handle;
  const { createServer } = await import('../index.js');
  const app = createServer();
  await app.ready; // routers are mounted asynchronously; without this a tool can 404

  const { socketPath, dir } = pickSocketPath();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  if (dir) { try { fs.chmodSync(socketPath, 0o600); } catch { /* not fatal; the dir is 0700 */ } }

  // The socket lives in a temp directory, so it has to be taken with us. `close`
  // is the orderly path; the `exit` hook is for every path that is not orderly —
  // an uncaught throw, a client that closes the pipe, `process.exit()` from a
  // signal handler. It must be synchronous, because `exit` handlers are. Only
  // SIGKILL can defeat this, and nothing can help there.
  const sweep = () => { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once('exit', sweep);

  const close = async () => {
    handle = null;
    await new Promise((resolve) => server.close(resolve));
    sweep();
  };
  handle = { socketPath, close, server };
  return handle;
}

export async function stopApi() {
  if (handle) await handle.close();
}

/** An error carrying the status and body the API answered with. */
export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function qs(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * One HTTP request against the in-process app.
 *
 * `path` is the API path WITHOUT the /api prefix and without a query string —
 * e.g. `/w/acme/export/xlsx`. Path segments that can contain user data must be
 * encoded by the caller (see `seg()`).
 *
 * Resolves `{status, headers, buffer, text, json}`; `json` is null for
 * non-JSON responses. Throws ApiError on a 4xx/5xx so tool handlers can report
 * the product's own message rather than inventing one.
 */
export async function api(method, apiPath, { query, body, raw = false } = {}) {
  const { socketPath } = await startApi();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method,
      path: `/api${apiPath}${qs(query)}`,
      headers: {
        accept: 'application/json, text/plain, */*',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, buffer: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  const ctype = String(res.headers['content-type'] || '');
  const isJson = ctype.includes('json');
  const isText = isJson || ctype.startsWith('text/') || ctype.includes('xml');
  const out = {
    status: res.status,
    headers: res.headers,
    buffer: res.buffer,
    contentType: ctype,
    text: (raw && !isText) ? null : res.buffer.toString('utf8'),
    json: null,
    filename: filenameFrom(res.headers['content-disposition']),
  };
  if (isJson) { try { out.json = JSON.parse(out.text); } catch { /* leave null */ } }
  if (res.status >= 400) {
    const msg = (out.json && (out.json.error || out.json.message))
      || (out.text && out.text.slice(0, 400))
      || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, out.json);
  }
  return out;
}

function filenameFrom(disposition) {
  const m = /filename="([^"]+)"/.exec(String(disposition || ''));
  return m ? m[1] : '';
}

/** Encode one path segment. Ids and slugs come from callers we do not trust. */
export const seg = (v) => encodeURIComponent(String(v ?? ''));
