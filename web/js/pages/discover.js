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

  /* AWS auth pre-flight */
  .auth-line { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:-4px 0 12px;
    font-size:12.5px; color:var(--muted); }
  .auth-line .auth-id { overflow-wrap:anywhere; }
  .auth-wait-sec { font-family:var(--mono); }

  /* background jobs */
  .job-head { display:flex; gap:10px; align-items:center; }
  .job-dot { width:10px; height:10px; border-radius:999px; background:var(--accent); flex:none;
    animation: job-pulse 1.3s ease-in-out infinite; }
  @keyframes job-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; box-shadow:0 0 0 5px rgba(79,143,247,.12); } }
  .job-elapsed { font-family:var(--mono); font-size:12.5px; color:var(--muted); }
  .job-log { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:10px 12px;
    margin-top:10px; max-height:190px; overflow-y:auto; font-family:var(--mono); font-size:12px;
    line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); }
  .job-safe { margin-top:8px; font-size:12.5px; color:var(--ok); }
  .tab .badge { margin-left:6px; vertical-align:1px; }
  .lastrun-sum { color:var(--muted); font-size:12.5px; margin-top:6px; overflow-wrap:anywhere; }
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

// ------------------------------------------------------------ background jobs
// Long discovery operations run as server-side jobs (POST /w/:ws/jobs) so a
// page refresh never loses a run: the page polls for progress, shows a live
// activity card, and re-attaches on load. When the jobs backend is not
// mounted (404/501), every action falls back to its original synchronous
// call path unchanged.

const KIND_INFO = {
  'aws-scan':      { tab: 'aws',   label: 'AWS scan',        running: 'Scanning AWS account…',        done: 'AWS scan finished' },
  'aws-scan-map':  { tab: 'aws',   label: 'AWS scan & map',  running: 'Scanning AWS account…',        done: 'AWS scan & map finished' },
  'enrich':        { tab: 'aws',   label: 'Deep enrichment', running: 'Enriching components…',        done: 'Enrichment finished' },
  'enrich-by-tag': { tab: 'aws',   label: 'Tag pull',        running: 'Pulling resources by tag…',    done: 'Tag pull finished' },
  'arpio':         { tab: 'arpio', label: 'Arpio import',    running: 'Scanning Arpio account…',      done: 'Arpio scan finished' },
  'k8s-scan':      { tab: 'k8s',   label: 'Kubernetes scan', running: 'Scanning Kubernetes cluster…', done: 'Kubernetes scan finished' },
};

const runningJobs = new Map();   // jobId -> tab id; drives the "N running" tab badges
let currentTabEls = null;        // this page's tab <span>s, set on each page render
const dismissedJobs = new Set(); // session-only "Last run" card dismissals

function refreshTabBadges() {
  if (!currentTabEls) return;
  for (const te of currentTabEls) {
    const n = [...runningJobs.values()].filter((t) => t === te.dataset.tab).length;
    te.textContent = te.dataset.label || te.textContent;
    if (n) te.append(' ', badge(`${n} running`, 'accent'));
  }
}
function addRunning(jobId, tab) {
  if (!tab || runningJobs.get(jobId) === tab) return;
  runningJobs.set(jobId, tab);
  refreshTabBadges();
}
function removeRunning(jobId) {
  if (runningJobs.delete(jobId)) refreshTabBadges();
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtAgo(ts) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Raw fetch (not api.js) so 409-with-jobId and 404/501-unavailable are
// distinguishable by status instead of by parsing an error message.
async function postJsonRaw(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body (e.g. an HTML 404 page) */ }
  return { status: res.status, data };
}

// Pure-ish, node-testable: start a job, attaching to the already-running one
// on 409. postJson(path, body) -> {status, data} and never throws on HTTP
// error statuses. Throws {unavailable:true} when the jobs backend is absent.
export async function startOrAttachJob(postJson, ws, kind, params) {
  const { status, data } = await postJson(`/api/w/${ws}/jobs`, { kind, params });
  if (status === 201 && data?.jobId) return { jobId: data.jobId, attached: false };
  if (status === 409 && data?.jobId) return { jobId: data.jobId, attached: true };
  if (status === 404 || status === 501) {
    const e = new Error(`${status} — jobs backend unavailable`);
    e.unavailable = true;
    throw e;
  }
  const e = new Error(data?.error || `Could not start the job (HTTP ${status})`);
  e.status = status;
  throw e;
}

