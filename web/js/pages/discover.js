import { h, card, badge, table, toast, markdown, field, empty, confirmDialog } from '../ui.js';

const SERVICE_LABELS = {
  eks: 'EKS', ecs: 'ECS', lambda: 'Lambda', 'ec2-asg': 'EC2 ASG', rds: 'RDS/Aurora',
  dynamodb: 'DynamoDB', elasticache: 'ElastiCache', sqs: 'SQS', sns: 'SNS',
  kinesis: 'Kinesis', s3: 'S3', secrets: 'Secrets Mgr', route53: 'Route 53',
  cloudfront: 'CloudFront', elb: 'ELB', apigateway: 'API Gateway', ecr: 'ECR',
  transfer: 'Transfer', msk: 'MSK', efs: 'EFS',
};

const STYLE = `
  .svc-chips { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 12px; }
  .svc-chip { padding:4px 11px; border-radius:999px; border:1px solid var(--border); background:var(--panel2);
    color:var(--muted); font:600 12px var(--sans); cursor:pointer; user-select:none; }
  .svc-chip.on { background:var(--accent-soft); color:#9cc0fa; border-color:rgba(79,143,247,.4); }
  .disc-log pre { max-height:260px; overflow:auto; margin-top:8px; }
  .disc-log summary { cursor:pointer; color:var(--muted); font-weight:600; font-size:12.5px; }
  .prompt-chip { padding:4px 11px; border-radius:999px; border:1px solid var(--border); background:var(--panel2);
    color:var(--text); font:600 12px var(--sans); cursor:pointer; }
  .prompt-chip:hover { border-color:var(--accent); color:#9cc0fa; }
  .facts-cell { color:var(--muted); font-size:12.5px; max-width:420px; }
  .drop-zone { border:2px dashed var(--border); border-radius:10px; padding:26px 16px; text-align:center;
    color:var(--muted); cursor:pointer; font-weight:600; font-size:13px; }
  .drop-zone.over { border-color:var(--accent); background:var(--accent-soft); color:#9cc0fa; }
  .muted-card { opacity:.78; }
  .snap-meta { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; font-size:13px; margin:8px 0 10px; }
  .snap-meta .k { color:var(--muted); font-weight:600; }
  .enrich-comps { display:flex; flex-direction:column; gap:6px; max-height:240px; overflow-y:auto;
    border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:2px 0 12px; background:var(--bg2); }

  /* proposal tree (Arpio-style review) */
  .pt-caret { background:none; border:1px solid var(--border); border-radius:6px; color:var(--muted);
    cursor:pointer; font:700 10px var(--mono); padding:1px 6px; margin-right:8px; vertical-align:1px; }
  .pt-caret:hover { color:var(--text); border-color:#3a4557; }
  .pt-dep-line { font-size:11.5px; color:var(--muted); margin-top:3px; }
  .pt-needed { margin-left:8px; }
  .pt-assoc-tr td { border-bottom:0; padding:2px 10px; background:rgba(18,22,29,.5); }
  .pt-assoc-tr:last-of-type td, .pt-assoc-last td { border-bottom:1px solid rgba(42,50,66,.55); padding-bottom:7px; }
  .pt-assoc { display:flex; gap:8px; align-items:center; flex-wrap:wrap; color:var(--muted);
    font-size:12px; padding-left:16px; }
  .pt-glyph { flex:none; min-width:32px; text-align:center; font:700 9.5px var(--mono); color:var(--muted);
    border:1px solid var(--border); border-radius:5px; padding:2px 4px; background:var(--panel); }
  .pt-assoc-name { color:var(--text); opacity:.85; overflow-wrap:anywhere; }
  .pt-assoc-rel { font-style:italic; font-size:11.5px; }
  .pt-assoc-rid { font-family:var(--mono); font-size:10.5px; opacity:.75; overflow-wrap:anywhere; }
  .pt-tag-chip { background:var(--bg2); border:1px solid var(--border); border-radius:999px;
    padding:0 7px; font-size:10.5px; color:var(--muted); max-width:220px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }

  /* deep enrichment */
  .arpio-preset { border:1px solid rgba(157,123,245,.35); background:rgba(157,123,245,.08);
    border-radius:10px; padding:12px 14px; margin:0 0 14px; }
  .arpio-preset h3 { color:var(--purple); margin-bottom:4px; }

  /* multi-tag filter editor */
  .tagf-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .tagf-row .tagf-key { flex:1; min-width:120px; }
  .tagf-row .tagf-vals { flex:2; min-width:180px; }
  .tagf-x { background:none; border:1px solid var(--border); border-radius:7px; color:var(--muted);
    cursor:pointer; font-size:12px; line-height:1; padding:6px 9px; flex:none; }
  .tagf-x:hover { color:var(--err); border-color:rgba(226,86,79,.4); }
  .tagf-x[disabled] { opacity:.35; cursor:default; }
`;

// localStorage conveniences — storage can be blocked; never let that break the page.
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch { /* best effort */ } }

// A 501/404 from a backend that isn't mounted yet should read as "coming soon",
// not as a broken tab. api.js throws `${status} ${statusText}` for such responses.
function isUnavailable(e) {
  return /\b(404|501)\b|not implemented|not found|no such endpoint|feature unavailable|cannot (get|post|delete|find module)/i
    .test(e?.message || '');
}
function unavailableCard(title) {
  return card(
    h('h2', null, title),
    h('p', { class: 'hint' },
      'This backend is not available yet — the server may be mid-update. Restart DR Compass or reload this page once it is; nothing here is lost.'),
  );
}

function keyFacts(p) {
  const bits = [];
  if (p.description) bits.push(p.description);
  if (p.replication?.mechanism && !['unknown', ''].includes(p.replication.mechanism)) bits.push(`replication: ${p.replication.mechanism}`);
  if (p.replication?.notes) bits.push(p.replication.notes);
  const s = bits.join(' · ');
  return s.length > 220 ? s.slice(0, 217) + '…' : s;
}

// ------------------------------------------------ shared: JSON drop-zone
// One FileReader/drag-drop pattern shared by the k8s and AWS script paths.
// onJson(parsed, setText) — setText(null) restores the idle label.
function jsonDropZone(idleLabel, scriptNoun, onJson) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  const zone = h('div', {
    class: 'drop-zone',
    onClick: () => fileInput.click(),
    onDragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    onDragleave: () => zone.classList.remove('over'),
    onDrop: (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    },
  }, idleLabel);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });
  const setText = (t) => { zone.textContent = t ?? idleLabel; };
  function handleFile(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file', 'err');
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(reader.result); }
      catch {
        toast(`“${file.name}” is not valid JSON — upload the unmodified file the ${scriptNoun} script produced.`, 'err');
        return;
      }
      onJson(parsed, setText);
    };
    reader.readAsText(file);
  }
  return { zone, fileInput, setText };
}

