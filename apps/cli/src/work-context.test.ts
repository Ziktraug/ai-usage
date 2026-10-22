import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { claudeDesktopFixtureRegistry } from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type { ClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import { importClaudeDesktopSessions, initializeUsageStore } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { withCliSandbox } from './test-support/run-cli';
import { WORK_CONTEXT_RETRIEVED_DATA_NOTICE } from './work-context';

const MACHINE = 'machine-cli-work-context';
const TEST_TIMEOUT_MS = 30_000;

/** The minimal Desktop registry, normalized as the collector does and imported as the engine does. */
const seedStore = async (dbPath: string, repository: string): Promise<void> => {
  const registry = claudeDesktopFixtureRegistry({
    cliSessionIdWithTranscript: 'cli-fixture-transcript',
    epoch: new Date(),
    repository,
    variant: 'minimal',
  });
  const observations: ClaudeDesktopSessionObservation[] = [];
  for (const entry of registry.documents) {
    const result = parseClaudeDesktopSessionFile(entry.document, {
      accountDirectory: entry.account,
      fileModifiedAt: entry.modifiedAt.toISOString(),
      machineId: MACHINE,
      observedAt: entry.modifiedAt.toISOString(),
      organizationDirectory: entry.organization,
      relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
    });
    if (result.kind === 'observation') {
      observations.push(result.observation);
    }
  }
  await mkdir(path.dirname(dbPath), { recursive: true });
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(
    importClaudeDesktopSessions({
      collectedAt: new Date(),
      completeness: {
        filesParsed: observations.length,
        filesSeen: registry.documents.length,
        rejected: 0,
        truncated: false,
        unsupported: registry.documents.length - observations.length,
      },
      dbPath,
      machineId: MACHINE,
      observations,
    }),
  );
};

test(
  'work context reads a checkout from the stored registry without starting an engine, as JSON and as text',
  async () => {
    await withCliSandbox(async ({ environment, root, runCli }) => {
      const dbPath = environment.AI_USAGE_DATABASE_PATH ?? '';
      const repository = path.join(root, 'work', 'fixture');
      await seedStore(dbPath, repository);
      const storeBytes = Bun.hash(await Bun.file(dbPath).arrayBuffer());

      // A relative checkout resolves against the operator's working directory (the sandbox root).
      const json = await runCli(['work', 'context', '--checkout', 'work/fixture', '--json']);
      expect(json.stderr).toBe('');
      expect(json.exitCode).toBe(0);
      const context = JSON.parse(json.stdout) as {
        readonly coverage: { readonly notes: readonly { readonly code: string }[] };
        readonly schemaVersion: number;
        readonly scope: unknown;
        readonly waiting: readonly { readonly attention: string; readonly root: { readonly title: string } }[];
      };
      expect(context.schemaVersion).toBe(1);
      expect(context.scope).toEqual({ checkoutPath: repository, kind: 'checkout', match: 'same-or-inside' });
      expect(context.waiting.map(({ attention, root: { title } }) => [title, attention])).toEqual([
        ['Fixture: investigate checkout 3', 'human-request'],
      ]);
      expect(context.coverage.notes.map(({ code }) => code)).toContain('claude-desktop-only');

      const text = await runCli(['work', 'context', '--project-label', 'fixture']);
      expect(text.exitCode).toBe(0);
      expect(text.stdout.startsWith(`${WORK_CONTEXT_RETRIEVED_DATA_NOTICE}\n`)).toBe(true);
      expect(text.stdout).toContain('Work context · project fixture');
      expect(text.stdout).toContain('Waiting (1)');
      expect(text.stdout).toContain('Confirm whether the fixture should keep checkout 3 or delete it.');
      expect(text.stdout).toContain('Only Claude Desktop sessions are represented.');
      expect(text.stdout).toContain('· Codex 0 in scope (sessions only; 0 of 0 recent campaigns read).');

      // Read-only: the database is unchanged, its write-ahead log empty, no engine started.
      expect(Bun.hash(await Bun.file(dbPath).arrayBuffer())).toBe(storeBytes);
      expect(Bun.file(`${dbPath}-wal`).size).toBe(0);
      expect(await Bun.file(`${dbPath}.engine.lock`).exists()).toBe(false);
      expect(await Bun.file(path.join(root, 'state', 'rendezvous.json')).exists()).toBe(false);
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  'work context fails visibly on a missing store and never creates one',
  async () => {
    await withCliSandbox(async ({ environment, runCli }) => {
      const dbPath = environment.AI_USAGE_DATABASE_PATH ?? '';
      const result = await runCli(['work', 'context', '--checkout', '/fixture/checkout', '--json']);
      expect(result).toMatchObject({
        exitCode: 1,
        stderr: 'Error: No usage store exists yet; the usage engine creates it on its first run.\n',
        stdout: '',
      });
      expect(await Bun.file(dbPath).exists()).toBe(false);

      const invalid = await runCli(['work', 'context', '--project-label', 'a/b']);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toBe(
        'Error: The Work context scope is invalid: projectLabel is a directory name; pass a checkout path to scope by path.\n',
      );
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  'work context answers store-not-upgraded on a store the engine has not reopened since the declaration history',
  async () => {
    await withCliSandbox(async ({ environment, root, runCli }) => {
      const dbPath = environment.AI_USAGE_DATABASE_PATH ?? '';
      const repository = path.join(root, 'work', 'fixture');
      await seedStore(dbPath, repository);
      const db = new Database(dbPath);
      try {
        db.exec('DROP TABLE claude_desktop_turn_declarations');
      } finally {
        db.close();
      }
      const result = await runCli(['work', 'context', '--checkout', repository, '--json']);
      expect(result).toMatchObject({
        exitCode: 1,
        stderr:
          'Error: The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.\n',
        stdout: '',
      });
      expect(result.stderr).not.toContain(dbPath);
    });
  },
  TEST_TIMEOUT_MS,
);
