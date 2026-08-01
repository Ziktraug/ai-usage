import {
  type CampaignLabelOverride,
  type CampaignLabelOverrideMutation,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from '@ai-usage/report-core/campaign-label';
import { type Accessor, createSignal } from 'solid-js';
import { campaignLabelFor, indexCampaignLabelOverrides } from './campaign-label-overrides';

export interface CampaignLabelApiResponse {
  campaignLabelOverrides: CampaignLabelOverride[];
}

export interface CampaignLabelApi {
  load(): Promise<CampaignLabelApiResponse>;
  mutate(input: CampaignLabelOverrideMutation): Promise<CampaignLabelApiResponse>;
}

export type CampaignLabelLoadStatus = 'error' | 'idle' | 'loading' | 'ready';
export type CampaignLabelMutationStatus = 'error' | 'idle' | 'saving';

export interface CampaignLabelController {
  labelFor(campaignKey: string, derivedLabel: string): string;
  load(): Promise<boolean>;
  loadError: Accessor<string | null>;
  loadStatus: Accessor<CampaignLabelLoadStatus>;
  mutationError: Accessor<string | null>;
  mutationStatus: Accessor<CampaignLabelMutationStatus>;
  overrideFor(campaignKey: string): string | undefined;
  overrides: Accessor<CampaignLabelOverride[]>;
  rename(campaignKey: string, label: string): Promise<string | null>;
  reset(campaignKey: string, derivedLabel: string): Promise<string | null>;
  retryLoad(): Promise<boolean>;
  skipLoad(): void;
}

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

export const createLiveCampaignLabelApi = (): CampaignLabelApi => ({
  load: async () => {
    const { getCampaignLabelOverrides } = await import('./server/report-payload');
    return await getCampaignLabelOverrides();
  },
  mutate: async (input) => {
    const { setCampaignLabelOverride } = await import('./server/report-payload');
    return await setCampaignLabelOverride({ data: input });
  },
});

export const createCampaignLabelController = (api?: CampaignLabelApi): CampaignLabelController => {
  const [overrides, setOverrides] = createSignal<CampaignLabelOverride[]>([]);
  const [loadStatus, setLoadStatus] = createSignal<CampaignLabelLoadStatus>('idle');
  const [mutationStatus, setMutationStatus] = createSignal<CampaignLabelMutationStatus>('idle');
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  let overrideIndex = indexCampaignLabelOverrides([]);
  let loadSequence = 0;

  const replaceOverrides = (nextOverrides: CampaignLabelOverride[]): void => {
    overrideIndex = indexCampaignLabelOverrides(nextOverrides);
    setOverrides(nextOverrides);
  };
  const currentOverrideIndex = (): ReadonlyMap<string, string> => {
    overrides();
    return overrideIndex;
  };
  const overrideFor = (campaignKey: string): string | undefined => currentOverrideIndex().get(campaignKey);
  const labelFor = (campaignKey: string, derivedLabel: string): string =>
    campaignLabelFor(currentOverrideIndex(), campaignKey, derivedLabel);

  const load = async (): Promise<boolean> => {
    const sequence = ++loadSequence;
    setLoadStatus('loading');
    setLoadError(null);
    try {
      if (!api) {
        throw new Error('Campaign label API is unavailable');
      }
      const response = await api.load();
      const validated = parseCampaignLabelOverrides(response.campaignLabelOverrides);
      if (sequence !== loadSequence) {
        return false;
      }
      replaceOverrides(validated);
      setLoadStatus('ready');
      return true;
    } catch (error) {
      if (sequence !== loadSequence) {
        return false;
      }
      setLoadError(errorMessage(error, 'Campaign labels could not be loaded'));
      setLoadStatus('error');
      return false;
    }
  };

  const mutate = async (input: CampaignLabelOverrideMutation, derivedLabel: string): Promise<string | null> => {
    if (mutationStatus() === 'saving') {
      return null;
    }
    setMutationStatus('saving');
    setMutationError(null);
    try {
      if (!api) {
        throw new Error('Campaign label API is unavailable');
      }
      const mutation = parseCampaignLabelOverrideMutation(input);
      const response = await api.mutate(mutation);
      const validated = parseCampaignLabelOverrides(response.campaignLabelOverrides);
      loadSequence += 1;
      replaceOverrides(validated);
      setLoadError(null);
      setLoadStatus('ready');
      setMutationStatus('idle');
      return campaignLabelFor(indexCampaignLabelOverrides(validated), mutation.campaignKey, derivedLabel);
    } catch (error) {
      setMutationError(errorMessage(error, 'Campaign label could not be saved'));
      setMutationStatus('error');
      return null;
    }
  };

  const skipLoad = (): void => {
    loadSequence += 1;
    replaceOverrides([]);
    setLoadError(null);
    setLoadStatus('ready');
  };

  return {
    labelFor,
    load,
    loadError,
    loadStatus,
    mutationError,
    mutationStatus,
    overrideFor,
    overrides,
    rename: (campaignKey, label) => mutate({ campaignKey, label }, label.trim()),
    reset: (campaignKey, derivedLabel) => mutate({ campaignKey, label: null }, derivedLabel),
    retryLoad: load,
    skipLoad,
  };
};
