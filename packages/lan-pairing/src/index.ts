import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { ristretto255 as cpaceRistretto255 } from '@cipherman/pake-js/cpace';
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
  extraHandler?: LanPairingExtraHandler;
  onPairingComplete?: (result: PairingResult) => void | Promise<void>;
}

export interface PairingInput {
  peerId: string;
  password: string;
  envelope?: PairingEnvelope;
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

export interface LanPairingExtraHandler {
  (request: Request): Response | null | Promise<Response | null>;
}

export type PakePairingRole = 'initiator' | 'responder';

export interface PakeTranscript {
  localPeerId: string;
  remotePeerId: string;
  protocol: string;
  protocolVersion: number;
  sessionId: string;
  role: PakePairingRole;
}

export interface PakeHandshakeMessage {
  peerId: string;
  protocol: string;
  protocolVersion: number;
  sessionId: string;
  role: PakePairingRole;
  share: string;
  associatedData: string;
}

export interface PakePrivateState {
  transcript: PakeTranscript;
  expiresAt: string;
  ephemeralSecret: string;
  ownShare: string;
  ownAssociatedData: string;
}

export interface PakeStartInput extends PakeTranscript {
  password: string;
  ttlMs?: number;
  now?: Date;
}

export interface PakeStartResult {
  state: PakePrivateState;
  message: PakeHandshakeMessage;
}

export interface PakeCompleteInput {
  state: PakePrivateState;
  peerMessage: PakeHandshakeMessage;
  now?: Date;
}

export interface PakeCompleteResult {
  sessionKey: string;
  confirmation: string;
}

export interface PakeVerifyInput {
  sessionKey: string;
  peerRole: PakePairingRole;
  confirmation: string;
}

export interface CredentialPairingPartyInput {
  identity: LanPeerIdentity;
  password: string;
  envelope: PairingEnvelope;
}

export interface PairCredentialEnvelopesInput {
  initiator: CredentialPairingPartyInput;
  responder: CredentialPairingPartyInput;
  protocol: string;
  protocolVersion: number;
  sessionId: string;
  ttlMs?: number;
  now?: Date;
  completedAt?: Date;
}

export interface PairCredentialEnvelopesResult {
  initiator: PairingResult;
  responder: PairingResult;
  sessionKey: string;
}

export interface EncryptedPairingEnvelope {
  algorithm: 'aes-256-gcm';
  nonce: string;
  ciphertext: string;
}

export interface PairingExchangeRequest {
  identity: LanPeerIdentity;
  message: PakeHandshakeMessage;
}

export interface PairingExchangeResponse {
  identity: LanPeerIdentity;
  message: PakeHandshakeMessage;
  confirmation: string;
  encryptedEnvelope: EncryptedPairingEnvelope;
}

export interface PairingFinalizeRequest {
  identity: LanPeerIdentity;
  sessionId: string;
  confirmation: string;
  encryptedEnvelope: EncryptedPairingEnvelope;
}

export interface PairWithLanPeerInput {
  localIdentity: LanPeerIdentity;
  peer: DiscoveredLanPeer;
  password: string;
  envelope: PairingEnvelope;
  sessionId?: string;
  ttlMs?: number;
  now?: Date;
}

export type LanPairingErrorReason =
  | 'invalid-input'
  | 'port-unavailable'
  | 'service-stopped'
  | 'peer-not-found'
  | 'pairing-failed'
  | 'pake-failed'
  | 'protocol-mismatch';

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
  serverRuntime?: 'auto' | 'bun' | 'node';
}

interface RuntimeState {
  pairing?: ActivePairingSession;
  server?: LanPairingServerHandle;
  state: LanPairingState;
  extraHandler?: LanPairingExtraHandler;
  onPairingComplete?: (result: PairingResult) => void | Promise<void>;
}

interface PendingPairingExchange {
  peerIdentity: LanPeerIdentity;
  sessionId: string;
  sessionKey: string;
  confirmation: string;
}

interface ActivePairingSession {
  state: PairingState;
  password: string;
  envelope?: PairingEnvelope;
  pending: Record<string, PendingPairingExchange>;
}

