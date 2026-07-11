import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSkillName, parseTargetId, skillNamePattern, skillTokenDiagnosticCodes } from './shared';

export type { SkillTokenDiagnosticCode } from './shared';
export { parseSkillName, parseTargetId, skillTokenDiagnosticCodes } from './shared';

export type SkillDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface SkillDiagnostic {
  code: string;
  message: string;
  path?: string;
  severity: SkillDiagnosticSeverity;
  skillName?: string;
  targetId?: string;
}

export type SkillTargetScope = 'system' | 'project';
export type SkillTargetKind = 'standard-interop' | 'native' | 'custom';

export interface SkillTokenThreshold {
  high: number;
  warn: number;
}

export interface SkillTokenThresholds {
  referenceFile: SkillTokenThreshold;
  skillMd: SkillTokenThreshold;
  totalSkill: SkillTokenThreshold;
}

export interface SkillManagementTargetConfig {
  enabled: boolean;
  kind: SkillTargetKind;
  path: string;
  scope: SkillTargetScope;
}

export interface SkillManagementConnectorConfig {
  consumesTargets: readonly string[];
  enabled: boolean;
}

export interface SkillManagementConfig {
  connectors?: Record<string, SkillManagementConnectorConfig>;
  ignoredTargetFindings?: readonly string[];
  projectPaths?: readonly string[];
  projectsRootPath?: string;
  sourceRepoPath?: string;
  targets?: Record<string, SkillManagementTargetConfig>;
  tokenThresholds?: SkillTokenThresholds;
}

export interface SkillSourceState {
  skillEnabledByName: Record<string, boolean>;
  skillOriginByName?: Record<string, string>;
  version: 1;
}

export type SkillValidationStatus = 'valid' | 'warning' | 'invalid';

export type SkillFrontmatterFieldKind = 'standard' | 'known-extension' | 'unknown-extension';

export type JsonValue = boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface SkillFrontmatterField {
  key: string;
  kind: SkillFrontmatterFieldKind;
  value: JsonValue;
}

export interface SkillManifest {
  description?: string;
  fields: readonly SkillFrontmatterField[];
  markdown: string;
  name?: string;
}

export interface SourceSkill {
  description: string;
  diagnostics: readonly SkillDiagnostic[];
  enabled: boolean;
  manifest: SkillManifest;
  name: string;
  path: string;
  skillMdPath: string;
  tokenCount?: {
    approximate: true;
    references: number;
    skillMd: number;
    total: number;
  };
  validationStatus: SkillValidationStatus;
}

export interface SkillTarget {
  connectorId?: string;
  enabled: boolean;
  id: string;
  kind: SkillTargetKind;
  label: string;
  missing: boolean;
  observed: boolean;
  path: string;
  scope: SkillTargetScope;
}

export type ProjectionState =
  | 'linked'
  | 'missing'
  | 'broken-link'
  | 'wrong-target'
  | 'unmanaged-copy'
  | 'unmanaged-symlink'
  | 'duplicate-same-content'
  | 'duplicate-name-conflict'
  | 'disabled-exposed'
  | 'missing-target';

export interface Projection {
  actualPath?: string;
  diagnostics: readonly SkillDiagnostic[];
  expectedPath: string;
  skillName: string;
  state: ProjectionState;
  targetId: string;
}

export type ProjectionAction =
  | {
      path: string;
      skillName: string;
      sourcePath: string;
      targetId: string;
      type: 'create-symlink';
    }
  | {
      observedSourcePath: string;
      path: string;
      skillName: string;
      sourcePath: string;
      targetId: string;
      type: 'repair-symlink' | 'unlink-managed-symlink';
    }
  | {
      path: string;
      reason: string;
      skillName: string;
      targetId: string;
      type: 'noop' | 'refuse-unmanaged-mutation';
    };

export interface SkillMutationInput {
  enabled?: boolean;
  skillName: string;
  targetId: string;
}

export interface SkillToggleInput {
  enabled: boolean;
  skillName: string;
}

export interface SkillTargetDirectoryInput {
  targetId: string;
}

export interface SkillSourceStateResult {
  diagnostics: readonly SkillDiagnostic[];
  state: SkillSourceState;
}

export interface ParsedSkillMarkdown {
  diagnostics: readonly SkillDiagnostic[];
  manifest: SkillManifest;
}

export interface SourceSkillScanOptions {
  ignoredDirectories?: readonly string[];
  maxFilesPerSkill?: number;
  maxRuntimeEntries?: number;
  maxSkills?: number;
  maxTextFileBytes?: number;
  tokenThresholds?: SkillTokenThresholds;
}

export interface SourceSkillScanInput {
  options?: SourceSkillScanOptions;
  sourceRepoPath: string;
  state?: SkillSourceState;
}

export interface SourceSkillScan {
  diagnostics: readonly SkillDiagnostic[];
  skills: readonly SourceSkill[];
}

export interface TargetProjectionScanInput {
  skills: readonly SourceSkill[];
  targets: readonly SkillTarget[];
}

export interface TargetProjectionScan {
  diagnostics: readonly SkillDiagnostic[];
  projections: readonly Projection[];
  unmanagedEntries: readonly Projection[];
}

export interface SkillManagementConfigDocument {
  skills?: unknown;
  [key: string]: unknown;
}

export interface SkillManagementSnapshotSummary {
  activeSkillCount: number;
  diagnosticCount: number;
  healthyProjectionCount: number;
  skillCount: number;
  targetCount: number;
  unhealthyProjectionCount: number;
  unmanagedEntryCount: number;
}

export interface SkillManagementSnapshot {
  config: SkillManagementConfig;
  configured: boolean;
  diagnostics: readonly SkillDiagnostic[];
  nativeRuleFindings: readonly SkillDiagnostic[];
  projections: readonly Projection[];
  skills: readonly SourceSkill[];
  sourceState: SkillSourceState;
  summary: SkillManagementSnapshotSummary;
  targets: readonly SkillTarget[];
  unmanagedEntries: readonly Projection[];
}

export interface LoadSkillManagementSnapshotInput {
  config: SkillManagementConfigDocument;
  homePath: string;
}

export interface WriteSkillManagementConfigInput {
  config: SkillManagementConfigDocument;
  skills: unknown;
  writeConfig: (config: SkillManagementConfigDocument) => Promise<void>;
}

export interface ToggleSkillEnabledInput {
  enabled: boolean;
  skillName: string;
  sourceRepoPath: string;
}

export interface ReconcileSkillInput extends LoadSkillManagementSnapshotInput {
  skillName: string;
}

export interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export interface CreateSkillTargetDirectoryInput {
  path: string;
}

export const projectSkillDirectories = [
  { id: 'claude-project', label: 'Claude Code', relativePath: '.claude/skills' },
  { id: 'agents-project', label: 'Standard Agents', relativePath: '.agents/skills' },
] as const;

export type ProjectSkillPlacement = 'owned-directory' | 'symlink-to-source' | 'project-symlink' | 'external-symlink';

export interface ProjectSkillObservation {
  description: string;
  diagnostics: readonly SkillDiagnostic[];
  invocation: 'auto' | 'manual';
  markdownReadable: boolean;
  name: string;
  path: string;
  placement: ProjectSkillPlacement;
  runtimeDirId: (typeof projectSkillDirectories)[number]['id'];
  skillMdPath: string;
  tokenCount?: SourceSkill['tokenCount'];
  validationStatus: SkillValidationStatus;
}

export interface ProjectSkillInventory {
  diagnostics: readonly SkillDiagnostic[];
  observations: readonly ProjectSkillObservation[];
  projectPath: string;
}

export interface SkillMarkdownDocument {
  content: string;
  path: string;
  sha256: string;
  skillName: string;
}

export interface SkillMarkdownWriteInput {
  baseSha256: string;
  content: string;
  skillName: string;
}

export const defaultTokenThresholds: SkillTokenThresholds = {
  referenceFile: { warn: 5000, high: 12_000 },
  skillMd: { warn: 2000, high: 5000 },
  totalSkill: { warn: 8000, high: 20_000 },
};

export const maxSkillMarkdownBytes = 262_144;

const frontmatterClosePattern = /^\n---\r?\n?/;
const lineBreakPattern = /\r?\n/;
const whitespacePattern = /\s+/;
const targetKinds = new Set<SkillTargetKind>(['standard-interop', 'native', 'custom']);
const targetScopes = new Set<SkillTargetScope>(['system', 'project']);
const knownFrontmatterExtensions = new Set(['paths', 'disable-model-invocation']);
const standardFrontmatterFields = new Set(['name', 'description']);
const defaultIgnoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', 'styled-system']);
const defaultMaxFilesPerSkill = 200;
const defaultMaxRuntimeEntries = 500;
const defaultMaxSkills = 500;
const defaultMaxTextFileBytes = 200_000;
const maxSkillSourceStateBytes = 1_048_576;
const tokenDiagnosticCodeSet = new Set<string>(skillTokenDiagnosticCodes);
const mutationLocks = new Map<string, Promise<void>>();
const fileLockAcquireTimeoutMs = 10_000;
const fileLockHardExpirationMs = 30_000;
const fileLockHeartbeatMs = 250;
const fileLockLeaseMs = 2000;
const fileLockRetryMs = 10;
const maxFileLockMetadataBytes = 1024;
const localHostname = hostname();

// biome-ignore lint/suspicious/noBitwiseOperators: Node filesystem flags are bitmasks.
const noFollowReadFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
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

