// The MCP protocol: initialize, tools/list, tools/call, resources/list,
// resources/read, and the notifications that go with them.
//
// Framing and stdout discipline live in ./stdio.js; the tool surface lives in
// ./tools.js; everything reaches the product through ./api.js.
//
// Robustness rule for this file: a peer can send anything, and NOTHING it
// sends may kill the process. Malformed JSON is a -32700 answer. An unknown
// method is a -32601 answer. A handler that throws becomes -32603 with a
// message. A notification (no `id`) never gets a reply, whatever happens.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { StdioTransport, JSONRPC, log } from './stdio.js';
import { buildTools, callTool, describeTools } from './tools.js';
import { startApi, stopApi } from './api.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

// Versions this server can speak, newest first. `initialize` negotiates: if the
// client asks for one of these we echo it back; otherwise we answer with our
// newest and the client decides whether it can live with that, which is exactly
// what the spec prescribes.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const RESOURCE_SCHEME = 'drcompass';

export class McpServer {
  constructor({ allowWrites = false, allowAiCli = false, input = process.stdin, output = process.stdout } = {}) {
    this.ctx = { allowWrites: !!allowWrites, allowAiCli: !!allowAiCli };
    this.transport = new StdioTransport(input, output);
    this.tools = null;
    this.initialized = false;
    this.protocolVersion = SUPPORTED_PROTOCOLS[0];
  }

  async start() {
    // Boot the API before we accept a single frame: a client that fires
    // tools/list immediately must not race the router mounting.
    await startApi();
    this.tools = await buildTools();

    this.transport.on('message', (msg) => { this.#dispatch(msg); });
    this.transport.on('parse-error', (e) => {
      // No id is knowable from an unparseable frame, so the spec's answer is a
      // null-id error. The connection stays open.
      this.transport.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.PARSE_ERROR, message: `Parse error: ${e.message}` } });
    });
    this.transport.on('close', () => { this.stop(); });
    this.transport.start();

