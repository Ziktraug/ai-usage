import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type DiscoveredLanPeer,
  LAN_PAIRING_PORT_RANGE,
  type LanPairingService,
  type LanPairingState,
  type LanPeerIdentity,
  type PairingEnvelope,
  type PairingResult,
  pairWithLanPeer,
} from '@ai-usage/lan-pairing';
import type { StoredLanPeer } from '@ai-usage/local-collectors/lan-peers';
import { safeTokenEqual } from '@ai-usage/report-core/auth';
import { parseUsageMergeBundle, type UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { exportLocalMergeBundle, type ImportResult, importPeerMergeBundle } from '@ai-usage/usage-store';
import { Data, Effect } from 'effect';

export const USAGE_MERGE_PROTOCOL = 'ai-usage-lan-merge' as const;
export const USAGE_MERGE_PROTOCOL_VERSION = 1 as const;

export interface TrustedLanPeer {
  lastMergedAt?: string;
  lastSeenAt?: string;
  machineId: string;
  machineLabel: string;
  online: boolean;
  paired: boolean;
  pairedAt: string;
  rows?: number;
  tokenEnv: string;
  warnings: number;
}

export interface LanMergeState {
  discoveredPeers: DiscoveredLanPeer[];
  localMachine: UsageMachine;
  service: {
    status: 'stopped' | 'starting' | 'running' | 'pairing' | 'error';
    urls: string[];
    lastError?: string;
  };
  trustedPeers: TrustedLanPeer[];
}

export interface PairPeerInput {
  discoveredPeerId: string;
  password: string;
  url?: string | null;
}

export interface MergePeerInput {
  machineId: string;
  url?: string | null;
}

export interface ScanLanMergePeersInput {
  hosts?: string[];
  timeoutMs?: number;
}

export interface ForgetPeerInput {
  deleteRows?: boolean;
  machineId: string;
}

export interface PeerStatusResult {
  peers: TrustedLanPeer[];
}

export interface ManualMergeExportResult {
  bundle: UsageMergeBundle;
  filename: string;
}

export interface ManualMergeImportInput {
  text: string;
}

export interface ManualMergeImportResult {
  generatedAt: string;
  machine: UsageMachine;
  result: ImportResult;
  rows: number;
  warnings: number;
}

export interface FetchPeerMergeBundleResult {
  bundle: UsageMergeBundle;
  peer: TrustedLanPeer;
}

export interface UsageMergePeerTransport {
  fetchMergeBundle(input: { url: string; token: string }): Effect.Effect<UsageMergeBundle, UsageMergeError>;
}

export interface UsageMergeRuntimeOptions {
  dbPath: string;
  discoveredPeers?: DiscoveredLanPeer[];
  getToken?: (tokenEnv: string) => string | undefined;
  lanHost?: string;
  lanPairing?: LanPairingService;
  localMachine: UsageMachine;
  localToken?: string;
  localTokenEnv?: string;
  now?: () => Date;
  peers: StoredLanPeer[];
  peerUrls?: Record<string, string>;
  persistToken?: (key: string, value: string) => void | Promise<void>;
  persistTrustedPeer?: (peer: StoredLanPeer) => void | Promise<void>;
  transport?: UsageMergePeerTransport;
  urls?: string[];
}

export interface UsageMergeBundleHttpHandlerInput {
  dbPath: string;
  generatedAt?: () => Date;
  machine: UsageMachine;
  token: string;
}

export interface ResolveUsageMergeBundleInput {
  dbPath: string;
  expectedToken: string;
  generatedAt?: Date;
  machine: UsageMachine;
  providedToken: string | null;
}

export type UsageMergeBundleResolution =
  | { kind: 'unauthorized' }
  | { kind: 'export-failed'; error: unknown }
  | { kind: 'ready'; bundle: UsageMergeBundle };

export interface UsageMergeCredential {
  token: string;
  tokenEnv: string;
  version: 1;
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

const manualMergeFilenameForMachine = (machine: UsageMachine, generatedAt: Date) => {
  const machineName = (machine.label || machine.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  return `ai-usage-${machineName || 'machine'}-${timestamp}.json`;
};

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

const shellToken = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

export const usageMergeTokenEnvNameForMachine = (machine: UsageMachine) =>
  `AI_USAGE_LAN_MERGE_${shellToken(machine.label || machine.id) || 'REMOTE'}_TOKEN`;

export const createUsageMergeToken = () => randomBytes(32).toString('base64url');

const toBase64Url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TOKEN_ENV_PATTERN = /^AI_USAGE_[A-Z0-9_]+_TOKEN$/;
const LINE_BREAK_PATTERN = /[\r\n]/;
const PRIVATE_FILE_MODE = 0o600;

const isCredential = (value: unknown): value is UsageMergeCredential =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.tokenEnv === 'string' &&
  TOKEN_ENV_PATTERN.test(value.tokenEnv) &&
  typeof value.token === 'string' &&
  value.token.length > 0;

export const encodeUsageMergeCredential = (credential: Omit<UsageMergeCredential, 'version'>) =>
  toBase64Url(JSON.stringify({ version: 1, ...credential } satisfies UsageMergeCredential));

export const decodeUsageMergeCredential = (value: string): UsageMergeCredential => {
  const parsed = JSON.parse(fromBase64Url(value)) as unknown;
  if (!isCredential(parsed)) {
    throw new Error('Invalid usage merge credential');
  }
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
  if (input.identity.id !== input.envelope.peerId) {
    throw new Error('Pairing envelope peer id does not match identity');
  }
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
        if (parsed.workspaces) {
          return current;
        }
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
};

export const upsertUsageMergeEnvToken = (key: string, value: string, cwd = process.cwd()) => {
  if (!TOKEN_ENV_PATTERN.test(key)) {
    throw new Error('Invalid usage merge token environment key');
  }
  if (!value || LINE_BREAK_PATTERN.test(value)) {
    throw new Error('Invalid usage merge token value');
  }
  const envPath = path.join(findWorkspaceRoot(cwd), '.env');
  if (fs.existsSync(envPath)) {
    fs.chmodSync(envPath, PRIVATE_FILE_MODE);
  }
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escapedKey}=.*$`, 'm');
  const next = matcher.test(existing)
    ? existing.replace(matcher, line)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, next, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  fs.chmodSync(envPath, PRIVATE_FILE_MODE);
  process.env[key] = value;
  return { path: envPath };
};

export const readUsageMergeEnvToken = (key: string, cwd = process.cwd()) => {
  if (process.env[key]) {
    return process.env[key];
  }
  const envPath = path.join(findWorkspaceRoot(cwd), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${escapedKey}=(.*)$`, 'm'));
  return match?.[1];
};

