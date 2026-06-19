import os from 'node:os';
import { Context, Data, Effect, Layer, Ref } from 'effect';

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
  self: boolean;
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
  host?: string;
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

export interface LanPairingServerHandle {
  port: number;
  urls: string[];
  stop: () => void | Promise<void>;
}

export interface LanPeerProbeInput {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface LanPeerProbeResult {
  identity: LanPeerIdentity;
  pairingAvailable: boolean;
}

export interface LanPeerProbeTransport {
  readPeer(input: LanPeerProbeInput): Effect.Effect<LanPeerProbeResult, LanPairingError>;
}

export interface DiscoverLanPeersInput {
  localIdentity: LanPeerIdentity;
  hosts?: string[];
  ports?: number[];
  timeoutMs?: number;
  cache?: DiscoveredLanPeer[];
  transport?: LanPeerProbeTransport;
  now?: Date;
}

export interface LanPairingRuntimeOptions {
  discoveryHosts?: string[];
  discoveryTimeoutMs?: number;
  discoveryTransport?: LanPeerProbeTransport;
}

interface RuntimeState {
  pairing?: PairingState;
  server?: LanPairingServerHandle;
  state: LanPairingState;
}

const stoppedIdentity: LanPeerIdentity = {
  id: '',
  label: '',
  protocol: '',
  version: 1,
};

const initialState = (): RuntimeState => ({
  state: {
    localIdentity: stoppedIdentity,
    status: 'stopped',
    urls: [],
    discoveredPeers: [],
    trustedPeers: [],
  },
});

const jsonResponse = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const portRangeValues = (range = LAN_PAIRING_PORT_RANGE) =>
  Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);

export const subnetHostsForAddress = (address: string) => {
  const parts = address.split('.');
  if (parts.length !== 4) return [];
  if (!parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)) return [];
  const prefix = parts.slice(0, 3).join('.');
  return Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`).filter((host) => host !== address);
};

export const discoveryHostsForAddresses = (addresses: string[]) =>
  [...new Set(addresses.flatMap(subnetHostsForAddress))];

export const lanInterfaceAddresses = () =>
  Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);

export const defaultDiscoveryHosts = () => discoveryHostsForAddresses(lanInterfaceAddresses());

const peerUrl = (host: string, port: number) => `http://${host}:${port}/lan/peer`;

const isLanPeerIdentity = (value: unknown): value is LanPeerIdentity =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  typeof value.label === 'string' &&
  typeof value.protocol === 'string' &&
  typeof value.version === 'number';

const parsePeerProbeResult = (value: unknown): LanPeerProbeResult => {
  if (!isRecord(value) || !isLanPeerIdentity(value.identity)) {
    throw new Error('LAN peer response missing identity');
  }
  return {
    identity: value.identity,
    pairingAvailable: value.pairingAvailable === true,
  };
};

export const fetchLanPeerProbeTransport: LanPeerProbeTransport = {
  readPeer: (input) =>
    Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 800);
        try {
          const response = await fetch(peerUrl(input.host, input.port), { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return parsePeerProbeResult(await response.json());
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: (cause) =>
        new LanPairingError({
          operation: 'readLanPeer',
          message: `Failed to read ${peerUrl(input.host, input.port)}: ${cause instanceof Error ? cause.message : String(cause)}`,
          reason: 'peer-not-found',
        }),
    }),
};

export const discoverLanPeers = (
  input: DiscoverLanPeersInput,
): Effect.Effect<DiscoveredLanPeer[], never> =>
  Effect.gen(function* () {
    const hosts = [...new Set(input.hosts ?? defaultDiscoveryHosts())];
    const ports = [...new Set(input.ports ?? portRangeValues())];
    const transport = input.transport ?? fetchLanPeerProbeTransport;
    const lastSeenAt = (input.now ?? new Date()).toISOString();
    const byMachine = new Map<string, DiscoveredLanPeer>();

    for (const cached of input.cache ?? []) {
      byMachine.set(cached.identity.id, { ...cached, online: false });
    }

    yield* Effect.all(
      hosts.flatMap((host) =>
        ports.map((port) =>
          transport.readPeer({ host, port, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) }).pipe(
            Effect.map((probe) => {
              const discovered: DiscoveredLanPeer = {
                identity: probe.identity,
                host,
                port,
                online: true,
                pairingAvailable: probe.pairingAvailable,
                self: probe.identity.id === input.localIdentity.id,
                lastSeenAt,
              };
              const existing = byMachine.get(discovered.identity.id);
              if (!existing || !existing.online) byMachine.set(discovered.identity.id, discovered);
            }),
            Effect.catchAll(() => Effect.void),
          ),
        ),
      ),
      { concurrency: 32 },
    );

    return [...byMachine.values()].sort(
      (a, b) => Number(a.self) - Number(b.self) || a.identity.label.localeCompare(b.identity.label) || a.host.localeCompare(b.host),
    );
  });

