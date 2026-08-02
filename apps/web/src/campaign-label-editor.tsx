import { css } from '@ai-usage/design-system/css';
import {
  drawerActions,
  drawerCompare,
  drawerTitle,
  ghostButton,
  muted,
  searchInput,
} from '@ai-usage/design-system/report';
import { MAX_CAMPAIGN_LABEL_LENGTH } from '@ai-usage/report-core/campaign-label';
import { createEffect, createSignal, on, Show } from 'solid-js';
import type { CampaignLabelLoadStatus, CampaignLabelMutationStatus } from './campaign-label-controller';

const CAMPAIGN_LABEL_INPUT_ID = 'session-drawer-campaign-label';
const editorLayout = css({ display: 'grid', gap: '8px' });

export interface CampaignLabelEditorState {
  campaignKey: string;
  effectiveLabel: string;
  hasOverride: boolean;
  loadError: string | null;
  loadStatus: CampaignLabelLoadStatus;
  mutationError: string | null;
  mutationStatus: CampaignLabelMutationStatus;
  onRename(label: string): Promise<string | null>;
  onReset(): Promise<string | null>;
  onRetry(): Promise<boolean> | undefined;
}

export const CampaignLabelEditor = (props: { editor: CampaignLabelEditorState }) => {
  const [draft, setDraft] = createSignal(props.editor.effectiveLabel);

  createEffect(
    on(
      () => [props.editor.campaignKey, props.editor.effectiveLabel] as const,
      ([, effectiveLabel]) => setDraft(effectiveLabel),
    ),
  );

  const trimmedDraft = (): string => draft().trim();
  const rename = async (): Promise<void> => {
    const label = trimmedDraft();
    if (!(label && label !== props.editor.effectiveLabel)) {
      return;
    }
    const effectiveLabel = await props.editor.onRename(label);
    if (effectiveLabel !== null) {
      setDraft(effectiveLabel);
    }
  };
  const reset = async (): Promise<void> => {
    const effectiveLabel = await props.editor.onReset();
    if (effectiveLabel !== null) {
      setDraft(effectiveLabel);
    }
  };

  return (
    <div class={`${drawerCompare} ${editorLayout}`} data-campaign-label-editor>
      <label class={drawerTitle} for={CAMPAIGN_LABEL_INPUT_ID}>
        Campaign label
      </label>
      <div class={drawerActions}>
        <input
          class={searchInput}
          id={CAMPAIGN_LABEL_INPUT_ID}
          maxLength={MAX_CAMPAIGN_LABEL_LENGTH}
          onInput={(event) => setDraft(event.currentTarget.value)}
          value={draft()}
        />
        <button
          class={ghostButton}
          disabled={
            props.editor.mutationStatus === 'saving' ||
            trimmedDraft().length === 0 ||
            trimmedDraft() === props.editor.effectiveLabel
          }
          onClick={() => rename()}
          type="button"
        >
          Rename
        </button>
        <button
          class={ghostButton}
          disabled={props.editor.mutationStatus === 'saving' || !props.editor.hasOverride}
          onClick={() => reset()}
          type="button"
        >
          Reset
        </button>
      </div>
      <div aria-live="polite" class={muted} data-campaign-label-status>
        <Show when={props.editor.loadStatus === 'loading'}>Loading campaign labels…</Show>
        <Show when={props.editor.loadStatus === 'error'}>
          <span>Unable to load campaign labels: {props.editor.loadError}</span>{' '}
          <button class={ghostButton} onClick={() => props.editor.onRetry()} type="button">
            Retry labels
          </button>
        </Show>
        <Show when={props.editor.mutationStatus === 'saving'}>Saving campaign label…</Show>
        <Show when={props.editor.mutationStatus === 'error'}>
          Unable to save campaign label: {props.editor.mutationError}
        </Show>
      </div>
    </div>
  );
};
