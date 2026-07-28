import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_CAMPAIGN_KEY_BYTES, MAX_CAMPAIGN_LABEL_LENGTH } from '@ai-usage/report-core/campaign-label';
import { Effect } from 'effect';
import { formatLocalHistoryError } from './errors';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import {
  aiUsageConfigPath,
  readAiUsageConfig,
  readMergedAiUsageConfigFrom,
  updateAiUsageConfig,
} from './machine-config';

const temporaryDirectory = (prefix: string): Promise<string> => mkdtemp(path.join(tmpdir(), prefix));

describe('campaign labels in machine config', () => {
  test('reads canonical home values and preserves them during unrelated updates', async () => {
    const home = await temporaryDirectory('ai-usage-campaign-label-home-');
    try {
      const storage = createLocalHistoryStorage(home);
      const configPath = aiUsageConfigPath(storage);
      const campaignLabelOverrides = [
        { campaignKey: 'machine-a:codex:root-a', label: 'Release train' },
        { campaignKey: 'machine-b:claude:root-b', label: 'Migration' },
      ];
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ campaignLabelOverrides, cursor: { clusterGapMs: 1234 } }));

      const initial = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(initial.campaignLabelOverrides).toEqual(campaignLabelOverrides);

      await Effect.runPromise(
        updateAiUsageConfig((config) => ({
          ...config,
          projectAliases: [{ match: ['/work/alpha'], name: 'alpha' }],
        })).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(persisted.campaignLabelOverrides).toEqual(campaignLabelOverrides);
      expect(persisted.cursor).toEqual({ clusterGapMs: 1234 });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test.each([
    ['empty key', [{ campaignKey: '', label: 'Name' }]],
    ['empty label', [{ campaignKey: 'campaign:a', label: '' }]],
    ['non-canonical label', [{ campaignKey: 'campaign:a', label: ' Name ' }]],
    ['oversized key', [{ campaignKey: 'x'.repeat(MAX_CAMPAIGN_KEY_BYTES + 1), label: 'Name' }]],
    ['oversized label', [{ campaignKey: 'campaign:a', label: 'x'.repeat(MAX_CAMPAIGN_LABEL_LENGTH + 1) }]],
    [
      'duplicate key',
      [
        { campaignKey: 'campaign:a', label: 'First' },
        { campaignKey: 'campaign:a', label: 'Second' },
      ],
    ],
  ])('rejects %s in home configuration', async (_case, campaignLabelOverrides) => {
    const home = await temporaryDirectory('ai-usage-campaign-label-invalid-');
    try {
      const storage = createLocalHistoryStorage(home);
      const configPath = aiUsageConfigPath(storage);
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ campaignLabelOverrides }));

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('rejects campaign labels in repository configuration', async () => {
    const home = await temporaryDirectory('ai-usage-campaign-label-repo-home-');
    const repo = await temporaryDirectory('ai-usage-campaign-label-repo-');
    try {
      const storage = createLocalHistoryStorage(home);
      writeFileSync(
        path.join(repo, 'ai-usage.config.ts'),
        "export default { campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Name' }] };\n",
      );

      const error = await Effect.runPromise(
        readMergedAiUsageConfigFrom(repo).pipe(Effect.provideService(LocalHistoryStorage, storage), Effect.flip),
      );
      expect(formatLocalHistoryError(error)).toContain(
        'campaignLabelOverrides may only be configured in the user home config',
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(repo, { force: true, recursive: true });
    }
  });
});
