import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  parseUsageEngineInstanceId,
  parseUsageEngineProtocolVersion,
  type UsageEngineInstanceId,
  type UsageEngineProtocolVersion,
  usageEngineControlBounds,
} from './contracts';
import { sameFileIdentity } from './private-file-identity';
import { readOpenedFileBounded } from './read-opened-file';
import { createUsageEngineBearerToken, type UsageEngineBearerToken } from './secret';

export {
  createUsageEngineBearerToken,
  revealUsageEngineBearerToken,
  type UsageEngineBearerToken,
} from './secret';

declare const loopbackOriginBrand: unique symbol;
declare const targetIdBrand: unique symbol;

export type UsageEngineLoopbackOrigin = string & {
  readonly [loopbackOriginBrand]: 'UsageEngineLoopbackOrigin';
};

export type UsageEngineTargetId = string & {
  readonly [targetIdBrand]: 'UsageEngineTargetId';
};

export interface UsageEngineTarget {
  readonly configCwd: string;
  readonly databasePath: string;
}

export interface UsageEngineRendezvous {
  readonly instanceId: UsageEngineInstanceId;
  readonly port: number;
  readonly protocolVersion: UsageEngineProtocolVersion;
  readonly targetId: UsageEngineTargetId;
  readonly token: UsageEngineBearerToken;
}

const loopbackOriginPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
const targetIdPattern = /^[a-f0-9]{64}$/;
const RENDEZVOUS_PUBLICATION_DEADLINE_MS = 250;
const RENDEZVOUS_PUBLICATION_POLL_MS = 10;

export type UsageEngineRendezvousErrorReason = 'invalid-rendezvous' | 'protocol-mismatch' | 'target-mismatch';

export class UsageEngineRendezvousError extends Error {
  override readonly name = 'UsageEngineRendezvousError';
  readonly reason: UsageEngineRendezvousErrorReason;

