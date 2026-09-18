// What to do with a thing that might be a megabyte — and where it is allowed
// to land.
//
// THE PROBLEM. `export_workbook` produces a real .xlsx. Base64 of that is ~1.4x
// the file, it is meaningless to a language model, and it would evict the
// conversation that asked for it. `export_bundle` carries every CSV and every
// runbook markdown inside one JSON document. Even a read tool can blow up: a
// resource graph on a real AWS account is not small, and `deploy_order` on the
// bundled example workspace is 394 KB.
//
// THE INVARIANT, and it is worth stating in one sentence because everything
// below follows from it:
//
//     THIS SERVER NEVER CREATES A FILE THE CALLER DID NOT NAME.
//
// An earlier version of this file was cleverer: oversized results "spilled" to
// <workspace home>/exports/ on their own, and exports defaulted to a path there.
// It was convenient and it was wrong. A server the user started READ-ONLY was
// quietly creating state in their data directory — eight files from one sweep
// of read tools — and a caller that asked for an answer got a file it never
// asked for. Convenience is not worth a surprise inside somebody's ~/.drcompass.
//
// So:
//
//   * No `outputPath` ⇒ nothing is written. Text comes back inline, truncated
//     with a loud note if it is over the cap. A read result comes back capped,
//     with a structure-preserving preview. The .xlsx — which cannot be a chat
//     message at all — comes back as a refusal that says exactly what to pass.
//   * `outputPath` given ⇒ that file, there, and nothing else.
//   * `outputPath` MUST BE ABSOLUTE. An MCP server is spawned by a client, so
//     its working directory is whatever the client felt like (often `/`) and a
//     relative path is a guess about somebody else's filesystem. It is also the
//     probe defence: a model or a harness filling a required string with a
//     placeholder cannot write anything, because a placeholder is not absolute.
import fs from 'node:fs';
import path from 'node:path';

// A runbook markdown or a failover brief runs to ~40 KB. Those are worth
// reading whole when somebody asked for that exact artifact, so the cap is set
// above them; a 400 KB CSV is not, and gets truncated with a note.
export const INLINE_TEXT_MAX = 48 * 1024;
export const INLINE_JSON_MAX = 60 * 1024;
export const SLICE = 8 * 1024;

export class OutputPathError extends Error {}

/**
 * Validate a caller-supplied path. Absolute or nothing.
 * @returns {string} the absolute path, with its directory created
 */
