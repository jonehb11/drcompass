// JSON-RPC 2.0 over stdio, and the stdout discipline that keeps it readable.
//
// FRAMING: newline-delimited JSON — one JSON object per line, UTF-8, no
// embedded newlines (JSON.stringify never emits a raw newline inside a string,
// so this is safe by construction). That is what the MCP stdio transport
// specifies and what Claude Desktop and `claude mcp add` actually speak;
// Content-Length framing is the Language Server Protocol's convention, not
// this one. Clients send one request per line and expect one response per
// line, so that is exactly what this reads and writes.
//
// STDOUT DISCIPLINE: the single most common way to break an MCP server is a
// stray console.log. There is none in server/ today, but this process loads
// twenty-one routers, exceljs, and whatever a future contributor adds, and a
// single debug print would turn every subsequent tool call into a parse error
// on the client with no clue why.
//
// So this module TAKES stdout away. It captures the real write function, then
// replaces process.stdout.write with a forwarder to stderr. Protocol frames go
// out through the captured original; anything else anybody prints ends up on
// stderr, tagged, where the client's MCP log shows it. This is belt and
// braces, and it is cheap.
import { EventEmitter } from 'node:events';

const MAX_LINE_BYTES = 32 * 1024 * 1024; // a runaway peer must not eat all memory

let realWrite = null;

/** Replace process.stdout with a stderr forwarder; return the real writer. */
function seizeStdout() {
  if (realWrite) return realWrite;
  realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    const cb = typeof encoding === 'function' ? encoding : callback;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    // Never drop it — an escaped print is a bug worth seeing, just not on the
    // wire. `[stdout]` says where it came from. Routed through log() so a dead
    // stderr cannot turn a stray console.log into an exception storm.
    log(`[stdout escaped, diverted] ${text.replace(/\n$/, '')}`);
    if (cb) cb();
    return true;
  };
  return realWrite;
}

// Once stderr is gone it never comes back, so latch logging off rather than
// trying again. This is not defensive padding: `log()` is called FROM the
// `uncaughtException` handler, so a throw in here re-enters that handler and
// loops forever. An orphaned server — client force-quit, pipes left open —
// then pegs a CPU core indefinitely, which is precisely what it did before
// this latch (observed at 26 minutes of CPU time at 100%).
let logDead = false;
export function log(...parts) {
  if (logDead) return;
  try {
    process.stderr.write(`[drcompass-mcp] ${parts.join(' ')}\n`);
  } catch {
    logDead = true;
  }
}

/**
 * Reads newline-delimited JSON from `input`, emits:
 *   'message' (obj)  — a syntactically valid JSON value
 *   'parse-error'    — a line that was not JSON; the caller answers -32700
 *   'close'
 * Never throws on input: a malformed frame is a reportable event, not a crash.
 */
export class StdioTransport extends EventEmitter {
  constructor(input = process.stdin, output = process.stdout) {
    super();
    this.input = input;
    this.output = output;
    this.buffer = '';
    this.closed = false;
    this.write = output === process.stdout ? seizeStdout() : output.write.bind(output);
  }

  start() {
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk) => this.#feed(chunk));
    this.input.on('end', () => { this.closed = true; this.emit('close'); });
    this.input.on('error', (e) => { log('stdin error:', e.message); this.closed = true; this.emit('close'); });
    this.input.resume();
    return this;
  }

  #feed(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.emit('parse-error', new Error(`frame exceeded ${MAX_LINE_BYTES} bytes and was dropped`));
      return;
    }
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.emit('parse-error', e);
        continue;
      }
      this.emit('message', msg);
    }
  }

  /** One JSON value, one line. Silently dropped after close — a dead pipe is not an error. */
  send(obj) {
    if (this.closed) return;
    try {
      this.write(`${JSON.stringify(obj)}\n`);
    } catch (e) {
      log('failed to write a frame:', e.message);
    }
  }
}

export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};
