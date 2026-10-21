import {
  type CanonicalInstant,
  canonicalInstantFromDate,
  parseCanonicalInstant,
} from '@ai-usage/report-core/canonical-instant';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
import type {
  WorkAttentionDataset,
  WorkAttentionKind,
  WorkFact,
  WorkFactProvenance,
  WorkInterpretation,
  WorkRoot,
  WorkRootSession,
} from '@ai-usage/report-core/work-attention';
import { demoReportPayload } from '../../../report-data';
import { workRequest } from '../../query/options/work';
import type { WorkAttentionClient } from '../../rpc/work-attention-client';
import { WORK_DEMO_REVISION, WORK_DEMO_TIME } from './work-synthetic';

/**
 * A synthetic Work attention dataset for the demo runtime. Every root is invented; the only join
 * to the rest of the demo is the served Session row, so "Open session detail" lands on the same
 * synthetic rows the report already shows. Ages are relative to `WORK_DEMO_TIME`, which the page
 * uses as its reference instant, so the demo reads the same on every visit.
 */
const MACHINE = 'fixture-machine';
const SECONDARY_MACHINE = 'fixture-machine-secondary';
const HOUR_MS = 3_600_000;
const DEMO_INSTANT = parseCanonicalInstant(WORK_DEMO_TIME);
const DEMO_NOW = Date.parse(DEMO_INSTANT);

const hoursAgo = (hours: number): CanonicalInstant => canonicalInstantFromDate(new Date(DEMO_NOW - hours * HOUR_MS));
const daysAgo = (days: number): CanonicalInstant => hoursAgo(days * 24);

const COLLECTED_AT = hoursAgo(25 / 60);
const OBSERVED_AT = hoursAgo(40 / 60);

const provenance = (
  source: WorkFactProvenance['source'],
  observedAt: CanonicalInstant,
  coverage: WorkFactProvenance['coverage'] = 'complete',
  machineId = MACHINE,
): WorkFactProvenance => ({ coverage, machineId, observedAt, source });

const desktop = (observedAt: CanonicalInstant = COLLECTED_AT): WorkFactProvenance =>
  provenance('claude-desktop', observedAt);
const github = (coverage: WorkFactProvenance['coverage'] = 'complete'): WorkFactProvenance =>
  provenance('github', OBSERVED_AT, coverage);
const checkout = (): WorkFactProvenance => provenance('local-checkout', OBSERVED_AT);
const jira = (): WorkFactProvenance => provenance('jira', OBSERVED_AT);

interface RootSeed {
  readonly archived?: boolean;
  readonly attention: WorkAttentionKind;
  readonly branch?: string | null;
  readonly children?: Partial<WorkRoot['children']>;
  readonly createdHoursAgo?: number;
  readonly declared?: WorkRoot['declared'];
  readonly desktopSessionId?: string | null;
  readonly facts?: readonly WorkFact[];
  readonly harness?: 'claude' | 'codex';
  readonly id: string;
  readonly interpretations?: readonly WorkInterpretation[];
  readonly lastActivityHoursAgo: number;
  readonly machineId?: string;
  readonly project: string;
  readonly title: string;
  readonly titleSource?: WorkRoot['titleSource'];
  readonly worktreeName?: string | null;
}

const demoSessionJoins = (): ReadonlyMap<string, WorkRootSession> => {
  const joins = new Map<string, WorkRootSession>();
  for (const item of projectSessionPage(demoReportPayload.rows, workRequest(WORK_DEMO_REVISION)).items) {
    const sourceSessionId = item.row.source?.sourceSessionId;
    if (sourceSessionId) {
      joins.set(sourceSessionId, {
        campaignKey: (item.row.campaignTotalCount ?? 1) > 1 ? item.campaignKey : null,
        rowId: item.row.rowId,
      });
    }
  }
  return joins;
};

/** Only Claude Desktop sessions carry a desktop id; other harnesses are addressed by their session key. */
const defaultDesktopSessionId = (harness: 'claude' | 'codex', id: string): string | null =>
  harness === 'claude' ? `desk-${id}` : null;