export function resolveOutputPath(outputPath, { what = 'this artifact', suggest = '' } = {}) {
  const p = String(outputPath || '');
  if (!p) throw new OutputPathError(`No outputPath was given for ${what}.`);
  if (!path.isAbsolute(p)) {
    throw new OutputPathError(
      `outputPath must be an ABSOLUTE path — got "${p}". This server is spawned by your MCP client, so its `
      + 'working directory is not a place either of us can reason about, and a relative path would write '
      + `somewhere neither of us chose.${suggest ? ` Try something like: ${suggest}` : ''}`,
    );
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export function writeArtifact(outputPath, data, meta) {
  const file = resolveOutputPath(outputPath, meta);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  fs.writeFileSync(file, buf);
  return { path: file, bytes: buf.length };
}

/**
 * A text artifact: inline unless the caller named a file.
 */
export function deliverText({ outputPath, text, label, suggestName = 'artifact.txt' }) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (outputPath) {
    const { path: file } = writeArtifact(outputPath, text, { what: label, suggest: `/tmp/${suggestName}` });
    return {
      wroteFile: true,
      path: file,
      bytes,
      note: `${label} was written to ${file} (${bytes} bytes), because you named a path. `
        + 'Nothing else was written.',
    };
  }
  if (bytes <= INLINE_TEXT_MAX) {
    return { wroteFile: false, bytes, content: text, note: `${label} in full (${bytes} bytes). Nothing was written to disk.` };
  }
  return {
    wroteFile: false,
    bytes,
    content: text.slice(0, SLICE),
    contentIsPartial: true,
    note: `${label} is ${bytes} bytes — too large to return whole — so \`content\` is the first ${SLICE} bytes `
      + 'only. NOTHING was written to disk: to get the whole thing, call this tool again with an absolute '
      + `\`outputPath\` (e.g. /tmp/${suggestName}), or narrow the scope with envId/serviceId/componentId.`,
  };
}

/**
 * A binary artifact. It cannot be inlined at all, so an absolute outputPath is
 * not optional — and saying that is more honest than inventing a location in
 * the user's data directory and hoping they find it.
 */
export function deliverBinary({ outputPath, buffer, label, suggestName, summary }) {
  if (!outputPath) {
    throw new OutputPathError(
      `${label} is a binary file. It is deliberately never returned inline — base64 of a spreadsheet is `
      + 'unreadable and would fill your context — and this server does not create files nobody asked for, so '
      + 'there is no default location either.\n\n'
      + `Call this tool again with an absolute \`outputPath\`, e.g. "/tmp/${suggestName}", and it will be `
      + 'written there.\n\n'
      + 'If what you actually want is what the workbook SAYS, those are text and need no file: '
      + 'export_executive_summary, export_failover_brief, or export_csv for one sheet.',
    );
  }
  const { path: file, bytes } = writeArtifact(outputPath, buffer, { what: label, suggest: `/tmp/${suggestName}` });
  return {
    wroteFile: true,
    path: file,
    bytes,
    ...(summary ? { summary } : {}),
    note: `${label} was written to ${file} (${bytes} bytes). Binary, so it is not returned inline. `
      + 'For what it SAYS, use export_executive_summary, export_failover_brief or export_csv — all text.',
  };
}

/**
 * A read tool's JSON payload, capped. Over the cap it is NOT written anywhere:
 * the caller gets a preview and is told how to get the rest.
 */
export function deliverJson(payload, { tool = 'this tool' } = {}) {
  const text = JSON.stringify(payload, null, 2);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= INLINE_JSON_MAX) return payload;
  return {
    truncated: true,
    bytes,
    note: `This result is ${bytes} bytes — over the ${INLINE_JSON_MAX}-byte inline cap — so only a preview is `
      + 'returned. NOTHING was written to disk. Lists of records are previewed as an INDEX (every entry\'s id '
      + 'and name), so you can see everything that is there and then ask about one of them by id. To see it '
      + `all, narrow with envId/serviceId/componentId, or call ${tool} again with an absolute \`outputPath\` `
      + 'to have the full JSON written to a file you name.',
    preview: preview(payload),
  };
}

// A structure-preserving preview: keys and counts, plus the first few entries
// of each array.
//
// The one refinement that earns its keep: an array of IDENTIFIABLE records — a
// components list, a gaps list, a wave's items — is previewed as an INDEX of
// every entry's id and name rather than as three whole records. A caller whose
// components list was capped needs to know which 51 components exist so it can
// ask about one; three fat records and "… 48 more" is the least useful possible
// answer to that. Anything not identifiable falls back to the first three
// entries, which is the right shape for prose or numbers.
const IDENTITY_KEYS = ['id', 'name', 'title', 'slug', 'key'];
const LABEL_KEYS = ['name', 'title', 'label', 'text', 'category', 'severity', 'status', 'importance', 'kind', 'wave', 'layer'];
const INDEX_MAX = 250;

function identifiable(arr) {
  return arr.length > 3
    && arr.every((v) => v && typeof v === 'object' && !Array.isArray(v)
      && IDENTITY_KEYS.some((k) => typeof v[k] === 'string' || typeof v[k] === 'number'));
}

function identity(item) {
  const out = {};
  for (const k of IDENTITY_KEYS) {
    if (item[k] !== undefined && typeof item[k] !== 'object') { out[k] = item[k]; break; }
  }
  for (const k of LABEL_KEYS) {
    if (out[k] !== undefined) continue;
    const v = item[k];
    if (v === undefined || v === null || typeof v === 'object') continue;
    out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
    if (Object.keys(out).length >= 4) break;
  }
  return Object.keys(out).length ? out : { '(no identifying field)': true };
}

function preview(value, depth = 0) {
  if (Array.isArray(value)) {
    if (depth > 2) return `[${value.length} items]`;
    if (identifiable(value)) {
      const rows = value.slice(0, INDEX_MAX).map(identity);
      return value.length > INDEX_MAX ? [...rows, `… ${value.length - INDEX_MAX} more`] : rows;
    }
    return value.length > 3
      ? [...value.slice(0, 3).map((v) => preview(v, depth + 1)), `… ${value.length - 3} more`]
      : value.map((v) => preview(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 3) return '{…}';
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = preview(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}… (${value.length} chars)`;
  return value;
}
