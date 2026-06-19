import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredLanPeer, LanPeerIdentity, PairingEnvelope } from '@ai-usage/lan-pairing';
import type { StoredLanPeer } from '@ai-usage/local-collectors/lan-peers';
import { parseUsageMergeBundle, type UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { exportLocalMergeBundle, importPeerMergeBundle, type ImportResult } from '@ai-usage/usage-store';
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

export interface UsageMergePeerTransport {
  fetchMergeBundle(input: {
    url: string;
    token: string;
  }): Effect.Effect<UsageMergeBundle, UsageMergeError>;
}

export interface UsageMergeRuntimeOptions {
  localMachine: UsageMachine;
  dbPath: string;
  peers: StoredLanPeer[];
  discoveredPeers?: DiscoveredLanPeer[];
  peerUrls?: Record<string, string>;
  urls?: string[];
  getToken?: (tokenEnv: string) => string | undefined;
  transport?: UsageMergePeerTransport;
  now?: () => Date;
}

export interface UsageMergeBundleHttpHandlerInput {
  machine: UsageMachine;
  dbPath: string;
  token: string;
  generatedAt?: () => Date;
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

const usageMergeError = (
  operation: string,
  message: string,
  reason: UsageMergeErrorReason,
  cause?: unknown,
): UsageMergeError =>
  new UsageMergeError({
    operation,
    message,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

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

const authorizationToken = (request: Request) => {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
};

export const createUsageMergeBundleHttpHandler =
  (input: UsageMergeBundleHttpHandlerInput) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/lan/merge-bundle') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (authorizationToken(request) !== input.token) return new Response('Unauthorized', { status: 401 });

    const result = await Effect.runPromiseExit(
      exportLocalMergeBundle({
        dbPath: input.dbPath,
        machine: input.machine,
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt() }),
      }),
    );
    if (result._tag === 'Failure') return new Response('Failed to export merge bundle', { status: 500 });
    return Response.json(result.value);
  };

export const fetchUsageMergeBundleTransport: UsageMergePeerTransport = {
  fetchMergeBundle: ({ url, token }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (response.status === 401) {
          throw usageMergeError('fetchMergeBundle', 'Peer rejected the configured LAN merge token.', 'missing-token');
        }
        if (!response.ok) {
          throw usageMergeError(
            'fetchMergeBundle',
            `Peer merge bundle request failed with HTTP ${response.status}.`,
            'peer-offline',
          );
        }
        return parseUsageMergeBundle(await response.text());
      },
      catch: (cause) => {
        if (cause instanceof UsageMergeError) return cause;
        return usageMergeError('fetchMergeBundle', 'Peer is offline or unreachable for LAN merge.', 'peer-offline', cause);
      },
    }),
};

const trustedPeerFromStored = (
  peer: StoredLanPeer,
  input: {
    online: boolean;
    lastMergedAt?: string;
    rows?: number;
    warnings?: number;
  },
): TrustedLanPeer => ({
  machineId: peer.machineId,
  machineLabel: peer.machineLabel,
  tokenEnv: peer.tokenEnv,
  pairedAt: peer.pairedAt,
  online: input.online,
  paired: true,
  ...(peer.lastSeenAt === undefined ? {} : { lastSeenAt: peer.lastSeenAt }),
  ...(input.lastMergedAt === undefined ? {} : { lastMergedAt: input.lastMergedAt }),
  ...(input.rows === undefined ? {} : { rows: input.rows }),
  warnings: input.warnings ?? 0,
});