const authorizationToken = (request: Request) => {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length);
};

export const resolveUsageMergeBundle = (
  input: ResolveUsageMergeBundleInput,
): Effect.Effect<UsageMergeBundleResolution> => {
  if (input.providedToken === null || !safeTokenEqual(input.providedToken, input.expectedToken)) {
    return Effect.succeed({ kind: 'unauthorized' });
  }

  return exportLocalMergeBundle({
    dbPath: input.dbPath,
    machine: input.machine,
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
  }).pipe(
    Effect.map((bundle) => ({ kind: 'ready', bundle }) satisfies UsageMergeBundleResolution),
    Effect.catchAll((error) => Effect.succeed({ kind: 'export-failed', error } satisfies UsageMergeBundleResolution)),
  );
};

export const createUsageMergeBundleHttpHandler =
  (input: UsageMergeBundleHttpHandlerInput) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/lan/merge-bundle') {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }
    const result = await Effect.runPromise(
      resolveUsageMergeBundle({
        dbPath: input.dbPath,
        machine: input.machine,
        expectedToken: input.token,
        providedToken: authorizationToken(request),
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt() }),
      }),
    );
    if (result.kind === 'unauthorized') {
      return new Response('Unauthorized', { status: 401 });
    }
    if (result.kind === 'export-failed') {
      return new Response('Failed to export merge bundle', { status: 500 });
    }
    return Response.json(result.bundle);
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
        if (cause instanceof UsageMergeError) {
          return cause;
        }
        return usageMergeError(
          'fetchMergeBundle',
          'Peer is offline or unreachable for LAN merge.',
          'peer-offline',
          cause,
        );
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

const isPeerWaitingForPairing = (error: unknown) =>
  error instanceof Error && error.message.includes('No active pairing session for peer');

