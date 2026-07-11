import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SkillDiagnostic, SkillSourceState, SkillSourceStateResult } from './contracts';
import { createDiagnostic, isMissingPathError, isRecord } from './diagnostics';
import { atomicWriteFile, readBoundedRegularFile, withSerializedFileMutation } from './filesystem';
import { parseSkillName, skillNamePattern } from './shared';
import { parseBoolean } from './validation';

const maxSkillSourceStateBytes = 1_048_576;

const parseSkillSourceState = (
  value: unknown,
  statePath?: string,
): { diagnostics: readonly SkillDiagnostic[]; state?: SkillSourceState } => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skillEnabledByName)) {
    return { diagnostics: [] };
  }
  const skillEnabledByName: Record<string, boolean> = {};
  for (const [skillName, enabled] of Object.entries(value.skillEnabledByName)) {
    if (!skillNamePattern.test(skillName) || typeof enabled !== 'boolean') {
      return { diagnostics: [] };
    }
    skillEnabledByName[skillName] = enabled;
  }

  const diagnostics: SkillDiagnostic[] = [];
  const state: SkillSourceState = { version: 1, skillEnabledByName };
  if (value.skillOriginByName !== undefined) {
    if (isRecord(value.skillOriginByName)) {
      const skillOriginByName: Record<string, string> = {};
      for (const [skillName, origin] of Object.entries(value.skillOriginByName)) {
        if (skillNamePattern.test(skillName) && typeof origin === 'string') {
          skillOriginByName[skillName] = origin;
          continue;
        }
        diagnostics.push(
          createDiagnostic('InvalidSkillOriginMetadata', 'warning', 'Dropped invalid source skill origin metadata', {
            ...(statePath === undefined ? {} : { path: statePath }),
            ...(skillNamePattern.test(skillName) ? { skillName } : {}),
          }),
        );
      }
      state.skillOriginByName = skillOriginByName;
    } else {
      diagnostics.push(
        createDiagnostic(
          'InvalidSkillOriginMetadata',
          'warning',
          'Source skill origins must be string values',
          statePath === undefined ? {} : { path: statePath },
        ),
      );
    }
  }
  return { diagnostics, state };
};

const isWritableSkillSourceState = (value: unknown): value is SkillSourceState => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skillEnabledByName)) {
    return false;
  }
  const validEnabled = Object.entries(value.skillEnabledByName).every(
    ([skillName, enabled]) => skillNamePattern.test(skillName) && typeof enabled === 'boolean',
  );
  if (!validEnabled) {
    return false;
  }
  if (value.skillOriginByName === undefined) {
    return true;
  }
  return (
    isRecord(value.skillOriginByName) &&
    Object.entries(value.skillOriginByName).every(
      ([skillName, origin]) => skillNamePattern.test(skillName) && typeof origin === 'string',
    )
  );
};

export const skillSourceStatePath = (sourceRepoPath: string): string =>
  path.join(sourceRepoPath, '.skill-tracker', 'state.json');

