// The MCP server, driven the way a real client drives it.
//
//   node --test test/
//
// Deliberately NOT named `mcp-*`: the conformance harness owns that prefix.
//
// Everything here spawns `node bin/drcompass.js mcp` as a child process with a
// throwaway DRCOMPASS_HOME and talks newline-delimited JSON-RPC 2.0 over its
// stdin/stdout — no in-process shortcuts, because the failure modes that matter
// (a stray stdout write, a crash on a malformed frame, a router that had not
// finished mounting) only exist across a real pipe.
//
// What each group is here to stop coming back:
//
//   * THE WRITE DOOR. This product has closed four separate doors where a
//     number nobody measured could be labelled "measured". An MCP server is the
//     widest one: any client, including a weak local model with nobody
//     watching, can call it. So: read-only by default, and the single write
//     tool goes through POST /ai/apply, where the honest-numbers guard lives.
//     The test that matters most is `a fabricated passed test is neutered`.
//   * STDOUT. One console.log anywhere in the 21 routers this process loads
//     would turn every subsequent frame into a parse error on the client.
//   * CRASHES. A malformed frame from a peer must be an answer, not an exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-mcp-'));
const WS = 'example-acme';

// The MCP server deliberately does NOT seed the bundled example (see
// server/mcp/index.js: it creates no state nobody asked for, and it will not
// hand a model an invented DR plan). So the fixture is seeded here, which is
// also where a test fixture belongs.
process.env.DRCOMPASS_HOME = HOME;
const { seedExample } = await import('../server/store.js');
seedExample();

// --------------------------------------------------------------- the client

function connect(args = [], env = {}) {
  const dir = env.DRCOMPASS_HOME || HOME;
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'drcompass.js'), 'mcp', '--dir', dir, ...args], {
    cwd: REPO,
    env: { ...process.env, DRCOMPASS_HOME: dir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const lines = [];
  let stderr = '';
  let buf = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let m = null;
      try { m = JSON.parse(line); } catch { continue; } // recorded in `lines` either way
      const key = m.id === undefined || m.id === null ? null : m.id;
      const resolve = pending.get(key);
      if (resolve) { pending.delete(key); resolve(m); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  const awaitId = (id) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for id ${id}`)), 120000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  });

  return {
    child,
    raw: (frame) => {
      const id = frame && frame.id !== undefined ? frame.id : null;
      const p = awaitId(id);
      child.stdin.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`);
      return p;
    },
    rawNoReply: (frame) => child.stdin.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`),
    awaitId,
    request(method, params) {
      const id = nextId++;
      const p = awaitId(id);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return p;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    lines,
    stderr: () => stderr,
    alive: () => child.exitCode === null && child.signalCode === null,
    close: () => new Promise((r) => {
      if (child.exitCode !== null) { r(); return; }
      child.once('exit', () => r());
      child.kill('SIGTERM');
      const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 4000);
      if (t.unref) t.unref();
    }),
  };
}

async function handshake(args = [], env = {}) {
  const c = connect(args, env);
  const init = await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'drcompass-test', version: '1' },
  });
  c.notify('notifications/initialized', {});
  return { c, init };
}

const callRaw = (c, name, args) => c.request('tools/call', { name, arguments: args || {} });
async function call(c, name, args) {
  const res = await callRaw(c, name, args);
  const text = res.result.content[0].text;
  return { isError: !!res.result.isError, text, json: safeJson(text) };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** Every file under a directory, relative and sorted — the ground truth for "wrote nothing". */
function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

// One read-only server for the whole file; the write tests get their own.
let ro;
test.before(async () => { ro = (await handshake()).c; });
test.after(async () => {
  if (ro) await ro.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ------------------------------------------------------------- the protocol

test('initialize negotiates a protocol version and declares capabilities', async () => {
  const { c, init } = await handshake();
  try {
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'drcompass');
    assert.ok(init.result.capabilities.tools, 'declares tools');
    assert.ok(init.result.capabilities.resources, 'declares resources');
    // The instructions are prompt surface: the honest-numbers rule must be in them.
    assert.match(init.result.instructions, /RTA and RPA are EVIDENCE/);
    assert.match(init.result.instructions, /READ-ONLY/);
  } finally { await c.close(); }
});

test('an unsupported protocol version gets our newest rather than a crash', async () => {
  const { c, init } = await handshake();
  try {
    const res = await c.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.protocolVersion);
  } finally { await c.close(); }
});

test('tools/list answers with schemas, titles and read-only annotations', async () => {
  const res = await ro.request('tools/list', {});
  const tools = res.result.tools;
  assert.ok(tools.length >= 40, `expected the full surface, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.name && t.description, `${t.name}: needs a description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema must be an object schema`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // The three that change data, and nothing else, are flagged destructive.
  const writes = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(writes, ['apply_operations', 'create_workspace', 'upload_document']);
  // THE DOOR THAT MUST STAY SHUT: no tool may offer a raw collection write.
  for (const t of tools) {
    assert.doesNotMatch(t.name, /^(create|update|delete|save|put|set)_(component|test|runbook|checklist|gap|decision|contact|collection|item)/,
      `${t.name} looks like a raw collection write — every write must go through apply_operations and the guard`);
  }
  // The rule itself has to be legible to a client model before it tries.
  assert.match(byName.apply_operations.description, /RTA\/RPA are EVIDENCE/);
  assert.match(byName.apply_operations.description, /guardNotes/);
  assert.match(byName.export_executive_summary.description, /NOT PROVEN/);
});

