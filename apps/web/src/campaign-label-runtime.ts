import { onMount } from 'solid-js';
import {
  type CampaignLabelApi,
  type CampaignLabelController,
  createCampaignLabelController,
  createLiveCampaignLabelApi,
} from './campaign-label-controller';
import type { RuntimeMode } from './runtime-mode';

export const initializeCampaignLabelRuntime = (
  mode: RuntimeMode,
  controller: CampaignLabelController,
): boolean | Promise<boolean> => {
  if (mode === 'demo') {
    controller.skipLoad();
    return true;
  }
  return controller.load();
};

export const createCampaignLabelRuntime = (
  mode: RuntimeMode,
  injectedApi?: CampaignLabelApi,
): CampaignLabelController => {
  const api = mode === 'live' ? (injectedApi ?? createLiveCampaignLabelApi()) : injectedApi;
  const controller = createCampaignLabelController(api);
  onMount(() => initializeCampaignLabelRuntime(mode, controller));
  return controller;
};
