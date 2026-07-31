import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type FocusedReportSupport, focusedRevisionFingerprint } from '@ai-usage/report-core/focused-report-query';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { Effect } from 'effect';
import {
  queryCurrentServedLocalProjectSources,
  queryCurrentServedReportRevision,
  queryCurrentServedReportRevisionBootstrap,
  queryServedReportRevisionLocalSnapshot,
  queryServedReportRevisionPortableConfig,
  queryServedReportRevisionRows,
  queryServedReportRevisionSlices,
  queryServedReportRevisionSupport,
  queryServedRevisionData,
  queryUsageStoreGenerations,
  type UsageStoreError,
} from './reader';
import { setServedReportPublicationFaultInjectorForTesting } from './testing';
import {
  importLocalRows,
  type PublishServedReportRevisionCapture,
  type PublishServedReportRevisionInput,
  publishServedReportRevision,
  retainServedReportRevisions,
  type ServedReportPublicationPhase,
  updateUsageMachineLabel,
} from './writer';

const roots: string[] = [];
const clearFaultInjectors: Array<() => void> = [];
const readerChildren = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  for (const clear of clearFaultInjectors.splice(0)) {
    clear();
  }
  await Promise.all(
    [...readerChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
  readerChildren.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-served-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(
    importLocalRows({ dbPath, machine: { id: 'served-machine', label: 'Served Machine' }, rows: [] }),
  );
  await Effect.runPromise(
    updateUsageMachineLabel({ dbPath, machine: { id: 'served-machine', label: 'Served Machine' } }),
  );
  return dbPath;
};

const row = (
  name: string,
  tokenTotal: number,
  options: { readonly project?: string; readonly sourcePath?: string } = {},
): SerializedRow => ({
  activeDate: '2026-07-01T10:01:00.000Z',
  calls: 1,
  costActual: tokenTotal / 100,
  costApprox: tokenTotal / 100,
  costKnown: true,
  costQuota: 0,
  date: '2026-07-01T10:00:00.000Z',
  durationMs: 1000,
  endDate: '2026-07-01T10:01:00.000Z',
  freshTokens: tokenTotal,
  harness: 'Codex',
  lineDelta: 1,
  linesAdded: 1,
  linesDeleted: 0,
  model: 'gpt-5',
  name,
  project: options.project ?? 'ai-usage',
  provider: 'OpenAI',
  sessionLabel: name,
  source: {
    harnessKey: 'codex',
    machineId: 'served-machine',
    machineLabel: 'Served Machine',
    rootSourceSessionId: name,
    sourceSessionId: name,
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
  },
  tokCr: 0,
  tokCw: 0,
  tokIn: tokenTotal,
  tokOut: 0,
  tokenTotal,
  tools: 0,
  turns: 1,
});

const support = (
  sessionCount: number,
  generatedAt = '2026-07-29T12:00:00.000Z',
  machineLabel = 'Served Machine',
): FocusedReportSupport => ({
  analytics: {
    averageDurationMs: null,
    byHarness: [],
    byModel: [],
    byProvider: [],
    costPer100Lines: null,
    durationMs: 0,
    durationRows: 0,
    lineCount: 0,
    linesA: 0,
    linesD: 0,
    meanCost: 0,
    medianCost: 0,
    pricedCount: 0,
    recentSessions: 0,
    sessionCount,
    tools: 0,
    totalCost: 0,
    turns: 0,
    unpricedCount: 0,
  },
  filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt,
  machineFreshness: {
    kind: 'available',
    machines: [{ id: 'served-machine', label: machineLabel, lastSeenAt: generatedAt }],
    observedAt: generatedAt,
    omittedMachines: 0,
    skippedRows: 0,
  },
  omittedRows: 0,
});

type PublicationOverrides = Partial<Omit<PublishServedReportRevisionInput, 'assemble'>> & {
  readonly capture?: Partial<PublishServedReportRevisionCapture>;
};

const publication = (
  dbPath: string,
  revision: string,
  rows: readonly SerializedRow[],
  overrides: PublicationOverrides = {},
): PublishServedReportRevisionInput => {
  const { capture: captureOverrides, ...inputOverrides } = overrides;
  const captureRows = captureOverrides?.rows ?? rows;
  const reportSupport = captureOverrides?.support ?? support(captureRows.length);
  const sourceAuthorities = captureOverrides?.sourceAuthorities ?? captureRows.map(() => 'local-observed' as const);
  return {
    assemble: () => ({
      configFingerprint: 'c'.repeat(64),
      generatedAt: '2026-07-29T12:00:00.000Z',
      projectAliases: [],
      projectGroupConfigs: [],
      rows: captureRows,
      sourceAuthorities,
      support: reportSupport,
      ...captureOverrides,
    }),
    dbPath,
    now: 1000,
    revision,
    ttlMs: 300_000,
    ...inputOverrides,
  };
};

const failureReason = async (effect: Effect.Effect<unknown, UsageStoreError>): Promise<string | undefined> => {
  const result = await Effect.runPromise(Effect.either(effect));
  return result._tag === 'Left' ? result.left.reason : undefined;
};

test('projects only local observed project paths from the current durable revision', async () => {
  const dbPath = await createStore();
  const rows = [
    row('local-a', 1, { project: 'Local Project', sourcePath: '/private/local-project' }),
    row('local-b', 2, { project: 'Local Project', sourcePath: '/private/local-project' }),
    row('portable', 3, { project: 'Imported Project', sourcePath: '/private/imported-project' }),
  ];
  await Effect.runPromise(
    publishServedReportRevision(
      publication(dbPath, 'revision-a', rows, {
        capture: { sourceAuthorities: ['local-observed', 'local-observed', 'portable-opaque'] },
      }),
    ),
  );

  expect(await Effect.runPromise(queryCurrentServedLocalProjectSources({ dbPath, now: 1500 }))).toEqual({
    revision: 'revision-a',
    sources: [
      {
        label: 'Local Project',
        machineId: 'served-machine',
        machineLabel: 'Served Machine',
        project: 'Local Project',
        sessions: 2,
        sourcePath: '/private/local-project',
      },
    ],
  });
});

test('reads an exact revision local snapshot without exposing portable rows or following current', async () => {
  const dbPath = await createStore();
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: { id: 'served-machine', label: 'Served Machine' },
      updatedAt: new Date('2026-07-29T11:59:00.000Z'),
    }),
  );
  const revisionARows = [row('local-a', 1), row('portable-a', 2)];
  await Effect.runPromise(
    publishServedReportRevision(
      publication(dbPath, 'revision-local-a', revisionARows, {
        capture: {
          projectAliases: [{ match: ['raw-project'], name: 'Aliased Project' }],
          projectGroupConfigs: [{ id: 'group-a', name: 'Grouped Project', sources: [{ project: 'raw-project' }] }],
          sourceAuthorities: ['local-observed', 'portable-opaque'],
        },
      }),
    ),
  );
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: { id: 'renamed-machine', label: 'Renamed Machine' },
      updatedAt: new Date('2026-07-29T12:01:00.000Z'),
    }),
  );
  await Effect.runPromise(
    publishServedReportRevision(
      publication(dbPath, 'revision-local-b', [], {
        capture: { support: support(0, '2026-07-29T12:02:00.000Z', 'Renamed Machine') },
        now: 1500,
      }),
    ),
  );
  const traces: Array<{ readonly params: readonly unknown[]; readonly sql: string }> = [];

  const result = await Effect.runPromise(
    queryServedReportRevisionLocalSnapshot({
      dbPath,
      now: 2000,
      revision: 'revision-local-a',
      trace: (query) => traces.push(query),
    }),
  );

  expect(result.manifest.revision).toBe('revision-local-a');
  expect(result.machine).toEqual({ id: 'served-machine', label: 'Served Machine' });
  expect(result.rows.map(({ name }) => name)).toEqual(['local-a']);
  expect(result.support).toEqual(support(2));
  expect(traces.some(({ sql }) => sql.includes(`LIMIT ${MAX_PORTABLE_USAGE_ROWS + 1}`))).toBe(true);
  expect(
    await Effect.runPromise(
      queryServedReportRevisionPortableConfig({ dbPath, now: 2000, revision: 'revision-local-a' }),
    ),
  ).toMatchObject({
    projectAliases: [{ match: ['raw-project'], name: 'Aliased Project' }],
    projectGroupConfigs: [{ id: 'group-a', name: 'Grouped Project' }],
  });

  const emptyRevision = await Effect.runPromise(
    queryServedReportRevisionLocalSnapshot({ dbPath, now: 2000, revision: 'revision-local-b' }),
  );
  expect(emptyRevision.machine).toEqual({ id: 'renamed-machine', label: 'Renamed Machine' });
  expect(emptyRevision.rows).toEqual([]);
  expect(
    await Effect.runPromise(
      queryServedReportRevisionPortableConfig({ dbPath, now: 2000, revision: 'revision-local-b' }),
    ),
  ).toMatchObject({ projectAliases: [], projectGroupConfigs: [] });
});