// ------------------------------------------------ shared: proposal tree

const ASSOC_GLYPHS = {
  'security-group': 'SG', subnet: 'SNET', vpc: 'VPC', 'iam-role': 'IAM', 'iam-policy': 'POL',
  'kms-key': 'KMS', 'target-group': 'TG', listener: 'LSNR', certificate: 'CERT',
  'availability-zone': 'AZ', tag: 'TAG', 'sns-topic': 'SNS', 'sqs-queue': 'SQS',
  'subnet-group': 'SNG', 'parameter-group': 'PG', 'oidc-provider': 'OIDC', nodegroup: 'NG',
};
function assocGlyph(type) {
  if (!type) return '·';
  if (ASSOC_GLYPHS[type]) return ASSOC_GLYPHS[type];
  const parts = String(type).split(/[-_/\s]+/).filter(Boolean);
  const g = parts.length > 1 ? parts.map((w) => w[0]).join('') : String(type).slice(0, 4);
  return g.toUpperCase().slice(0, 4);
}

// Tags arrive in whatever shape the collector produced: {k:v}, [{key,value}],
// [{Key,Value}], or plain strings. Normalize to "k=v" chips, capped.
function assocTagChips(tags) {
  let pairs = [];
  if (Array.isArray(tags)) {
    pairs = tags.map((t) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object') {
        const k = t.key ?? t.Key, v = t.value ?? t.Value;
        return k !== undefined ? `${k}=${v ?? ''}` : null;
      }
      return null;
    }).filter(Boolean);
  } else if (tags && typeof tags === 'object') {
    pairs = Object.entries(tags).map(([k, v]) => `${k}=${v ?? ''}`);
  }
  const shown = pairs.slice(0, 4);
  const extra = pairs.length - shown.length;
  return [
    ...shown.map((s) => h('span', { class: 'pt-tag-chip' }, s)),
    extra > 0 ? h('span', { class: 'pt-tag-chip' }, `+${extra} tags`) : null,
  ];
}

function assocRows(p) {
  const assocs = p.associations || [];
  return assocs.map((a, i) => h('tr', { class: `pt-assoc-tr ${i === assocs.length - 1 ? 'pt-assoc-last' : ''}`, hidden: true },
    h('td', null),
    h('td', { colspan: 4 },
      h('div', { class: 'pt-assoc' },
        h('span', { class: 'pt-glyph', title: a?.type || '' }, assocGlyph(a?.type)),
        h('span', { class: 'pt-assoc-name' }, a?.name || a?.rid || '(unnamed)'),
        a?.relation ? h('span', { class: 'pt-assoc-rel' }, a.relation) : null,
        a?.rid ? h('span', { class: 'pt-assoc-rid' }, a.rid) : null,
        a?.region ? h('span', { class: 'pt-tag-chip' }, a.region) : null,
        assocTagChips(a?.tags))),
  ));
}

// Shared proposals review panel — Arpio-style tree when scan-map data is present,
// plain flat rows for old/flat proposals (Arpio, AI, tag proposals). Checking a
// proposal auto-selects its dependsOnProposals closure; associations always come
// along with their parent, so they render as info rows, not checkboxes.
function proposalsPanel(proposals, { ws, api }) {
  proposals = (proposals || []).filter(Boolean);
  if (!proposals.length) return card(empty('No proposals found.'));

  const byKey = new Map(proposals.filter((p) => p.key).map((p) => [p.key, p]));
  const indexOfProposal = new Map(proposals.map((p, i) => [p, i]));
  // Cycle-safe dependency closure of each proposal (Set of proposal objects, self excluded).
  const closures = proposals.map((p) => {
    const out = new Set(), seen = new Set([p]), stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      for (const k of cur.dependsOnProposals || []) {
        const dep = byKey.get(k);
        if (dep && !seen.has(dep)) { seen.add(dep); out.add(dep); stack.push(dep); }
      }
    }
    return out;
  });
  const hasDeps = closures.some((s) => s.size);

  const checks = [];
  const warnSlots = [];
  const headRow = h('div', { class: 'row', style: 'margin-bottom:10px' });
  const importBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Import 0 selected');

  const refreshWarnings = () => {
    if (!hasDeps) return;
    warnSlots.forEach((slot, i) => {
      slot.innerHTML = '';
      if (checks[i].checked) return;
      const p = proposals[i];
      const dependents = proposals.filter((q, j) => j !== i && checks[j].checked && closures[j].has(p));
      if (dependents.length) {
        slot.append(badge(
          `needed by ${dependents[0].name || dependents[0].key || 'another selection'}${dependents.length > 1 ? ` +${dependents.length - 1}` : ''}`,
          'warn'));
      }
    });
  };
  const refresh = () => {
    const sel = proposals.filter((_, i) => checks[i].checked);
    const m = sel.reduce((acc, p) => acc + (p.associations?.length || 0), 0);
    importBtn.textContent = m > 0
      ? `Import ${sel.length} component${sel.length === 1 ? '' : 's'} + ${m} mapped resource${m === 1 ? '' : 's'}`
      : `Import ${sel.length} selected`;
    importBtn.disabled = sel.length === 0;
    refreshWarnings();
  };

  const rows = proposals.map((p, i) => {
    const cb = h('input', {
      type: 'checkbox', checked: !p.existing, style: 'width:auto',
      onChange: () => {
        if (cb.checked && hasDeps) {
          // Auto-select the whole dependency closure (recursive, cycle-safe).
          let auto = 0;
          closures[i].forEach((dep) => {
            const j = indexOfProposal.get(dep);
            if (j !== undefined && !checks[j].checked) { checks[j].checked = true; auto++; }
          });
          if (auto) toast(`Auto-selected ${auto} ${auto === 1 ? 'dependency' : 'dependencies'}`);
        }
        refresh();
      },
    });
    checks.push(cb);
    const warnSlot = h('span', { class: 'pt-needed' });
    warnSlots.push(warnSlot);

    const children = assocRows(p);
    let caret = null;
    if (children.length) {
      let open = false;
      caret = h('button', { class: 'pt-caret', title: 'Show mapped resources', onClick: () => {
        open = !open;
        caret.textContent = `${open ? '▾' : '▸'} ${children.length}`;
        children.forEach((tr) => { tr.hidden = !open; });
      } }, `▸ ${children.length}`);
    }

    const depNames = (p.dependsOnProposals || [])
      .map((k) => byKey.get(k)).filter((d) => d && d !== p)
      .map((d) => d.name || d.key);

    const mainRow = h('tr', null,
      h('td', null, cb),
      h('td', null,
        caret,
        h('strong', null, p.name),
        p.existing ? h('span', { style: 'margin-left:8px' }, badge('already in inventory', 'warn')) : null,
        warnSlot,
        depNames.length ? h('div', { class: 'pt-dep-line' }, `→ depends on: ${depNames.join(', ')}`) : null),
      h('td', null, badge(p.category)),
      h('td', { class: 'mono', style: 'font-size:12px' }, p.kind),
      h('td', { class: 'facts-cell' }, keyFacts(p)),
    );
    return [mainRow, ...children];
  });
  refresh();

  const allBox = h('input', {
    type: 'checkbox', style: 'width:auto',
    onChange: (e) => { checks.forEach((c) => { c.checked = e.target.checked; }); refresh(); },
  });
  importBtn.addEventListener('click', async () => {
    const selected = proposals.filter((_, i) => checks[i].checked);
    importBtn.disabled = true;
    importBtn.textContent = 'Importing…';
    try {
      // Full extended proposal objects go up — the import route stores
      // associations/edges into the resource graph and links them.
      const res = await api.post(`/w/${ws}/discover/aws/import`, { proposals: selected });
      const imported = res?.imported ?? selected.length;
      const nodes = res?.graphNodesAdded ?? 0;
      const edges = res?.graphEdgesAdded ?? 0;
      const linked = res?.linked ?? 0;
      const bits = [`Imported ${imported} component(s)`];
      if (nodes || edges) bits.push(`${nodes} graph node(s), ${edges} edge(s)`);
      if (linked) bits.push(`${linked} linked`);
      toast(h('span', null, bits.join(' · '), ' — ',
        h('a', { href: `#/${ws}/diagrams` }, 'Explore on the Diagrams page →')), 'ok');
      importBtn.textContent = `Imported ${imported} ✓`;
      headRow.append(h('a', { class: 'btn btn-ghost btn-sm', href: `#/${ws}/diagrams` }, 'Explore on the Diagrams page →'));
    } catch (e) {
      toast(e.message, 'err');
      importBtn.disabled = false;
      refresh();
    }
  });
  headRow.append(
    h('h2', { style: 'margin:0' }, `Proposed components (${proposals.length})`),
    h('span', { class: 'spacer' }),
    importBtn,
    h('a', { class: 'btn btn-ghost btn-sm', href: `#/${ws}/inventory` }, 'Open Inventory →'));
  return card(
    headRow,
    h('div', { style: 'overflow-x:auto' },
      table([allBox, 'Name', 'Category', 'Kind', 'Key facts'], rows)),
    h('p', { class: 'hint', style: 'margin-top:8px' },
      'Rows already matching an inventory component (by name) start unchecked. ',
      hasDeps ? 'Checking a row also selects everything it depends on; mapped resources under a row always come along with it. ' : '',
      'Everything can be edited after import.'),
  );
}