    log(`DR Compass v${pkg.version} MCP server ready — ${this.tools.length} tools,`,
      this.ctx.allowWrites ? 'WRITES ENABLED (--allow-writes)' : 'read-only (default),',
      this.ctx.allowAiCli ? 'AI CLI ENABLED (--allow-ai-cli)' : 'no subprocess spawning (default)');
    return this;
  }

  async stop() {
    try { await stopApi(); } catch { /* shutting down */ }
  }

  // ------------------------------------------------------------- dispatch

  async #dispatch(msg) {
    // Batches: an array of requests. Answer each, reply with the array of the
    // ones that had ids.
    if (Array.isArray(msg)) {
      if (!msg.length) {
        this.transport.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.INVALID_REQUEST, message: 'Invalid Request: empty batch' } });
        return;
      }
      for (const m of msg) await this.#dispatch(m);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this.transport.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.INVALID_REQUEST, message: 'Invalid Request: not a JSON object' } });
      return;
    }
    // A response to something we sent (we send no requests today) — ignore.
    if (msg.method === undefined) {
      if ('result' in msg || 'error' in msg) return;
      this.transport.send({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: JSONRPC.INVALID_REQUEST, message: 'Invalid Request: no `method`' },
      });
      return;
    }

    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this.#handle(String(msg.method), msg.params || {});
      if (isNotification) return;
      this.transport.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      if (isNotification) { log(`notification ${msg.method} failed:`, e.message); return; }
      const code = Number.isInteger(e?.jsonRpcCode) ? e.jsonRpcCode : JSONRPC.INTERNAL_ERROR;
      this.transport.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code, message: e && e.message ? e.message : 'internal error' },
      });
    }
  }

  async #handle(method, params) {
    switch (method) {
      case 'initialize': return this.#initialize(params);
      case 'notifications/initialized':
      case 'initialized':
        this.initialized = true;
        return {};
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return {};
      case 'ping': return {};
      case 'tools/list': return { tools: describeTools(this.tools, this.ctx) };
      case 'tools/call': return this.#callTool(params);
      case 'resources/list': return this.#listResources();
      case 'resources/templates/list': return { resourceTemplates: RESOURCE_TEMPLATES };
      case 'resources/read': return this.#readResource(params);
      // NOTE: no `prompts/list`. This server publishes no prompts, so it does
      // not advertise a `prompts` capability — and answering a method whose
      // capability is not advertised is how a capability map stops describing
      // the server. A client that asks anyway gets -32601, which is the spec's
      // answer and what every client handles.
      default: throw rpcError(JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  #initialize(params) {
    const wanted = String(params?.protocolVersion || '');
    this.protocolVersion = SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0];
    return {
      protocolVersion: this.protocolVersion,
      capabilities: {
        // Neither list changes while the process runs, so no listChanged.
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: 'drcompass', title: 'DR Compass', version: pkg.version },
      instructions: (this.ctx.allowWrites ? INSTRUCTIONS_RW : INSTRUCTIONS_RO)
        + (this.ctx.allowAiCli ? '' : NO_AI_CLI_NOTE),
    };
  }

  async #callTool(params) {
    const name = String(params?.name || '');
    if (!name) throw rpcError(JSONRPC.INVALID_PARAMS, 'tools/call needs a `name`');
    const out = await callTool(this.tools, name, params?.arguments, this.ctx);
    return { content: [{ type: 'text', text: out.text }], isError: !!out.isError };
  }

  // ------------------------------------------------------------- resources
  //
  // A workspace IS a directory of plain JSON files — that is the product's
  // storage model, stated on the first line of server/store.js — so exposing
  // those files as resources is not a translation layer, it is the thing
  // itself. Read-only, and never anything outside the workspace root.

  async #listResources() {
    const { listWorkspaces, wsRoot } = await import('../store.js');
    const out = [];
    for (const w of listWorkspaces()) {
      const dir = path.join(wsRoot(), w.slug);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
      for (const f of files.sort()) {
        let size = 0;
        try { size = fs.statSync(path.join(dir, f)).size; } catch { /* raced */ }
        out.push({
          uri: `${RESOURCE_SCHEME}://workspace/${encodeURIComponent(w.slug)}/${f}`,
          name: `${w.slug}/${f}`,
          title: `${w.name} — ${f.replace(/\.json$/, '')}`,
          description: `Raw stored JSON for the ${f.replace(/\.json$/, '')} of workspace '${w.slug}'. `
            + 'This is the data on disk, unrendered and unscoped — for the product\'s own view of it, '
            + 'use the tools.',
          mimeType: 'application/json',
          size,
        });
      }
    }
    try {
      const articles = (await (await import('./api.js')).api('GET', '/knowledge')).json || [];
      for (const a of articles) {
        out.push({
          uri: `${RESOURCE_SCHEME}://knowledge/${encodeURIComponent(a.id)}`,
          name: `knowledge/${a.id}`,
          title: a.title,
          description: `DR field guide — ${a.section}`,
          mimeType: 'text/markdown',
        });
      }
    } catch (e) { log('knowledge resources unavailable:', e.message); }
    return { resources: out };
  }

  async #readResource(params) {
    const uri = String(params?.uri || '');
    if (!uri.startsWith(`${RESOURCE_SCHEME}://`)) {
      throw rpcError(JSONRPC.INVALID_PARAMS, `Unknown resource URI: ${uri || '(none)'}`);
    }
    const rest = uri.slice(`${RESOURCE_SCHEME}://`.length);
    const parts = rest.split('/').map((p) => decodeURIComponent(p));

    if (parts[0] === 'knowledge' && parts[1]) {
      const { api } = await import('./api.js');
      try {
        const body = (await api('GET', `/knowledge/${encodeURIComponent(parts[1])}`)).json;
        return { contents: [{ uri, mimeType: 'text/markdown', text: body.markdown }] };
      } catch (e) {
        throw rpcError(JSONRPC.INVALID_PARAMS, `No such article: ${parts[1]}`);
      }
    }

    if (parts[0] === 'workspace' && parts[1] && parts[2]) {
      const { wsRoot } = await import('../store.js');
      const slug = parts[1];
      const file = parts[2];
      if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(slug) || !/^[a-z0-9-]{1,64}\.json$/i.test(file)) {
        throw rpcError(JSONRPC.INVALID_PARAMS, `Refused: '${slug}/${file}' is not a workspace JSON file.`);
      }
      const root = path.resolve(wsRoot());
      const full = path.resolve(path.join(root, slug, file));
      // Belt and braces on top of the regexes above: never escape the root.
      if (full !== path.join(root, slug, file) || !full.startsWith(root + path.sep)) {
        throw rpcError(JSONRPC.INVALID_PARAMS, 'Refused: path escapes the workspace root.');
      }
      if (!fs.existsSync(full)) throw rpcError(JSONRPC.INVALID_PARAMS, `No such resource: ${uri}`);
      return { contents: [{ uri, mimeType: 'application/json', text: fs.readFileSync(full, 'utf8') }] };
    }

    throw rpcError(JSONRPC.INVALID_PARAMS, `Unknown resource URI: ${uri}`);
  }
}

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${RESOURCE_SCHEME}://workspace/{slug}/{file}`,
    name: 'workspace-json',
    title: 'Workspace JSON file',
    description: 'A workspace stores everything as plain JSON files — workspace.json, components.json, '
      + 'runbooks.json, tests.json, checklists.json, gaps.json, decisions.json, contacts.json, services.json, '
      + 'documents.json, assessment.json, resource-graph.json, k8s.json. This reads one of them raw.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: `${RESOURCE_SCHEME}://knowledge/{id}`,
    name: 'field-guide-article',
    title: 'DR field guide article',
    mimeType: 'text/markdown',
  },
];