  constructor(reason: UsageEngineRendezvousErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
};

export const parseUsageEngineTargetId = (value: unknown): UsageEngineTargetId => {
  if (!(typeof value === 'string' && targetIdPattern.test(value))) {
    throw new Error('Usage engine rendezvous target identity is invalid.');
  }
  return value as UsageEngineTargetId;
};

export const usageEngineTargetIdFor = ({ configCwd, databasePath }: UsageEngineTarget): UsageEngineTargetId => {
  if (!(path.isAbsolute(configCwd) && path.isAbsolute(databasePath))) {
    throw new Error('Usage engine target paths must be absolute.');
  }
  return createHash('sha256')
    .update(JSON.stringify([path.resolve(databasePath), path.resolve(configCwd)]))
    .digest('hex') as UsageEngineTargetId;
};

export const assertUsageEngineRendezvousTarget = (
  rendezvous: UsageEngineRendezvous,
  expectedTargetIdValue: string,
): void => {
  const expectedTargetId = parseUsageEngineTargetId(expectedTargetIdValue);
  if (rendezvous.targetId !== expectedTargetId) {
    throw new UsageEngineRendezvousError('target-mismatch', 'Usage engine rendezvous target mismatch.');
  }
};

export const parseUsageEngineRendezvous = (value: unknown): UsageEngineRendezvous => {
  if (!(isRecord(value) && hasExactKeys(value, ['instanceId', 'port', 'protocolVersion', 'targetId', 'token']))) {
    throw new Error('Usage engine rendezvous contains unknown or missing fields.');
  }
  if (
    !(typeof value.port === 'number' && Number.isSafeInteger(value.port) && value.port >= 1 && value.port <= 65_535)
  ) {
    throw new Error('Usage engine rendezvous port is invalid.');
  }
  let protocolVersion: UsageEngineProtocolVersion;
  try {
    protocolVersion = parseUsageEngineProtocolVersion(value.protocolVersion);
  } catch {
    throw new UsageEngineRendezvousError('protocol-mismatch', 'Usage engine protocol version mismatch.');
  }
  return Object.freeze({
    instanceId: parseUsageEngineInstanceId(value.instanceId),
    port: value.port,
    protocolVersion,
    targetId: parseUsageEngineTargetId(value.targetId),
    token: createUsageEngineBearerToken(value.token),
  });
};

export const parseUsageEngineLoopbackOrigin = (value: unknown): UsageEngineLoopbackOrigin => {
  if (typeof value !== 'string') {
    throw new Error('Usage engine origin must be canonical numeric loopback HTTP.');
  }
  const match = loopbackOriginPattern.exec(value);
  const portText = match?.[1];
  const port = portText === undefined ? Number.NaN : Number(portText);
  if (!(Number.isSafeInteger(port) && port >= 1 && port <= 65_535 && String(port) === portText)) {
    throw new Error('Usage engine origin must be canonical numeric loopback HTTP.');
  }
  return value as UsageEngineLoopbackOrigin;
};

export const usageEngineLoopbackOrigin = (rendezvous: UsageEngineRendezvous): UsageEngineLoopbackOrigin =>
  parseUsageEngineLoopbackOrigin(`http://127.0.0.1:${rendezvous.port}`);

export const loadUsageEngineRendezvous = async (filePath: string): Promise<UsageEngineRendezvous> => {
  const absolutePath = path.resolve(filePath);
  const parentPath = path.dirname(absolutePath);
  const [parent, canonicalParent] = await Promise.all([
    lstat(parentPath).catch(() => undefined),
    realpath(parentPath).catch(() => undefined),
  ]);
  const currentUid = process.getuid?.();
  if (
    !parent?.isDirectory() ||
    parent.isSymbolicLink() ||
    canonicalParent !== parentPath ||
    (currentUid !== undefined && parent.uid !== currentUid) ||
    parent.mode % 0o100 !== 0
  ) {
    throw new Error('Usage engine rendezvous directory must be owner-only.');
  }
  const publicationDeadline = Date.now() + RENDEZVOUS_PUBLICATION_DEADLINE_MS;
  let file: Awaited<ReturnType<typeof open>>;
  let opened: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>;
  while (true) {
    try {
      file = await open(absolutePath, fs.constants.O_RDONLY + fs.constants.O_NOFOLLOW + fs.constants.O_NONBLOCK);
    } catch {
      throw new Error('Usage engine rendezvous must be an owner-only regular file.');
    }
    opened = await file.stat();
    const transientPublicationLink =
      opened.isFile() &&
      opened.nlink === 2 &&
      (currentUid === undefined || opened.uid === currentUid) &&
      opened.mode % 0o100 === 0;
    if (!(transientPublicationLink && Date.now() < publicationDeadline)) {
      break;
    }
    await file.close().catch(() => undefined);
    await Bun.sleep(RENDEZVOUS_PUBLICATION_POLL_MS);
  }

  try {
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (currentUid !== undefined && opened.uid !== currentUid) ||
      opened.mode % 0o100 !== 0
    ) {
      throw new Error('Usage engine rendezvous must be an owner-only regular file.');
    }
    if (opened.size <= 0 || opened.size > usageEngineControlBounds.maxRendezvousBytes) {
      throw new Error('Usage engine rendezvous exceeds its byte limit.');
    }

    const bytes = await readOpenedFileBounded(file, opened.size);
    const afterOpen = await file.stat();
    if (
      bytes.byteLength !== opened.size ||
      !sameFileIdentity(opened, afterOpen) ||
      afterOpen.size !== opened.size ||
      afterOpen.nlink !== 1 ||
      (currentUid !== undefined && afterOpen.uid !== currentUid) ||
      afterOpen.mode % 0o100 !== 0
    ) {
      throw new Error('Usage engine rendezvous changed while it was read.');
    }
    const current = await lstat(absolutePath).catch(() => undefined);
    if (
      !(
        current?.isFile() &&
        !current.isSymbolicLink() &&
        sameFileIdentity(opened, current) &&
        current.size === opened.size &&
        current.nlink === 1 &&
        (currentUid === undefined || current.uid === currentUid) &&
        current.mode % 0o100 === 0
      )
    ) {
      throw new Error('Usage engine rendezvous changed while it was read.');
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Usage engine rendezvous must contain valid UTF-8 JSON.');
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error('Usage engine rendezvous must contain valid JSON.');
    }
    return parseUsageEngineRendezvous(value);
  } finally {
    await file.close().catch(() => undefined);
  }
};

export {
  errorHasCode,
  type FileIdentity,
  hasCurrentOwner,
  isOwnerOnly,
  isProcessStartTimeTicks,
  processIsAlive,
  readProcessStartTimeTicks,
  sameFileIdentity,
} from './private-file-identity';
export { readOpenedFileBounded } from './read-opened-file';
export { resolveUsageRuntimePaths, type UsageRuntimePaths } from './runtime-paths';
