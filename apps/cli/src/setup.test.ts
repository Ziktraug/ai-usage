import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  readAiUsageConfig,
  updateAiUsageConfig,
} from '@ai-usage/local-collectors';
import type { ProjectSource } from '@ai-usage/report-data';
import { Effect } from 'effect';
import { saveSetupProjectAliases, setupHTML } from './setup';

const maliciousSource: ProjectSource = {
  gitRemote: '<img src=x onerror=alert(1)>',
  harness: 'Codex',
  harnesses: ['Codex'],
  harnessKey: 'codex',
  harnessKeys: ['codex'],
  id: 'source-1',
  machine: '<script>alert(1)</script>',
  machineId: 'machine-a',
  project: '<svg onload=alert(1)>',
  sessions: 1,
  sourcePath: '/tmp/<iframe src=javascript:alert(1)>',
  tokens: 10,
};

describe('setup HTML', () => {
  test('renders snapshot and config values through DOM text sinks', () => {
    const html = setupHTML(
      [maliciousSource],
      [{ name: '<img src=x onerror=alert(1)>', match: ['<script>alert(1)</script>'] }],
      [{ harness: '<svg onload=alert(1)>', message: '<iframe src=javascript:alert(1)>' }],
    );

    expect(html).not.toContain('.innerHTML');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('textContent = alias.name');
    expect(html).toContain('textContent = s.gitRemote');
    expect(html).toContain("setAttribute('aria-label', 'Select ' + s.project)");
  });

  test('saves aliases without replacing unrelated concurrent config fields', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ai-usage-setup-aliases-'));
    try {
      const storage = createLocalHistoryStorage(home);
      await Effect.runPromise(
        updateAiUsageConfig(() => ({ cursor: { clusterGapMs: 1234 } })).pipe(
          Effect.provideService(LocalHistoryStorage, storage),
        ),
      );

      await Effect.runPromise(
        saveSetupProjectAliases([{ match: ['/work/example'], name: 'example' }]).pipe(
          Effect.provideService(LocalHistoryStorage, storage),
        ),
      );

      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config).toEqual({
        cursor: { clusterGapMs: 1234 },
        projectAliases: [{ match: ['/work/example'], name: 'example' }],
      });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