const safeSkillSourceStatePath = async (
  sourceRepoPath: string,
  createTracker: boolean,
): Promise<string | undefined> => {
  const realSourceRepoPath = await realpath(sourceRepoPath);
  const trackerPath = path.join(sourceRepoPath, '.skill-tracker');
  if (createTracker) {
    try {
      await mkdir(trackerPath, { mode: 0o700 });
    } catch (error) {
      if (!(isRecord(error) && error.code === 'EEXIST')) {
        throw error;
      }
    }
  }

  let trackerStat: Awaited<ReturnType<typeof lstat>>;
  try {
    trackerStat = await lstat(trackerPath);
  } catch (error) {
    if (!createTracker && isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (trackerStat.isSymbolicLink()) {
    throw new Error('source skill state directory must not be a symlink');
  }
  if (!trackerStat.isDirectory()) {
    throw new Error('source skill state directory must be a directory');
  }

  const realTrackerPath = await realpath(trackerPath);
  const trackerRelativePath = path.relative(realSourceRepoPath, realTrackerPath);
  if (trackerRelativePath.startsWith('..') || path.isAbsolute(trackerRelativePath)) {
    throw new Error('source skill state directory must stay inside the source repository');
  }

  const filePath = path.join(realTrackerPath, 'state.json');
  try {
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error('source skill state file must not be a symlink');
    }
    if (!fileStat.isFile()) {
      throw new Error('source skill state must be a regular file');
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return filePath;
};

export const loadSkillSourceState = async (sourceRepoPath: string): Promise<SkillSourceStateResult> => {
  const configuredFilePath = skillSourceStatePath(sourceRepoPath);
  try {
    const filePath = await safeSkillSourceStatePath(sourceRepoPath, false);
    if (filePath === undefined) {
      return { diagnostics: [], state: { version: 1, skillEnabledByName: {} } };
    }
    const fileRead = await readBoundedRegularFile(filePath, maxSkillSourceStateBytes);
    if (fileRead.kind === 'missing') {
      return { diagnostics: [], state: { version: 1, skillEnabledByName: {} } };
    }
    if (fileRead.kind !== 'ok') {
      throw new Error('source skill state must be a bounded readable regular file');
    }
    const parsed = JSON.parse(fileRead.buffer.toString('utf8')) as unknown;
    const parsedState = parseSkillSourceState(parsed, filePath);
    if (parsedState.state === undefined) {
      return {
        diagnostics: [
          createDiagnostic('InvalidSourceState', 'error', 'Source skill state must be JSON version 1', {
            path: configuredFilePath,
          }),
        ],
        state: { version: 1, skillEnabledByName: {} },
      };
    }
    return { diagnostics: parsedState.diagnostics, state: parsedState.state };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { diagnostics: [], state: { version: 1, skillEnabledByName: {} } };
    }
    return {
      diagnostics: [
        createDiagnostic('InvalidSourceState', 'error', 'Source skill state must be readable JSON', {
          path: configuredFilePath,
        }),
      ],
      state: { version: 1, skillEnabledByName: {} },
    };
  }
};

const writeSkillSourceStateUnlocked = async (filePath: string, stateValue: SkillSourceState): Promise<void> => {
  if (!isWritableSkillSourceState(stateValue)) {
    throw new Error('source skill state must be JSON version 1');
  }
  await atomicWriteFile(filePath, `${JSON.stringify(stateValue, null, 2)}\n`);
};

const withSkillSourceStateMutation = async <Result>(
  sourceRepoPath: string,
  mutation: (canonicalStatePath: string) => Promise<Result>,
): Promise<Result> => {
  const canonicalStatePath = await safeSkillSourceStatePath(sourceRepoPath, true);
  if (canonicalStatePath === undefined) {
    throw new Error('source skill state directory could not be created');
  }
  return await withSerializedFileMutation(canonicalStatePath, async () => {
    const revalidatedStatePath = await safeSkillSourceStatePath(sourceRepoPath, true);
    if (revalidatedStatePath !== canonicalStatePath) {
      throw new Error('source skill state path changed while waiting for its mutation lock');
    }
    return await mutation(canonicalStatePath);
  });
};

export const writeSkillSourceState = async (sourceRepoPath: string, stateValue: SkillSourceState): Promise<void> =>
  withSkillSourceStateMutation(sourceRepoPath, (filePath) => writeSkillSourceStateUnlocked(filePath, stateValue));

export const setSkillEnabled = async (
  sourceRepoPath: string,
  skillName: string,
  enabled: boolean,
): Promise<SkillSourceState> => {
  const parsedSkillName = parseSkillName(skillName);
  const parsedEnabled = parseBoolean(enabled, 'enabled');
  return await withSkillSourceStateMutation(sourceRepoPath, async (filePath) => {
    const current = await loadSkillSourceState(sourceRepoPath);
    if (current.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new Error('source skill state must be readable JSON before it can be updated');
    }
    const nextState: SkillSourceState = {
      ...current.state,
      version: 1,
      skillEnabledByName: {
        ...current.state.skillEnabledByName,
        [parsedSkillName]: parsedEnabled,
      },
    };
    await writeSkillSourceStateUnlocked(filePath, nextState);
    return nextState;
  });
};