const root = (seed: RootSeed, joins: ReadonlyMap<string, WorkRootSession>): WorkRoot => {
  const harness = seed.harness ?? 'claude';
  const machineId = seed.machineId ?? MACHINE;
  const lastActivityAt = hoursAgo(seed.lastActivityHoursAgo);
  const declared = seed.declared ?? null;
  return {
    age: {
      createdAt: hoursAgo(seed.createdHoursAgo ?? seed.lastActivityHoursAgo + 6),
      declaredAt: declared?.at ?? null,
      lastActivityAt,
      lastObservedAt: COLLECTED_AT,
    },
    archived: seed.archived ?? false,
    attention: seed.attention,
    children: {
      blocked: 0,
      completed: 0,
      count: 0,
      reviewReady: 0,
      titles: [],
      ...seed.children,
    },
    declared,
    desktopSessionId:
      seed.desktopSessionId === undefined ? defaultDesktopSessionId(harness, seed.id) : seed.desktopSessionId,
    facts: seed.facts ?? [],
    interpretations: seed.interpretations ?? [],
    key: { harness, machineId, sourceSessionId: seed.id },
    project: {
      branch: seed.branch ?? null,
      checkoutPath: seed.worktreeName
        ? `~/Projects/${seed.project}-${seed.worktreeName}`
        : `~/Projects/${seed.project}`,
      label: seed.project,
      worktreeName: seed.worktreeName ?? null,
    },
    session: joins.get(seed.id) ?? null,
    title: seed.title,
    titleSource: seed.titleSource ?? (harness === 'claude' ? 'tool' : 'unknown'),
  };
};

const declaredTurn = (
  id: string,
  status: NonNullable<WorkRoot['declared']>['status'],
  at: CanonicalInstant,
  detail: string,
  needsAction: string | null,
): WorkFact => ({
  declaredAt: at,
  desktopSessionId: `desk-${id}`,
  detail,
  id: `${id}:declared`,
  kind: 'declared-turn',
  needsAction,
  provenance: desktop(),
  status,
});

const declaredPullRequest = (id: string, number: number, state: string, branch: string): WorkFact => ({
  branch,
  host: 'github.example',
  id: `${id}:declared-pr-${number}`,
  kind: 'declared-pull-request',
  number,
  provenance: desktop(),
  repository: 'demo/ai-usage',
  state,
  url: `https://github.example/demo/ai-usage/pull/${number}`,
});

const observedPullRequest = (
  id: string,
  number: number,
  fields: Partial<Extract<WorkFact, { kind: 'pull-request' }>>,
): WorkFact => ({
  accountLabel: 'demo-account',
  checksRollup: 'success',
  draft: false,
  host: 'github.example',
  id: `${id}:pr-${number}`,
  kind: 'pull-request',
  number,
  outcome: 'observed',
  provenance: github(),
  repository: 'demo/ai-usage',
  reviewDecision: null,
  state: 'OPEN',
  updatedAt: hoursAgo(2),
  url: `https://github.example/demo/ai-usage/pull/${number}`,
  ...fields,
});

const jiraIssue = (id: string, key: string, fields: Partial<Extract<WorkFact, { kind: 'jira-issue' }>>): WorkFact => ({
  commentCount: 2,
  id: `${id}:jira-${key}`,
  key,
  kind: 'jira-issue',
  newCommentsSince: 0,
  newestCommentAt: hoursAgo(4),
  outcome: 'observed',
  provenance: jira(),
  status: 'In Progress',
  statusCategory: 'in-progress',
  updatedAt: hoursAgo(4),
  url: null,
  ...fields,
});

const checkoutStatus = (id: string, path: string, branch: string, dirty: boolean, modified = 0): WorkFact => ({
  ahead: dirty ? 2 : 0,
  behind: 0,
  branch,
  checkoutPath: path,
  dirty,
  id: `${id}:checkout`,
  kind: 'checkout-status',
  lastCommitAt: hoursAgo(5),
  modifiedCount: modified,
  outcome: 'observed',
  provenance: checkout(),
  untrackedCount: dirty ? 1 : 0,
});

const proposal = (
  id: string,
  suggestionId: string,
  title: string,
  resolution: Extract<WorkFact, { kind: 'proposal' }>['resolution'],
  createdAt: CanonicalInstant,
  tldr: string | null = null,
): WorkFact => ({
  createdAt,
  id: `${id}:proposal-${suggestionId}`,
  kind: 'proposal',
  provenance: desktop(),
  resolution,
  suggestionId,
  title,
  tldr,
});

const wrapUp = (id: string, at: CanonicalInstant, text: string): WorkFact => ({
  at,
  id: `${id}:wrap-up`,
  kind: 'wrap-up',
  provenance: desktop(),
  text,
});

const writtenBranch = (id: string, branch: string): WorkFact => ({
  branch,
  id: `${id}:branch-${branch}`,
  kind: 'written-branch',
  provenance: desktop(),
});

