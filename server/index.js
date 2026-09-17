import express, { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function mountOptional(app, route, modPath) {
  try {
    const mod = await import(modPath);
    app.use(route, mod.default);
  } catch (e) {
    // A missing/broken feature router must not take the whole app down — and,
    // critically, its fallback must not swallow every later /api route. A bare
    // app.use('/api', fn) matches EVERYTHING under /api, so the 501 handler is
    // scoped to a router that only answers paths naming this feature.
    console.error(`[drcompass] router ${modPath} not mounted: ${e.message}`);
    const feature = String(modPath).replace(/^.*\//, '').replace(/\.js$/, '');
    const fallback = Router();
    const reply = (req, res) => res.status(501).json({ error: `feature unavailable: ${e.message}` });
    fallback.all(new RegExp(`/${feature}(/|$)`), reply);
    fallback.all(new RegExp(`/w/[^/]+/${feature}(/|$)`), reply);
    app.use(route, fallback);
  }
}

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // Static UI + vendored mermaid (ESM dist served straight from node_modules)
  app.use(express.static(path.join(__dirname, '..', 'web')));
  const mermaidDist = path.dirname(require.resolve('mermaid/package.json'));
  app.use('/vendor/mermaid', express.static(path.join(mermaidDist, 'dist')));

  const p = (f) => `./routes/${f}.js`;
  const mounts = (async () => {
    const workspace = await import(p('workspace'));
    const collections = await import(p('collections'));
    const knowledge = await import(p('knowledge'));
    app.use('/api', workspace.default);
    app.use('/api', collections.default);
    app.use('/api/knowledge', knowledge.default);
    await mountOptional(app, '/api', p('assessment'));
    await mountOptional(app, '/api', p('diagrams'));
    await mountOptional(app, '/api', p('exports'));
    await mountOptional(app, '/api', p('discover'));
    await mountOptional(app, '/api', p('recommend'));
    await mountOptional(app, '/api', p('ai'));
    // Which local AI CLI every AI feature runs through (server/lib/ai-providers.js).
    await mountOptional(app, '/api', p('ai-providers'));
    await mountOptional(app, '/api', p('layouts'));
    await mountOptional(app, '/api', p('k8s'));
    await mountOptional(app, '/api', p('resources'));
    await mountOptional(app, '/api', p('jobs'));
    await mountOptional(app, '/api', p('network'));
    await mountOptional(app, '/api', p('service'));
    await mountOptional(app, '/api', p('deploy-order'));
    await mountOptional(app, '/api', p('environments'));
    await mountOptional(app, '/api', p('services'));
    await mountOptional(app, '/api', p('documents'));
    // What the plan leaves EMPTY (server/lib/blanks.js) — read-only, and the
    // context the `general` document flow is pointed at.
    await mountOptional(app, '/api', p('blanks'));

    app.use('/api', (req, res) => res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}` }));
    // SPA fallback
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));
    // JSON error handler
    app.use((err, req, res, next) => {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message || 'internal error' });
    });
  })();
  app.ready = mounts;
  return app;
}
