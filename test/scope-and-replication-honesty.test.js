// Regression tests for the v0.7.1 DR-architect findings owned by the
// diagrams / scope / workbook lane. Every one of them is a surface asserting
// something the data does not say.
//
//   node --test test/
//
//   NEW-1 (BLOCKER) the SUMMARISED region-pair diagram derived "mirrored" from
//                   `inRecoveryScope` alone, so 40 tier-0 stores of which 36
//                   had no replication mechanism rendered as "10 components
//                   mirrored" under "Every component here has a recovery-side
//                   counterpart". `notReplicated` was already computed and
//                   sitting unused on the same object.
//   B2    (BLOCKER) the workbook was silent on an ungated ROLLBACK traffic
//                   step that the .txt export of the same runbook correctly
//                   marked BLOCKED — DO NOT RUN.
//   H4    (HIGH)    a SERVICE-scoped package printed the WORKSPACE region pair,
//                   because scope.js read the service's own envId only to warn
//                   about a mismatch and never adopted it.
//   NEW-3 (HIGH)    the computed-findings table was workspace-wide inside a
//                   scoped package whose own disclosure said those findings
//                   "do not appear anywhere in this package".
//   NEW-5 (HIGH)    the Workbench sheet printed a green `Pass` for a number the
//                   Executive Summary of the same workbook called
//                   "MET ON A PAST RUN — NOT PROVEN CURRENT".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- fixtures

// A throwaway DRCOMPASS_HOME per case: these tests write workspaces.
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-scoperepl-'));
  const prev = process.env.DRCOMPASS_HOME;
  process.env.DRCOMPASS_HOME = home;
  try {
    const store = await import('../server/store.js');
    return await fn({ store, home });
  } finally {
    if (prev === undefined) delete process.env.DRCOMPASS_HOME;
    else process.env.DRCOMPASS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeWorkspace(home, slug, files) {
  const dir = path.join(home, 'workspaces', slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2));
  }
}

// THE REVIEWER'S FIXTURE. 40 tier-0 data stores in four services; exactly one
// store per service carries a real mechanism, so 36 of 40 have none at all.
// 40 stores draw 81 nodes, which is past the 70-node summarisation gate — the
// smallest realistic estate that trips it.
const UNREPLICATED_ESTATE = (() => {
  const cats = ['database', 'storage', 'messaging-streaming'];
  const groups = ['alpha', 'bravo', 'charlie', 'delta'];
  const components = [];
  for (const g of groups) {
    for (let i = 0; i < 10; i++) {
      components.push({
        id: `cmp_${g}_${i}`,
        name: `${g}-store-${i + 1}`,
        category: cats[i % cats.length],
        kind: 'store',
        tier: 0,
        restoreLayer: 'L3',
        serviceId: `svc_${g}`,
        inRecoveryScope: 'yes',
        replication: i === 0 ? { mechanism: 'aurora-global', rpoMinutes: 1 } : { mechanism: '' },
        dependsOn: [],
      });
    }
  }
  return {
    workspace: {
      slug: 'estate', name: 'Estate', regions: { primary: 'eu-west-1', recovery: 'eu-central-1' },
      tooling: [], objectives: {},
    },
    components: { items: components },
    services: {
      items: groups.map((g) => ({
        id: `svc_${g}`, name: g, slug: g, tier: 0,
        componentIds: components.filter((c) => c.serviceId === `svc_${g}`).map((c) => c.id),
      })),
    },
    runbooks: { items: [] }, tests: { items: [] }, gaps: { items: [] }, checklists: { items: [] },
  };
})();

const diagramData = (store, slug) => ({
  workspace: store.getWorkspace(slug),
  components: store.getCollection(slug, 'components') || [],
  runbooks: store.getCollection(slug, 'runbooks') || [],
  services: store.getCollection(slug, 'services') || [],
});

// ============================================================ NEW-1 ========