interface BunServeRuntime {
  serve(input: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): {
    port?: number;
    stop: () => void | Promise<void>;
  };
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

const isPairingEnvelope = (value: unknown): value is PairingEnvelope =>
  isRecord(value) &&
  typeof value.peerId === 'string' &&
  typeof value.credential === 'string' &&
  isRecord(value.metadata) &&
  Object.values(value.metadata).every((item) => typeof item === 'string');

const textEncoder = new TextEncoder();

const stableJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return 'null';
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
};

const toBytes = (value: string) => textEncoder.encode(value);

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

const fromBase64Url = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));

const transcriptChannelIdentifier = (input: Omit<PakeTranscript, 'role'>) =>
  toBytes(
    stableJson({
      peerIds: [input.localPeerId, input.remotePeerId].sort(),
      protocol: input.protocol,
      protocolVersion: input.protocolVersion,
      sessionId: input.sessionId,
    }),
  );

const transcriptAssociatedData = (input: PakeTranscript) =>
  toBytes(
    stableJson({
      peerId: input.localPeerId,
      protocol: input.protocol,
      protocolVersion: input.protocolVersion,
      role: input.role,
      sessionId: input.sessionId,
    }),
  );

const passwordRelatedString = (password: string, transcript: PakeTranscript) =>
  scryptSync(password, transcriptChannelIdentifier(transcript), 64, { N: 16_384, r: 8, p: 1 });

const assertValidPakeStart = (input: PakeStartInput) => {
  if (!input.password) {
    throw new LanPairingError({
      operation: 'startPakePairing',
      message: 'PAKE pairing requires a password.',
      reason: 'invalid-input',
    });
  }
  if (!input.localPeerId || !input.remotePeerId || !input.protocol || !input.sessionId) {
    throw new LanPairingError({
      operation: 'startPakePairing',
      message: 'PAKE transcript is missing required peer, protocol, or session fields.',
      reason: 'invalid-input',
    });
  }
  if (input.localPeerId === input.remotePeerId) {
    throw new LanPairingError({
      operation: 'startPakePairing',
      message: 'PAKE pairing cannot pair a peer with itself.',
      reason: 'invalid-input',
    });
  }
};

export const startPakePairing = (input: PakeStartInput): PakeStartResult => {
  assertValidPakeStart(input);
  const now = input.now ?? new Date();
  const transcript: PakeTranscript = {
    localPeerId: input.localPeerId,
    remotePeerId: input.remotePeerId,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    sessionId: input.sessionId,
    role: input.role,
  };
  const sid = toBytes(input.sessionId);
  const ownAssociatedData = transcriptAssociatedData(transcript);
  const init = cpaceRistretto255.init({
    PRS: passwordRelatedString(input.password, transcript),
    sid,
    CI: transcriptChannelIdentifier(transcript),
  });
  const message: PakeHandshakeMessage = {
    peerId: input.localPeerId,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    sessionId: input.sessionId,
    role: input.role,
    share: toBase64Url(init.share),
    associatedData: toBase64Url(ownAssociatedData),
  };
  return {
    state: {
      transcript,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString(),
      ephemeralSecret: toBase64Url(init.ephemeralSecret),
      ownShare: message.share,
      ownAssociatedData: message.associatedData,
    },
    message,
  };
};

const expectedPeerRole = (role: PakePairingRole): PakePairingRole => (role === 'initiator' ? 'responder' : 'initiator');

const assertValidPeerMessage = (state: PakePrivateState, peerMessage: PakeHandshakeMessage, now: Date) => {
  if (now.getTime() > new Date(state.expiresAt).getTime()) {
    throw new LanPairingError({
      operation: 'completePakePairing',
      message: 'PAKE pairing session has expired.',
      reason: 'pake-failed',
    });
  }
  if (
    peerMessage.peerId !== state.transcript.remotePeerId ||
    peerMessage.sessionId !== state.transcript.sessionId ||
    peerMessage.protocol !== state.transcript.protocol ||
    peerMessage.protocolVersion !== state.transcript.protocolVersion ||
    peerMessage.role !== expectedPeerRole(state.transcript.role)
  ) {
    throw new LanPairingError({
      operation: 'completePakePairing',
      message: 'PAKE peer message does not match the expected transcript.',
      reason: 'pake-failed',
    });
  }
};

