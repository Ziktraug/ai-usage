import { Data, Effect } from 'effect';

export const LAN_PAIRING_PORT_RANGE = { start: 3847, end: 3857 } as const;

export interface LanPeerIdentity {
  id: string;
  label: string;
  protocol: string;
  version: number;
}

export interface DiscoveredLanPeer {
  identity: LanPeerIdentity;
  host: string;
  port: number;
  online: boolean;
  pairingAvailable: boolean;
  lastSeenAt: string;
}

export interface TrustedLanPeer {
  identity: LanPeerIdentity;
  pairedAt: string;
  lastSeenAt?: string;
  metadata: Record<string, string>;
}

export interface PairingEnvelope {
  peerId: string;
  credential: string;
  metadata: Record<string, string>;
}

export type LanPairingServiceStatus = 'stopped' | 'starting' | 'running' | 'pairing' | 'error';

export interface LanPairingState {
  localIdentity: LanPeerIdentity;
  status: LanPairingServiceStatus;
  port?: number;
  urls: string[];
  discoveredPeers: DiscoveredLanPeer[];
  trustedPeers: TrustedLanPeer[];
  lastError?: string;
}

export interface StartLanPairingInput {
  identity: LanPeerIdentity;
  portRange?: {
    start: number;
    end: number;
  };
}

export interface PairingInput {
  peerId: string;
  password: string;
}

export interface PairingState {
  peerId: string;
  startedAt: string;
  expiresAt: string;
}

export interface PairingResult {
  peer: TrustedLanPeer;
  receivedEnvelope: PairingEnvelope;
  sentEnvelope: PairingEnvelope;
}

export type LanPairingErrorReason =
  | 'invalid-input'
  | 'port-unavailable'
  | 'service-stopped'
  | 'peer-not-found'
  | 'pairing-failed';

export class LanPairingError extends Data.TaggedError('LanPairingError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason?: LanPairingErrorReason;
}> {}

export interface LanPairingService {
  start(input: StartLanPairingInput): Effect.Effect<void, LanPairingError>;
  stop(): Effect.Effect<void, LanPairingError>;
  scan(): Effect.Effect<DiscoveredLanPeer[], LanPairingError>;
  startPairing(input: PairingInput): Effect.Effect<PairingState, LanPairingError>;
  confirmPairing(input: PairingInput): Effect.Effect<PairingResult, LanPairingError>;
  getState(): Effect.Effect<LanPairingState, never>;
}