// Pure-ish, node-testable: poll one job until it finishes. Polls every
// intervalMs, backing off to slowIntervalMs once slowAfterMs has passed.
// io: { getJob(id), sleep(ms), now?, onTick?(job), shouldStop?() }.
// Resolves the finished job on 'done'; throws (with .job attached) on
// 'error'; resolves null if shouldStop() says the UI abandoned the poll
// (the job itself keeps running server-side).
export async function pollJobUntilDone(jobId, io, { intervalMs = 1500, slowAfterMs = 60000, slowIntervalMs = 3000 } = {}) {
  const now = io.now || Date.now;
  const t0 = now();
  for (;;) {
    const job = await io.getJob(jobId);
    io.onTick?.(job);
    if (job?.status === 'done') return job;
    if (job?.status === 'error') {
      const e = new Error(job.error || 'Job failed');
      e.job = job;
      throw e;
    }
    if (io.shouldStop?.()) return null;
    await io.sleep(now() - t0 > slowAfterMs ? slowIntervalMs : intervalMs);
  }
}

function setButtonsRunning(buttons, running) {
  for (const b of buttons || []) {
    if (!b?.el) continue;
    b.el.disabled = running ? true : !!b.idleDisabled;
    const text = running ? b.runningText : b.idleText;
    if (text) b.el.textContent = text;
  }
}

// The live activity card: pulsing dot + label, client-side elapsed ticker,
// last ~12 progress lines auto-scrolling, full log expandable, and the
// reassurance that a refresh loses nothing.
function activityCard(label) {
  const elapsedEl = h('span', { class: 'job-elapsed' }, '0:00');
  const logEl = h('div', { class: 'job-log', hidden: true });
  const fullSummary = h('summary', null, 'Full log');
  const fullPre = h('pre', { class: 'mono' }, '');
  const fullDetails = h('details', { class: 'disc-log', style: 'margin-top:8px', hidden: true }, fullSummary, fullPre);
  const el = card(
    h('div', { class: 'job-head' },
      h('span', { class: 'job-dot' }),
      h('strong', null, label),
      h('span', { class: 'spacer' }),
      elapsedEl),
    logEl,
    fullDetails,
    h('p', { class: 'job-safe' }, 'Safe to leave or refresh this page — the job keeps running and results are saved.'),
  );
  let base = Date.now();
  const tick = () => { elapsedEl.textContent = fmtElapsed(Date.now() - base); };
  const timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    tick();
  }, 1000);
  return {
    el,
    update(job) {
      if (Number.isFinite(job?.elapsedMs)) base = Date.now() - job.elapsedMs;
      const prog = Array.isArray(job?.progress) ? job.progress : [];
      if (prog.length) {
        logEl.hidden = false;
        logEl.textContent = prog.slice(-12).join('\n');
        logEl.scrollTop = logEl.scrollHeight;
        if (prog.length > 12) {
          fullDetails.hidden = false;
          fullSummary.textContent = `Full log (${prog.length} lines)`;
          fullPre.textContent = prog.join('\n');
        }
      }
      tick();
    },
    stop() { clearInterval(timer); },
  };
}

function jobErrorCard(title, e) {
  const progress = Array.isArray(e?.job?.progress) ? e.job.progress : [];
  return card(
    h('h2', null, `${title} failed`),
    h('p', { style: 'margin:8px 0' }, badge(e?.message || 'Job failed', 'err')),
    progress.length
      ? h('details', { class: 'disc-log', open: true, style: 'margin:10px 0' },
          h('summary', null, `Progress log (${progress.length} lines)`),
          h('pre', { class: 'mono' }, progress.join('\n')))
      : null,
  );
}

// Attach the UI to a job (fresh or resumed): activity card in spec.host,
// poll to completion, then render through the shared renderer. If the card
// leaves the DOM (tab switched / host reused) polling stops quietly — the
// job keeps running server-side and resume-on-load picks it back up.
async function attachToJob(ctx, jobId, spec) {
  const { kind, host, render, buttons = [], doneToast } = spec;
  const info = KIND_INFO[kind] || {};
  const label = spec.label || info.running || 'Working…';
  addRunning(jobId, info.tab);
  setButtonsRunning(buttons, true);
  host.innerHTML = '';
  const act = activityCard(label);
  host.append(act.el);
  let failures = 0;
  const getJob = async () => {
    try {
      const j = await ctx.api.get(`/w/${ctx.ws}/jobs/${jobId}`);
      failures = 0;
      return j;
    } catch (e) {
      if (++failures >= 3) throw e; // three misses in a row — give up for real
      return { status: 'running', transient: true }; // brief blip — keep waiting
    }
  };
  try {
    const job = await pollJobUntilDone(jobId, {
      getJob,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onTick: (j) => { if (!j?.transient) { act.update(j); addRunning(jobId, info.tab); } },
      shouldStop: () => !act.el.isConnected,
    });
    act.stop();
    if (!job) return; // abandoned — resume-on-load re-attaches later
    host.innerHTML = '';
    render(job.result ?? {});
    if (doneToast) doneToast(job.result ?? {});
    else toast(`${info.done || 'Job finished'} in ${fmtElapsed(job.elapsedMs)} — results below`, 'ok');
  } catch (e) {
    act.stop();
    if (act.el.isConnected) {
      host.innerHTML = '';
      host.append(jobErrorCard(info.label || 'Job', e));
      toast(e.message, 'err');
    }
  } finally {
    removeRunning(jobId);
    setButtonsRunning(buttons, false);
  }
}

