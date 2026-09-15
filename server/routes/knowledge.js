import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KDIR = path.join(__dirname, '..', 'data', 'knowledge');

const r = Router();

function articles() {
  if (!fs.existsSync(KDIR)) return [];
  return fs.readdirSync(KDIR).filter((f) => f.endsWith('.md')).map((f) => {
    const id = f.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(KDIR, f), 'utf8');
    // Front matter: first line `# Title`, optional `<!-- section: x | order: n -->`
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || id;
    const section = (text.match(/section:\s*([\w -]+)/) || [])[1]?.trim() || 'General';
    const order = Number((text.match(/order:\s*(\d+)/) || [])[1] || 999);
    return { id, title, section, order };
  }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

r.get('/', (req, res) => res.json(articles()));

r.get('/:id', (req, res) => {
  const id = req.params.id.replace(/[^\w-]/g, '');
  const file = path.join(KDIR, `${id}.md`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: `no article '${id}'` });
  const markdown = fs.readFileSync(file, 'utf8');
  const title = (markdown.match(/^#\s+(.+)$/m) || [])[1] || id;
  res.json({ id, title, markdown });
});

export default r;