const confirmationForRole = (sessionKey: Uint8Array, role: PakePairingRole) =>
  createHmac('sha256', sessionKey).update(`ai-usage-lan-pairing:${role}`).digest();

export const completePakePairing = (input: PakeCompleteInput): PakeCompleteResult => {
  const now = input.now ?? new Date();
  assertValidPeerMessage(input.state, input.peerMessage, now);

  const isk = cpaceRistretto255.deriveIskInitiatorResponder({
    ephemeralSecret: fromBase64Url(input.state.ephemeralSecret),
    ownShare: fromBase64Url(input.state.ownShare),
    peerShare: fromBase64Url(input.peerMessage.share),
    ownAD: fromBase64Url(input.state.ownAssociatedData),
    peerAD: fromBase64Url(input.peerMessage.associatedData),
    sid: toBytes(input.state.transcript.sessionId),
    role: input.state.transcript.role,
  });
  return {
    sessionKey: toBase64Url(isk),
    confirmation: toBase64Url(confirmationForRole(isk, input.state.transcript.role)),
  };
};

export const verifyPakeConfirmation = (input: PakeVerifyInput) => {
  const sessionKey = fromBase64Url(input.sessionKey);
  const expected = confirmationForRole(sessionKey, input.peerRole);
  const actual = fromBase64Url(input.confirmation);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
};

const encryptionKey = (sessionKey: string) => createHash('sha256').update(fromBase64Url(sessionKey)).digest();

export const encryptPairingEnvelope = (sessionKey: string, envelope: PairingEnvelope): EncryptedPairingEnvelope => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(sessionKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64url'),
    ciphertext: Buffer.concat([ciphertext, tag]).toString('base64url'),
  };
};