const sameFileIdentity = (
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

const withSerializedFileMutation = async <Result>(
  canonicalFilePath: string,
  mutation: () => Promise<Result>,
): Promise<Result> =>
  withSerializedPathMutation(canonicalFilePath, () => withFileSystemLock(canonicalFilePath, mutation));

const existingRegularFileMode = async (filePath: string, defaultMode: number): Promise<number> => {
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

const writeExclusiveFile = async (filePath: string, content: string | Buffer, mode: number): Promise<void> => {
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

const writeTemporarySibling = async (filePath: string, content: string | Buffer, mode: number): Promise<string> => {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeExclusiveFile(temporaryPath, content, mode);
  return temporaryPath;
};

const atomicWriteFile = async (filePath: string, content: string | Buffer, defaultMode = 0o600): Promise<void> => {
  const mode = await existingRegularFileMode(filePath, defaultMode);
  const temporaryPath = await writeTemporarySibling(filePath, content, mode);
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const parseOptionalNonEmptyString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const parseBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
};

const parseStringArray = (value: unknown, label: string): readonly string[] => {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
};

const parseNonEmptyStringArray = (value: unknown, label: string): readonly string[] => {
  const entries = parseStringArray(value, label);
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  return entries;
};

const parsePositiveNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
};

const parseTokenThreshold = (value: unknown, label: string): SkillTokenThreshold => {
  const record = assertRecord(value, label);
  return {
    high: parsePositiveNumber(record.high, `${label}.high`),
    warn: parsePositiveNumber(record.warn, `${label}.warn`),
  };
};

const parseTokenThresholds = (value: unknown): SkillTokenThresholds => {
  const record = assertRecord(value, 'tokenThresholds');
  return {
    referenceFile: parseTokenThreshold(record.referenceFile, 'tokenThresholds.referenceFile'),
    skillMd: parseTokenThreshold(record.skillMd, 'tokenThresholds.skillMd'),
    totalSkill: parseTokenThreshold(record.totalSkill, 'tokenThresholds.totalSkill'),
  };
};

const parseTargets = (value: unknown): Record<string, SkillManagementTargetConfig> => {
  const targets = assertRecord(value, 'targets');
  const parsed: Record<string, SkillManagementTargetConfig> = {};
  for (const [targetId, targetValue] of Object.entries(targets)) {
    parseTargetId(targetId);
    const target = assertRecord(targetValue, `targets.${targetId}`);
    if (typeof target.kind !== 'string' || !targetKinds.has(target.kind as SkillTargetKind)) {
      throw new Error(`targets.${targetId}.kind must be a supported target kind`);
    }
    if (typeof target.scope !== 'string' || !targetScopes.has(target.scope as SkillTargetScope)) {
      throw new Error(`targets.${targetId}.scope must be a supported target scope`);
    }
    parsed[targetId] = {
      enabled: parseBoolean(target.enabled, `targets.${targetId}.enabled`),
      kind: target.kind as SkillTargetKind,
      path: parseRequiredNonEmptyString(target.path, `targets.${targetId}.path`),
      scope: target.scope as SkillTargetScope,
    };
  }
  return parsed;
};

const parseConnectors = (value: unknown): Record<string, SkillManagementConnectorConfig> => {
  const connectors = assertRecord(value, 'connectors');
  const parsed: Record<string, SkillManagementConnectorConfig> = {};
  for (const [connectorId, connectorValue] of Object.entries(connectors)) {
    parseTargetId(connectorId);
    const connector = assertRecord(connectorValue, `connectors.${connectorId}`);
    parsed[connectorId] = {
      consumesTargets: parseStringArray(connector.consumesTargets, `connectors.${connectorId}.consumesTargets`),
      enabled: parseBoolean(connector.enabled, `connectors.${connectorId}.enabled`),
    };
    for (const targetId of parsed[connectorId].consumesTargets) {
      parseTargetId(targetId);
    }
  }
  return parsed;
};

const parseRequiredNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const parseString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
};

const createDiagnostic = (
  code: string,
  severity: SkillDiagnosticSeverity,
  message: string,
  details: Omit<SkillDiagnostic, 'code' | 'message' | 'severity'> = {},
): SkillDiagnostic => ({
  code,
  message,
  severity,
  ...details,
});

const isMissingPathError = (error: unknown) =>
  isRecord(error) && typeof error.code === 'string' && error.code === 'ENOENT';

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

const approximateTokenCount = (text: string) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return Math.ceil(trimmed.split(whitespacePattern).length * 1.35);
};

const looksBinary = (buffer: Buffer) => buffer.includes(0);

const parseScalarFrontmatterValue = (value: string): JsonValue => {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const classifyFrontmatterField = (key: string): SkillFrontmatterFieldKind => {
  if (standardFrontmatterFields.has(key)) {
    return 'standard';
  }
  if (knownFrontmatterExtensions.has(key)) {
    return 'known-extension';
  }
  return 'unknown-extension';
};

const parseFrontmatter = (text: string) => {
  if (!text.startsWith('---\n')) {
    return { fields: [] as SkillFrontmatterField[], markdown: text };
  }

  const endIndex = text.indexOf('\n---', 4);
  if (endIndex === -1) {
    return { fields: [] as SkillFrontmatterField[], markdown: text };
  }

  const frontmatter = text.slice(4, endIndex);
  const markdown = text.slice(endIndex).replace(frontmatterClosePattern, '');
  const lines = frontmatter.split(lineBreakPattern);
  const fields: SkillFrontmatterField[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0 || line.startsWith(' ')) {
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    let value: JsonValue = parseScalarFrontmatterValue(rawValue);
    if (rawValue.length === 0) {
      const arrayValue: string[] = [];
      while (lines[index + 1]?.trim().startsWith('- ')) {
        index += 1;
        const item = lines[index]?.trim().slice(2).trim();
        if (item) {
          arrayValue.push(item);
        }
      }
      value = arrayValue;
    }
    fields.push({
      key,
      kind: classifyFrontmatterField(key),
      value,
    });
  }

  return { fields, markdown };
};

const textField = (fields: readonly SkillFrontmatterField[], key: string): string | undefined => {
  const field = fields.find((entry) => entry.key === key);
  return typeof field?.value === 'string' && field.value.trim().length > 0 ? field.value : undefined;
};

const validationStatusFor = (diagnostics: readonly SkillDiagnostic[]): SkillValidationStatus => {
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === 'error' && !tokenDiagnosticCodeSet.has(diagnostic.code))
  ) {
    return 'invalid';
  }
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === 'warning' || tokenDiagnosticCodeSet.has(diagnostic.code))
  ) {
    return 'warning';
  }
  return 'valid';
};

export const parseSkillFilePath = (value: unknown, skillDirectory: string): string => {
  const relativePath = parseRequiredNonEmptyString(value, 'skill file path');
  if (path.isAbsolute(relativePath)) {
    throw new Error('skill file path must be relative');
  }
  const basePath = path.resolve(skillDirectory);
  const resolvedPath = path.resolve(basePath, relativePath);
  const pathFromBase = path.relative(basePath, resolvedPath);
  if (pathFromBase === '' || pathFromBase.startsWith('..') || path.isAbsolute(pathFromBase)) {
    throw new Error('skill file path must stay inside the selected skill directory');
  }
  return pathFromBase.split(path.sep).join('/');
};

export const parseSkillMutationInput = (value: unknown): SkillMutationInput => {
  const input = assertRecord(value, 'skill mutation input');
  const parsed: SkillMutationInput = {
    skillName: parseSkillName(input.skillName),
    targetId: parseTargetId(input.targetId),
  };
  if (input.enabled !== undefined) {
    parsed.enabled = parseBoolean(input.enabled, 'enabled');
  }
  return parsed;
};

export const parseSkillToggleInput = (value: unknown): SkillToggleInput => {
  const input = assertRecord(value, 'skill toggle input');
  return {
    enabled: parseBoolean(input.enabled, 'enabled'),
    skillName: parseSkillName(input.skillName),
  };
};

export const parseSkillTargetDirectoryInput = (value: unknown): SkillTargetDirectoryInput => {
  const input = assertRecord(value, 'skill target directory input');
  return {
    targetId: parseTargetId(input.targetId),
  };
};

