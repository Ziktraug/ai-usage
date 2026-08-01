import { describe, expect, test } from 'bun:test';
import { type CampaignLabelApi, createCampaignLabelController } from './campaign-label-controller';
import { initializeCampaignLabelRuntime } from './campaign-label-runtime';

const apiWithLoadCounter = (): { api: CampaignLabelApi; loadCount: () => number } => {
  let loads = 0;
  return {
    api: {
      load: () => {
        loads += 1;
        return Promise.resolve({
          campaignLabelOverrides: [{ campaignKey: 'campaign:a', label: 'Release' }],
        });
      },
      mutate: () => Promise.resolve({ campaignLabelOverrides: [] }),
    },
    loadCount: () => loads,
  };
};

describe('campaign label runtime', () => {
  test('loads through the injected live or E2E adapter', async () => {
    for (const mode of ['live', 'e2e'] as const) {
      const injected = apiWithLoadCounter();
      const controller = createCampaignLabelController(injected.api);

      expect(await initializeCampaignLabelRuntime(mode, controller)).toBe(true);
      expect(injected.loadCount()).toBe(1);
      expect(controller.labelFor('campaign:a', 'Derived')).toBe('Release');
    }
  });

  test('marks demo labels ready without touching an injected adapter', async () => {
    const injected = apiWithLoadCounter();
    const controller = createCampaignLabelController(injected.api);

    expect(await initializeCampaignLabelRuntime('demo', controller)).toBe(true);
    expect(injected.loadCount()).toBe(0);
    expect(controller.loadStatus()).toBe('ready');
  });
});