test('rejects an oversized local project-source projection without accumulating every row', async () => {
  const dbPath = await createStore();
  const rows = Array.from({ length: 600 }, (_, index) =>
    row(`local-${index}`, index + 1, {
      project: `Local Project ${index}`,
      sourcePath: `/private/${'x'.repeat(850)}/${index}`,
    }),
  );
  await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-large-sources', rows)));

  const error = await Effect.runPromise(Effect.flip(queryCurrentServedLocalProjectSources({ dbPath, now: 1500 })));

  expect(error).toMatchObject({ reason: 'invalid-input' });
  expect(error.message).toContain('exceed 524288 bytes');
});

test('bounds the local project-source input scan to the maximum valid served revision', async () => {
  const dbPath = await createStore();
  await Effect.runPromise(
    publishServedReportRevision(
      publication(dbPath, 'revision-bounded-sources', [
        row('local', 1, { project: 'Local Project', sourcePath: '/private/local-project' }),
      ]),
    ),
  );
  const traces: Array<{ readonly params: readonly unknown[]; readonly sql: string }> = [];

  const result = await Effect.runPromise(
    queryCurrentServedLocalProjectSources({
      dbPath,
      now: 1500,
      trace: (query) => traces.push(query),
    }),
  );

  expect(result.sources).toHaveLength(1);
  expect(traces).toHaveLength(1);
  expect(traces[0]?.sql).toContain(`LIMIT ${MAX_PORTABLE_USAGE_ROWS + 1}`);
  expect(traces[0]?.params).toEqual(Array.from({ length: 4 }, () => 'revision-bounded-sources'));
});

