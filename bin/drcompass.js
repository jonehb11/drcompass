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
  const app = createServer();
  app.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  🧭  DR Compass v${pkg.version}`);
    console.log(`  UI:        ${url}`);
    console.log(`  Data dir:  ${process.env.DRCOMPASS_HOME || '~/.drcompass'}`);
    console.log(`  Stop with Ctrl+C\n`);
    if (opts.open !== false) {
      try { (await import('open')).default(url); } catch { /* headless is fine */ }
    }
  });
}

program.command('start', { isDefault: true })
  .description('start the DR Compass UI on localhost')
  .option('-p, --port <port>', 'port (default 4517)')
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
