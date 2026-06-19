import type { DiscoveredLanPeer, LanPeerIdentity } from '@ai-usage/lan-pairing';
import type { UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ImportResult } from '@ai-usage/usage-store';
import { Data, Effect } from 'effect';

export const USAGE_MERGE_PROTOCOL = 'ai-usage-lan-merge' as const;
export const USAGE_MERGE_PROTOCOL_VERSION = 1 as const;

export interface TrustedLanPeer {
  machineId: string;
  machineLabel: string;
  tokenEnv: string;
  pairedAt: string;
  online: boolean;
  paired: boolean;
  lastSeenAt?: string;
  lastMergedAt?: string;
  rows?: number;
  warnings: number;
}

export interface LanMergeState {
  localMachine: UsageMachine;
  service: {
    status: 'stopped' | 'starting' | 'running' | 'pairing' | 'error';
    urls: string[];
    lastError?: string;
  };
  discoveredPeers: DiscoveredLanPeer[];
  trustedPeers: TrustedLanPeer[];
}

export interface PairPeerInput {
  discoveredPeerId: string;
  password: string;
}

export interface MergePeerInput {
  machineId: string;
}

export interface ForgetPeerInput {
  machineId: string;
  deleteRows?: boolean;
}

export interface PeerStatusResult {
  peers: TrustedLanPeer[];
}

export interface FetchPeerMergeBundleResult {
  peer: TrustedLanPeer;
  bundle: UsageMergeBundle;
}

export type UsageMergeErrorReason =
  | 'invalid-input'
  | 'self-merge'
  | 'pairing-failed'
  | 'peer-not-found'
  | 'missing-token'
  | 'peer-offline'
  | 'store-failed';

export class UsageMergeError extends Data.TaggedError('UsageMergeError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason?: UsageMergeErrorReason;
  readonly cause?: unknown;
}> {}

export const lanIdentityFromMachine = (machine: UsageMachine): LanPeerIdentity => ({
  id: machine.id,
  label: machine.label,
  protocol: USAGE_MERGE_PROTOCOL,
  version: USAGE_MERGE_PROTOCOL_VERSION,
});

export interface UsageMergeService {
  startLanMerge(): Effect.Effect<void, UsageMergeError>;
  stopLanMerge(): Effect.Effect<void, UsageMergeError>;
  getLanMergeState(): Effect.Effect<LanMergeState, UsageMergeError>;
  scanLanMergePeers(): Effect.Effect<LanMergeState, UsageMergeError>;
  pairPeer(input: PairPeerInput): Effect.Effect<LanMergeState, UsageMergeError>;
  mergePeer(input: MergePeerInput): Effect.Effect<ImportResult, UsageMergeError>;
  forgetPeer(input: ForgetPeerInput): Effect.Effect<LanMergeState, UsageMergeError>;
  readPeerStatuses(): Effect.Effect<PeerStatusResult, UsageMergeError>;
}
