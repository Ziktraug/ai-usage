import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeDesktopFixtureRegistry } from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type { ClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import { importClaudeDesktopSessions, initializeUsageStore } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createLocalWorkContextMcpReadService, runMemoryMcpProcess } from './main';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-context-mcp-'));
  temporaryRoots.push(root);
  return root;
};

describe('Memory MCP process composition', () => {
  test('builds the local stdio composition without opening a Memory or usage database', async () => {
    const root = await temporaryRoot();
    let connected = false;
    await runMemoryMcpProcess({
      connect: (server) => {
        connected = server !== null;
        return Promise.resolve();
      },
      cwd: '/workspace',
      environment: {
        AI_USAGE_DATABASE_PATH: path.join(root, 'store', 'usage-store.sqlite'),
        AI_USAGE_ENGINE_STATE_DIR: '/isolated/state',
        AI_USAGE_HOME: '/isolated/home',
      },
    });
    expect(connected).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  test('reads the Work context read-only and reports a missing store as a typed code, never creating it', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    const work = createLocalWorkContextMcpReadService(dbPath);
    const signal = new AbortController().signal;

    expect(await work.readWorkContext({ checkoutPath: '/fixture/checkout', kind: 'checkout' }, signal)).toEqual({
      code: 'store-missing',
      kind: 'error',
    });
    expect(await work.readWorkContext({ checkoutPath: 'relative/checkout', kind: 'checkout' }, signal)).toEqual({
      code: 'invalid-input',
      kind: 'error',
    });
    expect(await readdir(root)).toEqual([]);
  });

  test('answers store-not-upgraded on a store the engine has not reopened since the declaration history', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    const machineId = 'machine-mcp-work-context';
    const registry = claudeDesktopFixtureRegistry({
      cliSessionIdWithTranscript: 'cli-fixture-transcript',
      epoch: new Date(),
      repository: path.join(root, 'work', 'fixture'),
      variant: 'minimal',
    });
    const observations: ClaudeDesktopSessionObservation[] = [];
    for (const entry of registry.documents) {
      const result = parseClaudeDesktopSessionFile(entry.document, {
        accountDirectory: entry.account,
        fileModifiedAt: entry.modifiedAt.toISOString(),
        machineId,
        observedAt: entry.modifiedAt.toISOString(),
        organizationDirectory: entry.organization,
        relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
      });
      if (result.kind === 'observation') {
        observations.push(result.observation);
      }
    }
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(
      importClaudeDesktopSessions({
        collectedAt: new Date(),
        completeness: {
          filesParsed: observations.length,
          filesSeen: observations.length,
          rejected: 0,
          truncated: false,
          unsupported: 0,
        },
        dbPath,
        machineId,
        observations,
      }),
    );
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE claude_desktop_turn_declarations');
    } finally {
      db.close();
    }
    const work = createLocalWorkContextMcpReadService(dbPath);
    expect(
      await work.readWorkContext(
        { checkoutPath: path.join(root, 'work', 'fixture'), kind: 'checkout' },
        new AbortController().signal,
      ),
    ).toEqual({ code: 'store-not-upgraded', kind: 'error' });
  });
});
