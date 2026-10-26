import type { UsageEngineCommandName } from '@ai-usage/usage-engine-control';

export type UsageEngineCommandOutputKind =
  | 'collection'
  | 'cursor-import'
  | 'delegation-cancel'
  | 'delegation-config'
  | 'delegation-evaluation'
  | 'delegation-qualification'
  | 'delegation-start'
  | 'machine'
  | 'merge-preview'
  | 'none'
  | 'publication'
  | 'replication-status'
  | 'review-attempt'
  | 'review-attempt-stop'
  | 'review-reservation-release'
  | 'routing-qualification'
  | 'work-thread';

interface UsageEngineCommandPolicy {
  readonly interruptible: boolean;
  readonly outputKind: UsageEngineCommandOutputKind;
}

export const usageEngineCommandPolicies = {
  // Terminates a tracked worker and records the request on one row; an interrupted cancel would leave both half-done.
  'cancel-delegation': { interruptible: false, outputKind: 'delegation-cancel' },
  'collect-fresh-quota': { interruptible: true, outputKind: 'collection' },
  'collect-fresh-report': { interruptible: true, outputKind: 'collection' },
  'confirm-merge': { interruptible: false, outputKind: 'none' },
  'detect-all': { interruptible: true, outputKind: 'none' },
  'import-cursor': { interruptible: false, outputKind: 'cursor-import' },
  'preview-merge': { interruptible: true, outputKind: 'merge-preview' },
  publish: { interruptible: false, outputKind: 'publication' },
  // Observes the executors now, reads, decides and records one qualification row; nothing is started.
  'qualify-delegation': { interruptible: true, outputKind: 'delegation-qualification' },
  // Observes the executors now, then decides; nothing is started, so an abort leaves nothing behind.
  'qualify-review-routing': { interruptible: true, outputKind: 'routing-qualification' },
  // Appends one evaluation row.
  'record-delegation-evaluation': { interruptible: false, outputKind: 'delegation-evaluation' },
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
  // The command returns once the job is recorded and spawned; aborting it never kills the worker.
  'start-delegation': { interruptible: false, outputKind: 'delegation-start' },
  // The command returns once the attempt is recorded and spawned; aborting it never kills the review.
  'start-review-attempt': { interruptible: false, outputKind: 'review-attempt' },
  // One locked home-config write under an expected revision.
  'update-delegation-config': { interruptible: false, outputKind: 'delegation-config' },
  'stop-review-attempt': { interruptible: false, outputKind: 'review-attempt-stop' },
  'work-thread': { interruptible: false, outputKind: 'work-thread' },
} as const satisfies Record<UsageEngineCommandName, UsageEngineCommandPolicy>;
