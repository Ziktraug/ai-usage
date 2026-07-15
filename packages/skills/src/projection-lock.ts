import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isMissingPathError } from './diagnostics';
import { withSerializedMutationLock } from './filesystem';

const PRIVATE_DIRECTORY_MODE = 0o700;

const ensurePrivateDirectory = async (directoryPath: string): Promise<void> => {
  await mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const directoryStat = await lstat(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Skills projection lock directory is unsafe: ${directoryPath}`);
  }
  if (process.platform !== 'win32') {
    await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
};

export const projectionLockIdentityForTarget = async (targetPath: string): Promise<string> => {
  const resolvedTargetPath = path.resolve(targetPath);
  let existingParent = resolvedTargetPath;
  while (true) {
    try {
      const parentStat = await lstat(existingParent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error(`Skill target ancestor must be a non-symlink directory: ${existingParent}`);
      }
      const canonicalParent = await realpath(existingParent);
      return path.resolve(canonicalParent, path.relative(existingParent, resolvedTargetPath));
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(existingParent);
      if (parent === existingParent) {
        throw new Error('Skill target has no observable directory ancestor');
      }
      existingParent = parent;
    }
  }
};

export const withSkillProjectionLock = async <Result>(
  privateStatePath: string,
  targetLockIdentity: string,
  mutation: () => Promise<Result>,
): Promise<Result> => {
  const lockDirectory = path.join(path.resolve(privateStatePath), 'skills-projection-locks');
  await ensurePrivateDirectory(lockDirectory);
  const digest = createHash('sha256').update(targetLockIdentity).digest('hex');
  return withSerializedMutationLock(path.join(lockDirectory, `${digest}.lock`), mutation);
};
