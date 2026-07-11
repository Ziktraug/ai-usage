import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const mutationLocks = new Map<string, Promise<void>>();
const fileLockAcquireTimeoutMs = 10_000;
const fileLockHardExpirationMs = 30_000;
const fileLockHeartbeatMs = 250;
const fileLockLeaseMs = 2000;
const fileLockRetryMs = 10;
const maxFileLockMetadataBytes = 1024;
const localHostname = hostname();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMissingPathError = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT';

export type BoundedRegularFileRead =
  | { buffer: Buffer; identity: { dev: number | bigint; ino: number | bigint }; kind: 'ok' }
  | { kind: 'missing' | 'too-large' | 'unsupported' | 'unreadable' };

export const readBoundedRegularFile = async (filePath: string, maxBytes: number): Promise<BoundedRegularFileRead> => {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, noFollowReadFlags);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: 'missing' };
    }
    if (isRecord(error) && (error.code === 'ELOOP' || error.code === 'ENXIO')) {
      return { kind: 'unsupported' };
    }
    return { kind: 'unreadable' };
  }

  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      return { kind: 'unsupported' };
    }
    if (fileStat.size > maxBytes) {
      return { kind: 'too-large' };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) {
      return { kind: 'too-large' };
    }
    return {
      buffer: buffer.subarray(0, bytesRead),
      identity: { dev: fileStat.dev, ino: fileStat.ino },
      kind: 'ok',
    };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    await file.close().catch(() => undefined);
  }
};

// biome-ignore lint/suspicious/noBitwiseOperators: Node filesystem flags are bitmasks.
export const noFollowReadFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const exclusiveLockFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node filesystem flags are bitmasks.
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

const withSerializedPathMutation = async <Result>(
  filePath: string,
  mutation: () => Promise<Result>,
): Promise<Result> => {
  const lockKey = path.resolve(filePath);
  const previous = mutationLocks.get(lockKey) ?? Promise.resolve();
  let release = (): void => undefined;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => active,
    () => active,
  );
  mutationLocks.set(lockKey, queued);
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
    if (mutationLocks.get(lockKey) === queued) {
      mutationLocks.delete(lockKey);
    }
  }
};

export const sameFileIdentity = (
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

const removeLockIfUnchanged = async (
  lockPath: string,
  expectedStat: { dev: number | bigint; ino: number | bigint },
): Promise<void> => {
  try {
    const currentStat = await lstat(lockPath);
    if (sameFileIdentity(currentStat, expectedStat)) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
};

interface FileLockMetadata {
  createdAt: string;
  heartbeatAt: string;
  hostname: string;
  ownerId: string;
  pid: number;
  version: 1;
}

const parseFileLockMetadata = (metadataText: string): FileLockMetadata | undefined => {
  try {
    const metadata = JSON.parse(metadataText) as unknown;
    if (
      isRecord(metadata) &&
      metadata.version === 1 &&
      typeof metadata.createdAt === 'string' &&
      typeof metadata.heartbeatAt === 'string' &&
      typeof metadata.hostname === 'string' &&
      typeof metadata.ownerId === 'string' &&
      typeof metadata.pid === 'number' &&
      Number.isSafeInteger(metadata.pid)
    ) {
      return metadata as unknown as FileLockMetadata;
    }
  } catch {
    return;
  }
  return;
};

const writeFileLockMetadata = async (
  lockFile: Awaited<ReturnType<typeof open>>,
  metadata: FileLockMetadata,
): Promise<void> => {
  const serializedMetadata = `${JSON.stringify(metadata)}\n`;
  await lockFile.truncate(0);
  await lockFile.write(serializedMetadata, 0, 'utf8');
  await lockFile.sync();
};

const isLocalProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isRecord(error) && error.code === 'ESRCH');
  }
};

const tryRemoveStaleLock = async (lockPath: string): Promise<boolean> => {
  let lockFile: Awaited<ReturnType<typeof open>>;
  try {
    lockFile = await open(lockPath, noFollowReadFlags);
  } catch {
    return false;
  }
  try {
    const lockStat = await lockFile.stat();
    if (!lockStat.isFile()) {
      return false;
    }
    let metadata: FileLockMetadata | undefined;
    if (lockStat.size <= maxFileLockMetadataBytes) {
      const metadataText = await lockFile.readFile('utf8');
      metadata = parseFileLockMetadata(metadataText);
    }
    const now = Date.now();
    const heartbeatTimestamp = metadata === undefined ? lockStat.mtimeMs : Date.parse(metadata.heartbeatAt);
    const createdTimestamp = metadata === undefined ? lockStat.birthtimeMs : Date.parse(metadata.createdAt);
    const heartbeatAge = now - (Number.isFinite(heartbeatTimestamp) ? heartbeatTimestamp : lockStat.mtimeMs);
    const hardAge = now - (Number.isFinite(createdTimestamp) ? createdTimestamp : lockStat.birthtimeMs);
    if (metadata?.hostname === localHostname && metadata.pid > 0 && !isLocalProcessAlive(metadata.pid)) {
      await removeLockIfUnchanged(lockPath, lockStat);
      return true;
    }
    if (heartbeatAge < fileLockLeaseMs) {
      return false;
    }
    if (hardAge < fileLockHardExpirationMs) {
      return false;
    }
    if (metadata !== undefined || now - lockStat.mtimeMs >= fileLockHardExpirationMs) {
      await removeLockIfUnchanged(lockPath, lockStat);
      return true;
    }
    return false;
  } finally {
    await lockFile.close().catch(() => undefined);
  }
};

