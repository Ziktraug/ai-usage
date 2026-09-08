import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_SERVICE_PROTOCOL_VERSION, memoryServiceBounds } from './contracts';

declare const memoryServiceTokenBrand: unique symbol;

export type MemoryServiceToken = string & { readonly [memoryServiceTokenBrand]: true };

export interface MemoryServiceRendezvous {
  readonly port: number;
  readonly protocolVersion: typeof MEMORY_SERVICE_PROTOCOL_VERSION;
  readonly token: MemoryServiceToken;
}

export interface PublishedMemoryServiceRendezvous extends MemoryServiceRendezvous {
  readonly path: string;
  readonly remove: () => Promise<void>;
}

const fileName = 'memory-service.json';
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/u;

const hasCurrentOwner = (uid: number | bigint): boolean => {
  const current = process.getuid?.();
  return current === undefined || uid === current || uid === BigInt(current);
};
const isOwnerOnly = (mode: number | bigint): boolean =>
  typeof mode === 'bigint' ? mode % 0o100n === 0n : mode % 0o100 === 0;
const sameFile = (
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createMemoryServiceToken = (value: unknown): MemoryServiceToken => {
  if (typeof value !== 'string' || !tokenPattern.test(value)) {
    throw new Error('Memory service token is invalid.');
  }
  return value as MemoryServiceToken;
};

export const revealMemoryServiceToken = (token: MemoryServiceToken): string => token;

export const memoryServiceRendezvousPath = (stateDirectory: string): string =>
  path.join(path.resolve(stateDirectory), fileName);

export const parseMemoryServiceRendezvous = (value: unknown): MemoryServiceRendezvous => {
  if (!(isRecord(value) && Object.keys(value).length === 3)) {
    throw new Error('Memory service rendezvous is invalid.');
  }
  if (
    !(
      Object.hasOwn(value, 'port') &&
      Object.hasOwn(value, 'protocolVersion') &&
      Object.hasOwn(value, 'token') &&
      Number.isSafeInteger(value.port) &&
      Number(value.port) >= 1 &&
      Number(value.port) <= 65_535 &&
      value.protocolVersion === MEMORY_SERVICE_PROTOCOL_VERSION
    )
  ) {
    throw new Error('Memory service rendezvous is invalid.');
  }
  return Object.freeze({
    port: Number(value.port),
    protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
    token: createMemoryServiceToken(value.token),
  });
};

const ensurePrivateDirectory = async (directoryValue: string, create = false): Promise<string> => {
  const directory = path.resolve(directoryValue);
  if (create) {
    await mkdir(directory, { mode: privateDirectoryMode, recursive: true });
  }
  const [before, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  if (!before.isDirectory() || before.isSymbolicLink() || !hasCurrentOwner(before.uid) || canonical !== directory) {
    throw new Error('Memory service rendezvous directory is unsafe.');
  }
  if (create && process.platform !== 'win32') {
    await chmod(directory, privateDirectoryMode);
  }
  const after = await lstat(directory);
  if (!(sameFile(before, after) && isOwnerOnly(after.mode))) {
    throw new Error('Memory service rendezvous directory is unsafe.');
  }
  return directory;
};

const validatePrivateFile = (stats: Awaited<ReturnType<typeof lstat>>): void => {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    !hasCurrentOwner(stats.uid) ||
    !isOwnerOnly(stats.mode)
  ) {
    throw new Error('Memory service rendezvous file is unsafe.');
  }
};

export const loadMemoryServiceRendezvous = async (filePathValue: string): Promise<MemoryServiceRendezvous> => {
  const filePath = path.resolve(filePathValue);
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await open(filePath, fs.constants.O_RDONLY + fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    validatePrivateFile(before);
    if (before.size <= 0 || before.size > memoryServiceBounds.maxRendezvousBytes) {
      throw new Error('Memory service rendezvous exceeds its byte limit.');
    }
    const bytes = new Uint8Array(before.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    const [after, current] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (
      read.bytesRead !== bytes.byteLength ||
      !sameFile(before, after) ||
      !sameFile(before, current) ||
      after.size !== before.size
    ) {
      throw new Error('Memory service rendezvous changed while it was read.');
    }
    validatePrivateFile(current);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseMemoryServiceRendezvous(JSON.parse(text) as unknown);
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export interface PublishMemoryServiceRendezvousOptions extends MemoryServiceRendezvous {
  readonly replaceStale?: boolean;
  readonly stateDirectory: string;
}

export const publishMemoryServiceRendezvous = async ({
  port,
  protocolVersion,
  replaceStale = false,
  stateDirectory,
  token,
}: PublishMemoryServiceRendezvousOptions): Promise<PublishedMemoryServiceRendezvous> => {
  const directory = await ensurePrivateDirectory(stateDirectory, true);
  const targetPath = path.join(directory, fileName);
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  });
  if (existing) {
    validatePrivateFile(existing);
    if (!replaceStale) {
      throw new Error('Memory service rendezvous already exists.');
    }
    await unlink(targetPath);
  }
  const rendezvous = parseMemoryServiceRendezvous({ port, protocolVersion, token });
  const temporaryPath = path.join(directory, `.memory-service-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let publishedIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', privateFileMode);
    await handle.writeFile(`${JSON.stringify(rendezvous)}\n`, { encoding: 'utf8' });
    await handle.sync();
    const temporaryIdentity = await handle.stat();
    validatePrivateFile(temporaryIdentity);
    await handle.close();
    handle = undefined;
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    if (process.platform !== 'win32') {
      await chmod(targetPath, privateFileMode);
    }
    publishedIdentity = await lstat(targetPath);
    validatePrivateFile(publishedIdentity);
    let removed = false;
    return {
      ...rendezvous,
      path: targetPath,
      remove: async () => {
        if (removed) {
          return;
        }
        const current = await lstat(targetPath).catch(() => undefined);
        if (!(current && publishedIdentity && sameFile(current, publishedIdentity))) {
          throw new Error('Memory service rendezvous changed before removal.');
        }
        validatePrivateFile(current);
        await unlink(targetPath);
        removed = true;
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (publishedIdentity) {
      const current = await lstat(targetPath).catch(() => undefined);
      if (current && sameFile(current, publishedIdentity)) {
        await unlink(targetPath).catch(() => undefined);
      }
    }
    throw error;
  }
};
