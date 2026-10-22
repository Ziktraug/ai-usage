import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClaudeDesktopSessions } from '@ai-usage/local-collectors/claude-desktop-sessions';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL } from '@ai-usage/local-machine/testing/claude-desktop-sessions';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import {
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  importPullRequestObservations,
  initializeUsageStore,
  recordWorkFactRun,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';

/**
 * The Work attention chain end to end: a seeded Desktop registry, the real collector, the real
 * store import, and the same read the web procedure runs. Each link has its own tests; this is
 * the one that fails when a declaration, a child, a proposal or a coverage count is lost between
 * the registry file and the dataset.
 *
 * The join to collected Sessions is exercised in `report-data`'s own test against a published
 * served revision; publishing one here would mean driving the engine's publication port, which
 * this chain does not own. With no revision the dataset says so in `coverage.sessions`.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const MACHINE = 'machine-work-chain';
const EPOCH = new Date('2026-10-20T12:00:00.000Z');
const hoursBefore = (hours: number) => canonicalInstantFromDate(new Date(EPOCH.getTime() - hours * 3_600_000));

const pullRequestObservation = (
  number: number,
  overrides: Partial<PullRequestObservation> = {},
): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'fixture-main',
  checksRollup: 'pending',
  draft: false,
  headRef: `fixture/pr-${String(number)}`,
  host: 'github.com',
  machineId: MACHINE,
  mergedAt: null,
  number,
  observedAt: hoursBefore(2),
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'fixture/ai-usage',
  reviewDecision: null,
  state: 'OPEN',
  title: `Fixture pull request ${String(number)}`,
  updatedAt: hoursBefore(3),
  url: `https://github.com/fixture/ai-usage/pull/${String(number)}`,
  ...overrides,
});

const checkoutObservation = (checkoutPath: string): CheckoutStatusObservation => ({
  ahead: 1,
  behind: 0,
  branch: 'fixture/checkout-3',
  checkoutPath,
  dirty: true,
  headSha: 'b'.repeat(40),
  lastCommitAt: hoursBefore(5),
  machineId: MACHINE,
  modifiedCount: 2,
  observedAt: hoursBefore(40 / 60),
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 1,
  upstream: null,
});

describe('work attention chain', () => {
  test('carries the representative registry from files to the ranked dataset', async () => {
    const home = await temporaryDirectory('plan117-work-chain-home-');
    const storeRoot = await temporaryDirectory('plan117-work-chain-store-');
    const dbPath = join(storeRoot, 'usage.sqlite');
    const fixture = await seedHarnessHome(home, {
      claudeDesktopEpoch: EPOCH,
      claudeDesktopSessions: 'representative',
      harnesses: ['claude'],
    });
    if (fixture.claudeDesktop === null) {
      throw new Error('expected a seeded Desktop registry');
    }
    const { ids } = fixture.claudeDesktop;
    await Effect.runPromise(initializeUsageStore({ dbPath }));

    const collection = await Effect.runPromise(
      collectClaudeDesktopSessions({ machineId: MACHINE, now: () => EPOCH }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    const imported = await Effect.runPromise(
      importClaudeDesktopSessions({
        collectedAt: EPOCH,
        completeness: collection.completeness,
        dbPath,
        machineId: MACHINE,
        observations: collection.observations,
      }),
    );
    expect(imported).toEqual({
      inserted: fixture.claudeDesktop.rootCount + fixture.claudeDesktop.childCount,
      skipped: 0,
      unchanged: 0,
      updated: 0,
    });

    const dataset = await Effect.runPromise(
      queryWorkAttention({ dbPath, machineId: MACHINE, now: EPOCH, sinceDays: 60 }),
    );
    const byId = new Map(dataset.roots.map((root) => [root.desktopSessionId, root]));

    // Roots and children: every seeded root is a root, no child is, and the orphan counts as one.
    expect(dataset.totalRoots).toBe(fixture.claudeDesktop.rootCount);
    expect(dataset.totalRoots).toBeGreaterThanOrEqual(20);
    expect(dataset.truncated).toBe(false);
    expect(byId.has(ids.blockedChildren[0] ?? '')).toBe(false);
    expect(byId.has(ids.satisfiedChild ?? '')).toBe(false);
    expect(byId.has(ids.orphanChild ?? '')).toBe(true);
    expect(dataset.roots.reduce((sum, root) => sum + root.children.count, 0)).toBe(fixture.claudeDesktop.childCount);

    const blocked = byId.get(ids.blockedRoot);
    expect(blocked?.attention).toBe('human-request');
    expect(blocked?.declared?.status).toBe('blocked');
    expect(blocked?.declared?.needsAction).toBe('Confirm whether the fixture should keep checkout 3 or delete it.');
    // Two children and one grandchild, all folded under the root.
    expect(blocked?.children).toMatchObject({ blocked: 0, completed: 2, count: 3, reviewReady: 1 });
    expect(blocked?.key).toEqual({ harness: 'claude', machineId: MACHINE, sourceSessionId: fixture.ids.claude });
    expect(blocked?.project.worktreeName).toBe('checkout-3');
    expect(blocked?.facts.map(({ kind }) => kind)).toEqual([
      'declared-turn',
      'wrap-up',
      'turn-report',
      'written-branch',
      'side-session-note',
      'side-session-note',
    ]);

    // The child's later pull request reconsiders the request; the question stays a human request.
    const satisfied = byId.get(ids.satisfiedRoot ?? '');
    expect(satisfied?.attention).toBe('human-request');
    expect(satisfied?.reconsidered).toBe(true);
    expect(satisfied?.declared?.status).toBe('blocked');
    expect(satisfied?.interpretations.map(({ kind }) => kind)).toEqual(['request-open', 'request-satisfied-elsewhere']);
    expect(satisfied?.interpretations[1]?.text).toContain('listed by a child session');

    const mergedBefore = byId.get(ids.mergedBeforeRoot ?? '');
    expect(mergedBefore?.attention).toBe('human-request');
    expect(mergedBefore?.reconsidered).toBe(false);
    expect(mergedBefore?.interpretations.map(({ kind }) => kind)).toEqual(['request-open']);

    const proposal = byId.get(ids.proposalRoot ?? '');
    expect(proposal?.attention).toBe('optional-lead');
    expect(proposal?.interpretations.map(({ kind }) => kind)).toEqual(['proposal-open', 'proposal-resolved']);

    expect(byId.get(ids.reviewReadyRoot ?? '')?.attention).toBe('human-request');
    expect(byId.get(ids.staleRoot ?? '')?.interpretations.map(({ kind }) => kind)).toEqual([
      'request-open',
      'declared-status-stale',
    ]);
    expect(byId.get(ids.archivedRoot ?? '')?.archived).toBe(true);
    expect(byId.get(ids.unsupported)?.interpretations.map(({ kind }) => kind)).toEqual(['coverage-gap']);
    expect(byId.get(ids.orphanChild ?? '')?.interpretations.map(({ kind }) => kind)).toEqual([
      'review-ready',
      'coverage-gap',
    ]);

    // Ranking: every human request precedes every other group, the reconsidered ones last among them.
    const attentions = dataset.roots.map((root) => root.attention);
    const lastRequest = attentions.lastIndexOf('human-request');
    expect(attentions.slice(0, lastRequest + 1).every((kind) => kind === 'human-request')).toBe(true);
    const requests = dataset.roots.filter((root) => root.attention === 'human-request');
    const firstReconsidered = requests.findIndex((root) => root.reconsidered);
    expect(firstReconsidered).toBeGreaterThan(0);
    expect(requests.slice(firstReconsidered).every((root) => root.reconsidered)).toBe(true);

    // Coverage carries the collector's counts; the join is absent and says so.
    expect(dataset.coverage.desktopSessions).toEqual({
      collectedAt: canonicalInstantFromDate(EPOCH),
      filesParsed: fixture.claudeDesktop.rootCount + fixture.claudeDesktop.childCount - 1,
      filesSeen: fixture.claudeDesktop.rootCount + fixture.claudeDesktop.childCount,
      refusedRows: 0,
      truncated: false,
      unsupported: 1,
    });
    expect(dataset.coverage.sessions).toEqual({ joined: 0, revision: null, unmatched: 0 });
    // No fact producer has run: no external fact anywhere, no date, nothing disabled.
    expect(dataset.coverage.pullRequests).toEqual({ disabled: false, failed: 0, lastRunAt: null, observed: 0 });
    expect(dataset.coverage.checkouts).toEqual({ failed: 0, lastRunAt: null, observed: 0 });
    expect(
      dataset.roots
        .flatMap((root) => root.facts)
        .some(({ kind }) => kind === 'pull-request' || kind === 'checkout-status'),
    ).toBe(false);

    // The brief of a proposal never reaches the dataset.
    expect(JSON.stringify(dataset)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);

    // The fact producers' tables, seeded as the engine's sources write them: GitHub showed #118
    // awaiting review, #90 merged after the request that asked for it, #117 unreadable now but
    // open when last read a day ago, #555 which no session declared; the worktree is dirty.
    const worktree = join(fixture.paths.repository, '.claude', 'worktrees', 'checkout-3');
    await Effect.runPromise(
      importPullRequestObservations({
        dbPath,
        observations: [
          pullRequestObservation(118),
          pullRequestObservation(90, {
            checksRollup: 'success',
            mergedAt: hoursBefore(2),
            observedAt: hoursBefore(1),
            reviewDecision: 'APPROVED',
            state: 'MERGED',
            updatedAt: hoursBefore(2),
          }),
          pullRequestObservation(117, { observedAt: hoursBefore(26), updatedAt: hoursBefore(27) }),
          pullRequestObservation(117, {
            baseRef: null,
            checksRollup: null,
            draft: null,
            headRef: null,
            observedAt: hoursBefore(0.5),
            outcome: 'unauthenticated',
            outcomeMessage: 'gh exited 4',
            state: null,
            title: null,
            updatedAt: null,
            url: null,
          }),
          pullRequestObservation(555),
        ],
      }),
    );
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkoutObservation(worktree)] }),
    );
    for (const run of [
      { failed: 1, observed: 3, ranAt: hoursBefore(0.5), sourceId: 'github.pull-requests' as const },
      { failed: 0, observed: 1, ranAt: hoursBefore(40 / 60), sourceId: 'checkouts.status' as const },
    ]) {
      await Effect.runPromise(
        recordWorkFactRun({ dbPath, disabled: false, machineId: MACHINE, message: null, ...run }),
      );
    }

    const confronted = await Effect.runPromise(
      queryWorkAttention({ dbPath, machineId: MACHINE, now: EPOCH, sinceDays: 60 }),
    );
    const confrontedById = new Map(confronted.roots.map((root) => [root.desktopSessionId, root]));
    const kindsOf = (desktopSessionId: string | null) =>
      confrontedById.get(desktopSessionId ?? '')?.interpretations.map(({ kind }) => kind);

    // #118: declared by the completed root, now observed awaiting review: an external wait.
    const completed = confrontedById.get(ids.completedRoot);
    expect(completed?.attention).toBe('external-wait');
    expect(kindsOf(ids.completedRoot)).toEqual(['external-review-pending']);
    expect(completed?.facts.filter(({ kind }) => kind === 'pull-request')).toHaveLength(1);

    // #90: the child declared it merged before the request, so the declaration reconsiders
    // nothing; GitHub then showed it merged two hours ago, after the request, and that does.
    // The question stays a human request either way.
    const merged = confrontedById.get(ids.mergedBeforeRoot ?? '');
    expect(merged?.attention).toBe('human-request');
    expect(merged?.reconsidered).toBe(true);
    expect(kindsOf(ids.mergedBeforeRoot)).toEqual([
      'request-open',
      'request-satisfied-elsewhere',
      'pull-request-merged',
    ]);
    expect(merged?.interpretations[1]?.text).toContain(
      `merged at ${hoursBefore(2)}) observed on GitHub at ${hoursBefore(1)}`,
    );
    expect(merged?.interpretations[1]?.evidence).toEqual([
      `${ids.mergedBeforeRoot}:gh:github.com/fixture/ai-usage#90@${hoursBefore(1)}`,
    ]);

    // #117: the failed read and the last successful one both reach the root; neither replaces
    // the child's declaration that reconsidered the request, and neither is presented as current.
    const satisfiedWithFacts = confrontedById.get(ids.satisfiedRoot ?? '');
    expect(satisfiedWithFacts?.attention).toBe('human-request');
    expect(satisfiedWithFacts?.reconsidered).toBe(true);
    expect(kindsOf(ids.satisfiedRoot)).toEqual([
      'request-open',
      'request-satisfied-elsewhere',
      'coverage-gap',
      'coverage-gap',
    ]);
    expect(
      satisfiedWithFacts?.facts
        .filter((fact) => fact.kind === 'pull-request')
        .map((fact) => [fact.outcome, fact.provenance.observedAt]),
    ).toEqual([
      ['observed', hoursBefore(26)],
      ['unauthenticated', hoursBefore(0.5)],
    ]);
    expect(satisfiedWithFacts?.interpretations[2]?.text).toContain('nothing fresher');
    expect(satisfiedWithFacts?.interpretations[3]?.uncertainty).toContain('sign in gh');

    // The dirty worktree reaches every root working in it, each told how many share it.
    const blockedWithFacts = confrontedById.get(ids.blockedRoot);
    expect(blockedWithFacts?.attention).toBe('human-request');
    expect(kindsOf(ids.blockedRoot)).toEqual(['request-open', 'local-changes-unvalidated']);
    expect(blockedWithFacts?.interpretations[1]?.text).toEndWith('Checkout shared by 4 roots.');
    const sharing = confronted.roots.filter((root) =>
      root.facts.some((fact) => fact.kind === 'checkout-status' && fact.checkoutPath === worktree),
    );
    expect(sharing).toHaveLength(4);
    expect(sharing.every((root) => root.project.checkoutPath === worktree)).toBe(true);

    // Nothing is attached by anything but a declaration: #555 reaches no root, and only the
    // three families that declared #118, #90 and #117 carry pull request facts.
    expect(JSON.stringify(confronted)).not.toContain('#555');
    expect(
      confronted.roots
        .filter((root) => root.facts.some(({ kind }) => kind === 'pull-request'))
        .map((root) => root.desktopSessionId)
        .sort(),
    ).toEqual([ids.completedRoot, ids.mergedBeforeRoot, ids.satisfiedRoot].sort());
    expect(confronted.coverage.pullRequests).toEqual({
      disabled: false,
      failed: 1,
      lastRunAt: hoursBefore(0.5),
      observed: 3,
    });
    expect(confronted.coverage.checkouts).toEqual({ failed: 0, lastRunAt: hoursBefore(40 / 60), observed: 1 });
    expect(confronted.totalRoots).toBe(dataset.totalRoots);

    // The default window never hides the 40-day-old question; it hides only older roots with
    // nothing pending, counts them, and a short page still reports the total.
    const windowed = await Effect.runPromise(queryWorkAttention({ dbPath, limit: 5, machineId: MACHINE, now: EPOCH }));
    expect(windowed.roots).toHaveLength(5);
    expect(windowed.truncated).toBe(true);
    expect(windowed.totalRoots).toBe(dataset.totalRoots);
    expect(windowed.coverage.window.sinceDays).toBe(30);
    const unpaged = await Effect.runPromise(queryWorkAttention({ dbPath, limit: 200, machineId: MACHINE, now: EPOCH }));
    expect(unpaged.roots.some((root) => root.desktopSessionId === ids.staleRoot)).toBe(true);
    expect(unpaged.coverage.window.excludedRoots).toBe(dataset.totalRoots - unpaged.roots.length);
    expect(
      unpaged.roots
        .filter((root) => Date.parse(root.age.lastActivityAt ?? '') < EPOCH.getTime() - 30 * 86_400_000)
        .every((root) => root.attention === 'human-request' || root.attention === 'external-wait'),
    ).toBe(true);
    expect(dataset.coverage.window).toEqual({ excludedRoots: 0, sinceDays: 60 });

    // A second sweep of the untouched registry changes nothing in the store.
    const again = await Effect.runPromise(
      importClaudeDesktopSessions({
        collectedAt: new Date(EPOCH.getTime() + 60_000),
        completeness: collection.completeness,
        dbPath,
        machineId: MACHINE,
        observations: collection.observations,
      }),
    );
    expect(again).toEqual({ inserted: 0, skipped: 0, unchanged: imported.inserted, updated: 0 });
  });
});