const runFileLockHeartbeat = async (
  lockFile: Awaited<ReturnType<typeof open>>,
  metadata: FileLockMetadata,
  signal: AbortSignal,
): Promise<void> => {
  while (!signal.aborted) {
    try {
      await delay(fileLockHeartbeatMs, undefined, { ref: false, signal });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      throw error;
    }
    await writeFileLockMetadata(lockFile, { ...metadata, heartbeatAt: new Date().toISOString() });
  }
};

const withFileSystemLock = async <Result>(filePath: string, mutation: () => Promise<Result>): Promise<Result> => {
  const lockPath = `${filePath}.ai-usage.lock`;
  const deadline = Date.now() + fileLockAcquireTimeoutMs;
  const createdAt = new Date().toISOString();
  const lockMetadata: FileLockMetadata = {
    createdAt,
    heartbeatAt: createdAt,
    hostname: localHostname,
    ownerId: randomUUID(),
    pid: process.pid,
    version: 1,
  };
  let lockFile: Awaited<ReturnType<typeof open>> | undefined;
  while (lockFile === undefined) {
    let candidateLockFile: Awaited<ReturnType<typeof open>>;
    try {
      candidateLockFile = await open(lockPath, exclusiveLockFlags, 0o600);
    } catch (error) {
      if (!(isRecord(error) && error.code === 'EEXIST')) {
        throw error;
      }
      const lockStat = await lstat(lockPath).catch(() => undefined);
      if (lockStat?.isSymbolicLink()) {
        throw new Error(`filesystem mutation lock must not be a symlink: ${lockPath}`);
      }
      if (await tryRemoveStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for filesystem mutation lock: ${filePath}`);
      }
      await delay(fileLockRetryMs);
      continue;
    }
    try {
      await writeFileLockMetadata(candidateLockFile, lockMetadata);
      lockFile = candidateLockFile;
    } catch (error) {
      const candidateStat = await candidateLockFile.stat().catch(() => undefined);
      await candidateLockFile.close().catch(() => undefined);
      if (candidateStat !== undefined) {
        await removeLockIfUnchanged(lockPath, candidateStat).catch(() => undefined);
      }
      throw error;
    }
  }

  const lockStat = await lockFile.stat();
  const heartbeatAbortController = new AbortController();
  let heartbeatError: unknown;
  const heartbeat = runFileLockHeartbeat(lockFile, lockMetadata, heartbeatAbortController.signal).catch((error) => {
    heartbeatError = error;
  });
  try {
    const result = await mutation();
    if (heartbeatError !== undefined) {
      throw heartbeatError;
    }
    return result;
  } finally {
    heartbeatAbortController.abort();
    await heartbeat;
    await lockFile.close().catch(() => undefined);
    await removeLockIfUnchanged(lockPath, lockStat).catch(() => undefined);
  }
};

export const withSerializedFileMutation = async <Result>(
  canonicalFilePath: string,
  mutation: () => Promise<Result>,
): Promise<Result> =>
  withSerializedPathMutation(canonicalFilePath, () => withFileSystemLock(canonicalFilePath, mutation));

export const existingRegularFileMode = async (filePath: string, defaultMode: number): Promise<number> => {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, noFollowReadFlags);
  } catch (error) {
    if (isMissingPathError(error)) {
      return defaultMode;
    }
    throw error;
  }
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      throw new Error(`atomic write destination must be a regular file: ${filePath}`);
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bitmasks.
    return fileStat.mode & 0o777;
  } finally {
    await file.close();
  }
};

export const writeExclusiveFile = async (filePath: string, content: string | Buffer, mode: number): Promise<void> => {
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    temporaryFile = await open(filePath, 'wx', mode);
    created = true;
    await temporaryFile.chmod(mode);
    await temporaryFile.writeFile(content);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    if (created) {
      await unlink(filePath).catch(() => undefined);
    }
    throw error;
  }
};

export const writeTemporarySibling = async (
  filePath: string,
  content: string | Buffer,
  mode: number,
): Promise<string> => {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeExclusiveFile(temporaryPath, content, mode);
  return temporaryPath;
};

export const atomicWriteFile = async (
  filePath: string,
  content: string | Buffer,
  defaultMode = 0o600,
): Promise<void> => {
  const mode = await existingRegularFileMode(filePath, defaultMode);
  const temporaryPath = await writeTemporarySibling(filePath, content, mode);
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};
