import type { DiscoveredLanPeer } from '@ai-usage/lan-pairing';
import type { LanMergeState, TrustedLanPeer } from '@ai-usage/usage-merge';

export const formatSyncDateTime = (iso: string | undefined) => {
  if (!iso) {
    return 'Never';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
};

export interface SyncOperationError {
  message: string;
  reason?: string;
  tag: string;
}

export interface LanMergeSummary {
  discoveredMachines: number;
  onlineMachines: number;
  trustedMachines: number;
  warningCount: number;
}

export const buildLanMergeSummary = (state: LanMergeState): LanMergeSummary => ({
  trustedMachines: state.trustedPeers.length,
  onlineMachines: state.trustedPeers.filter((peer) => peer.online).length,
  discoveredMachines: state.discoveredPeers.filter((peer) => !peer.self).length,
  warningCount: state.trustedPeers.reduce((total, peer) => total + peer.warnings, 0),
});

export const lanMergeServiceStatusLabel = (status: LanMergeState['service']['status']) => {
  switch (status) {
    case 'stopped':
      return 'Stopped';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Online';
    case 'pairing':
      return 'Pairing';
    case 'error':
      return 'Needs attention';
    default:
      return 'Unknown';
  }
};

export const lanTrustedPeerStatusLabel = (peer: Pick<TrustedLanPeer, 'online' | 'paired'>) => {
  if (!peer.paired) {
    return 'Not paired';
  }
  return peer.online ? 'Available' : 'Offline';
};

export const lanDiscoveredPeerStatusLabel = (peer: Pick<DiscoveredLanPeer, 'self' | 'pairingAvailable' | 'online'>) => {
  if (peer.self) {
    return 'This machine';
  }
  if (!peer.online) {
    return 'Offline';
  }
  return peer.pairingAvailable ? 'Ready to pair' : 'Pairing unavailable';
};

export const lanPrimaryPeerDetails = (
  peer: Pick<TrustedLanPeer, 'machineLabel' | 'online' | 'rows' | 'warnings' | 'lastMergedAt'>,
) => [
  lanTrustedPeerStatusLabel({ online: peer.online, paired: true }),
  `${peer.rows ?? 0} rows`,
  `${peer.warnings} warnings`,
  `Last merged ${formatSyncDateTime(peer.lastMergedAt)}`,
];

export const mergeBundleUrlForLanPeer = (peer: Pick<DiscoveredLanPeer, 'host' | 'port'>) =>
  `http://${peer.host}:${peer.port}/lan/merge-bundle`;

export const lanMergeErrorHint = (error: SyncOperationError) => {
  switch (error.reason) {
    case 'missing-token':
      return 'Pair this machine again so the LAN merge token can be saved locally.';
    case 'peer-offline':
      return 'Scan the LAN again, then retry when the machine is available.';
    case 'pairing-failed':
      return 'Check that both machines are showing the same pairing password flow, then try again.';
    case 'self-merge':
      return 'This is the local machine and cannot be merged as a peer.';
    default:
      return null;
  }
};
