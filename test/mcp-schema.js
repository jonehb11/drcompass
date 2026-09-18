// JSON Schema well-formedness, argument synthesis, and tool classification.
//
// WHY HAND-ROLLED
// ---------------
// No new npm dependencies, so there is no ajv here. That is fine, because the
// job is narrower than validation: `tools/list` must publish a schema that a
// CLIENT can use, and the failure mode that matters is a schema that LOOKS
// present and is not usable — `required: ["slug"]` with no `slug` in
// `properties`, `type: "str"`, `items` on an object, a `$ref` pointing at a
// definition that does not exist. A model reading such a schema will guess, and
// a guessing model calling a DR tool is exactly what this harness exists to
// catch. `checkJsonSchema` looks for those, recursively, and says where.
//
// The synthesis half (`sampleArgs`, `wrongTypeArgs`) exists so the adversarial
// suite can drive EVERY tool the server publishes, including ones invented
// after this file was written, rather than the handful whose names a human
// happened to recognise. A read-sounding name is not proof of anything.

const SIMPLE_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Recursively check that `schema` is a usable JSON Schema.
 * Returns an array of human-readable problems ([] means clean).
 */
export function checkJsonSchema(schema, where = 'inputSchema', root = schema, seen = new Set()) {
  const problems = [];
  const P = (msg) => problems.push(`${where}: ${msg}`);

  if (schema === true || schema === false) return problems; // boolean schemas are legal
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    P(`is not a schema object (got ${Array.isArray(schema) ? 'array' : typeof schema})`);
    return problems;
  }
  if (seen.has(schema)) return problems;
  seen.add(schema);

  if ('$ref' in schema) {
    const ref = schema.$ref;
    if (typeof ref !== 'string') P('$ref is not a string');
    else if (!ref.startsWith('#')) P(`$ref "${ref}" points outside the document — a client cannot resolve it`);
    else {
      const seg = ref.slice(1).split('/').filter(Boolean).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      let node = root;
      for (const s of seg) {
        node = node && typeof node === 'object' ? node[s] : undefined;
        if (node === undefined) break;
      }
      if (node === undefined) P(`$ref "${ref}" does not resolve inside this schema`);
    }
  }

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length) P('type is an empty array');
    for (const t of types) {
      if (typeof t !== 'string') P(`type contains a non-string (${JSON.stringify(t)})`);
      else if (!SIMPLE_TYPES.has(t)) P(`type "${t}" is not a JSON Schema type`);
    }
  }

  if ('properties' in schema) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      P('properties is not an object');
    } else {
      for (const [k, v] of Object.entries(schema.properties)) {
        problems.push(...checkJsonSchema(v, `${where}.properties.${k}`, root, seen));
      }
    }
  }

  if ('required' in schema) {
    if (!Array.isArray(schema.required)) P('required is not an array');
    else {
      const bad = schema.required.filter((r) => typeof r !== 'string');
      if (bad.length) P(`required contains non-strings: ${JSON.stringify(bad)}`);
      if (new Set(schema.required).size !== schema.required.length) P('required has duplicate entries');
      const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
      const composed = ['anyOf', 'oneOf', 'allOf', '$ref'].some((k) => k in schema);
      if (props && !composed) {
        const missing = schema.required.filter((r) => typeof r === 'string' && !(r in props));
        if (missing.length) {
          P(`required names ${missing.map((m) => `"${m}"`).join(', ')} but properties does not describe ${missing.length > 1 ? 'them' : 'it'} — a client cannot know what to send`);
        }
      }
    }
  }

  if ('items' in schema) {
    if (Array.isArray(schema.items)) schema.items.forEach((s, i) => problems.push(...checkJsonSchema(s, `${where}.items[${i}]`, root, seen)));
    else problems.push(...checkJsonSchema(schema.items, `${where}.items`, root, seen));
  }
  if ('additionalProperties' in schema && typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    problems.push(...checkJsonSchema(schema.additionalProperties, `${where}.additionalProperties`, root, seen));
  }
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    if (k in schema) {
      if (!Array.isArray(schema[k]) || !schema[k].length) P(`${k} is not a non-empty array`);
      else schema[k].forEach((s, i) => problems.push(...checkJsonSchema(s, `${where}.${k}[${i}]`, root, seen)));
    }
  }
  if ('not' in schema) problems.push(...checkJsonSchema(schema.not, `${where}.not`, root, seen));
  for (const k of ['$defs', 'definitions']) {
    if (k in schema && schema[k] && typeof schema[k] === 'object') {
      for (const [n, v] of Object.entries(schema[k])) problems.push(...checkJsonSchema(v, `${where}.${k}.${n}`, root, seen));
    }
  }

  if ('enum' in schema && (!Array.isArray(schema.enum) || !schema.enum.length)) P('enum is not a non-empty array');
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'multipleOf']) {
    if (k in schema && typeof schema[k] !== 'number') P(`${k} is not a number`);
  }
  if (typeof schema.multipleOf === 'number' && schema.multipleOf <= 0) P('multipleOf must be > 0');
  if (typeof schema.minLength === 'number' && typeof schema.maxLength === 'number' && schema.minLength > schema.maxLength) P('minLength > maxLength — nothing can satisfy it');
  if (typeof schema.minItems === 'number' && typeof schema.maxItems === 'number' && schema.minItems > schema.maxItems) P('minItems > maxItems — nothing can satisfy it');
  if ('description' in schema && typeof schema.description !== 'string') P('description is not a string');
  if ('pattern' in schema) {
    if (typeof schema.pattern !== 'string') P('pattern is not a string');
    else { try { new RegExp(schema.pattern); } catch (e) { P(`pattern is not a valid regex: ${e.message}`); } }
  }

  return problems;
}

