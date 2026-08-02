import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  errorHasCode,
  type FileIdentity,
  hasCurrentOwner,
  isOwnerOnly,
  isProcessStartTimeTicks,
  processIsAlive,
  readProcessStartTimeTicks as processStartTimeTicks,
  sameFileIdentity,
} from '@ai-usage/usage-engine-control/node';

const BUILD_CONTAINER_NAME = '.output-build';
const BUILD_LOCK_NAME = 'build.lock';
const BUILD_LOCK_ACQUISITION_ATTEMPTS = 3;
const LOCK_METADATA_VERSION = 1;
const LOCK_INITIALIZATION_DEADLINE_MS = 250;
const LOCK_INITIALIZATION_POLL_MS = 10;
const MAX_LOCK_METADATA_BYTES = 4096;
const PRODUCTION_OUTPUT_CHILDREN = [
  path.join(BUILD_CONTAINER_NAME, 'nitro'),
  path.join(BUILD_CONTAINER_NAME, 'vite'),
  path.join(BUILD_CONTAINER_NAME, 'work'),
  'dist',
] as const;

interface ValidatedBuildContainer {
  identity: FileIdentity;
  path: string;
}

interface ProductionBuildLockContext {
  assertContainerUnchanged: () => Promise<void>;
}

interface ProductionBuildLockMetadata {
  appRoot: string;
  createdAt: string;
  hostname: string;
  ownerId: string;
  pid: number;
  processStartTimeTicks: string | null;
  version: typeof LOCK_METADATA_VERSION;
}

const validateBuildContainerStat = (containerPath: string, containerStat: Stats): void => {
  if (
    containerStat.isSymbolicLink() ||
    !containerStat.isDirectory() ||
    !hasCurrentOwner(containerStat.uid) ||
    !isOwnerOnly(containerStat.mode)
  ) {
    throw new Error(`Production web build container must be an owned directory: ${containerPath}`);
  }
};

const ensurePrivateBuildContainer = async (containerPath: string): Promise<ValidatedBuildContainer> => {
  try {
    await mkdir(containerPath, { mode: 0o700 });
  } catch (error) {
    if (!errorHasCode(error, 'EEXIST')) {
      throw error;
    }
  }

  const containerStat = await lstat(containerPath);
  if (containerStat.isSymbolicLink() || !containerStat.isDirectory() || !hasCurrentOwner(containerStat.uid)) {
    throw new Error(`Production web build container must be an owned directory: ${containerPath}`);
  }
  if (process.platform !== 'win32') {
    await chmod(containerPath, 0o700);
  }
  const privateContainerStat = await lstat(containerPath);
  validateBuildContainerStat(containerPath, privateContainerStat);
  if (!sameFileIdentity(containerStat, privateContainerStat)) {
    throw new Error(`Production web build container changed during validation: ${containerPath}`);
  }
  return { identity: privateContainerStat, path: containerPath };
};

const assertBuildContainerUnchanged = async (container: ValidatedBuildContainer): Promise<void> => {
  const containerStat = await lstat(container.path).catch(() => undefined);
  if (!containerStat) {
    throw new Error(`Production web build container disappeared during use: ${container.path}`);
  }
  validateBuildContainerStat(container.path, containerStat);
  if (!sameFileIdentity(container.identity, containerStat)) {
    throw new Error(`Production web build container changed during use: ${container.path}`);
  }
};

const parseLockMetadata = (text: string): ProductionBuildLockMetadata | undefined => {
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'appRoot,createdAt,hostname,ownerId,pid,processStartTimeTicks,version' ||
      !('version' in value) ||
      value.version !== LOCK_METADATA_VERSION ||
      !('appRoot' in value) ||
      typeof value.appRoot !== 'string' ||
      !('createdAt' in value) ||
      typeof value.createdAt !== 'string' ||
      !('hostname' in value) ||
      typeof value.hostname !== 'string' ||
      !('ownerId' in value) ||
      typeof value.ownerId !== 'string' ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !('processStartTimeTicks' in value) ||
      !(value.processStartTimeTicks === null || isProcessStartTimeTicks(value.processStartTimeTicks))
    ) {
      return;
    }
    return value as ProductionBuildLockMetadata;
  } catch {
    return;
  }
};

