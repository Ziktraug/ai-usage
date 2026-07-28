import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { aiUsageConfigPath, readAiUsageConfig, updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import { MAX_CAMPAIGN_KEY_BYTES, MAX_CAMPAIGN_LABEL_LENGTH } from '@ai-usage/report-core/campaign-label';
import { Effect } from 'effect';
import { getCampaignLabelOverridesForServer, setCampaignLabelOverrideForServer } from './report-payload.server';

const createTemporaryStorage = async (): Promise<{ home: string; storage: LocalHistoryStorageService }> => {
  const home = await mkdtemp(path.join(tmpdir(), 'ai-usage-campaign-label-server-'));
  return { home, storage: createLocalHistoryStorage(home) };
};

describe('campaign label server boundary', () => {
  test('persists ordered rename and reset mutations without touching unrelated config', async () => {
    const { home, storage } = await createTemporaryStorage();
    try {
      expect(await getCampaignLabelOverridesForServer(storage)).toEqual({ campaignLabelOverrides: [] });
      await Effect.runPromise(
        updateAiUsageConfig(() => ({
          cursor: { clusterGapMs: 1234 },
          projectAliases: [{ match: ['/work/alpha'], name: 'alpha' }],
        })).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(
        await setCampaignLabelOverrideForServer(
          { campaignKey: 'machine-a:codex:root-a', label: '  Release train  ' },
          storage,
        ),
      ).toEqual({
        campaignLabelOverrides: [{ campaignKey: 'machine-a:codex:root-a', label: 'Release train' }],
      });
      await setCampaignLabelOverrideForServer({ campaignKey: 'machine-b:claude:root-b', label: 'Migration' }, storage);
      const renamed = await setCampaignLabelOverrideForServer(
        { campaignKey: 'machine-a:codex:root-a', label: 'Launch' },
        storage,
      );
      expect(renamed.campaignLabelOverrides).toEqual([
        { campaignKey: 'machine-a:codex:root-a', label: 'Launch' },
        { campaignKey: 'machine-b:claude:root-b', label: 'Migration' },
      ]);

      expect(await getCampaignLabelOverridesForServer(storage)).toEqual(renamed);
      await setCampaignLabelOverrideForServer({ campaignKey: 'machine-a:codex:root-a', label: null }, storage);
      const reset = await setCampaignLabelOverrideForServer(
        { campaignKey: 'machine-b:claude:root-b', label: null },
        storage,
      );
      expect(reset).toEqual({ campaignLabelOverrides: [] });

      const persisted = JSON.parse(await readFile(aiUsageConfigPath(storage), 'utf8')) as Record<string, unknown>;
      expect(Object.hasOwn(persisted, 'campaignLabelOverrides')).toBe(false);
      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(config.cursor).toEqual({ clusterGapMs: 1234 });
      expect(config.projectAliases).toEqual([{ match: ['/work/alpha'], name: 'alpha' }]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test('validates mutation boundaries before writing', async () => {
    const { home, storage } = await createTemporaryStorage();
    try {
      const exactLabel = 'x'.repeat(MAX_CAMPAIGN_LABEL_LENGTH);
      const exactKey = 'é'.repeat(MAX_CAMPAIGN_KEY_BYTES / 2);
      await expect(
        setCampaignLabelOverrideForServer({ campaignKey: exactKey, label: exactLabel }, storage),
      ).resolves.toEqual({ campaignLabelOverrides: [{ campaignKey: exactKey, label: exactLabel }] });
      await expect(
        setCampaignLabelOverrideForServer({ campaignKey: `${exactKey}a`, label: 'Name' }, storage),
      ).rejects.toThrow('campaignKey exceeds');
      await expect(
        setCampaignLabelOverrideForServer({ campaignKey: 'campaign:other', label: `${exactLabel}x` }, storage),
      ).rejects.toThrow('label exceeds');
      await expect(
        setCampaignLabelOverrideForServer({ campaignKey: 'campaign:other', label: '   ' }, storage),
      ).rejects.toThrow('must not be empty');
      expect((await getCampaignLabelOverridesForServer(storage)).campaignLabelOverrides).toEqual([
        { campaignKey: exactKey, label: exactLabel },
      ]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
