import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatavizPrototypeSnapshot } from '@ai-usage/web-contract/dataviz-prototype';
import { call } from '@orpc/server';
import { createDatavizPrototypeRouter } from './dataviz-prototype.server';

test('snapshot is disabled by default even with a configured file and validates an enabled capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dataviz-contract-'));
  const previous = process.env.AI_USAGE_DATAVIZ_SNAPSHOT;
  try {
    const file = join(directory, 'snapshot.json');
    process.env.AI_USAGE_DATAVIZ_SNAPSHOT = file;
    const snapshot: DatavizPrototypeSnapshot = {
      version: 1,
      revision: 'r',
      capturedAt: '2026-09-09T12:00:00Z',
      generatedAt: '2026-09-09T12:00:00Z',
      rows: [],
      details: [],
    };
    await writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
    await expect(call(createDatavizPrototypeRouter().snapshot, {})).rejects.toMatchObject({
      code: 'Unavailable',
      data: { reason: 'prototype-disabled' },
    });
    expect(await call(createDatavizPrototypeRouter(true).snapshot, {})).toEqual(snapshot);
    await writeFile(file, JSON.stringify({ ...snapshot, unexpected: 'not in DTO' }));
    await expect(call(createDatavizPrototypeRouter(true).snapshot, {})).rejects.toThrow();
  } finally {
    if (previous === undefined) {
      delete process.env.AI_USAGE_DATAVIZ_SNAPSHOT;
    } else {
      process.env.AI_USAGE_DATAVIZ_SNAPSHOT = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
