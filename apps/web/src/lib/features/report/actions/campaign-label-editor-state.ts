export interface CampaignLabelEditorState {
  readonly campaignKey: string;
  readonly effectiveLabel: string;
  readonly hasOverride: boolean;
  readonly loadError: string | null;
  readonly loadStatus: 'error' | 'idle' | 'loading' | 'ready';
  readonly mutationError: string | null;
  readonly mutationStatus: 'error' | 'idle' | 'saving';
  readonly onRename: (label: string) => Promise<string | null>;
  readonly onReset: () => Promise<string | null>;
  readonly onRetry: () => Promise<boolean> | undefined;
}