test('rejects publication above the local project-source input ceiling before projection', async () => {
  const dbPath = await createStore();
  const repeatedRow = row('same-project', 1, {
    project: 'Local Project',
    sourcePath: '/private/local-project',
  });
  const oversizedRows = Array.from({ length: MAX_PORTABLE_USAGE_ROWS + 1 }, () => repeatedRow);

  const result = await Effect.runPromise(
    Effect.either(publishServedReportRevision(publication(dbPath, 'revision-too-many-sources', oversizedRows))),
  );

  expect(result._tag).toBe('Left');
  if (result._tag === 'Left') {
    expect(result.left.message).toContain('row budget');
  }
  expect(await failureReason(queryCurrentServedReportRevision({ dbPath, now: 1500 }))).toBe('revision-unavailable');
});

const CONCURRENT_GENERATION_WRITER_SCRIPT = `
  import { Database } from 'bun:sqlite';
  const dbPath = process.env.AI_USAGE_TEST_DATABASE_PATH;
  if (!dbPath) throw new Error('Missing isolated test database path');
  const database = new Database(dbPath, { create: false, readwrite: true });
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('BEGIN IMMEDIATE');
  database.query("UPDATE usage_store_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'generation'").run();
  database.exec('COMMIT');
  database.close(true);
`;

interface BarrierReader {
  readonly complete: () => Promise<string>;
  readonly release: () => void;
}

const USAGE_STORE_READER_MODULE_URL = new URL('./reader.ts', import.meta.url).href;
const USAGE_STORE_TESTING_MODULE_URL = new URL('./testing.ts', import.meta.url).href;

