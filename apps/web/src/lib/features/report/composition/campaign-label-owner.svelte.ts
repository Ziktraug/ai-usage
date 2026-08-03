import { type CampaignLabelOverride, parseCampaignLabelOverrides } from '@ai-usage/report-core/campaign-label';
import { campaignLabelFor, indexCampaignLabelOverrides } from '../../../../campaign-label-overrides';
import type { ReportClient } from '../../../rpc/report-client';
import { campaignRenameMutation, campaignResetMutation } from '../actions/campaign';
import type { CampaignLabelEditorState } from '../actions/campaign-label-editor.svelte';

export interface CampaignLabelOwnerSnapshot {
  readonly loadError: string | null;
  readonly loadStatus: 'error' | 'idle' | 'loading' | 'ready';
  readonly mutationError: string | null;
  readonly mutationStatus: 'error' | 'idle' | 'saving';
  readonly overrides: readonly CampaignLabelOverride[];
}

const messageFrom = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

export const createCampaignLabelOwner = (client: ReportClient) => {
  let snapshot = $state<CampaignLabelOwnerSnapshot>({
    loadError: null,
    loadStatus: 'idle',
    mutationError: null,
    mutationStatus: 'idle',
    overrides: [],
  });
  let loadGeneration = 0;

  const replaceOverrides = (overrides: readonly CampaignLabelOverride[]): void => {
    snapshot = { ...snapshot, overrides: [...overrides] };
  };

  const load = async (): Promise<boolean> => {
    const generation = ++loadGeneration;
    snapshot = { ...snapshot, loadError: null, loadStatus: 'loading' };
    try {
      const result = await client.getCampaignLabelOverrides();
      if (generation !== loadGeneration) {
        return false;
      }
      replaceOverrides(parseCampaignLabelOverrides(result.campaignLabelOverrides));
      snapshot = { ...snapshot, loadStatus: 'ready' };
      return true;
    } catch (error) {
      if (generation !== loadGeneration) {
        return false;
      }
      snapshot = {
        ...snapshot,
        loadError: messageFrom(error, 'Campaign labels could not be loaded'),
        loadStatus: 'error',
      };
      return false;
    }
  };

  const mutate = async (campaignKey: string, derivedLabel: string, label: string | null): Promise<string | null> => {
    if (snapshot.mutationStatus === 'saving') {
      return null;
    }
    snapshot = { ...snapshot, mutationError: null, mutationStatus: 'saving' };
    try {
      const mutation = label === null ? campaignResetMutation(campaignKey) : campaignRenameMutation(campaignKey, label);
      const result = await client.setCampaignLabelOverride(mutation);
      loadGeneration += 1;
      const overrides = parseCampaignLabelOverrides(result.campaignLabelOverrides);
      replaceOverrides(overrides);
      snapshot = { ...snapshot, loadError: null, loadStatus: 'ready', mutationStatus: 'idle' };
      return campaignLabelFor(indexCampaignLabelOverrides(overrides), campaignKey, label ?? derivedLabel);
    } catch (error) {
      snapshot = {
        ...snapshot,
        mutationError: messageFrom(error, 'Campaign label could not be saved'),
        mutationStatus: 'error',
      };
      return null;
    }
  };

  return {
    editorFor: (campaignKey: string, derivedLabel: string): CampaignLabelEditorState => {
      const index = indexCampaignLabelOverrides(snapshot.overrides);
      return {
        campaignKey,
        effectiveLabel: campaignLabelFor(index, campaignKey, derivedLabel),
        hasOverride: index.has(campaignKey),
        loadError: snapshot.loadError,
        loadStatus: snapshot.loadStatus,
        mutationError: snapshot.mutationError,
        mutationStatus: snapshot.mutationStatus,
        onRename: async (label: string) => await mutate(campaignKey, derivedLabel, label),
        onReset: async () => await mutate(campaignKey, derivedLabel, null),
        onRetry: load,
      };
    },
    labelFor: (campaignKey: string, derivedLabel: string): string =>
      campaignLabelFor(indexCampaignLabelOverrides(snapshot.overrides), campaignKey, derivedLabel),
    load,
    get snapshot() {
      return snapshot;
    },
  };
};
