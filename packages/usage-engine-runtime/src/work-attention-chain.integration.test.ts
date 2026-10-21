import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClaudeDesktopSessions } from '@ai-usage/local-collectors/claude-desktop-sessions';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL } from '@ai-usage/local-machine/testing/claude-desktop-sessions';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import { importClaudeDesktopSessions, initializeUsageStore } from '@ai-usage/usage-store/writer';
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

    const satisfied = byId.get(ids.satisfiedRoot ?? '');
    expect(satisfied?.attention).toBe('none');
    expect(satisfied?.declared?.status).toBe('blocked');
    expect(satisfied?.interpretations.map(({ kind }) => kind)).toEqual(['request-satisfied-elsewhere']);

    const mergedBefore = byId.get(ids.mergedBeforeRoot ?? '');
    expect(mergedBefore?.attention).toBe('human-request');
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

    // Ranking: every human request precedes every other group.
    const attentions = dataset.roots.map((root) => root.attention);
    const lastRequest = attentions.lastIndexOf('human-request');
    expect(attentions.slice(0, lastRequest + 1).every((kind) => kind === 'human-request')).toBe(true);

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
    expect(dataset.coverage.pullRequests.disabled).toBe(true);

    // The brief of a proposal never reaches the dataset.
    expect(JSON.stringify(dataset)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);

    // The default window leaves out the 40-day-old root; a short page still reports the total.
    const windowed = await Effect.runPromise(queryWorkAttention({ dbPath, limit: 5, machineId: MACHINE, now: EPOCH }));
    expect(windowed.roots).toHaveLength(5);
    expect(windowed.truncated).toBe(true);
    expect(windowed.totalRoots).toBeGreaterThanOrEqual(20);
    expect(windowed.totalRoots).toBeLessThan(dataset.totalRoots);
    expect(windowed.roots.some((root) => root.desktopSessionId === ids.staleRoot)).toBe(false);

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
