import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageSnapshot } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import {
  createUsageSnapshotFileReader,
  MAX_USAGE_SNAPSHOT_BYTES,
  readUsageSnapshotFile,
  type UsageSnapshotFileHandle,
} from './snapshot-file';

const row = (): SourcedRow => ({
  calls: 1,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  date: new Date('2026-01-01T00:00:00.000Z'),
  durationMs: 60_000,
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  linesAdded: null,
  linesDeleted: null,
  model: 'gpt-5.3-codex',
  name: 'session',
  project: 'ai-usage',
  provider: 'Codex API',
  source: { harnessKey: 'codex', sourceSessionId: 'session-1' },
  tokCr: 0,
  tokCw: 0,
  tokIn: 10,
  tokOut: 5,
  tools: 0,
  turns: 1,
});

describe('usage snapshot files', () => {
  test('reads a current snapshot file', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-snapshot-file-'));
    try {
      const filePath = path.join(directory, 'snapshot.json');
      const snapshot = createUsageSnapshot({
        generatedAt: new Date('2026-01-02T00:00:00.000Z'),
        machine: { id: 'machine-1', label: 'Machine 1' },
        rows: [row()],
      });
      writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');

      const parsed = await Effect.runPromise(readUsageSnapshotFile(filePath));

      expect(parsed.machine.label).toBe('Machine 1');
      expect(parsed.rows).toHaveLength(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('rejects malformed JSON without returning file contents', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-snapshot-malformed-'));
    try {
      const filePath = path.join(directory, 'snapshot.json');
      writeFileSync(filePath, '{"secret":"must-not-escape"', 'utf8');

      const error = await Effect.runPromise(Effect.flip(readUsageSnapshotFile(filePath)));

      expect(error.message).toBe(`Cannot read usage snapshot file: ${filePath}`);
      expect(error.message).not.toContain('must-not-escape');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('rejects invalid UTF-8 and semantically invalid snapshots', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-snapshot-invalid-'));
    try {
      const invalidUtf8Path = path.join(directory, 'invalid-utf8.json');
      const invalidSnapshotPath = path.join(directory, 'invalid-snapshot.json');
      writeFileSync(invalidUtf8Path, new Uint8Array([0xff]));
      writeFileSync(invalidSnapshotPath, '{}', 'utf8');

      for (const inputPath of [invalidUtf8Path, invalidSnapshotPath]) {
        const error = await Effect.runPromise(Effect.flip(readUsageSnapshotFile(inputPath)));
        expect(error.message).toBe(`Cannot read usage snapshot file: ${inputPath}`);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('rejects directories, symlinks, and files over the byte limit', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-snapshot-kind-'));
    try {
      const snapshotPath = path.join(directory, 'snapshot.json');
      const symlinkPath = path.join(directory, 'snapshot-link.json');
      const oversizedPath = path.join(directory, 'oversized.json');
      const childDirectory = path.join(directory, 'child');
      mkdirSync(childDirectory);
      writeFileSync(snapshotPath, '{}');
      symlinkSync(snapshotPath, symlinkPath);
      writeFileSync(oversizedPath, '');
      truncateSync(oversizedPath, MAX_USAGE_SNAPSHOT_BYTES + 1);

      for (const inputPath of [childDirectory, symlinkPath, oversizedPath]) {
        const error = await Effect.runPromise(Effect.flip(readUsageSnapshotFile(inputPath)));
        expect(error.message).toBe(`Cannot read usage snapshot file: ${inputPath}`);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('bounds growth after stat and closes the same file handle', async () => {
    let closed = false;
    let reads = 0;
    const handle: UsageSnapshotFileHandle = {
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      read: (buffer) => {
        reads += 1;
        buffer.fill(0x61);
        return Promise.resolve({ bytesRead: buffer.byteLength });
      },
      stat: () => Promise.resolve({ isFile: () => true, size: 1 }),
    };
    const reader = createUsageSnapshotFileReader(() => Promise.resolve(handle));

    const error = await Effect.runPromise(Effect.flip(reader('/fixture/growing.json')));

    expect(error.message).toBe('Cannot read usage snapshot file: /fixture/growing.json');
    expect(reads).toBeGreaterThan(1);
    expect(closed).toBe(true);
  });

  test('closes the file handle when stat rejects the input', async () => {
    let closed = false;
    const handle: UsageSnapshotFileHandle = {
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      read: () => Promise.resolve({ bytesRead: 0 }),
      stat: () => Promise.resolve({ isFile: () => false, size: 0 }),
    };
    const reader = createUsageSnapshotFileReader(() => Promise.resolve(handle));

    await Effect.runPromise(Effect.flip(reader('/fixture/directory')));

    expect(closed).toBe(true);
  });
});
