import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredLanPeer, LanPeerIdentity, PairingEnvelope } from '@ai-usage/lan-pairing';
import type { StoredLanPeer } from '@ai-usage/local-collectors/lan-peers';
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

export interface UsageMergeCredential {
  version: 1;
  tokenEnv: string;
  token: string;
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

const shellToken = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

export const usageMergeTokenEnvNameForMachine = (machine: UsageMachine) =>
  `AI_USAGE_LAN_MERGE_${shellToken(machine.label || machine.id) || 'REMOTE'}_TOKEN`;

export const createUsageMergeToken = () => randomBytes(32).toString('base64url');

const toBase64Url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCredential = (value: unknown): value is UsageMergeCredential =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.tokenEnv === 'string' &&
  /^AI_USAGE_[A-Z0-9_]+_TOKEN$/.test(value.tokenEnv) &&
  typeof value.token === 'string' &&
  value.token.length > 0;

export const encodeUsageMergeCredential = (credential: Omit<UsageMergeCredential, 'version'>) =>
  toBase64Url(JSON.stringify({ version: 1, ...credential } satisfies UsageMergeCredential));

export const decodeUsageMergeCredential = (value: string): UsageMergeCredential => {
  const parsed = JSON.parse(fromBase64Url(value)) as unknown;
  if (!isCredential(parsed)) throw new Error('Invalid usage merge credential');
  return parsed;
};

export const createUsageMergePairingEnvelope = (input: {
  machine: UsageMachine;
  tokenEnv: string;
  token: string;
}): PairingEnvelope => ({
  peerId: input.machine.id,
  credential: encodeUsageMergeCredential({ tokenEnv: input.tokenEnv, token: input.token }),
  metadata: {
    machineLabel: input.machine.label,
    protocol: USAGE_MERGE_PROTOCOL,
    protocolVersion: String(USAGE_MERGE_PROTOCOL_VERSION),
  },
});

export const storedLanPeerFromPairingEnvelope = (input: {
  identity: LanPeerIdentity;
  envelope: PairingEnvelope;
  pairedAt: Date;
}): StoredLanPeer => {
  if (input.identity.id !== input.envelope.peerId) throw new Error('Pairing envelope peer id does not match identity');
  const credential = decodeUsageMergeCredential(input.envelope.credential);
  return {
    machineId: input.identity.id,
    machineLabel: input.identity.label,
    tokenEnv: credential.tokenEnv,
    pairedAt: input.pairedAt.toISOString(),
    lastSeenAt: input.pairedAt.toISOString(),
  };
};

const findWorkspaceRoot = (cwd = process.cwd()) => {
  let current = path.resolve(cwd);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { workspaces?: unknown };
        if (parsed.workspaces) return current;
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
};

export const upsertUsageMergeEnvToken = (key: string, value: string, cwd = process.cwd()) => {
  const envPath = path.join(findWorkspaceRoot(cwd), '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escapedKey}=.*$`, 'm');
  const next = matcher.test(existing)
    ? existing.replace(matcher, line)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, next, 'utf8');
  return { path: envPath };
};

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
