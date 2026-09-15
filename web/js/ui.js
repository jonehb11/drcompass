// Tiny DOM + widget helpers shared by every page module.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const card = (...children) => h('div', { class: 'card' }, ...children);
export const empty = (msg) => h('div', { class: 'empty' }, msg);

export function table(headers, rows) {
  return h('table', { class: 'table' },
    h('thead', null, h('tr', null, headers.map((th) => h('th', null, th)))),
    h('tbody', null, rows));
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 3800);
}

export function modal(title, body, { wide = false, actions = [] } = {}) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back', onClick: (e) => { if (e.target === back) close(null); } });
    const close = (v) => { back.remove(); resolve(v); };
    const btns = actions.map((a) =>
      h('button', { class: `btn ${a.kind || ''}`, onClick: async () => { const v = a.onClick ? await a.onClick() : a.value; if (v !== undefined) close(v); } }, a.label));
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('h2', null, title), body,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-ghost', onClick: () => close(null) }, 'Cancel'), btns));
    back.append(box);
    document.body.append(back);
    back.close = close;
  });
}

export function confirmDialog(msg) {
  return modal('Confirm', h('p', null, msg), {
    actions: [{ label: 'Confirm', kind: 'btn-danger', value: true }],
  });
}

export function field(labelText, input) {
  return h('label', { class: 'field' }, h('span', null, labelText), input);
}

// Minimal markdown renderer — headings, lists, tables, code, bold/italic/links.
export function markdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = md.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let html = '', inCode = false, inList = false, inTable = false;
  const closeBlocks = () => { if (inList) { html += '</ul>'; inList = false; } if (inTable) { html += '</tbody></table>'; inTable = false; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) { closeBlocks(); html += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) { closeBlocks(); html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(line)) { if (inTable) closeBlocks(); if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`; continue; }
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line.trim())) continue; // separator row
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      if (!inTable) { if (inList) closeBlocks(); html += `<table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`; inTable = true; }
      else html += `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
      continue;
    }
    if (/^>\s?/.test(line)) { closeBlocks(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    closeBlocks();
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeBlocks();
  if (inCode) html += '</code></pre>';
  return h('div', { class: 'md', html });
}
