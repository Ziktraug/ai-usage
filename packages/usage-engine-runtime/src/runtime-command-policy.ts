import type { UsageEngineCommandName } from '@ai-usage/usage-engine-control';

export type UsageEngineCommandOutputKind =
  | 'collection'
  | 'cursor-import'
  | 'machine'
  | 'merge-preview'
  | 'none'
  | 'publication'
  | 'replication-status'
  | 'review-attempt'
  | 'review-attempt-stop'
  | 'review-reservation-release'
  | 'routing-qualification';

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
  // Observes the executors now, then decides; nothing is started, so an abort leaves nothing behind.
  'qualify-review-routing': { interruptible: true, outputKind: 'routing-qualification' },
  // Records the operator's declaration (or a process absence) on one row; nothing is stopped.
  'release-review-reservation': { interruptible: false, outputKind: 'review-reservation-release' },
  'replication-status': { interruptible: true, outputKind: 'replication-status' },
  'replace-project-aliases': { interruptible: false, outputKind: 'none' },
  'replace-project-groups': { interruptible: false, outputKind: 'none' },
  'replace-project-groups-by-reference': { interruptible: false, outputKind: 'none' },
  'run-all-enabled': { interruptible: true, outputKind: 'none' },
  'run-source': { interruptible: true, outputKind: 'none' },
  'set-campaign-label-override': { interruptible: false, outputKind: 'none' },
  'set-machine-label': { interruptible: false, outputKind: 'machine' },
  'set-source-enabled': { interruptible: false, outputKind: 'none' },
  // The command returns once the attempt is recorded and spawned; aborting it never kills the review.
  'start-review-attempt': { interruptible: false, outputKind: 'review-attempt' },
  'stop-review-attempt': { interruptible: false, outputKind: 'review-attempt-stop' },
} as const satisfies Record<UsageEngineCommandName, UsageEngineCommandPolicy>;
