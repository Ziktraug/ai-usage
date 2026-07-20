import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageMergeBundle, parseUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { importLocalRows, queryReportRows } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { createUsageFileMergeService, UsageMergeError } from './index';

const localMachine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
const peerMachine: UsageMachine = { id: 'peer-machine', label: 'Peer Machine' };
const generatedAt = new Date('2026-06-19T12:30:00.000Z');

const makeSourcedRow = (input: { project: string; sourcePath: string; sessionId: string }): SourcedRow => ({
  ...normalizeUsageRow({
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Claude Code',
    provider: 'Claude API',
    name: input.sessionId,
    model: 'claude-sonnet-4-6',
    project: input.project,
    tokens: { in: 10, out: 5, cr: 0, cw: 0 },
    cost: approximateApiCost,
    calls: 1,
  }),
  source: {
    harnessKey: 'claude',
    sourceSessionId: input.sessionId,
    sourcePath: input.sourcePath,
  },
});

describe('usage file merge public boundary', () => {
  test('uses a typed public error', () => {
    const error = new UsageMergeError({
      message: 'Cannot import this machine into itself',
      operation: 'importManualMergeBundle',
      reason: 'self-merge',
    });

    expect(error._tag).toBe('UsageMergeError');
  });

  test('reports malformed JSON and invalid merge bundles as invalid input', async () => {
    const service = createUsageFileMergeService({
      dbPath: path.join(tmpdir(), 'unused.sqlite'),
      localMachine,
    });

    for (const text of ['{invalid', JSON.stringify({ version: 1 })]) {
      const error = await Effect.runPromise(service.importManualMergeBundle({ text }).pipe(Effect.flip));

      expect(error).toBeInstanceOf(UsageMergeError);
      expect(error.reason).toBe('invalid-input');
    }
  });

  test('exports local usage as a manual merge bundle file', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-manual-export-'));
    try {
      const dbPath = path.join(home, 'usage.sqlite');
      await Effect.runPromise(
        importLocalRows({
          dbPath,
          machine: localMachine,
          rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
        }),
      );
      const service = createUsageFileMergeService({
        dbPath,
        localMachine,
        now: () => generatedAt,
      });

      const exported = await Effect.runPromise(service.exportManualMergeBundle());

      expect(exported.filename).toBe('ai-usage-local-machine-2026-06-19T12-30-00-000Z.json');
      const bundle = parseUsageMergeBundle(exported.text);
      expect(exported.bytes).toBe(new TextEncoder().encode(exported.text).byteLength);
      expect(exported.rows).toBe(1);
      expect(bundle.machine).toEqual(localMachine);
      expect(bundle.rows).toHaveLength(1);
      expect(bundle.rows[0]?.source.machineId).toBe(localMachine.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('imports a manual merge bundle idempotently', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-manual-import-'));
    try {
      const peerRow = makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-1' });
      const vcs = {
        branches: [],
        headCommit: null,
        partial: false,
        pullRequests: [],
        repository: {
          host: 'github.com',
          ownerPath: 'example/project',
          provenance: 'local-derived' as const,
          webUrl: 'https://github.com/example/project',
        },
      };
      const bundle = createUsageMergeBundle({
        machine: peerMachine,
        rows: [{ ...peerRow, source: { ...peerRow.source, vcs } }],
        warnings: [{ message: 'manual warning' }],
      });
      const service = createUsageFileMergeService({
        dbPath: path.join(home, 'usage.sqlite'),
        localMachine,
        now: () => generatedAt,
      });

      const imported = await Effect.runPromise(service.importManualMergeBundle({ text: JSON.stringify(bundle) }));
      const repeated = await Effect.runPromise(service.importManualMergeBundle({ text: JSON.stringify(bundle) }));

      expect(imported).toMatchObject({
        machine: peerMachine,
        rows: 1,
        warnings: 1,
        result: { inserted: 1 },
      });
      expect(repeated.result.unchanged).toBe(1);
      expect(bundle.version).toBe(3);
      expect(
        (await Effect.runPromise(queryReportRows({ dbPath: path.join(home, 'usage.sqlite') }))).rows[0]?.source.vcs,
      ).toEqual(vcs);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('previews without mutation and binds confirmation to raw bytes and store state', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'usage-merge-preview-'));
    try {
      const dbPath = path.join(home, 'usage.sqlite');
      const service = createUsageFileMergeService({ dbPath, localMachine, now: () => generatedAt });
      const bundle = createUsageMergeBundle({
        machine: peerMachine,
        rows: [makeSourcedRow({ project: 'peer', sessionId: 'peer-preview', sourcePath: '/peer/project' })],
        generatedAt,
      });
      const text = `${JSON.stringify(bundle)}\n`;
      const bytes = new TextEncoder().encode(text);
      const preview = await Effect.runPromise(service.previewManualMergeBundle({ bytes, text }));
      await expect(Bun.file(dbPath).exists()).resolves.toBe(false);
      expect(preview.inserted).toBe(1);
      expect(preview.digest).toHaveLength(64);

      await expect(
        Effect.runPromise(
          service.confirmManualMergeBundle({
            bytes: new TextEncoder().encode(`${text} `),
            text,
            expectedDigest: preview.digest,
            expectedStoreGeneration: preview.storeGeneration,
            expectedStoreStateToken: preview.storeStateToken,
          }),
        ),
      ).rejects.toThrow('changed after preview');
      const confirmed = await Effect.runPromise(
        service.confirmManualMergeBundle({
          bytes,
          text,
          expectedDigest: preview.digest,
          expectedStoreGeneration: preview.storeGeneration,
          expectedStoreStateToken: preview.storeStateToken,
        }),
      );
      expect(confirmed.result.inserted).toBe(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('rejects manual self-imports', async () => {
    const service = createUsageFileMergeService({
      dbPath: path.join(tmpdir(), 'unused.sqlite'),
      localMachine,
    });
    const bundle = createUsageMergeBundle({
      machine: localMachine,
      rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
    });

    const error = await Effect.runPromise(
      service.importManualMergeBundle({ text: JSON.stringify(bundle) }).pipe(Effect.flip),
    );

    expect(error.reason).toBe('self-merge');
  });
});
