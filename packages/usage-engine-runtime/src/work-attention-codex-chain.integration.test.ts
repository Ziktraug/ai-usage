import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { createStoredReportCapture } from '@ai-usage/report-data';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import { publishServedReportRevision, updateUsageMachineLabel, usageStorePath } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';

/**
 * Codex on the Work view end to end (ADR 0059): native rollouts, the real `codex.sessions`
 * source, the store import, the served publication, and the same read the web procedure runs.
 * Codex declares no turn status, so the one Codex root must come out with the checkout and branch
 * the rollout recorded, its delegated child folded through the declared parent, and an attention
 * that is not observable. A question Codex posted through `request_user_input_async` is in the
 * rollout and is not read as a wait: the collector does not parse it (absent from the served row).
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
  test('carries a native Codex rollout to a not-observable Work root', async () => {
    const home = await temporaryDirectory('lot-c-codex-work-chain-home-');
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(writeMachineConfig(MACHINE).pipe(Effect.provideService(LocalHistoryStorage, storage)));
    const fixture = await seedHarnessHome(home, { harnesses: ['codex'] });
    await appendFile(fixture.paths.codexRootRollout, `${JSON.stringify(askedQuestion('2026-07-02T09:03:30.000Z'))}\n`);

    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({ codexLiveAvailable: () => false, machine: MACHINE }).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
      ),
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

    // No Desktop registry on this machine: the Codex root is the whole dataset, and it is unknown.
    expect(dataset.roots.map((root) => [root.key, root.attention])).toEqual([
      [{ harness: 'codex', machineId: MACHINE.id, sourceSessionId: fixture.ids.codexRoot }, 'not-observable'],
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
    expect(root?.interpretations[0]?.text).toBe(
      'Codex records no turn status: whether this session waits on you is unknown — not declared by this harness.',
    );
    expect(dataset.coverage.sessions.revision).toBe('codex-work-chain-revision');
    expect(dataset.totalRoots).toBe(1);
  });
});