const removeLockIfUnchanged = async (lockPath: string, identity: FileIdentity): Promise<boolean> => {
  const current = await lstat(lockPath).catch(() => undefined);
  if (!(current?.isFile() && sameFileIdentity(current, identity))) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return false;
    }
    throw new Error(`Unable to release production web build lock: ${lockPath}`, { cause: error });
  }
};

const inspectExistingLock = async (
  lockPath: string,
  canonicalWebDirectory: string,
  buildContainer: ValidatedBuildContainer,
): Promise<{ identity: FileIdentity; metadata: ProductionBuildLockMetadata }> => {
  const initializationDeadline = Date.now() + LOCK_INITIALIZATION_DEADLINE_MS;
  let expectedIdentity: FileIdentity | undefined;
  while (true) {
    await assertBuildContainerUnchanged(buildContainer);
    const pathStat = await lstat(lockPath).catch(() => undefined);
    if (pathStat?.isSymbolicLink()) {
      throw new Error(`Production web build lock must not be a symlink: ${lockPath}`);
    }
    if (pathStat && !pathStat.isFile()) {
      throw new Error(`Production web build lock is not a bounded regular file: ${lockPath}`);
    }

    let lockFile: Awaited<ReturnType<typeof open>>;
    try {
      lockFile = await open(lockPath, fs.constants.O_NOFOLLOW);
    } catch (error) {
      throw new Error(`Unable to validate production web build lock ${lockPath}.`, { cause: error });
    }
    try {
      const lockStat = await lockFile.stat();
      if (!(lockStat.isFile() && lockStat.size <= MAX_LOCK_METADATA_BYTES)) {
        throw new Error(`Production web build lock is not a bounded regular file: ${lockPath}`);
      }
      if (
        (process.platform !== 'win32' &&
          (!(hasCurrentOwner(lockStat.uid) && isOwnerOnly(lockStat.mode)) || lockStat.nlink !== 1)) ||
        !pathStat ||
        !sameFileIdentity(pathStat, lockStat) ||
        (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, lockStat))
      ) {
        throw new Error(`Production web build lock must be owner-only and singly linked: ${lockPath}`);
      }
      expectedIdentity = lockStat;
      const metadataText = await lockFile.readFile('utf8');
      const metadata = parseLockMetadata(metadataText);
      if (metadata) {
        if (metadata.hostname !== os.hostname() || metadata.appRoot !== canonicalWebDirectory) {
          throw new Error(`Production web build lock ownership could not be validated and was preserved: ${lockPath}`);
        }
        return { identity: lockStat, metadata };
      }
      if (metadataText.endsWith('\n') || Date.now() >= initializationDeadline) {
        throw new Error(`Production web build lock has invalid metadata and was preserved: ${lockPath}`);
      }
    } finally {
      await lockFile.close().catch(() => undefined);
    }
    await Bun.sleep(LOCK_INITIALIZATION_POLL_MS);
  }
};

const recoverStaleLock = async (
  lockPath: string,
  canonicalWebDirectory: string,
  buildContainer: ValidatedBuildContainer,
): Promise<boolean> => {
  const { identity, metadata } = await inspectExistingLock(lockPath, canonicalWebDirectory, buildContainer);
  const ownerPidIsLive = processIsAlive(metadata.pid);
  const currentStartTime = ownerPidIsLive ? await processStartTimeTicks(metadata.pid) : null;
  const ownerIsLive =
    ownerPidIsLive &&
    (metadata.processStartTimeTicks === null ||
      currentStartTime === null ||
      currentStartTime === metadata.processStartTimeTicks);
  if (ownerIsLive) {
    throw new Error(`Production web build lock ${lockPath} is owned by live PID ${metadata.pid}.`);
  }
  await assertBuildContainerUnchanged(buildContainer);
  return await removeLockIfUnchanged(lockPath, identity);
};

