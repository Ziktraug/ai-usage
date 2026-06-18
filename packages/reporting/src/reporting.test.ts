import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LocalHistoryStorage, createLocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { Effect } from 'effect';
import { createLocalReportPayload } from './index';

describe('shared reporting', () => {
  test('creates the compatibility payload through the shared local history boundary', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-'));
    try {
      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: null,
          includeCursor: false,
          keepSource: true,
          includeFacets: true,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: {
            since: null,
            project: null,
            limit: null,
            minTokens: 1,
            sort: 'date',
          },
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(payload).toMatchObject({
        generatedAt: '2026-01-01T00:00:00.000Z',
        filters: {
          since: null,
          project: null,
          limit: null,
          minTokens: 1,
          sort: 'date',
        },
        rows: [],
        tableRows: [],
        omittedRows: 0,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