test('a malformed frame is answered, not fatal', async () => {
  const waiting = ro.awaitId(null);
  ro.rawNoReply('{"jsonrpc":"2.0","id":5,"method":"tools/list"  NOT JSON');
  const err = await waiting;
  assert.equal(err.id, null);
  assert.equal(err.error.code, -32700);
  assert.match(err.error.message, /Parse error/);
  assert.ok(ro.alive(), 'the process survived a malformed frame');
  // ...and is still serving.
  const after = await ro.request('ping', {});
  assert.deepEqual(after.result, {});
});

test('an unknown method is -32601 and an unknown tool is a tool error', async () => {
  const unknown = await ro.raw({ jsonrpc: '2.0', id: 900, method: 'no/such/method', params: {} });
  assert.equal(unknown.error.code, -32601);

  const noName = await ro.raw({ jsonrpc: '2.0', id: 901, method: 'tools/call', params: {} });
  assert.equal(noName.error.code, -32602);

  // A bad TOOL is not a protocol error — the spec wants isError so a model can recover.
  const badTool = await call(ro, 'definitely_not_a_tool', {});
  assert.ok(badTool.isError);
  assert.match(badTool.text, /No such tool/);
  assert.ok(ro.alive());
});

test('a notification never gets a reply, even a broken one', async () => {
  ro.notify('garbage/notification', { nonsense: true });
  const ping = await ro.request('ping', {});
  assert.deepEqual(ping.result, {}, 'the next request still lines up — nothing extra was written');
});

test('stdout carries protocol frames and nothing else', async () => {
  await ro.request('tools/list', {});
  await call(ro, 'list_workspaces', {});
  assert.ok(ro.lines.length > 0);
  for (const line of ro.lines) {
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `non-JSON on stdout: ${line.slice(0, 200)}`);
    assert.equal(parsed.jsonrpc, '2.0', `a stdout line that is not a JSON-RPC frame: ${line.slice(0, 200)}`);
  }
  assert.match(ro.stderr(), /\[drcompass-mcp\]/, 'diagnostics go to stderr');
});

// -------------------------------------------------------------- read tools