/* ========================================================================
 * Argument synthesis
 * ======================================================================*/

// Values that make a call MEAN something against the seeded workspace, keyed by
// what the property is called. Without these a synthesised call is a 404 and
// proves nothing about the code path behind the tool.
const NAME_HINTS = [
  [/^(ws|slug|workspace|workspaceSlug|workspaceId)$/i, (ctx) => ctx.slug],
  [/(workspace|^ws$)/i, (ctx) => ctx.slug],
  [/^collection$/i, (ctx) => ctx.collection || 'tests'],
  [/^(componentId|component)$/i, (ctx) => ctx.componentId],
  [/^(testId)$/i, (ctx) => ctx.testId],
  [/^(documentId|docId)$/i, (ctx) => ctx.documentId],
  [/^(serviceId|service)$/i, (ctx) => ctx.serviceId],
  [/^id$/i, (ctx) => ctx.testId],
  [/^(op|operation|action)$/i, () => 'update'],
  [/^(name|title)$/i, () => 'harness probe'],
  [/^(text|body|content|instruction|prompt|question|query|notes?)$/i, () => 'What does this workspace say about recovery?'],
  [/^(kind|type)$/i, () => undefined], // let the enum decide
  [/(limit|count|max|page[Ss]ize)/i, () => 3],
  [/^(confirm|force|dryRun|preview)$/i, () => false],
];