export const createUsageMergeRuntime = (options: UsageMergeRuntimeOptions): UsageMergeService => {
  const transport = options.transport ?? fetchUsageMergeBundleTransport;
  const peerStats = new Map<string, { lastMergedAt?: string; rows?: number; warnings?: number }>();
  let serviceStatus: LanMergeState['service']['status'] = 'stopped';
  let lastError: string | undefined;

  const now = () => options.now?.() ?? new Date();

  const getToken = (tokenEnv: string) => options.getToken?.(tokenEnv) ?? process.env[tokenEnv];

  const peerByMachineId = (machineId: string) => options.peers.find((peer) => peer.machineId === machineId);

  const state = (): LanMergeState => ({
    localMachine: options.localMachine,
    service: {
      status: serviceStatus,
      urls: options.urls ?? Object.values(options.peerUrls ?? {}),
      ...(lastError === undefined ? {} : { lastError }),
    },
    discoveredPeers: options.discoveredPeers ?? [],
    trustedPeers: options.peers.map((peer) =>
      trustedPeerFromStored(peer, {
        online: Boolean(options.peerUrls?.[peer.machineId]),
        ...peerStats.get(peer.machineId),
      }),
    ),
  });

  const mergePeer = (input: MergePeerInput): Effect.Effect<ImportResult, UsageMergeError> =>
    Effect.gen(function* () {
      if (input.machineId === options.localMachine.id) {
        return yield* Effect.fail(
          usageMergeError('mergePeer', 'Cannot merge this machine into itself.', 'self-merge'),
        );
      }

      const peer = peerByMachineId(input.machineId);
      if (!peer) {
        return yield* Effect.fail(usageMergeError('mergePeer', 'Peer is not paired with this machine.', 'peer-not-found'));
      }

      const token = getToken(peer.tokenEnv);
      if (!token) {
        return yield* Effect.fail(
          usageMergeError('mergePeer', `Missing LAN merge token in ${peer.tokenEnv}.`, 'missing-token'),
        );
      }

      const url = options.peerUrls?.[peer.machineId];
      if (!url) {
        return yield* Effect.fail(
          usageMergeError('mergePeer', 'Peer is offline or has no merge bundle endpoint.', 'peer-offline'),
        );
      }

      const bundle = yield* transport.fetchMergeBundle({ url, token });
      const result = yield* importPeerMergeBundle({
        dbPath: options.dbPath,
        localMachineId: options.localMachine.id,
        bundle,
        importedAt: now(),
      }).pipe(
        Effect.mapError((cause) =>
          usageMergeError('mergePeer', `Could not import peer bundle from ${peer.machineLabel}.`, 'store-failed', cause),
        ),
      );

      peerStats.set(peer.machineId, {
        lastMergedAt: now().toISOString(),
        rows: bundle.rows.length,
        warnings: bundle.warnings.length,
      });
      lastError = undefined;
      return result;
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          lastError = error.message;
        }),
      ),
    );

  return {
    startLanMerge: () =>
      Effect.sync(() => {
        serviceStatus = 'running';
        lastError = undefined;
      }),
    stopLanMerge: () =>
      Effect.sync(() => {
        serviceStatus = 'stopped';
      }),
    getLanMergeState: () => Effect.sync(state),
    scanLanMergePeers: () => Effect.sync(state),
    pairPeer: (input) => {
      const discoveredPeer = options.discoveredPeers?.find((peer) => peer.identity.id === input.discoveredPeerId);
      if (!discoveredPeer) {
        return Effect.fail(usageMergeError('pairPeer', 'Discovered peer is no longer available.', 'peer-not-found'));
      }
      if (discoveredPeer.identity.id === options.localMachine.id) {
        return Effect.fail(usageMergeError('pairPeer', 'Cannot pair this machine with itself.', 'self-merge'));
      }
      if (!peerByMachineId(discoveredPeer.identity.id)) {
        return Effect.fail(
          usageMergeError('pairPeer', 'Pairing credentials were not recorded for this peer.', 'pairing-failed'),
        );
      }
      return mergePeer({ machineId: discoveredPeer.identity.id }).pipe(Effect.zipRight(Effect.sync(state)));
    },
    mergePeer,
    forgetPeer: (input) =>
      Effect.sync(() => {
        peerStats.delete(input.machineId);
        return state();
      }),
    readPeerStatuses: () => Effect.sync(() => ({ peers: state().trustedPeers })),
  };
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