export const createUsageMergeRuntime = (options: UsageMergeRuntimeOptions): UsageMergeService => {
  const transport = options.transport ?? fetchUsageMergeBundleTransport;
  const peers = [...options.peers];
  let discoveredPeers = [...(options.discoveredPeers ?? [])];
  let peerUrls: Record<string, string> = { ...(options.peerUrls ?? {}) };
  const peerStats = new Map<string, { lastMergedAt?: string; rows?: number; warnings?: number }>();
  let serviceStatus: LanMergeState['service']['status'] = 'stopped';
  let lastError: string | undefined;
  let localToken =
    options.localToken ??
    readUsageMergeEnvToken(options.localTokenEnv ?? usageMergeTokenEnvNameForMachine(options.localMachine));

  const now = () => options.now?.() ?? new Date();

  const getToken = (tokenEnv: string) => options.getToken?.(tokenEnv) ?? readUsageMergeEnvToken(tokenEnv);

  const peerByMachineId = (machineId: string) => peers.find((peer) => peer.machineId === machineId);

  const mergeBundleUrlForPeer = (peer: DiscoveredLanPeer) => `http://${peer.host}:${peer.port}/lan/merge-bundle`;

  const refreshPeerUrls = (items: DiscoveredLanPeer[]) => {
    peerUrls = {
      ...peerUrls,
      ...Object.fromEntries(
        items.filter((peer) => peer.online).map((peer) => [peer.identity.id, mergeBundleUrlForPeer(peer)]),
      ),
    };
  };

  const rememberPeerUrl = (machineId: string, url: string | null | undefined) => {
    if (url) {
      peerUrls[machineId] = url;
    }
  };

  refreshPeerUrls(discoveredPeers);

  const state = (lanState?: LanPairingState): LanMergeState => ({
    localMachine: options.localMachine,
    service: {
      status: lanState?.status ?? serviceStatus,
      urls: options.urls ?? lanState?.urls ?? Object.values(peerUrls),
      ...(lastError === undefined ? {} : { lastError }),
    },
    discoveredPeers: lanState?.discoveredPeers ?? discoveredPeers,
    trustedPeers: peers.map((peer) =>
      trustedPeerFromStored(peer, {
        online:
          Boolean(peerUrls[peer.machineId]) ||
          Boolean(
            (lanState?.discoveredPeers ?? discoveredPeers).find(
              (item) => item.identity.id === peer.machineId && item.online,
            ),
          ),
        ...peerStats.get(peer.machineId),
      }),
    ),
  });

  const persistToken = (key: string, value: string) => {
    if (options.persistToken) {
      return options.persistToken(key, value);
    }
    process.env[key] = value;
    return value;
  };

  const persistTrustedPeer = (peer: StoredLanPeer) => options.persistTrustedPeer?.(peer);

  const upsertPeerInMemory = (peer: StoredLanPeer) => {
    const index = peers.findIndex((stored) => stored.machineId === peer.machineId);
    if (index >= 0) {
      peers[index] = peer;
    } else {
      peers.push(peer);
    }
    peers.sort((a, b) => a.machineLabel.localeCompare(b.machineLabel));
  };

  const recordPairingResult = (result: PairingResult): Effect.Effect<StoredLanPeer, UsageMergeError> =>
    Effect.tryPromise({
      try: async () => {
        const pairedAt = now();
        const credential = decodeUsageMergeCredential(result.receivedEnvelope.credential);
        const peer = storedLanPeerFromPairingEnvelope({
          identity: result.peer.identity,
          envelope: result.receivedEnvelope,
          pairedAt,
        });
        await persistToken(credential.tokenEnv, credential.token);
        await persistTrustedPeer(peer);
        upsertPeerInMemory(peer);
        return peer;
      },
      catch: (cause) =>
        usageMergeError('pairPeer', 'Could not persist LAN pairing credentials.', 'pairing-failed', cause),
    });

  const localPairingEnvelope = (): Effect.Effect<PairingEnvelope, UsageMergeError> =>
    Effect.tryPromise({
      try: async () => {
        const tokenEnv = options.localTokenEnv ?? usageMergeTokenEnvNameForMachine(options.localMachine);
        localToken = localToken ?? createUsageMergeToken();
        await persistToken(tokenEnv, localToken);
        return createUsageMergePairingEnvelope({ machine: options.localMachine, tokenEnv, token: localToken });
      },
      catch: (cause) =>
        usageMergeError('startLanMerge', 'Could not prepare local LAN merge credentials.', 'pairing-failed', cause),
    });

  const mergePeer = (input: MergePeerInput): Effect.Effect<ImportResult, UsageMergeError> =>
    Effect.gen(function* () {
      if (input.machineId === options.localMachine.id) {
        return yield* Effect.fail(usageMergeError('mergePeer', 'Cannot merge this machine into itself.', 'self-merge'));
      }

      const peer = peerByMachineId(input.machineId);
      if (!peer) {
        return yield* Effect.fail(
          usageMergeError('mergePeer', 'Peer is not paired with this machine.', 'peer-not-found'),
        );
      }

      rememberPeerUrl(input.machineId, input.url);

      const token = getToken(peer.tokenEnv);
      if (!token) {
        return yield* Effect.fail(
          usageMergeError('mergePeer', `Missing LAN merge token in ${peer.tokenEnv}.`, 'missing-token'),
        );
      }

      const url = peerUrls[peer.machineId];
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
          usageMergeError(
            'mergePeer',
            `Could not import peer bundle from ${peer.machineLabel}.`,
            'store-failed',
            cause,
          ),
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

  const exportManualMergeBundle = (): Effect.Effect<ManualMergeExportResult, UsageMergeError> =>
    Effect.gen(function* () {
      const generatedAt = now();
      const bundle = yield* exportLocalMergeBundle({
        dbPath: options.dbPath,
        machine: options.localMachine,
        generatedAt,
      }).pipe(
        Effect.mapError((cause) =>
          usageMergeError('exportManualMergeBundle', 'Could not export local usage merge file.', 'store-failed', cause),
        ),
      );
      lastError = undefined;
      return {
        filename: manualMergeFilenameForMachine(options.localMachine, generatedAt),
        bundle,
      };
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          lastError = error.message;
        }),
      ),
    );

  const importManualMergeBundle = (
    input: ManualMergeImportInput,
  ): Effect.Effect<ManualMergeImportResult, UsageMergeError> =>
    Effect.gen(function* () {
      const bundle = yield* Effect.try({
        try: () => parseUsageMergeBundle(input.text),
        catch: (cause) =>
          usageMergeError(
            'importManualMergeBundle',
            `Could not parse usage merge file: ${cause instanceof Error ? cause.message : String(cause)}`,
            'invalid-input',
            cause,
          ),
      });
      const result = yield* importPeerMergeBundle({
        dbPath: options.dbPath,
        localMachineId: options.localMachine.id,
        bundle,
        importedAt: now(),
      }).pipe(
        Effect.mapError((cause) =>
          usageMergeError(
            'importManualMergeBundle',
            `Could not import usage merge file from ${bundle.machine.label}.`,
            cause.reason === 'self-import' ? 'self-merge' : 'store-failed',
            cause,
          ),
        ),
      );
      lastError = undefined;
      return {
        machine: bundle.machine,
        generatedAt: bundle.generatedAt,
        rows: bundle.rows.length,
        warnings: bundle.warnings.length,
        result,
      };
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          lastError = error.message;
        }),
      ),
    );

  return {
    startLanMerge: () =>
      Effect.gen(function* () {
        const envelope = yield* localPairingEnvelope();
        if (options.lanPairing) {
          yield* options.lanPairing
            .start({
              identity: lanIdentityFromMachine(options.localMachine),
              host: options.lanHost ?? '0.0.0.0',
              portRange: LAN_PAIRING_PORT_RANGE,
              extraHandler: createUsageMergeBundleHttpHandler({
                machine: options.localMachine,
                dbPath: options.dbPath,
                token: localToken ?? decodeUsageMergeCredential(envelope.credential).token,
              }),
              onPairingComplete: async (result) => {
                const peer = await Effect.runPromise(recordPairingResult(result));
                if (peerUrls[peer.machineId]) {
                  await Effect.runPromise(mergePeer({ machineId: peer.machineId }).pipe(Effect.either));
                }
              },
            })
            .pipe(
              Effect.mapError((cause) =>
                usageMergeError(
                  'startLanMerge',
                  `Could not start LAN merge service: ${cause.message}`,
                  'peer-offline',
                  cause,
                ),
              ),
            );
        }
        serviceStatus = 'running';
        lastError = undefined;
      }),
    stopLanMerge: () =>
      Effect.gen(function* () {
        if (options.lanPairing) {
          yield* options.lanPairing
            .stop()
            .pipe(
              Effect.mapError((cause) =>
                usageMergeError(
                  'stopLanMerge',
                  `Could not stop LAN merge service: ${cause.message}`,
                  'peer-offline',
                  cause,
                ),
              ),
            );
        }
        serviceStatus = 'stopped';
      }),
    getLanMergeState: () =>
      Effect.gen(function* () {
        const lanState = options.lanPairing ? yield* options.lanPairing.getState() : undefined;
        return state(lanState);
      }),
    scanLanMergePeers: (input = {}) =>
      Effect.gen(function* () {
        if (options.lanPairing) {
          discoveredPeers = yield* options.lanPairing
            .scan(input)
            .pipe(
              Effect.mapError((cause) =>
                usageMergeError(
                  'scanLanMergePeers',
                  `Could not scan LAN peers: ${cause.message}`,
                  'peer-offline',
                  cause,
                ),
              ),
            );
          refreshPeerUrls(discoveredPeers);
          return state(yield* options.lanPairing.getState());
        }
        return state();
      }),
    pairPeer: (input) => {
      const discoveredPeer = discoveredPeers.find((peer) => peer.identity.id === input.discoveredPeerId);
      if (!discoveredPeer) {
        return Effect.fail(usageMergeError('pairPeer', 'Discovered peer is no longer available.', 'peer-not-found'));
      }
      if (discoveredPeer.identity.id === options.localMachine.id) {
        return Effect.fail(usageMergeError('pairPeer', 'Cannot pair this machine with itself.', 'self-merge'));
      }
      if (!options.lanPairing) {
        rememberPeerUrl(discoveredPeer.identity.id, input.url);
        if (!peerByMachineId(discoveredPeer.identity.id)) {
          return Effect.fail(
            usageMergeError('pairPeer', 'Pairing credentials were not recorded for this peer.', 'pairing-failed'),
          );
        }
        return mergePeer({
          machineId: discoveredPeer.identity.id,
          ...(input.url === undefined ? {} : { url: input.url }),
        }).pipe(Effect.zipRight(Effect.sync(() => state())));
      }
      return Effect.gen(function* () {
        const envelope = yield* localPairingEnvelope();
        yield* options
          .lanPairing!.startPairing({
            peerId: discoveredPeer.identity.id,
            password: input.password,
            envelope,
          })
          .pipe(
            Effect.mapError((cause) =>
              usageMergeError(
                'pairPeer',
                `Could not open local pairing session: ${cause.message}`,
                'pairing-failed',
                cause,
              ),
            ),
          );
        const pairAttempt = yield* Effect.either(
          pairWithLanPeer({
            localIdentity: lanIdentityFromMachine(options.localMachine),
            peer: discoveredPeer,
            password: input.password,
            envelope,
          }),
        );
        if (pairAttempt._tag === 'Left') {
          if (isPeerWaitingForPairing(pairAttempt.left)) {
            const lanState = yield* options.lanPairing!.getState();
            return state(lanState);
          }
          return yield* Effect.fail(
            usageMergeError(
              'pairPeer',
              `Could not pair with ${discoveredPeer.identity.label}: ${pairAttempt.left.message}`,
              'pairing-failed',
              pairAttempt.left,
            ),
          );
        }
        const result = pairAttempt.right;
        const peer = yield* recordPairingResult(result);
        peerUrls[peer.machineId] = input.url ?? mergeBundleUrlForPeer(discoveredPeer);
        yield* mergePeer({
          machineId: peer.machineId,
          ...(input.url === undefined ? {} : { url: input.url }),
        });
        const lanState = yield* options.lanPairing!.getState();
        return state(lanState);
      });
    },
    mergePeer,
    exportManualMergeBundle,
    importManualMergeBundle,
    forgetPeer: (input) =>
      Effect.sync(() => {
        peerStats.delete(input.machineId);
        return state();
      }),
    readPeerStatuses: () => Effect.sync(() => ({ peers: state().trustedPeers })),
  };
};

export interface UsageMergeService {
  exportManualMergeBundle(): Effect.Effect<ManualMergeExportResult, UsageMergeError>;
  forgetPeer(input: ForgetPeerInput): Effect.Effect<LanMergeState, UsageMergeError>;
  getLanMergeState(): Effect.Effect<LanMergeState, UsageMergeError>;
  importManualMergeBundle(input: ManualMergeImportInput): Effect.Effect<ManualMergeImportResult, UsageMergeError>;
  mergePeer(input: MergePeerInput): Effect.Effect<ImportResult, UsageMergeError>;
  pairPeer(input: PairPeerInput): Effect.Effect<LanMergeState, UsageMergeError>;
  readPeerStatuses(): Effect.Effect<PeerStatusResult, UsageMergeError>;
  scanLanMergePeers(input?: ScanLanMergePeersInput): Effect.Effect<LanMergeState, UsageMergeError>;
  startLanMerge(): Effect.Effect<void, UsageMergeError>;
  stopLanMerge(): Effect.Effect<void, UsageMergeError>;
}
