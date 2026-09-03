import type { UsageEngineCommandName } from '@ai-usage/usage-engine-control';

export type UsageEngineCommandOutputKind =
  | 'collection'
  | 'cursor-import'
  | 'machine'
  | 'merge-preview'
  | 'none'
  | 'publication'
  | 'replication-status';

interface UsageEngineCommandPolicy {
  readonly interruptible: boolean;
  readonly outputKind: UsageEngineCommandOutputKind;
}

export const usageEngineCommandPolicies = {
  'collect-fresh-quota': { interruptible: true, outputKind: 'collection' },
  'collect-fresh-report': { interruptible: true, outputKind: 'collection' },
  'confirm-merge': { interruptible: false, outputKind: 'none' },
  'detect-all': { interruptible: true, outputKind: 'none' },
  'import-cursor': { interruptible: false, outputKind: 'cursor-import' },
  'preview-merge': { interruptible: true, outputKind: 'merge-preview' },
  publish: { interruptible: false, outputKind: 'publication' },
  'replication-status': { interruptible: true, outputKind: 'replication-status' },
  'replace-project-aliases': { interruptible: false, outputKind: 'none' },
  'replace-project-groups': { interruptible: false, outputKind: 'none' },
  'replace-project-groups-by-reference': { interruptible: false, outputKind: 'none' },
  'run-all-enabled': { interruptible: true, outputKind: 'none' },
  'run-source': { interruptible: true, outputKind: 'none' },
  'set-campaign-label-override': { interruptible: false, outputKind: 'none' },
  'set-machine-label': { interruptible: false, outputKind: 'machine' },
  'set-source-enabled': { interruptible: false, outputKind: 'none' },
} as const satisfies Record<UsageEngineCommandName, UsageEngineCommandPolicy>;