const HONESTY_PARA = 'DR Compass holds one rule above everything else: RTO and RPO are TARGETS somebody chose; '
  + 'RTA and RPA are EVIDENCE, and only when a test that actually passed produced them. When you report on a '
  + 'plan, use the product\'s own words — if the executive summary says NOT PROVEN, say NOT PROVEN. Do not '
  + 'average a target with a measurement, do not describe an untested plan as a capability, and never present '
  + 'a number you or a document supplied as something that was measured.';

const INSTRUCTIONS_RO = 'DR Compass — a local-first disaster-recovery planning studio. Inventory, dependencies, '
  + 'a computed recovery order, diagrams, runbooks, tests and exports, all derived from plain JSON on this '
  + 'machine.\n\n'
  + 'THIS SERVER IS READ-ONLY (the default). Every read tool works. Nothing can change the user\'s plan.\n\n'
  + 'Start with list_workspaces, then get_workspace / blanks / export_executive_summary to see where a plan '
  + 'really stands. When the user wants a change, write the operations, run preview_operations to show exactly '
  + 'what would happen — it runs the same guard the write path runs — and tell them the server must be '
  + 'restarted with --allow-writes before anything can land.\n\n' + HONESTY_PARA;

const INSTRUCTIONS_RW = 'DR Compass — a local-first disaster-recovery planning studio. Inventory, dependencies, '
  + 'a computed recovery order, diagrams, runbooks, tests and exports, all derived from plain JSON on this '
  + 'machine.\n\n'
  + 'WRITES ARE ENABLED. apply_operations is the only tool that can change plan data, and every operation it '
  + 'takes passes through the honest-numbers guard. ALWAYS run preview_operations first and show the human what '
  + 'would change; ALWAYS relay `guardNotes` from an apply, because they say where what landed differs from '
  + 'what was proposed.\n\n' + HONESTY_PARA;

const NO_AI_CLI_NOTE = '\n\nThis server also will not spawn DR Compass\'s local AI CLI (propose_operations, '
  + 'ingest_document, ai_status are disabled without --allow-ai-cli). You do not need it: you can read every '
  + 'document yourself with get_document and check your own operations with preview_operations.';

function rpcError(code, message) {
  const e = new Error(message);
  e.jsonRpcCode = code;
  return e;
}