const startBarrierReader = async (dbPath: string, revision: string): Promise<BarrierReader> => {
  const program = `
    const fs = await import('node:fs');
    const { Effect } = await import('effect');
    const { queryServedReportRevisionRows } = await import(${JSON.stringify(USAGE_STORE_READER_MODULE_URL)});
    const { setServedReportReadFaultInjectorForTesting } = await import(${JSON.stringify(USAGE_STORE_TESTING_MODULE_URL)});
    const clear = setServedReportReadFaultInjectorForTesting((phase) => {
      if (phase === 'after-resolve') {
        fs.writeSync(1, 'ready\\n');
        fs.readFileSync(0, 'utf8');
      }
    });
    const result = await Effect.runPromise(queryServedReportRevisionRows(
      { dbPath: ${JSON.stringify(dbPath)}, now: 2000, revision: ${JSON.stringify(revision)} },
    ));
    clear();
    fs.writeSync(1, 'result:' + JSON.stringify(result) + '\\n');
  `;
  const child = spawn(process.execPath, ['-e', program]);
  readerChildren.add(child);
  let errorOutput = '';
  let output = '';
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('ready\n')) {
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('ready\n')) {
        reject(new Error(`Revision reader exited before its barrier with code ${code}: ${errorOutput}`));
      }
    });
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Revision reader exited with code ${code}: ${errorOutput}`));
    });
  });
  return {
    complete: async () => {
      await completion;
      readerChildren.delete(child);
      return output;
    },
    release: () => child.stdin.end('continue\n'),
  };
};

describe('durable served report revisions', () => {
  test('publishes a complete revision and reads its public slices without source authority', async () => {
    const dbPath = await createStore();
    const rows = [row('first', 1), row('second', 2)];

    const result = await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', rows)));
    const current = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 2000 }));
    const slices = await Effect.runPromise(
      queryServedReportRevisionSlices({ dbPath, now: 2000, revision: 'revision-a' }),
    );

    expect(result).toMatchObject({ changed: true, renewed: false });
    expect(current.revision).toBe('revision-a');
    expect(slices.rows).toEqual(rows);
    expect(slices.support).toEqual(support(2));
    expect(JSON.stringify(slices)).not.toContain('local-observed');
  });

  test('resolves the current manifest and support bootstrap inside one read snapshot', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));

    const bootstrap = await Effect.runPromise(queryCurrentServedReportRevisionBootstrap({ dbPath, now: 2000 }));

    expect(bootstrap.manifest.revision).toBe('revision-a');
    expect(bootstrap.support).toMatchObject({
      requestFingerprint: focusedRevisionFingerprint('support', { revision: 'revision-a' }),
      revision: 'revision-a',
      support: {
        analytics: { sessionCount: 1 },
      },
    });
  });

  test('exposes only the closed query catalog and rejects unknown query kinds', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const readerExports = await import('./reader');

    expect('readServedReportRevision' in readerExports).toBe(false);
    expect(
      await failureReason(
        queryServedRevisionData({
          dbPath,
          kind: 'raw-sql' as never,
          now: 2000,
          request: { revision: 'revision-a', sql: 'SELECT * FROM usage_rows' },
          revision: 'revision-a',
        }),
      ),
    ).toBe('invalid-input');
  });

  test('keeps an open revision-A snapshot isolated while revision B publishes', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const reader = await startBarrierReader(dbPath, 'revision-a');

    await Effect.runPromise(
      publishServedReportRevision(publication(dbPath, 'revision-b', [row('b', 2)], { now: 1500 })),
    );
    reader.release();
    const output = await reader.complete();
    const resultLine = output.split('\n').find((line) => line.startsWith('result:'));
    if (!resultLine) {
      throw new Error(`Revision reader returned no result: ${output}`);
    }
    const result = JSON.parse(resultLine.slice('result:'.length)) as {
      manifest: { revision: string };
      rows: SerializedRow[];
    };

    expect(result.manifest.revision).toBe('revision-a');
    expect(result.rows.map(({ name }) => name)).toEqual(['a']);
    expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 2000 }))).revision).toBe(
      'revision-b',
    );
  });

  test('rolls back every publication phase and leaves the previous pointer authoritative', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const phases: ServedReportPublicationPhase[] = [
      'after-generation-read',
      'after-metadata',
      'after-support',
      'after-projection',
      'after-validation',
      'after-complete',
      'after-pointer',
    ];
    for (const [index, phase] of phases.entries()) {
      const revision = `revision-b-${index}`;
      const clear = setServedReportPublicationFaultInjectorForTesting((visited) => {
        if (visited === phase) {
          throw new Error(`Injected failure at ${phase}`);
        }
      });
      clearFaultInjectors.push(clear);
      expect(
        await failureReason(publishServedReportRevision(publication(dbPath, revision, [row(`b-${index}`, index + 2)]))),
      ).toBe('storage-failure');
      clear();
      clearFaultInjectors.pop();
      expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 2000 }))).revision).toBe(
        'revision-a',
      );
      expect(await failureReason(queryServedReportRevisionSlices({ dbPath, revision }))).toBe('revision-unavailable');
    }
  });

  test('renews matching private captures at the exact window without rematerializing', async () => {
    const dbPath = await createStore();
    const originalRows = [row('a', 1)];
    const original = publication(dbPath, 'revision-a', originalRows, { expiresAt: 301_000 });
    const first = await Effect.runPromise(publishServedReportRevision(original));
    const renewed = await Effect.runPromise(
      publishServedReportRevision({ ...original, now: 241_000, revision: 'revision-unused', ttlMs: 300_000 }),
    );

    expect(first.changed).toBe(true);
    expect(renewed).toMatchObject({ changed: false, renewed: true });
    expect(renewed.manifest.revision).toBe('revision-a');
    expect(renewed.manifest.generatedAt).toBe('2026-07-29T12:00:00.000Z');
    expect(renewed.manifest.publishedAt).toBe(241_000);
    expect(
      (await Effect.runPromise(queryServedReportRevisionSlices({ dbPath, now: 241_000, revision: 'revision-a' }))).rows,
    ).toEqual(originalRows);
  });

  test('rejects an invalid capture before publication', async () => {
    const dbPath = await createStore();

    expect(
      await failureReason(
        publishServedReportRevision(
          publication(dbPath, 'revision-a', [row('a', 1)], {
            capture: { configFingerprint: 'invalid' },
          }),
        ),
      ),
    ).toBe('storage-failure');
    expect(await failureReason(queryCurrentServedReportRevision({ dbPath }))).toBe('revision-unavailable');
  });

  test('rejects invalid publication timing before writer acquisition or assembly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-invalid-publication-'));
    roots.push(root);
    const dbPath = path.join(root, 'missing.sqlite');
    let assembled = false;
    const input = publication(dbPath, 'revision-a', [row('a', 1)], { now: Number.NaN });

    expect(
      await failureReason(
        publishServedReportRevision({
          ...input,
          assemble: (context) => {
            assembled = true;
            return input.assemble(context);
          },
        }),
      ),
    ).toBe('invalid-input');
    expect(assembled).toBe(false);
    expect(await Bun.file(dbPath).exists()).toBe(false);
  });

  test('assembles from generations read under the publication writer lock', async () => {
    const dbPath = await createStore();
    const before = await Effect.runPromise(queryUsageStoreGenerations({ dbPath }));
    const input = publication(dbPath, 'revision-a', [row('a', 1)]);
    let assemblyGenerations = before;
    let competingWriter: ReturnType<typeof Bun.spawn> | undefined;
    let competingWriterWasBlocked = false;

    const published = await Effect.runPromise(
      publishServedReportRevision({
        ...input,
        assemble: async (context) => {
          assemblyGenerations = context.generations;
          competingWriter = Bun.spawn([process.execPath, '-e', CONCURRENT_GENERATION_WRITER_SCRIPT], {
            env: { AI_USAGE_TEST_DATABASE_PATH: dbPath },
            stderr: 'ignore',
            stdout: 'ignore',
          });
          await Bun.sleep(100);
          competingWriterWasBlocked = competingWriter.exitCode === null;
          return await input.assemble(context);
        },
      }),
    );
    if (!competingWriter) {
      throw new Error('Expected the competing writer process to start');
    }
    const competingExitCode = await competingWriter.exited;
    if (competingExitCode !== 0) {
      throw new Error(`Competing writer exited with code ${competingExitCode}`);
    }
    const after = await Effect.runPromise(queryUsageStoreGenerations({ dbPath }));

    expect(competingWriterWasBlocked).toBe(true);
    expect(assemblyGenerations).toEqual(before);
    expect(published.manifest).toMatchObject({
      machineFleetGeneration: before.machineFleetGeneration,
      usageStoreGeneration: before.usageStoreGeneration,
    });
    expect(after.usageStoreGeneration).toBe(before.usageStoreGeneration + 1);
  });

  test('reconciles a committed publication when completion reports an ambiguous failure', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const clear = setServedReportPublicationFaultInjectorForTesting((phase) => {
      if (phase === 'after-commit') {
        throw new Error('Injected ambiguous commit completion');
      }
    });
    clearFaultInjectors.push(clear);

    const published = await Effect.runPromise(
      publishServedReportRevision(publication(dbPath, 'revision-b', [row('b', 2)], { now: 1500 })),
    );
    clear();
    clearFaultInjectors.pop();

    expect(published).toMatchObject({ changed: true, renewed: false });
    expect(published.manifest.revision).toBe('revision-b');
    expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 2000 }))).revision).toBe(
      'revision-b',
    );
  });

  test('republishes instead of renewing a matching but corrupt current revision', async () => {
    const dbPath = await createStore();
    const captureRows = [row('same', 1)];
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', captureRows)));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database.query('DELETE FROM served_report_rows WHERE revision = ?').run('revision-a');
    database.close(true);

    const repaired = await Effect.runPromise(
      publishServedReportRevision(publication(dbPath, 'revision-b', captureRows, { now: 2000 })),
    );

    expect(repaired).toMatchObject({ changed: true, renewed: false });
    expect(repaired.manifest.revision).toBe('revision-b');
    expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 2500 }))).revision).toBe(
      'revision-b',
    );
  });

  test('keeps the current revision readable past its TTL and expires it only after supersession', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(
      publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)], { expiresAt: 2000 })),
    );

    expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 2000 }))).revision).toBe(
      'revision-a',
    );
    expect(
      (await Effect.runPromise(queryServedReportRevisionSlices({ dbPath, now: 2500, revision: 'revision-a' }))).rows,
    ).toEqual([row('a', 1)]);
    expect(await Effect.runPromise(retainServedReportRevisions({ dbPath, now: 2500 }))).toMatchObject({
      deletedRevisions: 0,
    });

    await Effect.runPromise(
      publishServedReportRevision(publication(dbPath, 'revision-b', [row('b', 2)], { expiresAt: 4000, now: 3000 })),
    );

    expect(await failureReason(queryServedReportRevisionSlices({ dbPath, now: 3000, revision: 'revision-a' }))).toBe(
      'revision-expired',
    );
    expect(await failureReason(queryServedReportRevisionSlices({ dbPath, now: Number.NaN }))).toBe('invalid-input');
  });

  test('maps invalid projection content to corrupt instead of a generic storage failure', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database.query('UPDATE served_report_support SET support_json = ? WHERE revision = ?').run('{', 'revision-a');
    database.close(true);

    expect(await failureReason(queryServedReportRevisionSlices({ dbPath, now: 2000, revision: 'revision-a' }))).toBe(
      'corrupt',
    );
  });

  test('maps missing and malformed revision-local context to corrupt', async () => {
    for (const corruption of ['missing', 'malformed'] as const) {
      const dbPath = await createStore();
      await Effect.runPromise(
        publishServedReportRevision(publication(dbPath, `revision-context-${corruption}`, [row('a', 1)])),
      );
      const { Database } = await import('bun:sqlite');
      const database = new Database(dbPath, { create: false, readwrite: true });
      if (corruption === 'missing') {
        database
          .query('DELETE FROM served_report_local_context WHERE revision = ?')
          .run(`revision-context-${corruption}`);
      } else {
        database
          .query('UPDATE served_report_local_context SET context_json = ? WHERE revision = ?')
          .run('{', `revision-context-${corruption}`);
      }
      database.close(true);

      expect(
        await failureReason(
          queryServedReportRevisionLocalSnapshot({
            dbPath,
            now: 2000,
            revision: `revision-context-${corruption}`,
          }),
        ),
      ).toBe('corrupt');
      expect(
        await failureReason(
          queryServedReportRevisionPortableConfig({
            dbPath,
            now: 2000,
            revision: `revision-context-${corruption}`,
          }),
        ),
      ).toBe('corrupt');
    }
  });

  test('rejects syntactically valid but structurally invalid support as corrupt', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database
      .query('UPDATE served_report_support SET support_json = ?, support_bytes = 2 WHERE revision = ?')
      .run('{}', 'revision-a');
    database.query('UPDATE served_report_revisions SET support_bytes = 2 WHERE revision = ?').run('revision-a');
    database.close(true);

    expect(await failureReason(queryServedReportRevisionSupport({ dbPath, now: 2000, revision: 'revision-a' }))).toBe(
      'corrupt',
    );
  });

  test('reads support without loading or validating the revision row slice', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(publishServedReportRevision(publication(dbPath, 'revision-a', [row('a', 1)])));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database.query('UPDATE served_report_rows SET source_row_json = ? WHERE revision = ?').run('{', 'revision-a');
    database.close(true);

    expect(
      (await Effect.runPromise(queryServedReportRevisionSupport({ dbPath, now: 2000, revision: 'revision-a' })))
        .support,
    ).toEqual(support(1));
    expect(await failureReason(queryServedReportRevisionRows({ dbPath, now: 2000, revision: 'revision-a' }))).toBe(
      'corrupt',
    );
  });

  test('bounds retained complete revisions while preserving the current pointer', async () => {
    const dbPath = await createStore();
    for (const [index, revision] of ['revision-a', 'revision-b', 'revision-c', 'revision-d'].entries()) {
      await Effect.runPromise(
        publishServedReportRevision(
          publication(dbPath, revision, [row(revision, index + 1)], {
            now: 1000 + index,
            ttlMs: 100_000,
          }),
        ),
      );
    }

    const retained = await Effect.runPromise(retainServedReportRevisions({ dbPath, maximumRevisions: 2, now: 5000 }));

    const { Database } = await import('bun:sqlite');
    const planDatabase = new Database(dbPath, { create: false, readonly: true });
    const retentionPlan = planDatabase
      .query(`
        EXPLAIN QUERY PLAN
        SELECT revision
        FROM served_report_revisions
        WHERE complete = 1 AND expires_at <= ?
        ORDER BY complete, expires_at, published_at, revision
      `)
      .all(5000) as Array<{ detail?: unknown }>;
    const retainedContexts = planDatabase
      .query('SELECT revision FROM served_report_local_context ORDER BY revision')
      .all() as Array<{ revision: string }>;
    planDatabase.close(true);

    expect(retained).toMatchObject({ deletedRevisions: 2, deletedRows: 2, expiredRevisions: 2 });
    expect(retentionPlan.some(({ detail }) => String(detail).includes('idx_served_report_revisions_retention'))).toBe(
      true,
    );
    expect(retainedContexts.map(({ revision }) => revision)).toEqual(['revision-c', 'revision-d']);
    expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 5000 }))).revision).toBe(
      'revision-d',
    );
    expect(await failureReason(queryServedReportRevisionSlices({ dbPath, now: 5000, revision: 'revision-a' }))).toBe(
      'revision-unavailable',
    );
    expect(
      (await Effect.runPromise(queryServedReportRevisionSlices({ dbPath, now: 5000, revision: 'revision-c' }))).rows,
    ).toHaveLength(1);
  });

  test('enforces retained row and logical-byte caps independently', async () => {
    for (const limit of ['rows', 'bytes'] as const) {
      const dbPath = await createStore();
      let currentBytes = 0;
      for (const [index, revision] of ['revision-a', 'revision-b', 'revision-c'].entries()) {
        const published = await Effect.runPromise(
          publishServedReportRevision(
            publication(dbPath, revision, [row(`${limit}-${revision}`, index + 1)], {
              now: 1000 + index,
              ttlMs: 100_000,
            }),
          ),
        );
        currentBytes = published.manifest.projectionBytes + published.manifest.supportBytes;
      }

      const retained = await Effect.runPromise(
        retainServedReportRevisions({
          dbPath,
          maximumBytes: limit === 'bytes' ? currentBytes : Number.MAX_SAFE_INTEGER,
          maximumRevisions: 10,
          maximumRows: limit === 'rows' ? 1 : Number.MAX_SAFE_INTEGER,
          now: 5000,
        }),
      );

      expect(retained).toMatchObject({ deletedRevisions: 2, expiredRevisions: 2 });
      expect((await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: 5000 }))).revision).toBe(
        'revision-c',
      );
    }
  });

  test('deletes only abandoned incomplete staging rows after the grace period', async () => {
    const dbPath = await createStore();
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database
      .query(`
        INSERT INTO served_report_revisions (
          revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
          usage_store_generation, machine_fleet_generation, projection_schema_version,
          generated_at, published_at, expires_at, complete, row_count, segment_count,
          filter_key_count, rows_bytes, support_bytes, projection_bytes
        ) VALUES (?, ?, ?, ?, 0, 0, 15, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
      `)
      .run(
        'abandoned-staging',
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
        '2026-07-29T12:00:00.000Z',
        1000,
        100_000,
      );
    database.close(true);

    expect(
      await Effect.runPromise(retainServedReportRevisions({ abandonedAfterMs: 1000, dbPath, now: 2000 })),
    ).toMatchObject({ deletedRevisions: 1, expiredRevisions: 0 });
  });
});