test('the read surface answers off the real product', async () => {
  const ws = await call(ro, 'list_workspaces', {});
  assert.ok(ws.json.some((w) => w.slug === WS), 'the fixture workspace is there');

  const meta = await call(ro, 'get_workspace', { workspace: WS });
  assert.equal(meta.json.slug, WS);

  // 51 components is well over the inline cap, so this arrives as a spill whose
  // preview indexes every component by id and name — which is the answer a
  // caller actually needs before it asks about one of them.
  const comps = await call(ro, 'list_collection', { workspace: WS, collection: 'components' });
  const index = comps.json.items || comps.json.preview.items;
  assert.ok(index.length > 10, 'every component is listed, not the first three');
  assert.ok(index.every((c) => typeof c.id === 'string'), 'each one is identifiable');

  const scope = await call(ro, 'resolve_scope', { workspace: WS, envId: 'prod' });
  assert.equal(scope.json.active, true);
  assert.ok(scope.json.componentCount > 0);
  assert.ok(scope.json.componentCount < scope.json.totalComponents, 'a scope really narrows');

  const blanks = await call(ro, 'blanks', { workspace: WS, importance: 'critical' });
  assert.ok(Array.isArray(blanks.json.items));

  const order = await call(ro, 'deploy_order', { workspace: WS });
  // Big enough to spill; either way the wave count has to be reachable.
  const stats = order.json.stats || order.json.preview?.stats;
  assert.ok(stats.waveCount > 0, 'the deployment order computed waves');
});

test('an unknown envId is a 404 naming the real ones, never an empty answer', async () => {
  const res = await call(ro, 'blanks', { workspace: WS, envId: 'not-an-env' });
  assert.ok(res.isError);
  assert.match(res.text, /404/);
  assert.match(res.text, /known environments/i);
});

test('an over-large result is capped with a preview — and NOTHING is written', async () => {
  const before = filesUnder(HOME);
  const res = await call(ro, 'deploy_order', { workspace: WS });
  assert.equal(res.json.truncated, true, 'the example deployment order is far over the inline cap');
  assert.ok(res.json.bytes > 60 * 1024);
  assert.ok(res.json.preview, 'a structure-preserving preview came back');
  assert.equal(res.json.path, undefined, 'and no file was invented to hold the rest');
  assert.match(res.json.note, /NOTHING was written to disk/);
  assert.match(res.json.note, /outputPath/, 'it says how to get the whole thing');
  assert.deepEqual(filesUnder(HOME), before, 'not one new file in the data directory');
});

test('THE FILE INVARIANT: no read tool creates a file the caller did not name', async () => {
  const before = filesUnder(HOME);
  for (const [name, args] of [
    ['blanks', { workspace: WS }],
    ['service_profile', { workspace: WS, componentId: 'cmp_eks' }],
    ['export_csv', { workspace: WS, sheet: 'components' }],
    ['export_bundle', { workspace: WS }],
    ['export_failover_brief', { workspace: WS }],
    ['export_executive_summary', { workspace: WS }],
    ['draft_runbook_from_deploy_order', { workspace: WS }],
    ['deploy_order', { workspace: WS }],
    ['resource_graph', { workspace: WS }],
  ]) {
    await call(ro, name, args);
  }
  assert.deepEqual(filesUnder(HOME), before,
    'a server the user started read-only must not create state in their data directory');
});

test('a relative outputPath is refused rather than guessed at', async () => {
  const res = await call(ro, 'export_csv', { workspace: WS, sheet: 'tests', outputPath: 'somewhere.csv' });
  assert.ok(res.isError);
  assert.match(res.text, /must be an ABSOLUTE path/);
  assert.ok(!fs.existsSync(path.join(REPO, 'somewhere.csv')), 'and nothing landed in the working directory');
});

// ----------------------------------------------------------------- exports

test('export_workbook refuses to guess a location, then writes a real .xlsx where told', async () => {
  const refused = await call(ro, 'export_workbook', { workspace: WS });
  assert.ok(refused.isError, 'binary with nowhere to put it is a refusal, not an invented path');
  assert.match(refused.text, /absolute `outputPath`/);
  assert.match(refused.text, /export_executive_summary/, 'and it points at the text alternatives');

  const out = path.join(HOME, 'wb-test.xlsx');
  const res = await call(ro, 'export_workbook', { workspace: WS, outputPath: out });
  assert.equal(res.json.wroteFile, true);
  assert.equal(res.json.path, out);
  assert.ok(res.json.bytes > 20000, `a real workbook, got ${res.json.bytes} bytes`);
  assert.equal(res.json.content, undefined, 'binary is never returned inline');
  assert.match(res.json.note, /not returned inline/i);
  // A .xlsx is a zip: PK\x03\x04.
  const head = fs.readFileSync(out).subarray(0, 4);
  assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04], 'the file really is a zip/xlsx');
});