test('NEW-1 · the summarised region pair never calls an unreplicated store mirrored', async () => {
  await withHome(async ({ store, home }) => {
    writeWorkspace(home, 'estate', UNREPLICATED_ESTATE);
    const gen = await import('../server/lib/diagram-gen.js');
    const data = diagramData(store, 'estate');
    const full = gen.regionPair(data);
    const out = gen.applyMermaidBudget(full, data);

    assert.ok(out.summarized, 'this estate must trip the summarisation gate');
    assert.ok(out.summarized.from.nodes > gen.MERMAID_MAX_NODES);

    // The word that was the lie.
    assert.ok(!/mirrored/i.test(out.mermaid), 'no node may claim a store is mirrored');
    assert.ok(!/Every component here has a recovery-side counterpart/.test(out.notes),
      'the reassurance sentence must not survive an estate with no replication');

    // Node text, arrow label and prose all carry the unreplicated count.
    assert.match(out.mermaid, /9 of 10 stores NOT replicated/,
      'each recovery-side node states how many of its stores have no mechanism');
    assert.match(out.mermaid, /aurora-global x1 — 9 of 10 stores NOT replicated/,
      'the arrow may not carry a mechanism one store uses as if it covered ten');
    assert.match(out.notes, /36 of 40 data stores here have NO replication mechanism at all/);
    assert.match(out.notes, /most of the data in this picture does not exist in eu-central-1 today/);

    // And it is loud in the rendering as well as in the words.
    assert.match(out.mermaid, /class q0,q1,q2,q3 notrep/);
    assert.match(out.mermaid, /linkStyle 0 stroke:#e2564f/);

    // The counts reach the API payload, not only the prose.
    assert.equal(out.summarized.storeCount, 40);
    assert.equal(out.summarized.notReplicated, 36);
  });
});

test('NEW-1 · scope and mechanism stay two different facts in both directions', async () => {
  await withHome(async ({ store, home }) => {
    // Everything replicated, and one group of stateless components with no
    // stores at all: the diagram must be reassuring only where it is entitled.
    const fixture = JSON.parse(JSON.stringify(UNREPLICATED_ESTATE));
    for (const c of fixture.components.items) c.replication = { mechanism: 'aurora-global', rpoMinutes: 1 };
    writeWorkspace(home, 'estate', fixture);
    const gen = await import('../server/lib/diagram-gen.js');
    const data = diagramData(store, 'estate');
    const out = gen.applyMermaidBudget(gen.regionPair(data), data);
    assert.equal(out.summarized.notReplicated, 0);
    assert.match(out.notes, /Every one of the 40 data stores here has a replication mechanism recorded/);
    assert.match(out.notes, /a mechanism on file, not a tested recovery/,
      'a recorded mechanism is still not evidence, and the note may not imply it is');
    assert.ok(!/NOT replicated/.test(out.mermaid));

    // A store marked IN recovery scope whose mechanism is the string 'none' is
    // not replicated: a mechanism that means no mechanism may not label an arrow.
    const fixture2 = JSON.parse(JSON.stringify(UNREPLICATED_ESTATE));
    for (const c of fixture2.components.items) c.replication = { mechanism: 'none' };
    writeWorkspace(home, 'estate2', { ...fixture2, workspace: { ...fixture2.workspace, slug: 'estate2' } });
    const data2 = diagramData(store, 'estate2');
    const out2 = gen.applyMermaidBudget(gen.regionPair(data2), data2);
    assert.equal(out2.summarized.notReplicated, 40);
    assert.match(out2.mermaid, /NO replication mechanism/);
    assert.ok(!/\|"none/.test(out2.mermaid), "'none' may not be printed as a mechanism");
  });
});

test('NEW-1 · the icon canvas gives an unreplicated store no recovery-side twin', async () => {
  await withHome(async ({ store, home }) => {
    writeWorkspace(home, 'estate', UNREPLICATED_ESTATE);
    const gen = await import('../server/lib/diagram-gen.js');
    const canvas = gen.buildCanvasData('region-pair', diagramData(store, 'estate'));
    const twins = canvas.nodes.filter((n) => String(n.id).startsWith('rec_'));
    assert.equal(twins.length, 4, 'only the four stores with a mechanism get a copy in the recovery region');
    assert.equal(canvas.edges.length, 4);
    assert.ok(canvas.edges.every((e) => e.label !== 'replication'),
      'no arrow may be labelled "replication" for a store nothing replicates');
    const orphan = canvas.nodes.find((n) => n.id === 'cmp_alpha_1');
    assert.match(String(orphan.sub), /not replicated/);
  });
});

// ============================================================ B2 ===========

// Forward path correctly gated; the ROLLBACK flips traffic back with nothing
// verified above it — the reviewer's reproduction.
const ROLLBACK_WS = {
  workspace: {
    slug: 'rbk', name: 'Rollback fixture',
    regions: { primary: 'eu-west-1', recovery: 'eu-central-1' }, tooling: [], objectives: {},
  },
  components: {
    items: [{
      id: 'cmp_edge', name: 'edge-router', category: 'edge-dns', kind: 'Route53 record',
      tier: 0, restoreLayer: 'L7', inRecoveryScope: 'yes',
    }],
  },
  services: { items: [] },
  runbooks: {
    items: [{
      id: 'rbk_failover', name: 'Region failover',
      steps: [
        {
          layer: 'L6', title: 'Pre-cutover verification — success bar', gate: true,
          gateKind: 'pre-cutover-verification',
          tests: [{ name: 'One real claim adjudicates end to end', onFail: 'block', expected: 'HTTP 200', owner: 'claims' }],
        },
        { layer: 'L6', title: 'Named human approval — go/no-go', gateKind: 'cutover-approval' },
        { layer: 'L7', title: 'Flip Route53 to eu-central-1', gateKind: 'traffic-cutover', command: 'flip' },
      ],
      rollback: [
        { layer: 'L7', title: 'Flip Route53 back to eu-west-1', gateKind: 'traffic-cutover', command: 'unflip' },
        { layer: 'L4', title: 'Scale eu-west-1 back up' },
      ],
    }],
  },
  tests: { items: [] }, gaps: { items: [] }, checklists: { items: [] },
};

const rowCells = (ws, rn) => {
  const out = [];
  ws.getRow(rn).eachCell({ includeEmpty: true }, (c) => {
    const v = c.value;
    out.push(v == null ? '' : typeof v === 'object' ? (v.text || '') : String(v));
  });
  return out;
};

test('B2 · the workbook flags an ungated ROLLBACK traffic step, as the .txt always did', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'rbk', ROLLBACK_WS);
    const gen = await import('../server/lib/xlsx-gen.js');
    const wb = await gen.buildWorkbook('rbk');
    const ws = wb.worksheets.find((s) => s.name.startsWith('Runbooks'));
    const cellRows = [];
    ws.eachRow({ includeEmpty: false }, (r, rn) => cellRows.push(rowCells(ws, rn)));
    const rows = cellRows.map((r) => r.join(' ¦ '));
    const text = rows.join('\n');

    // The STEP row, not the finding row under it: column 1 carries R1.
    const r1 = cellRows.filter((r) => r[0] === 'R1').map((r) => r.join(' ¦ '))[0];
    assert.ok(r1, 'the rollback step is still on the sheet');
    assert.match(r1, /\*\*\* BLOCKED — DO NOT RUN \*\*\*/,
      'the flag is TEXT, not colour: this sheet gets printed in greyscale');
    assert.match(r1, /Blocked/, 'its Status cell is Blocked, not Not started');
    assert.match(text, /BEFORE YOU RUN THE ROLLBACK/);
    assert.match(text, /ROLLBACK \*\*\* CUTOVER NOT GATED/,
      'a collapsed runbook block still says its rollback is ungated');
    // Rollback findings are about ROLLBACK step numbers and must not be
    // presented as a reason to stop the cutover above.
    assert.match(text, /none of these is a reason not to run the cutover above/);
    // The forward path, which the reviewer verified as correct, is untouched.
    const fwd = cellRows.filter((r) => r[0] === '3').map((r) => r.join(' ¦ '))[0];
    assert.match(fwd, /Flip Route53 to eu-central-1/);
    assert.ok(!/\*\*\* BLOCKED/.test(fwd), 'the forward traffic step is properly gated here');
  });
});

