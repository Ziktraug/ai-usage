import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  parseUsageEngineInstanceId,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineInstanceId,
} from '@ai-usage/usage-engine-control';
import {
  parseUsageEngineTargetId,
  revealUsageEngineBearerToken,
  type UsageEngineBearerToken,
  type UsageEngineTargetId,
} from '@ai-usage/usage-engine-control/node';
import {
  errorHasCode,
  type FileIdentity,
  hasCurrentOwner,
  isOwnerOnly,
  sameFileIdentity as sameIdentity,
} from './private-file-identity';

const RENDEZVOUS_FILE_NAME = 'rendezvous.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RENDEZVOUS_TEMPORARY_GRACE_MS = 1000;
const MAX_STATE_DIRECTORY_ENTRIES = 4096;
const RENDEZVOUS_TEMPORARY_FILE_PATTERN =
  /^\.rendezvous-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export interface PublishUsageEngineRendezvousOptions {
  readonly instanceId: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly targetId: UsageEngineTargetId;
  readonly token: UsageEngineBearerToken;
}

export interface PublishedUsageEngineRendezvous {
  readonly instanceId: UsageEngineInstanceId;
  readonly path: string;
  readonly port: number;
  readonly remove: () => Promise<void>;
  readonly targetId: UsageEngineTargetId;
  readonly token: UsageEngineBearerToken;
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, 'ESRCH');
  }
};

const ensurePrivateStateDirectory = async (stateDirectoryValue: string): Promise<string> => {
  const stateDirectory = path.resolve(stateDirectoryValue);
  await mkdir(stateDirectory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const before = await lstat(stateDirectory);
  if (before.isSymbolicLink() || !before.isDirectory() || !hasCurrentOwner(before.uid)) {
    throw new Error(`Usage engine rendezvous directory must be owned by the current user: ${stateDirectory}`);
  }
  if (process.platform !== 'win32') {
    await chmod(stateDirectory, PRIVATE_DIRECTORY_MODE);
  }
  const after = await lstat(stateDirectory);
  if (
    !(isOwnerOnly(after.mode) && sameIdentity(before, after)) ||
    (await realpath(stateDirectory)) !== stateDirectory
  ) {
    throw new Error(`Usage engine rendezvous directory changed during validation: ${stateDirectory}`);
  }
  return stateDirectory;
};

const assertRendezvousAbsent = async (filePath: string): Promise<void> => {
  const stats = await lstat(filePath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!stats) {
    return;
  }
  throw new Error(`Usage engine rendezvous already exists and was preserved: ${filePath}`);
};

const removeIfUnchanged = async (filePath: string, identity: FileIdentity): Promise<boolean> => {
  const current = await lstat(filePath).catch(() => undefined);
  if (!(current?.isFile() && !current.isSymbolicLink() && sameIdentity(current, identity))) {
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
};

const scavengeAbandonedRendezvousTemporaryFiles = async (stateDirectory: string): Promise<void> => {
  let entryCount = 0;
  const entries = await opendir(stateDirectory);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new Error(`Usage engine rendezvous temporary scan was bounded and preserved: ${stateDirectory}`);
    }
    const match = RENDEZVOUS_TEMPORARY_FILE_PATTERN.exec(entry.name);
    const pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid)) {
      continue;
    }
    const candidatePath = path.join(stateDirectory, entry.name);
    const stats = await lstat(candidatePath).catch(() => undefined);
    if (stats?.isFile() && !stats.isSymbolicLink() && stats.nlink === 2) {
      continue;
    }
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode)
    ) {
      throw new Error(`Usage engine rendezvous temporary file was suspicious and preserved: ${candidatePath}`);
    }
    if (Date.now() - stats.mtimeMs < RENDEZVOUS_TEMPORARY_GRACE_MS || processIsAlive(pid)) {
      continue;
    }
    await removeIfUnchanged(candidatePath, stats);
  }
};

export const usageEngineRendezvousPath = (stateDirectory: string): string =>
  path.join(stateDirectory, RENDEZVOUS_FILE_NAME);

export const publishUsageEngineRendezvous = async ({
  instanceId: instanceIdValue,
  port,
  stateDirectory: stateDirectoryValue,
  targetId: targetIdValue,
  token,
}: PublishUsageEngineRendezvousOptions): Promise<PublishedUsageEngineRendezvous> => {
  const instanceId = parseUsageEngineInstanceId(instanceIdValue);
  const targetId = parseUsageEngineTargetId(targetIdValue);
  if (!(Number.isSafeInteger(port) && port >= 1 && port <= 65_535)) {
    throw new Error('Usage engine rendezvous port is invalid.');
  }
  const stateDirectory = await ensurePrivateStateDirectory(stateDirectoryValue);
  const filePath = usageEngineRendezvousPath(stateDirectory);
  await assertRendezvousAbsent(filePath);
  await scavengeAbandonedRendezvousTemporaryFiles(stateDirectory);
  const temporaryPath = path.join(stateDirectory, `.rendezvous-${process.pid}-${randomUUID()}.tmp`);
  const rawToken = revealUsageEngineBearerToken(token);
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  let publishedIdentity: FileIdentity | undefined;
  let removed = false;
  try {
    temporaryFile = await open(temporaryPath, 'wx+', PRIVATE_FILE_MODE);
    await temporaryFile.writeFile(
      `${JSON.stringify({ instanceId, port, protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION, targetId, token: rawToken })}\n`,
      'utf8',
    );
    await temporaryFile.sync();
    const temporaryIdentity = await temporaryFile.stat();
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.nlink !== 1 ||
      !hasCurrentOwner(temporaryIdentity.uid) ||
      !isOwnerOnly(temporaryIdentity.mode)
    ) {
      throw new Error(`Usage engine rendezvous temporary file is unsafe: ${temporaryPath}`);
    }
    await temporaryFile.close();
    temporaryFile = undefined;
    await assertRendezvousAbsent(filePath);
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if (errorHasCode(error, 'EEXIST')) {
        throw new Error(`Usage engine rendezvous already exists and was preserved: ${filePath}`);
      }
      throw error;
    }
    publishedIdentity = temporaryIdentity;
    await unlink(temporaryPath);
    const published = await lstat(filePath);
    if (!(sameIdentity(temporaryIdentity, published) && published.nlink === 1)) {
      throw new Error(`Usage engine rendezvous changed during publication: ${filePath}`);
    }
    if (process.platform !== 'win32') {
      await chmod(filePath, PRIVATE_FILE_MODE);
    }
    const privatePublished = await lstat(filePath);
    if (!sameIdentity(published, privatePublished)) {
      throw new Error(`Usage engine rendezvous changed during permission validation: ${filePath}`);
    }
    publishedIdentity = privatePublished;
    return {
      instanceId,
      path: filePath,
      port,
      remove: async () => {
        if (removed) {
          return;
        }
        removed = true;
        if (!(publishedIdentity && (await removeIfUnchanged(filePath, publishedIdentity)))) {
          throw new Error(`Usage engine rendezvous changed before removal: ${filePath}`);
        }
      },
      targetId,
      token,
    };
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (publishedIdentity) {
      await removeIfUnchanged(filePath, publishedIdentity);
    }
    throw error;
  }
};
