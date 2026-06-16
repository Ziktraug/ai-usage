import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiUsageConfig } from '@ai-usage/core/project-alias';
import type { UsageMachine } from '@ai-usage/core/snapshot';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';

const machineConfigError = (operation: string, filePath: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, path: filePath, cause });

export const machineConfigPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'machine.json');

export const aiUsageConfigPath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'config.json');

const isUsageMachine = (value: unknown): value is UsageMachine => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0 && typeof record.label === 'string';
};

export const ensureMachineConfig: Effect.Effect<UsageMachine, LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = machineConfigPath(storage);
    if (yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
      const parsed = JSON.parse(yield* storage.readText(filePath)) as unknown;
      if (!isUsageMachine(parsed)) throw new Error(`Invalid machine config: ${filePath}`);
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const aliases = (value as Record<string, unknown>).projectAliases;
  if (aliases === undefined) return true;
  if (!Array.isArray(aliases)) return false;
  return aliases.every((alias) => {
    if (typeof alias !== 'object' || alias === null || Array.isArray(alias)) return false;
    const record = alias as Record<string, unknown>;
    return (
      typeof record.name === 'string' && Array.isArray(record.match) && record.match.every((v) => typeof v === 'string')
    );
  });
};

export const readAiUsageConfig: Effect.Effect<AiUsageConfig, LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const filePath = aiUsageConfigPath(storage);
    if (!(yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false))))) return {};
    const parsed = JSON.parse(yield* storage.readText(filePath)) as unknown;
    if (!isAiUsageConfig(parsed)) throw new Error(`Invalid ai-usage config: ${filePath}`);
    return parsed;
  });

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