export const parseSkillConfigInput = (value: unknown): SkillManagementConfig => {
  const input = assertRecord(value, 'skills config');
  const parsed: SkillManagementConfig = {};

  const sourceRepoPath = parseOptionalNonEmptyString(input.sourceRepoPath, 'sourceRepoPath');
  if (sourceRepoPath !== undefined) {
    parsed.sourceRepoPath = sourceRepoPath;
  }

  const projectsRootPath = parseOptionalNonEmptyString(input.projectsRootPath, 'projectsRootPath');
  if (projectsRootPath !== undefined) {
    parsed.projectsRootPath = projectsRootPath;
  }

  if (input.projectPaths !== undefined) {
    parsed.projectPaths = parseNonEmptyStringArray(input.projectPaths, 'projectPaths');
  }
  if (input.targets !== undefined) {
    parsed.targets = parseTargets(input.targets);
  }
  if (input.connectors !== undefined) {
    parsed.connectors = parseConnectors(input.connectors);
  }
  if (input.tokenThresholds !== undefined) {
    parsed.tokenThresholds = parseTokenThresholds(input.tokenThresholds);
  }
  if (input.ignoredTargetFindings !== undefined) {
    parsed.ignoredTargetFindings = parseStringArray(input.ignoredTargetFindings, 'ignoredTargetFindings');
  }

  return parsed;
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

export const parseSkillMarkdown = (skillName: string, text: string): ParsedSkillMarkdown => {
  const parsedSkillName = parseSkillName(skillName);
  const { fields, markdown } = parseFrontmatter(text);
  const manifestName = textField(fields, 'name');
  const description = textField(fields, 'description');
  const diagnostics: SkillDiagnostic[] = [];

  if (description === undefined) {
    diagnostics.push(
      createDiagnostic('MissingSkillDescription', 'warning', 'SKILL.md frontmatter should include description', {
        skillName: parsedSkillName,
      }),
    );
  }
  if (manifestName !== undefined && manifestName !== parsedSkillName) {
    diagnostics.push(
      createDiagnostic('SkillNameMismatch', 'error', 'SKILL.md frontmatter name does not match directory name', {
        skillName: parsedSkillName,
      }),
    );
  }
  for (const field of fields) {
    if (field.kind === 'unknown-extension') {
      diagnostics.push(
        createDiagnostic('UnknownFrontmatterField', 'warning', `Unknown SKILL.md frontmatter field: ${field.key}`, {
          skillName: parsedSkillName,
        }),
      );
    }
  }

  const manifest: SkillManifest = {
    fields,
    markdown,
  };
  if (manifestName !== undefined) {
    manifest.name = manifestName;
  }
  if (description !== undefined) {
    manifest.description = description;
  }
  return { diagnostics, manifest };
};

const maxSkillDirectoryDepth = 64;

interface CollectedSkillFiles {
  depthLimitExceeded: boolean;
  fileLimitExceeded: boolean;
  files: readonly string[];
  unsupportedPaths: readonly string[];
}

const collectSkillFiles = async (
  directory: string,
  ignoredDirectories: ReadonlySet<string>,
  maxFiles: number,
): Promise<CollectedSkillFiles> => {
  const files: string[] = [];
  const unsupportedPaths: string[] = [];
  let depthLimitExceeded = false;
  let fileLimitExceeded = false;
  let visitedEntryCount = 0;

  const visitDirectory = async (currentDirectory: string, depth: number): Promise<boolean> => {
    if (depth > maxSkillDirectoryDepth) {
      depthLimitExceeded = true;
      return true;
    }
    const directoryHandle = await opendir(currentDirectory);
    for await (const entry of directoryHandle) {
      if (visitedEntryCount >= maxFiles) {
        fileLimitExceeded = true;
        return false;
      }
      visitedEntryCount += 1;
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }
        if (!(await visitDirectory(entryPath, depth + 1))) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        unsupportedPaths.push(entryPath);
        continue;
      }
      files.push(entryPath);
    }
    return true;
  };

  await visitDirectory(directory, 0);
  return {
    depthLimitExceeded,
    fileLimitExceeded,
    files: files.toSorted((left, right) => left.localeCompare(right)),
    unsupportedPaths: unsupportedPaths.toSorted((left, right) => left.localeCompare(right)),
  };
};

type BoundedRegularFileRead =
  | { buffer: Buffer; identity: { dev: number | bigint; ino: number | bigint }; kind: 'ok' }
  | { kind: 'missing' | 'too-large' | 'unsupported' | 'unreadable' };

