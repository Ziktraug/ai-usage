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
import { createUsageEngineBearerToken, type UsageEngineBearerToken } from './secret';

export type { UsageEngineBearerToken } from './secret';

declare const loopbackOriginBrand: unique symbol;

export type UsageEngineLoopbackOrigin = string & {
  readonly [loopbackOriginBrand]: 'UsageEngineLoopbackOrigin';
};

export interface UsageEngineRendezvous {
  readonly instanceId: UsageEngineInstanceId;
  readonly port: number;
  readonly protocolVersion: UsageEngineProtocolVersion;
  readonly token: UsageEngineBearerToken;
}

const loopbackOriginPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export type UsageEngineRendezvousErrorReason = 'invalid-rendezvous' | 'protocol-mismatch';

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

const sameFileIdentity = (
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

export const parseUsageEngineRendezvous = (value: unknown): UsageEngineRendezvous => {
  if (!(isRecord(value) && hasExactKeys(value, ['instanceId', 'port', 'protocolVersion', 'token']))) {
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
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(absolutePath, fs.constants.O_RDONLY + fs.constants.O_NOFOLLOW + fs.constants.O_NONBLOCK);
  } catch {
    throw new Error('Usage engine rendezvous must be an owner-only regular file.');
  }

  try {
    const opened = await file.stat();
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

    const bytes = await file.readFile();
    if (bytes.byteLength !== opened.size) {
      throw new Error('Usage engine rendezvous changed while it was read.');
    }
    const current = await lstat(absolutePath).catch(() => undefined);
    if (!(current?.isFile() && !current.isSymbolicLink() && sameFileIdentity(opened, current))) {
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