export const decryptPairingEnvelope = (sessionKey: string, envelope: EncryptedPairingEnvelope): PairingEnvelope => {
  if (envelope.algorithm !== 'aes-256-gcm') throw new Error('Unsupported encrypted pairing envelope algorithm');
  const payload = Buffer.from(envelope.ciphertext, 'base64url');
  if (payload.length < 16) throw new Error('Encrypted pairing envelope is too short');
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(sessionKey), Buffer.from(envelope.nonce, 'base64url'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as unknown;
  if (!isPairingEnvelope(parsed)) {
    throw new Error('Encrypted pairing envelope payload is invalid');
  }
  return parsed;
};

const trustedPeerFromIdentity = (identity: LanPeerIdentity, pairedAt: string, metadata: Record<string, string>): TrustedLanPeer => ({
  identity,
  pairedAt,
  lastSeenAt: pairedAt,
  metadata,
});

export const pairCredentialEnvelopes = (input: PairCredentialEnvelopesInput): PairCredentialEnvelopesResult => {
  if (input.initiator.identity.id === input.responder.identity.id) {
    throw new LanPairingError({
      operation: 'pairCredentialEnvelopes',
      message: 'Cannot pair a peer with itself.',
      reason: 'invalid-input',
    });
  }

  const initiator = startPakePairing({
    localPeerId: input.initiator.identity.id,
    remotePeerId: input.responder.identity.id,
    password: input.initiator.password,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    sessionId: input.sessionId,
    role: 'initiator',
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const responder = startPakePairing({
    localPeerId: input.responder.identity.id,
    remotePeerId: input.initiator.identity.id,
    password: input.responder.password,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    sessionId: input.sessionId,
    role: 'responder',
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const initiatorComplete = completePakePairing({
    state: initiator.state,
    peerMessage: responder.message,
    ...(input.completedAt === undefined && input.now === undefined ? {} : { now: input.completedAt ?? input.now }),
  });
  const responderComplete = completePakePairing({
    state: responder.state,
    peerMessage: initiator.message,
    ...(input.completedAt === undefined && input.now === undefined ? {} : { now: input.completedAt ?? input.now }),
  });

  if (
    !verifyPakeConfirmation({
      sessionKey: initiatorComplete.sessionKey,
      peerRole: 'responder',
      confirmation: responderComplete.confirmation,
    }) ||
    !verifyPakeConfirmation({
      sessionKey: responderComplete.sessionKey,
      peerRole: 'initiator',
      confirmation: initiatorComplete.confirmation,
    })
  ) {
    throw new LanPairingError({
      operation: 'pairCredentialEnvelopes',
      message: 'PAKE confirmation failed.',
      reason: 'pairing-failed',
    });
  }

  const pairedAt = (input.now ?? new Date()).toISOString();
  return {
    sessionKey: initiatorComplete.sessionKey,
    initiator: {
      peer: trustedPeerFromIdentity(input.responder.identity, pairedAt, input.responder.envelope.metadata),
      receivedEnvelope: input.responder.envelope,
      sentEnvelope: input.initiator.envelope,
    },
    responder: {
      peer: trustedPeerFromIdentity(input.initiator.identity, pairedAt, input.initiator.envelope.metadata),
      receivedEnvelope: input.initiator.envelope,
      sentEnvelope: input.responder.envelope,
    },
  };
};

const pairingEndpoint = (peer: DiscoveredLanPeer, path: string) => `http://${peer.host}:${peer.port}${path}`;

const parseJsonResponse = async (response: Response, operation: string) => {
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as unknown;
      if (isRecord(body) && typeof body.error === 'string') detail = `: ${body.error}`;
    } catch {
      // Keep the transport error usable even when the peer returns non-JSON.
    }
    throw new LanPairingError({
      operation,
      message: `LAN pairing peer returned HTTP ${response.status}${detail}.`,
      reason: 'pairing-failed',
    });
  }
  return (await response.json()) as unknown;
};

const isPakeHandshakeMessage = (value: unknown): value is PakeHandshakeMessage =>
  isRecord(value) &&
  typeof value.peerId === 'string' &&
  typeof value.protocol === 'string' &&
  typeof value.protocolVersion === 'number' &&
  typeof value.sessionId === 'string' &&
  (value.role === 'initiator' || value.role === 'responder') &&
  typeof value.share === 'string' &&
  typeof value.associatedData === 'string';

const isLanPeerIdentity = (value: unknown): value is LanPeerIdentity =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  typeof value.label === 'string' &&
  typeof value.protocol === 'string' &&
  typeof value.version === 'number';

const isEncryptedPairingEnvelope = (value: unknown): value is EncryptedPairingEnvelope =>
  isRecord(value) &&
  value.algorithm === 'aes-256-gcm' &&
  typeof value.nonce === 'string' &&
  typeof value.ciphertext === 'string';

const parsePairingExchangeResponse = (value: unknown): PairingExchangeResponse => {
  if (
    !isRecord(value) ||
    !isLanPeerIdentity(value.identity) ||
    !isPakeHandshakeMessage(value.message) ||
    typeof value.confirmation !== 'string' ||
    !isEncryptedPairingEnvelope(value.encryptedEnvelope)
  ) {
    throw new Error('Invalid LAN pairing exchange response');
  }
  return {
    identity: value.identity,
    message: value.message,
    confirmation: value.confirmation,
    encryptedEnvelope: value.encryptedEnvelope,
  };
};

export const pairWithLanPeer = (input: PairWithLanPeerInput): Effect.Effect<PairingResult, LanPairingError> =>
  Effect.tryPromise({
    try: async () => {
      if (input.localIdentity.id === input.peer.identity.id) {
        throw new LanPairingError({
          operation: 'pairWithLanPeer',
          message: 'Cannot pair a peer with itself.',
          reason: 'invalid-input',
        });
      }

      const sessionId = input.sessionId ?? randomBytes(16).toString('base64url');
      const started = startPakePairing({
        localPeerId: input.localIdentity.id,
        remotePeerId: input.peer.identity.id,
        password: input.password,
        protocol: input.localIdentity.protocol,
        protocolVersion: input.localIdentity.version,
        sessionId,
        role: 'initiator',
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });

      const exchangeValue = await parseJsonResponse(
        await fetch(pairingEndpoint(input.peer, '/lan/pairing/exchange'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identity: input.localIdentity, message: started.message } satisfies PairingExchangeRequest),
        }),
        'pairWithLanPeer.exchange',
      );
      const exchange = parsePairingExchangeResponse(exchangeValue);
      if (exchange.identity.id !== input.peer.identity.id) {
        throw new LanPairingError({
          operation: 'pairWithLanPeer',
          message: 'LAN pairing exchange returned a different peer identity.',
          reason: 'protocol-mismatch',
        });
      }

      const completed = completePakePairing({ state: started.state, peerMessage: exchange.message });
      if (
        !verifyPakeConfirmation({
          sessionKey: completed.sessionKey,
          peerRole: 'responder',
          confirmation: exchange.confirmation,
        })
      ) {
        throw new LanPairingError({
          operation: 'pairWithLanPeer',
          message: 'LAN pairing confirmation failed.',
          reason: 'pake-failed',
        });
      }

      const receivedEnvelope = decryptPairingEnvelope(completed.sessionKey, exchange.encryptedEnvelope);
      await parseJsonResponse(
        await fetch(pairingEndpoint(input.peer, '/lan/pairing/finalize'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            identity: input.localIdentity,
            sessionId,
            confirmation: completed.confirmation,
            encryptedEnvelope: encryptPairingEnvelope(completed.sessionKey, input.envelope),
          } satisfies PairingFinalizeRequest),
        }),
        'pairWithLanPeer.finalize',
      );

      return {
        peer: trustedPeerFromIdentity(exchange.identity, (input.now ?? new Date()).toISOString(), receivedEnvelope.metadata),
        receivedEnvelope,
        sentEnvelope: input.envelope,
      };
    },
    catch: (cause) => {
      if (cause instanceof LanPairingError) return cause;
      return new LanPairingError({
        operation: 'pairWithLanPeer',
        message: cause instanceof Error ? cause.message : String(cause),
        reason: 'pairing-failed',
      });
    },
  });

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
  return {
    peerId: value.peerId,
    password: value.password,
    ...(isPairingEnvelope(value.envelope) ? { envelope: value.envelope } : {}),
  };
};

