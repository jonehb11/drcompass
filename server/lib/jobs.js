// Background-job engine for long-running discovery operations.
//
// Jobs run server-side, stream progress lines (the libs' onLog output plus
// engine milestones/heartbeats), and persist FINISHED jobs per-workspace via
// the object store ('discovery-jobs') so results survive page refreshes AND
// server restarts. Running jobs live only in this process's registry — a job
// that was running when the process died is simply unknown afterwards.
//
// Contract highlights (HARD — the UI polls against this, see routes/jobs.js):
//   job view: { id, kind, ws, status: 'running'|'done'|'error', startedAt,
//               finishedAt?, elapsedMs, progress: [strings], result?, error? }
//   one RUNNING job per (ws, kind); progress capped at 500 lines (+ one
//   truncation note); heartbeat line every 10s of onLog silence; persisted
//   jobs keep the last 15 per workspace, progress stripped to the last 100
//   lines, result capped at ~4MB JSON (proposals capped to first 500).
import * as store from '../store.js';

const JOBS_OBJECT = 'discovery-jobs';
const MAX_PROGRESS = 500;        // in-memory progress line cap (then 1 note)
const STORED_PROGRESS = 100;     // persisted progress: last N lines
const KEEP = 15;                 // persisted + listed jobs per workspace
const MAX_RESULT_JSON = 4 * 1024 * 1024; // ~4MB persisted-result cap
const MAX_PROPOSALS_STORED = 500;
const HEARTBEAT_MS = 10000;

// id -> job, this process only (running + recently finished).
const registry = new Map();

const nowIso = () => new Date().toISOString();