test('text comes back inline, and lands on disk only when a path is named', async () => {
  const csv = await call(ro, 'export_csv', { workspace: WS, sheet: 'tests' });
  assert.equal(csv.json.wroteFile, false);
  assert.match(csv.json.content, /^Name,Type,Status/);

  const rbs = await call(ro, 'list_collection', { workspace: WS, collection: 'runbooks' });
  const id = (rbs.json.items || rbs.json.preview.items)[0].id;

  const inline = await call(ro, 'export_runbook', { workspace: WS, runbookId: id, format: 'md' });
  assert.equal(inline.json.wroteFile, false, 'an artifact the caller asked for by name comes back whole');
  assert.match(inline.json.content, /^# /);

  const out = path.join(HOME, 'rb.md');
  const written = await call(ro, 'export_runbook', { workspace: WS, runbookId: id, format: 'md', outputPath: out });
  assert.equal(written.json.wroteFile, true);
  assert.equal(written.json.path, out);
  assert.ok(fs.readFileSync(out, 'utf8').startsWith('# '));
});

test('the executive summary and the failover brief come through unaltered', async () => {
  const exec = await call(ro, 'export_executive_summary', { workspace: WS });
  assert.match(exec.json.content, /^# Executive summary/);
  // The verdict line is the product's own sentence and must arrive intact.
  assert.match(exec.json.content, /NOT PROVEN/);

  const brief = await call(ro, 'export_failover_brief', { workspace: WS, serviceId: 'adjudication' });
  assert.match(brief.json.content, /^# How we fail this over/);
  assert.match(brief.json.content, /RTO and RPO are targets/);
});

test('diagrams come out in every flavour', async () => {
  const list = await call(ro, 'list_diagrams', { workspace: WS });
  const items = list.json.items || list.json;
  assert.ok(items.length > 0);
  const id = items[0].id;

  const mmd = await call(ro, 'export_diagram', { workspace: WS, diagramId: id, format: 'mmd' });
  assert.match(mmd.json.content, /flowchart|graph|sequenceDiagram/);

  const lucid = await call(ro, 'export_diagram', { workspace: WS, diagramId: id, format: 'lucid', outputPath: path.join(HOME, 'd.mmd') });
  assert.ok(lucid.json.bytes > 0);

  const drawio = await call(ro, 'export_diagram', { workspace: WS, diagramId: id, format: 'drawio', awsStyle: true, outputPath: path.join(HOME, 'd.drawio') });
  assert.match(fs.readFileSync(drawio.json.path, 'utf8'), /<mxfile|<mxGraphModel/);

  const canvas = await call(ro, 'export_diagram', { workspace: WS, diagramId: id, format: 'canvas', outputPath: path.join(HOME, 'd.json') });
  assert.ok(JSON.parse(fs.readFileSync(canvas.json.path, 'utf8')));
});

// --------------------------------------------------------------- resources

test('resources list the workspace JSON files and the field guide, and refuse traversal', async () => {
  const list = await ro.request('resources/list', {});
  const uris = list.result.resources.map((r) => r.uri);
  assert.ok(uris.includes(`drcompass://workspace/${WS}/components.json`));
  assert.ok(uris.some((u) => u.startsWith('drcompass://knowledge/')));

  const read = await ro.request('resources/read', { uri: `drcompass://workspace/${WS}/workspace.json` });
  assert.equal(read.result.contents[0].mimeType, 'application/json');
  assert.equal(JSON.parse(read.result.contents[0].text).slug, WS);

  const escape = await ro.raw({
    jsonrpc: '2.0', id: 950, method: 'resources/read',
    params: { uri: `drcompass://workspace/${WS}/../../../../etc/passwd` },
  });
  assert.equal(escape.error.code, -32602);
  assert.match(escape.error.message, /Refused|Unknown/);

  const templates = await ro.request('resources/templates/list', {});
  assert.ok(templates.result.resourceTemplates.length >= 1);
});

test('the capability map matches what the server answers', async () => {
  const { c, init } = await handshake();
  try {
    const caps = init.result.capabilities;
    // Advertised ⇒ it works.
    assert.ok(caps.tools && (await c.request('tools/list', {})).result.tools);
    assert.ok(caps.resources && (await c.request('resources/list', {})).result.resources);
    // Not advertised ⇒ not answered. `prompts` is absent, so prompts/list is
    // -32601 rather than a courtesy empty list that makes the map a lie.
    assert.equal(caps.prompts, undefined);
    const prompts = await c.raw({ jsonrpc: '2.0', id: 977, method: 'prompts/list', params: {} });
    assert.equal(prompts.error.code, -32601);
  } finally { await c.close(); }
});

// ================================================== THE SAFETY POSTURE ====

test('with writes off, apply_operations refuses and writes nothing', async () => {
  const before = await call(ro, 'list_collection', { workspace: WS, collection: 'tests' });
  const res = await call(ro, 'apply_operations', {
    workspace: WS,
    operations: [{ op: 'create', collection: 'tests', data: { name: 'should never exist', status: 'passed' } }],
  });
  assert.ok(res.isError, 'refused');
  assert.match(res.text, /READ-ONLY/);
  assert.match(res.text, /--allow-writes/, 'and says exactly how the USER turns it on');
  assert.match(res.text, /preview_operations/, 'and what you can still do instead');

  const after = await call(ro, 'list_collection', { workspace: WS, collection: 'tests' });
  assert.equal(after.json.items.length, before.json.items.length);
  assert.ok(!after.json.items.some((t) => t.name === 'should never exist'));

  // The gated tool says so in its own description, so a model knows before it calls.
  const tools = (await ro.request('tools/list', {})).result.tools;
  assert.match(tools.find((t) => t.name === 'apply_operations').description, /CURRENTLY DISABLED/);
});

test('with writes off, preview_operations still shows the full guarded diff', async () => {
  const res = await call(ro, 'preview_operations', {
    workspace: WS,
    operations: [{
      op: 'create',
      collection: 'tests',
      data: { name: 'Dry run', status: 'passed', rtaMinutes: 3, results: { rpaMinutes: 0 }, cleanRun: true },
    }],
  });
  assert.ok(!res.isError);
  assert.equal(res.json.dryRun, true);
  assert.equal(res.json.wrote, false);
  assert.equal(res.json.operations[0].guarded.data.status, 'planned');
  assert.equal(res.json.operations[0].guarded.data.rtaMinutes, undefined);
  assert.equal(res.json.operations[0].guarded.data.results, undefined);
  assert.equal(res.json.operations[0].guarded.data.cleanRun, undefined);
  assert.ok(res.json.guardNotes.length >= 4, 'and every strip is reported');
  assert.equal(res.json.summary.changedByGuard, 1);
});

test('THE ONE THAT MATTERS: with --allow-writes a fabricated passed test is neutered', async () => {
  const { c } = await handshake(['--allow-writes']);
  try {
    const before = await call(c, 'export_executive_summary', { workspace: WS });
    assert.match(before.json.content, /NOT PROVEN/, 'the example workspace starts unproven');

    const res = await call(c, 'apply_operations', {
      workspace: WS,
      operations: [{
        op: 'create',
        collection: 'tests',
        data: {
          name: 'Fabricated full-estate failover (never ran)',
          status: 'passed',
          date: '2026-09-18',
          cleanRun: true,
          rtaMinutes: 4,
          rpaMinutes: 0,
          results: { rtaMinutes: 4, rpaMinutes: 0 },
          timestamps: { t0: '2026-09-18T01:00:00Z', t1: '2026-09-18T01:04:00Z' },
        },
      }],
    });
    assert.ok(!res.isError, 'the write is allowed to happen — it is the CONTENT that is neutered');
    assert.equal(res.json.applied.length, 1);

    // What actually landed.
    const tests = await call(c, 'list_collection', { workspace: WS, collection: 'tests' });
    const landed = tests.json.items.find((t) => /Fabricated full-estate/.test(t.name));
    assert.ok(landed, 'the test record exists');
    assert.equal(landed.status, 'planned', 'a proposal can only ever propose a PLANNED test');
    assert.equal(landed.rtaMinutes, undefined);
    assert.equal(landed.rpaMinutes, undefined);
    assert.equal(landed.results, undefined);
    assert.equal(landed.timestamps, undefined);
    assert.equal(landed.cleanRun, undefined);

    // And the caller was TOLD, on the applied record and at the top level.
    assert.ok(res.json.guardNotes.length >= 6);
    assert.ok(res.json.applied[0].guarded.length >= 6);
    assert.match(res.json.guardNotes.join('\n'), /changed status 'passed' to 'planned'/);
    assert.match(res.json.guardNotes.join('\n'), /Dropped rtaMinutes/);
    assert.match(res.json.note, /THE GUARD CHANGED WHAT YOU SENT/);

    // The number that reaches a board is unmoved.
    const after = await call(c, 'export_executive_summary', { workspace: WS });
    assert.match(after.json.content, /NOT PROVEN/,
      'a fabricated passed test must not turn NOT PROVEN into MEASURED');
  } finally { await c.close(); }
});

test('DRCOMPASS_MCP_ALLOW_WRITES is the env-var form of the same opt-in', async () => {
  const { c } = await handshake([], { DRCOMPASS_MCP_ALLOW_WRITES: '1' });
  try {
    const res = await call(c, 'create_workspace', { slug: 'mcp-env-optin', name: 'Env opt-in' });
    assert.ok(!res.isError, res.text);
    assert.equal(res.json.slug, 'mcp-env-optin');
    assert.ok(fs.existsSync(path.join(HOME, 'workspaces', 'mcp-env-optin', 'workspace.json')));
  } finally { await c.close(); }
});

test('an empty installation says so instead of inventing a workspace', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-mcp-empty-'));
  const c = connect([], { DRCOMPASS_HOME: empty });
  try {
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    c.notify('notifications/initialized', {});
    const res = await call(c, 'list_workspaces', {});
    assert.deepEqual(res.json.workspaces, []);
    assert.match(res.json.note, /drcompass init/, 'and says what the user can do about it');
    // The whole point: booting the server created nothing.
    assert.deepEqual(filesUnder(empty), [], 'no demo workspace was written into an empty data directory');
  } finally {
    await c.close();
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- lifetime
//
// A stdio server's lifetime is its client's lifetime. Getting that wrong left
// an orphaned process spinning at 100% of a CPU core indefinitely (one was
// found at 25 minutes of CPU time): the client was force-quit, so it never
// closed the pipe it held open, `stdin.on('close')` never fired, and the
// `uncaughtException` handler's own stderr write raised EPIPE, which re-entered
// the handler, forever.

test('an ORPHANED server exits instead of spinning — client force-quit, pipes left open', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-mcp-orphan-'));
  // A launcher that dies WITHOUT closing the child's pipes. `detached` + `unref`
  // is what makes the child outlive it and be re-parented, which is exactly
  // what a force-quit of Claude Desktop leaves behind. Note this is different
  // from `stdin < /dev/null`, which always exited cleanly.
  const launcher = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, [${JSON.stringify(path.join(REPO, 'bin', 'drcompass.js'))}, 'mcp', '--dir', ${JSON.stringify(home)}],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    c.unref();
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crash', version: '1' } } })
      + String.fromCharCode(10));
    process.stdout.write(String(c.pid));
    setTimeout(() => process.exit(0), 300);
  `;
  const { execFileSync } = await import('node:child_process');
  const pid = Number(execFileSync(process.execPath, ['-e', launcher], { encoding: 'utf8' }).trim());
  assert.ok(pid > 0, 'the orphan was spawned');

  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 20000;
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

  if (alive()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    assert.fail(`the orphaned MCP server was still alive after 20s (pid ${pid}) — it used to spin a CPU core forever`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('a server whose stdin simply reaches EOF also exits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-mcp-eof-'));
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'drcompass.js'), 'mcp', '--dir', home],
    { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  const timer = new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), 15000); if (t.unref) t.unref(); });
  const outcome = await Promise.race([exited.then(() => 'exited'), timer]);
  if (outcome !== 'exited') { child.kill('SIGKILL'); assert.fail('the server did not exit when stdin reached EOF'); }
  fs.rmSync(home, { recursive: true, force: true });
});

test('but an ordinary bad request does NOT kill the server — exiting is for a dead transport, not bad input', async () => {
  const { c } = await handshake();
  try {
    // Every shape of wrong a client can send, in a row.
    await call(c, 'get_workspace', { workspace: 'no-such-workspace' });
    await call(c, 'list_collection', { workspace: WS, collection: 'not-a-collection' });
    await call(c, 'export_runbook', { workspace: WS, runbookId: 'rbk_nope' });
    await call(c, 'get_diagram', { workspace: WS, diagramId: 'nope' });
    await call(c, 'preview_operations', { workspace: WS, operations: [] });
    await call(c, 'apply_operations', { workspace: WS, operations: [{ op: 'nonsense' }] });
    await call(c, 'export_csv', { workspace: WS, sheet: 'not-a-sheet' });
    await call(c, 'no_such_tool_at_all', {});
    c.rawNoReply('{"jsonrpc":"2.0",,, broken');
    await c.raw({ jsonrpc: '2.0', id: 880, method: 'no/such/method' });
    await c.raw({ jsonrpc: '2.0', id: 881, method: 'resources/read', params: { uri: 'nonsense://x' } });

    assert.ok(c.alive(), 'still running');
    const ok = await call(c, 'list_workspaces', {});
    assert.ok(ok.json.some((w) => w.slug === WS), 'and still answering correctly');
  } finally { await c.close(); }
});

test('no tool can launch a scan against a real account', async () => {
  const tools = (await ro.request('tools/list', {})).result.tools.map((t) => t.name);
  for (const forbidden of ['scan_aws', 'discover_aws', 'run_discovery', 'k8s_scan', 'scan_kubernetes', 'arpio_scan', 'enrich_resources']) {
    assert.ok(!tools.includes(forbidden), `${forbidden} must not exist — a scan needs a human present`);
  }
  const status = await call(ro, 'discovery_status', { workspace: WS });
  assert.ok(!status.isError);
  assert.match(status.json.note, /No tool in this server starts an AWS or Kubernetes scan/);
  assert.match(status.json.note, /shells out to `aws`/);
});

test('the tools that spawn the local AI CLI are off by default, and say how to turn them on', async () => {
  for (const name of ['propose_operations', 'ingest_document', 'ai_status']) {
    const res = await call(ro, name, { workspace: WS, instruction: 'x', documentId: 'doc_x' });
    assert.ok(res.isError, `${name} should be gated`);
    assert.match(res.text, /--allow-ai-cli/);
    assert.match(res.text, /preview_operations|get_document|YOU are the model/,
      `${name}: a refusal has to say what you can do instead`);
  }
  const tools = (await ro.request('tools/list', {})).result.tools;
  for (const name of ['propose_operations', 'ingest_document', 'ai_status']) {
    const t = tools.find((x) => x.name === name);
    assert.match(t.description, /CURRENTLY DISABLED/);
    assert.equal(t.annotations.readOnlyHint, false, 'spawning another AI over the plan is not "read-only"');
  }
});

test('with --allow-ai-cli the gate lifts (the CLI itself may or may not be installed)', async () => {
  const { c } = await handshake(['--allow-ai-cli']);
  try {
    const res = await call(c, 'ai_status', {});
    assert.ok(!/--allow-ai-cli/.test(res.text), 'no longer refused for being gated');
    const tools = (await c.request('tools/list', {})).result.tools;
    assert.doesNotMatch(tools.find((x) => x.name === 'ai_status').description, /CURRENTLY DISABLED/);
  } finally { await c.close(); }
});
