import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import { isProjectGroupConfig } from '@ai-usage/report-core/project-group';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { parseSkillConfigInput, type SkillManagementConfig } from '@ai-usage/skills';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';

const machineConfigError = (operation: string, filePath: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, path: filePath, cause });

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
  if (projectGroups !== undefined && !(Array.isArray(projectGroups) && projectGroups.every(isProjectGroupConfig))) {
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

  const sync = config.sync;
  const skills = config.skills;
  if (skills !== undefined && !isSkillManagementConfig(skills)) {
    return false;
  }

  if (sync === undefined) {
    return true;
  }
  if (typeof sync !== 'object' || sync === null || Array.isArray(sync)) {
    return false;
  }
  const syncConfig = sync as Record<string, unknown>;
  const remotes = syncConfig.remotes;
  if (remotes === undefined) {
    return true;
  }
  if (!Array.isArray(remotes)) {
    return false;
  }
  return remotes.every((remote) => {
    if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
      return false;
    }
    const record = remote as Record<string, unknown>;
    return (
      typeof record.name === 'string' &&
      record.name.length > 0 &&
      typeof record.url === 'string' &&
      record.url.length > 0 &&
      (record.tokenEnv === undefined || typeof record.tokenEnv === 'string') &&
      (record.enabled === undefined || typeof record.enabled === 'boolean')
    );
  });
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
  if (base.sync || override.sync) {
    merged.sync = { ...(base.sync ?? {}), ...(override.sync ?? {}) };
    if (override.sync?.remotes === undefined && base.sync?.remotes !== undefined) {
      merged.sync.remotes = base.sync.remotes;
    }
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

export const writeAiUsageConfig = (
  config: AiUsageConfig,
): Effect.Effect<void, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = aiUsageConfigPath(storage);
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      },
      catch: machineConfigError('writeAiUsageConfig', filePath),
    });
  });