function fmtDur(ms) {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

// ---------------------------------------------------------------- progress

function pushLine(job, line) {
  job._lastLineAt = Date.now();
  const entry = `[+${fmtDur(Date.now() - job._startMs)}] ${String(line)}`;
  if (job.progress.length < MAX_PROGRESS) {
    job.progress.push(entry);
    return;
  }
  // Cap reached: one (updating) truncation note instead of unbounded growth.
  job._dropped = (job._dropped || 0) + 1;
  job.progress[MAX_PROGRESS] = `… progress truncated at ${MAX_PROGRESS} lines (${job._dropped} more not shown)`;
}

function storedProgress(progress) {
  if (progress.length <= STORED_PROGRESS) return [...progress];
  const stripped = progress.length - STORED_PROGRESS;
  return [`… ${stripped} earlier lines stripped for storage (last ${STORED_PROGRESS} kept)`,
    ...progress.slice(-STORED_PROGRESS)];
}

// ---------------------------------------------------------------- result cap

function jsonLen(v) {
  try { return JSON.stringify(v).length; } catch { return Infinity; }
}

// Cap a result at ~4MB of JSON for persistence. Scalars survive; arrays are
// capped (proposals to the first 500, with a note); oversized nested objects
// are dropped with a note. Last resort halves proposals until it fits.
function capResult(result) {
  if (jsonLen(result) <= MAX_RESULT_JSON) return result;
  const out = {
    truncated: true,
    note: `full result exceeded the ${Math.round(MAX_RESULT_JSON / (1024 * 1024))}MB persistence cap — arrays capped (proposals to first ${MAX_PROPOSALS_STORED}); re-run the operation for a full result`,
  };
  const src = result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result };
  for (const [k, v] of Object.entries(src)) {
    if (k === 'truncated' || k === 'note') continue;
    if (Array.isArray(v)) {
      const cap = k === 'proposals' ? MAX_PROPOSALS_STORED : 200;
      out[k] = v.slice(0, cap);
      if (v.length > cap) out[`${k}Truncated`] = `${v.length - cap} of ${v.length} entries dropped from the persisted copy`;
    } else if (v && typeof v === 'object') {
      if (jsonLen(v) <= 512 * 1024) out[k] = v;
      else out[`${k}Truncated`] = 'too large for the persisted copy';
    } else {
      out[k] = v;
    }
  }
  while (jsonLen(out) > MAX_RESULT_JSON && Array.isArray(out.proposals) && out.proposals.length > 10) {
    out.proposals = out.proposals.slice(0, Math.floor(out.proposals.length / 2));
    out.proposalsTruncated = `proposals reduced to ${out.proposals.length} to fit the persistence cap`;
  }
  if (jsonLen(out) > MAX_RESULT_JSON) {
    for (const k of Object.keys(out)) {
      if (Array.isArray(out[k]) && jsonLen(out) > MAX_RESULT_JSON) {
        out[k] = out[k].slice(0, 10);
        out[`${k}Truncated`] = 'hard-capped to fit the persistence cap';
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- persistence

function readPersisted(ws) {
  try {
    const cur = store.getObject(ws, JOBS_OBJECT);
    return Array.isArray(cur && cur.jobs) ? cur.jobs : [];
  } catch {
    return []; // workspace gone → nothing persisted
  }
}

function persistFinished(job) {
  const rec = {
    id: job.id, kind: job.kind, ws: job.ws, status: job.status,
    startedAt: job.startedAt, finishedAt: job.finishedAt, elapsedMs: job.elapsedMs,
    summary: job.summary,
    progress: storedProgress(job.progress),
  };
  if (job.status === 'done') rec.result = capResult(job.result);
  if (job.error !== undefined) rec.error = job.error;
  const rest = readPersisted(job.ws).filter((j) => j && j.id !== job.id);
  store.saveObject(job.ws, JOBS_OBJECT, { jobs: [rec, ...rest].slice(0, KEEP) });
}

// Keep the in-memory registry tidy: at most KEEP finished jobs per workspace
// (they are persisted anyway); running jobs are never pruned.
function pruneRegistry(ws) {
  const finished = [...registry.values()]
    .filter((j) => j.ws === ws && j.status !== 'running')
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  for (const j of finished.slice(KEEP)) registry.delete(j.id);
}

// ---------------------------------------------------------------- engine

// startJob({ws, kind, startLine, run, summarize})
//   run: async (onLog) => result   (result must match the sync endpoint)
//   summarize: (result) => one human line for the jobs list
// Returns {job} — or {conflict: runningJob} when a job of this kind is
// already running in this workspace (one RUNNING job per (ws, kind)).
// No awaits between the guard check and registry.set, so the guard is atomic.
export function startJob({ ws, kind, startLine, run, summarize }) {
  for (const j of registry.values()) {
    if (j.ws === ws && j.kind === kind && j.status === 'running') return { conflict: j };
  }
  const job = {
    id: store.newId('job'), kind, ws,
    status: 'running',
    startedAt: nowIso(), finishedAt: null, elapsedMs: 0,
    progress: [], result: undefined, error: undefined, summary: '',
    _startMs: Date.now(), _lastLineAt: Date.now(), _dropped: 0,
  };
  registry.set(job.id, job);
  pushLine(job, startLine || `started ${kind}`);

  // Heartbeat: pollers always see movement even while a slow CLI call hangs.
  const timer = setInterval(() => {
    if (job.status !== 'running') return;
    if (Date.now() - job._lastLineAt >= HEARTBEAT_MS) {
      pushLine(job, `… still running (${Math.round((Date.now() - job._startMs) / 1000)}s elapsed)`);
    }
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();

  job._promise = (async () => {
    try {
      job.result = await run((line) => pushLine(job, line));
      job.status = 'done';
      job.elapsedMs = Date.now() - job._startMs;
      pushLine(job, `finished in ${fmtDur(job.elapsedMs)}`);
    } catch (e) {
      job.status = 'error';
      job.error = String((e && e.message) || e).slice(0, 500);
      job.elapsedMs = Date.now() - job._startMs;
      pushLine(job, `failed after ${fmtDur(job.elapsedMs)}: ${job.error}`);
    } finally {
      clearInterval(timer);
      job.finishedAt = nowIso();
      job.elapsedMs = Date.now() - job._startMs;
      try {
        job.summary = job.status === 'error'
          ? `failed: ${job.error}`.slice(0, 200)
          : String((typeof summarize === 'function' && summarize(job.result)) || 'done').slice(0, 200);
      } catch { job.summary = job.status; }
      try { persistFinished(job); } catch (e) {
        pushLine(job, `warning: could not persist finished job: ${(e && e.message) || e}`);
      }
      pruneRegistry(job.ws);
    }
  })();

  return { job };
}

// ---------------------------------------------------------------- reads

function liveElapsed(j) {
  return j.status === 'running' && j._startMs ? Date.now() - j._startMs : (j.elapsedMs || 0);
}

// Full job view (GET /jobs/:id shape). Works for in-memory jobs and for
// records read back from the persisted store.
export function jobView(j) {
  const v = {
    id: j.id, kind: j.kind, ws: j.ws, status: j.status,
    startedAt: j.startedAt, elapsedMs: liveElapsed(j),
    progress: Array.isArray(j.progress) ? j.progress : [],
  };
  if (j.finishedAt) v.finishedAt = j.finishedAt;
  if (j.status === 'done') v.result = j.result;
  if (j.error !== undefined) v.error = j.error;
  return v;
}

function jobSummaryView(j) {
  return {
    id: j.id, kind: j.kind, status: j.status,
    startedAt: j.startedAt, finishedAt: j.finishedAt || null,
    elapsedMs: liveElapsed(j),
    summary: j.status === 'running'
      ? `running (${Math.round(liveElapsed(j) / 1000)}s elapsed)`
      : (j.summary || j.status),
  };
}

// getJob(ws, id) -> job or persisted record (jobView-able), or null.
// In-memory first; the persisted store covers server restarts/refreshes.
export function getJob(ws, id) {
  const mem = registry.get(id);
  if (mem && mem.ws === ws) return mem;
  return readPersisted(ws).find((j) => j && j.id === id) || null;
}

// listJobs(ws) -> up to KEEP summaries, newest-first, running included.
export function listJobs(ws) {
  const mem = [...registry.values()].filter((j) => j.ws === ws);
  const memIds = new Set(mem.map((j) => j.id));
  const all = [...mem, ...readPersisted(ws).filter((j) => j && !memIds.has(j.id))];
  all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return all.slice(0, KEEP).map(jobSummaryView);
}
