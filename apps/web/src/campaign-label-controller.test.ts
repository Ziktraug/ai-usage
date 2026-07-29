import { describe, expect, test } from 'bun:test';
import type { CampaignLabelApi, CampaignLabelApiResponse } from './campaign-label-controller';
import { createCampaignLabelController } from './campaign-label-controller';
import { createCampaignLabelE2EApi } from './campaign-label-e2e-fixture';

describe('campaign label controller', () => {
  test('loads, renames, and resets through one API while presenting immediate results', async () => {
    let stored: CampaignLabelApiResponse = { campaignLabelOverrides: [] };
    const api: CampaignLabelApi = {
      load: () => Promise.resolve(stored),
      mutate: (input) => {
        const existingIndex = stored.campaignLabelOverrides.findIndex(
          ({ campaignKey }) => campaignKey === input.campaignKey,
        );
        if (input.label === null) {
          stored = {
            campaignLabelOverrides: stored.campaignLabelOverrides.filter(
              ({ campaignKey }) => campaignKey !== input.campaignKey,
            ),
          };
        } else if (existingIndex >= 0) {
          const next = [...stored.campaignLabelOverrides];
          next[existingIndex] = { campaignKey: input.campaignKey, label: input.label };
          stored = { campaignLabelOverrides: next };
        } else {
          stored = {
            campaignLabelOverrides: [
              ...stored.campaignLabelOverrides,
              { campaignKey: input.campaignKey, label: input.label },
            ],
          };
        }
        return Promise.resolve(stored);
      },
    };
    const controller = createCampaignLabelController(api);

    expect(await controller.load()).toBe(true);
    expect(controller.loadStatus()).toBe('ready');
    expect(await controller.rename('campaign:a', ' Release ')).toBe('Release');
    expect(controller.labelFor('campaign:a', 'Derived')).toBe('Release');
    expect(controller.overrideFor('campaign:a')).toBe('Release');
    expect(await controller.reset('campaign:a', 'Derived')).toBe('Derived');
    expect(controller.labelFor('campaign:a', 'Derived')).toBe('Derived');
    expect(controller.mutationStatus()).toBe('idle');
  });

  test('skips demo loading without calling the API', () => {
    let calls = 0;
    const controller = createCampaignLabelController({
      load: () => {
        calls += 1;
        return Promise.resolve({ campaignLabelOverrides: [] });
      },
      mutate: () => Promise.resolve({ campaignLabelOverrides: [] }),
    });

    controller.skipLoad();
    expect(controller.loadStatus()).toBe('ready');
    expect(controller.overrides()).toEqual([]);
    expect(calls).toBe(0);
  });

  test('keeps the last valid list across separate load and mutation errors', async () => {
    let loadFailure = false;
    let mutationFailure = false;
    const api: CampaignLabelApi = {
      load: () =>
        loadFailure
          ? Promise.reject(new Error('load failed'))
          : Promise.resolve({ campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Release' }] }),
      mutate: () =>
        mutationFailure
          ? Promise.reject(new Error('save failed'))
          : Promise.resolve({ campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Other' }] }),
    };
    const controller = createCampaignLabelController(api);
    await controller.load();
    loadFailure = true;
    expect(await controller.retryLoad()).toBe(false);
    expect(controller.loadStatus()).toBe('error');
    expect(controller.loadError()).toBe('load failed');
    expect(controller.labelFor('campaign:a', 'Derived')).toBe('Release');

    mutationFailure = true;
    expect(await controller.rename('campaign:a', 'Other')).toBeNull();
    expect(controller.mutationStatus()).toBe('error');
    expect(controller.mutationError()).toBe('save failed');
    expect(controller.labelFor('campaign:a', 'Derived')).toBe('Release');
  });

  test('does not let an older load overwrite a completed mutation', async () => {
    let resolveLoad: ((response: CampaignLabelApiResponse) => void) | undefined;
    const controller = createCampaignLabelController({
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
      mutate: () =>
        Promise.resolve({
          campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Renamed' }],
        }),
    });

    const pendingLoad = controller.load();
    expect(await controller.rename('campaign:a', 'Renamed')).toBe('Renamed');
    resolveLoad?.({
      campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Old label' }],
    });

    expect(await pendingLoad).toBe(false);
    expect(controller.loadStatus()).toBe('ready');
    expect(controller.labelFor('campaign:a', 'Derived')).toBe('Renamed');
  });

  test('isolates each E2E page behind a fresh closure-owned list', async () => {
    const firstPageApi = createCampaignLabelE2EApi();
    const secondPageApi = createCampaignLabelE2EApi();

    await firstPageApi.mutate({ campaignKey: 'campaign:a', label: 'Release' });
    const firstPageState = await firstPageApi.load();
    firstPageState.campaignLabelOverrides[0]!.label = 'mutated response';

    expect(await firstPageApi.load()).toEqual({
      campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Release' }],
    });
    expect(await secondPageApi.load()).toEqual({ campaignLabelOverrides: [] });
  });
});
