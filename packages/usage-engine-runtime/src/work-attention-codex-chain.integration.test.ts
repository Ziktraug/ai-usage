import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { createStoredReportCapture } from '@ai-usage/report-data';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import { publishServedReportRevision, updateUsageMachineLabel, usageStorePath } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';
import { isolatedSourceOptions } from './source-test-fixtures';

/**
 * Codex on the Work view end to end (ADR 0059): native rollouts, the real `codex.sessions`
 * source, the store import, the served publication, and the same read the web procedure runs.
 * Codex declares no general turn status. The one root retains its recorded checkout and branch,
 * and its delegated child folds through the declared parent. The test adds a native structured
 * request to the shared seed: its local auxiliary evidence requires attention without inventing
 * an acknowledgement or human answer, and remains absent from the portable served row.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const MACHINE = { id: 'machine-codex-work-chain', label: 'Codex chain machine' } as const;
/** A week after the seeded rollouts (2026-07-02), inside the 30-day window. */
const NOW = new Date('2026-07-10T12:00:00.000Z');
const QUESTION_AT = canonicalInstantFromDate(new Date('2026-07-02T09:03:30.000Z'));
const sourceContext: SourceRunContext = { reportProgress: () => Effect.void };
const reportOptions = { limit: null, minTokens: 0, project: null, since: null, sort: 'date' as const };

/** The native shape of a Codex question to the person, synthesized: name and argument keys only are real. */
const askedQuestion = (at: string) => ({
  payload: {
    arguments: JSON.stringify({ questions: [{ options: ['Fixture A', 'Fixture B'], title: 'Fixture question?' }] }),
    call_id: 'fixture-question-call',
    name: 'request_user_input_async',
    type: 'function_call',
  },
  timestamp: at,
  type: 'response_item',
});

describe('Codex work attention chain', () => {
  test('carries an unanswered native Codex request to its Work root without declaring a general turn status', async () => {
    const home = await temporaryDirectory('lot-c-codex-work-chain-home-');
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(writeMachineConfig(MACHINE).pipe(Effect.provideService(LocalHistoryStorage, storage)));
    const fixture = await seedHarnessHome(home, { harnesses: ['codex'] });
    await appendFile(fixture.paths.codexRootRollout, `${JSON.stringify(askedQuestion(QUESTION_AT))}\n`);

    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({
        ...isolatedSourceOptions,
        codexLiveAvailable: () => false,
        machine: MACHINE,
        now: () => NOW,
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const source = registry.get('codex.sessions');
    if (!source) {
      throw new Error('missing codex.sessions source');
    }
    await Effect.runPromise(source.run(sourceContext));

    const dbPath = usageStorePath(home);
    const capture = await Effect.runPromise(
      createStoredReportCapture({
        config: {},
        dbPath,
        generatedAt: NOW,
        harness: null,
        includeCursor: false,
        machine: MACHINE,
        options: reportOptions,
      }),
    );
    const { rows, tableRows: _tableRows, ...support } = capture.payload;
    expect(JSON.stringify(rows)).not.toContain('Fixture question?');
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: MACHINE, updatedAt: NOW }));
    await Effect.runPromise(
      publishServedReportRevision({
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: capture.payload.generatedAt,
          projectAliases: [],
          projectGroupConfigs: [],
          rows,
          sourceAuthorities: capture.rowSourceAuthorities,
          support: support as FocusedReportSupport,
        }),
        dbPath,
        now: NOW.getTime(),
        revision: 'codex-work-chain-revision',
        ttlMs: 100_000,
      }),
    );

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: MACHINE.id, now: NOW }));

    // No Desktop registry: the exact native request makes this Codex root require attention.
    expect(dataset.roots.map((root) => [root.key, root.attention])).toEqual([
      [{ harness: 'codex', machineId: MACHINE.id, sourceSessionId: fixture.ids.codexRoot }, 'human-request'],
    ]);
    const [root] = dataset.roots;
    expect(root?.desktopSessionId).toBeNull();
    expect(root?.declared).toBeNull();
    expect(root?.project).toMatchObject({
      branch: 'fixture/main',
      checkoutPath: fixture.paths.repository,
      label: path.basename(fixture.paths.repository),
    });
    // The delegated child declared its parent in its own rollout and folds under it.
    expect(root?.children.count).toBe(1);
    expect(root?.session?.rowId).toBeString();
    const requests = root?.facts.filter((fact) => fact.kind === 'codex-user-request') ?? [];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sourceSessionId: fixture.ids.codexRoot,
      provenance: { source: 'codex-rollout', machineId: MACHINE.id, coverage: 'complete' },
    });
    expect(requests[0]?.request).toEqual({
      callId: 'fixture-question-call',
      tool: 'request_user_input_async',
      askedAt: QUESTION_AT,
      acknowledgedAt: null,
      rejectedAt: null,
      questions: [{ id: null, text: 'Fixture question?', textTruncated: false, answeredAt: null }],
    });
    expect(root?.interpretations[0]).toMatchObject({
      kind: 'request-open',
      evidence: [requests[0]?.id],
      text: 'Codex asks: Fixture question?',
    });
    expect(root?.interpretations[0]?.uncertainty).toContain('presentation is not confirmed');
    expect(root?.interpretations.find((entry) => entry.kind === 'coverage-gap')?.text).toBe(
      'Codex records no general turn status: waits beyond the structured requests shown here are unknown — not declared by this harness.',
    );
    expect(dataset.coverage.sessions.revision).toBe('codex-work-chain-revision');
    expect(dataset.totalRoots).toBe(1);
  });
});