const publicPeerState = (state: LanPairingState, pairing: ActivePairingSession | undefined) => ({
  identity: state.localIdentity,
  online: state.status === 'running' || state.status === 'pairing',
  pairingAvailable: state.status === 'running' || state.status === 'pairing',
  pairing: pairing ? pairing.state : null,
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
      pairing: {
        state: pairing,
        password: input.password,
        ...(input.envelope === undefined ? {} : { envelope: input.envelope }),
        pending: {},
      },
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
    if (!current.pairing || current.pairing.state.peerId !== input.peerId) {
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
        credential: current.pairing.envelope?.credential ?? input.password,
        metadata: {},
      },
      sentEnvelope: current.pairing.envelope ?? {
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

const parsePairingExchangeRequest = async (request: Request): Promise<PairingExchangeRequest> => {
  const value = (await request.json()) as unknown;
  if (!isRecord(value) || !isLanPeerIdentity(value.identity) || !isPakeHandshakeMessage(value.message)) {
    throw new LanPairingError({
      operation: 'parsePairingExchangeRequest',
      message: 'Pairing exchange request is invalid.',
      reason: 'invalid-input',
    });
  }
  return { identity: value.identity, message: value.message };
};

const parsePairingFinalizeRequest = async (request: Request): Promise<PairingFinalizeRequest> => {
  const value = (await request.json()) as unknown;
  if (
    !isRecord(value) ||
    !isLanPeerIdentity(value.identity) ||
    typeof value.sessionId !== 'string' ||
    typeof value.confirmation !== 'string' ||
    !isEncryptedPairingEnvelope(value.encryptedEnvelope)
  ) {
    throw new LanPairingError({
      operation: 'parsePairingFinalizeRequest',
      message: 'Pairing finalize request is invalid.',
      reason: 'invalid-input',
    });
  }
  return {
    identity: value.identity,
    sessionId: value.sessionId,
    confirmation: value.confirmation,
    encryptedEnvelope: value.encryptedEnvelope,
  };
};

const exchangePairingInRef = (
  ref: Ref.Ref<RuntimeState>,
  input: PairingExchangeRequest,
): Effect.Effect<PairingExchangeResponse, LanPairingError> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(ref);
    if (!current.pairing || current.pairing.state.peerId !== input.identity.id || !current.pairing.envelope) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'exchangePairing',
          message: `No active pairing session for peer ${input.identity.id}.`,
          reason: 'pairing-failed',
        }),
      );
    }

    const started = startPakePairing({
      localPeerId: current.state.localIdentity.id,
      remotePeerId: input.identity.id,
      password: current.pairing.password,
      protocol: current.state.localIdentity.protocol,
      protocolVersion: current.state.localIdentity.version,
      sessionId: input.message.sessionId,
      role: 'responder',
    });
    const completed = completePakePairing({ state: started.state, peerMessage: input.message });
    const encryptedEnvelope = encryptPairingEnvelope(completed.sessionKey, current.pairing.envelope);

    yield* Ref.update(ref, (runtime) => {
      if (!runtime.pairing) return runtime;
      return {
        ...runtime,
        pairing: {
          ...runtime.pairing,
          pending: {
            ...runtime.pairing.pending,
            [input.message.sessionId]: {
              peerIdentity: input.identity,
              sessionId: input.message.sessionId,
              sessionKey: completed.sessionKey,
              confirmation: completed.confirmation,
            },
          },
        },
      };
    });

    return {
      identity: current.state.localIdentity,
      message: started.message,
      confirmation: completed.confirmation,
      encryptedEnvelope,
    };
  });

