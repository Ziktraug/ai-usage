import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import {
  CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
  claudeDesktopFixtureRegistry,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type { ClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import { importClaudeDesktopSessions, initializeUsageStore } from '@ai-usage/usage-store/testing';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { Effect } from 'effect';
import { readWorkAttentionForServer } from './work-attention.server';
import {
  readE2EWorkAttention,
  WORK_ATTENTION_E2E_MACHINE_ID,
  WORK_ATTENTION_E2E_NOW,
} from './work-attention-e2e-fixture.server';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-web-work';
const NOW = new Date('2026-10-20T12:00:00.000Z');

/** The minimal registry, normalized the way the collector normalizes files, imported like the engine does. */
const seededStore = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'web-work-attention-'));
  temporaryRoots.push(root);
  const dbPath = join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const registry = claudeDesktopFixtureRegistry({
    cliSessionIdWithTranscript: 'claude-fixture-025',
    epoch: NOW,
    repository: `${root}/home/work/fixture`,
    variant: 'minimal',
  });
  const observations: ClaudeDesktopSessionObservation[] = [];
  let unsupported = 0;
  for (const entry of registry.documents) {
    const result = parseClaudeDesktopSessionFile(entry.document, {
      accountDirectory: entry.account,
      fileModifiedAt: entry.modifiedAt.toISOString(),
      machineId: MACHINE,
      observedAt: NOW.toISOString(),
      organizationDirectory: entry.organization,
      relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
    });
    if (result.kind === 'rejected') {
      throw new Error(`fixture document ${entry.fileName} was rejected`);
    }
    if (result.kind === 'unsupported') {
      unsupported += 1;
    }
    if (result.observation !== null) {
      observations.push(result.observation);
    }
  }
  await Effect.runPromise(
    importClaudeDesktopSessions({
      collectedAt: NOW,
      completeness: {
        filesParsed: registry.documents.length - unsupported,
        filesSeen: registry.documents.length,
        rejected: 0,
        truncated: false,
        unsupported,
      },
      dbPath,
      machineId: MACHINE,
      observations,
    }),
  );
  return dbPath;
};

describe('work attention server', () => {
  test('reads the live store through the read model and returns the contract envelope', async () => {
    const dbPath = await seededStore();
    const result = await readWorkAttentionForServer(
      { limit: 10, machineId: MACHINE },
      { dbPath, mode: 'live', now: () => NOW },
    );
    expect(parseWorkAttentionOutput(result)).toEqual(JSON.parse(JSON.stringify(result)));
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.data.totalRoots).toBe(3);
    expect(result.data.roots.map((root) => root.attention)).toEqual(['human-request', 'none', 'none']);
    expect(result.data.roots[0]?.declared?.needsAction).toBe(
      'Confirm whether the fixture should keep checkout 3 or delete it.',
    );
    expect(result.data.roots[0]?.children.count).toBe(2);
    expect(result.data.coverage.desktopSessions).toMatchObject({ filesSeen: 5, unsupported: 1 });
    expect(JSON.stringify(result)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);
    // A null machine filter means no filter, not the empty machine.
    const unfiltered = await readWorkAttentionForServer({ machineId: null }, { dbPath, mode: 'live', now: () => NOW });
    expect(unfiltered.ok && unfiltered.data.totalRoots).toBe(3);
  });

  test('refuses demo mode and reports store failures without a path', async () => {
    expect(await readWorkAttentionForServer({}, { mode: 'demo' })).toEqual({
      error: { message: 'Work attention is unavailable in demo mode.', tag: 'ForbiddenDemo' },
      ok: false,
    });

    const root = await mkdtemp(join(tmpdir(), 'web-work-attention-broken-'));
    temporaryRoots.push(root);
    const missing = await readWorkAttentionForServer({}, { dbPath: join(root, 'absent.sqlite'), mode: 'live' });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error.tag).toBe('Unavailable');
    expect(JSON.stringify(missing)).not.toContain(root);

    const corruptPath = join(root, 'corrupt.sqlite');
    await writeFile(corruptPath, 'not a database at all, but long enough to be opened as one');
    const corrupt = await readWorkAttentionForServer({}, { dbPath: corruptPath, mode: 'live' });
    expect(corrupt.ok).toBe(false);
    expect(!corrupt.ok && ['IncompatibleStore', 'Unavailable'].includes(corrupt.error.tag)).toBe(true);
    expect(JSON.stringify(corrupt)).not.toContain(root);
  });

  test('a store the engine has not upgraded since the declaration history reads as typed, not as a storage failure', async () => {
    const dbPath = await seededStore();
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE claude_desktop_turn_declarations');
    } finally {
      db.close();
    }
    expect(await readWorkAttentionForServer({ machineId: MACHINE }, { dbPath, mode: 'live', now: () => NOW })).toEqual({
      error: {
        message:
          'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.',
        tag: 'IncompatibleStore',
      },
      ok: false,
    });
  });

  test('serves the representative fixture through the same assembly in e2e mode', async () => {
    const first = await readWorkAttentionForServer({ machineId: WORK_ATTENTION_E2E_MACHINE_ID }, { mode: 'e2e' });
    expect(parseWorkAttentionOutput(first)).toEqual(JSON.parse(JSON.stringify(first)));
    if (!first.ok) {
      throw new Error(first.error.message);
    }
    expect(first.data.generatedAt).toBe(canonicalInstantFromDate(WORK_ATTENTION_E2E_NOW));
    expect(first.data.totalRoots).toBeGreaterThanOrEqual(20);
    expect(first.data.roots.some((root) => root.attention === 'human-request')).toBe(true);
    expect(first.data.roots.some((root) => root.attention === 'optional-lead')).toBe(true);
    expect(
      first.data.roots.some((root) => root.interpretations.some(({ kind }) => kind === 'request-satisfied-elsewhere')),
    ).toBe(true);
    expect(first.data.coverage.desktopSessions).toMatchObject({ truncated: false, unsupported: 1 });
    expect(first.data.coverage.sessions).toEqual({ joined: 0, revision: null, unmatched: 0 });
    expect(JSON.stringify(first)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);

    const second = await readE2EWorkAttention({ limit: 5 });
    expect(second.ok && second.data.roots).toHaveLength(5);
    expect(second.ok && second.data.truncated).toBe(true);
    expect(second.ok && second.data.totalRoots).toBe(first.data.totalRoots);

    // A machine the fixture does not know yields an empty, honest dataset rather than an error.
    const other = await readE2EWorkAttention({ machineId: 'machine-elsewhere' });
    expect(other.ok && other.data.totalRoots).toBe(0);
  });
});
