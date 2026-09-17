// Maturity assessment: questions, stored answers, computed report blended
// with live workspace signals.
import { Router } from 'express';
import * as store from '../store.js';
// Signals must not claim an achievement a test never produced.
// Contract: docs/measured-numbers.md
import { measuredNumbers, staleAfterDaysFor } from '../lib/measured.js';
// Environment / service scoping — docs/ENV-SERVICE-MODEL.md §3, §7. A scoped
// assessment scores the components IN SCOPE and says so.
import {
  scopeFromQuery, resolveScopeOrThrow, scopeCollection, scopeMeta, describeScope,
} from '../lib/scope.js';

export const PILLARS = [
  { id: 'inventory', name: 'Inventory & scope' },
  { id: 'data', name: 'Data & secrets' },
  { id: 'runbooks', name: 'Runbooks' },
  { id: 'testing', name: 'Testing' },
  { id: 'observability', name: 'Observability' },
  { id: 'governance', name: 'Governance' },
];

export const LEVEL_LABELS = ['None', 'Backups only', 'Documented plan', 'Tested once', 'Repeatable test loop', 'Production-proven'];

// 21 questions. levels[i] describes what answer i (0–4) means. Question ids are
// STABLE — stored answers are keyed by them, so ids are added, never renamed or
// removed. Pillars do not all carry the same count, which is fine: the overall
// score is the mean of the pillar percentages.
export const QUESTIONS = [
  // ---- inventory ----
  {
    id: 'inv-coverage', pillar: 'inventory',
    text: 'How complete is your inventory of what must come back after a disaster?',
    help: 'You cannot recover what you have not written down. The inventory is the seed of every diagram, runbook, and test.',
    levels: [
      'No inventory exists',
      'A partial list lives in heads or scattered docs',
      'Most components are listed in one place',
      'Complete inventory with owners and tiers',
      'Complete, reviewed on a cadence, tied to IaC',
    ],
  },
  {
    id: 'inv-dependencies', pillar: 'inventory',
    text: 'Are dependencies between components mapped?',
    help: 'Restore order comes from the dependency graph: apps need data, data needs keys, everything needs the network.',
    levels: [
      'Unknown — we would discover them during an outage',
      'Known informally by senior engineers',
      'Mapped for the critical path only',
      'Mapped for all Tier 0/1 components',
      'Fully mapped and verified during tests',
    ],
  },
  {
    id: 'inv-capacity', pillar: 'inventory',
    text: 'Do you know the recovery region will actually sell you the compute you need?',
    help: 'Pilot light and warm standby both assume the recovery region has capacity for full production load — at the moment every other tenant in that region is asking for it too. Quotas are per-region, per-account, and instance types are not offered in every AZ. This is the most likely single cause of a failed pilot-light recovery in a real regional event.',
    levels: [
      'Never considered — we assume the capacity is there',
      'We know quotas exist but have never looked at the recovery region',
      'Quotas reviewed once against standby size, not full production load',
      'Quotas and instance-type availability verified against FULL production load in the recovery region',
      'Verified on a cadence, with capacity reservations for Tier-0 and a scale-up rehearsed in a test',
    ],
  },
  {
    id: 'inv-thirdparty', pillar: 'inventory',
    text: 'Do you know every outbound call to third parties, SaaS, and other systems?',
    help: 'Partner allowlists, static egress IPs, and SFTP endpoints fail silently after failover unless they are inventoried and pre-arranged.',
    levels: [
      'No idea what we call externally',
      'The big ones are known, none documented',
      'Documented for critical services',
      'Documented with failover behavior per call',
      'Documented, and recovery-region access pre-arranged with partners',
    ],
  },
  // ---- data ----
  {
    id: 'data-replication', pillar: 'data',
    text: 'Is every data store backed up or replicated to the recovery region?',
    help: 'Databases, object storage, queues, caches — each needs an explicit mechanism, even if the answer is "rebuild cold".',
    levels: [
      'No cross-region copies at all',
      'Some backups exist, coverage unknown',
      'All critical stores have backups or replication',
      'Every store has a mechanism with a stated RPO',
      'Replication is monitored and recovery points align across stores',
    ],
  },
  {
    id: 'data-rpo', pillar: 'data',
    text: 'Do you know your real RPO — how much data you would actually lose?',
    help: 'Configured snapshot frequency is not achieved RPO. Only a restore test tells you the real recovery point.',
    levels: [
      'Never thought about it',
      'A target number exists on paper',
      'Target set per data store',
      'Measured once in a real restore (RPA)',
      'Measured every test and within target',
    ],
  },
  {
    id: 'data-secrets', pillar: 'data',
    text: 'Are secrets and encryption keys available in the recovery region?',
    help: 'Missing secrets are the most common cause of failed recovery tests. Apps that boot via secrets-init die instantly without them. KMS keys must be multi-region or restores need re-encryption.',
    levels: [
      'Secrets exist only in the primary region',
      'Some secrets replicated, no list',
      'A replication list exists but is unverified',
      'One reconciled, signed-off secret list, replicated',
      'Verified every test: every logical name resolves in recovery',
    ],
  },
  // ---- runbooks ----
  {
    id: 'rbk-exists', pillar: 'runbooks',
    text: 'Does a written recovery runbook exist?',
    help: 'A runbook turns tribal knowledge into an ordered, layer-by-layer procedure anyone on the on-call rotation can execute.',
    levels: [
      'Nothing written down',
      'Scattered notes and wiki fragments',
      'One document covers the main scenario',
      'Ordered, layered runbook with owners per step',
      'Runbooks per scenario, kept current after every test',
    ],
  },
  {
    id: 'rbk-verification', pillar: 'runbooks',
    text: 'Does each runbook step have a verification and a pass criterion?',
    help: 'A layer you can’t verify is a layer you can’t gate. "Run this, then check that, expect X" — otherwise you advance on hope.',
    levels: [
      'No runbook / no checks',
      'Steps only — you eyeball whether it worked',
      'Some steps have checks',
      'Every gate step has a command and a pass bar',
      'Checks are scripted and their outputs recorded per test',
    ],
  },
  {
    id: 'rbk-roles', pillar: 'runbooks',
    text: 'Are roles, escalation, and rollback defined for a recovery event?',
    help: 'Who declares the disaster? Who flips DNS? Who calls the partner? What if recovery itself fails halfway?',
    levels: [
      'Undefined — we would improvise',
      'A few people know their part',
      'Roles named for the main scenario',
      'Roles, contacts, and rollback documented',
      'Practiced: people have executed their role in an exercise',
    ],
  },
  {
    id: 'rbk-failback', pillar: 'runbooks',
    text: 'Do you have a tested plan for getting BACK to the primary region?',
    help: 'Untested failback means your recovery is a one-way door. Failing back is a SECOND failover with the same risks — and worse in places: DRS reverse replication overwrites the original volumes, Aurora failback is another switchover, and every write taken while you were in the recovery region has to come home.',
    levels: [
      'Never discussed — we would work it out afterwards',
      'We assume we would just reverse the steps',
      'A written failback plan exists, never executed',
      'Failback is a full runbook with its own gates, approval and data-reconciliation step',
      'Failback has been executed end-to-end in a test, with the return data path verified',
    ],
  },
  {
    id: 'rbk-controlplane', pillar: 'runbooks',
    text: 'Could you execute the failover with the primary region — and your SSO — dark?',
    help: 'The event-day action should be data-plane only. If the runbook needs a console login through an IdP in the failed region, a CI pipeline whose runners live there, or a Route 53 record edit (a single-region control plane), then the outage owns your recovery path too.',
    levels: [
      'Unknown — we have never traced what the failover path depends on',
      'We know some steps need the primary region and have no alternative',
      'Break-glass credentials exist but have never been used in an exercise',
      'The failover path is data-plane only, with break-glass access independent of the primary region',
      'Proven in an exercise executed without the primary region or the normal identity provider',
    ],
  },
  // ---- testing ----
  {
    id: 'tst-frequency', pillar: 'testing',
    text: 'How often do you actually test recovery?',
    help: 'An untested DR plan is a hypothesis. The gap between "should work" and "works" only closes by running it.',
    levels: [
      'Never tested',
      'Tested once, long ago',
      'Tested within the last year',
      'Tested quarterly or after major changes',
      'Continuous: scheduled tests plus game days',
    ],
  },
  {
    id: 'tst-successbar', pillar: 'testing',
    text: 'Do tests prove a real business transaction end-to-end?',
    help: 'Pods "Running" is not recovery. The success bar is functional: a claim answered, an order placed, a payment settled — through the recovered stack.',
    levels: [
      'No tests',
      'We check that infrastructure comes up',
      'Smoke tests hit health endpoints',
      'A defined business transaction must succeed',
      'Full functional suite runs against the recovered environment',
    ],
  },
  {
    id: 'tst-measured', pillar: 'testing',
    text: 'Do you measure RTA/RPA and compare them to your targets?',
    help: 'Timestamps during the test (T0, first access, success bar green) turn a test into evidence: achieved recovery time and achieved recovery point.',
    levels: [
      'Nothing measured',
      'Rough sense of how long it took',
      'Duration recorded, not compared to target',
      'RTA/RPA recorded and compared each test',
      'Trend tracked; gaps drive the improvement backlog',
    ],
  },
  // ---- observability ----
  {
    id: 'obs-recovery-region', pillar: 'observability',
    text: 'Will monitoring and dashboards exist in the recovery region?',
    help: 'If observability lives only in the primary region, you will fly blind exactly when you need instruments most.',
    levels: [
      'Monitoring is single-region only',
      'Some logs would survive, no dashboards',
      'Core metrics available after manual setup',
      'Dashboards and alerting recover with the platform',
      'Dual-region observability, verified during tests',
    ],
  },
  {
    id: 'obs-readiness', pillar: 'observability',
    text: 'Can you see DR readiness on a normal day?',
    help: 'Backups green? Replication lag in bounds? Last recovery point aligned? Readiness should be a dashboard, not an investigation.',
    levels: [
      'No visibility into readiness',
      'We could assemble the picture by hand',
      'Backup/replication jobs are individually checkable',
      'A readiness dashboard shows the key signals',
      'Readiness is alerted on and reviewed on a cadence',
    ],
  },
  {
    id: 'obs-drift', pillar: 'observability',
    text: 'Would you notice if replication broke or scope drifted?',
    help: 'A new database that never entered recovery scope, a snapshot job silently failing for weeks — drift is how green plans rot.',
    levels: [
      'Only a real disaster would reveal it',
      'We might notice during unrelated work',
      'Periodic manual review catches most drift',
      'Alerts fire on replication/backup failure',
      'Alerts plus automated scope reconciliation against inventory',
    ],
  },
  // ---- governance ----
  {
    id: 'gov-objectives', pillar: 'governance',
    text: 'Has the business signed off on RTO and RPO?',
    help: 'Engineering can propose numbers, but recovery objectives are business decisions about acceptable loss — they need an owner and a signature.',
    levels: [
      'No targets exist',
      'Engineering has informal targets',
      'Targets written down, not approved',
      'RTO/RPO formally approved by the business',
      'Approved, reviewed annually, backed by test evidence',
    ],
  },
  {
    id: 'gov-ownership', pillar: 'governance',
    text: 'Does the DR program have an owner and a cadence?',
    help: 'DR without an owner decays. Someone must run the loop: test, find gaps, fix, retest — with time and budget to do it.',
    levels: [
      'Nobody owns DR',
      'Owned informally, best-effort',
      'Named owner, no regular cadence',
      'Owner plus a recurring program cadence',
      'Funded program with executive sponsorship',
    ],
  },
  {
    id: 'gov-gaps', pillar: 'governance',
    text: 'Are gaps and decisions tracked to closure?',
    help: 'Every test produces findings. A blocker found and forgotten is worse than one never found — you knew, and it still bit you.',
    levels: [
      'Findings evaporate after each incident/test',
      'Gaps live in people’s memories',
      'Gaps listed somewhere central',
      'Gaps tracked with severity, owner, and status',
      'Blockers gate go-live decisions; closure is reviewed',
    ],
  },
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function getAssessment(ws) {
  const obj = store.getObject(ws, 'assessment');
  return { answers: obj.answers || {}, completedAt: obj.completedAt || null };
}

function safeCollection(ws, name) {
  try { return store.getCollection(ws, name) || []; } catch { return []; }
}

export function computeReport(ws, query = {}) {
  const { answers } = getAssessment(ws);
  const meta = store.getWorkspace(ws);
  const allComponents = safeCollection(ws, 'components');
  // §3. The ANSWERS are workspace-wide — a maturity questionnaire is answered
  // once for the programme, not once per environment — but every LIVE SIGNAL
  // and every evidence cap below is read off the inventory, and "62% of
  // components have a verification command" is a different (and more useful)
  // number for production than for all three environments averaged together.
  // So with a scope, the signals, the caps and the next actions are computed
  // from the components, gaps, tests and runbooks IN SCOPE, and the report says
  // which ones those were. With no scope, `scopeCollection` hands back the same
  // array it was given and this is the report it always was.
  const scope = (() => {
    const wanted = scopeFromQuery(query);
    if (!wanted.envId && !wanted.serviceId) return null;
    return resolveScopeOrThrow(ws, wanted, { workspace: meta, components: allComponents });
  })();
  const components = scopeCollection('components', allComponents, scope, allComponents);
  const gaps = scopeCollection('gaps', safeCollection(ws, 'gaps'), scope, allComponents);
  const tests = scopeCollection('tests', safeCollection(ws, 'tests'), scope, allComponents);
  const runbooks = scopeCollection('runbooks', safeCollection(ws, 'runbooks'), scope, allComponents);

  // ---- pillar scores (0–100) ----
  // Divided by questionCount, NOT answeredCount (audit A-1). Scoring only the
  // questions someone chose to answer made unanswered questions free: answering
  // the single best question in each pillar produced six 100% pillars and a raw
  // level 5. An unanswered question is not a neutral abstention — it is an
  // unknown, and an unknown is not maturity.
  const pillars = PILLARS.map((p) => {
    const qs = QUESTIONS.filter((q) => q.pillar === p.id);
    const answered = qs.filter((q) => Number.isInteger(answers[q.id]));
    const sum = answered.reduce((a, q) => a + clamp(answers[q.id], 0, 4), 0);
    const score = qs.length ? Math.round((sum / (qs.length * 4)) * 100) : 0;
    const answeredScore = answered.length ? Math.round((sum / (answered.length * 4)) * 100) : 0;
    return {
      id: p.id, name: p.name, score, answeredCount: answered.length, questionCount: qs.length,
      // What the pillar would score if the unanswered questions were as good as
      // the answered ones — shown as the ceiling, never as the score.
      answeredScore,
    };
  });
  const answeredTotal = pillars.reduce((a, p) => a + p.answeredCount, 0);
  const overall = Math.round(pillars.reduce((a, p) => a + p.score, 0) / pillars.length);
  const completeness = QUESTIONS.length ? Math.round((answeredTotal / QUESTIONS.length) * 100) : 0;
  const incomplete = completeness < 80;

  // ---- live signals from workspace data ----
  const withDeps = components.filter((c) => Array.isArray(c.dependsOn) && c.dependsOn.length > 0);
  const withVerify = components.filter((c) => c.verification && c.verification.command);
  const pct = (n) => (components.length ? Math.round((n / components.length) * 100) : 0);
  const openBlockers = gaps.filter((g) => g.severity === 'blocker' && g.status !== 'resolved' && g.status !== 'accepted');
  const componentGapNotes = components.reduce((a, c) => a + (Array.isArray(c.gaps) ? c.gaps.length : 0), 0);
  const passedTests = tests.filter((t) => t.status === 'passed');
  const staleAfterDays = staleAfterDaysFor(meta);
  const freshCutoff = Date.now() - staleAfterDays * 86400000;
  const isRecent = (t) => {
    const d = t.date ? new Date(t.date) : null;
    return !d || Number.isNaN(d.getTime()) ? false : d.getTime() >= freshCutoff;
  };
  const recentPassed = passedTests.filter(isRecent);
  const gameDayPassed = recentPassed.some((t) => t.type === 'game-day');
  const obj = meta.objectives || {};
  const rtoSet = obj.rtoMinutes !== null && obj.rtoMinutes !== undefined;

  const signals = [];
  signals.push({
    label: 'Components inventoried', value: String(components.length),
    kind: components.length === 0 ? 'err' : components.length < 5 ? 'warn' : 'ok',
  });
  if (components.length) {
    signals.push({
      label: 'Dependencies mapped', value: `${pct(withDeps.length)}%`,
      kind: pct(withDeps.length) >= 60 ? 'ok' : pct(withDeps.length) >= 30 ? 'warn' : 'err',
    });
    signals.push({
      label: 'Verification defined', value: `${pct(withVerify.length)}%`,
      kind: pct(withVerify.length) >= 60 ? 'ok' : pct(withVerify.length) >= 30 ? 'warn' : 'err',
    });
  }
  signals.push({
    label: 'Open blocker gaps', value: String(openBlockers.length),
    kind: openBlockers.length ? 'err' : 'ok',
  });
  if (componentGapNotes) {
    signals.push({ label: 'Gap notes on components', value: String(componentGapNotes), kind: 'warn' });
  }
  signals.push({
    label: 'Runbooks written', value: String(runbooks.length),
    kind: runbooks.length ? 'ok' : 'warn',
  });
  signals.push({
    label: 'Tests passed', value: String(passedTests.length),
    kind: passedTests.length ? 'ok' : 'warn',
  });
  signals.push({
    label: 'RTO target', value: rtoSet ? `${obj.rtoMinutes} min${obj.approved ? ' · approved' : ' · not approved'}` : 'not set',
    kind: !rtoSet ? 'err' : obj.approved ? 'ok' : 'warn',
  });
  // The ONE signal in this list that makes a claim about achievement. It used
  // to read `objectives.rtaMinutes` — a free number field in Settings — and
  // colour it green against the target (audit A-3). It now comes from the same
  // helper everything else does, and says "unmeasured" when it is.
  const numbers = measuredNumbers(meta, tests, null, { components, staleAfterDays });
  if (numbers.rta.state === 'measured') {
    signals.push({
      label: `Measured RTA${numbers.rta.stale ? ' (stale)' : ''}`,
      value: `${numbers.rta.minutes} min vs ${obj.rtoMinutes ?? '—'} target · ${numbers.rta.test.name}`,
      kind: numbers.rta.stale ? 'warn' : (numbers.verdict.rto === 'met' ? 'ok' : 'err'),
      note: numbers.rta.note,
    });
  } else if (numbers.rta.state === 'declared') {
    signals.push({
      label: 'RTA — declared, not measured',
      value: `${numbers.rta.minutes} min typed in Settings · no passed test behind it`,
      kind: 'err',
      note: numbers.rta.note,
    });
  } else if (rtoSet) {
    signals.push({
      label: 'RTA — unmeasured', value: 'no passed test has measured a recovery time',
      kind: 'warn', note: numbers.rta.note,
    });
  }

  // ---- overall level 0–5, capped by real-world evidence ----
  const caps = [];
  let level = overall >= 90 ? 5 : overall >= 72 ? 4 : overall >= 52 ? 3 : overall >= 32 ? 2 : overall >= 12 ? 1 : 0;
  const capTo = (n, reason) => {
    if (level > n) { caps.push({ cappedTo: n, from: level, reason }); level = n; }
  };
  if (answeredTotal === 0) level = 0;
  // Self-reported maturity can't exceed what the workspace data proves — and
  // evidence expires (audit A-2): a pass from three years ago describes a system
  // that no longer exists, so only tests inside the freshness window count.
  if (level >= 3 && recentPassed.length === 0) {
    capTo(2, passedTests.length
      ? `The only passed test(s) are older than ${staleAfterDays} days — level 3 means "tested", and expired evidence is not a test.`
      : 'No test has passed yet — level 3+ requires at least one passed recovery test.');
  }
  if (level >= 4 && recentPassed.length < 2) capTo(3, `Level 4 means a repeatable loop — that needs at least two passed tests inside ${staleAfterDays} days (have ${recentPassed.length}).`);
  if (level >= 5 && !gameDayPassed) capTo(4, 'Level 5 means production-proven — that needs a passed game day with live traffic.');
  if (level >= 2 && runbooks.length === 0 && answeredTotal > 0) capTo(2, 'No runbook exists — level 2 means "documented plan".');
  // Coverage matters (audit A-1): a level is a claim about the whole program,
  // and most of the program is unanswered.
  if (incomplete && level > 3) {
    capTo(3, `Only ${answeredTotal} of ${QUESTIONS.length} questions are answered (${completeness}%) — a level above 3 is a claim about a program that has not been described yet.`);
  }

  // ---- next actions: driven by weakest pillars + hard signals ----
  const actions = [];
  const push = (a) => { if (!actions.some((x) => x.title === a.title)) actions.push(a); };

  if (answeredTotal < QUESTIONS.length) {
    push({
      title: 'Finish the maturity assessment',
      why: `${QUESTIONS.length - answeredTotal} of ${QUESTIONS.length} questions unanswered — the roadmap sharpens as you answer.`,
      page: 'assessment',
    });
  }
  if (openBlockers.length) {
    push({
      title: `Close ${openBlockers.length} blocker gap${openBlockers.length > 1 ? 's' : ''}`,
      why: 'Blockers found in testing will fail a real recovery the same way. Fix or formally accept them before the next exercise.',
      page: 'tests',
    });
  }
  if (numbers.rta.state === 'declared' || numbers.rpa.state === 'declared') {
    push({
      title: 'Replace the typed RTA/RPA with a measured one',
      why: 'Those numbers were typed into Settings, not produced by a passed test. Until a test that passes records them, they are declared values and the tool will not present them as achievements.',
      page: 'tests',
    });
  }
  if (!rtoSet || !obj.approved) {
    push({
      title: rtoSet ? 'Get RTO/RPO approved by the business' : 'Set RTO/RPO targets',
      why: rtoSet
        ? 'Targets exist but nobody has signed off. Unapproved objectives are engineering guesses, not commitments.'
        : 'Without a target recovery time and data-loss bound, you cannot judge any test result.',
      page: 'settings',
    });
  }

  const byPillar = {
    inventory: {
      title: components.length < 5 ? 'Build your component inventory' : 'Deepen the inventory: dependencies and third parties',
      why: components.length < 5
        ? 'Everything downstream — diagrams, runbooks, tests — is generated from the inventory. Start by listing what must come back.'
        : 'Map dependsOn and outbound calls so restore order and partner allowlists stop being tribal knowledge.',
      page: 'inventory',
    },
    data: {
      title: 'Pin down replication and secrets per data store',
      why: 'Record a mechanism and RPO for every database, bucket, and queue — and reconcile the secret list. Missing secrets are the #1 test killer.',
      page: 'inventory',
    },
    runbooks: {
      title: runbooks.length ? 'Add verification gates to your runbook steps' : 'Write your first recovery runbook',
      why: runbooks.length
        ? 'Each gate step needs a check command and a pass bar — a layer you can’t verify is a layer you can’t gate.'
        : 'Turn the inventory into an ordered, layer-by-layer procedure someone else could execute at 3am.',
      page: 'runbooks',
    },
    testing: {
      title: passedTests.length ? 'Schedule the next recovery test' : 'Run your first recovery test',
      why: passedTests.length
        ? 'Maturity comes from the loop: test, find gaps, fix, retest. Put the next one on the calendar.'
        : 'Until a test passes, the plan is a hypothesis. Start small: restore in a dev account and measure RTA/RPA.',
      page: 'tests',
    },
    observability: {
      title: 'Make DR readiness visible',
      why: 'Add verification commands to components and stand up a readiness view — backups green, replication lag, last recovery point.',
      page: 'inventory',
    },
    governance: {
      title: 'Put governance around the program',
      why: 'Name an owner, set a cadence, approve objectives, and track every gap to closure with a Phase 0 checklist.',
      page: 'checklists',
    },
  };
  const weakest = [...pillars].sort((a, b) => a.score - b.score || a.answeredCount - b.answeredCount);
  for (const p of weakest) {
    if (actions.length >= 6) break;
    if (p.score >= 85 && p.answeredCount === p.questionCount) continue;
    push(byPillar[p.id]);
  }
  if (actions.length < 3) {
    push({
      title: 'Plan a game day',
      why: 'The fundamentals look strong — prove them with live traffic in a controlled window.',
      page: 'tests',
    });
    push({
      title: 'Keep learning',
      why: 'Browse the knowledge base for patterns to push toward production-proven.',
      page: 'learn',
    });
  }

  const meta2 = scopeMeta(scope);
  return {
    // §3: present only when the report was scoped, so an unscoped report is
    // unchanged.
    ...(meta2 ? {
      scope: {
        ...meta2,
        description: describeScope(scope),
        scored: {
          components: components.length,
          gaps: gaps.length,
          tests: tests.length,
          runbooks: runbooks.length,
        },
        note: 'The questionnaire answers are workspace-wide — maturity is answered once for the programme. '
          + 'Everything measured from the workspace (the signals, the evidence caps on the level, the next actions) '
          + 'was computed from the components, gaps, tests and runbooks in this scope. An item that links to no '
          + 'component at all — a workspace-wide runbook or checklist — is counted in every scope, because it '
          + 'applies to every one of them.',
      },
    } : {}),
    pillars: pillars.map(({ id, name, score, answeredCount, questionCount, answeredScore }) =>
      ({ id, name, score, answeredCount, questionCount, answeredScore })),
    level,
    levelLabel: LEVEL_LABELS[level],
    overallScore: overall,
    answeredTotal,
    questionCount: QUESTIONS.length,
    signals,
    nextActions: actions.slice(0, 6),
    // ---- additive ----
    completeness,
    incomplete,
    caps,
    staleAfterDays,
    numbers,
  };
}

const r = Router();

r.get('/w/:ws/assessment/questions', (req, res, next) => {
  try { store.getWorkspace(req.params.ws); res.json({ questions: QUESTIONS, pillars: PILLARS, levelLabels: LEVEL_LABELS }); } catch (e) { next(e); }
});

r.get('/w/:ws/assessment/report', (req, res, next) => {
  try { res.json(computeReport(req.params.ws, req.query)); } catch (e) { next(e); }
});

r.get('/w/:ws/assessment', (req, res, next) => {
  try { res.json(getAssessment(req.params.ws)); } catch (e) { next(e); }
});

r.put('/w/:ws/assessment', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const body = req.body || {};
    const answers = {};
    const valid = new Set(QUESTIONS.map((q) => q.id));
    for (const [k, v] of Object.entries(body.answers || {})) {
      if (valid.has(k) && Number.isInteger(v) && v >= 0 && v <= 4) answers[k] = v;
    }
    const completedAt = Object.keys(answers).length >= QUESTIONS.length
      ? (body.completedAt || new Date().toISOString())
      : null;
    const obj = { answers, completedAt };
    store.saveObject(ws, 'assessment', obj);
    res.json(obj);
  } catch (e) { next(e); }
});

export default r;
