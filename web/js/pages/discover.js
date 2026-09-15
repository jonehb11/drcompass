import { h, card, badge, table, toast, markdown, field, empty } from '../ui.js';

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
`;

function keyFacts(p) {
  const bits = [];
  if (p.description) bits.push(p.description);
  if (p.replication?.mechanism && !['unknown', ''].includes(p.replication.mechanism)) bits.push(`replication: ${p.replication.mechanism}`);
  if (p.replication?.notes) bits.push(p.replication.notes);
  const s = bits.join(' · ');
  return s.length > 220 ? s.slice(0, 217) + '…' : s;
}

// Shared proposals panel: checkbox table + "Import N selected".
function proposalsPanel(proposals, { ws, api }) {
  if (!proposals.length) return card(empty('No proposals found.'));
  const checks = [];
  const importBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Import 0 selected');
  const refresh = () => {
    const n = checks.filter((c) => c.checked).length;
    importBtn.textContent = `Import ${n} selected`;
    importBtn.disabled = n === 0;
  };
  const rows = proposals.map((p) => {
    const cb = h('input', { type: 'checkbox', checked: !p.existing, style: 'width:auto', onChange: refresh });
    checks.push(cb);
    return h('tr', null,
      h('td', null, cb),
      h('td', null, h('strong', null, p.name), p.existing ? h('span', { style: 'margin-left:8px' }, badge('already in inventory', 'warn')) : null),
      h('td', null, badge(p.category)),
      h('td', { class: 'mono', style: 'font-size:12px' }, p.kind),
      h('td', { class: 'facts-cell' }, keyFacts(p)),
    );
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
      const { imported } = await api.post(`/w/${ws}/discover/aws/import`, { proposals: selected });
      toast(`Imported ${imported} component(s)`, 'ok');
      importBtn.textContent = `Imported ${imported} ✓`;
    } catch (e) {
      toast(e.message, 'err');
      importBtn.disabled = false;
      refresh();
    }
  });
  return card(
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('h2', { style: 'margin:0' }, `Proposed components (${proposals.length})`),
      h('span', { class: 'spacer' }),
      importBtn,
      h('a', { class: 'btn btn-ghost btn-sm', href: `#/${ws}/inventory` }, 'Open Inventory →')),
    h('div', { style: 'overflow-x:auto' },
      table([allBox, 'Name', 'Category', 'Kind', 'Key facts'], rows)),
    h('p', { class: 'hint', style: 'margin-top:8px' },
      'Rows already matching an inventory component (by name) start unchecked. Everything can be edited after import.'),
  );
}

function errorBadges(errors) {
  if (!errors?.length) return null;
  return h('div', { class: 'row', style: 'margin:10px 0' },
    errors.map((e) => badge(e, 'warn')));
}

function logPanel(log) {
  if (!log?.length) return null;
  return h('details', { class: 'disc-log', style: 'margin:10px 0' },
    h('summary', null, `Command log (${log.length} aws calls)`),
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

  if (!info.awsCliFound) {
    el.append(card(
      h('h2', null, 'AWS CLI not found'),
      h('p', null, 'AWS discovery shells out to your local AWS CLI v2 with your own profiles — DR Compass never sees or stores credentials.'),
      h('p', { class: 'hint' }, 'Install it, configure a profile, then reload this page:'),
      h('pre', { class: 'mono' }, 'brew install awscli\naws configure --profile my-profile'),
    ));
    return;
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
    info.profiles.length
      ? info.profiles.map((p) => h('option', { value: p }, p))
      : [h('option', { value: '' }, '(no profiles found — env credentials)')]);
  const regionInp = h('input', { value: meta.regions?.primary || 'us-east-1', placeholder: 'e.g. us-east-1' });
  const scanBtn = h('button', { class: 'btn btn-primary' }, 'Scan account');
  const results = h('div');

  scanBtn.addEventListener('click', async () => {
    if (!selected.size) { toast('Pick at least one service to scan', 'err'); return; }
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning… (read-only list/describe calls)';
    results.innerHTML = '';
    try {
      const res = await api.post(`/w/${ws}/discover/aws`, {
        profile: profileSel.value, region: regionInp.value.trim(), services: [...selected],
      });
      results.append(
        ...[errorBadges(res.errors), logPanel(res.log)].filter(Boolean),
        res.proposals.length ? proposalsPanel(res.proposals, ctx)
          : (res.errors.length ? empty('Nothing discovered — see warnings above.') : empty('Nothing discovered in this region for the selected services.')),
      );
    } catch (e) {
      results.append(card(badge(e.message, 'err')));
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan account';
    }
  });

  el.append(
    card(
      h('h2', null, 'Scan an AWS account'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Runs read-only list/describe calls through your local AWS CLI with your own credentials. No credentials are read, sent, or stored by DR Compass; the exact commands run are shown in the log. Secret values are never read — names and ARNs only.'),
      h('div', { class: 'grid cols-2' },
        field('AWS profile', profileSel),
        field('Region (primary)', regionInp)),
      h('div', null,
        h('span', { class: 'hint', style: 'font-weight:600' }, 'Services to scan'),
        h('div', { class: 'svc-chips' }, chips)),
      h('div', { class: 'row' }, scanBtn),
    ),
    results,
  );
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
    ),
    results,
  );
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
