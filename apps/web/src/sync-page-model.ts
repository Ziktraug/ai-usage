import type { DiscoveredSnapshotRemote, SyncRemoteState, SyncState, SyncTokenStatus } from '@ai-usage/sync';
import type { DiscoveredLanPeer } from '@ai-usage/lan-pairing';
import type { LanMergeState, TrustedLanPeer } from '@ai-usage/usage-merge';

export interface SyncSummary {
  configuredRemotes: number;
  enabledRemotes: number;
  missingTokens: number;
  storedSnapshots: number;
  warningCount: number;
}

export const buildSyncSummary = (state: SyncState): SyncSummary => ({
  configuredRemotes: state.remotes.length,
  enabledRemotes: state.remotes.filter((remote) => remote.enabled).length,
  missingTokens: state.remotes.filter((remote) => remote.tokenStatus === 'missing').length,
  storedSnapshots: state.storedSnapshots.length,
  warningCount: state.warnings.length,
});

export const tokenStatusLabel = (status: SyncTokenStatus) => {
  switch (status) {
    case 'missing':
      return 'Missing env';
    case 'present':
      return 'Env present';
    case 'none':
      return 'No token';
  }
};

export const enabledStatusLabel = (remote: Pick<SyncRemoteState, 'enabled'>) =>
  remote.enabled ? 'Enabled' : 'Disabled';

export const remoteMachineLabel = (remote: Pick<SyncRemoteState, 'machineLabel' | 'machineId'>) =>
  remote.machineLabel ?? remote.machineId ?? 'Not pulled yet';

export const formatSyncDateTime = (iso: string | undefined) => {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};

export interface SyncOperationError {
  tag: string;
  message: string;
  reason?: string;
}

export const syncOperationErrorHint = (error: SyncOperationError) => {
  switch (error.reason) {
    case 'missing-token':
      return 'Set the token environment variable in your shell or supported .env file, then retry.';
    case 'invalid-url':
      return 'Use a snapshot URL that starts with http:// or https://.';
    case 'invalid-token-env':
      return 'Token env names may contain letters, digits, and underscores, and cannot start with a digit.';
    case 'unknown-remote':
      return 'Refresh sync state; this remote may have been removed.';
    case 'no-remotes':
      return 'Add a snapshot remote before pulling.';
    case 'self-sync':
      return 'This endpoint belongs to the local machine and cannot be synced as a remote.';
    default:
      return error.tag === 'SyncTransportError'
        ? 'Check the host, port, firewall, token, and whether snapshot serving is enabled.'
        : null;
  }
};

export const syncServeErrorHint = (error: { message: string; reason?: string } | undefined) => {
  if (!error) return null;
  if (error.reason === 'missing-serve-token') return 'Use All-in-one setup or enter a serve token before binding to 0.0.0.0.';
  if (/EADDRINUSE|address already in use/i.test(error.message)) {
    return 'Port is already used. Stop the other sync server, choose another port, or use All-in-one setup to pick a free port automatically.';
  }
  return null;
};

export const allInOneSetupSummary =
  'Starts this machine on the LAN, writes its token to this repo .env, then gives you a paste-ready setup block for the other machine.';

export interface SyncRemoteDraft {
  name: string;
  url: string;
  tokenEnv: string;
}

const cleanRemoteName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const remoteDraftFromDiscoveredPeer = (peer: DiscoveredSnapshotRemote): SyncRemoteDraft => {
  const name = cleanRemoteName(peer.machineLabel) || `peer-${peer.host.replace(/[^a-z0-9]+/gi, '-')}`;
  return { name, url: peer.snapshotUrl, tokenEnv: '' };
};

export const discoveryBadgesForPeer = (peer: Pick<DiscoveredSnapshotRemote, 'self' | 'alreadyConfigured'>) => [
  ...(peer.self ? ['self'] : []),
  ...(peer.alreadyConfigured ? ['configured'] : []),
];

export type SyncServeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export const serveStatusLabel = (status: SyncServeStatus) => {
  switch (status) {
    case 'stopped':
      return 'Not serving';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Serving';
    case 'stopping':
      return 'Stopping';
    case 'error':
      return 'Error';
  }
};

export const validateServeStartInput = (input: { host: string; port: number; token: string }) => {
  if (!input.host.trim()) return 'Host is required.';
  if (!Number.isFinite(input.port) || input.port < 1 || input.port > 65_535) return 'Port must be between 1 and 65535.';
  if (input.host.trim() === '0.0.0.0' && !input.token.trim()) return 'A token is required when serving on 0.0.0.0.';
  return null;
};

export interface LanMergeSummary {
  trustedMachines: number;
  onlineMachines: number;
  discoveredMachines: number;
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
      return 'Ready';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Scanning';
    case 'pairing':
      return 'Pairing';
    case 'error':
      return 'Needs attention';
  }
};

export const lanTrustedPeerStatusLabel = (peer: Pick<TrustedLanPeer, 'online' | 'paired'>) => {
  if (!peer.paired) return 'Not paired';
  return peer.online ? 'Available' : 'Offline';
};

export const lanDiscoveredPeerStatusLabel = (peer: Pick<DiscoveredLanPeer, 'self' | 'pairingAvailable' | 'online'>) => {
  if (peer.self) return 'This machine';
  if (!peer.online) return 'Offline';
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
