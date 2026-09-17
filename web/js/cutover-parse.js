// "I just met with a dev and he has all of his testing things" — the quick,
// in-page path from pasted notes to draft pre-cutover checks.
//
// This is deliberately dumb and deliberately honest: it recognises the four
// shapes people actually paste (a markdown checklist, a numbered list, a pasted
// table, and Test:/Owner:/Expected: blocks), it says on every field whether it
// READ that field or GUESSED it, and it never invents a pass criterion. Prose
// that does not fit one of those shapes is left alone — the AI-assisted parse
// (Tests page, "Parse with AI") handles that, and its output goes through the
// same review table before anything is written.
//
// Document ingestion from FILES is a separate feature owned by another agent;
// this module is only the paste box.
import { normalizeAppTest, WHEN_VALUES } from './cutover.js';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (s) => str(s).replace(/\s+/g, ' ').trim();

const BLOCK_RE = /\b(blocking|blocker|must[- ]pass|must pass|hard gate|no-?go|show ?stopper|mandatory|required to cut ?over)\b/i;
const ADVISE_RE = /\b(advisory|nice[- ]to[- ]have|informational|informative|fyi|optional|soft|not blocking|non-?blocking)\b/i;
const POST_RE = /\b(post[- ]?cutover|after (the )?cutover|after (the )?flip|after (we )?(cut|move) (traffic|over)|once live|on live traffic)\b/i;
const PRE_RE = /\b(pre[- ]?cutover|before (the )?cutover|before (we )?(cut|move) (traffic|over)|before traffic moves|pre[- ]?flight gate)\b/i;
const CMD_START_RE = /^(kubectl|aws|curl|psql|mysql|redis-cli|dig|nslookup|helm|terraform|docker|nc|openssl|grpcurl|http|npm|node|python|bash|sh)\b/i;

const OWNER_RE = /\b(?:owner|owned by|run by|runs?|who|assignee|responsible)\s*[:=-]\s*([^,;()\[\]\n]{1,60})/i;
const AT_OWNER_RE = /(?:^|\s)@([a-z0-9][a-z0-9._-]{1,40})/i;
// Only an EXPLICIT "proves:"-style label, or "so that …". A bare "shows" or
// "confirms" mid-sentence used to swallow the rest of the line — "Bank partner
// confirms the first live settlement" became a check called "Bank partner".
const PROVES_RE = /\b(?:proves?|verif(?:ies|y that)|purpose|rationale)\s*[:=]\s*([^\n;]{3,200})/i;
const SO_THAT_RE = /\bso that\s+([^\n;.]{3,200})/i;
const EVIDENCE_RE = /\b(?:evidence|record|capture|screenshot|paste|attach)\s*[:=-]\s*([^\n;]{3,160})/i;
const EST_RE = /(?:~|about |approx\.? |est\.? )?\b(\d{1,3})\s*(?:min|mins|minutes|m)\b/i;
const EXPECT_RE = /\b(?:expect(?:s|ed|ing)?|expectation|pass(?:es)? (?:when|if)|success(?: is)?|should (?:be|return|show|see)|looks? like|result)\s*[:=-]?\s*/i;

const SECTION_RE = /^\s*#{0,4}\s*(.{0,80}?)\s*:?\s*$/;

/* -------------------------------------------------------------- annotations */

