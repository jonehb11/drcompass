#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const program = new Command();
program.name('drcompass').description('DR Compass — disaster recovery planning studio').version(pkg.version);

async function startServer(opts) {
  const { createServer } = await import('../server/index.js');
  const { seedExample } = await import('../server/store.js');
  seedExample();
  const port = Number(opts.port || process.env.DRCOMPASS_PORT || 4517);
  // Bind to the loopback interface, NOT every interface.
  //
  // `app.listen(port)` with no host binds 0.0.0.0/::, which put the whole
  // workspace — inventory, ARNs, secret names, gaps, the recovery plan — on the
  // local network with no authentication in front of it. On office or cafe
  // wifi that is everyone. There is no login in this product by design, and the
  // reason that is acceptable is that it only ever answers this machine.
  //
  // --host is the deliberate opt-out for someone who genuinely wants to reach
  // it from another machine; it warns, because they are publishing an
  // unauthenticated copy of their DR plan.
  const host = opts.host || process.env.DRCOMPASS_HOST || '127.0.0.1';
  const app = createServer();
  app.listen(port, host, async () => {
    const url = `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`;
    console.log(`\n  🧭  DR Compass v${pkg.version}`);
    console.log(`  UI:        ${url}`);
    console.log(`  Data dir:  ${process.env.DRCOMPASS_HOME || '~/.drcompass'}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      // Deliberately blunt. "Anyone can change your workspace" understates it:
      // the AI-tool setting lets a caller name ANY executable on this machine
      // and then run it (Settings → AI tool → custom command, which the API
      // exposes as PUT /ai/provider + POST /ai/provider/test). With no login,
      // that is arbitrary code execution as the user running drcompass — which
      // means their ~/.aws credentials. Loopback is what contains it, so anyone
      // turning that off should be told exactly what they are turning off.
      console.log(`\n  ⚠  DANGER — listening on ${host}, not just this machine.`);
      console.log(`     DR Compass has NO login. Anyone who can reach this port can read and`);
      console.log(`     change this workspace — and can set the AI tool to any command and run`);
      console.log(`     it, which is code execution as ${process.env.USER || 'you'}, with your AWS credentials.`);
      console.log(`     Only do this on a network you control. The default (localhost) is safe.`);
    }
    console.log(`  Stop with Ctrl+C\n`);
    if (opts.open !== false) {
      try { (await import('open')).default(url); } catch { /* headless is fine */ }
    }
  });
}

program.command('start', { isDefault: true })
  .description('start the DR Compass UI on localhost')
  .option('-p, --port <port>', 'port (default 4517)')
  .option('--host <host>', 'interface to bind (default 127.0.0.1 — anything else exposes an unauthenticated workspace to the network)')
  .option('--no-open', 'do not open the browser')
  .option('--dir <path>', 'workspace data directory (overrides ~/.drcompass)')
  .action((opts) => {
    if (opts.dir) process.env.DRCOMPASS_HOME = path.resolve(opts.dir);
    startServer(opts);
  });

program.command('init <slug>')
  .description('create a new empty workspace')
  .option('--name <name>', 'display name')
  .action(async (slug, opts) => {
    const { createWorkspace } = await import('../server/store.js');
    const ws = createWorkspace(slug, { name: opts.name || slug });
    console.log(`Created workspace '${ws.slug}'. Run \`drcompass\` and open it in the UI.`);
  });

program.command('list')
  .description('list workspaces')
  .action(async () => {
    const { listWorkspaces } = await import('../server/store.js');
    for (const w of listWorkspaces()) console.log(`${w.slug}\t${w.name}`);
  });

// `drcompass mcp` — the Model Context Protocol server, over stdio.
//
// Launched by an MCP client (Claude Desktop, `claude mcp add`, anything else
// that speaks MCP) as a child process with no TTY: stdin and stdout are the
// protocol, every diagnostic goes to stderr. Nothing is printed here for that
// reason — a console.log on this path would corrupt the first frame.
//
// READ-ONLY BY DEFAULT. --allow-writes is the deliberate opt-in that lets
// `apply_operations` change the plan, and even then every operation goes
// through the same honest-numbers guard POST /ai/apply runs. See docs/mcp.md.
program.command('mcp')
  .description('run the MCP server on stdio so an AI client can drive DR Compass (read-only unless --allow-writes)')
  .option('--allow-writes', 'permit the tools that change workspace data (off by default)')
  .option('--allow-ai-cli', 'permit the tools that spawn the local AI CLI over your plan (off by default)')
  .option('--dir <path>', 'workspace data directory (overrides ~/.drcompass)')
  .action(async (opts) => {
    if (opts.dir) process.env.DRCOMPASS_HOME = path.resolve(opts.dir);
    const { startMcp } = await import('../server/mcp/index.js');
    await startMcp({ allowWrites: !!opts.allowWrites, allowAiCli: !!opts.allowAiCli });
  });

program.command('export <slug>')
  .description('export a workspace workbook to an .xlsx file')
  .option('--xlsx <path>', 'output path', 'dr-compass-export.xlsx')
  .action(async (slug, opts) => {
    const { buildWorkbook } = await import('../server/lib/xlsx-gen.js');
    const wb = await buildWorkbook(slug);
    await wb.xlsx.writeFile(opts.xlsx);
    console.log(`Wrote ${opts.xlsx}`);
  });

program.parse();
