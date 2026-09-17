// Which local AI CLI does this machine use?
//
// Three endpoints, deliberately in their own router so the (much busier)
// routes/ai.js does not have to change. Mounted at /api by server/index.js via
// mountOptional, so a breakage here cannot take the rest of the API down.
//
// Nothing here ever runs a shell string — server/lib/ai-providers.js spawns
// with argument arrays only.
import { Router } from 'express';
import * as store from '../store.js';
import {
  detectProviders, setSelectedProvider, testProvider, getSelectedProvider,
  validateSelection, PROMPT_TOKEN,
} from '../lib/ai-providers.js';

const r = Router();

// Every known CLI, whether it is on PATH, its version, whether its own --help
// actually contains the flags DR Compass would use, and what is selected.
r.get('/w/:ws/ai/providers', async (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 if missing
    res.json({ ok: true, ...(await detectProviders(req.params.ws)) });
  } catch (e) { next(e); }
});

// Machine-wide view, for callers with no workspace in hand.
r.get('/ai/providers', async (req, res, next) => {
  try { res.json({ ok: true, ...(await detectProviders(null)) }); } catch (e) { next(e); }
});

// Select a provider. Body is {id} for a built-in, or
// {id:'custom', bin, argsTemplate, input} for the escape hatch.
// `scope: 'global'` writes the machine default instead of the workspace
// override; {id:'inherit'} clears a workspace override.
//
// Validation is hard and up front: a custom template with no {prompt} in argv
// mode, or a binary that is not on PATH, is a 400 that says exactly that,
// because the alternative is a mysterious failure three minutes into a
// document ingestion.
r.put('/w/:ws/ai/provider', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const global = String(body.scope || '') === 'global';

    // 'inherit' clears a workspace override and is meaningless globally.
    const inherit = String(body.id || '') === 'inherit';
    if (inherit && global) {
      const m = 'scope "global" has nothing to inherit from — send a provider id, or drop the scope to clear this workspace\'s override.';
      return res.status(400).json({ ok: false, error: m, message: m });
    }
    if (!inherit) {
      const v = validateSelection(body);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.message, message: v.message, promptToken: PROMPT_TOKEN });
    }

    const out = setSelectedProvider(global ? null : ws, body);
    if (!out.ok) return res.status(400).json({ ok: false, error: out.message, message: out.message, promptToken: PROMPT_TOKEN });

    const sel = getSelectedProvider(ws);
    res.json({
      ok: true,
      scope: out.scope,
      selection: out.selection,
      selected: sel ? { id: sel.id, name: sel.name, bin: sel.bin, input: sel.input, source: sel.source, verified: sel.verified } : null,
    });
  } catch (e) { next(e); }
});

// Run a trivial prompt through a provider and report exactly what came back —
// the only thing in this feature that is allowed to say "this works".
r.post('/w/:ws/ai/provider/test', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // No body at all → test whatever is currently selected.
    const target = body.id ? body : null;
    if (target) {
      const v = validateSelection(target);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.message, message: v.message, promptToken: PROMPT_TOKEN });
    }
    const out = await testProvider(target, { slug: ws });
    res.json(out);
  } catch (e) { next(e); }
});

export default r;
