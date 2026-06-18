import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  test('loads repo config from an explicit cwd', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-home-'));
    const configCwd = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-config-'));
    try {
      const claudeDir = path.join(home, '.claude/projects/-work-raw');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        path.join(claudeDir, 'session-1.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: '/work/raw',
          requestId: 'request-1',
          message: {
            id: 'message-1',
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        })}\n`,
      );
      writeFileSync(
        path.join(configCwd, 'ai-usage.config.ts'),
        `export default { projectAliases: [{ name: 'Aliased Project', match: ['/work/raw'] }] }`,
      );

      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: 'claude',
          includeCursor: false,
          keepSource: true,
          configCwd,
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

      expect(payload.rows).toHaveLength(1);
      expect(payload.rows[0]?.project).toBe('Aliased Project');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configCwd, { recursive: true, force: true });
    }
  });
});