// Job-first runner for an action button. Returns true when the job path
// handled the run (success or failure rendered); false when the jobs
// backend is unavailable, in which case the caller runs its original
// synchronous path unchanged.
async function runJob(ctx, kind, params, { renderResult, activityHost, label, buttons = [], doneToast } = {}) {
  setButtonsRunning(buttons, true);
  let start;
  try {
    start = await startOrAttachJob(postJsonRaw, ctx.ws, kind, params);
  } catch (e) {
    if (e.unavailable) return false; // sync fallback manages the button from here
    setButtonsRunning(buttons, false);
    activityHost.innerHTML = '';
    activityHost.append(jobErrorCard(KIND_INFO[kind]?.label || 'Job', e));
    toast(e.message, 'err');
    return true;
  }
  if (start.attached) toast('Already running — attached');
  await attachToJob(ctx, start.jobId, { kind, host: activityHost, render: renderResult, label, buttons, doneToast });
  return true;
}

// Resume-on-load: one GET /jobs per tab render. Re-attaches to any running
// job of this tab's kinds; otherwise offers a slim "Last run" card for the
// newest job that finished within 24h. Also refreshes every tab badge from
// the same snapshot. kindMap: kind -> {host, render, label?, buttons?, doneToast?}.
async function resumeJobs(ctx, tabId, kindMap) {
  let jobs;
  try { jobs = (await ctx.api.get(`/w/${ctx.ws}/jobs`))?.jobs || []; }
  catch { return; } // jobs backend not mounted — nothing to resume
  try {
    runningJobs.clear();
    for (const j of jobs) {
      if (j?.status === 'running' && KIND_INFO[j.kind]) runningJobs.set(j.id, KIND_INFO[j.kind].tab);
    }
    refreshTabBadges();
    const mine = jobs.filter((j) => j && kindMap[j.kind]);
    const running = mine.filter((j) => j.status === 'running');
    const usedHosts = new Set();
    for (const j of running) {
      const spec = kindMap[j.kind];
      if (usedHosts.has(spec.host)) continue; // one activity card per results area
      usedHosts.add(spec.host);
      attachToJob(ctx, j.id, { kind: j.kind, ...spec }); // deliberately not awaited
    }
    if (running.length) return;
    const fin = mine.find((j) => j.status === 'done' || j.status === 'error'); // list is newest-first
    if (!fin || dismissedJobs.has(fin.id)) return;
    const endedAt = Date.parse(fin.finishedAt || '');
    if (!Number.isFinite(endedAt) || Date.now() - endedAt > 24 * 3600 * 1000) return;
    kindMap[fin.kind].host.append(lastRunCard(ctx, fin, kindMap[fin.kind]));
  } catch { /* resume is best-effort — never break the tab */ }
}

