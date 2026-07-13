import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import { isProjectGroupConfigArray } from '@ai-usage/report-core/project-group';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { parseSkillConfigInput, type SkillManagementConfig } from '@ai-usage/skills';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';

const machineConfigError = (operation: string, filePath: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, path: filePath, cause });

const aiUsageConfigUpdateTails = new Map<string, Promise<void>>();
const configLockAcquireTimeoutMs = 15_000;
const configLockHardExpirationMs = 5 * 60_000;
const configLockRetryMs = 10;
const maxConfigLockMetadataBytes = 1024;
const exclusiveConfigLockFlags = 'wx+';
const noFollowConfigLockReadFlags = fs.constants.O_NOFOLLOW;

interface ConfigLockMetadata {
  createdAt: string;
  hostname: string;
  ownerId: string;
  pid: number;
  version: 1;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const removeConfigLockIfUnchanged = async (lockPath: string, identity: FileIdentity): Promise<boolean> => {
  const current = await lstat(lockPath).catch(() => undefined);
  if (!(current?.isFile() && sameFileIdentity(current, identity))) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
};

const configLockMetadataFrom = (text: string): ConfigLockMetadata | undefined => {
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      'version' in value &&
      value.version === 1 &&
      'createdAt' in value &&
      typeof value.createdAt === 'string' &&
      'hostname' in value &&
      typeof value.hostname === 'string' &&
      'ownerId' in value &&
      typeof value.ownerId === 'string' &&
      'pid' in value &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0
    ) {
      return value as ConfigLockMetadata;
    }
  } catch {
    return;
  }
  return;
};

const localProcessIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, 'ESRCH');
  }
};

const removeStaleConfigLock = async (lockPath: string): Promise<boolean> => {
  let lockFile: Awaited<ReturnType<typeof open>>;
  try {
    lockFile = await open(lockPath, noFollowConfigLockReadFlags);
  } catch {
    return false;
  }
  try {
    const lockStat = await lockFile.stat();
    if (!lockStat.isFile()) {
      return false;
    }
    const metadata =
      lockStat.size <= maxConfigLockMetadataBytes ? configLockMetadataFrom(await lockFile.readFile('utf8')) : undefined;
    const ownerExited = metadata?.hostname === os.hostname() && !localProcessIsAlive(metadata.pid);
    const malformedLockExpired = metadata === undefined && Date.now() - lockStat.mtimeMs >= configLockHardExpirationMs;
    if (!(ownerExited || malformedLockExpired)) {
      return false;
    }
    return await removeConfigLockIfUnchanged(lockPath, lockStat);
  } finally {
    await lockFile.close().catch(() => undefined);
  }
};

const withConfigFileLock = async <A>(filePath: string, update: () => A | Promise<A>): Promise<A> => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const canonicalFilePath = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  const lockPath = `${canonicalFilePath}.lock`;
  const deadline = Date.now() + configLockAcquireTimeoutMs;
  let lockFile: Awaited<ReturnType<typeof open>> | undefined;

  while (lockFile === undefined) {
    try {
      lockFile = await open(lockPath, exclusiveConfigLockFlags, 0o600);
    } catch (error) {
      if (!errorHasCode(error, 'EEXIST')) {
        throw error;
      }
      const lockStat = await lstat(lockPath).catch(() => undefined);
      if (lockStat?.isSymbolicLink()) {
        throw new Error(`ai-usage config lock must not be a symlink: ${lockPath}`);
      }
      if (await removeStaleConfigLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ai-usage config lock: ${canonicalFilePath}`);
      }
      await delay(configLockRetryMs);
    }
  }

  const metadata: ConfigLockMetadata = {
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    ownerId: randomUUID(),
    pid: process.pid,
    version: 1,
  };
  let lockIdentity: FileIdentity | undefined;
  try {
    await lockFile.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await lockFile.sync();
    lockIdentity = await lockFile.stat();
    return await update();
  } finally {
    lockIdentity ??= await lockFile.stat().catch(() => undefined);
    await lockFile.close().catch(() => undefined);
    if (lockIdentity) {
      await removeConfigLockIfUnchanged(lockPath, lockIdentity);
    }
  }
};

const writeJsonAtomically = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

const enqueueAiUsageConfigUpdate = async <A>(filePath: string, update: () => A | Promise<A>): Promise<A> => {
  const previousTail = aiUsageConfigUpdateTails.get(filePath) ?? Promise.resolve();
  const result = previousTail.catch(() => undefined).then(() => withConfigFileLock(filePath, update));
  const currentTail = result.then(
    () => undefined,
    () => undefined,
  );
  aiUsageConfigUpdateTails.set(filePath, currentTail);

  try {
    return await result;
  } finally {
    if (aiUsageConfigUpdateTails.get(filePath) === currentTail) {
      aiUsageConfigUpdateTails.delete(filePath);
    }
  }
};

export const machineConfigPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'machine.json');

export const aiUsageConfigPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'config.json');

export const repoAiUsageConfigPath = (cwd = process.cwd()) => path.join(cwd, 'ai-usage.config.ts');

const isUsageMachine = (value: unknown): value is UsageMachine => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0 && typeof record.label === 'string';
};

const isSkillManagementConfig = (value: unknown): value is SkillManagementConfig => {
  try {
    parseSkillConfigInput(value);
    return true;
  } catch {
    return false;
  }
};

export const ensureMachineConfig: Effect.Effect<UsageMachine, LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = machineConfigPath(storage);
    if (yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
      const parsed = JSON.parse(yield* storage.readText(filePath)) as unknown;
      if (!isUsageMachine(parsed)) {
        throw new Error(`Invalid machine config: ${filePath}`);
      }
      return parsed;
    }

    const machine: UsageMachine = {
      id: randomUUID(),
      label: os.hostname() || 'This machine',
    };

    yield* Effect.try({
      try: () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(machine, null, 2)}\n`, 'utf8');
      },
      catch: machineConfigError('writeMachineConfig', filePath),
    });

    return machine;
  });