test('B2 · the runbook-steps CSV carries the gate columns for rollback rows too', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'rbk', ROLLBACK_WS);
    const gen = await import('../server/lib/xlsx-gen.js');
    const ds = gen.csvDataset('rbk', 'runbook-steps');
    const gateCol = ds.headers.indexOf('Cutover gate');
    assert.ok(gateCol > 0);
    const r1 = ds.rows.find((r) => r[3] === 'Flip Route53 back to eu-west-1');
    assert.match(String(r1[gateCol]), /BLOCKED — DO NOT RUN/);
    assert.match(String(r1[gateCol]), /moves live traffic/);
    // Indexes are ROLLBACK-relative: the finding is about rollback step 1, not
    // about forward step 1 (which is the verification gate).
    assert.match(String(r1[gateCol]), /step 1 \(“Flip Route53 back to eu-west-1”\)/);
    const r2 = ds.rows.find((r) => r[3] === 'Scale eu-west-1 back up');
    assert.equal(String(r2[gateCol]), '', 'a rollback step that moves no traffic is not flagged');
  });
});

// ============================================================ H4 ===========

const ENVS_WS = {
  workspace: {
    slug: 'envs', name: 'Envs fixture',
    regions: { primary: 'eu-west-1', recovery: 'eu-central-1' },
    tooling: [], objectives: {},
    environments: [
      { id: 'env_eu', name: 'EU', slug: 'eu', regions: { primary: 'eu-west-1', recovery: 'eu-central-1' } },
      { id: 'env_apac', name: 'APAC', slug: 'apac', regions: { primary: 'ap-southeast-2', recovery: 'ap-southeast-1' } },
    ],
  },
  components: {
    items: [
      {
        id: 'cmp_edge', name: 'edge-cache', category: 'compute', tier: 0, restoreLayer: 'L4',
        envId: 'env_apac', serviceId: 'svc_edge', inRecoveryScope: 'yes', dependsOn: [],
      },
      {
        id: 'cmp_ledger', name: 'ledger-api', category: 'compute', tier: 0, restoreLayer: 'L4',
        envId: 'env_eu', serviceId: 'svc_ledger', inRecoveryScope: 'yes', dependsOn: ['cmp_ghost'],
      },
    ],
  },
  services: {
    items: [
      { id: 'svc_edge', name: 'edge-delivery', slug: 'edge-delivery', envId: 'env_apac', tier: 0, componentIds: ['cmp_edge'] },
      { id: 'svc_ledger', name: 'ledger', slug: 'ledger', envId: 'env_eu', tier: 0, componentIds: ['cmp_ledger'] },
    ],
  },
  runbooks: { items: [] }, tests: { items: [] },
  gaps: {
    items: [{
      id: 'gap_ledger', title: 'Ledger restore order has a hole', severity: 'blocker',
      status: 'open', componentId: 'cmp_ledger',
    }],
  },
  checklists: { items: [] },
};