const readBoundedRegularFile = async (filePath: string, maxBytes: number): Promise<BoundedRegularFileRead> => {
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

const readTextForTokenCount = async (
  filePath: string,
  maxTextFileBytes: number,
  skillName: string,
): Promise<{ diagnostics: readonly SkillDiagnostic[]; text: string }> => {
  const result = await readBoundedRegularFile(filePath, maxTextFileBytes);
  if (result.kind === 'too-large') {
    return {
      diagnostics: [
        createDiagnostic('SkillFileTooLarge', 'warning', 'Skill file is too large for token counting', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  if (result.kind !== 'ok') {
    return {
      diagnostics: [
        createDiagnostic('UnreadableSkillReferenceFile', 'warning', 'Skill reference file could not be read', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  if (looksBinary(result.buffer)) {
    return {
      diagnostics: [
        createDiagnostic('BinarySkillFileSkipped', 'info', 'Binary skill file was skipped for token counting', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  return { diagnostics: [], text: result.buffer.toString('utf8') };
};

type TokenDiagnosticKind = 'markdown' | 'reference' | 'total';

const tokenDiagnosticFor = (
  kind: TokenDiagnosticKind,
  tokenCount: number,
  threshold: SkillTokenThreshold,
  details: { path: string; skillName: string },
): SkillDiagnostic | undefined => {
  const labels: Record<TokenDiagnosticKind, string> = {
    markdown: 'SKILL.md',
    reference: 'Skill reference file',
    total: 'Total skill',
  };
  const codePrefixes: Record<TokenDiagnosticKind, string> = {
    markdown: 'SkillMarkdownToken',
    reference: 'SkillReferenceToken',
    total: 'SkillTotalToken',
  };
  if (tokenCount >= threshold.high) {
    return createDiagnostic(
      `${codePrefixes[kind]}High`,
      'error',
      `${labels[kind]} token count reached the configured high threshold`,
      details,
    );
  }
  if (tokenCount >= threshold.warn) {
    return createDiagnostic(
      `${codePrefixes[kind]}Warning`,
      'warning',
      `${labels[kind]} token count reached the configured warning threshold`,
      details,
    );
  }
  return;
};

const scanOneSkill = async (
  skillDirectory: string,
  stateValue: SkillSourceState,
  options: Required<Pick<SourceSkillScanOptions, 'maxFilesPerSkill' | 'maxTextFileBytes' | 'tokenThresholds'>>,
  ignoredDirectories: ReadonlySet<string>,
  recoverMarkdownWrites: boolean,
): Promise<{ diagnostics: readonly SkillDiagnostic[]; skill?: SourceSkill }> => {
  const skillName = path.basename(skillDirectory);
  try {
    parseSkillName(skillName);
  } catch {
    return {
      diagnostics: [
        createDiagnostic('InvalidSkillDirectoryName', 'error', 'Skill directory name must be lowercase kebab-case', {
          path: skillDirectory,
        }),
      ],
    };
  }

  const skillMdPath = path.join(skillDirectory, 'SKILL.md');
  if (recoverMarkdownWrites) {
    try {
      const canonicalSkillDirectory = await realpath(skillDirectory);
      const canonicalSkillMarkdownPath = path.join(canonicalSkillDirectory, 'SKILL.md');
      const recoveryStatus = await withSerializedFileMutation(canonicalSkillMarkdownPath, () =>
        recoverSkillMarkdownWrite(recoveryPathsForMarkdown(canonicalSkillMarkdownPath)),
      );
      if (recoveryStatus === 'blocked') {
        return {
          diagnostics: [
            createDiagnostic(
              'SkillMarkdownRecoveryConflict',
              'error',
              'SKILL.md has an unresolved crash-recovery conflict',
              { path: skillMdPath, skillName },
            ),
          ],
        };
      }
    } catch {
      return {
        diagnostics: [
          createDiagnostic('UnreadableSkillMarkdown', 'error', 'SKILL.md crash recovery could not be checked', {
            path: skillMdPath,
            skillName,
          }),
        ],
      };
    }
  }

  const skillMdRead = await readBoundedRegularFile(skillMdPath, maxSkillMarkdownBytes);
  if (skillMdRead.kind === 'missing') {
    return {
      diagnostics: [
        createDiagnostic('MissingSkillMarkdown', 'error', 'Skill directory is missing SKILL.md', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }
  if (skillMdRead.kind === 'too-large') {
    return {
      diagnostics: [
        createDiagnostic('SkillMarkdownTooLarge', 'error', 'SKILL.md is too large to scan safely', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }
  if (skillMdRead.kind !== 'ok') {
    return {
      diagnostics: [
        createDiagnostic('UnreadableSkillMarkdown', 'error', 'SKILL.md must be a readable regular file', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }
  const skillMdText = skillMdRead.buffer.toString('utf8');

  const parsedMarkdown = parseSkillMarkdown(skillName, skillMdText);
  const diagnostics: SkillDiagnostic[] = [...parsedMarkdown.diagnostics];
  let collectedFiles: CollectedSkillFiles;
  try {
    collectedFiles = await collectSkillFiles(skillDirectory, ignoredDirectories, options.maxFilesPerSkill);
  } catch {
    collectedFiles = {
      depthLimitExceeded: false,
      fileLimitExceeded: false,
      files: [skillMdPath],
      unsupportedPaths: [],
    };
    diagnostics.push(
      createDiagnostic('UnreadableSkillDirectory', 'warning', 'Skill directory could not be fully scanned', {
        path: skillDirectory,
        skillName,
      }),
    );
  }

  if (collectedFiles.fileLimitExceeded) {
    diagnostics.push(
      createDiagnostic('SkillFileLimitExceeded', 'warning', 'Skill has more files than the configured scan limit', {
        path: skillDirectory,
        skillName,
      }),
    );
  }
  if (collectedFiles.depthLimitExceeded) {
    diagnostics.push(
      createDiagnostic('SkillDirectoryDepthExceeded', 'warning', 'Skill directory nesting exceeds the scan limit', {
        path: skillDirectory,
        skillName,
      }),
    );
  }
  for (const unsupportedPath of collectedFiles.unsupportedPaths) {
    diagnostics.push(
      createDiagnostic('UnsupportedSkillFile', 'warning', 'Skill scanner skipped a non-regular file', {
        path: unsupportedPath,
        skillName,
      }),
    );
  }

  let referenceTokens = 0;
  const referenceTokenDiagnostics: SkillDiagnostic[] = [];
  const referenceFiles = collectedFiles.files.filter((filePath) => path.basename(filePath) !== 'SKILL.md');
  for (const filePath of referenceFiles) {
    const textResult = await readTextForTokenCount(filePath, options.maxTextFileBytes, skillName);
    diagnostics.push(...textResult.diagnostics);
    const fileTokens = approximateTokenCount(textResult.text);
    referenceTokens += fileTokens;
    const tokenDiagnostic = tokenDiagnosticFor('reference', fileTokens, options.tokenThresholds.referenceFile, {
      path: filePath,
      skillName,
    });
    if (tokenDiagnostic !== undefined) {
      referenceTokenDiagnostics.push(tokenDiagnostic);
    }
  }

  const skillMdTokens = approximateTokenCount(skillMdText);
  const totalTokens = skillMdTokens + referenceTokens;
  const skillMdTokenDiagnostic = tokenDiagnosticFor('markdown', skillMdTokens, options.tokenThresholds.skillMd, {
    path: skillMdPath,
    skillName,
  });
  if (skillMdTokenDiagnostic !== undefined) {
    diagnostics.push(skillMdTokenDiagnostic);
  }
  diagnostics.push(...referenceTokenDiagnostics);
  const totalTokenDiagnostic = tokenDiagnosticFor('total', totalTokens, options.tokenThresholds.totalSkill, {
    path: skillDirectory,
    skillName,
  });
  if (totalTokenDiagnostic !== undefined) {
    diagnostics.push(totalTokenDiagnostic);
  }
  const skill: SourceSkill = {
    description: parsedMarkdown.manifest.description ?? '',
    diagnostics,
    enabled: stateValue.skillEnabledByName[skillName] ?? true,
    manifest: parsedMarkdown.manifest,
    name: skillName,
    path: skillDirectory,
    skillMdPath,
    tokenCount: {
      approximate: true,
      references: referenceTokens,
      skillMd: skillMdTokens,
      total: totalTokens,
    },
    validationStatus: validationStatusFor(diagnostics),
  };

  return { diagnostics, skill };
};

export const scanSkillSourceRepository = async (input: SourceSkillScanInput): Promise<SourceSkillScan> => {
  const sourceRepoPath = parseRequiredNonEmptyString(input.sourceRepoPath, 'sourceRepoPath');
  const stateResult =
    input.state === undefined ? await loadSkillSourceState(sourceRepoPath) : { diagnostics: [], state: input.state };
  const diagnostics: SkillDiagnostic[] = [...stateResult.diagnostics];
  const skillsDirectory = path.join(sourceRepoPath, 'skills');
  const ignoredDirectories = new Set([...defaultIgnoredDirectories, ...(input.options?.ignoredDirectories ?? [])]);
  const options = {
    maxFilesPerSkill: input.options?.maxFilesPerSkill ?? defaultMaxFilesPerSkill,
    maxSkills: input.options?.maxSkills ?? defaultMaxSkills,
    maxTextFileBytes: input.options?.maxTextFileBytes ?? defaultMaxTextFileBytes,
    tokenThresholds: input.options?.tokenThresholds ?? defaultTokenThresholds,
  };

  const skills: SourceSkill[] = [];
  try {
    const skillsDirectoryHandle = await opendir(skillsDirectory);
    let inspectedEntryCount = 0;
    for await (const entry of skillsDirectoryHandle) {
      if (inspectedEntryCount >= options.maxSkills) {
        diagnostics.push(
          createDiagnostic(
            'SourceSkillLimitExceeded',
            'warning',
            'Source skills directory has more entries than the configured scan limit',
            { path: skillsDirectory },
          ),
        );
        break;
      }
      inspectedEntryCount += 1;
      if (!entry.isDirectory()) {
        continue;
      }
      const result = await scanOneSkill(
        path.join(skillsDirectory, entry.name),
        stateResult.state,
        options,
        ignoredDirectories,
        true,
      );
      diagnostics.push(...result.diagnostics);
      if (result.skill) {
        skills.push(result.skill);
      }
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { diagnostics, skills: [] };
    }
    return {
      diagnostics: [
        ...diagnostics,
        createDiagnostic('UnreadableSkillsDirectory', 'error', 'Source skills directory could not be read', {
          path: skillsDirectory,
        }),
      ],
      skills: [],
    };
  }
  return { diagnostics, skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)) };
};

const invocationForFields = (fields: readonly SkillFrontmatterField[]): 'auto' | 'manual' =>
  fields.some((field) => field.key === 'disable-model-invocation' && field.value === true) ? 'manual' : 'auto';

const isPathWithin = (parentPath: string, childPath: string): boolean => {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const projectPlacementFor = async (
  entryPath: string,
  projectPath: string,
  sourceRepoPath?: string,
): Promise<{ pathForScan: string; placement: ProjectSkillPlacement }> => {
  const entryStat = await lstat(entryPath);
  if (!entryStat.isSymbolicLink()) {
    return { pathForScan: entryPath, placement: 'owned-directory' };
  }
  const resolved = path.resolve(path.dirname(entryPath), await readlink(entryPath));
  let resolvedRealPath: string;
  try {
    resolvedRealPath = await realpath(resolved);
  } catch {
    return { pathForScan: entryPath, placement: 'external-symlink' };
  }
  if (sourceRepoPath !== undefined) {
    const sourceSkillsPath = path.join(await realpath(sourceRepoPath), 'skills');
    if (isPathWithin(sourceSkillsPath, resolvedRealPath)) {
      return { pathForScan: entryPath, placement: 'symlink-to-source' };
    }
  }
  let projectRealPath: string;
  try {
    projectRealPath = await realpath(projectPath);
  } catch {
    return { pathForScan: entryPath, placement: 'external-symlink' };
  }
  return {
    pathForScan: entryPath,
    placement: isPathWithin(projectRealPath, resolvedRealPath) ? 'project-symlink' : 'external-symlink',
  };
};

export const scanProjectSkills = async (input: {
  options?: SourceSkillScanOptions;
  projectPaths: readonly string[];
  sourceRepoPath?: string;
}): Promise<readonly ProjectSkillInventory[]> => {
  const inventories: ProjectSkillInventory[] = [];
  const options = {
    maxFilesPerSkill: input.options?.maxFilesPerSkill ?? defaultMaxFilesPerSkill,
    maxRuntimeEntries: input.options?.maxRuntimeEntries ?? defaultMaxRuntimeEntries,
    maxTextFileBytes: input.options?.maxTextFileBytes ?? defaultMaxTextFileBytes,
    tokenThresholds: input.options?.tokenThresholds ?? defaultTokenThresholds,
  };
  const ignoredDirectories = new Set([...defaultIgnoredDirectories, ...(input.options?.ignoredDirectories ?? [])]);
  const state: SkillSourceState = { version: 1, skillEnabledByName: {} };

  for (const projectPath of input.projectPaths) {
    const diagnostics: SkillDiagnostic[] = [];
    const observations: ProjectSkillObservation[] = [];
    let projectRealPath: string;
    try {
      projectRealPath = await realpath(projectPath);
    } catch {
      inventories.push({ diagnostics, observations, projectPath });
      continue;
    }
    for (const directory of projectSkillDirectories) {
      const runtimePath = path.join(projectPath, directory.relativePath);
      try {
        const runtimeRealPath = await realpath(runtimePath);
        if (!isPathWithin(projectRealPath, runtimeRealPath)) {
          diagnostics.push(
            createDiagnostic(
              'ExternalProjectSkillDirectoryNotScanned',
              'warning',
              'External project skill directory symlink was classified without reading its content',
              { path: runtimePath, targetId: directory.id },
            ),
          );
          continue;
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          diagnostics.push(
            createDiagnostic(
              'UnreadableProjectSkillDirectory',
              'warning',
              'Project skill directory could not be inspected',
              { path: runtimePath, targetId: directory.id },
            ),
          );
        }
        continue;
      }
      let runtimeDirectoryHandle: Awaited<ReturnType<typeof opendir>>;
      try {
        runtimeDirectoryHandle = await opendir(runtimePath);
      } catch (error) {
        if (!isMissingPathError(error)) {
          diagnostics.push(
            createDiagnostic(
              'UnreadableProjectSkillDirectory',
              'warning',
              'Project skill directory could not be read',
              {
                path: runtimePath,
                targetId: directory.id,
              },
            ),
          );
        }
        continue;
      }
      let inspectedRuntimeEntryCount = 0;
      for await (const entry of runtimeDirectoryHandle) {
        if (inspectedRuntimeEntryCount >= options.maxRuntimeEntries) {
          diagnostics.push(
            createDiagnostic(
              'ProjectSkillEntryLimitExceeded',
              'warning',
              'Project skill runtime has more entries than the configured scan limit',
              { path: runtimePath, targetId: directory.id },
            ),
          );
          break;
        }
        inspectedRuntimeEntryCount += 1;
        if (!(entry.isDirectory() || entry.isSymbolicLink())) {
          continue;
        }
        const entryPath = path.join(runtimePath, entry.name);
        let placement: ProjectSkillPlacement;
        let pathForScan: string;
        try {
          ({ pathForScan, placement } = await projectPlacementFor(entryPath, projectPath, input.sourceRepoPath));
        } catch {
          diagnostics.push(
            createDiagnostic('UnreadableProjectSkillEntry', 'warning', 'Project skill entry could not be inspected', {
              path: entryPath,
              targetId: directory.id,
            }),
          );
          continue;
        }
        if (placement === 'external-symlink') {
          try {
            parseSkillName(entry.name);
          } catch {
            diagnostics.push(
              createDiagnostic(
                'InvalidSkillDirectoryName',
                'error',
                'Skill directory name must be lowercase kebab-case',
                { path: entryPath },
              ),
            );
            continue;
          }
          const externalDiagnostic = createDiagnostic(
            'ExternalProjectSkillNotScanned',
            'warning',
            'External project skill symlink was classified without reading its content',
            { path: entryPath, skillName: entry.name, targetId: directory.id },
          );
          diagnostics.push(externalDiagnostic);
          observations.push({
            description: '',
            diagnostics: [externalDiagnostic],
            invocation: 'auto',
            markdownReadable: false,
            name: entry.name,
            path: entryPath,
            placement,
            runtimeDirId: directory.id,
            skillMdPath: path.join(entryPath, 'SKILL.md'),
            validationStatus: 'warning',
          });
          continue;
        }
        const result = await scanOneSkill(pathForScan, state, options, ignoredDirectories, false);
        diagnostics.push(...result.diagnostics);
        if (result.skill === undefined) {
          continue;
        }
        observations.push({
          description: result.skill.description,
          diagnostics: result.skill.diagnostics,
          invocation: invocationForFields(result.skill.manifest.fields),
          markdownReadable: true,
          name: result.skill.name,
          path: result.skill.path,
          placement,
          runtimeDirId: directory.id,
          skillMdPath: result.skill.skillMdPath,
          tokenCount: result.skill.tokenCount,
          validationStatus: result.skill.validationStatus,
        });
      }
    }
    const runtimeOrder = new Map(projectSkillDirectories.map((directory, index) => [directory.id, index]));
    inventories.push({
      diagnostics,
      observations: observations.toSorted((left, right) => {
        const runtimeDifference =
          (runtimeOrder.get(left.runtimeDirId) ?? 0) - (runtimeOrder.get(right.runtimeDirId) ?? 0);
        return runtimeDifference === 0 ? left.name.localeCompare(right.name) : runtimeDifference;
      }),
      projectPath,
    });
  }
  return inventories;
};

export const buildDefaultSkillTargets = (homePath: string): readonly SkillTarget[] => [
  {
    enabled: true,
    id: 'standard-agents',
    kind: 'standard-interop',
    label: 'Standard Agents',
    missing: false,
    observed: true,
    path: path.join(homePath, '.agents', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'claude-code',
    kind: 'standard-interop',
    label: 'Claude Code',
    missing: false,
    observed: true,
    path: path.join(homePath, '.claude', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'codex',
    kind: 'standard-interop',
    label: 'Codex',
    missing: false,
    observed: true,
    path: path.join(homePath, '.codex', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'opencode',
    kind: 'standard-interop',
    label: 'OpenCode',
    missing: false,
    observed: true,
    path: path.join(homePath, '.config', 'opencode', 'skills'),
    scope: 'system',
  },
  {
    enabled: false,
    id: 'github-copilot',
    kind: 'standard-interop',
    label: 'GitHub Copilot',
    missing: false,
    observed: false,
    path: path.join(homePath, '.config', 'github-copilot', 'skills'),
    scope: 'system',
  },
  {
    enabled: false,
    id: 'cursor',
    kind: 'standard-interop',
    label: 'Cursor',
    missing: false,
    observed: false,
    path: path.join(homePath, '.cursor', 'skills'),
    scope: 'system',
  },
];

const projectionFor = (
  skillName: string,
  targetId: string,
  expectedPath: string,
  stateValue: ProjectionState,
  options: {
    actualPath?: string;
    diagnostics?: readonly SkillDiagnostic[];
  } = {},
): Projection => {
  const projection: Projection = {
    diagnostics: options.diagnostics ?? [],
    expectedPath,
    skillName,
    state: stateValue,
    targetId,
  };
  if (options.actualPath !== undefined) {
    projection.actualPath = options.actualPath;
  }
  return projection;
};

const classifyProjectedSkill = async (skill: SourceSkill, target: SkillTarget): Promise<Projection> => {
  const expectedPath = path.join(target.path, skill.name);
  if (target.missing) {
    return projectionFor(skill.name, target.id, expectedPath, 'missing-target', {
      diagnostics: [
        createDiagnostic('MissingTarget', 'warning', 'Target directory is missing', {
          path: target.path,
          skillName: skill.name,
          targetId: target.id,
        }),
      ],
    });
  }

  let entryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    entryStat = await lstat(expectedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return projectionFor(skill.name, target.id, expectedPath, 'missing');
    }
    return projectionFor(skill.name, target.id, expectedPath, 'missing-target', {
      diagnostics: [
        createDiagnostic('UnreadableTargetEntry', 'warning', 'Target entry could not be inspected', {
          path: expectedPath,
          skillName: skill.name,
          targetId: target.id,
        }),
      ],
    });
  }

  if (entryStat.isSymbolicLink()) {
    const linkTarget = await readlink(expectedPath);
    const actualPath = path.resolve(path.dirname(expectedPath), linkTarget);
    try {
      await stat(actualPath);
    } catch {
      return projectionFor(skill.name, target.id, expectedPath, 'broken-link', { actualPath });
    }
    if (path.resolve(skill.path) === actualPath) {
      return projectionFor(skill.name, target.id, expectedPath, skill.enabled ? 'linked' : 'disabled-exposed', {
        actualPath,
      });
    }
    return projectionFor(skill.name, target.id, expectedPath, 'wrong-target', { actualPath });
  }

  return projectionFor(skill.name, target.id, expectedPath, skill.enabled ? 'unmanaged-copy' : 'disabled-exposed', {
    actualPath: expectedPath,
  });
};

const scanUnmanagedTargetEntries = async (
  target: SkillTarget,
  managedSkillNames: ReadonlySet<string>,
): Promise<readonly Projection[]> => {
  let entries: Array<{
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
    name: string;
  }>;
  try {
    entries = await readdir(target.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const projections: Projection[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (managedSkillNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(target.path, entry.name);
    if (entry.isSymbolicLink()) {
      projections.push(projectionFor(entry.name, target.id, entryPath, 'unmanaged-symlink', { actualPath: entryPath }));
      continue;
    }
    if (entry.isDirectory() || entry.isFile()) {
      projections.push(projectionFor(entry.name, target.id, entryPath, 'unmanaged-copy', { actualPath: entryPath }));
    }
  }
  return projections;
};

export const scanTargetProjections = async (input: TargetProjectionScanInput): Promise<TargetProjectionScan> => {
  const projections: Projection[] = [];
  const unmanagedEntries: Projection[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const managedSkillNames = new Set(input.skills.map((skill) => skill.name));

  for (const target of input.targets) {
    let targetMissing = target.missing;
    try {
      const targetStat = await lstat(target.path);
      targetMissing = !targetStat.isDirectory();
    } catch (error) {
      if (isMissingPathError(error)) {
        targetMissing = true;
      } else {
        diagnostics.push(
          createDiagnostic('UnreadableTarget', 'warning', 'Target directory could not be inspected', {
            path: target.path,
            targetId: target.id,
          }),
        );
        targetMissing = true;
      }
    }
    const observedTarget: SkillTarget = { ...target, missing: targetMissing, observed: !targetMissing };
    for (const skill of input.skills) {
      projections.push(await classifyProjectedSkill(skill, observedTarget));
    }
    if (!targetMissing) {
      unmanagedEntries.push(...(await scanUnmanagedTargetEntries(observedTarget, managedSkillNames)));
    }
  }

  diagnostics.push(...projections.flatMap((projection) => projection.diagnostics));
  return { diagnostics, projections, unmanagedEntries };
};

export const isProjectionHealthy = (projection: Projection | undefined): boolean => projection?.state === 'linked';

export const planProjection = (
  skill: SourceSkill,
  target: SkillTarget,
  projection: Projection | undefined,
): ProjectionAction => {
  const expectedPath = projection?.expectedPath ?? path.join(target.path, skill.name);
  if (projection === undefined) {
    return {
      path: expectedPath,
      reason: 'projection is unavailable',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (!skill.enabled) {
    if (
      projection.state === 'linked' ||
      (projection.state === 'disabled-exposed' && projection.actualPath === skill.path)
    ) {
      return {
        observedSourcePath: projection.actualPath ?? skill.path,
        path: projection.expectedPath,
        skillName: skill.name,
        sourcePath: skill.path,
        targetId: target.id,
        type: 'unlink-managed-symlink',
      };
    }
    if (projection.state === 'disabled-exposed') {
      return {
        path: projection.expectedPath,
        reason: 'disabled skill remains exposed by unmanaged content',
        skillName: skill.name,
        targetId: target.id,
        type: 'refuse-unmanaged-mutation',
      };
    }
    return {
      path: projection.expectedPath,
      reason: 'disabled skill has no managed symlink to remove',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  // Warning-status skills (heavy tokens, unknown frontmatter fields…) stay
  // projectable; only structurally invalid skills are refused.
  if (skill.validationStatus === 'invalid') {
    return {
      path: projection.expectedPath,
      reason: 'invalid skills cannot be projected',
      skillName: skill.name,
      targetId: target.id,
      type: 'refuse-unmanaged-mutation',
    };
  }

  if (!target.enabled) {
    return {
      path: projection.expectedPath,
      reason: 'target is disabled',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (projection.state === 'missing') {
    return {
      path: projection.expectedPath,
      skillName: skill.name,
      sourcePath: skill.path,
      targetId: target.id,
      type: 'create-symlink',
    };
  }

  if (projection.state === 'broken-link' || projection.state === 'wrong-target') {
    if (projection.actualPath === undefined) {
      return {
        path: projection.expectedPath,
        reason: 'observed symlink target is unavailable',
        skillName: skill.name,
        targetId: target.id,
        type: 'refuse-unmanaged-mutation',
      };
    }
    return {
      observedSourcePath: projection.actualPath,
      path: projection.expectedPath,
      skillName: skill.name,
      sourcePath: skill.path,
      targetId: target.id,
      type: 'repair-symlink',
    };
  }

  if (projection.state === 'linked') {
    return {
      path: projection.expectedPath,
      reason: 'already linked',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  return {
    path: projection.expectedPath,
    reason: `refusing to mutate ${projection.state}`,
    skillName: skill.name,
    targetId: target.id,
    type: 'refuse-unmanaged-mutation',
  };
};

const assertObservedProjectionUnchanged = async (projectionPath: string, observedSourcePath: string): Promise<void> => {
  const projectionStat = await lstat(projectionPath);
  if (!projectionStat.isSymbolicLink()) {
    throw new Error('Refusing to mutate a projection that changed after observation');
  }
  const actualSourcePath = path.resolve(path.dirname(projectionPath), await readlink(projectionPath));
  if (actualSourcePath !== path.resolve(observedSourcePath)) {
    throw new Error('Refusing to mutate a projection that changed after observation');
  }
};

const restoreClaimedProjection = async (claimedPath: string, projectedPath: string): Promise<void> => {
  try {
    await lstat(projectedPath);
    throw new Error(`Refusing to overwrite an interloper; claimed projection retained at ${claimedPath}`);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  const claimedStat = await lstat(claimedPath);
  if (claimedStat.isSymbolicLink()) {
    await symlink(await readlink(claimedPath), projectedPath);
    await unlink(claimedPath);
    return;
  }
  if (claimedStat.isFile()) {
    await link(claimedPath, projectedPath);
    await unlink(claimedPath);
    return;
  }
  if (claimedStat.isDirectory()) {
    await rename(claimedPath, projectedPath);
    return;
  }
  throw new Error(`Unsupported claimed projection retained at ${claimedPath}`);
};

const claimObservedProjection = async (projectedPath: string, observedSourcePath: string): Promise<string> => {
  await assertObservedProjectionUnchanged(projectedPath, observedSourcePath);
  const claimedPath = path.join(path.dirname(projectedPath), `.${path.basename(projectedPath)}.${randomUUID()}.old`);
  await rename(projectedPath, claimedPath);
  try {
    await assertObservedProjectionUnchanged(claimedPath, observedSourcePath);
    // Yield once so competing filesystem actors can become visible before the exclusive install.
    await delay(5);
    return claimedPath;
  } catch (error) {
    await restoreClaimedProjection(claimedPath, projectedPath);
    throw error;
  }
};

export const applyProjectionAction = async (action: ProjectionAction): Promise<void> => {
  if (action.type === 'noop' || action.type === 'refuse-unmanaged-mutation') {
    return;
  }

  if (action.type === 'create-symlink') {
    await mkdir(path.dirname(action.path), { recursive: true });
    await symlink(action.sourcePath, action.path);
    return;
  }

  if (action.type === 'repair-symlink') {
    const claimedPath = await claimObservedProjection(action.path, action.observedSourcePath);
    try {
      await symlink(action.sourcePath, action.path);
    } catch (error) {
      await restoreClaimedProjection(claimedPath, action.path);
      throw error;
    }
    await unlink(claimedPath);
    return;
  }

  if (action.type === 'unlink-managed-symlink') {
    const claimedPath = await claimObservedProjection(action.path, action.observedSourcePath);
    try {
      await unlink(claimedPath);
    } catch (error) {
      await restoreClaimedProjection(claimedPath, action.path);
      throw error;
    }
  }
};

const emptySkillManagementSnapshot = (
  config: SkillManagementConfig,
  diagnostics: readonly SkillDiagnostic[] = [],
): SkillManagementSnapshot => ({
  config,
  configured: false,
  diagnostics,
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { version: 1, skillEnabledByName: {} },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: diagnostics.length,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
});

const targetLabelFor = (targetId: string): string =>
  targetId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

const buildConfiguredSkillTargets = (config: SkillManagementConfig, homePath: string): readonly SkillTarget[] => {
  const configuredTargets = config.targets;
  if (configuredTargets === undefined) {
    return buildDefaultSkillTargets(homePath);
  }
  return Object.entries(configuredTargets).map(([targetId, targetConfig]) => ({
    enabled: targetConfig.enabled,
    id: targetId,
    kind: targetConfig.kind,
    label: targetLabelFor(targetId),
    missing: false,
    observed: false,
    path: targetConfig.path,
    scope: targetConfig.scope,
  }));
};

const observeSkillTargets = async (targets: readonly SkillTarget[]): Promise<readonly SkillTarget[]> => {
  const observedTargets: SkillTarget[] = [];
  for (const target of targets) {
    try {
      const targetStat = await lstat(target.path);
      const isDirectory = targetStat.isDirectory();
      observedTargets.push({
        ...target,
        missing: !isDirectory,
        observed: isDirectory,
      });
    } catch (error) {
      observedTargets.push({
        ...target,
        missing: isMissingPathError(error) ? true : target.missing,
        observed: false,
      });
    }
  }
  return observedTargets;
};

const snapshotSummary = (
  skills: readonly SourceSkill[],
  targets: readonly SkillTarget[],
  projections: readonly Projection[],
  unmanagedEntries: readonly Projection[],
  diagnostics: readonly SkillDiagnostic[],
): SkillManagementSnapshotSummary => {
  const healthyProjectionCount = projections.filter(isProjectionHealthy).length;
  return {
    activeSkillCount: skills.filter((skill) => skill.enabled).length,
    diagnosticCount: diagnostics.length,
    healthyProjectionCount,
    skillCount: skills.length,
    targetCount: targets.length,
    unhealthyProjectionCount: projections.length - healthyProjectionCount,
    unmanagedEntryCount: unmanagedEntries.length,
  };
};

export const loadSkillManagementSnapshot = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillManagementSnapshot> => {
  const config = input.config.skills === undefined ? {} : parseSkillConfigInput(input.config.skills);
  if (config.sourceRepoPath === undefined) {
    return emptySkillManagementSnapshot(config);
  }

  const sourceState = await loadSkillSourceState(config.sourceRepoPath);
  const sourceScanOptions: SourceSkillScanOptions = {};
  if (config.tokenThresholds !== undefined) {
    sourceScanOptions.tokenThresholds = config.tokenThresholds;
  }
  const sourceScan = await scanSkillSourceRepository({
    options: sourceScanOptions,
    sourceRepoPath: config.sourceRepoPath,
    state: sourceState.state,
  });
  const targets = await observeSkillTargets(buildConfiguredSkillTargets(config, input.homePath));
  const projectionScan = await scanTargetProjections({ skills: sourceScan.skills, targets });
  const diagnostics = [...sourceState.diagnostics, ...sourceScan.diagnostics, ...projectionScan.diagnostics];

  return {
    config,
    configured: true,
    diagnostics,
    nativeRuleFindings: [],
    projections: projectionScan.projections,
    skills: sourceScan.skills,
    sourceState: sourceState.state,
    summary: snapshotSummary(
      sourceScan.skills,
      targets,
      projectionScan.projections,
      projectionScan.unmanagedEntries,
      diagnostics,
    ),
    targets,
    unmanagedEntries: projectionScan.unmanagedEntries,
  };
};

export const writeSkillManagementConfig = async (
  input: WriteSkillManagementConfigInput,
): Promise<SkillManagementConfigDocument> => {
  const skills = parseSkillConfigInput(input.skills);
  const nextConfig: SkillManagementConfigDocument = {
    ...input.config,
    skills,
  };
  await input.writeConfig(nextConfig);
  return nextConfig;
};

export const toggleSkillEnabled = async (input: ToggleSkillEnabledInput): Promise<SkillSourceState> =>
  setSkillEnabled(input.sourceRepoPath, input.skillName, input.enabled);

const activeSkillPredicate = (skill: SourceSkill): boolean => skill.enabled && skill.validationStatus !== 'invalid';

const planReconcileActions = (
  snapshot: SkillManagementSnapshot,
  predicate: (skill: SourceSkill) => boolean,
): ProjectionAction[] => {
  const actions: ProjectionAction[] = [];
  for (const skill of snapshot.skills.filter(predicate)) {
    for (const target of snapshot.targets.filter((candidate) => candidate.enabled)) {
      const projection = snapshot.projections.find(
        (candidate) => candidate.skillName === skill.name && candidate.targetId === target.id,
      );
      const action = planProjection(skill, target, projection);
      if (action.type !== 'noop') {
        actions.push(action);
      }
    }
  }
  return actions;
};

const applyPlannedActions = async (
  snapshot: SkillManagementSnapshot,
  predicate: (skill: SourceSkill) => boolean,
): Promise<SkillReconcileResult> => {
  const actions = planReconcileActions(snapshot, predicate);
  for (const action of actions) {
    if (
      action.type === 'create-symlink' ||
      action.type === 'repair-symlink' ||
      action.type === 'unlink-managed-symlink'
    ) {
      await applyProjectionAction(action);
    }
  }
  return { actions, snapshot };
};

export const reconcileSkill = async (input: ReconcileSkillInput): Promise<SkillReconcileResult> => {
  const skillName = parseSkillName(input.skillName);
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(snapshot, (skill) => skill.name === skillName);
};

export const reconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(snapshot, activeSkillPredicate);
};

export const previewReconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  return { actions: planReconcileActions(snapshot, activeSkillPredicate), snapshot };
};

export const createSkillTargetDirectory = async (input: CreateSkillTargetDirectoryInput): Promise<void> => {
  const targetPath = parseRequiredNonEmptyString(input.path, 'target path');
  await mkdir(targetPath, { recursive: true });
};

const sha256 = (buffer: Buffer | string): string => createHash('sha256').update(buffer).digest('hex');

const skillMarkdownPathFor = (sourceRepoPath: string, skillName: string): string =>
  path.join(sourceRepoPath, 'skills', parseSkillName(skillName), 'SKILL.md');

const isInsideDirectory = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative === '' || !(relative.startsWith('..') || path.isAbsolute(relative));
};

interface SkillMarkdownLocation {
  filePath: string;
  markdownPath: string;
}

const resolveSkillMarkdownLocation = async (
  sourceRepoPath: string,
  skillName: string,
): Promise<SkillMarkdownLocation | undefined> => {
  const filePath = skillMarkdownPathFor(sourceRepoPath, skillName);
  try {
    const realSourcePath = await realpath(sourceRepoPath);
    const realSkillsPath = await realpath(path.join(realSourcePath, 'skills'));
    const realSkillPath = await realpath(path.join(realSkillsPath, skillName));
    if (!(isInsideDirectory(realSourcePath, realSkillsPath) && isInsideDirectory(realSkillsPath, realSkillPath))) {
      return;
    }
    return { filePath, markdownPath: path.join(realSkillPath, 'SKILL.md') };
  } catch {
    return;
  }
};

export const readSkillMarkdown = async (input: {
  skillName: string;
  sourceRepoPath: string;
}): Promise<SkillMarkdownDocument> => {
  const skillName = parseSkillName(input.skillName);
  const location = await resolveSkillMarkdownLocation(input.sourceRepoPath, skillName);
  if (location === undefined) {
    throw new Error('skill markdown not found');
  }
  return await withSerializedFileMutation(location.markdownPath, async () => {
    const recoveryPaths = recoveryPathsForMarkdown(location.markdownPath);
    if ((await recoverSkillMarkdownWrite(recoveryPaths)) === 'blocked') {
      throw new Error('skill markdown has an unresolved recovery conflict');
    }
    const fileRead = await readBoundedRegularFile(location.markdownPath, maxSkillMarkdownBytes);
    if (fileRead.kind === 'too-large') {
      throw new Error('skill markdown is too large');
    }
    if (fileRead.kind !== 'ok') {
      throw new Error('skill markdown not found');
    }
    return {
      content: fileRead.buffer.toString('utf8'),
      path: location.filePath,
      sha256: sha256(fileRead.buffer),
      skillName,
    };
  });
};

const sha256Pattern = /^[a-f0-9]{64}$/;

export const parseSkillMarkdownWriteInput = (input: unknown): SkillMarkdownWriteInput => {
  const record = assertRecord(input, 'skill markdown write input');
  const content = parseString(record.content, 'content');
  if (Buffer.byteLength(content, 'utf8') > maxSkillMarkdownBytes) {
    throw new Error('content must be at most 262144 bytes');
  }
  const baseSha256 = parseRequiredNonEmptyString(record.baseSha256, 'baseSha256');
  if (!sha256Pattern.test(baseSha256)) {
    throw new Error('baseSha256 must be a 64-character lowercase hex string');
  }
  return {
    baseSha256,
    content,
    skillName: parseSkillName(record.skillName),
  };
};

const linkClaimedMarkdownNoClobber = async (claimedPath: string, markdownPath: string): Promise<boolean> => {
  try {
    await link(claimedPath, markdownPath);
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  return true;
};

type SkillMarkdownWriteResult = { ok: true } | { ok: false; reason: 'conflict' | 'not-found' | 'too-large' };

interface SkillMarkdownWriteJournal {
  baseSha256: string;
  newSha256: string;
  operationId: string;
  phase: 'claimed' | 'prepared' | 'published';
  tempName: string;
  version: 1;
}

interface SkillMarkdownRecoveryPaths {
  claimPath: string;
  journalPath: string;
  markdownPath: string;
}

const skillMarkdownJournalMaxBytes = 4096;
const skillMarkdownTempNamePattern = /^\.SKILL\.md\.ai-usage\.[a-z0-9-]+\.tmp$/;

const recoveryPathsForMarkdown = (markdownPath: string): SkillMarkdownRecoveryPaths => ({
  claimPath: path.join(path.dirname(markdownPath), '.SKILL.md.ai-usage.claim'),
  journalPath: path.join(path.dirname(markdownPath), '.SKILL.md.ai-usage.journal.json'),
  markdownPath,
});

const parseSkillMarkdownWriteJournal = (value: unknown): SkillMarkdownWriteJournal | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.baseSha256 !== 'string' ||
    !sha256Pattern.test(value.baseSha256) ||
    typeof value.newSha256 !== 'string' ||
    !sha256Pattern.test(value.newSha256) ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    (value.phase !== 'prepared' && value.phase !== 'claimed' && value.phase !== 'published') ||
    typeof value.tempName !== 'string' ||
    !skillMarkdownTempNamePattern.test(value.tempName)
  ) {
    return;
  }
  if (value.tempName !== `.SKILL.md.ai-usage.${value.operationId}.tmp`) {
    return;
  }
  return value as unknown as SkillMarkdownWriteJournal;
};

type SkillMarkdownJournalRead =
  | { kind: 'invalid' }
  | { kind: 'missing' }
  | {
      identity: { dev: number | bigint; ino: number | bigint };
      journal: SkillMarkdownWriteJournal;
      kind: 'ok';
    };

type RecoveryArtifactValidation =
  | { kind: 'invalid' }
  | { kind: 'missing' }
  | { identity: { dev: number | bigint; ino: number | bigint }; kind: 'valid' };

const readSkillMarkdownWriteJournal = async (journalPath: string): Promise<SkillMarkdownJournalRead> => {
  const journalRead = await readBoundedRegularFile(journalPath, skillMarkdownJournalMaxBytes);
  if (journalRead.kind === 'missing') {
    return { kind: 'missing' };
  }
  if (journalRead.kind !== 'ok') {
    return { kind: 'invalid' };
  }
  try {
    const journal = parseSkillMarkdownWriteJournal(JSON.parse(journalRead.buffer.toString('utf8')) as unknown);
    return journal === undefined ? { kind: 'invalid' } : { identity: journalRead.identity, journal, kind: 'ok' };
  } catch {
    return { kind: 'invalid' };
  }
};

const writeSkillMarkdownJournal = async (journalPath: string, journal: SkillMarkdownWriteJournal): Promise<void> =>
  atomicWriteFile(journalPath, `${JSON.stringify(journal)}\n`);

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const validateRecoveryArtifact = async (
  artifactPath: string,
  expectedSha256: string,
): Promise<RecoveryArtifactValidation> => {
  const artifactRead = await readBoundedRegularFile(artifactPath, maxSkillMarkdownBytes);
  if (artifactRead.kind === 'missing') {
    return { kind: 'missing' };
  }
  if (artifactRead.kind !== 'ok' || sha256(artifactRead.buffer) !== expectedSha256) {
    return { kind: 'invalid' };
  }
  return { identity: artifactRead.identity, kind: 'valid' };
};

const removeArtifactWithIdentity = async (
  artifactPath: string,
  identity: { dev: number | bigint; ino: number | bigint },
): Promise<boolean> => {
  try {
    const artifactStat = await lstat(artifactPath);
    if (!sameFileIdentity(artifactStat, identity)) {
      return false;
    }
    await unlink(artifactPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const journalsEqual = (left: SkillMarkdownWriteJournal, right: SkillMarkdownWriteJournal): boolean =>
  left.baseSha256 === right.baseSha256 &&
  left.newSha256 === right.newSha256 &&
  left.operationId === right.operationId &&
  left.phase === right.phase &&
  left.tempName === right.tempName &&
  left.version === right.version;

const cleanupValidatedSkillMarkdownJournal = async (
  paths: SkillMarkdownRecoveryPaths,
  journal: SkillMarkdownWriteJournal,
  expected?: {
    journalIdentity: { dev: number | bigint; ino: number | bigint };
    tempValidation: RecoveryArtifactValidation;
  },
): Promise<boolean> => {
  const temporaryPath = path.join(path.dirname(paths.markdownPath), journal.tempName);
  const tempValidation = await validateRecoveryArtifact(temporaryPath, journal.newSha256);
  if (tempValidation.kind === 'invalid') {
    return false;
  }
  const journalRead = await readSkillMarkdownWriteJournal(paths.journalPath);
  if (journalRead.kind !== 'ok' || !journalsEqual(journalRead.journal, journal)) {
    return false;
  }
  if (expected !== undefined) {
    if (!sameFileIdentity(journalRead.identity, expected.journalIdentity)) {
      return false;
    }
    if (expected.tempValidation.kind !== tempValidation.kind) {
      return false;
    }
    if (
      expected.tempValidation.kind === 'valid' &&
      tempValidation.kind === 'valid' &&
      !sameFileIdentity(expected.tempValidation.identity, tempValidation.identity)
    ) {
      return false;
    }
  }
  if (tempValidation.kind === 'valid' && !(await removeArtifactWithIdentity(temporaryPath, tempValidation.identity))) {
    return false;
  }
  return await removeArtifactWithIdentity(paths.journalPath, journalRead.identity);
};

const journalReadIsUnchanged = async (
  journalPath: string,
  expected: Extract<SkillMarkdownJournalRead, { kind: 'ok' }>,
): Promise<boolean> => {
  const current = await readSkillMarkdownWriteJournal(journalPath);
  return (
    current.kind === 'ok' &&
    sameFileIdentity(current.identity, expected.identity) &&
    journalsEqual(current.journal, expected.journal)
  );
};

const recoverSkillMarkdownWrite = async (paths: SkillMarkdownRecoveryPaths): Promise<'blocked' | 'ready'> => {
  const journalRead = await readSkillMarkdownWriteJournal(paths.journalPath);
  if (journalRead.kind === 'invalid') {
    return 'blocked';
  }
  if (journalRead.kind === 'missing') {
    const claimRead = await readBoundedRegularFile(paths.claimPath, maxSkillMarkdownBytes);
    if (claimRead.kind === 'missing') {
      return 'ready';
    }
    const markdownRead = await readBoundedRegularFile(paths.markdownPath, maxSkillMarkdownBytes);
    if (
      claimRead.kind !== 'ok' ||
      markdownRead.kind !== 'ok' ||
      !sameFileIdentity(claimRead.identity, markdownRead.identity)
    ) {
      return 'blocked';
    }
    const currentMarkdownStat = await lstat(paths.markdownPath);
    if (!sameFileIdentity(currentMarkdownStat, markdownRead.identity)) {
      return 'blocked';
    }
    return (await removeArtifactWithIdentity(paths.claimPath, claimRead.identity)) ? 'ready' : 'blocked';
  }
  const { journal } = journalRead;
  const tempValidation = await validateRecoveryArtifact(
    path.join(path.dirname(paths.markdownPath), journal.tempName),
    journal.newSha256,
  );
  if (tempValidation.kind === 'invalid') {
    return 'blocked';
  }
  // The writer persists prepared -> claims Markdown -> persists claimed -> creates temp.
  // Therefore any prepared journal accompanied by a temp is not an ai-usage state.
  if (journal.phase === 'prepared' && tempValidation.kind !== 'missing') {
    return 'blocked';
  }
  const cleanupExpected = { journalIdentity: journalRead.identity, tempValidation };
  const claimValidation = await validateRecoveryArtifact(paths.claimPath, journal.baseSha256);
  if (claimValidation.kind === 'invalid') {
    return 'blocked';
  }
  const markdownRead = await readBoundedRegularFile(paths.markdownPath, maxSkillMarkdownBytes);
  if (claimValidation.kind === 'missing') {
    if (markdownRead.kind !== 'ok') {
      return 'blocked';
    }
    const markdownSha = sha256(markdownRead.buffer);
    const isPreparedRollback =
      journal.phase === 'prepared' && tempValidation.kind === 'missing' && markdownSha === journal.baseSha256;
    const isLaterPublication =
      journal.phase !== 'prepared' &&
      markdownSha === journal.newSha256 &&
      (tempValidation.kind === 'missing' || sameFileIdentity(tempValidation.identity, markdownRead.identity));
    if (!(isPreparedRollback || isLaterPublication)) {
      return 'blocked';
    }
    return (await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected)) ? 'ready' : 'blocked';
  }
  if (markdownRead.kind === 'missing') {
    const currentClaimStat = await lstat(paths.claimPath);
    if (
      !(
        sameFileIdentity(currentClaimStat, claimValidation.identity) &&
        (await journalReadIsUnchanged(paths.journalPath, journalRead))
      )
    ) {
      return 'blocked';
    }
    const restored = await linkClaimedMarkdownNoClobber(paths.claimPath, paths.markdownPath);
    if (!(restored && (await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected)))) {
      return 'blocked';
    }
    return (await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity)) ? 'ready' : 'blocked';
  }
  if (markdownRead.kind !== 'ok') {
    return 'blocked';
  }
  const markdownSha = sha256(markdownRead.buffer);
  const isPublished =
    journal.phase !== 'prepared' &&
    markdownSha === journal.newSha256 &&
    tempValidation.kind === 'valid' &&
    sameFileIdentity(tempValidation.identity, markdownRead.identity);
  const isRollback =
    markdownSha === journal.baseSha256 && sameFileIdentity(markdownRead.identity, claimValidation.identity);
  if (!(isPublished || isRollback)) {
    return 'blocked';
  }
  if (!(await journalReadIsUnchanged(paths.journalPath, journalRead))) {
    return 'blocked';
  }
  if (isRollback) {
    if (!(await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected))) {
      return 'blocked';
    }
    return (await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity)) ? 'ready' : 'blocked';
  }
  if (!(await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity))) {
    return 'blocked';
  }
  return (await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected)) ? 'ready' : 'blocked';
};

const claimSkillMarkdown = async (paths: SkillMarkdownRecoveryPaths): Promise<boolean> => {
  if (await pathExists(paths.claimPath)) {
    return false;
  }
  try {
    await rename(paths.markdownPath, paths.claimPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const restoreClaimAndCleanupJournal = async (
  paths: SkillMarkdownRecoveryPaths,
  journal: SkillMarkdownWriteJournal,
  reason: 'conflict' | 'not-found' | 'too-large',
): Promise<SkillMarkdownWriteResult> => {
  const journalRead = await readSkillMarkdownWriteJournal(paths.journalPath);
  const tempValidation = await validateRecoveryArtifact(
    path.join(path.dirname(paths.markdownPath), journal.tempName),
    journal.newSha256,
  );
  if (journalRead.kind !== 'ok' || !journalsEqual(journalRead.journal, journal) || tempValidation.kind === 'invalid') {
    return { ok: false, reason: 'conflict' };
  }
  const claimValidation = await validateRecoveryArtifact(paths.claimPath, journal.baseSha256);
  if (claimValidation.kind !== 'valid') {
    return { ok: false, reason: 'conflict' };
  }
  const currentClaimStat = await lstat(paths.claimPath);
  if (
    !(
      sameFileIdentity(currentClaimStat, claimValidation.identity) &&
      (await journalReadIsUnchanged(paths.journalPath, journalRead))
    )
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const restored = await linkClaimedMarkdownNoClobber(paths.claimPath, paths.markdownPath);
  if (
    !(
      restored &&
      (await cleanupValidatedSkillMarkdownJournal(paths, journal, {
        journalIdentity: journalRead.identity,
        tempValidation,
      })) &&
      (await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity))
    )
  ) {
    return { ok: false, reason: 'conflict' };
  }
  return { ok: false, reason };
};

export const writeSkillMarkdown = async (input: {
  baseSha256: string;
  content: string;
  skillName: string;
  sourceRepoPath: string;
}): Promise<SkillMarkdownWriteResult> => {
  const skillName = parseSkillName(input.skillName);
  if (Buffer.byteLength(input.content, 'utf8') > maxSkillMarkdownBytes) {
    return { ok: false, reason: 'too-large' };
  }
  if (!sha256Pattern.test(input.baseSha256)) {
    throw new Error('baseSha256 must be a 64-character lowercase hex string');
  }
  const location = await resolveSkillMarkdownLocation(input.sourceRepoPath, skillName);
  if (location === undefined) {
    return { ok: false, reason: 'not-found' };
  }
  const recoveryPaths = recoveryPathsForMarkdown(location.markdownPath);
  return await withSerializedFileMutation(location.markdownPath, async () => {
    if ((await recoverSkillMarkdownWrite(recoveryPaths)) === 'blocked') {
      return { ok: false, reason: 'conflict' };
    }
    const currentRead = await readBoundedRegularFile(location.markdownPath, maxSkillMarkdownBytes);
    if (currentRead.kind === 'too-large') {
      return { ok: false, reason: 'too-large' };
    }
    if (currentRead.kind !== 'ok') {
      return { ok: false, reason: 'not-found' };
    }
    if (sha256(currentRead.buffer) !== input.baseSha256) {
      return { ok: false, reason: 'conflict' };
    }
    const operationId = randomUUID();
    let journal: SkillMarkdownWriteJournal = {
      baseSha256: input.baseSha256,
      newSha256: sha256(input.content),
      operationId,
      phase: 'prepared',
      tempName: `.SKILL.md.ai-usage.${operationId}.tmp`,
      version: 1,
    };
    await writeSkillMarkdownJournal(recoveryPaths.journalPath, journal);
    if (!(await claimSkillMarkdown(recoveryPaths))) {
      return (await cleanupValidatedSkillMarkdownJournal(recoveryPaths, journal))
        ? { ok: false, reason: 'not-found' }
        : { ok: false, reason: 'conflict' };
    }
    journal = { ...journal, phase: 'claimed' };
    await writeSkillMarkdownJournal(recoveryPaths.journalPath, journal);
    const claimedRead = await readBoundedRegularFile(recoveryPaths.claimPath, maxSkillMarkdownBytes);
    if (claimedRead.kind === 'too-large') {
      return await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'too-large');
    }
    if (claimedRead.kind !== 'ok') {
      return await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'not-found');
    }
    if (sha256(claimedRead.buffer) !== input.baseSha256) {
      return await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'conflict');
    }
    const temporaryPath = path.join(path.dirname(location.markdownPath), journal.tempName);
    try {
      const mode = await existingRegularFileMode(recoveryPaths.claimPath, 0o600);
      await writeExclusiveFile(temporaryPath, input.content, mode);
    } catch (error) {
      await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'conflict');
      throw error;
    }
    try {
      await link(temporaryPath, location.markdownPath);
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') {
        await cleanupValidatedSkillMarkdownJournal(recoveryPaths, journal);
        return { ok: false, reason: 'conflict' };
      }
      await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'conflict');
      throw error;
    }
    journal = { ...journal, phase: 'published' };
    await writeSkillMarkdownJournal(recoveryPaths.journalPath, journal);
    const publishedJournalRead = await readSkillMarkdownWriteJournal(recoveryPaths.journalPath);
    const publishedTempValidation = await validateRecoveryArtifact(temporaryPath, journal.newSha256);
    const publishedMarkdownRead = await readBoundedRegularFile(location.markdownPath, maxSkillMarkdownBytes);
    const claimValidation = await validateRecoveryArtifact(recoveryPaths.claimPath, journal.baseSha256);
    if (
      publishedJournalRead.kind !== 'ok' ||
      !journalsEqual(publishedJournalRead.journal, journal) ||
      publishedTempValidation.kind !== 'valid' ||
      publishedMarkdownRead.kind !== 'ok' ||
      !sameFileIdentity(publishedTempValidation.identity, publishedMarkdownRead.identity) ||
      claimValidation.kind !== 'valid' ||
      !(await journalReadIsUnchanged(recoveryPaths.journalPath, publishedJournalRead)) ||
      !(await removeArtifactWithIdentity(recoveryPaths.claimPath, claimValidation.identity)) ||
      !(await cleanupValidatedSkillMarkdownJournal(recoveryPaths, journal, {
        journalIdentity: publishedJournalRead.identity,
        tempValidation: publishedTempValidation,
      }))
    ) {
      throw new Error('skill markdown recovery artifacts changed before cleanup');
    }
    return { ok: true };
  });
};