function pullAnnotations(text, item, notes) {
  let s = str(text);

  // Fenced/inline command first, so its contents are never mined for prose.
  const fence = s.match(/```([\s\S]*?)```/);
  if (fence) { item.command = clean(fence[1]); notes.push('command: from a code fence'); s = s.replace(fence[0], ' '); }
  const tick = s.match(/`([^`]{3,300})`/);
  if (!item.command && tick) { item.command = clean(tick[1]); notes.push('command: from backticks'); s = s.replace(tick[0], ' '); }

  // The classification tokens come out BEFORE the free-text fields, or an
  // "Owner: app team. BLOCKING" trailer gets swallowed into the owner's name and
  // the check silently stops being a gate.
  if (BLOCK_RE.test(s)) { item.onFail = 'block'; item.critical = true; s = s.replace(BLOCK_RE, ' '); notes.push('blocking: read'); }
  else if (ADVISE_RE.test(s)) { item.onFail = 'advise'; item.critical = false; s = s.replace(ADVISE_RE, ' '); notes.push('advisory: read'); }

  if (POST_RE.test(s)) { item.when = 'post-cutover'; s = s.replace(POST_RE, ' '); notes.push('when: read (post-cutover)'); }
  else if (PRE_RE.test(s)) { item.when = 'pre-cutover'; s = s.replace(PRE_RE, ' '); notes.push('when: read (pre-cutover)'); }

  const est = s.match(EST_RE);
  if (est) { item.estMinutes = Number(est[1]); s = s.replace(est[0], ' '); notes.push('estMinutes: read'); }

  const owner = s.match(OWNER_RE);
  if (owner) {
    // Stop at a sentence break: "Owner: app team. It also needs…" is one owner.
    const name = clean(owner[1]).split(/\.\s|\s[–—]\s/)[0].replace(/^(the|our)\s+/i, '').replace(/[.,;:]+$/, '').trim();
    if (name) { item.owner = name; notes.push('owner: read'); }
    s = s.replace(owner[0], ' ');
  } else {
    const at = s.match(AT_OWNER_RE);
    if (at) { item.owner = clean(at[1]); s = s.replace(at[0], ' '); notes.push('owner: read from @handle'); }
  }

  const evid = s.match(EVIDENCE_RE);
  if (evid) { item.evidence = clean(evid[1]); s = s.replace(evid[0], ' '); notes.push('evidence: read'); }

  const proves = s.match(PROVES_RE) || s.match(SO_THAT_RE);
  if (proves) { item.proves = clean(proves[1]); s = s.replace(proves[0], ' '); notes.push('proves: read'); }

  // Leftover empty brackets/parens from the removals.
  s = s.replace(/[([{]\s*[,;]*\s*[)\]}]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Pulling annotations out of the middle of a sentence leaves dangling dashes,
// colons and commas behind. A check called "Payee queue depth returns to zero —"
// is the parser showing its working; tidy them off.
const tidy = (v) => clean(v)
  .replace(/^[\s\-–—:;,.]+/, '')
  .replace(/[\s\-–—:;,]+$/, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

/** Split "name — expected" once the annotations are gone. */
function splitNameExpected(text, item, notes) {
  const s = tidy(text).replace(/^[*•]\s*/, '');

  const expectAt = s.search(EXPECT_RE);
  if (expectAt > 0) {
    const head = s.slice(0, expectAt);
    const tail = s.slice(expectAt).replace(EXPECT_RE, '');
    if (tidy(head) && tidy(tail)) { item.name = tidy(head); item.expected = tidy(tail); notes.push('pass criterion: read'); return; }
  }
  for (const sep of [' -> ', ' → ', ' => ', ' — ', ' – ', ' -- ']) {
    const i = s.indexOf(sep);
    if (i > 0) {
      item.name = tidy(s.slice(0, i));
      item.expected = tidy(s.slice(i + sep.length));
      notes.push('pass criterion: guessed from the separator');
      return;
    }
  }
  // "Name: expectation" — only when the head reads like a name, not a sentence.
  const colon = s.indexOf(': ');
  if (colon > 3 && colon < 70 && !/^(test|check|step|item)$/i.test(s.slice(0, colon))) {
    const head = tidy(s.slice(0, colon));
    const tail = tidy(s.slice(colon + 2));
    if (head.split(' ').length <= 12 && tail) {
      item.name = head; item.expected = tail;
      notes.push('pass criterion: guessed from the colon');
      return;
    }
  }
  item.name = tidy(s);
}

/* ------------------------------------------------------------------ formats */

const isTableLine = (l) => (l.match(/\|/g) || []).length >= 2 || (l.match(/\t/g) || []).length >= 1;
const splitCells = (l) => (l.includes('|') ? l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|') : l.split('\t')).map(clean);

const HEADER_ALIASES = {
  name: ['test', 'check', 'name', 'verification', 'item', 'what', 'step'],
  owner: ['owner', 'who', 'team', 'assignee', 'run by', 'responsible'],
  expected: ['expected', 'expectation', 'pass', 'pass criterion', 'success', 'result', 'looks like'],
  command: ['command', 'how', 'cmd', 'run'],
  proves: ['proves', 'why', 'purpose', 'what it proves'],
  onFail: ['blocking', 'blocks', 'gate', 'severity', 'on fail', 'critical', 'must pass'],
  when: ['when', 'phase', 'timing', 'stage'],
  evidence: ['evidence', 'record', 'capture'],
  estMinutes: ['minutes', 'mins', 'est', 'duration', 'time'],
};

function headerMap(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const c = cell.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (!c) return;
    for (const [field, names] of Object.entries(HEADER_ALIASES)) {
      if (names.includes(c) || names.some((n) => c === n || c.startsWith(n))) { if (map[field] === undefined) map[field] = i; return; }
    }
  });
  return map;
}

function parseTable(lines, ctx) {
  const rows = lines.filter((l) => isTableLine(l) && !/^[\s|:+-]+$/.test(l)).map(splitCells);
  if (rows.length < 2) return null;
  const map = headerMap(rows[0]);
  if (map.name === undefined) return null;
  const out = [];
  for (const cells of rows.slice(1)) {
    if (!cells.length || !clean(cells[map.name])) continue;
    const notes = [];
    const item = { ...ctx.blank(), name: clean(cells[map.name]) };
    const take = (field, i) => { if (i !== undefined && cells[i] !== undefined && clean(cells[i])) { item[field] = clean(cells[i]); notes.push(`${field}: from the '${rows[0][i]}' column`); } };
    take('owner', map.owner);
    take('expected', map.expected);
    take('command', map.command);
    take('proves', map.proves);
    take('evidence', map.evidence);
    if (map.onFail !== undefined) {
      const v = clean(cells[map.onFail]).toLowerCase();
      if (/^(y|yes|true|block|blocking|blocker|critical|high|must)/.test(v)) { item.onFail = 'block'; item.critical = true; }
      else if (v) { item.onFail = 'advise'; item.critical = false; }
      if (v) notes.push('blocking: from the column');
    }
    if (map.when !== undefined) {
      const v = clean(cells[map.when]).toLowerCase();
      if (POST_RE.test(v)) item.when = 'post-cutover';
      else if (PRE_RE.test(v) || /before/.test(v)) item.when = 'pre-cutover';
      if (v) notes.push('when: from the column');
    }
    if (map.estMinutes !== undefined) {
      const m = clean(cells[map.estMinutes]).match(/\d{1,3}/);
      if (m) { item.estMinutes = Number(m[0]); notes.push('estMinutes: from the column'); }
    }
    out.push(ctx.finish(item, notes));
  }
  return out.length ? { format: 'table', items: out } : null;
}

function parseBlocks(lines, ctx) {
  const FIELD = {
    test: 'name', check: 'name', name: 'name', verification: 'name',
    owner: 'owner', who: 'owner', team: 'owner', 'run by': 'owner',
    expected: 'expected', expect: 'expected', pass: 'expected', 'pass criterion': 'expected', success: 'expected', result: 'expected',
    command: 'command', cmd: 'command', how: 'command', run: 'command',
    proves: 'proves', why: 'proves', purpose: 'proves',
    evidence: 'evidence', record: 'evidence', capture: 'evidence',
    blocking: 'onFail', gate: 'onFail', critical: 'onFail', 'on fail': 'onFail',
    when: 'when', phase: 'when', timing: 'when',
    minutes: 'estMinutes', est: 'estMinutes', duration: 'estMinutes',
  };
  const out = [];
  let cur = null;
  let notes = [];
  const flush = () => { if (cur && cur.name) out.push(ctx.finish(cur, notes)); cur = null; notes = []; };
  let sawAny = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]?\s*([A-Za-z][A-Za-z ]{1,18}?)\s*:\s*(.*)$/);
    const key = m ? m[1].trim().toLowerCase() : '';
    const field = FIELD[key];
    if (!field) continue; // stray prose between blocks — left alone, never guessed at
    sawAny = true;
    const value = clean(m[2]);
    if (field === 'name') { flush(); cur = { ...ctx.blank(), name: value }; notes = ['name: read']; continue; }
    if (!cur) continue;
    if (field === 'onFail') {
      if (/^(y|yes|true|block|blocking|blocker|critical|must)/i.test(value)) { cur.onFail = 'block'; cur.critical = true; }
      else { cur.onFail = 'advise'; cur.critical = false; }
      notes.push('blocking: read');
    } else if (field === 'when') {
      if (POST_RE.test(value)) cur.when = 'post-cutover';
      else if (PRE_RE.test(value) || /before/i.test(value)) cur.when = 'pre-cutover';
      notes.push('when: read');
    } else if (field === 'estMinutes') {
      const n = value.match(/\d{1,3}/); if (n) { cur.estMinutes = Number(n[0]); notes.push('estMinutes: read'); }
    } else {
      cur[field] = value;
      notes.push(`${field}: read`);
    }
  }
  flush();
  return sawAny && out.length ? { format: 'blocks', items: out } : null;
}

function parseLines(lines, ctx) {
  const out = [];
  let pending = null;
  const flush = () => { if (pending) { out.push(ctx.finish(pending.item, pending.notes)); pending = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!clean(line)) { continue; }

    // A section header switches the running `when`/blocking context.
    const bullet = line.match(/^\s*(?:[-*•]|\d{1,2}[.)])\s*(?:\[( |x|X)\]\s*)?(.*)$/);
    if (!bullet) {
      const sec = line.match(SECTION_RE);
      const label = sec ? sec[1] : '';
      if (label && label.length < 80 && (POST_RE.test(label) || PRE_RE.test(label) || BLOCK_RE.test(label) || ADVISE_RE.test(label))) {
        flush();
        if (POST_RE.test(label)) ctx.when = 'post-cutover';
        else if (PRE_RE.test(label)) ctx.when = 'pre-cutover';
        if (BLOCK_RE.test(label)) ctx.onFail = 'block';
        else if (ADVISE_RE.test(label)) ctx.onFail = 'advise';
        continue;
      }
      // A bare command line belongs to the check above it.
      if (pending && CMD_START_RE.test(clean(line))) { pending.item.command = clean(line); pending.notes.push('command: the line under the check'); continue; }
      // An indented continuation ("  expect: ...") extends the check above it.
      if (pending && /^\s{2,}/.test(raw)) {
        const rest = pullAnnotations(clean(line), pending.item, pending.notes);
        if (rest && !pending.item.expected) {
          const t = { };
          splitNameExpected(rest, t, pending.notes);
          pending.item.expected = t.expected || t.name;
          pending.notes.push('pass criterion: from the continuation line');
        }
        continue;
      }
      flush();
      // A standalone sentence is only a check when the whole paste has no bullets.
      if (ctx.allowBareLines && clean(line).length > 8 && !/[:.]$/.test(clean(line).slice(-1))) {
        const item = { ...ctx.blank() };
        const notes = [];
        const rest = pullAnnotations(line, item, notes);
        splitNameExpected(rest, item, notes);
        if (item.name) pending = { item, notes };
      }
      continue;
    }

    flush();
    const item = { ...ctx.blank() };
    const notes = [];
    if (bullet[1] && bullet[1].toLowerCase() === 'x') notes.push('was already ticked in the notes');
    const rest = pullAnnotations(bullet[2], item, notes);
    splitNameExpected(rest, item, notes);
    if (!item.name) continue;
    pending = { item, notes };
  }
  flush();
  return out.length ? { format: 'list', items: out } : null;
}

/* --------------------------------------------------------------------- api */

/**
 * Parse pasted notes into DRAFT app tests. Writes nothing; every field carries
 * a note saying whether it was read or guessed, so the review table can show it.
 *
 * @param {string} text
 * @param {object} [opts] {defaultWhen, defaultOwner, source, componentId, serviceId}
 * @returns {{items:Array, format:string, warnings:string[], lines:number}}
 */
export function parsePastedTests(text, opts = {}) {
  const src = str(text);
  const lines = src.split(/\r?\n/);
  const defaultWhen = WHEN_VALUES.includes(opts.defaultWhen) ? opts.defaultWhen : 'pre-cutover';

  const ctx = {
    when: defaultWhen,
    onFail: '',
    allowBareLines: !/^\s*(?:[-*•]|\d{1,2}[.)])/m.test(src),
    blank: () => ({
      name: '', command: '', expected: '', componentId: str(opts.componentId), critical: false, result: null,
      when: ctx.when, owner: str(opts.defaultOwner), proves: '', onFail: ctx.onFail, evidence: '',
      estMinutes: null, source: str(opts.source), serviceId: str(opts.serviceId),
    }),
    finish: (item, notes) => {
      const it = { ...item };
      if (!it.onFail) {
        // Nothing in the notes said. A PRE-cutover check that cannot fail is not
        // a gate, so it defaults to blocking and the reviewer downgrades it. A
        // POST-cutover check cannot block a cutover that has already happened.
        it.onFail = it.when === 'post-cutover' ? 'advise' : 'block';
        notes.push(`blocking: assumed ${it.onFail} (the notes did not say)`);
      }
      if (it.onFail === 'block') it.critical = true;
      const normalized = normalizeAppTest(it);
      return { ...normalized, parseNotes: notes.slice(), guessed: notes.filter((n) => /guess|assum/i.test(n)) };
    },
  };

  const warnings = [];
  const result = parseTable(lines, ctx) || parseBlocks(lines, ctx) || parseLines(lines, ctx);
  if (!result) {
    return {
      items: [], format: 'none', lines: lines.length,
      warnings: ['Nothing here looks like a list of checks. Paste a bulleted or numbered list, a table, or Test:/Owner:/Expected: blocks — '
        + 'or use “Parse with AI”, which reads prose and proposes the same draft rows for review.'],
    };
  }

  const seen = new Set();
  const items = [];
  for (const it of result.items) {
    const k = it.name.toLowerCase();
    if (seen.has(k)) { warnings.push(`Dropped a duplicate of “${it.name}”.`); continue; }
    seen.add(k);
    items.push(it);
  }
  const noCriterion = items.filter((i) => !i.expected).length;
  if (noCriterion) {
    warnings.push(`${noCriterion} of ${items.length} check${noCriterion === 1 ? ' has' : 's have'} no pass criterion — nothing was invented for them. `
      + 'Write what "passed" literally looks like before this becomes a gate.');
  }
  const noOwner = items.filter((i) => !i.owner).length;
  if (noOwner) warnings.push(`${noOwner} check${noOwner === 1 ? ' has' : 's have'} no owner. On the day, an unowned check is an unrun check.`);
  return { items, format: result.format, warnings, lines: lines.length };
}

/**
 * Normalize whatever the AI proposed into the same draft rows the paste parser
 * produces, so both go through one review table. Accepts an array, or an object
 * with items/tests/appTests/checks.
 */
export function normalizeParsedDrafts(raw, opts = {}) {
  const list = Array.isArray(raw) ? raw : (raw?.items || raw?.tests || raw?.appTests || raw?.checks || []);
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || !clean(r.name || r.test || r.check || r.title)) continue;
    const it = normalizeAppTest({
      ...r,
      name: clean(r.name || r.test || r.check || r.title),
      expected: str(r.expected || r.pass || r.passCriterion || r.success || ''),
      proves: str(r.proves || r.why || r.purpose || ''),
      owner: str(r.owner || r.who || r.team || ''),
      when: r.when || opts.defaultWhen || 'pre-cutover',
      onFail: r.onFail || (r.blocking === false ? 'advise' : (r.blocking ? 'block' : undefined)),
      componentId: str(r.componentId || opts.componentId || ''),
      source: str(r.source || opts.source || ''),
      serviceId: str(r.serviceId || opts.serviceId || ''),
    });
    out.push({ ...it, parseNotes: ['from the AI parse — read every row'], guessed: [] });
  }
  return out;
}

export default { parsePastedTests, normalizeParsedDrafts };
