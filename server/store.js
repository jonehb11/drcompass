// Workspace storage: plain JSON files under ~/.drcompass/workspaces/<slug>/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `services` and `documents` are v0.7 additions (docs/ENV-SERVICE-MODEL.md).
// Both are additive: a workspace created before they existed simply has no
// services.json / documents.json, and `getCollection` falls back to an empty
// list, so it behaves exactly as it did.
//
// NOTE for anyone writing services: the generic `/w/:ws/c/services` routes in
// routes/collections.js do NOT keep `component.serviceId` and
// `service.componentIds` in step. Membership writes must go through
// routes/services.js, which owns that consistency.
export const COLLECTIONS = ['components', 'runbooks', 'tests', 'checklists', 'gaps', 'decisions', 'contacts', 'services', 'documents'];

export function homeDir() {
  return process.env.DRCOMPASS_HOME || path.join(os.homedir(), '.drcompass');
}
export function wsRoot() {
  return path.join(homeDir(), 'workspaces');
}
function wsDir(slug) {
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(slug)) throw httpError(400, `invalid workspace slug: ${slug}`);
  return path.join(wsRoot(), slug);
}
export function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export function listWorkspaces() {
  const root = wsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'workspace.json')))
    .map((d) => {
      const meta = readJson(path.join(root, d, 'workspace.json'), {});
      return { slug: d, name: meta.name || d, updatedAt: meta.updatedAt || null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createWorkspace(slug, meta = {}) {
  const dir = wsDir(slug);
  if (fs.existsSync(path.join(dir, 'workspace.json'))) throw httpError(409, `workspace '${slug}' already exists`);
  const now = new Date().toISOString();
  const ws = {
    slug, name: meta.name || slug, org: meta.org || '', description: meta.description || '',
    regions: meta.regions || { primary: 'us-east-1', recovery: 'us-west-2' },
    objectives: meta.objectives || { rtoMinutes: null, rpoMinutes: null, rtaMinutes: null, rpaMinutes: null, approved: false, notes: '' },
    strategy: meta.strategy || 'pilot-light',
    tooling: meta.tooling || [],
    createdAt: now, updatedAt: now,
  };
  writeJson(path.join(dir, 'workspace.json'), ws);
  for (const c of COLLECTIONS) writeJson(path.join(dir, `${c}.json`), { items: [] });
  writeJson(path.join(dir, 'assessment.json'), { answers: {}, completedAt: null });
  return ws;
}

export function deleteWorkspace(slug) {
  const dir = wsDir(slug);
  if (!fs.existsSync(dir)) throw httpError(404, `no workspace '${slug}'`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function getWorkspace(slug) {
  const meta = readJson(path.join(wsDir(slug), 'workspace.json'), null);
  if (!meta) throw httpError(404, `no workspace '${slug}'`);
  return meta;
}
export function saveWorkspace(slug, meta) {
  const cur = getWorkspace(slug);
  const merged = { ...cur, ...meta, slug, updatedAt: new Date().toISOString() };
  writeJson(path.join(wsDir(slug), 'workspace.json'), merged);
  return merged;
}

export function getCollection(slug, name) {
  if (!COLLECTIONS.includes(name)) throw httpError(404, `unknown collection '${name}'`);
  getWorkspace(slug); // 404 if missing
  return readJson(path.join(wsDir(slug), `${name}.json`), { items: [] }).items || [];
}
export function saveCollection(slug, name, items) {
  if (!COLLECTIONS.includes(name)) throw httpError(404, `unknown collection '${name}'`);
  writeJson(path.join(wsDir(slug), `${name}.json`), { items });
  saveWorkspace(slug, {});
}

export function getObject(slug, name) {
  getWorkspace(slug);
  return readJson(path.join(wsDir(slug), `${name}.json`), {});
}
export function saveObject(slug, name, obj) {
  writeJson(path.join(wsDir(slug), `${name}.json`), obj);
  saveWorkspace(slug, {});
}

// First-run: copy the bundled example workspace so the UI is never empty.
export function seedExample() {
  const seedDir = path.join(__dirname, 'data', 'seed');
  const target = path.join(wsRoot(), 'example-acme');
  if (fs.existsSync(path.join(target, 'workspace.json'))) return;
  if (!fs.existsSync(path.join(seedDir, 'workspace.json'))) return;
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(seedDir)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(seedDir, f), path.join(target, f));
  }
}