test('H4 · a service-scoped package prints its own environment\'s region pair', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'envs', ENVS_WS);
    const { resolveScope } = await import('../server/lib/scope.js');
    const { resolveExportScope } = await import('../server/lib/export-scope.js');
    const gen = await import('../server/lib/xlsx-gen.js');

    const scope = resolveScope('envs', { serviceId: 'svc_edge' });
    assert.equal(scope.envId, 'env_apac', 'the service brings its environment with it');
    assert.equal(scope.envInherited, true);

    const ex = resolveExportScope('envs', { serviceId: 'svc_edge' });
    assert.deepEqual(ex.envRegions, { primary: 'ap-southeast-2', recovery: 'ap-southeast-1' });

    const m = await gen.executiveSummaryModel('envs', ex);
    const env = m.identityRows.find((r) => r.name === 'Environment');
    assert.equal(env.value, 'APAC');
    assert.match(env.note, /ap-southeast-2 → ap-southeast-1/);
    assert.ok(!/eu-west-1/.test(env.note), 'the workspace default must not reach this row');
  });
});

test('H4 · an inherited environment labels the scope and narrows nothing', async () => {
  await withHome(async ({ home }) => {
    // The service's component is recorded in the OTHER environment. Adopting
    // the service's env must not delete it from its own service's package.
    const ws = JSON.parse(JSON.stringify(ENVS_WS));
    ws.components.items[0].envId = 'env_eu';
    writeWorkspace(home, 'envs', ws);
    const { resolveScope } = await import('../server/lib/scope.js');
    const scope = resolveScope('envs', { serviceId: 'svc_edge' });
    assert.equal(scope.envId, 'env_apac');
    assert.deepEqual([...scope.componentIds], ['cmp_edge'], 'the component is kept');
    assert.ok(scope.warnings.some((w) => /belong to another environment/.test(w)),
      'and the disagreement is reported rather than filtered away');
  });
});

test('H4 · an explicitly requested environment still wins, and still warns', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'envs', ENVS_WS);
    const { resolveScope } = await import('../server/lib/scope.js');
    const scope = resolveScope('envs', { serviceId: 'svc_edge', envId: 'env_eu' });
    assert.equal(scope.envId, 'env_eu', 'the caller asked for EU; the caller gets EU');
    assert.ok(!scope.envInherited);
    assert.equal(scope.componentCount, 0, 'the result is the intersection and may be empty');
    assert.ok(scope.warnings.some((w) => /not the requested environment/.test(w)));
  });
});