function errorBadges(errors) {
  if (!errors?.length) return null;
  return h('div', { class: 'row', style: 'margin:10px 0' },
    errors.map((e) => badge(e, 'warn')));
}

function logPanel(log, label = 'aws calls') {
  if (!log?.length) return null;
  return h('details', { class: 'disc-log', style: 'margin:10px 0' },
    h('summary', null, `Command log (${log.length} ${label})`),
    h('pre', { class: 'mono' }, log.join('\n')));
}

// ---------------------------------------------------------------- Tab 1: AWS

async function renderAws(el, ctx) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('div', { class: 'loading' }, 'Checking for the AWS CLI…'));
  let info;
  try { info = await api.get('/discover/aws/profiles'); }
  catch (e) { el.innerHTML = ''; el.append(card(badge(e.message, 'err'))); return; }
  let meta = {};
  try { meta = await api.get(`/w/${ws}/workspace`); } catch { /* region default only */ }
  el.innerHTML = '';

  const results = h('div');
  const renderScanResults = (res, { fellBack = false } = {}) => {
    results.innerHTML = '';
    const proposals = res.proposals || [];
    const errs = res.errors || [];
    results.append(...[
      fellBack ? h('div', { class: 'row', style: 'margin:0 0 10px' },
        badge('Dependency mapping is not available on this server yet — showing a plain scan instead.', 'warn')) : null,
      errorBadges(errs),
      logPanel(res.log),
      proposals.length ? proposalsPanel(proposals, ctx)
        : (errs.length ? empty('Nothing discovered — see warnings above.') : empty('Nothing discovered in this region for the selected services.')),
    ].filter(Boolean));
  };

  if (!info.awsCliFound) {
    el.append(card(
      h('h2', null, 'AWS CLI not found'),
      h('p', null, 'AWS discovery shells out to your local AWS CLI v2 with your own profiles — DR Compass never sees or stores credentials.'),
      h('p', { class: 'hint' }, 'Install it, configure a profile, then reload this page — or use the script path:'),
      h('pre', { class: 'mono' }, 'brew install awscli\naws configure --profile my-profile'),
    ));
    // Fall through: the script download + upload path below works without a local CLI.
  }

  const serviceIds = info.services || Object.keys(SERVICE_LABELS);
  const selected = new Set(serviceIds); // all on by default
  const chips = serviceIds.map((id) => {
    const chip = h('span', { class: 'svc-chip on', onClick: () => {
      if (selected.has(id)) { selected.delete(id); chip.classList.remove('on'); }
      else { selected.add(id); chip.classList.add('on'); }
    } }, SERVICE_LABELS[id] || id);
    return chip;
  });

  const profileSel = h('select', null,
    (info.profiles || []).length
      ? info.profiles.map((p) => h('option', { value: p }, p))
      : [h('option', { value: '' }, '(no profiles found — env credentials)')]);
  const regionInp = h('input', { value: meta.regions?.primary || 'us-east-1', placeholder: 'e.g. us-east-1' });
  const mapCb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const scanBtn = h('button', { class: 'btn btn-primary', disabled: !info.awsCliFound }, 'Scan & map account');

  scanBtn.addEventListener('click', async () => {
    if (!selected.size) { toast('Pick at least one service to scan', 'err'); return; }
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning… (read-only list/describe calls)';
    results.innerHTML = '';
    const base = { profile: profileSel.value, region: regionInp.value.trim(), services: [...selected] };
    try {
      let res = null, fellBack = false;
      if (mapCb.checked) {
        try {
          res = await api.post(`/w/${ws}/discover/aws/scan-map`, { ...base, mapDependencies: true });
        } catch (e) {
          if (!isUnavailable(e)) throw e;
          fellBack = true; // scan-map backend not mounted yet — plain scan still works
        }
      }
      if (!res) res = await api.post(`/w/${ws}/discover/aws`, base);
      renderScanResults(res, { fellBack });
    } catch (e) {
      results.append(isUnavailable(e) ? unavailableCard('AWS scan') : card(badge(e.message, 'err')));
    } finally {
      scanBtn.disabled = !info.awsCliFound;
      scanBtn.textContent = 'Scan & map account';
    }
  });

  // Script path: for machines without credentials — download a read-only bash
  // script scoped to the selected services, run it where credentials live,
  // upload the JSON artifact into the SAME review tree.
  const scriptLink = h('a', {
    class: '', href: '/api/discover/aws/script', download: 'drcompass-aws-discovery.sh',
    onClick: (e) => {
      e.currentTarget.href = `/api/discover/aws/script?services=${encodeURIComponent([...selected].join(','))}`;
    },
  }, 'Download the read-only discovery script');
  const upload = jsonDropZone('Drop the discovery JSON here, or click to choose the file', 'discovery', async (parsed, setText) => {
    setText('Uploading…');
    results.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/discover/aws/upload`, parsed);
      renderScanResults(res);
      toast('Discovery artifact uploaded — review the proposals below', 'ok');
    } catch (e) {
      results.append(isUnavailable(e) ? unavailableCard('Discovery upload') : card(badge(e.message, 'err')));
    } finally {
      setText(null);
    }
  });

  let comps = [];
  try { comps = (await api.get(`/w/${ws}/c/components`)).items || []; } catch { /* enrichment list degrades to empty */ }

  el.append(
    card(
      h('h2', null, 'Scan & map an AWS account'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Runs read-only list/describe calls through your local AWS CLI with your own credentials. No credentials are read, sent, or stored by DR Compass; the exact commands run are shown in the log. Secret values are never read — names and ARNs only.'),
      h('div', { class: 'grid cols-2' },
        field('AWS profile', profileSel),
        field('Region (primary)', regionInp)),
      h('div', null,
        h('span', { class: 'hint', style: 'font-weight:600' }, 'Services to scan'),
        h('div', { class: 'svc-chips' }, chips)),
      h('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:4px' },
        mapCb, h('strong', { style: 'font-size:13px' }, 'Map dependencies')),
      h('p', { class: 'hint', style: 'margin:0 0 12px 26px' },
        'Also pulls each resource’s associations — security groups, subnets, IAM, target groups, KMS, tags — like a recovery tool’s resource graph'),
      h('div', { class: 'row' }, scanBtn),
      h('div', { class: 'divider' }),
      h('p', { class: 'hint', style: 'margin-bottom:10px' },
        h('strong', null, 'No credentials on this machine? '),
        scriptLink,
        ' (scoped to the selected services), run it where you do have credentials — it only reads — then upload the JSON it produces:'),
      upload.zone, upload.fileInput,
    ),
    results,
    ...enrichmentSection(ctx, info, meta, comps),
  );
}

// ------------------------------------------------- AWS tab: deep enrichment

function enrichTotalsChips(res) {
  return h('div', { class: 'row', style: 'margin:4px 0 10px' },
    badge(`${res.addedNodes ?? 0} nodes added`, 'ok'),
    badge(`${res.updatedNodes ?? 0} nodes updated`, 'accent'),
    badge(`${res.addedEdges ?? 0} edges added`, 'accent'),
    typeof res.matched === 'number' ? badge(`${res.matched} tag-matched`, res.matched ? 'accent' : 'warn') : null,
    typeof res.targeted === 'number' ? badge(`${res.targeted} Arpio-imported component(s) targeted`, res.targeted ? 'purple' : 'warn') : null);
}

function matchedByCell(mb) {
  if (mb === 'arn') return badge('exact', 'ok');
  if (mb === 'name') return badge('name');
  return h('span', { class: 'hint' }, '—');
}

function enrichResultPanel(res, compsById) {
  const per = res.perComponent || [];
  const rows = per.map((p) => h('tr', null,
    h('td', null, h('strong', null, compsById[p.componentId]?.name || p.componentId || '(unlinked — review in graph)')),
    h('td', null, p.found ? badge('✓ found', 'ok') : badge('—')),
    h('td', null, matchedByCell(p.matchedBy)),
    h('td', null, String(p.nodes ?? 0)),
  ));
  return card(
    h('h3', { style: 'margin-bottom:8px' }, 'Enrichment results'),
    enrichTotalsChips(res),
    res.targeted === 0
      ? h('p', { class: 'hint', style: 'margin:0 0 10px' },
          'No Arpio-imported components found — import on the Arpio tab first.')
      : null,
    ...[errorBadges(res.errors), logPanel(res.log)].filter(Boolean),
    per.length
      ? h('div', { style: 'overflow-x:auto' }, table(['Component', 'Associations', 'Matched by', 'Nodes added'], rows))
      : empty('No per-component detail returned.'),
    h('p', { class: 'hint', style: 'margin-top:8px' },
      '“exact” = matched by ARN; “name” = matched heuristically by name. Click nodes on the Diagrams page to explore what got associated.'),
  );
}

function enrichmentSection(ctx, info, meta, comps) {
  const { ws, api } = ctx;
  const compsById = Object.fromEntries(comps.map((c) => [c.id, c]));
  const awsComps = comps.filter((c) => c.awsServices?.length);

  // Same profiles the scan card uses — no second network call.
  const profiles = info.profiles || [];
  const profileSel = h('select', null,
    profiles.length
      ? profiles.map((p) => h('option', { value: p }, p))
      : [h('option', { value: '' }, '(no profiles found — env credentials)')]);
  const savedProfile = lsGet('drc.enrich.profile');
  if (savedProfile && profiles.includes(savedProfile)) profileSel.value = savedProfile;
  const regionInp = h('input', {
    value: lsGet('drc.enrich.region') || meta.regions?.primary || 'us-east-1',
    placeholder: 'e.g. us-east-1',
  });
  const persist = () => {
    lsSet('drc.enrich.profile', profileSel.value);
    lsSet('drc.enrich.region', regionInp.value.trim());
  };

  const checks = [];
  const allToggle = h('input', {
    type: 'checkbox', checked: true, style: 'width:auto',
    onChange: (e) => checks.forEach((c) => { c.checked = e.target.checked; }),
  });
  const compList = awsComps.length
    ? h('div', { class: 'enrich-comps' },
        h('label', { class: 'row', style: 'gap:8px;cursor:pointer;padding-bottom:4px;border-bottom:1px solid var(--border)' },
          allToggle, h('strong', null, 'Select all')),
        awsComps.map((c) => {
          const cb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
          checks.push(cb);
          return h('label', { class: 'row', style: 'gap:8px;cursor:pointer' },
            cb, c.name, badge((c.awsServices || []).slice(0, 4).join(', ')));
        }))
    : h('p', { class: 'hint', style: 'margin:2px 0 12px' },
        'No inventory components list AWS services yet — scan or import above first, or use “Correlate by tag” below.');

  const results = h('div');
  const runEnrich = async (btn, runningLabel, idleLabel, path, body, cardTitle = 'Deep enrichment', { expectTargeted = false } = {}) => {
    btn.disabled = true;
    btn.textContent = runningLabel;
    persist();
    try {
      const res = await api.post(path, body);
      results.innerHTML = '';
      if (expectTargeted && typeof res.targeted !== 'number') {
        // Older backend that ignores target:'arpio' — it enriched every AWS
        // component instead of just the Arpio-imported ones. Say so.
        results.append(h('div', { class: 'row', style: 'margin:0 0 10px' },
          badge('Targeted Arpio overlay is not available on this server yet — ran a normal enrichment across AWS components.', 'warn')));
      }
      results.append(enrichResultPanel(res, compsById));
      if (typeof res.targeted === 'number' && res.targeted === 0) {
        toast('No Arpio-imported components found — import on the Arpio tab first.', 'err');
      } else {
        toast(`Enrichment added ${res.addedNodes ?? 0} node(s) — click nodes on the Diagrams page to explore associations.`, 'ok');
      }
    } catch (e) {
      results.innerHTML = '';
      results.append(isUnavailable(e) ? unavailableCard(cardTitle) : card(badge(e.message, 'err')));
    } finally {
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  };

  // --- Arpio overlay preset: enrich ONLY components imported from Arpio,
  // matching by their exact ARNs — no account-wide scan.
  const arpioBtn = h('button', { class: 'btn btn-primary' }, 'Map dependencies for Arpio-imported components');
  arpioBtn.addEventListener('click', () => {
    runEnrich(arpioBtn, 'Mapping Arpio dependencies… (read-only)', 'Map dependencies for Arpio-imported components',
      `/w/${ws}/resources/enrich`,
      { target: 'arpio', profile: profileSel.value, region: regionInp.value.trim() },
      'Arpio overlay', { expectTargeted: true });
  });
  const arpioPreset = h('div', { class: 'arpio-preset' },
    h('h3', null, 'Arpio overlay'),
    h('p', { class: 'hint', style: 'margin-bottom:10px' },
      'Import from the Arpio tab first — then this maps exact dependencies for only those resources. No account-wide scan. Matches by ARN, so results show as “exact”.'),
    h('div', { class: 'row' }, arpioBtn));

  const enrichBtn = h('button', { class: 'btn btn-primary', disabled: !awsComps.length }, 'Enrich selected');
  enrichBtn.addEventListener('click', () => {
    const ids = awsComps.filter((_, i) => checks[i].checked).map((c) => c.id);
    if (!ids.length) { toast('Select at least one component to enrich', 'err'); return; }
    runEnrich(enrichBtn, 'Enriching… (read-only describe calls)', 'Enrich selected',
      `/w/${ws}/resources/enrich`,
      { componentIds: ids, profile: profileSel.value, region: regionInp.value.trim() });
  });

  // --- Correlate by tag: multi-tag filter editor ---------------------------
  // Persisted as JSON [{key, values:[...]}]; migrates the old single key/value.
  const TAGF_LS = 'drc.enrich.tagFilters';
  const loadTagFilters = () => {
    try {
      const raw = lsGet(TAGF_LS);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          return arr.slice(0, 10).map((t) => ({
            key: String(t?.key ?? ''),
            values: Array.isArray(t?.values) ? t.values.map(String) : [],
          }));
        }
      }
    } catch { /* fall through to legacy/blank */ }
    const legacyKey = lsGet('drc.enrich.tagKey'), legacyVal = lsGet('drc.enrich.tagValue');
    if (legacyKey || legacyVal) return [{ key: legacyKey || '', values: legacyVal ? [legacyVal] : [] }];
    return [{ key: '', values: [] }];
  };

  const tagRows = []; // {el, keyInp, valInp}
  const tagRowsBox = h('div');
  const addRowBtn = h('button', { class: 'btn btn-sm' }, '＋ Add tag filter');
  const refreshTagRowButtons = () => {
    tagRows.forEach((r) => { r.removeBtn.disabled = tagRows.length <= 1; });
    addRowBtn.disabled = tagRows.length >= 10;
  };
  const addTagRow = (key = '', values = []) => {
    if (tagRows.length >= 10) return;
    const keyInp = h('input', { class: 'tagf-key', value: key, placeholder: 'tag key — e.g. app' });
    const valInp = h('input', { class: 'tagf-vals', value: values.join(', '), placeholder: 'values, comma-separated — e.g. claims-platform, pricing' });
    const removeBtn = h('button', { class: 'tagf-x', title: 'Remove this filter', onClick: () => {
      const i = tagRows.findIndex((r) => r.removeBtn === removeBtn);
      if (i >= 0 && tagRows.length > 1) { tagRows[i].el.remove(); tagRows.splice(i, 1); refreshTagRowButtons(); }
    } }, '✕');
    const el = h('div', { class: 'tagf-row' }, keyInp, valInp, removeBtn);
    tagRows.push({ el, keyInp, valInp, removeBtn });
    tagRowsBox.append(el);
    refreshTagRowButtons();
  };
  loadTagFilters().forEach((t) => addTagRow(t.key, t.values));
  addRowBtn.addEventListener('click', () => addTagRow());

  const proposeCb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const tagBtn = h('button', { class: 'btn btn-primary' }, 'Pull by tags');
  tagBtn.addEventListener('click', async () => {
    const tags = tagRows
      .map((r) => ({
        key: r.keyInp.value.trim(),
        values: r.valInp.value.split(',').map((s) => s.trim()).filter(Boolean),
      }))
      .filter((t) => t.key && t.values.length);
    if (!tags.length) { toast('Enter at least one tag key with at least one value', 'err'); return; }
    lsSet(TAGF_LS, JSON.stringify(tags));
    persist();
    tagBtn.disabled = true;
    tagBtn.textContent = 'Pulling by tags… (read-only)';
    try {
      const common = { profile: profileSel.value, region: regionInp.value.trim() };
      let res = null, fellBack = false;
      try {
        res = await api.post(`/w/${ws}/resources/enrich-by-tag`,
          { ...common, tags, proposeComponents: proposeCb.checked });
        // An older backend answers the new body with 200 + an errors[] complaint
        // rather than a 4xx — treat that as "multi-tag unsupported" too.
        if (res && typeof res.matched !== 'number'
            && (res.errors || []).some((m) => /tagKey and tagValue/i.test(String(m)))) {
          fellBack = true;
          res = null;
        }
      } catch (e) {
        if (!isUnavailable(e)) throw e;
        fellBack = true;
      }
      if (!res) {
        // Old backend: single key/value only — degrade to the first filter's first value.
        res = await api.post(`/w/${ws}/resources/enrich-by-tag`,
          { ...common, tagKey: tags[0].key, tagValue: tags[0].values[0] });
      }
      results.innerHTML = '';
      if (fellBack) {
        results.append(h('div', { class: 'row', style: 'margin:0 0 10px' },
          badge(`Multi-tag filters not available on this server yet — used only ${tags[0].key}=${tags[0].values[0]}.`, 'warn')));
      }
      results.append(enrichResultPanel(res, compsById));
      if (res.proposals?.length) results.append(proposalsPanel(res.proposals, ctx));
      toast(`Tag pull matched ${res.matched ?? 0} resource(s)${res.proposals?.length ? ` — ${res.proposals.length} component proposal(s) below` : ''}.`,
        (res.matched ?? 0) ? 'ok' : '');
    } catch (e) {
      results.innerHTML = '';
      results.append(isUnavailable(e) ? unavailableCard('Correlate by tag') : card(badge(e.message, 'err')));
    } finally {
      tagBtn.disabled = false;
      tagBtn.textContent = 'Pull by tags';
    }
  });

  return [
    card(
      h('h2', null, 'Deep enrichment — associate everything (Arpio-style depth)'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Pulls each component’s real associations: security groups, subnets & AZs, IAM roles/policies, target groups & listeners, KMS, certificates, tags — into the resource graph shown when you click a diagram node. Read-only, through the same local AWS CLI.'),
      h('div', { class: 'grid cols-2' },
        field('AWS profile', profileSel),
        field('Region', regionInp)),
      arpioPreset,
      h('div', null,
        h('span', { class: 'hint', style: 'font-weight:600' }, `Components with AWS services (${awsComps.length})`),
        compList),
      h('div', { class: 'row' }, enrichBtn),
    ),
    card(
      h('h3', { style: 'margin-bottom:6px' }, 'Correlate by tag'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Great for finding resources your inventory missed — unmatched resources land in the graph unlinked so you can review them. A resource must match every filter row (AND across rows); within one row, any of the comma-separated values counts (OR within values).'),
      tagRowsBox,
      h('div', { class: 'row', style: 'margin-bottom:12px' }, addRowBtn),
      h('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:12px' },
        proposeCb, 'Propose components for app-level matches',
        h('span', { class: 'hint' }, '(review + import them below, like a scan)')),
      h('div', { class: 'row' }, tagBtn,
        h('span', { class: 'hint' }, 'Uses the profile and region selected above.')),
    ),
    results,
  ];
}

// ---------------------------------------------------------------- Tab 2: Arpio

function renderArpio(el, ctx) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  // Arpio API keys have two parts (key ID + secret), sent together as
  // "X-Api-Key: <keyId>:<secret>". Pasting the combined "id:secret" into the
  // Key ID field alone also works.
  const keyIdInp = h('input', { placeholder: 'API key ID', autocomplete: 'off' });
  const secretInp = h('input', { type: 'password', placeholder: 'API key secret', autocomplete: 'off' });
  const acctInp = h('input', { placeholder: 'Optional — first randomized string in your Arpio console URL', autocomplete: 'off' });
  const connectBtn = h('button', { class: 'btn btn-primary' }, 'Connect & scan');
  const results = h('div');

  connectBtn.addEventListener('click', async () => {
    const keyId = keyIdInp.value.trim();
    const secret = secretInp.value.trim();
    if (!keyId || (!secret && !keyId.includes(':'))) {
      toast('Enter the Arpio API key ID and secret (or paste the combined id:secret)', 'err');
      return;
    }
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    results.innerHTML = '';
    try {
      const body = keyId.includes(':') && !secret
        ? { apiKey: keyId, accountId: acctInp.value.trim() }
        : { apiKeyId: keyId, apiSecret: secret, accountId: acctInp.value.trim() };
      const res = await api.post(`/w/${ws}/discover/arpio`, body);
      if (res.ok) {
        if (res.message) results.append(errorBadges([res.message]));
        results.append(proposalsPanel(res.proposals || [], ctx));
      } else {
        results.append(card(
          h('h2', null, 'Could not read from Arpio'),
          h('p', { style: 'margin:8px 0' }, badge(res.message || 'Unknown error', 'warn')),
          h('p', { class: 'hint' },
            'Keys are created in the Arpio console under Settings → Account Settings → API Keys, and both parts are needed (sent as "X-Api-Key: <keyId>:<secret>"). If the key cannot list accounts, add your Account ID — the first randomized string in your Arpio console URL.'),
        ));
      }
    } catch (e) {
      results.append(card(badge(e.message, 'err')));
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect & scan';
    }
  });

  el.append(
    card(
      h('h2', null, 'Import protected resources from Arpio'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Reads your Arpio accounts, applications, and protected resources (read-only) and proposes them as inventory components marked in-recovery-scope with mechanism "arpio-snapshot". Create a key in the Arpio console: Settings → Account Settings → API Keys. It has two parts — enter both below. Neither is ever written to disk.'),
      h('div', { class: 'grid cols-2' },
        field('API key ID (never persisted)', keyIdInp),
        field('API key secret (never persisted)', secretInp)),
      field('Arpio account ID', acctInp),
      h('div', { class: 'row' }, connectBtn),
      h('p', { class: 'hint', style: 'margin-top:10px' },
        'After importing, use “Arpio overlay” on the AWS tab to map exact dependencies for just these resources.'),
    ),
    results,
  );
}

// ----------------------------------------------------------- Tab: Kubernetes

function k8sSummaryChips(summary) {
  const s = summary || {};
  return h('div', { class: 'row', style: 'margin:10px 0' },
    badge(`${s.namespaces ?? 0} namespaces`, 'accent'),
    badge(`${s.workloads ?? 0} workloads`, 'accent'),
    badge(`${s.services ?? 0} services`, 'accent'),
    badge(`${s.ingresses ?? 0} ingresses`, 'accent'),
    badge(`${s.linked ?? 0} linked to inventory`, 'ok'));
}

async function renderK8s(el, ctx) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('div', { class: 'loading' }, 'Checking for kubectl…'));
  let info = null, infoErr = null;
  try { info = await api.get('/discover/k8s/contexts'); }
  catch (e) { infoErr = e; }
  el.innerHTML = '';

  const scanResults = h('div');
  const snapshotBox = h('div');
  let triggerScan = null; // set below when kubectl is available

  // ---- Card 3 body: current snapshot (loaded/reloaded independently)
  async function loadSnapshot() {
    snapshotBox.innerHTML = '';
    let snap = null;
    try { snap = await api.get(`/w/${ws}/k8s`); }
    catch (e) {
      snapshotBox.append(isUnavailable(e)
        ? unavailableCard('Current snapshot')
        : card(h('h2', null, 'Current snapshot'), badge(e.message, 'err')));
      return;
    }
    const has = snap && (snap.capturedAt || snap.summary || snap.cluster || snap.source);
    if (!has) {
      snapshotBox.append(card(
        h('h2', null, 'Current snapshot'),
        empty('No Kubernetes snapshot stored yet — scan with kubectl or upload a script artifact above.'),
      ));
      return;
    }
    const rescanBtn = h('button', { class: 'btn' }, 'Re-scan');
    rescanBtn.addEventListener('click', () => {
      if (triggerScan) triggerScan();
      else toast('kubectl was not found — re-run the snapshot script and upload the JSON instead', 'err');
    });
    const deleteBtn = h('button', { class: 'btn btn-danger' }, 'Delete snapshot');
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete the stored Kubernetes snapshot? Inventory components are not touched — only the cluster snapshot and its diagrams.');
      if (!ok) return;
      try {
        await api.del(`/w/${ws}/k8s`);
        toast('Snapshot deleted', 'ok');
        loadSnapshot();
      } catch (e) { toast(e.message, 'err'); }
    });
    snapshotBox.append(card(
      h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('h2', { style: 'margin:0' }, 'Current snapshot'),
        h('span', { class: 'spacer' }),
        rescanBtn, deleteBtn),
      h('div', { class: 'snap-meta' },
        h('span', { class: 'k' }, 'Captured'), h('span', null, snap.capturedAt || '—'),
        h('span', { class: 'k' }, 'Source'), h('span', null, snap.source || '—'),
        h('span', { class: 'k' }, 'Cluster'), h('span', { class: 'mono' }, snap.cluster || '—')),
      k8sSummaryChips(snap.summary || snap.counts),
      h('p', { style: 'margin-top:4px' },
        h('a', { href: `#/${ws}/diagrams/k8s-cluster` }, 'View diagrams →')),
    ));
  }

  // ---- Card 1: scan with kubectl
  let scanCard;
  if (infoErr) {
    scanCard = isUnavailable(infoErr)
      ? unavailableCard('Scan with kubectl (read-only)')
      : card(h('h2', null, 'Scan with kubectl (read-only)'), badge(infoErr.message, 'err'));
  } else if (!info?.kubectlFound) {
    scanCard = card(
      h('div', { class: 'muted-card' },
        h('h2', null, 'kubectl not found'),
        h('p', null, 'The scan path shells out to your local ', h('code', null, 'kubectl'), ' with your own kubeconfig — nothing routed through DR Compass.'),
        h('p', { class: 'hint', style: 'margin:8px 0 6px' }, 'Install it and reload this page, or use the script path below:'),
        h('pre', { class: 'mono' }, 'brew install kubectl   # or: see kubernetes.io/docs/tasks/tools')),
    );
  } else {
    const contexts = info.contexts || [];
    const ctxSel = h('select', null,
      contexts.length
        ? contexts.map((c) => h('option', { value: c.name }, c.current ? `${c.name} (current)` : c.name))
        : [h('option', { value: '' }, '(no contexts found in kubeconfig)')]);
    const current = contexts.find((c) => c.current);
    if (current) ctxSel.value = current.name;
    const nsInp = h('input', { placeholder: 'e.g. claims,pricing — blank = all app namespaces' });
    const scanBtn = h('button', { class: 'btn btn-primary', disabled: !contexts.length }, 'Scan cluster');
    triggerScan = async () => {
      if (scanBtn.disabled) return;
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning… (read-only kubectl get calls)';
      scanResults.innerHTML = '';
      try {
        const namespaces = nsInp.value.split(',').map((s) => s.trim()).filter(Boolean);
        const body = { context: ctxSel.value };
        if (namespaces.length) body.namespaces = namespaces;
        const res = await api.post(`/w/${ws}/k8s/scan`, body);
        scanResults.append(card(
          h('h3', { style: 'margin-bottom:6px' }, 'Scan results'),
          k8sSummaryChips(res.summary),
          ...[errorBadges(res.errors), logPanel(res.log, 'kubectl commands')].filter(Boolean),
          h('p', { style: 'margin-top:4px' },
            h('a', { href: `#/${ws}/diagrams/k8s-cluster` }, 'View diagrams →')),
        ));
        loadSnapshot();
      } catch (e) {
        scanResults.append(isUnavailable(e)
          ? unavailableCard('Kubernetes scan')
          : card(badge(e.message, 'err')));
      } finally {
        scanBtn.disabled = !contexts.length;
        scanBtn.textContent = 'Scan cluster';
      }
    };
    scanBtn.addEventListener('click', triggerScan);
    scanCard = card(
      h('h2', null, 'Scan with kubectl (read-only)'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Runs only read-only ', h('code', null, 'kubectl get -o json'),
        ' commands with your local kubeconfig. Nothing is modified. Secret and ConfigMap names only — never values.'),
      h('div', { class: 'grid cols-2' },
        field('Context', ctxSel),
        field('Namespaces (comma-separated)', nsInp)),
      h('div', { class: 'row' }, scanBtn),
    );
  }

  // ---- Card 2: run a script yourself, then upload the artifact
  const uploadResults = h('div');
  const upload = jsonDropZone('Drop the snapshot JSON here, or click to choose the file', 'snapshot', async (parsed, setText) => {
    setText('Uploading…');
    uploadResults.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/k8s/upload`, parsed);
      uploadResults.append(card(
        h('h3', { style: 'margin-bottom:6px' }, 'Upload results'),
        k8sSummaryChips(res.summary),
        errorBadges(res.warnings),
      ));
      toast('Snapshot uploaded', 'ok');
      loadSnapshot();
    } catch (e) {
      uploadResults.append(isUnavailable(e)
        ? unavailableCard('Snapshot upload')
        : card(badge(e.message, 'err')));
    } finally {
      setText(null);
    }
  });
  const scriptCard = card(
    h('h2', null, 'Run a script yourself'),
    h('p', { class: 'hint', style: 'margin-bottom:12px' },
      'For locked-down environments: download the snapshot script, run it wherever you have cluster access (it only reads), then upload the JSON it produces.'),
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('a', { class: 'btn', href: '/api/discover/k8s/script', download: 'drcompass-k8s-snapshot.sh' },
        'Download snapshot script')),
    upload.zone, upload.fileInput,
  );

  el.append(
    scanCard,
    scanResults,
    scriptCard,
    uploadResults,
    snapshotBox,
    h('p', { class: 'hint', style: 'margin-top:14px' },
      'You can also ask the AI copilot (Cmd/Ctrl+K) to help interpret or link the snapshot.'),
  );
  loadSnapshot();
}

// ---------------------------------------------------------------- Tab 3: Ask AI

const SUGGEST_PROMPT = 'Given this inventory, what dependencies, third-party calls, secrets, or components am I likely missing for a complete DR plan?';
const PROMPT_CHIPS = [
  'Which components look under-specified?',
  'Draft outbound-call entries for adjudication-service',
  'What would break first in a region failover?',
  'Which secrets are most likely to break a recovery test?',
  'Propose a verification command for each database component',
];

async function renderAi(el, ctx) {
  const { ws, api } = ctx;
  el.innerHTML = '';
  el.append(h('div', { class: 'loading' }, 'Checking for the Claude Code CLI…'));
  let status = { claudeCliFound: false };
  try { status = await api.get('/discover/ai/status'); } catch { /* banner below covers it */ }
  el.innerHTML = '';

  if (!status.claudeCliFound) {
    el.append(card(
      h('h2', null, 'Claude Code CLI not found'),
      h('p', null, 'The AI tab shells out to your local ', h('code', null, 'claude'), ' CLI — your account, your machine, nothing routed through DR Compass.'),
      h('p', { class: 'hint', style: 'margin:8px 0 6px' }, 'Install Claude Code and sign in, then reload this page:'),
      h('pre', { class: 'mono' }, 'npm install -g @anthropic-ai/claude-code\nclaude   # sign in once'),
    ));
    // Still render the tools below (disabled) so users can see what they would get.
  }

  const promptTa = h('textarea', { placeholder: 'e.g. Which of these components would block a region failover first, and why?', style: 'min-height:110px' });
  const ctxCheck = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const askBtn = h('button', { class: 'btn btn-primary', disabled: !status.claudeCliFound }, 'Ask');
  const answerBox = h('div');

  askBtn.addEventListener('click', async () => {
    const prompt = promptTa.value.trim();
    if (!prompt) { toast('Type a question first', 'err'); return; }
    askBtn.disabled = true;
    askBtn.textContent = 'Thinking… (local claude CLI, up to 3 min)';
    answerBox.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/ai/ask`, { prompt, includeContext: ctxCheck.checked });
      answerBox.append(res.ok
        ? card(h('h3', { style: 'margin-bottom:8px' }, 'Answer'), markdown(res.answer || '(empty answer)'))
        : card(badge(res.message, 'warn')));
    } catch (e) {
      answerBox.append(card(badge(e.message, 'err')));
    } finally {
      askBtn.disabled = !status.claudeCliFound;
      askBtn.textContent = 'Ask';
    }
  });

  const chipRow = h('div', { class: 'row', style: 'margin:8px 0 12px' },
    PROMPT_CHIPS.map((p) => h('span', { class: 'prompt-chip', onClick: () => { promptTa.value = p; promptTa.focus(); } }, p)));

  const suggestBtn = h('button', { class: 'btn btn-primary', disabled: !status.claudeCliFound }, 'Suggest missing pieces');
  const suggestBox = h('div');
  suggestBtn.addEventListener('click', async () => {
    suggestBtn.disabled = true;
    suggestBtn.textContent = 'Analyzing inventory… (up to 3 min)';
    suggestBox.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/ai/suggest`, { freeText: SUGGEST_PROMPT });
      if (res.ok && res.proposals) suggestBox.append(proposalsPanel(res.proposals, ctx));
      else if (res.ok && res.raw) suggestBox.append(card(
        h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'The AI did not return importable JSON — raw answer below:'),
        markdown(res.raw)));
      else suggestBox.append(card(badge(res.message || 'No suggestions returned', 'warn')));
    } catch (e) {
      suggestBox.append(card(badge(e.message, 'err')));
    } finally {
      suggestBtn.disabled = !status.claudeCliFound;
      suggestBtn.textContent = 'Suggest missing pieces';
    }
  });

  el.append(
    card(
      h('h2', null, 'Ask AI about your DR plan'),
      h('p', { class: 'hint', style: 'margin-bottom:10px' },
        'Runs your question through your local Claude Code CLI. With context on, a compact summary of this workspace (component names, kinds, dependencies, gaps — no secret values) is included in the prompt.'),
      chipRow,
      field('Question', promptTa),
      h('div', { class: 'row' },
        h('label', { class: 'row', style: 'gap:8px;cursor:pointer' }, ctxCheck, 'Include workspace context'),
        h('span', { class: 'spacer' }), askBtn),
    ),
    answerBox,
    card(
      h('h2', null, 'Suggest missing pieces'),
      h('p', { class: 'hint', style: 'margin-bottom:10px' },
        `One click sends the inventory plus: “${SUGGEST_PROMPT}” — and returns importable component proposals.`),
      h('div', { class: 'row' }, suggestBtn),
    ),
    suggestBox,
  );
}

// ---------------------------------------------------------------- page

export default {
  title: 'Discover',
  async render(el, ctx) {
    const tabs = [
      { id: 'aws', label: 'AWS account', render: renderAws },
      { id: 'k8s', label: 'Kubernetes', render: renderK8s },
      { id: 'arpio', label: 'Arpio', render: renderArpio },
      { id: 'ai', label: 'Ask AI', render: renderAi },
    ];
    const body = h('div');
    const activate = async (id) => {
      tabEls.forEach((te) => te.classList.toggle('active', te.dataset.tab === id));
      const t = tabs.find((x) => x.id === id);
      await t.render(body, ctx);
    };
    const tabEls = tabs.map((t) =>
      h('span', { class: 'tab', 'data-tab': t.id, onClick: () => activate(t.id) }, t.label));
    el.append(
      h('style', null, STYLE),
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', null, 'Discover'),
        h('div', { class: 'sub' }, 'Build the inventory from your AWS account, Arpio, or your local AI — read-only, nothing stored'))),
      h('div', { class: 'tabs' }, tabEls),
      body,
    );
    await activate(ctx.params?.[0] && tabs.some((t) => t.id === ctx.params[0]) ? ctx.params[0] : 'aws');
  },
};
