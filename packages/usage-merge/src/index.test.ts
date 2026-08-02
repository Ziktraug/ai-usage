import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { createUsageFileMergeService, MAX_MANUAL_MERGE_PREVIEW_WARNINGS, UsageMergeError } from './index';

const roots: string[] = [];
const RAW_WARNING_WHITESPACE_PATTERN = /[\n\t]/;
const localMachine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
const peerMachine: UsageMachine = { id: 'peer-machine', label: 'Peer Machine' };
const generatedAt = new Date('2026-08-02T12:00:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

const mergeDocument = () => {
  const bundle = createUsageMergeBundle({
    generatedAt,
    machine: peerMachine,
    rows: [
      {
        ...normalizeUsageRow({
          calls: 1,
          cost: approximateApiCost,
          date: generatedAt,
          endDate: new Date(generatedAt.getTime() + 1000),
          harness: 'Claude Code',
          model: 'claude-sonnet-4-6',
          name: 'peer-session',
          project: 'peer-project',
          provider: 'Claude API',
          tokens: { cr: 0, cw: 0, in: 10, out: 5 },
        }),
        source: {
          harnessKey: 'claude' as const,
          sourcePath: '/fixture/peer',
          sourceSessionId: 'peer-session',
        },
      },
    ],
  });
  const text = `${JSON.stringify(bundle)}\n`;
  return { bytes: new TextEncoder().encode(text), text };
};

describe('usage merge workflow owner', () => {
  test('distinguishes malformed JSON from an invalid merge contract', async () => {
    const service = createUsageFileMergeService({ dbPath: '/unused.sqlite', localMachine });
    const malformed = await Effect.runPromise(
      service.previewManualMergeBundle({ bytes: new Uint8Array(), text: '{invalid' }).pipe(Effect.flip),
    );
    const invalid = await Effect.runPromise(
      service.previewManualMergeBundle({ bytes: new Uint8Array(), text: '{}' }).pipe(Effect.flip),
    );

    expect(malformed).toBeInstanceOf(UsageMergeError);
    expect(malformed.reason).toBe('invalid-json');
    expect(invalid.reason).toBe('invalid-input');
  });

  test('binds confirmation to the previewed bytes and store state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-merge-owner-'));
    roots.push(root);
    const service = createUsageFileMergeService({
      dbPath: path.join(root, 'usage.sqlite'),
      localMachine,
      now: () => generatedAt,
    });
    const document = mergeDocument();
    const preview = await Effect.runPromise(service.previewManualMergeBundle(document));

    const stale = await Effect.runPromise(
      service
        .confirmManualMergeBundle({
          ...document,
          bytes: new TextEncoder().encode(`${document.text} `),
          confirmationToken: preview.confirmationToken,
          expectedDigest: preview.digest,
        })
        .pipe(Effect.flip),
    );
    expect(stale.reason).toBe('preview-stale');

    const confirmed = await Effect.runPromise(
      service.confirmManualMergeBundle({
        ...document,
        confirmationToken: preview.confirmationToken,
        expectedDigest: preview.digest,
      }),
    );
    expect(confirmed.result.inserted).toBe(1);
  });

  test('rejects self-merge during preview through the public typed error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-merge-self-'));
    roots.push(root);
    const service = createUsageFileMergeService({
      dbPath: path.join(root, 'usage.sqlite'),
      localMachine,
    });
    const text = JSON.stringify(createUsageMergeBundle({ machine: localMachine, rows: [] }));

    const error = await Effect.runPromise(
      service.previewManualMergeBundle({ bytes: new TextEncoder().encode(text), text }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(UsageMergeError);
    expect(error.reason).toBe('self-merge');
  });

  test('bounds and sanitizes warning projection while preserving the total', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-merge-warnings-'));
    roots.push(root);
    const service = createUsageFileMergeService({
      dbPath: path.join(root, 'usage.sqlite'),
      localMachine,
    });
    const warnings = Array.from({ length: MAX_MANUAL_MERGE_PREVIEW_WARNINGS + 5 }, (_, index) => ({
      message: `warning\n ${index}\t${'x'.repeat(600)}`,
    }));
    const text = JSON.stringify(createUsageMergeBundle({ machine: peerMachine, rows: [], warnings }));

    const preview = await Effect.runPromise(
      service.previewManualMergeBundle({ bytes: new TextEncoder().encode(text), text }),
    );

    expect(preview.warningCount).toBe(warnings.length);
    expect(preview.warningItems).toHaveLength(MAX_MANUAL_MERGE_PREVIEW_WARNINGS);
    expect(preview.warningItems.every((warning) => warning.length <= 512)).toBe(true);
    expect(preview.warningItems.every((warning) => !RAW_WARNING_WHITESPACE_PATTERN.test(warning))).toBe(true);
  });
});
