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
      console.log(`\n  ⚠  Listening on ${host} — reachable from your network, and DR Compass`);
      console.log(`     has no login. Anyone who can reach this port can read AND change`);
      console.log(`     this workspace. Use the default (localhost) unless you meant this.`);
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