function lastRunCard(ctx, job, spec) {
  const info = KIND_INFO[job.kind] || {};
  const failed = job.status === 'error';
  const viewLabel = failed ? 'View details' : 'View results';
  const viewBtn = h('button', { class: 'btn btn-sm' }, viewLabel);
  const dismissBtn = h('button', {
    class: 'btn btn-ghost btn-sm',
    onClick: () => { dismissedJobs.add(job.id); wrap.remove(); },
  }, 'Dismiss');
  viewBtn.addEventListener('click', async () => {
    viewBtn.disabled = true;
    viewBtn.textContent = 'Loading…';
    try {
      if (failed) {
        const full = await ctx.api.get(`/w/${ctx.ws}/jobs/${job.id}`);
        const e = new Error(full?.error || 'Job failed');
        e.job = full;
        spec.host.innerHTML = '';
        spec.host.append(jobErrorCard(info.label || 'Job', e));
      } else {
        const res = await ctx.api.get(`/w/${ctx.ws}/jobs/${job.id}/result`);
        spec.render(res ?? {});
      }
    } catch (e) {
      toast(isUnavailable(e) ? 'That result is no longer available on the server.' : e.message, 'err');
      viewBtn.disabled = false;
      viewBtn.textContent = viewLabel;
    }
  });
  const ago = fmtAgo(job.finishedAt);
  const wrap = card(
    h('div', { class: 'row' },
      h('strong', null, `Last run — ${info.label || job.kind}`),
      badge(failed ? 'failed' : 'done', failed ? 'err' : 'ok'),
      ago ? h('span', { class: 'hint' }, `finished ${ago}`) : null,
      h('span', { class: 'spacer' }),
      viewBtn, dismissBtn),
    job.summary ? h('div', { class: 'lastrun-sum' }, job.summary) : null,
  );
  return wrap;
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

// ------------------------------------------------------ AWS auth pre-flight
// Credential/session UX for the AWS tab. The server's auth endpoints run one
// `sts get-caller-identity` as a pre-flight and can launch `aws sso login` /
// `aws-vault exec` — the browser/OS handles the actual sign-in, DR Compass
// never sees or stores credentials. On a server without these endpoints
// (info.profilesDetailed absent) everything degrades: plain profile labels,
// no status line, and every action proceeds exactly as before.

function profileOptionLabel(p) {
  if (p.sso && p.vault) return `${p.name} (SSO · vault)`;
  if (p.sso) return `${p.name} (SSO)`;
  if (p.vault) return `${p.name} (aws-vault)`;
  return p.name;
}

// Options for a profile <select>: detailed labels when the server provides
// them, otherwise the plain name list (old-server degrade).
function profileOptions(info) {
  const det = Array.isArray(info?.profilesDetailed) ? info.profilesDetailed : null;
  if (det?.length) return det.map((p) => h('option', { value: p.name }, profileOptionLabel(p)));
  if (info?.profiles?.length) return info.profiles.map((p) => h('option', { value: p }, p));
  return [h('option', { value: '' }, '(no profiles found — env credentials)')];
}

function arnTail(arn) {
  const s = String(arn || '');
  const parts = s.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : (s.split(':').pop() || s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAwsAuth(ctx, info) {
  const supported = Array.isArray(info?.profilesDetailed);
  const detailed = supported ? info.profilesDetailed : [];
  const cache = new Map(); // profile -> {at, res} — page-session cache

  const detailOf = (name) => detailed.find((p) => p.name === name) || null;
  // authVia the UI sends along with heavy actions: 'vault' for vault-only
  // profiles, 'profile' otherwise; undefined when the server is old.
  const viaOf = (name) => {
    const d = detailOf(name);
    return d ? (d.source === 'vault' ? 'vault' : 'profile') : undefined;
  };

  // check(profile) -> auth/check response, or null when unsupported/absent
  // (callers treat null as "proceed — no pre-flight available").
  async function check(profile, { maxAgeMs = Infinity } = {}) {
    if (!supported) return null;
    const key = profile || '(default)';
    const c = cache.get(key);
    if (c && Date.now() - c.at < maxAgeMs) return c.res;
    const q = new URLSearchParams();
    if (profile) q.set('profile', profile);
    const via = viaOf(profile);
    if (via) q.set('via', via);
    let res;
    try { res = await ctx.api.get(`/discover/aws/auth/check${q.toString() ? `?${q}` : ''}`); }
    catch (e) {
      if (isUnavailable(e)) return null; // endpoint not mounted — degrade
      throw e;
    }
    cache.set(key, { at: Date.now(), res });
    return res;
  }

  // Launch the login process server-side (opens the browser / vault prompt
  // on this machine). A 409 means one is already running — treat as started.
  async function startLogin(profile) {
    try {
      return await ctx.api.post('/discover/aws/auth/login', { profile, via: viaOf(profile) });
    } catch (e) {
      if (/already in progress/i.test(e?.message || '')) return { started: true, attached: true };
      throw e;
    }
  }

  // Poll auth/check every 2.5s (max 4 min) until the session works; also
  // watch the login process so a crashed login surfaces immediately.
  async function waitForLogin(profile, { onTick, timeoutMs = 240000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      await sleep(2500);
      const secs = Math.round((Date.now() - t0) / 1000);
      onTick?.(secs);
      try {
        const chk = await check(profile, { maxAgeMs: 0 });
        if (chk?.ok) return { ok: true, chk };
        if (chk === null) return { ok: false, error: 'auth endpoints unavailable' };
      } catch { /* transient — keep polling */ }
      try {
        const st = await ctx.api.get(`/discover/aws/auth/login/${encodeURIComponent(profile)}/status`);
        if (st && st.running === false && st.ok === false) {
          return { ok: false, crashed: true, stderrTail: st.stderrTail || '' };
        }
      } catch { /* status endpoint is best-effort */ }
      if (Date.now() - t0 > timeoutMs) return { ok: false, timeout: true };
    }
  }

  // Slim status line under a profile row: authenticated identity, or a
  // warn + Authenticate button, plus a manual re-check. Hidden entirely on
  // old servers.
  function statusLine(profileSel) {
    const line = h('div', { class: 'auth-line', hidden: !supported });
    if (!supported) return { el: line, refresh: () => {} };
    let seq = 0;
    const render = async ({ force = false } = {}) => {
      const mySeq = ++seq;
      const profile = profileSel.value;
      line.innerHTML = '';
      line.append(h('span', null, 'Checking AWS access…'));
      let res = null;
      try { res = await check(profile, { maxAgeMs: force ? 0 : Infinity }); }
      catch (e) { res = { ok: false, error: e.message, canLogin: false, method: 'keys' }; }
      if (mySeq !== seq) return; // a newer render superseded this one
      line.innerHTML = '';
      const recheck = h('button', { class: 'btn btn-ghost btn-sm', onClick: () => render({ force: true }) }, 'Check access');
      if (res === null) { line.hidden = true; return; }
      if (res.ok) {
        line.append(
          badge('✓ authenticated', 'ok'),
          h('span', { class: 'auth-id' }, `as ${res.identity?.account || '?'} (${arnTail(res.identity?.arn)})`),
          recheck);
        return;
      }
      line.append(badge('session expired / not authenticated', 'warn'));
      if (res.canLogin) {
        const authBtn = h('button', { class: 'btn btn-sm' }, 'Authenticate');
        authBtn.addEventListener('click', async () => {
          authBtn.disabled = true;
          authBtn.textContent = 'Waiting for browser sign-in…';
          try {
            await startLogin(profile);
            const done = await waitForLogin(profile, {
              onTick: (s) => { authBtn.textContent = `Waiting for browser sign-in… (${s}s)`; },
            });
            if (done.ok) toast('Authenticated ✓', 'ok');
            else toast(done.crashed ? `Login failed: ${done.stderrTail || 'the login process exited with an error'}`
              : 'Login timed out — try again', 'err');
          } catch (e) { toast(e.message, 'err'); }
          render({ force: true });
        });
        line.append(authBtn);
      }
      line.append(recheck);
    };
    let debounce;
    profileSel.addEventListener('change', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => render(), 350);
    });
    render();
    return { el: line, refresh: () => render({ force: true }) };
  }

  // Pre-flight for every heavy AWS action: cached-ok (<60s) proceeds
  // immediately; an expired session renders an inline auth card that, after
  // a successful browser sign-in, AUTO-STARTS the originally requested
  // action. Unsupported/old server → run() unchanged.
  async function preflight(profile, { host, actionLabel = 'the action', buttons = [], run }) {
    let chk = null;
    setButtonsRunning(buttons, true);
    try { chk = await check(profile, { maxAgeMs: 60000 }); }
    catch { chk = null; } // pre-flight must never block the action outright
    if (!chk || chk.ok) { await run(); return; }
    setButtonsRunning(buttons, false);

    const label = profile || 'default';
    const showCard = (body) => { host.innerHTML = ''; host.append(card(...body)); };

    if (!chk.canLogin) {
      showCard([
        h('h2', null, 'AWS credentials needed'),
        h('p', { style: 'margin:8px 0' }, badge(`Profile '${label}' is not authenticated`, 'err')),
        chk.error ? h('pre', { class: 'mono', style: 'margin:8px 0' }, chk.error) : null,
        h('p', { class: 'hint' },
          'This profile has no login flow DR Compass can launch (static keys). Refresh its credentials in your terminal, then retry.'),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn', onClick: () => preflight(profile, { host, actionLabel, buttons, run }) }, 'Retry')),
      ]);
      return;
    }

    const authBtn = h('button', { class: 'btn btn-primary' }, 'Authenticate');
    const statusEl = h('p', { class: 'hint', style: 'margin-top:8px' });
    showCard([
      h('h2', null, 'Authentication needed'),
      h('p', { style: 'margin:8px 0' },
        `Session for '${label}' needs authentication — `,
        h('strong', null, 'Authenticate'),
        ' will open your browser (AWS’s own sign-in page; DR Compass never sees your credentials).'),
      chk.loginHint ? h('p', { class: 'hint' }, chk.loginHint) : null,
      h('div', { class: 'row', style: 'margin-top:10px' }, authBtn),
      statusEl,
    ]);
    authBtn.addEventListener('click', async () => {
      authBtn.disabled = true;
      try { await startLogin(profile); }
      catch (e) {
        authBtn.disabled = false;
        statusEl.textContent = '';
        statusEl.append(badge(e.message, 'err'));
        return;
      }
      statusEl.innerHTML = '';
      statusEl.append('Waiting for you to finish signing in in the browser… ',
        h('span', { class: 'auth-wait-sec' }, '(0s)'));
      const secEl = statusEl.querySelector('.auth-wait-sec');
      const done = await waitForLogin(profile, {
        onTick: (s) => { if (secEl) secEl.textContent = `(${s}s)`; },
      });
      if (done.ok) {
        toast(`Authenticated ✓ — starting ${actionLabel}`, 'ok');
        host.innerHTML = '';
        await run();
        return;
      }
      showCard([
        h('h2', null, 'Authentication failed'),
        h('p', { style: 'margin:8px 0' },
          badge(done.timeout ? 'Timed out after 4 minutes waiting for the sign-in' : 'The login process exited with an error', 'err')),
        done.stderrTail ? h('pre', { class: 'mono', style: 'margin:8px 0' }, done.stderrTail) : null,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn', onClick: () => preflight(profile, { host, actionLabel, buttons, run }) }, 'Retry')),
      ]);
    });
  }

  return { supported, viaOf, check, statusLine, preflight };
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
  const resumeMap = {}; // kind -> resume spec; filled here + by enrichmentSection
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

  const auth = makeAwsAuth(ctx, info);
  const profileSel = h('select', null, profileOptions(info));
  const authLine = auth.statusLine(profileSel);
  const regionInp = h('input', { value: meta.regions?.primary || 'us-east-1', placeholder: 'e.g. us-east-1' });
  const mapCb = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const scanBtn = h('button', { class: 'btn btn-primary', disabled: !info.awsCliFound }, 'Scan & map account');
  const scanButtons = [{
    el: scanBtn,
    runningText: 'Scanning… (read-only list/describe calls)',
    idleText: 'Scan & map account',
    idleDisabled: !info.awsCliFound,
  }];

  scanBtn.addEventListener('click', async () => {
    if (!selected.size) { toast('Pick at least one service to scan', 'err'); return; }
    const base = { profile: profileSel.value, region: regionInp.value.trim(), services: [...selected] };
    const authVia = auth.viaOf(profileSel.value);
    if (authVia) base.authVia = authVia;
    // Credential pre-flight: an expired SSO/vault session renders an inline
    // Authenticate card and auto-starts the scan once sign-in completes.
    await auth.preflight(profileSel.value, {
      host: results,
      actionLabel: mapCb.checked ? 'the AWS scan & map' : 'the AWS scan',
      buttons: scanButtons,
      run: async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scanning… (read-only list/describe calls)';
        results.innerHTML = '';
        // Job path first — survives refresh; falls back to the synchronous
        // scan below when the jobs backend is not mounted.
        const handled = await runJob(ctx,
          mapCb.checked ? 'aws-scan-map' : 'aws-scan',
          mapCb.checked ? { ...base, mapDependencies: true } : base, {
            label: 'Scanning AWS account…',
            activityHost: results,
            renderResult: (res) => renderScanResults(res),
            buttons: scanButtons,
          });
        if (handled) return;
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
      },
    });
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
      authLine.el,
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
    ...enrichmentSection(ctx, info, meta, comps, resumeMap, auth),
  );
  resumeMap['aws-scan'] = { host: results, render: (res) => renderScanResults(res), buttons: scanButtons };
  resumeMap['aws-scan-map'] = { host: results, render: (res) => renderScanResults(res), buttons: scanButtons };
  resumeJobs(ctx, 'aws', resumeMap); // deliberately not awaited — resume never blocks the tab
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

function enrichmentSection(ctx, info, meta, comps, resumeMap, auth) {
  const { ws, api } = ctx;
  const compsById = Object.fromEntries(comps.map((c) => [c.id, c]));
  const awsComps = comps.filter((c) => c.awsServices?.length);
  auth = auth || makeAwsAuth(ctx, info); // defensive — callers always pass it

  // Same profiles the scan card uses — no second network call.
  const profiles = Array.isArray(info.profilesDetailed) && info.profilesDetailed.length
    ? info.profilesDetailed.map((p) => p.name)
    : (info.profiles || []);
  const profileSel = h('select', null, profileOptions(info));
  const savedProfile = lsGet('drc.enrich.profile');
  if (savedProfile && profiles.includes(savedProfile)) profileSel.value = savedProfile;
  const authLine = auth.statusLine(profileSel);
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

  // Shared render/toast paths — used identically by the job path, the sync
  // fallback, and "Last run → View results".
  const renderEnrichResults = (res, { expectTargeted = false } = {}) => {
    results.innerHTML = '';
    if (expectTargeted && typeof res.targeted !== 'number') {
      // Older backend that ignores target:'arpio' — it enriched every AWS
      // component instead of just the Arpio-imported ones. Say so.
      results.append(h('div', { class: 'row', style: 'margin:0 0 10px' },
        badge('Targeted Arpio overlay is not available on this server yet — ran a normal enrichment across AWS components.', 'warn')));
    }
    results.append(enrichResultPanel(res, compsById));
  };
  const toastEnrich = (res) => {
    if (typeof res.targeted === 'number' && res.targeted === 0) {
      toast('No Arpio-imported components found — import on the Arpio tab first.', 'err');
    } else {
      toast(`Enrichment added ${res.addedNodes ?? 0} node(s) — click nodes on the Diagrams page to explore associations.`, 'ok');
    }
  };

  const runEnrich = async (btn, runningLabel, idleLabel, path, body, cardTitle = 'Deep enrichment', { expectTargeted = false } = {}) => {
    const authVia = auth.viaOf(profileSel.value);
    if (authVia) body = { ...body, authVia };
    // Credential pre-flight — an expired session shows an inline Authenticate
    // card and auto-starts this enrichment once the sign-in completes.
    await auth.preflight(profileSel.value, {
      host: results,
      actionLabel: cardTitle.toLowerCase(),
      buttons: [{ el: btn, runningText: runningLabel, idleText: idleLabel }],
      run: async () => {
        btn.disabled = true;
        btn.textContent = runningLabel;
        persist();
        results.innerHTML = '';
        // Job path first — survives refresh; sync fallback below is unchanged.
        const handled = await runJob(ctx, 'enrich', body, {
          label: expectTargeted ? 'Mapping Arpio dependencies…' : 'Enriching components…',
          activityHost: results,
          renderResult: (res) => renderEnrichResults(res, { expectTargeted }),
          doneToast: toastEnrich,
          buttons: [{ el: btn, runningText: runningLabel, idleText: idleLabel }],
        });
        if (handled) return;
        try {
          const res = await api.post(path, body);
          renderEnrichResults(res, { expectTargeted });
          toastEnrich(res);
        } catch (e) {
          results.innerHTML = '';
          results.append(isUnavailable(e) ? unavailableCard(cardTitle) : card(badge(e.message, 'err')));
        } finally {
          btn.disabled = false;
          btn.textContent = idleLabel;
        }
      },
    });
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
  const renderTagResults = (res, { note = null } = {}) => {
    results.innerHTML = '';
    if (note) {
      results.append(h('div', { class: 'row', style: 'margin:0 0 10px' }, badge(note, 'warn')));
    }
    results.append(enrichResultPanel(res, compsById));
    if (res.proposals?.length) results.append(proposalsPanel(res.proposals, ctx));
  };
  const toastTag = (res) => {
    toast(`Tag pull matched ${res.matched ?? 0} resource(s)${res.proposals?.length ? ` — ${res.proposals.length} component proposal(s) below` : ''}.`,
      (res.matched ?? 0) ? 'ok' : '');
  };
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
    const common = { profile: profileSel.value, region: regionInp.value.trim() };
    const authVia = auth.viaOf(profileSel.value);
    if (authVia) common.authVia = authVia;
    const tagButtons = [{ el: tagBtn, runningText: 'Pulling by tags… (read-only)', idleText: 'Pull by tags' }];
    // Credential pre-flight — an expired session shows an inline Authenticate
    // card and auto-starts the tag pull once the sign-in completes.
    await auth.preflight(profileSel.value, {
      host: results,
      actionLabel: 'the tag pull',
      buttons: tagButtons,
      run: async () => {
        tagBtn.disabled = true;
        tagBtn.textContent = 'Pulling by tags… (read-only)';
        results.innerHTML = '';
        // Job path first — survives refresh; the sync fallback below (including
        // its old-backend single-tag degradation) is unchanged.
        const handled = await runJob(ctx, 'enrich-by-tag',
          { ...common, tags, proposeComponents: proposeCb.checked }, {
            label: 'Pulling resources by tag…',
            activityHost: results,
            renderResult: (res) => renderTagResults(res),
            doneToast: toastTag,
            buttons: tagButtons,
          });
        if (handled) return;
        try {
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
          renderTagResults(res, {
            note: fellBack
              ? `Multi-tag filters not available on this server yet — used only ${tags[0].key}=${tags[0].values[0]}.`
              : null,
          });
          toastTag(res);
        } catch (e) {
          results.innerHTML = '';
          results.append(isUnavailable(e) ? unavailableCard('Correlate by tag') : card(badge(e.message, 'err')));
        } finally {
          tagBtn.disabled = false;
          tagBtn.textContent = 'Pull by tags';
        }
      },
    });
  });

  if (resumeMap) {
    resumeMap['enrich'] = {
      host: results,
      render: (res) => renderEnrichResults(res),
      doneToast: toastEnrich,
      buttons: [
        { el: enrichBtn, runningText: 'Enriching… (read-only describe calls)', idleText: 'Enrich selected', idleDisabled: !awsComps.length },
        { el: arpioBtn, runningText: 'Mapping Arpio dependencies… (read-only)', idleText: 'Map dependencies for Arpio-imported components' },
      ],
    };
    resumeMap['enrich-by-tag'] = {
      host: results,
      render: (res) => renderTagResults(res),
      doneToast: toastTag,
      buttons: [{ el: tagBtn, runningText: 'Pulling by tags… (read-only)', idleText: 'Pull by tags' }],
    };
  }

  return [
    card(
      h('h2', null, 'Deep enrichment — associate everything (Arpio-style depth)'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Pulls each component’s real associations: security groups, subnets & AZs, IAM roles/policies, target groups & listeners, KMS, certificates, tags — into the resource graph shown when you click a diagram node. Read-only, through the same local AWS CLI.'),
      h('div', { class: 'grid cols-2' },
        field('AWS profile', profileSel),
        field('Region', regionInp)),
      authLine.el,
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

  // Shared render path — used by the job path, the sync fallback, and
  // "Last run → View results".
  const renderArpioResults = (res) => {
    results.innerHTML = '';
    res = res || {};
    if (res.ok) {
      if (res.message) results.append(errorBadges([res.message]));
      if (res.trace?.length) results.append(logPanel(res.trace, 'steps'));
      results.append(proposalsPanel(res.proposals || [], ctx));
    } else {
      results.append(card(
        h('h2', null, 'Could not read from Arpio'),
        h('p', { style: 'margin:8px 0' }, badge(res.message || 'Unknown error', 'warn')),
        res.trace?.length
          ? h('details', { class: 'disc-log', open: true, style: 'margin:10px 0' },
              h('summary', null, `What each Arpio endpoint returned (${res.trace.length} steps — no secrets)`),
              h('pre', { class: 'mono' }, res.trace.join('\n')))
          : null,
        h('p', { class: 'hint' },
          'Keys are created in the Arpio console under Settings → Account Settings → API Keys, and both parts are needed (sent as "X-Api-Key: <keyId>:<secret>"). If the key cannot list accounts, add your Account ID — the first randomized string in your Arpio console URL. If the trace shows data that isn\'t being extracted, paste the trace to your AI copilot or into a GitHub issue — it contains structure only, no secrets.'),
      ));
    }
  };
  const toastArpio = (res) => {
    if (res?.ok) toast(`Arpio scan finished — ${(res.proposals || []).length} proposal(s) below`, 'ok');
    else toast(res?.message || 'Could not read from Arpio — see details below', 'err');
  };
  const connectButtons = [{ el: connectBtn, runningText: 'Connecting…', idleText: 'Connect & scan' }];

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
    const body = keyId.includes(':') && !secret
      ? { apiKey: keyId, accountId: acctInp.value.trim() }
      : { apiKeyId: keyId, apiSecret: secret, accountId: acctInp.value.trim() };
    // Job path first — same body as the sync endpoint (keys are used
    // per-request server-side and never persisted, job or not); falls back
    // to the synchronous call when the jobs backend is not mounted.
    const handled = await runJob(ctx, 'arpio', body, {
      label: 'Scanning Arpio account…',
      activityHost: results,
      renderResult: renderArpioResults,
      doneToast: toastArpio,
      buttons: connectButtons,
    });
    if (handled) return;
    try {
      const res = await api.post(`/w/${ws}/discover/arpio`, body);
      renderArpioResults(res);
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
  resumeJobs(ctx, 'arpio', {
    arpio: { host: results, render: renderArpioResults, doneToast: toastArpio, buttons: connectButtons },
  }); // deliberately not awaited
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
  let k8sScanButtons = []; // set below when the scan button exists

  // Shared render path — used by the job path, the sync fallback, and
  // "Last run → View results". (loadSnapshot is hoisted.)
  const renderK8sScanResults = (res) => {
    scanResults.innerHTML = '';
    scanResults.append(card(
      h('h3', { style: 'margin-bottom:6px' }, 'Scan results'),
      k8sSummaryChips(res.summary),
      ...[errorBadges(res.errors), logPanel(res.log, 'kubectl commands')].filter(Boolean),
      h('p', { style: 'margin-top:4px' },
        h('a', { href: `#/${ws}/diagrams/k8s-cluster` }, 'View diagrams →')),
    ));
    loadSnapshot();
  };

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
    k8sScanButtons = [{
      el: scanBtn,
      runningText: 'Scanning… (read-only kubectl get calls)',
      idleText: 'Scan cluster',
      idleDisabled: !contexts.length,
    }];
    triggerScan = async () => {
      if (scanBtn.disabled) return;
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning… (read-only kubectl get calls)';
      scanResults.innerHTML = '';
      const namespaces = nsInp.value.split(',').map((s) => s.trim()).filter(Boolean);
      const body = { context: ctxSel.value };
      if (namespaces.length) body.namespaces = namespaces;
      // Job path first — survives refresh; sync fallback below unchanged.
      const handled = await runJob(ctx, 'k8s-scan', body, {
        label: 'Scanning Kubernetes cluster…',
        activityHost: scanResults,
        renderResult: renderK8sScanResults,
        buttons: k8sScanButtons,
      });
      if (handled) return;
      try {
        const res = await api.post(`/w/${ws}/k8s/scan`, body);
        renderK8sScanResults(res);
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
  resumeJobs(ctx, 'k8s', {
    'k8s-scan': { host: scanResults, render: renderK8sScanResults, buttons: k8sScanButtons },
  }); // deliberately not awaited
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
      h('span', { class: 'tab', 'data-tab': t.id, 'data-label': t.label, onClick: () => activate(t.id) }, t.label));
    currentTabEls = tabEls;
    refreshTabBadges(); // running jobs already known this session badge instantly
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
