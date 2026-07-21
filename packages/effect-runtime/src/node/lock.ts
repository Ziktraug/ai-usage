import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const LOCK_FILE_NAME = 'wide-events.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const STALE_LOCK_MS = 30_000;

export interface CooperativeLockHandle {
  readonly release: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const lockOwnerIsAlive = (lockPath: string): boolean => {
  let ownerPid: number;
  try {
    const [pidText] = readFileSync(lockPath, 'utf8').split('\n');
    ownerPid = Number(pidText);
  } catch {
    return false;
  }
  if (!(Number.isSafeInteger(ownerPid) && ownerPid > 0)) {
    return false;
  }
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const assertSafePath = (targetPath: string, kind: 'directory' | 'file'): void => {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink ${kind} path: ${targetPath}`);
  }
  if (kind === 'directory' && !stats.isDirectory()) {
    throw new Error(`Expected directory at ${targetPath}`);
  }
  if (kind === 'file' && stats.nlink > 1) {
    throw new Error(`Refusing multi-link ${kind} path: ${targetPath}`);
  }
  if (kind === 'file' && !stats.isFile()) {
    throw new Error(`Expected regular file at ${targetPath}`);
  }
};

export const ensureOwnedLogDirectory = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafePath(directory, 'directory');
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best-effort mode repair on platforms that support it.
  }
};

export const acquireCooperativeLock = async (
  directory: string,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<CooperativeLockHandle | null> => {
  ensureOwnedLogDirectory(directory);
  const lockPath = path.join(directory, LOCK_FILE_NAME);
  const started = Date.now();

  while (Date.now() - started <= timeoutMs) {
    try {
      assertSafePath(lockPath, 'file');
      // biome-ignore lint/suspicious/noBitwiseOperators: open flags are OR'd intentionally
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      return {
        release: () => {
          try {
            closeSync(fd);
          } catch {
            // ignore
          }
          try {
            unlinkSync(lockPath);
          } catch {
            // ignore
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      try {
        const stats = lstatSync(lockPath);
        const stale = Date.now() - stats.mtimeMs > STALE_LOCK_MS;
        if (!stats.isSymbolicLink() && stats.isFile() && stale && !lockOwnerIsAlive(lockPath)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // retry
      }
      await sleep(20);
    }
  }

  return null;
};

export const withCooperativeLock = async <A>(
  directory: string,
  operation: () => Promise<A>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<A | null> => {
  const lock = await acquireCooperativeLock(directory, timeoutMs);
  if (lock === null) {
    return null;
  }
  try {
    return await operation();
  } finally {
    lock.release();
  }
};

export const assertSafeRegularFilePath = (targetPath: string): void => {
  assertSafePath(targetPath, 'file');
};
