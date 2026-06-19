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

export const makeLanPairingService: Effect.Effect<LanPairingService, never> = Effect.gen(function* () {
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
    scan: () => Effect.succeed([]),
    startPairing: (input) => startPairingInRef(ref, input),
    confirmPairing: (input) => confirmPairingInRef(ref, input),
    getState: () => Ref.get(ref).pipe(Effect.map((runtime) => runtime.state)),
  };

  return service;
});

export class LanPairingRuntime extends Context.Tag('@ai-usage/lan-pairing/LanPairingRuntime')<
  LanPairingRuntime,
  LanPairingService
>() {}

export const LanPairingRuntimeLive = Layer.effect(LanPairingRuntime, makeLanPairingService);