function hintFor(key, ctx) {
  for (const [re, f] of NAME_HINTS) {
    if (re.test(key)) {
      const v = f(ctx);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function scalarFor(schema, key, ctx) {
  if (!schema || typeof schema !== 'object') return 'x';
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const hint = key ? hintFor(key, ctx) : undefined;
    if (hint !== undefined && schema.enum.includes(hint)) return hint;
    return schema.enum[0];
  }
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  const t = types[0];
  const hint = key ? hintFor(key, ctx) : undefined;
  if (hint !== undefined && (!t || typeof hint === t || (t === 'integer' && Number.isInteger(hint)))) return hint;
  switch (t) {
    case 'string': {
      const min = typeof schema.minLength === 'number' ? schema.minLength : 1;
      return 'x'.repeat(Math.max(1, min));
    }
    case 'number': case 'integer': {
      if (typeof schema.minimum === 'number') return schema.minimum;
      return t === 'integer' ? 1 : 1;
    }
    case 'boolean': return false;
    case 'null': return null;
    case 'array': {
      const n = typeof schema.minItems === 'number' ? schema.minItems : 0;
      const item = schema.items && !Array.isArray(schema.items) ? schema.items : { type: 'string' };
      return Array.from({ length: n }, () => scalarFor(item, key, ctx));
    }
    case 'object': return sampleArgs(schema, ctx);
    default:
      return hint !== undefined ? hint : 'x';
  }
}

/**
 * The smallest argument object that satisfies a tool's inputSchema, filled with
 * values that actually exist in the seeded workspace where the property name
 * says what it wants.
 */
export function sampleArgs(schema, ctx = {}, { includeOptional = false } = {}) {
  if (!schema || typeof schema !== 'object') return {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
  const out = {};
  const keys = includeOptional ? Object.keys(props) : required;
  for (const k of keys) {
    const sub = props[k];
    out[k] = sub === undefined ? (hintFor(k, ctx) ?? 'x') : scalarFor(sub, k, ctx);
  }
  return out;
}

/** The same object with exactly one property replaced by a value of the wrong type. */
export function wrongTypeArgs(schema, ctx = {}) {
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required.filter((r) => typeof r === 'string') : [];
  const base = sampleArgs(schema, ctx);
  const target = required.find((r) => props[r]) || Object.keys(props)[0];
  if (!target) return null;
  const t = Array.isArray(props[target]?.type) ? props[target].type[0] : props[target]?.type;
  const wrong = (t === 'string' || t === undefined) ? 12345
    : (t === 'number' || t === 'integer') ? 'not-a-number'
    : (t === 'boolean') ? 'yes'
    : (t === 'array') ? { nope: true }
    : (t === 'object') ? ['nope'] : 12345;
  return { args: { ...base, [target]: wrong }, property: target, declared: t ?? '(none)', sent: wrong };
}

/** Drop one required property, so the call is definitively incomplete. */
export function missingRequiredArgs(schema, ctx = {}) {
  const required = Array.isArray(schema?.required) ? schema.required.filter((r) => typeof r === 'string') : [];
  if (!required.length) return null;
  const base = sampleArgs(schema, ctx);
  const dropped = required[0];
  const args = { ...base };
  delete args[dropped];
  return { args, dropped };
}

/* ========================================================================
 * Tool classification
 * ======================================================================*/

// A name is a claim, not evidence — every one of these buckets is used only to
// ORDER the work (which tool to try first), never to excuse skipping a tool.
// The no-writes suite calls all of them regardless.
const MUTATING_NAME = /(create|update|add|set|write|delete|remove|destroy|patch|edit|apply|record|save|import|ingest|upload|new|rename|move|merge|split|assign|approve|mark|complete|reset|seed|init|generate|export|draft|propose|suggest|run|scan|discover|refresh|sync|fetch|invoke|execute)/i;
const SCAN_NAME = /(scan|discover|aws|k8s|kube|cluster|cloud|inventory_?import|arpio|enrich|probe|connect)/i;
const AI_NAME = /(ai|ask|chat|converse|propose|suggest|draft|narrative|review|copilot|assistant|correlate|recommend)/i;
const EXPORT_NAME = /(export|workbook|xlsx|csv|brief|report|package|summary|render|diagram)/i;

const OBJECT_ARG_SLOTS = ['data', 'patch', 'fields', 'updates', 'update', 'item', 'values', 'body', 'payload', 'changes', 'attributes', 'props'];

export function classifyTool(tool) {
  const name = String(tool?.name || '');
  const schema = tool?.inputSchema || {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props);
  const objectSlots = keys.filter((k) => OBJECT_ARG_SLOTS.includes(k.toLowerCase())
    || (props[k] && (props[k].type === 'object' || (Array.isArray(props[k].type) && props[k].type.includes('object')))));
  const blob = `${name} ${String(tool?.description || '')} ${JSON.stringify(schema)}`;
  const annotations = tool?.annotations || {};
  return {
    name,
    schema,
    keys,
    annotations,
    // The server's OWN admission that this tool is not read-only. Used to make
    // sure the attack pool always contains every door the server itself says it
    // has, regardless of what the name sounds like — a heuristic that happens
    // to miss the one real write tool would make every attack "BLOCKED" by
    // never reaching it.
    selfDeclaredWriter: annotations.readOnlyHint !== true,
    objectSlots,
    looksMutating: MUTATING_NAME.test(name) || objectSlots.length > 0,
    looksScanning: SCAN_NAME.test(name) || SCAN_NAME.test(String(tool?.description || '')),
    looksAi: AI_NAME.test(name),
    looksExporting: EXPORT_NAME.test(name),
    touchesTests: /test/i.test(blob),
    touchesObjectives: /objectiv|rto|rpo|rta|rpa|approv/i.test(blob),
    hasPathish: keys.filter((k) => /(path|file|dir|out|dest|target|slug|workspace|id$|Id$)/i.test(k)),
  };
}

export function classifyTools(tools) {
  return (tools || []).map(classifyTool);
}

/* ========================================================================
 * Reading a tools/call result
 * ======================================================================*/

/** Flatten every scrap of text an MCP tool result can carry. */
export function resultText(msg) {
  if (!msg) return '';
  const bits = [];
  if (msg.error) bits.push(JSON.stringify(msg.error));
  const r = msg.result;
  if (r) {
    if (Array.isArray(r.content)) {
      for (const c of r.content) {
        if (!c || typeof c !== 'object') { bits.push(String(c)); continue; }
        if (typeof c.text === 'string') bits.push(c.text);
        else bits.push(JSON.stringify(c));
      }
    }
    if (r.structuredContent !== undefined) bits.push(JSON.stringify(r.structuredContent));
    if (!Array.isArray(r.content) && r.structuredContent === undefined) bits.push(JSON.stringify(r));
  }
  return bits.join('\n');
}

/** Did this call fail — either as a JSON-RPC error or as a tool-level error? */
export function isFailure(msg) {
  if (!msg) return false;
  if (msg.error) return true;
  if (msg.result && msg.result.isError === true) return true;
  return false;
}

/** Is the reply shaped like a tools/call result at all? */
export function checkToolResultShape(msg, where = 'tools/call') {
  const problems = [];
  if (!msg || msg.jsonrpc !== '2.0') { problems.push(`${where}: reply is not a JSON-RPC 2.0 message`); return problems; }
  if (msg.error) {
    const e = msg.error;
    if (typeof e.code !== 'number') problems.push(`${where}: error.code is not a number`);
    if (typeof e.message !== 'string' || !e.message) problems.push(`${where}: error.message is missing`);
    return problems;
  }
  const r = msg.result;
  if (!r || typeof r !== 'object') { problems.push(`${where}: result is not an object`); return problems; }
  if (!Array.isArray(r.content)) {
    problems.push(`${where}: result.content is not an array (MCP requires a content array on every tools/call result)`);
    return problems;
  }
  r.content.forEach((c, i) => {
    if (!c || typeof c !== 'object') { problems.push(`${where}: content[${i}] is not an object`); return; }
    if (typeof c.type !== 'string') { problems.push(`${where}: content[${i}].type is missing`); return; }
    if (c.type === 'text' && typeof c.text !== 'string') problems.push(`${where}: content[${i}] is type "text" with no text`);
    if (c.type === 'image' && (typeof c.data !== 'string' || typeof c.mimeType !== 'string')) problems.push(`${where}: content[${i}] is type "image" without data+mimeType`);
    if (c.type === 'resource' && (!c.resource || typeof c.resource !== 'object')) problems.push(`${where}: content[${i}] is type "resource" without a resource`);
  });
  if ('isError' in r && typeof r.isError !== 'boolean') problems.push(`${where}: result.isError is not a boolean`);
  return problems;
}