const finalizePairingInRef = (
  ref: Ref.Ref<RuntimeState>,
  input: PairingFinalizeRequest,
): Effect.Effect<PairingResult, LanPairingError> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(ref);
    const pending = current.pairing?.pending[input.sessionId];
    if (!current.pairing || !pending || pending.peerIdentity.id !== input.identity.id || !current.pairing.envelope) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'finalizePairing',
          message: `No pending pairing exchange for peer ${input.identity.id}.`,
          reason: 'pairing-failed',
        }),
      );
    }
    if (
      !verifyPakeConfirmation({
        sessionKey: pending.sessionKey,
        peerRole: 'initiator',
        confirmation: input.confirmation,
      })
    ) {
      return yield* Effect.fail(
        new LanPairingError({
          operation: 'finalizePairing',
          message: 'Pairing confirmation failed.',
          reason: 'pake-failed',
        }),
      );
    }

    const receivedEnvelope = decryptPairingEnvelope(pending.sessionKey, input.encryptedEnvelope);
    const now = new Date().toISOString();
    const result: PairingResult = {
      peer: trustedPeerFromIdentity(input.identity, now, receivedEnvelope.metadata),
      receivedEnvelope,
      sentEnvelope: current.pairing.envelope,
    };

    yield* Effect.tryPromise({
      try: async () => {
        await current.onPairingComplete?.(result);
      },
      catch: (cause) =>
        new LanPairingError({
          operation: 'finalizePairing',
          message: `Pairing completion callback failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          reason: 'pairing-failed',
        }),
    });

    yield* Ref.update(ref, (runtime) => {
      const nextPending = { ...(runtime.pairing?.pending ?? {}) };
      delete nextPending[input.sessionId];
      const { pairing: _pairing, ...withoutPairing } = runtime;
      return {
        ...withoutPairing,
        state: {
          ...runtime.state,
          status: 'running' as const,
          trustedPeers: [
            ...runtime.state.trustedPeers.filter((trusted) => trusted.identity.id !== result.peer.identity.id),
            result.peer,
          ],
        },
        ...(Object.keys(nextPending).length && runtime.pairing
          ? { pairing: { ...runtime.pairing, pending: nextPending } }
          : {}),
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

    if (request.method === 'POST' && url.pathname === '/lan/pairing/exchange') {
      try {
        return jsonResponse(await Effect.runPromise(exchangePairingInRef(ref, await parsePairingExchangeRequest(request))));
      } catch (cause) {
        return jsonResponse({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/lan/pairing/finalize') {
      try {
        const result = await Effect.runPromise(finalizePairingInRef(ref, await parsePairingFinalizeRequest(request)));
        return jsonResponse({
          peer: result.peer,
          receivedEnvelope: { ...result.receivedEnvelope, credential: '[redacted]' },
          sentEnvelope: { ...result.sentEnvelope, credential: '[redacted]' },
        });
      } catch (cause) {
        return jsonResponse({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
      }
    }

    const runtime = await Effect.runPromise(Ref.get(ref));
    const extraResponse = await runtime.extraHandler?.(request);
    if (extraResponse) return extraResponse;

    return new Response('not found', { status: 404 });
  };

const urlsFor = (host: string, port: number) => {
  const hosts = host === '0.0.0.0' ? lanInterfaceAddresses() : [host];
  const reachableHosts = hosts.length > 0 ? hosts : ['127.0.0.1'];
  return reachableHosts.map((item) => `http://${item}:${port}/lan/peer`);
};

const requestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

const requestHeaders = (request: IncomingMessage) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
};

const requestUrl = (request: IncomingMessage, host: string, port: number) => {
  const hostHeader = request.headers.host ?? `${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return `http://${hostHeader}${request.url ?? '/'}`;
};

const nodeRequestToFetchRequest = async (request: IncomingMessage, host: string, port: number) => {
  const method = request.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(requestUrl(request, host, port), {
      method,
      headers: requestHeaders(request),
    });
  }

  const body = await requestBody(request);
  return new Request(requestUrl(request, host, port), {
    method,
    headers: requestHeaders(request),
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
};

const writeFetchResponse = async (response: Response, output: ServerResponse) => {
  output.statusCode = response.status;
  output.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    output.setHeader(key, value);
  });
  if (!response.body) {
    output.end();
    return;
  }
  output.end(Buffer.from(await response.arrayBuffer()));
};

const startNodeServerOnPort = (
  ref: Ref.Ref<RuntimeState>,
  host: string,
  port: number,
): Promise<LanPairingServerHandle> =>
  new Promise((resolve, reject) => {
    const handler = createLanPairingHttpHandler(ref);
    const server = createServer((request, response) => {
      void (async () => {
        try {
          await writeFetchResponse(await handler(await nodeRequestToFetchRequest(request, host, port)), response);
        } catch (cause) {
          response.statusCode = 500;
          response.end(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    });

    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const onListening = () => {
      cleanup();
      const address = server.address() as AddressInfo | null;
      const boundPort = address?.port ?? port;
      resolve({
        port: boundPort,
        urls: urlsFor(host, boundPort),
        stop: () =>
          new Promise<void>((resolveStop, rejectStop) => {
            server.close((error) => {
              if (error) rejectStop(error);
              else resolveStop();
            });
          }),
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

const startBunServerOnPort = (ref: Ref.Ref<RuntimeState>, host: string, port: number, bunRuntime: BunServeRuntime) => {
  const server = bunRuntime.serve({
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
};

const startServerOnPort = (
  ref: Ref.Ref<RuntimeState>,
  host: string,
  port: number,
  runtime: NonNullable<LanPairingRuntimeOptions['serverRuntime']>,
): Effect.Effect<LanPairingServerHandle, LanPairingError> =>
  Effect.tryPromise({
    try: async () => {
      const bunRuntime = (globalThis as { Bun?: BunServeRuntime }).Bun;
      if (runtime !== 'node' && bunRuntime?.serve) return startBunServerOnPort(ref, host, port, bunRuntime);
      if (runtime === 'bun') throw new Error('Bun.serve is not available in this runtime');
      return await startNodeServerOnPort(ref, host, port);
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
  runtime: NonNullable<LanPairingRuntimeOptions['serverRuntime']>,
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
      const result = yield* Effect.either(startServerOnPort(ref, host, port, runtime));
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
          const serverRuntime = options.serverRuntime ?? 'auto';
          yield* Ref.update(ref, (runtime) => {
          const { lastError: _lastError, ...stateWithoutLastError } = runtime.state;
          return {
            ...runtime,
            ...(input.extraHandler === undefined ? {} : { extraHandler: input.extraHandler }),
            ...(input.onPairingComplete === undefined ? {} : { onPairingComplete: input.onPairingComplete }),
            state: {
              ...stateWithoutLastError,
              localIdentity: input.identity,
              status: 'starting' as const,
            },
          };
        });

          const server = yield* startServerInRange(ref, host, portRange, serverRuntime).pipe(
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
