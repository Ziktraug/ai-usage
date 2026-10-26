import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClaudeDesktopSessions } from '@ai-usage/local-collectors/claude-desktop-sessions';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import {
  CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
  type ClaudeDesktopFixtureDocument,
  claudeDesktopFixtureRegistry,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import { importClaudeDesktopSessions, initializeUsageStore } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';

/**
 * ADR 0056 end to end over two sweeps: the registry files as Claude Desktop had written them
 * earlier, the real collector and store import, then the same files rewritten into their later
 * state, a second sweep, and the read the web procedure runs. A single sweep cannot see that a
 * question was replaced or a later message arrived; this chain fails when the declaration
 * history is lost between the files and the dataset.
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

const MACHINE = 'machine-work-history-chain';
const EPOCH = new Date('2026-10-20T12:00:00.000Z');
const hoursBefore = (hours: number) => canonicalInstantFromDate(new Date(EPOCH.getTime() - hours * 3_600_000));

const writeDocuments = async (registryDirectory: string, documents: readonly ClaudeDesktopFixtureDocument[]) => {
  for (const entry of documents) {
    const filePath = join(registryDirectory, entry.account, entry.organization, entry.fileName);
    await writeFile(filePath, JSON.stringify(entry.document));
    await utimes(filePath, entry.modifiedAt, entry.modifiedAt);
  }
};

describe('work attention declaration history chain', () => {
  test('two native registry sweeps carry supersession and message dates without inventing answers', async () => {
    const home = await temporaryDirectory('adr0056-history-home-');
    const storeRoot = await temporaryDirectory('adr0056-history-store-');
    const dbPath = join(storeRoot, 'usage.sqlite');
    const fixture = await seedHarnessHome(home, {
      claudeDesktopEpoch: EPOCH,
      claudeDesktopSessions: 'representative',
      harnesses: ['claude'],
    });
    if (fixture.claudeDesktop === null) {
      throw new Error('expected a seeded Desktop registry');
    }
    const { ids, registryDirectory } = fixture.claudeDesktop;
    // The same generator, with the seed's own inputs, names the earlier state of each file.
    const registry = claudeDesktopFixtureRegistry({
      cliSessionIdWithTranscript: fixture.ids.claude,
      epoch: EPOCH,
      repository: fixture.paths.repository,
      variant: 'representative',
    });
    expect(registry.history.map((entry) => entry.sessionId).sort()).toEqual(
      [ids.answeredRoot ?? 'missing', ids.repliedRoot ?? 'missing'].sort(),
    );
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const sweep = async (at: Date) => {
      const collection = await Effect.runPromise(
        collectClaudeDesktopSessions({ machineId: MACHINE, now: () => at }).pipe(
          Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
        ),
      );
      expect(JSON.stringify(collection)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);
      return await Effect.runPromise(
        importClaudeDesktopSessions({
          collectedAt: at,
          completeness: collection.completeness,
          dbPath,
          machineId: MACHINE,
          observations: collection.observations,
        }),
      );
    };

    // Sweep 1: the two files as they were before; every other file already in its final state.
    await writeDocuments(registryDirectory, registry.history);
    await sweep(new Date(EPOCH.getTime() - 2.4 * 3_600_000));
    // Sweep 2: Claude Desktop rewrote them.
    const rewritten = registry.documents.filter((entry) =>
      registry.history.some((earlier) => earlier.sessionId === entry.sessionId),
    );
    await writeDocuments(registryDirectory, rewritten);
    const second = await sweep(EPOCH);
    expect(second.updated).toBe(rewritten.length);

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: MACHINE, now: EPOCH }));
    const byId = new Map(dataset.roots.map((root) => [root.desktopSessionId, root]));

    // Q1, a message, then Q2: Q1 was replaced, no answer is proven, and Q2 is current.
    const answered = byId.get(ids.answeredRoot ?? '');
    expect(answered?.attention).toBe('human-request');
    expect(answered?.reconsidered).toBe(false);
    expect(answered?.declared).toMatchObject({
      at: hoursBefore(3),
      needsAction: 'Delete the superseded layout branch now?',
    });
    expect(answered?.interpretations.map(({ kind }) => kind)).toEqual(['request-open', 'earlier-request-superseded']);
    expect(answered?.interpretations[1]?.text).toBe(
      `Declaration replaced: the question “Keep the compact layout or the airy one?” (asked ${hoursBefore(5)}) was replaced by the session’s declaration at ${hoursBefore(3)}.`,
    );
    const answeredFacts = new Set(answered?.facts.map(({ id }) => id));
    expect(answered?.interpretations[1]?.evidence.every((id) => answeredFacts.has(id))).toBe(true);

    // A later message alone does not establish which question was answered.
    const replied = byId.get(ids.repliedRoot ?? '');
    expect(replied?.attention).toBe('human-request');
    expect(replied?.declared?.at).toBe(hoursBefore(2.5));
    expect(replied?.interpretations.map(({ kind }) => kind)).toEqual(['request-open', 'request-message-observed']);
    expect(replied?.interpretations[1]?.text).toContain(`Message observed in Claude Desktop at ${hoursBefore(2)}`);

    // An unrelated pull request resolves nothing; a child that predates the question proves nothing.
    const unrelated = byId.get(ids.unrelatedPullRequestRoot ?? '');
    expect(unrelated?.attention).toBe('human-request');
    expect(unrelated?.reconsidered).toBe(false);
    expect(unrelated?.interpretations.map(({ kind }) => kind)).toEqual(['request-open']);

    // A later message leaves offers open; native expiry still removes an offer.
    const offers = byId.get(ids.laterOfferRoot ?? '');
    expect(offers?.attention).toBe('optional-lead');
    expect(offers?.interpretations.map(({ kind }) => kind)).toEqual(['proposal-open', 'proposal-expired']);

    // A completed child records linked activity, not an answer to its parent's question.
    const handled = byId.get(ids.handledRoot ?? '');
    expect(handled?.attention).toBe('human-request');
    expect(handled?.interpretations.map(({ kind }) => kind)).toEqual(['request-open', 'request-continued-elsewhere']);
    expect(handled?.interpretations[1]?.text).toContain('“Fixture: fix the flaky export test”');
    // Work continued there without a completion: an older declaration to reconsider.
    const continued = byId.get(ids.continuedRoot ?? '');
    expect(continued?.attention).toBe('human-request');
    expect(continued?.reconsidered).toBe(true);
    expect(continued?.interpretations.map(({ kind }) => kind)).toEqual(['request-open', 'request-continued-elsewhere']);
  });
});