test('H4 · no scope still means everything, unchanged', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'envs', ENVS_WS);
    const { resolveScope } = await import('../server/lib/scope.js');
    const scope = resolveScope('envs', {});
    assert.equal(scope.active, false);
    assert.equal(scope.envId, null);
    assert.equal(scope.envInherited, false);
  });
});

// ============================================================ NEW-3 ========

test('NEW-3 · the computed-findings table agrees with the package\'s own disclosure', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'envs', ENVS_WS);
    const { resolveExportScope } = await import('../server/lib/export-scope.js');
    const gen = await import('../server/lib/xlsx-gen.js');

    const wide = await gen.executiveSummaryModel('envs');
    assert.ok(wide.computedRisks.total > 0, 'the risk engine has something to say about this workspace');
    assert.equal(wide.computedRisks.scopedToSlice, false);
    assert.equal(wide.computedRisks.outsideCount, 0);

    const ex = resolveExportScope('envs', { serviceId: 'svc_edge' });
    const m = await gen.executiveSummaryModel('envs', ex);
    assert.equal(m.computedRisks.scopedToSlice, true);
    // Nothing in the table may be filed against a component this package says
    // it does not contain.
    const ids = new Set(ex.componentIds);
    for (const s of m.stoppers) {
      assert.ok(!/ledger/i.test(s.component),
        `the edge package listed a finding filed against ${s.component}`);
    }
    for (const f of m.computedRisks.top) {
      assert.ok(!f.componentId || ids.has(f.componentId), `${f.componentId} is outside this scope`);
    }
    // …and what the narrowing removed is COUNTED, never silently dropped.
    assert.ok(m.computedRisks.outsideCount > 0);
    assert.match(m.stopperHeadline, /outside/i,
      'a scoped package may not read clean without saying what is filed next door');
  });
});

test('NEW-3 · a scoped table with no blockers still refuses to read clean', async () => {
  await withHome(async ({ home }) => {
    writeWorkspace(home, 'envs', ENVS_WS);
    const { resolveExportScope } = await import('../server/lib/export-scope.js');
    const gen = await import('../server/lib/xlsx-gen.js');
    const ex = resolveExportScope('envs', { serviceId: 'svc_edge' });
    const m = await gen.executiveSummaryModel('envs', ex);
    if (m.computedRisks.outsideBlockerCount) {
      assert.match(m.stopperHeadline, /NOT A CLEAN PLAN/);
    }
  });
});

// ============================================================ NEW-5 ========

test('NEW-5 · the Workbench sheet does not print Pass for a caveated number', async () => {
  await withHome(async ({ store, home }) => {
    fs.mkdirSync(path.join(home, 'workspaces'), { recursive: true });
    store.seedExample();
    const slug = 'example-acme';
    // Inside target on the day, on a run that was NOT clean: `met` by the pure
    // numeric contract, and not a present-tense capability.
    const today = new Date().toISOString().slice(0, 10);
    store.saveCollection(slug, 'tests', [{
      id: 'tst_messy', name: 'Full-estate game day', date: today, status: 'passed', type: 'game-day',
      results: { rtaMinutes: 40, rpaMinutes: 10, cleanRun: false },
    }]);
    const gen = await import('../server/lib/xlsx-gen.js');
    const m = await gen.executiveSummaryModel(slug);
    assert.equal(m.numbers.caveated, true, 'the fixture must actually be caveated');
    assert.equal(m.numbers.meetsRto, true, 'and met on the numbers — that is the trap');

    const wb = await gen.buildWorkbook(slug);
    const ws = wb.worksheets.find((s) => s.name.startsWith('Workbench'));
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (r, rn) => rows.push(rowCells(ws, rn)));
    const rta = rows.find((r) => r.some((c) => /^RTA measured/.test(String(c))));
    assert.ok(rta, 'the RTA row is still there');
    const cells = rta.map(String);
    assert.ok(cells.some((c) => /not proven current/i.test(c)),
      'the row says what the Executive Summary of the same workbook says');
    assert.ok(!cells.includes('Pass'), 'and it is not green');
    assert.ok(cells.includes('Partial'));
  });
});