const parsePairingInput = async (request: Request): Promise<PairingInput> => {
  const value = (await request.json()) as unknown;
  if (!isRecord(value) || typeof value.peerId !== 'string' || typeof value.password !== 'string') {
    throw new LanPairingError({
      operation: 'parsePairingInput',
      message: 'Pairing request must include peerId and password strings.',
      reason: 'invalid-input',
    });
  }
  return { peerId: value.peerId, password: value.password };
};

const publicPeerState = (state: LanPairingState, pairing: PairingState | undefined) => ({
  identity: state.localIdentity,
  online: state.status === 'running' || state.status === 'pairing',
  pairingAvailable: state.status === 'running' || state.status === 'pairing',
  pairing: pairing ? { peerId: pairing.peerId, startedAt: pairing.startedAt, expiresAt: pairing.expiresAt } : null,
  port: state.port ?? null,
  urls: state.urls,
});

const startPairingInRef = (ref: Ref.Ref<RuntimeState>, input: PairingInput): Effect.Effect<PairingState, LanPairingError> =>
  Effect.gen(function* () {
    if (!input.peerId || !input.password) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'startPairing',
          message: 'Pairing requires a peer id and password.',
          reason: 'invalid-input',
        }),
      );
    }

    const current = yield* Ref.get(ref);
    if (current.state.status === 'stopped') {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'startPairing',
          message: 'LAN pairing service is stopped.',
          reason: 'service-stopped',
        }),
      );
    }

    const startedAt = new Date();
    const pairing: PairingState = {
      peerId: input.peerId,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + 5 * 60_000).toISOString(),
    };
    yield* Ref.update(ref, (runtime) => ({
      ...runtime,
      pairing,
      state: {
        ...runtime.state,
        status: 'pairing' as const,
      },
    }));
    return pairing;
  });

const confirmPairingInRef = (ref: Ref.Ref<RuntimeState>, input: PairingInput): Effect.Effect<PairingResult, LanPairingError> =>
  Effect.gen(function* () {
    if (!input.peerId || !input.password) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'confirmPairing',
          message: 'Pairing confirmation requires a peer id and password.',
          reason: 'invalid-input',
        }),
      );
    }

    const current = yield* Ref.get(ref);
    if (!current.pairing || current.pairing.peerId !== input.peerId) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'confirmPairing',
          message: `No active pairing session for peer ${input.peerId}.`,
          reason: 'pairing-failed',
        }),
      );
    }

    const now = new Date().toISOString();
    const peer: TrustedLanPeer = {
      identity: {
        id: input.peerId,
        label: input.peerId,
        protocol: current.state.localIdentity.protocol,
        version: current.state.localIdentity.version,
      },
      pairedAt: now,
      lastSeenAt: now,
      metadata: {},
    };
    const result: PairingResult = {
      peer,
      receivedEnvelope: {
        peerId: input.peerId,
        credential: input.password,
        metadata: {},
      },
      sentEnvelope: {
        peerId: current.state.localIdentity.id,
        credential: input.password,
        metadata: {},
      },
    };

    yield* Ref.update(ref, (runtime) => {
      const { pairing: _pairing, ...withoutPairing } = runtime;
      return {
        ...withoutPairing,
        state: {
          ...runtime.state,
          status: 'running' as const,
          trustedPeers: [
            ...runtime.state.trustedPeers.filter((trusted) => trusted.identity.id !== peer.identity.id),
            peer,
          ],
        },
      };
    });
    return result;
  });