const openProductionBuildLock = async (
  lockPath: string,
  canonicalWebDirectory: string,
  buildContainer: ValidatedBuildContainer,
): Promise<Awaited<ReturnType<typeof open>>> => {
  for (let attempt = 0; attempt < BUILD_LOCK_ACQUISITION_ATTEMPTS; attempt += 1) {
    try {
      return await open(lockPath, 'wx+', 0o600);
    } catch (error) {
      if (!errorHasCode(error, 'EEXIST')) {
        throw error;
      }
      await recoverStaleLock(lockPath, canonicalWebDirectory, buildContainer);
    }
  }
  throw new Error(`Production web build lock changed repeatedly during acquisition: ${lockPath}`);
};

export const productionBuildLockPath = (webDirectory: string): string =>
  path.join(webDirectory, BUILD_CONTAINER_NAME, BUILD_LOCK_NAME);

export const withProductionBuildLock = async <Result>(
  webDirectory: string,
  build: (context: ProductionBuildLockContext) => Result | Promise<Result>,
): Promise<Result> => {
  const canonicalWebDirectory = await realpath(webDirectory);
  const buildContainer = await ensurePrivateBuildContainer(path.join(canonicalWebDirectory, BUILD_CONTAINER_NAME));
  const lockPath = productionBuildLockPath(canonicalWebDirectory);
  const lockFile = await openProductionBuildLock(lockPath, canonicalWebDirectory, buildContainer);

  let lockIdentity: FileIdentity | undefined;
  try {
    const metadata: ProductionBuildLockMetadata = {
      appRoot: canonicalWebDirectory,
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
      ownerId: randomUUID(),
      pid: process.pid,
      processStartTimeTicks: await processStartTimeTicks(process.pid),
      version: LOCK_METADATA_VERSION,
    };
    await lockFile.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await lockFile.sync();
    lockIdentity = await lockFile.stat();
    return await build({
      assertContainerUnchanged: async () => await assertBuildContainerUnchanged(buildContainer),
    });
  } finally {
    lockIdentity ??= await lockFile.stat().catch(() => undefined);
    await lockFile.close().catch(() => undefined);
    if (lockIdentity) {
      await assertBuildContainerUnchanged(buildContainer);
      await removeLockIfUnchanged(lockPath, lockIdentity);
    }
  }
};

export type ProductionBuildCommandRunner = (command: readonly string[], cwd: string) => void | Promise<void>;

export interface RunProductionWebBuildOptions {
  repositoryDirectory: string;
  runCommand?: ProductionBuildCommandRunner;
  webDirectory: string;
}

const runInheritedCommand: ProductionBuildCommandRunner = async (command, cwd) => {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Production web build command failed with exit code ${exitCode}: ${command.join(' ')}`);
  }
};

export const runProductionWebBuild = async ({
  repositoryDirectory,
  runCommand = runInheritedCommand,
  webDirectory,
}: RunProductionWebBuildOptions): Promise<void> =>
  await withProductionBuildLock(webDirectory, async ({ assertContainerUnchanged }) => {
    await runCommand(['bun', '--no-env-file', '--filter', '@ai-usage/design-system', 'build'], repositoryDirectory);
    await runCommand(['bun', '--no-env-file', 'run', 'dev:prepare'], webDirectory);
    await runCommand(['bun', '--no-env-file', 'run', 'typecheck'], webDirectory);
    await assertContainerUnchanged();
    await Promise.all(
      PRODUCTION_OUTPUT_CHILDREN.map((relativePath) =>
        rm(path.join(webDirectory, relativePath), { force: true, recursive: true }),
      ),
    );
    await runCommand(['bun', '--no-env-file', '--bun', 'vite', 'build'], webDirectory);
  });

if (import.meta.main) {
  const webDirectory = import.meta.dirname;
  const repositoryDirectory = path.resolve(webDirectory, '../..');
  try {
    await runProductionWebBuild({ repositoryDirectory, webDirectory });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-usage] Production web build failed: ${message}`);
    process.exitCode = 1;
  }
}
