import type { Device, DeviceCredentialId } from '@ai-usage/platform-core/identity';
import type { ReplicationAck, ReplicationBatch, ReplicationProblem } from '@ai-usage/replication-protocol';

export interface ApplyReplicationBatchInput {
  readonly authenticatedCredentialId: DeviceCredentialId;
  readonly authenticatedDevice: Device;
  readonly batch: ReplicationBatch;
}

export type ApplyReplicationBatchResult =
  | { readonly ack: ReplicationAck; readonly kind: 'ack' }
  | { readonly kind: 'problem'; readonly problem: ReplicationProblem };

export interface PlatformReplicationStore {
  readonly applyBatch: (input: ApplyReplicationBatchInput) => Promise<ApplyReplicationBatchResult>;
}