export const createLanPairingHttpHandler =
  (ref: Ref.Ref<RuntimeState>) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/lan/health') {
      const runtime = await Effect.runPromise(Ref.get(ref));
      return jsonResponse({
        ok: runtime.state.status === 'running' || runtime.state.status === 'pairing',
        status: runtime.state.status,
        peer: publicPeerState(runtime.state, runtime.pairing),
      });
    }

    if (request.method === 'GET' && url.pathname === '/lan/peer') {
      const runtime = await Effect.runPromise(Ref.get(ref));
      return jsonResponse(publicPeerState(runtime.state, runtime.pairing));
    }

    if (request.method === 'POST' && url.pathname === '/lan/pairing/start') {
      try {
        const input = await parsePairingInput(request);
        return jsonResponse(await Effect.runPromise(startPairingInRef(ref, input)));
      } catch (cause) {
        return jsonResponse({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/lan/pairing/confirm') {
      try {
        const input = await parsePairingInput(request);
        const result = await Effect.runPromise(confirmPairingInRef(ref, input));
        return jsonResponse({
          peer: result.peer,
          receivedEnvelope: { ...result.receivedEnvelope, credential: '[redacted]' },
          sentEnvelope: { ...result.sentEnvelope, credential: '[redacted]' },
        });
      } catch (cause) {
        return jsonResponse({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
      }
    }

    return new Response('not found', { status: 404 });
  };

const urlsFor = (host: string, port: number) => [`http://${host}:${port}/lan/peer`];

const startServerOnPort = (
  ref: Ref.Ref<RuntimeState>,
  host: string,
  port: number,
): Effect.Effect<LanPairingServerHandle, LanPairingError> =>
  Effect.try({
    try: () => {
      const server = Bun.serve({
        hostname: host,
        port,
        fetch: createLanPairingHttpHandler(ref),
      });
      const boundPort = server.port ?? port;
      return {
        port: boundPort,
        urls: urlsFor(host, boundPort),
        stop: () => {
          void server.stop();
        },
      };
    },
    catch: (cause) =>
      new LanPairingError({
        operation: 'startLanPairingServer',
        message: `Unable to bind ${host}:${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
        reason: 'port-unavailable',
      }),
  });

const startServerInRange = (
  ref: Ref.Ref<RuntimeState>,
  host: string,
  portRange: { start: number; end: number },
): Effect.Effect<LanPairingServerHandle, LanPairingError> =>
  Effect.gen(function* () {
    if (portRange.start > portRange.end) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'startLanPairingServer',
          message: `Invalid port range ${portRange.start}-${portRange.end}.`,
          reason: 'invalid-input',
        }),
      );
    }

    let lastError: LanPairingError | undefined;
    for (let port = portRange.start; port <= portRange.end; port++) {
      const result = yield* Effect.either(startServerOnPort(ref, host, port));
      if (result._tag === 'Right') return result.right;
      lastError = result.left;
    }

    return yield* Effect.fail(
      new LanPairingError({
        operation: 'startLanPairingServer',
        message: `No available LAN pairing port in ${portRange.start}-${portRange.end}: ${lastError?.message ?? 'all ports unavailable'}`,
        reason: 'port-unavailable',
      }),
    );
  });

export const makeLanPairingServiceWithOptions = (
  options: LanPairingRuntimeOptions = {},
): Effect.Effect<LanPairingService, never> =>
  Effect.gen(function* () {
  const ref = yield* Ref.make(initialState());

  const service: LanPairingService = {
    start: (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(ref);
        if (current.server) return;

        const host = input.host ?? '127.0.0.1';
        const portRange = input.portRange ?? LAN_PAIRING_PORT_RANGE;
        yield* Ref.update(ref, (runtime) => {
          const { lastError: _lastError, ...stateWithoutLastError } = runtime.state;
          return {
            ...runtime,
            state: {
              ...stateWithoutLastError,
              localIdentity: input.identity,
              status: 'starting' as const,
            },
          };
        });

        const server = yield* startServerInRange(ref, host, portRange).pipe(
          Effect.tapError((error) =>
            Ref.update(ref, (runtime) => ({
              ...runtime,
              state: {
                ...runtime.state,
                status: 'error' as const,
                lastError: error.message,
              },
            })),
          ),
        );

        yield* Ref.update(ref, (runtime) => ({
          ...runtime,
          server,
          state: {
            ...runtime.state,
            status: 'running' as const,
            port: server.port,
            urls: server.urls,
          },
        }));
      }),
    stop: () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(ref);
        if (!current.server) {
          yield* Ref.set(ref, initialState());
          return;
        }

        yield* Effect.tryPromise({
          try: async () => {
            await current.server?.stop();
          },
          catch: (cause) =>
            new LanPairingError({
              operation: 'stopLanPairingServer',
              message: `Failed to stop LAN pairing server: ${cause instanceof Error ? cause.message : String(cause)}`,
              reason: 'pairing-failed',
            }),
        });
        yield* Ref.set(ref, initialState());
      }),
    scan: () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(ref);
        if (current.state.status === 'stopped') {
          return yield* Effect.fail(
            new LanPairingError({
              operation: 'scan',
              message: 'LAN pairing service is stopped.',
              reason: 'service-stopped',
            }),
          );
        }

        const discoveredPeers = yield* discoverLanPeers({
          localIdentity: current.state.localIdentity,
          cache: current.state.discoveredPeers,
          ...(options.discoveryHosts === undefined ? {} : { hosts: options.discoveryHosts }),
          ...(options.discoveryTimeoutMs === undefined ? {} : { timeoutMs: options.discoveryTimeoutMs }),
          ...(options.discoveryTransport === undefined ? {} : { transport: options.discoveryTransport }),
        });
        yield* Ref.update(ref, (runtime) => ({
          ...runtime,
          state: {
            ...runtime.state,
            discoveredPeers,
          },
        }));
        return discoveredPeers;
      }),
    startPairing: (input) => startPairingInRef(ref, input),
    confirmPairing: (input) => confirmPairingInRef(ref, input),
    getState: () => Ref.get(ref).pipe(Effect.map((runtime) => runtime.state)),
  };

  return service;
});

export const makeLanPairingService = makeLanPairingServiceWithOptions();

export class LanPairingRuntime extends Context.Tag('@ai-usage/lan-pairing/LanPairingRuntime')<
  LanPairingRuntime,
  LanPairingService
>() {}

export const LanPairingRuntimeLive = Layer.effect(LanPairingRuntime, makeLanPairingService);
