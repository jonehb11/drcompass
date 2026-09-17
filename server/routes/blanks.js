// Blanks — what is MISSING from the plan, as an endpoint.
//
// `server/lib/blanks.js` computes it; this file is the thin HTTP skin. It is a
// READ-ONLY router: there is no POST, PUT or DELETE here and there never should
// be, because a blank is a derived fact about the workspace, not a record in it.
//
// Scoping uses the shared helper exactly as `routes/collections.js` does —
// findBlanks() calls `resolveScopeOrThrow` itself, so an unknown envId or
// serviceId comes back as a 404 naming the ids that DO exist rather than as an
// empty list. Silently returning zero blanks for a typo is how somebody
// concludes their plan is complete.
//
// Pre-mounted at /api by server/index.js.
import { Router } from 'express';
import { findBlanks, IMPORTANCE } from '../lib/blanks.js';

const r = Router();

// GET /w/:ws/blanks[?envId=&serviceId=&importance=&kind=]
//
// `importance` and `kind` are convenience filters over the computed list. They
// narrow what is RETURNED; `counts` always describes the full scoped set, so a
// filtered request cannot make a plan look more complete than it is.
r.get('/w/:ws/blanks', (req, res, next) => {
  try {
    const q = req.query || {};
    const result = findBlanks(req.params.ws, q);

    const wantImportance = new Set(
      String(q.importance || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    const wantKind = new Set(
      String(q.kind || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    const items = result.items.filter((it) => (!wantImportance.size || wantImportance.has(it.importance))
      && (!wantKind.size || wantKind.has(it.kind)));

    res.json({
      items,
      // Always the UNFILTERED counts — see the note above.
      counts: result.counts,
      ...(items.length === result.items.length ? {} : { filtered: { returned: items.length, of: result.counts.total } }),
      ...(result.scope ? { scope: result.scope } : {}),
      importanceOrder: IMPORTANCE,
      note: 'Derived from this workspace on every request — nothing is stored. '
        + 'A blank is a field the plan leaves empty, graded by the tier, the environment and the recovery scope '
        + 'of the thing it is missing from, and listing the exports it shows up in.',
    });
  } catch (e) { next(e); }
});

export default r;