const interpretation = (
  kind: WorkInterpretation['kind'],
  text: string,
  uncertainty: string,
  evidence: readonly string[],
): WorkInterpretation => ({ evidence, kind, text, uncertainty });

const seeds = (): readonly RootSeed[] => [
  // Needs you ------------------------------------------------------------------------------
  {
    attention: 'human-request',
    branch: 'feat/quota-last-confirmation',
    children: {
      blocked: 1,
      completed: 1,
      count: 2,
      titles: ['Audit the Codex quota feed', 'Write the CLI quota test'],
    },
    declared: {
      at: hoursAgo(3),
      detail: 'The shared projection is in place; the CLI feed still dates quota by first observation.',
      needsAction:
        'Confirm whether the Codex quota window should be dated by its last confirmation before I change the CLI feed.',
      status: 'blocked',
    },
    facts: [
      declaredTurn(
        'claude-history-fallback',
        'blocked',
        hoursAgo(3),
        'The shared projection is in place; the CLI feed still dates quota by first observation.',
        'Confirm whether the Codex quota window should be dated by its last confirmation before I change the CLI feed.',
      ),
      checkoutStatus('claude-history-fallback', '~/Projects/ai-usage-quota-c', 'feat/quota-last-confirmation', true, 3),
      writtenBranch('claude-history-fallback', 'feat/quota-last-confirmation'),
    ],
    id: 'claude-history-fallback',
    interpretations: [
      interpretation(
        'request-open',
        'A question was asked 3 hours ago and no later fact answers it.',
        'A reply given outside the session (chat, terminal) would not be observed here.',
        ['claude-history-fallback:declared'],
      ),
      interpretation(
        'local-changes-unvalidated',
        'The checkout had 3 modified files when it was last observed.',
        'Modified files say nothing about whether the change is complete or tested.',
        ['claude-history-fallback:checkout'],
      ),
    ],
    lastActivityHoursAgo: 3,
    project: 'ai-usage',
    title: 'Recover Claude history',
    worktreeName: 'quota-c',
  },
  {
    attention: 'human-request',
    branch: 'main',
    declared: {
      at: hoursAgo(9),
      detail: 'Retention timeline reconstructed from the stored captures and the purge window.',
      needsAction: 'Review the retention timeline findings and decide whether to re-import the MacBook snapshot.',
      status: 'review_ready',
    },
    facts: [
      declaredTurn(
        'enquete-retention',
        'review_ready',
        hoursAgo(9),
        'Retention timeline reconstructed from the stored captures and the purge window.',
        'Review the retention timeline findings and decide whether to re-import the MacBook snapshot.',
      ),
      {
        at: hoursAgo(9),
        id: 'enquete-retention:turn-report',
        kind: 'turn-report',
        provenance: desktop(),
        text: 'Nothing was lost: the store captured the history five days before the purge. A snapshot re-import is due within two weeks.',
      },
      jiraIssue('enquete-retention', 'XLB-2090', { newCommentsSince: 2 }),
    ],
    id: 'enquete-retention',
    interpretations: [
      interpretation(
        'review-ready',
        'The session declared its result ready for review 9 hours ago.',
        'Review readiness is the session’s own claim; no reviewer has been observed.',
        ['enquete-retention:declared'],
      ),
      interpretation(
        'jira-reply-arrived',
        `2 comments arrived on XLB-2090 after this session family's last activity (${hoursAgo(9)}); no resumption observed.`,
        `You may have read them in Jira; this view cannot tell. Newest comment ${hoursAgo(4)}, observed ${OBSERVED_AT}.`,
        ['enquete-retention:jira-XLB-2090'],
      ),
    ],
    lastActivityHoursAgo: 9,
    project: 'ai-usage',
    title: 'Enquête',
    titleSource: 'auto',
  },
  {
    attention: 'human-request',
    branch: 'fix/mobile-nav-labels',
    children: { blocked: 0, completed: 1, count: 1, titles: ['Measure label geometry at 320px'] },
    declared: {
      at: hoursAgo(26),
      detail: 'Two candidate layouts are pushed as separate commits on the branch.',
      needsAction: 'Which of the two 320px layouts do you prefer? Both are pushed as commits on the branch.',
      status: 'blocked',
    },
    facts: [
      declaredTurn(
        'mobile-nav',
        'blocked',
        hoursAgo(26),
        'Two candidate layouts are pushed as separate commits on the branch.',
        'Which of the two 320px layouts do you prefer? Both are pushed as commits on the branch.',
      ),
      declaredPullRequest('mobile-nav', 71, 'OPEN', 'fix/mobile-nav-labels'),
      observedPullRequest('mobile-nav', 71, { checksRollup: 'pending', updatedAt: hoursAgo(25) }),
      checkoutStatus('mobile-nav', '~/Projects/ai-usage', 'fix/mobile-nav-labels', false),
    ],
    id: 'mobile-nav',
    interpretations: [
      interpretation(
        'request-open',
        'A choice between two layouts was requested 26 hours ago; neither commit has been reverted or merged.',
        'A decision taken in the pull request discussion is not read here.',
        ['mobile-nav:declared', 'mobile-nav:pr-71'],
      ),
    ],
    lastActivityHoursAgo: 26,
    project: 'ai-usage',
    title: 'Fix mobile navigation label overlap',
  },
  {
    attention: 'human-request',
    branch: 'fix/distillation-redaction',
    declared: {
      at: daysAgo(5),
      detail: 'Quote re-redaction rejects already-redacted authorization markers; a fixed-point test is drafted.',
      needsAction: 'The redaction fixed-point test needs a real sample; can you provide one from the scratch store?',
      status: 'blocked',
    },
    facts: [
      declaredTurn(
        'distillation-redaction',
        'blocked',
        daysAgo(5),
        'Quote re-redaction rejects already-redacted authorization markers; a fixed-point test is drafted.',
        'The redaction fixed-point test needs a real sample; can you provide one from the scratch store?',
      ),
      checkoutStatus('distillation-redaction', '~/Projects/ai-usage', 'fix/distillation-redaction', true, 1),
    ],
    id: 'distillation-redaction',
    interpretations: [
      interpretation(
        'request-open',
        'A sample was requested 5 days ago; no later fact shows it was provided.',
        'The sample may have been handed over outside any observed source.',
        ['distillation-redaction:declared'],
      ),
      interpretation(
        'declared-status-stale',
        'The declaration is 5 days old and the checkout still carries one modified file.',
        'Age alone does not mean the request was abandoned.',
        ['distillation-redaction:declared', 'distillation-redaction:checkout'],
      ),
    ],
    lastActivityHoursAgo: 5 * 24,
    project: 'ai-usage',
    title: 'Session distillation worker redaction',
  },
  {
    attention: 'human-request',
    branch: 'docs/accent-palette-adr',
    declared: {
      at: hoursAgo(14),
      detail: 'ADR draft written for the lavender accent and the contour field.',
      needsAction: 'Approve the ADR draft for the accent palette before I open the pull request.',
      status: 'review_ready',
    },
    facts: [
      declaredTurn(
        'enquete-palette',
        'review_ready',
        hoursAgo(14),
        'ADR draft written for the lavender accent and the contour field.',
        'Approve the ADR draft for the accent palette before I open the pull request.',
      ),
    ],
    id: 'enquete-palette',
    interpretations: [
      interpretation(
        'review-ready',
        'An ADR draft awaits approval; no pull request has been declared or observed for it.',
        'Approval given in conversation would not be observed.',
        ['enquete-palette:declared'],
      ),
    ],
    lastActivityHoursAgo: 14,
    project: 'docs-site',
    title: 'Enquête',
    titleSource: 'auto',
  },
  // Waiting on others ----------------------------------------------------------------------
  {
    attention: 'external-wait',
    branch: 'feat/codex-compressed-rollouts',
    declared: {
      at: daysAgo(2),
      detail: 'Reader discovers .jsonl.zst rollouts; pull request opened.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'codex-rollouts',
        'completed',
        daysAgo(2),
        'Reader discovers .jsonl.zst rollouts; pull request opened.',
        null,
      ),
      declaredPullRequest('codex-rollouts', 62, 'OPEN', 'feat/codex-compressed-rollouts'),
      observedPullRequest('codex-rollouts', 62, { checksRollup: 'pending', updatedAt: hoursAgo(3) }),
    ],
    id: 'codex-rollouts',
    interpretations: [
      interpretation(
        'external-review-pending',
        'Pull request #62 was open with pending checks and no review decision when observed 40 minutes ago.',
        'The next observation may already differ; GitHub is read on the collection cadence only.',
        ['codex-rollouts:pr-62'],
      ),
    ],
    lastActivityHoursAgo: 2 * 24,
    project: 'ai-usage',
    title: 'Compressed Codex rollouts discovery',
  },
  {
    attention: 'external-wait',
    branch: 'perf/linear-line-emitter',
    declared: {
      at: daysAgo(3),
      detail: 'Piecewise emitter replaces the quadratic rope re-flatten; cold report peak measured.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'line-emitter',
        'completed',
        daysAgo(3),
        'Piecewise emitter replaces the quadratic rope re-flatten; cold report peak measured.',
        null,
      ),
      declaredPullRequest('line-emitter', 65, 'OPEN', 'perf/linear-line-emitter'),
      observedPullRequest('line-emitter', 65, { reviewDecision: 'REVIEW_REQUIRED', updatedAt: hoursAgo(30) }),
    ],
    id: 'line-emitter',
    interpretations: [
      interpretation(
        'external-review-pending',
        'Pull request #65 passed its checks and still requires a review when observed.',
        'A review posted after the observation is not reflected yet.',
        ['line-emitter:pr-65'],
      ),
    ],
    lastActivityHoursAgo: 3 * 24,
    project: 'ai-usage',
    title: 'Linear history line emitter',
  },
  {
    attention: 'external-wait',
    branch: 'feat/platform-runtime',
    declared: {
      at: daysAgo(6),
      detail: 'Eleven review rounds applied; pull request updated.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'platform-runtime',
        'completed',
        daysAgo(6),
        'Eleven review rounds applied; pull request updated.',
        null,
      ),
      declaredPullRequest('platform-runtime', 53, 'OPEN', 'feat/platform-runtime'),
      observedPullRequest('platform-runtime', 53, {
        accountLabel: null,
        checksRollup: null,
        draft: null,
        outcome: 'unauthenticated',
        provenance: github('partial'),
        state: null,
        updatedAt: null,
      }),
    ],
    id: 'platform-runtime',
    interpretations: [
      interpretation(
        'coverage-gap',
        'The GitHub read for #53 failed (unauthenticated); only the session’s declared OPEN state is available.',
        'The declared state is six days old and unconfirmed.',
        ['platform-runtime:declared-pr-53', 'platform-runtime:pr-53'],
      ),
    ],
    lastActivityHoursAgo: 6 * 24,
    project: 'ai-usage',
    title: 'Platform runtime review follow-ups',
  },
  {
    attention: 'external-wait',
    branch: 'fix/memory-ci',
    children: {
      blocked: 0,
      completed: 2,
      count: 3,
      reviewReady: 1,
      titles: ['Fixture machine identity', 'Retired URL canonicalisation', 'Restart investigation'],
    },
    declared: {
      at: hoursAgo(20),
      detail: 'Memory CI repaired; the restart timeout is documented as unresolved.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'memory-ci',
        'completed',
        hoursAgo(20),
        'Memory CI repaired; the restart timeout is documented as unresolved.',
        null,
      ),
      declaredPullRequest('memory-ci', 67, 'OPEN', 'fix/memory-ci'),
      observedPullRequest('memory-ci', 67, { updatedAt: hoursAgo(19) }),
    ],
    id: 'memory-ci',
    interpretations: [
      interpretation(
        'external-review-pending',
        'Pull request #67 is open, not a draft, with passing checks and no review decision.',
        'Reviewers may have been requested outside the observed fields.',
        ['memory-ci:pr-67'],
      ),
    ],
    lastActivityHoursAgo: 20,
    project: 'ai-usage',
    title: 'Memory CI repair',
  },
  // Leads ----------------------------------------------------------------------------------
  {
    attention: 'optional-lead',
    branch: 'main',
    declared: {
      at: hoursAgo(30),
      detail: 'Ceiling and drift guard in place; the closure measured at 301 KB.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'bundle-guard',
        'completed',
        hoursAgo(30),
        'Ceiling and drift guard in place; the closure measured at 301 KB.',
        null,
      ),
      proposal(
        'bundle-guard',
        'ledger',
        'Add a per-route closure ledger',
        'open',
        hoursAgo(30),
        'Record each route’s initial closure so a regression names the route.',
      ),
    ],
    id: 'bundle-guard',
    interpretations: [
      interpretation(
        'proposal-open',
        'One proposal from the session has not been started or dismissed.',
        'An open proposal is a lead, not a commitment, and grants no authorization.',
        ['bundle-guard:proposal-ledger'],
      ),
    ],
    lastActivityHoursAgo: 30,
    project: 'ai-usage',
    title: 'Bundle budget guard',
  },
  {
    attention: 'optional-lead',
    branch: 'main',
    declared: {
      at: daysAgo(4),
      detail: 'Overview composition reviewed; hero and legend liveness adjusted.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'overview-composition',
        'completed',
        daysAgo(4),
        'Overview composition reviewed; hero and legend liveness adjusted.',
        null,
      ),
      proposal('overview-composition', 'contour', 'Decide the contour-field treatment', 'open', daysAgo(4)),
      proposal('overview-composition', 'sessions', 'Sketch the Sessions list + inspector', 'open', daysAgo(4)),
      proposal('overview-composition', 'palette', 'Re-tune the harness palette', 'dismissed', daysAgo(4)),
    ],
    id: 'overview-composition',
    interpretations: [
      interpretation(
        'proposal-open',
        'Two proposals remain open; one was dismissed without a recorded reason.',
        'Dismissal reasons are not collected; the dismissed proposal is not a decision against it.',
        ['overview-composition:proposal-contour', 'overview-composition:proposal-sessions'],
      ),
      interpretation('proposal-resolved', 'One proposal was dismissed.', 'No reason is recorded for the dismissal.', [
        'overview-composition:proposal-palette',
      ]),
    ],
    lastActivityHoursAgo: 4 * 24,
    project: 'ai-usage',
    title: 'Overview composition pass',
  },
  {
    attention: 'optional-lead',
    branch: 'main',
    declared: {
      at: daysAgo(8),
      detail: 'Barrel cost measured: one eager Ark UI chunk is 26% of the first load.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'barrel-cost',
        'completed',
        daysAgo(8),
        'Barrel cost measured: one eager Ark UI chunk is 26% of the first load.',
        null,
      ),
      proposal('barrel-cost', 'split', 'Split the Ark UI chunk by primitive', 'open', daysAgo(8)),
    ],
    id: 'barrel-cost',
    interpretations: [
      interpretation('proposal-open', 'One proposal is open since 8 days.', 'Leads do not age into urgency.', [
        'barrel-cost:proposal-split',
      ]),
    ],
    lastActivityHoursAgo: 8 * 24,
    project: 'ai-usage',
    title: 'Design-system barrel cost',
  },
  // Recent, nothing pending ----------------------------------------------------------------
  {
    attention: 'none',
    branch: 'feat/report-ui',
    facts: [
      checkoutStatus('campaign-root', '~/Projects/ai-usage', 'feat/report-ui', false),
      {
        branch: 'feat/report-ui',
        id: 'campaign-root:branch',
        kind: 'written-branch',
        provenance: provenance('claude-transcript', COLLECTED_AT, 'partial'),
      },
    ],
    harness: 'codex',
    id: 'campaign-root',
    interpretations: [
      interpretation(
        'coverage-gap',
        'Codex declares no turn outcome; whether this work is finished is unobserved.',
        'Only the transcript and the checkout are read for Codex sessions.',
        ['campaign-root:checkout'],
      ),
    ],
    lastActivityHoursAgo: 1,
    project: 'ai-usage',
    title: 'Build report UI',
  },
  {
    attention: 'none',
    branch: 'fix/quota-timer',
    declared: {
      at: hoursAgo(2),
      detail: 'Timer documented as quota-only; backups taken before the upgrade.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'quota-timer',
        'completed',
        hoursAgo(2),
        'Timer documented as quota-only; backups taken before the upgrade.',
        null,
      ),
      declaredPullRequest('quota-timer', 60, 'MERGED', 'fix/quota-timer'),
      observedPullRequest('quota-timer', 60, { state: 'MERGED', updatedAt: hoursAgo(2) }),
      wrapUp(
        'quota-timer',
        hoursAgo(2),
        'Merged #60. The NixOS timer runs quota only; the store still needs a report run.',
      ),
    ],
    id: 'quota-timer',
    interpretations: [
      interpretation(
        'pull-request-merged',
        'Pull request #60 was observed merged.',
        'Merged is not deployed; the timer unit on the machine was not observed.',
        ['quota-timer:pr-60'],
      ),
    ],
    lastActivityHoursAgo: 2,
    project: 'ai-usage',
    title: 'Quota timer is not collection',
  },
  {
    attention: 'none',
    branch: 'perf/scan-resources',
    declared: {
      at: hoursAgo(36),
      detail: 'Per-file cache and hourly heartbeat implemented.',
      needsAction: 'Open the pull request for the per-file cache once the measurement kit is committed.',
      status: 'blocked',
    },
    facts: [
      declaredTurn(
        'scan-resources',
        'blocked',
        hoursAgo(36),
        'Per-file cache and hourly heartbeat implemented.',
        'Open the pull request for the per-file cache once the measurement kit is committed.',
      ),
      observedPullRequest('scan-resources', 61, { state: 'MERGED', updatedAt: hoursAgo(20) }),
    ],
    id: 'scan-resources',
    interpretations: [
      interpretation(
        'request-satisfied-elsewhere',
        'The requested pull request (#61) was observed open and then merged after the request was declared.',
        'The link rests on the branch name; the session itself never recorded the outcome.',
        ['scan-resources:declared', 'scan-resources:pr-61'],
      ),
    ],
    lastActivityHoursAgo: 36,
    project: 'ai-usage',
    title: 'Scan resource optimization',
  },
  {
    archived: true,
    attention: 'none',
    branch: 'main',
    children: {
      blocked: 0,
      completed: 4,
      count: 4,
      titles: ['Lineage per harness', 'Campaign lanes', 'Aggregate cells', 'Graph library survey'],
    },
    declared: {
      at: daysAgo(12),
      detail: 'Verdict recorded: campaign lanes first, no graph library.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'viz-lineage',
        'completed',
        daysAgo(12),
        'Verdict recorded: campaign lanes first, no graph library.',
        null,
      ),
    ],
    id: 'viz-lineage',
    lastActivityHoursAgo: 12 * 24,
    project: 'ai-usage',
    title: 'Viz lineage exploration',
  },
  {
    attention: 'none',
    branch: 'main',
    declared: {
      at: daysAgo(15),
      detail: 'No full rewrite; GPUI at most a third read-only client.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'rust-question',
        'completed',
        daysAgo(15),
        'No full rewrite; GPUI at most a third read-only client.',
        null,
      ),
      wrapUp('rust-question', daysAgo(15), 'Roadmap stays on session and agent-lineage visualisation.'),
    ],
    id: 'rust-question',
    lastActivityHoursAgo: 15 * 24,
    project: 'ai-usage',
    title: 'Rust/GPUI rewrite question',
  },
  {
    attention: 'none',
    branch: 'exp/codex-sandbox',
    declared: {
      at: daysAgo(18),
      detail: 'Sandbox limits documented; workers queue commits for the supervisor.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'codex-sandbox',
        'completed',
        daysAgo(18),
        'Sandbox limits documented; workers queue commits for the supervisor.',
        null,
      ),
      checkoutStatus('codex-sandbox', '~/Projects/ai-usage-sandbox', 'exp/codex-sandbox', true, 4),
    ],
    id: 'codex-sandbox',
    interpretations: [
      interpretation(
        'local-changes-unvalidated',
        'The checkout still had 4 modified files when observed, 18 days after the session completed.',
        'Local modifications are not evidence of pending work or of lost work.',
        ['codex-sandbox:checkout'],
      ),
    ],
    lastActivityHoursAgo: 18 * 24,
    project: 'ai-usage',
    title: 'Codex worker sandbox limits',
    worktreeName: 'sandbox',
  },
  {
    attention: 'none',
    desktopSessionId: 'desk-unsupported-v2',
    facts: [],
    id: 'unsupported-v2',
    interpretations: [
      interpretation(
        'coverage-gap',
        'The desktop session file uses an unsupported format (schema v2); no declaration was read.',
        'The session may carry a request that this build cannot see.',
        [],
      ),
    ],
    lastActivityHoursAgo: 20 * 24,
    project: 'mobile-app',
    title: 'local_7f3a9c.json',
    titleSource: 'unknown',
  },
  {
    attention: 'none',
    branch: 'feat/atelier-ui',
    declared: {
      at: daysAgo(25),
      detail: 'Lavender/graphite refresh merged as the accepted direction.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'atelier-ui',
        'completed',
        daysAgo(25),
        'Lavender/graphite refresh merged as the accepted direction.',
        null,
      ),
      declaredPullRequest('atelier-ui', 54, 'MERGED', 'feat/atelier-ui'),
      observedPullRequest('atelier-ui', 54, { state: 'MERGED', updatedAt: daysAgo(25) }),
    ],
    id: 'atelier-ui',
    interpretations: [
      interpretation('pull-request-merged', 'Pull request #54 was observed merged.', 'Merged is not released.', [
        'atelier-ui:pr-54',
      ]),
    ],
    lastActivityHoursAgo: 25 * 24,
    project: 'ai-usage',
    title: 'Atelier UI direction',
  },
  {
    attention: 'none',
    branch: 'main',
    facts: [checkoutStatus('cdp-driving', '~/Projects/ai-usage', 'main', false)],
    harness: 'codex',
    id: 'cdp-driving',
    interpretations: [
      interpretation(
        'coverage-gap',
        'Codex declares no turn outcome; whether this work is finished is unobserved.',
        'Only the transcript and the checkout are read for Codex sessions.',
        ['cdp-driving:checkout'],
      ),
    ],
    lastActivityHoursAgo: 28 * 24,
    machineId: SECONDARY_MACHINE,
    project: 'ai-usage',
    title: 'Headless Chrome CDP driving',
  },
  {
    attention: 'none',
    branch: 'feat/skills-worktable',
    children: {
      blocked: 0,
      completed: 6,
      count: 6,
      titles: ['Row model', 'Drawer detail', 'Matrix removal', 'Toggle in row', '~n notation'],
    },
    declared: {
      at: daysAgo(33),
      detail: 'One worktable surface; tree, inspector and matrix deleted.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'skills-worktable',
        'completed',
        daysAgo(33),
        'One worktable surface; tree, inspector and matrix deleted.',
        null,
      ),
      {
        at: daysAgo(33),
        id: 'skills-worktable:note',
        kind: 'side-session-note',
        provenance: desktop(),
        report: 'Matrix removed; the drawer carries the per-skill detail now.',
        sessionId: 'desk-skills-matrix',
        title: 'Matrix removal',
      },
    ],
    id: 'skills-worktable',
    lastActivityHoursAgo: 33 * 24,
    project: 'ai-usage',
    title: 'Skills worktable redesign',
  },
  {
    attention: 'none',
    branch: 'main',
    declared: {
      at: daysAgo(40),
      detail: 'Checkout producer lands without a checkout of its own; repair path documented.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'distillation-producer',
        'completed',
        daysAgo(40),
        'Checkout producer lands without a checkout of its own; repair path documented.',
        null,
      ),
    ],
    id: 'distillation-producer',
    lastActivityHoursAgo: 40 * 24,
    project: 'ai-usage',
    title: 'Memory distillation checkout producer',
  },
  {
    attention: 'none',
    branch: 'main',
    facts: [checkoutStatus('quota-sources', '~/Projects/ai-usage', 'main', false)],
    harness: 'codex',
    id: 'quota-sources',
    interpretations: [
      interpretation(
        'coverage-gap',
        'Codex declares no turn outcome; whether this work is finished is unobserved.',
        'Only the transcript and the checkout are read for Codex sessions.',
        ['quota-sources:checkout'],
      ),
    ],
    lastActivityHoursAgo: 37 * 24,
    project: 'ai-usage',
    title: 'Provider quota sources',
  },
  {
    attention: 'none',
    branch: 'main',
    declared: {
      at: daysAgo(10),
      detail: 'Legend total counts Sessions only; the hero follows the brush live.',
      needsAction: null,
      status: 'completed',
    },
    facts: [
      declaredTurn(
        'legend-liveness',
        'completed',
        daysAgo(10),
        'Legend total counts Sessions only; the hero follows the brush live.',
        null,
      ),
    ],
    id: 'legend-liveness',
    lastActivityHoursAgo: 10 * 24,
    project: 'forecast-service',
    title: 'Activity legend and hero liveness',
  },
];

export const syntheticWorkAttentionDataset = (): WorkAttentionDataset => {
  const joins = demoSessionJoins();
  const roots = seeds().map((seed) => root(seed, joins));
  return {
    coverage: {
      checkouts: { failed: 0, lastRunAt: OBSERVED_AT, observed: 6 },
      desktopSessions: {
        collectedAt: COLLECTED_AT,
        filesParsed: 39,
        filesSeen: 41,
        refusedRows: 0,
        truncated: false,
        unsupported: 2,
      },
      jira: { disabled: false, failed: 0, lastRunAt: OBSERVED_AT, observed: 1, reason: null },
      pullRequests: { disabled: false, failed: 1, lastRunAt: OBSERVED_AT, observed: 7 },
      sessions: { joined: 22, revision: 'synthetic-work-v1', unmatched: 3 },
    },
    generatedAt: DEMO_INSTANT,
    machineId: null,
    roots,
    totalRoots: roots.length + 13,
    truncated: true,
  };
};

/** Resolves the synthetic dataset without any transport; the demo never reaches `/rpc`. */
export const createSyntheticWorkAttentionClient = (): WorkAttentionClient => ({
  attention: () => Promise.resolve({ data: syntheticWorkAttentionDataset(), ok: true }),
});