export const writeMachineConfig = (
  machine: UsageMachine,
): Effect.Effect<void, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = machineConfigPath(storage);
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(machine, null, 2)}\n`, 'utf8');
      },
      catch: machineConfigError('writeMachineConfig', filePath),
    });
  });

const isAiUsageConfig = (value: unknown): value is AiUsageConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const config = value as Record<string, unknown>;
  const aliases = config.projectAliases;
  if (aliases !== undefined) {
    if (!Array.isArray(aliases)) {
      return false;
    }
    if (
      !aliases.every((alias) => {
        if (typeof alias !== 'object' || alias === null || Array.isArray(alias)) {
          return false;
        }
        const record = alias as Record<string, unknown>;
        return (
          typeof record.name === 'string' &&
          Array.isArray(record.match) &&
          record.match.every((v) => typeof v === 'string')
        );
      })
    ) {
      return false;
    }
  }

  const projectGroups = config.projectGroups;
  if (projectGroups !== undefined && !isProjectGroupConfigArray(projectGroups)) {
    return false;
  }

  const cursor = config.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return false;
    }
    const cursorConfig = cursor as Record<string, unknown>;
    const usageExportPaths = cursorConfig.usageExportPaths;
    if (
      usageExportPaths !== undefined &&
      !(Array.isArray(usageExportPaths) && usageExportPaths.every((v) => typeof v === 'string'))
    ) {
      return false;
    }
    const usageExportDir = cursorConfig.usageExportDir;
    if (usageExportDir !== undefined && typeof usageExportDir !== 'string') {
      return false;
    }
    const reconcileWindowMs = cursorConfig.reconcileWindowMs;
    if (
      reconcileWindowMs !== undefined &&
      (typeof reconcileWindowMs !== 'number' || !Number.isInteger(reconcileWindowMs) || reconcileWindowMs <= 0)
    ) {
      return false;
    }
    const clusterGapMs = cursorConfig.clusterGapMs;
    if (
      clusterGapMs !== undefined &&
      (typeof clusterGapMs !== 'number' || !Number.isInteger(clusterGapMs) || clusterGapMs <= 0)
    ) {
      return false;
    }
    const maxSessionSpanMs = cursorConfig.maxSessionSpanMs;
    if (
      maxSessionSpanMs !== undefined &&
      (typeof maxSessionSpanMs !== 'number' || !Number.isInteger(maxSessionSpanMs) || maxSessionSpanMs <= 0)
    ) {
      return false;
    }
    const user = cursorConfig.user;
    if (user !== undefined && typeof user !== 'string') {
      return false;
    }
  }

  const skills = config.skills;
  if (skills !== undefined && !isSkillManagementConfig(skills)) {
    return false;
  }
  return true;
};

const mergeSkillsConfig = (base: unknown, override: unknown): SkillManagementConfig | undefined => {
  if (base === undefined && override === undefined) {
    return;
  }

  const baseSkills = base === undefined ? undefined : parseSkillConfigInput(base);
  const overrideSkills = override === undefined ? undefined : parseSkillConfigInput(override);

  if (baseSkills === undefined) {
    return overrideSkills;
  }
  if (overrideSkills === undefined) {
    return baseSkills;
  }

  const merged: SkillManagementConfig = { ...baseSkills, ...overrideSkills };
  if (overrideSkills.targets === undefined && baseSkills.targets !== undefined) {
    merged.targets = baseSkills.targets;
  } else if (baseSkills.targets !== undefined || overrideSkills.targets !== undefined) {
    merged.targets = { ...(baseSkills.targets ?? {}), ...(overrideSkills.targets ?? {}) };
  }
  if (overrideSkills.connectors === undefined && baseSkills.connectors !== undefined) {
    merged.connectors = baseSkills.connectors;
  } else if (baseSkills.connectors !== undefined || overrideSkills.connectors !== undefined) {
    merged.connectors = { ...(baseSkills.connectors ?? {}), ...(overrideSkills.connectors ?? {}) };
  }
  if (overrideSkills.tokenThresholds === undefined && baseSkills.tokenThresholds !== undefined) {
    merged.tokenThresholds = baseSkills.tokenThresholds;
  }
  if (overrideSkills.ignoredTargetFindings === undefined && baseSkills.ignoredTargetFindings !== undefined) {
    merged.ignoredTargetFindings = baseSkills.ignoredTargetFindings;
  }
  if (overrideSkills.projectPaths === undefined && baseSkills.projectPaths !== undefined) {
    merged.projectPaths = baseSkills.projectPaths;
  }
  return merged;
};

const parseAiUsageConfig = (value: unknown, filePath: string): AiUsageConfig => {
  if (!isAiUsageConfig(value)) {
    throw new Error(`Invalid ai-usage config: ${filePath}`);
  }
  return value;
};

const mergeAiUsageConfig = (base: AiUsageConfig, override: AiUsageConfig): AiUsageConfig => {
  const merged: AiUsageConfig = { ...base, ...override };
  if (override.projectAliases === undefined && base.projectAliases !== undefined) {
    merged.projectAliases = base.projectAliases;
  }
  if (override.projectGroups === undefined && base.projectGroups !== undefined) {
    merged.projectGroups = base.projectGroups;
  }
  if (base.cursor || override.cursor) {
    merged.cursor = { ...(base.cursor ?? {}), ...(override.cursor ?? {}) };
  }
  const skills = mergeSkillsConfig(base.skills, override.skills);
  if (skills !== undefined) {
    merged.skills = skills;
  }
  return merged;
};

export const readAiUsageConfig: Effect.Effect<AiUsageConfig, LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = aiUsageConfigPath(storage);
    if (!(yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false))))) {
      return {};
    }
    const parsed = JSON.parse(yield* storage.readText(filePath)) as unknown;
    return parseAiUsageConfig(parsed, filePath);
  });

export const readRepoAiUsageConfig = (cwd = process.cwd()): Effect.Effect<AiUsageConfig, LocalHistoryError> =>
  Effect.gen(function* () {
    const filePath = repoAiUsageConfigPath(cwd);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const module = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ `${pathToFileURL(filePath).href}?t=${Date.now()}`),
      catch: machineConfigError('importAiUsageConfig', filePath),
    });
    const exportedConfig =
      (module as { default?: unknown; config?: unknown }).default ??
      (module as { default?: unknown; config?: unknown }).config;
    return parseAiUsageConfig(exportedConfig, filePath);
  });

export const readMergedAiUsageConfigFrom = (
  cwd = process.cwd(),
): Effect.Effect<AiUsageConfig, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const homeConfig = yield* readAiUsageConfig;
    const repoConfig = yield* readRepoAiUsageConfig(cwd);
    return mergeAiUsageConfig(homeConfig, repoConfig);
  });

export const readMergedAiUsageConfig = readMergedAiUsageConfigFrom();

export type AiUsageConfigUpdater = (config: AiUsageConfig) => AiUsageConfig | Promise<AiUsageConfig>;

export const updateAiUsageConfig = (
  update: AiUsageConfigUpdater,
): Effect.Effect<AiUsageConfig, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = aiUsageConfigPath(storage);
    return yield* Effect.tryPromise({
      try: () =>
        enqueueAiUsageConfigUpdate(filePath, async () => {
          const current = fs.existsSync(filePath)
            ? parseAiUsageConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown, filePath)
            : {};
          const next = parseAiUsageConfig(await update(current), filePath);
          writeJsonAtomically(filePath, next);
          return next;
        }),
      catch: machineConfigError('updateAiUsageConfig', filePath),
    });
  });

export const writeAiUsageConfig = (
  config: AiUsageConfig,
): Effect.Effect<void, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = aiUsageConfigPath(storage);
    yield* Effect.tryPromise({
      try: () =>
        enqueueAiUsageConfigUpdate(filePath, () => {
          writeJsonAtomically(filePath, parseAiUsageConfig(config, filePath));
        }),
      catch: machineConfigError('writeAiUsageConfig', filePath),
    });
  });
