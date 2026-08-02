import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUsageEngineInstanceId, type UsageEngineInstanceId } from '@ai-usage/usage-engine-control';
import {
  errorHasCode,
  type FileIdentity,
  hasCurrentOwner,
  isOwnerOnly,
  isProcessStartTimeTicks,
  loadUsageEngineRendezvous,
  processIsAlive,
  readProcessStartTimeTicks as processStartTimeTicks,
  readOpenedFileBounded,
  sameFileIdentity as sameIdentity,
} from '@ai-usage/usage-engine-control/node';

const LOCK_FILE_SUFFIX = '.engine.lock';
const RENDEZVOUS_FILE_NAME = 'rendezvous.json';
const LOCK_METADATA_VERSION = 1;
const MAX_LOCK_METADATA_BYTES = 4096;
const LOCK_INITIALIZATION_DEADLINE_MS = 250;
const LOCK_INITIALIZATION_POLL_MS = 10;
const LOCK_ACQUISITION_ATTEMPTS = 8;
const LOCK_TEMPORARY_GRACE_MS = 1000;
const LOCK_RECOVERY_POLL_MS = 10;
const LOCK_RECOVERY_SETTLE_DEADLINE_MS = 500;
const RENDEZVOUS_TEMPORARY_FILE_PATTERN =
  /^\.rendezvous-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const LOCK_TEMPORARY_FILE_PATTERN =
  /^\.ai-usage-engine-lock-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const LOCK_ACQUISITION_INTENT_PATTERN =
  /^\.ai-usage-engine-acquire-([0-9a-f]{16})-(\d+)-(none|\d+)-(\d{1,16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.intent$/;
const LOCK_RECOVERY_CLAIM_PATTERN =
  /^\.ai-usage-engine-recovery-([0-9a-f]{16})-(\d+)-(none|\d+)-(\d{1,16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.claim$/;
const MAX_STATE_DIRECTORY_ENTRIES = 4096;

interface ValidatedStateDirectory {
  readonly identity: FileIdentity;
  readonly path: string;
}

interface RecoveryOwner {
  readonly createdAtMs: number;
  readonly pid: number;
  readonly processStartTimeTicks: string | null;
}

interface AcquisitionIntent {
  readonly identity: FileIdentity;
  readonly owner: RecoveryOwner;
  readonly path: string;
}

interface UsageEngineLockMetadata {
  readonly createdAt: string;
  readonly databasePath: string;
  readonly hostname: string;
  readonly instanceId: UsageEngineInstanceId;
  readonly ownerId: string;
  readonly pid: number;
  readonly processStartTimeTicks: string | null;
  readonly stateDirectory: string;
  readonly version: typeof LOCK_METADATA_VERSION;
}

interface RecoveryClaim {
  readonly identity: FileIdentity;
  readonly metadata: UsageEngineLockMetadata;
  readonly owner: RecoveryOwner;
  readonly path: string;
}

class UnprovenPublishedLockRollbackError extends AggregateError {
  override readonly name = 'UnprovenPublishedLockRollbackError';
}

export interface UsageEngineLock {
  readonly path: string;
  readonly release: () => Promise<void>;
}

export interface AcquireUsageEngineLockOptions {
  /** @internal Fault injection after a missing replacement final is proven. */
  readonly afterPublishedLockRollbackAbsent?: (lockPath: string) => Promise<void>;
  /** @internal Fault injection after the replacement final is linked. */
  readonly afterRecoveredLockLinked?: (lockPath: string) => Promise<void>;
  /** @internal Fault injection before replacement-final rollback inspection. */
  readonly beforePublishedLockRollbackInspection?: (lockPath: string) => Promise<void>;
  /** @internal Fault injection at the post-takeover crash boundary. */
  readonly beforeRecoveredLockPublication?: () => Promise<void>;
  readonly databasePath: string;
  readonly instanceId: string;
  readonly stateDirectory: string;
}

export type UsageEngineLockInspection =
  | { readonly path: string; readonly state: 'absent' }
  | {
      readonly instanceId: UsageEngineInstanceId;
      readonly path: string;
      readonly pid: number;
      readonly state: 'live' | 'stale';
    }
  | { readonly path: string; readonly reason: string; readonly state: 'unsafe' };

const validateStateDirectoryStat = (directoryPath: string, stats: Stats): void => {
  if (stats.isSymbolicLink() || !stats.isDirectory() || !hasCurrentOwner(stats.uid) || !isOwnerOnly(stats.mode)) {
    throw new Error(`Usage engine state directory must be an owned directory: ${directoryPath}`);
  }
};

const ensurePrivateStateDirectory = async (directoryPath: string): Promise<ValidatedStateDirectory> => {
  const absolutePath = path.resolve(directoryPath);
  try {
    await mkdir(absolutePath, { mode: 0o700, recursive: true });
  } catch (error) {
    if (!errorHasCode(error, 'EEXIST')) {
      throw error;
    }
  }
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isDirectory() || !hasCurrentOwner(before.uid)) {
    throw new Error(`Usage engine state directory must be an owned directory: ${absolutePath}`);
  }
  if (process.platform !== 'win32') {
    await chmod(absolutePath, 0o700);
  }
  const after = await lstat(absolutePath);
  validateStateDirectoryStat(absolutePath, after);
  if (!sameIdentity(before, after)) {
    throw new Error(`Usage engine state directory changed during validation: ${absolutePath}`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new Error(`Usage engine state directory must be canonical: ${absolutePath}`);
  }
  return { identity: after, path: canonicalPath };
};

const inspectPrivateStateDirectory = async (directoryPath: string): Promise<ValidatedStateDirectory | undefined> => {
  const absolutePath = path.resolve(directoryPath);
  const stats = await lstat(absolutePath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!stats) {
    return;
  }
  validateStateDirectoryStat(absolutePath, stats);
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new Error(`Usage engine state directory must be canonical: ${absolutePath}`);
  }
  return { identity: stats, path: canonicalPath };
};

const assertStateDirectoryUnchanged = async (directory: ValidatedStateDirectory): Promise<void> => {
  const current = await lstat(directory.path).catch(() => undefined);
  if (!current) {
    throw new Error(`Usage engine state directory disappeared during use: ${directory.path}`);
  }
  validateStateDirectoryStat(directory.path, current);
  if (!sameIdentity(directory.identity, current)) {
    throw new Error(`Usage engine state directory changed during use: ${directory.path}`);
  }
};

interface ValidatedDatabaseLockTarget {
  readonly databasePath: string;
  readonly directory: ValidatedStateDirectory;
  readonly lockPath: string;
}

const validateDatabaseCandidate = (databasePath: string, stats: Stats | undefined): void => {
  if (stats && (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1 || !hasCurrentOwner(stats.uid))) {
    throw new Error(`Usage engine database path is unsafe: ${databasePath}`);
  }
};

const resolveDatabaseLockTarget = async (
  databasePathValue: string,
  createDirectory: boolean,
): Promise<ValidatedDatabaseLockTarget | undefined> => {
  const absoluteDatabasePath = path.resolve(databasePathValue);
  const directoryPath = path.dirname(absoluteDatabasePath);
  if (createDirectory) {
    await mkdir(directoryPath, { mode: 0o700, recursive: true });
  }
  const directoryStats = await lstat(directoryPath).catch((error: unknown): Stats | undefined => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!directoryStats) {
    return;
  }
  const canonicalDirectoryPath = await realpath(directoryPath);
  const directory = await inspectPrivateStateDirectory(canonicalDirectoryPath);
  if (!directory) {
    return;
  }
  const databaseStats = await lstat(absoluteDatabasePath).catch((error: unknown): Stats | undefined => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  validateDatabaseCandidate(absoluteDatabasePath, databaseStats);
  const databasePath = databaseStats
    ? await realpath(absoluteDatabasePath)
    : path.join(directory.path, path.basename(absoluteDatabasePath));
  return {
    databasePath,
    directory,
    lockPath: `${databasePath}${LOCK_FILE_SUFFIX}`,
  };
};

const recoveryOwnerIsLive = async (owner: RecoveryOwner): Promise<boolean> => {
  if (!processIsAlive(owner.pid)) {
    return false;
  }
  const currentStartTime = await processStartTimeTicks(owner.pid);
  return (
    owner.processStartTimeTicks === null ||
    currentStartTime === null ||
    owner.processStartTimeTicks === currentStartTime
  );
};

const lockScopeKey = (lockPath: string): string =>
  createHash('sha256').update(lockPath, 'utf8').digest('hex').slice(0, 16);

const recoveryOwnerFromMatch = (match: RegExpExecArray): RecoveryOwner | undefined => {
  const pid = Number(match[2]);
  const processStartTimeTicks = match[3] === 'none' ? null : match[3];
  const createdAtMs = Number(match[4]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    processStartTimeTicks === undefined
  ) {
    return;
  }
  return { createdAtMs, pid, processStartTimeTicks };
};

const recoveryOwnerFileSegment = (owner: RecoveryOwner): string =>
  `${owner.pid}-${owner.processStartTimeTicks ?? 'none'}-${owner.createdAtMs}-${randomUUID()}`;

const recoveryOwnerIsAbandoned = async (owner: RecoveryOwner): Promise<boolean> =>
  Date.now() - owner.createdAtMs >= LOCK_TEMPORARY_GRACE_MS && !(await recoveryOwnerIsLive(owner));

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const parseLockMetadata = (text: string): UsageEngineLockMetadata | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, [
        'createdAt',
        'databasePath',
        'hostname',
        'instanceId',
        'ownerId',
        'pid',
        'processStartTimeTicks',
        'stateDirectory',
        'version',
      ])
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.version !== LOCK_METADATA_VERSION ||
      typeof record.createdAt !== 'string' ||
      Number.isNaN(Date.parse(record.createdAt)) ||
      typeof record.hostname !== 'string' ||
      typeof record.databasePath !== 'string' ||
      typeof record.ownerId !== 'string' ||
      typeof record.stateDirectory !== 'string' ||
      !(typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0) ||
      !(record.processStartTimeTicks === null || isProcessStartTimeTicks(record.processStartTimeTicks))
    ) {
      return;
    }
    return {
      createdAt: record.createdAt,
      databasePath: record.databasePath,
      hostname: record.hostname,
      instanceId: parseUsageEngineInstanceId(record.instanceId),
      ownerId: record.ownerId,
      pid: record.pid,
      processStartTimeTicks: record.processStartTimeTicks,
      stateDirectory: record.stateDirectory,
      version: LOCK_METADATA_VERSION,
    };
  } catch {
    return;
  }
};

const removeLockIfUnchanged = async (lockPath: string, identity: FileIdentity): Promise<boolean> => {
  const current = await lstat(lockPath).catch(() => undefined);
  if (!(current?.isFile() && !current.isSymbolicLink() && sameIdentity(current, identity))) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
};

const removePrivateFileIfUnchanged = async (filePath: string, identity: FileIdentity): Promise<boolean> => {
  const current = await lstat(filePath).catch(() => undefined);
  if (
    !current?.isFile() ||
    current.isSymbolicLink() ||
    !sameIdentity(current, identity) ||
    !hasCurrentOwner(current.uid) ||
    !isOwnerOnly(current.mode)
  ) {
    return false;
  }
  return await removeLockIfUnchanged(filePath, identity);
};

const createAcquisitionIntent = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  owner: RecoveryOwner,
): Promise<AcquisitionIntent> => {
  await assertStateDirectoryUnchanged(directory);
  const intentPath = path.join(
    directory.path,
    `.ai-usage-engine-acquire-${lockScopeKey(lockPath)}-${recoveryOwnerFileSegment(owner)}.intent`,
  );
  const intentFile = await open(intentPath, 'wx', 0o600);
  try {
    const stats = await intentFile.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size !== 0 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode)
    ) {
      throw new Error(`Usage engine lock acquisition intent is unsafe: ${intentPath}`);
    }
    return { identity: stats, owner, path: intentPath };
  } catch (error) {
    await removeLockIfUnchanged(intentPath, await intentFile.stat()).catch(() => undefined);
    throw error;
  } finally {
    await intentFile.close().catch(() => undefined);
  }
};

const listAcquisitionIntents = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
): Promise<AcquisitionIntent[]> => {
  await assertStateDirectoryUnchanged(directory);
  const expectedScopeKey = lockScopeKey(lockPath);
  const intents: AcquisitionIntent[] = [];
  let entryCount = 0;
  const entries = await opendir(directory.path);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new Error(`Usage engine lock acquisition intent scan was bounded and preserved: ${lockPath}`);
    }
    const match = LOCK_ACQUISITION_INTENT_PATTERN.exec(entry.name);
    if (!match || match[1] !== expectedScopeKey) {
      continue;
    }
    const owner = recoveryOwnerFromMatch(match);
    if (!owner) {
      throw new Error(`Usage engine lock acquisition intent name was invalid and preserved: ${entry.name}`);
    }
    const intentPath = path.join(directory.path, entry.name);
    const stats = await lstat(intentPath).catch(() => undefined);
    if (!stats) {
      // A losing acquirer may remove its own validated intent between readdir and lstat.
      continue;
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size !== 0 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode)
    ) {
      throw new Error(`Usage engine lock acquisition intent was suspicious and preserved: ${intentPath}`);
    }
    intents.push({ identity: stats, owner, path: intentPath });
  }
  return intents;
};

const scavengeAbandonedAcquisitionIntents = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  ownIntent: AcquisitionIntent,
): Promise<void> => {
  const intents = await listAcquisitionIntents(lockPath, directory);
  for (const intent of intents) {
    if (
      intent.path !== ownIntent.path &&
      (await recoveryOwnerIsAbandoned(intent.owner)) &&
      !(await removePrivateFileIfUnchanged(intent.path, intent.identity))
    ) {
      throw new Error(`Usage engine abandoned acquisition intent changed during scavenging: ${intent.path}`);
    }
  }
};

const inspectRecoveryClaim = async (
  claimPath: string,
  owner: RecoveryOwner,
  databasePath: string,
): Promise<RecoveryClaim> => {
  const pathStats = await lstat(claimPath).catch(() => undefined);
  if (!pathStats?.isFile() || pathStats.isSymbolicLink()) {
    throw new Error(`Usage engine lock recovery claim was suspicious and preserved: ${claimPath}`);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  const claimFile = await open(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await claimFile.stat();
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > MAX_LOCK_METADATA_BYTES ||
      !sameIdentity(pathStats, opened) ||
      !hasCurrentOwner(opened.uid) ||
      !isOwnerOnly(opened.mode)
    ) {
      throw new Error(`Usage engine lock recovery claim was suspicious and preserved: ${claimPath}`);
    }
    const bytes = await readOpenedFileBounded(claimFile, opened.size);
    const afterOpen = await claimFile.stat();
    const current = await lstat(claimPath).catch(() => undefined);
    if (
      bytes.byteLength !== opened.size ||
      !sameIdentity(opened, afterOpen) ||
      afterOpen.size !== opened.size ||
      afterOpen.nlink < 1 ||
      !hasCurrentOwner(afterOpen.uid) ||
      !isOwnerOnly(afterOpen.mode) ||
      !current?.isFile() ||
      current.isSymbolicLink() ||
      current.nlink < 1 ||
      current.size !== opened.size ||
      !sameIdentity(opened, current)
    ) {
      throw new Error(`Usage engine lock recovery claim changed while it was read: ${claimPath}`);
    }
    const metadata = parseLockMetadata(bytes.toString('utf8'));
    if (!metadata || metadata.hostname !== os.hostname() || metadata.databasePath !== databasePath) {
      throw new Error(`Usage engine lock recovery claim ownership was not validated: ${claimPath}`);
    }
    return { identity: opened, metadata, owner, path: claimPath };
  } finally {
    await claimFile.close().catch(() => undefined);
  }
};

const listRecoveryClaims = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
): Promise<RecoveryClaim[]> => {
  await assertStateDirectoryUnchanged(directory);
  const expectedScopeKey = lockScopeKey(lockPath);
  const claims: RecoveryClaim[] = [];
  let entryCount = 0;
  const entries = await opendir(directory.path);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new Error(`Usage engine lock recovery claim scan was bounded and preserved: ${lockPath}`);
    }
    const match = LOCK_RECOVERY_CLAIM_PATTERN.exec(entry.name);
    if (!match || match[1] !== expectedScopeKey) {
      continue;
    }
    const owner = recoveryOwnerFromMatch(match);
    if (!owner) {
      throw new Error(`Usage engine lock recovery claim name was invalid and preserved: ${entry.name}`);
    }
    claims.push(await inspectRecoveryClaim(path.join(directory.path, entry.name), owner, databasePath));
  }
  return claims;
};

const recoveryClaimPath = (lockPath: string, directory: ValidatedStateDirectory, owner: RecoveryOwner): string =>
  path.join(
    directory.path,
    `.ai-usage-engine-recovery-${lockScopeKey(lockPath)}-${recoveryOwnerFileSegment(owner)}.claim`,
  );

const createRecoveryClaim = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
  expectedIdentity: FileIdentity,
  owner: RecoveryOwner,
): Promise<RecoveryClaim | undefined> => {
  await assertStateDirectoryUnchanged(directory);
  const claimPath = recoveryClaimPath(lockPath, directory, owner);
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  try {
    const claim = await inspectRecoveryClaim(claimPath, owner, databasePath);
    if (!sameIdentity(expectedIdentity, claim.identity)) {
      await removePrivateFileIfUnchanged(claim.path, claim.identity);
      return;
    }
    return claim;
  } catch (error) {
    const claimStats = await lstat(claimPath).catch(() => undefined);
    if (claimStats?.isFile() && !claimStats.isSymbolicLink()) {
      await removePrivateFileIfUnchanged(claimPath, claimStats).catch(() => undefined);
    }
    throw error;
  }
};

const electRecoveryClaim = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
  claim: RecoveryClaim,
): Promise<boolean> => {
  const deadline = Date.now() + LOCK_RECOVERY_SETTLE_DEADLINE_MS;
  while (true) {
    const contenders = (await listRecoveryClaims(lockPath, directory, databasePath))
      .filter((candidate) => sameIdentity(candidate.identity, claim.identity))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (contenders[0]?.path !== claim.path) {
      if (!(await removePrivateFileIfUnchanged(claim.path, claim.identity))) {
        throw new Error(`Usage engine lock recovery claim changed before withdrawal: ${claim.path}`);
      }
      return false;
    }
    const [currentFinal, currentClaim] = await Promise.all([
      lstat(lockPath).catch(() => undefined),
      lstat(claim.path).catch(() => undefined),
    ]);
    if (
      currentFinal?.isFile() &&
      !currentFinal.isSymbolicLink() &&
      currentClaim?.isFile() &&
      !currentClaim.isSymbolicLink() &&
      sameIdentity(currentFinal, claim.identity) &&
      sameIdentity(currentClaim, claim.identity) &&
      currentFinal.nlink === 2 &&
      currentClaim.nlink === 2 &&
      contenders.length === 1
    ) {
      return true;
    }
    if (Date.now() >= deadline) {
      if (!(await removePrivateFileIfUnchanged(claim.path, claim.identity))) {
        throw new Error(`Usage engine lock recovery claim changed during contention: ${claim.path}`);
      }
      throw new Error(`Usage engine lock recovery contention did not settle: ${lockPath}`);
    }
    await Bun.sleep(LOCK_RECOVERY_POLL_MS);
  }
};

const adoptAbandonedRecoveryClaim = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
  claims: readonly RecoveryClaim[],
  owner: RecoveryOwner,
): Promise<RecoveryClaim | undefined> => {
  if (claims.length === 0) {
    return;
  }
  const identity = claims[0]?.identity;
  if (!identity || claims.some((claim) => !sameIdentity(claim.identity, identity))) {
    throw new Error(`Usage engine lock recovery claims were ambiguous and preserved: ${lockPath}`);
  }
  for (const claim of claims) {
    if (!(await recoveryOwnerIsAbandoned(claim.owner))) {
      throw new Error(`Usage engine lock recovery is owned by live PID ${claim.owner.pid}: ${lockPath}`);
    }
  }
  const selected = [...claims].sort((left, right) => left.path.localeCompare(right.path))[0];
  if (!selected) {
    return;
  }
  const adoptedPath = recoveryClaimPath(lockPath, directory, owner);
  try {
    await rename(selected.path, adoptedPath);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  const adopted = await inspectRecoveryClaim(adoptedPath, owner, databasePath);
  if (!sameIdentity(adopted.identity, selected.identity)) {
    throw new Error(`Usage engine lock recovery claim changed during adoption: ${adoptedPath}`);
  }
  for (const claim of claims) {
    if (claim.path === selected.path) {
      continue;
    }
    if (!(await removePrivateFileIfUnchanged(claim.path, claim.identity))) {
      throw new Error(`Usage engine lock recovery claim changed during adoption: ${claim.path}`);
    }
  }
  return adopted;
};

const drainForeignAcquisitionIntents = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  ownIntent: AcquisitionIntent,
): Promise<void> => {
  const deadline = Date.now() + LOCK_RECOVERY_SETTLE_DEADLINE_MS;
  while (true) {
    const foreignIntents = (await listAcquisitionIntents(lockPath, directory)).filter(
      (intent) => intent.path !== ownIntent.path,
    );
    for (const intent of foreignIntents) {
      if (
        (await recoveryOwnerIsAbandoned(intent.owner)) &&
        !(await removePrivateFileIfUnchanged(intent.path, intent.identity))
      ) {
        throw new Error(`Usage engine lock acquisition intent changed during recovery: ${intent.path}`);
      }
    }
    const remaining = (await listAcquisitionIntents(lockPath, directory)).filter(
      (intent) => intent.path !== ownIntent.path,
    );
    if (remaining.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Usage engine lock recovery could not drain live acquisition intents: ${lockPath}`);
    }
    await Bun.sleep(LOCK_RECOVERY_POLL_MS);
  }
};

const removeClaimedStaleFinal = async (lockPath: string, claim: RecoveryClaim): Promise<void> => {
  const [currentFinal, currentClaim] = await Promise.all([
    lstat(lockPath).catch(() => undefined),
    lstat(claim.path).catch(() => undefined),
  ]);
  if (
    !currentFinal?.isFile() ||
    currentFinal.isSymbolicLink() ||
    !currentClaim?.isFile() ||
    currentClaim.isSymbolicLink() ||
    currentFinal.nlink !== 2 ||
    currentClaim.nlink !== 2 ||
    !sameIdentity(currentFinal, claim.identity) ||
    !sameIdentity(currentClaim, claim.identity) ||
    !hasCurrentOwner(currentFinal.uid) ||
    !isOwnerOnly(currentFinal.mode)
  ) {
    throw new Error(`Usage engine stale lock changed after recovery claim: ${lockPath}`);
  }
  await unlink(lockPath);
  const remainingClaim = await lstat(claim.path).catch(() => undefined);
  if (
    !remainingClaim?.isFile() ||
    remainingClaim.isSymbolicLink() ||
    remainingClaim.nlink !== 1 ||
    !sameIdentity(remainingClaim, claim.identity)
  ) {
    throw new Error(`Usage engine stale lock removal could not be validated: ${lockPath}`);
  }
};

const rollBackRecoveryClaim = async (
  lockPath: string,
  claim: RecoveryClaim,
  finalWasRemoved: boolean,
): Promise<void> => {
  if (finalWasRemoved) {
    try {
      await link(claim.path, lockPath);
    } catch (error) {
      if (!errorHasCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }
  const [currentFinal, currentClaim] = await Promise.all([
    lstat(lockPath).catch((error: unknown) => {
      if (errorHasCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }),
    lstat(claim.path).catch((error: unknown) => {
      if (errorHasCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }),
  ]);
  if (
    !currentFinal?.isFile() ||
    currentFinal.isSymbolicLink() ||
    !currentClaim?.isFile() ||
    currentClaim.isSymbolicLink() ||
    currentFinal.nlink !== 2 ||
    currentClaim.nlink !== 2 ||
    !sameIdentity(currentFinal, claim.identity) ||
    !sameIdentity(currentClaim, claim.identity) ||
    !hasCurrentOwner(currentFinal.uid) ||
    !isOwnerOnly(currentFinal.mode)
  ) {
    throw new UnprovenPublishedLockRollbackError(
      [new Error(`Usage engine recovery claim could not be restored at the canonical lock path: ${lockPath}`)],
      'Usage engine lock publication rollback could not be proven.',
    );
  }
  if (!(await removePrivateFileIfUnchanged(claim.path, claim.identity))) {
    throw new Error(`Usage engine lock recovery claim changed during rollback: ${claim.path}`);
  }
};

const scavengeAbandonedLockTemporaryFiles = async (directory: ValidatedStateDirectory): Promise<void> => {
  await assertStateDirectoryUnchanged(directory);
  let entryCount = 0;
  const entries = await opendir(directory.path);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new Error(`Usage engine lock temporary scan was bounded and preserved: ${directory.path}`);
    }
    const match = LOCK_TEMPORARY_FILE_PATTERN.exec(entry.name);
    const pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid)) {
      continue;
    }
    const candidatePath = path.join(directory.path, entry.name);
    const stats = await lstat(candidatePath).catch(() => undefined);
    if (stats?.isFile() && !stats.isSymbolicLink() && stats.nlink === 2) {
      // The final-path recovery below owns exact two-link publication repair.
      continue;
    }
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode)
    ) {
      throw new Error(`Usage engine lock temporary file was suspicious and preserved: ${candidatePath}`);
    }
    if (Date.now() - stats.mtimeMs < LOCK_TEMPORARY_GRACE_MS || processIsAlive(pid)) {
      continue;
    }
    await removeLockIfUnchanged(candidatePath, stats);
  }
};

const repairInterruptedLockPublication = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
): Promise<void> => {
  const lockStats = await lstat(lockPath).catch(() => undefined);
  if (lockStats?.nlink !== 2) {
    return;
  }
  await assertStateDirectoryUnchanged(directory);
  let candidate: { readonly path: string; readonly stats: Stats } | undefined;
  let entryCount = 0;
  const entries = await opendir(directory.path);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new Error(`Usage engine interrupted lock scan was bounded and preserved: ${lockPath}`);
    }
    if (!LOCK_TEMPORARY_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    const candidatePath = path.join(directory.path, entry.name);
    const stats = await lstat(candidatePath).catch(() => undefined);
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 2 ||
      !sameIdentity(lockStats, stats) ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode) ||
      candidate
    ) {
      throw new Error(`Usage engine interrupted lock publication was ambiguous and preserved: ${lockPath}`);
    }
    candidate = { path: candidatePath, stats };
  }
  if (!candidate) {
    throw new Error(`Usage engine lock must be owner-only and singly linked: ${lockPath}`);
  }
  await unlink(candidate.path);
  const repaired = await lstat(lockPath).catch(() => undefined);
  if (
    !repaired?.isFile() ||
    repaired.isSymbolicLink() ||
    repaired.nlink !== 1 ||
    !sameIdentity(candidate.stats, repaired) ||
    !hasCurrentOwner(repaired.uid) ||
    !isOwnerOnly(repaired.mode)
  ) {
    throw new Error(`Usage engine interrupted lock repair could not be validated: ${lockPath}`);
  }
};

const inspectExistingLock = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
): Promise<{ readonly identity: FileIdentity; readonly metadata: UsageEngineLockMetadata }> => {
  const initializationDeadline = Date.now() + LOCK_INITIALIZATION_DEADLINE_MS;
  let expectedIdentity: FileIdentity | undefined;
  while (true) {
    await assertStateDirectoryUnchanged(directory);
    const pathStats = await lstat(lockPath).catch(() => undefined);
    if (pathStats?.isSymbolicLink()) {
      throw new Error(`Usage engine lock must not be a symlink: ${lockPath}`);
    }
    if (pathStats && !pathStats.isFile()) {
      throw new Error(`Usage engine lock must be a bounded regular file: ${lockPath}`);
    }
    let lockFile: Awaited<ReturnType<typeof open>>;
    try {
      // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
      lockFile = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      throw new Error(`Unable to validate usage engine lock: ${lockPath}`, { cause: error });
    }
    try {
      const opened = await lockFile.stat();
      if (!(opened.isFile() && opened.size <= MAX_LOCK_METADATA_BYTES)) {
        throw new Error(`Usage engine lock must be a bounded regular file: ${lockPath}`);
      }
      const privateOwnedFile =
        process.platform === 'win32' || (hasCurrentOwner(opened.uid) && isOwnerOnly(opened.mode));
      const stableIdentity =
        pathStats !== undefined &&
        sameIdentity(pathStats, opened) &&
        (expectedIdentity === undefined || sameIdentity(expectedIdentity, opened));
      const transientPublicationLink =
        opened.nlink === 2 && privateOwnedFile && stableIdentity && Date.now() < initializationDeadline;
      if (transientPublicationLink) {
        expectedIdentity = opened;
      } else {
        if (!(opened.nlink === 1 && privateOwnedFile && stableIdentity)) {
          throw new Error(`Usage engine lock must be owner-only and singly linked: ${lockPath}`);
        }
        expectedIdentity = opened;
        const bytes = await readOpenedFileBounded(lockFile, opened.size);
        const afterOpen = await lockFile.stat();
        const current = await lstat(lockPath).catch(() => undefined);
        if (
          bytes.byteLength !== opened.size ||
          !sameIdentity(opened, afterOpen) ||
          afterOpen.size !== opened.size ||
          afterOpen.nlink !== opened.nlink ||
          !current?.isFile() ||
          current.isSymbolicLink() ||
          current.size !== opened.size ||
          !sameIdentity(opened, current)
        ) {
          throw new Error(`Usage engine lock changed while it was read: ${lockPath}`);
        }
        const text = bytes.toString('utf8');
        const metadata = parseLockMetadata(text);
        if (metadata) {
          if (metadata.hostname !== os.hostname() || metadata.databasePath !== databasePath) {
            throw new Error(`Usage engine lock ownership could not be validated and was preserved: ${lockPath}`);
          }
          return { identity: opened, metadata };
        }
        if (text.endsWith('\n') || Date.now() >= initializationDeadline) {
          throw new Error(`Usage engine lock has invalid metadata and was preserved: ${lockPath}`);
        }
      }
    } finally {
      await lockFile.close().catch(() => undefined);
    }
    await Bun.sleep(LOCK_INITIALIZATION_POLL_MS);
  }
};

const lockOwnerIsLive = async (metadata: UsageEngineLockMetadata): Promise<boolean> => {
  const pidIsLive = processIsAlive(metadata.pid);
  const currentStartTime = pidIsLive ? await processStartTimeTicks(metadata.pid) : null;
  return (
    pidIsLive &&
    (metadata.processStartTimeTicks === null ||
      currentStartTime === null ||
      metadata.processStartTimeTicks === currentStartTime)
  );
};

const repairInterruptedRendezvousPublication = async (
  directory: ValidatedStateDirectory,
  rendezvousPath: string,
  stalePid: number,
  rendezvousStats: Stats,
): Promise<Stats> => {
  if (rendezvousStats.nlink !== 2) {
    return rendezvousStats;
  }
  await assertStateDirectoryUnchanged(directory);
  let candidate: { readonly path: string; readonly stats: Stats } | undefined;
  let entryCount = 0;
  const entries = await opendir(directory.path);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new Error(`Usage engine stale rendezvous directory scan was bounded and preserved: ${directory.path}`);
    }
    const match = RENDEZVOUS_TEMPORARY_FILE_PATTERN.exec(entry.name);
    if (Number(match?.[1]) !== stalePid) {
      continue;
    }
    const candidatePath = path.join(directory.path, entry.name);
    const stats = await lstat(candidatePath).catch(() => undefined);
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 2 ||
      !sameIdentity(rendezvousStats, stats) ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode) ||
      candidate
    ) {
      throw new Error(`Usage engine interrupted rendezvous publication was ambiguous and preserved: ${rendezvousPath}`);
    }
    candidate = { path: candidatePath, stats };
  }
  if (!candidate) {
    throw new Error(`Usage engine hard-linked stale rendezvous was preserved: ${rendezvousPath}`);
  }
  await unlink(candidate.path);
  const repaired = await lstat(rendezvousPath).catch(() => undefined);
  if (
    !repaired?.isFile() ||
    repaired.isSymbolicLink() ||
    repaired.nlink !== 1 ||
    !sameIdentity(candidate.stats, repaired) ||
    !hasCurrentOwner(repaired.uid) ||
    !isOwnerOnly(repaired.mode)
  ) {
    throw new Error(`Usage engine interrupted rendezvous repair could not be validated: ${rendezvousPath}`);
  }
  return repaired;
};

const removeValidatedStaleRendezvous = async (
  directory: ValidatedStateDirectory,
  lockInstanceId: UsageEngineInstanceId,
  stalePid: number,
): Promise<void> => {
  const rendezvousPath = path.join(directory.path, RENDEZVOUS_FILE_NAME);
  let rendezvousStats = await lstat(rendezvousPath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!rendezvousStats) {
    return;
  }
  rendezvousStats = await repairInterruptedRendezvousPublication(directory, rendezvousPath, stalePid, rendezvousStats);
  let rendezvous: Awaited<ReturnType<typeof loadUsageEngineRendezvous>>;
  try {
    rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
  } catch (error) {
    throw new Error(
      `Usage engine stale rendezvous ownership could not be validated and was preserved: ${rendezvousPath}`,
      { cause: error },
    );
  }
  if (rendezvous.instanceId !== lockInstanceId) {
    throw new Error(`Usage engine stale lock and rendezvous identities differ and were preserved: ${directory.path}`);
  }
  const current = await lstat(rendezvousPath).catch(() => undefined);
  if (
    !current?.isFile() ||
    current.isSymbolicLink() ||
    !sameIdentity(rendezvousStats, current) ||
    current.nlink !== 1 ||
    !hasCurrentOwner(current.uid) ||
    !isOwnerOnly(current.mode)
  ) {
    throw new Error(`Usage engine stale rendezvous changed during recovery and was preserved: ${rendezvousPath}`);
  }
  if (!(await removeLockIfUnchanged(rendezvousPath, current))) {
    throw new Error(`Usage engine stale rendezvous changed during recovery and was preserved: ${rendezvousPath}`);
  }
};

const recoverStaleLock = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
  owner: RecoveryOwner,
  ownIntent: AcquisitionIntent,
): Promise<RecoveryClaim | undefined> => {
  let finalStats = await lstat(lockPath).catch(() => undefined);
  let claims = await listRecoveryClaims(lockPath, directory, databasePath);
  if (finalStats) {
    const observedFinalStats = finalStats;
    const detachedClaims = claims.filter((claim) => !sameIdentity(claim.identity, observedFinalStats));
    for (const detached of detachedClaims) {
      if (
        !(
          (await recoveryOwnerIsAbandoned(detached.owner)) &&
          (await removePrivateFileIfUnchanged(detached.path, detached.identity))
        )
      ) {
        throw new Error(`Usage engine detached recovery claim was preserved: ${detached.path}`);
      }
    }
    claims = claims.filter((claim) => sameIdentity(claim.identity, observedFinalStats));
  }

  let claim: RecoveryClaim | undefined;
  if (claims.length > 0) {
    const firstClaim = claims[0];
    if (!firstClaim) {
      return;
    }
    if (claims.some(({ metadata }) => metadata.ownerId !== firstClaim.metadata.ownerId)) {
      throw new Error(`Usage engine lock recovery claims disagreed and were preserved: ${lockPath}`);
    }
    if (await lockOwnerIsLive(firstClaim.metadata)) {
      throw new Error(`Usage engine lock ${lockPath} is owned by live PID ${firstClaim.metadata.pid}.`);
    }
    claim = await adoptAbandonedRecoveryClaim(lockPath, directory, databasePath, claims, owner);
    if (!claim) {
      return;
    }
  } else {
    if (!finalStats) {
      return;
    }
    await repairInterruptedLockPublication(lockPath, directory);
    const inspected = await inspectExistingLock(lockPath, directory, databasePath);
    if (await lockOwnerIsLive(inspected.metadata)) {
      throw new Error(`Usage engine lock ${lockPath} is owned by live PID ${inspected.metadata.pid}.`);
    }
    claim = await createRecoveryClaim(lockPath, directory, databasePath, inspected.identity, owner);
    if (!(claim && (await electRecoveryClaim(lockPath, directory, databasePath, claim)))) {
      return;
    }
    finalStats = await lstat(lockPath).catch(() => undefined);
  }

  let finalWasRemoved = !finalStats;
  try {
    await drainForeignAcquisitionIntents(lockPath, directory, ownIntent);
    if (finalStats) {
      await removeClaimedStaleFinal(lockPath, claim);
      finalWasRemoved = true;
    } else {
      const currentClaim = await lstat(claim.path).catch(() => undefined);
      if (
        !currentClaim?.isFile() ||
        currentClaim.isSymbolicLink() ||
        currentClaim.nlink !== 1 ||
        !sameIdentity(currentClaim, claim.identity)
      ) {
        throw new Error(`Usage engine detached recovery claim changed before takeover: ${claim.path}`);
      }
    }
    const staleStateDirectory = await inspectPrivateStateDirectory(claim.metadata.stateDirectory);
    if (staleStateDirectory) {
      await removeValidatedStaleRendezvous(staleStateDirectory, claim.metadata.instanceId, claim.metadata.pid);
    }
  } catch (error) {
    try {
      await rollBackRecoveryClaim(lockPath, claim, finalWasRemoved);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Usage engine stale-lock recovery rollback failed.');
    }
    throw error;
  }
  return claim;
};

type LockFile = Awaited<ReturnType<typeof open>>;

interface PreparedLock {
  readonly file: LockFile;
  readonly identity: FileIdentity;
  readonly temporaryPath: string;
}

interface LockPublicationFaults {
  readonly afterPublishedLockRollbackAbsent?: ((lockPath: string) => Promise<void>) | undefined;
  readonly afterRecoveredLockLinked?: ((lockPath: string) => Promise<void>) | undefined;
  readonly beforePublishedLockRollbackInspection?: ((lockPath: string) => Promise<void>) | undefined;
  readonly beforeRecoveredLockPublication?: (() => Promise<void>) | undefined;
}

const serializeLockMetadata = (lockPath: string, metadata: UsageEngineLockMetadata): string => {
  const serializedMetadata = `${JSON.stringify(metadata)}\n`;
  if (Buffer.byteLength(serializedMetadata, 'utf8') > MAX_LOCK_METADATA_BYTES) {
    throw new Error(`Usage engine lock metadata exceeds its byte limit: ${lockPath}`);
  }
  return serializedMetadata;
};

const prepareTemporaryLock = async (
  directory: ValidatedStateDirectory,
  serializedMetadata: string,
): Promise<PreparedLock> => {
  const temporaryPath = path.join(directory.path, `.ai-usage-engine-lock-${process.pid}-${randomUUID()}.tmp`);
  let file: LockFile | undefined;
  try {
    file = await open(temporaryPath, 'wx+', 0o600);
    await file.writeFile(serializedMetadata, 'utf8');
    await file.sync();
    const identity = await file.stat();
    if (
      !identity.isFile() ||
      identity.nlink !== 1 ||
      identity.size <= 0 ||
      identity.size > MAX_LOCK_METADATA_BYTES ||
      !hasCurrentOwner(identity.uid) ||
      !isOwnerOnly(identity.mode)
    ) {
      throw new Error(`Usage engine lock temporary file is unsafe: ${temporaryPath}`);
    }
    return { file, identity, temporaryPath };
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const discardPreparedLock = async ({ file, temporaryPath }: PreparedLock): Promise<void> => {
  await file.close().catch(() => undefined);
  await unlink(temporaryPath).catch(() => undefined);
};

const validatePublishedLock = async (lockPath: string, prepared: PreparedLock): Promise<Stats> => {
  const finalIdentity = await lstat(lockPath);
  if (
    !finalIdentity.isFile() ||
    finalIdentity.isSymbolicLink() ||
    finalIdentity.nlink !== 1 ||
    !sameIdentity(prepared.identity, finalIdentity) ||
    !hasCurrentOwner(finalIdentity.uid) ||
    !isOwnerOnly(finalIdentity.mode)
  ) {
    throw new Error(`Usage engine lock changed during publication: ${lockPath}`);
  }
  return finalIdentity;
};

const rollBackPublishedLock = async (
  lockPath: string,
  identity: FileIdentity,
  error: unknown,
  faults: LockPublicationFaults,
): Promise<void> => {
  if (await removeLockIfUnchanged(lockPath, identity)) {
    return;
  }
  let unresolvedFinal: Stats | undefined;
  try {
    await faults.beforePublishedLockRollbackInspection?.(lockPath);
    unresolvedFinal = await lstat(lockPath);
  } catch (inspectionError) {
    if (!errorHasCode(inspectionError, 'ENOENT')) {
      throw new UnprovenPublishedLockRollbackError(
        [error, inspectionError],
        'Usage engine lock publication rollback could not be proven.',
      );
    }
  }
  if (unresolvedFinal) {
    throw new UnprovenPublishedLockRollbackError(
      [error, new Error(`Usage engine published lock changed before rollback: ${lockPath}`)],
      'Usage engine lock publication rollback could not be proven.',
    );
  }
  await faults.afterPublishedLockRollbackAbsent?.(lockPath);
};

const hasRecoveryClaims = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
): Promise<boolean> => (await listRecoveryClaims(lockPath, directory, databasePath)).length > 0;

const recoverLockClaim = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
  ownIntent: AcquisitionIntent,
): Promise<RecoveryClaim | undefined> =>
  await recoverStaleLock(lockPath, directory, databasePath, ownIntent.owner, ownIntent);

const publishLock = async (
  lockPath: string,
  directory: ValidatedStateDirectory,
  databasePath: string,
  metadata: UsageEngineLockMetadata,
  ownIntent: AcquisitionIntent,
  faults: LockPublicationFaults,
): Promise<{ readonly file: LockFile; readonly identity: FileIdentity }> => {
  const serializedMetadata = serializeLockMetadata(lockPath, metadata);
  await scavengeAbandonedLockTemporaryFiles(directory);
  await scavengeAbandonedAcquisitionIntents(lockPath, directory, ownIntent);
  let recoveryClaim: RecoveryClaim | undefined;
  try {
    for (let attempt = 0; attempt < LOCK_ACQUISITION_ATTEMPTS; attempt += 1) {
      await assertStateDirectoryUnchanged(directory);
      if (!recoveryClaim && (await hasRecoveryClaims(lockPath, directory, databasePath))) {
        recoveryClaim = await recoverLockClaim(lockPath, directory, databasePath, ownIntent);
        if (recoveryClaim) {
          await faults.beforeRecoveredLockPublication?.();
        }
        if (!recoveryClaim) {
          await Bun.sleep(LOCK_RECOVERY_POLL_MS);
          continue;
        }
      }
      const prepared = await prepareTemporaryLock(directory, serializedMetadata);
      let published = false;
      try {
        await assertStateDirectoryUnchanged(directory);
        if (!recoveryClaim && (await hasRecoveryClaims(lockPath, directory, databasePath))) {
          await discardPreparedLock(prepared);
          recoveryClaim = await recoverLockClaim(lockPath, directory, databasePath, ownIntent);
          if (recoveryClaim) {
            await faults.beforeRecoveredLockPublication?.();
          }
          if (!recoveryClaim) {
            await Bun.sleep(LOCK_RECOVERY_POLL_MS);
          }
          continue;
        }
        await link(prepared.temporaryPath, lockPath);
        published = true;
        if (recoveryClaim) {
          await faults.afterRecoveredLockLinked?.(lockPath);
        }
        await unlink(prepared.temporaryPath).catch((error: unknown) => {
          if (!errorHasCode(error, 'ENOENT')) {
            throw error;
          }
        });
        const finalIdentity = await validatePublishedLock(lockPath, prepared);
        if (recoveryClaim && !(await removePrivateFileIfUnchanged(recoveryClaim.path, recoveryClaim.identity))) {
          throw new Error(`Usage engine lock recovery claim changed before completion: ${recoveryClaim.path}`);
        }
        return { file: prepared.file, identity: finalIdentity };
      } catch (error) {
        await discardPreparedLock(prepared);
        if (published) {
          await rollBackPublishedLock(lockPath, prepared.identity, error, faults);
        }
        if (!errorHasCode(error, 'EEXIST')) {
          throw error;
        }
        if (recoveryClaim) {
          if (!(await removePrivateFileIfUnchanged(recoveryClaim.path, recoveryClaim.identity))) {
            throw new Error(`Usage engine lock recovery claim changed after publication loss: ${recoveryClaim.path}`);
          }
          recoveryClaim = undefined;
        }
        recoveryClaim = await recoverLockClaim(lockPath, directory, databasePath, ownIntent);
        if (recoveryClaim) {
          await faults.beforeRecoveredLockPublication?.();
        }
      }
    }
  } catch (error) {
    if (!recoveryClaim || error instanceof UnprovenPublishedLockRollbackError) {
      throw error;
    }
    try {
      await rollBackRecoveryClaim(lockPath, recoveryClaim, true);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Usage engine recovered-lock publication rollback failed.');
    }
    throw error;
  }
  if (recoveryClaim) {
    await rollBackRecoveryClaim(lockPath, recoveryClaim, true);
  }
  throw new Error(`Usage engine lock changed repeatedly during acquisition: ${lockPath}`);
};

export const usageEngineLockPath = (databasePath: string): string => `${path.resolve(databasePath)}${LOCK_FILE_SUFFIX}`;

export const inspectUsageEngineLock = async (databasePathValue: string): Promise<UsageEngineLockInspection> => {
  let lockPath = usageEngineLockPath(databasePathValue);
  try {
    const target = await resolveDatabaseLockTarget(databasePathValue, false);
    if (!target) {
      return { path: lockPath, state: 'absent' };
    }
    lockPath = target.lockPath;
    const lockStats = await lstat(lockPath).catch((error: unknown) => {
      if (errorHasCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    });
    const recoveryClaims = await listRecoveryClaims(lockPath, target.directory, target.databasePath);
    if (recoveryClaims.length > 0) {
      return {
        path: lockPath,
        reason: 'Usage engine lock recovery is in progress and was not mutated.',
        state: 'unsafe',
      };
    }
    if (!lockStats) {
      const acquisitionIntents = await listAcquisitionIntents(lockPath, target.directory);
      if (acquisitionIntents.length > 0) {
        return {
          path: lockPath,
          reason: 'Usage engine lock acquisition is in progress and was not mutated.',
          state: 'unsafe',
        };
      }
      return { path: lockPath, state: 'absent' };
    }
    const { metadata } = await inspectExistingLock(lockPath, target.directory, target.databasePath);
    return {
      instanceId: metadata.instanceId,
      path: lockPath,
      pid: metadata.pid,
      state: (await lockOwnerIsLive(metadata)) ? 'live' : 'stale',
    };
  } catch (error) {
    return {
      path: lockPath,
      reason: error instanceof Error ? error.message : 'Usage engine lock validation failed.',
      state: 'unsafe',
    };
  }
};

export const acquireUsageEngineLock = async ({
  afterRecoveredLockLinked,
  afterPublishedLockRollbackAbsent,
  beforeRecoveredLockPublication,
  beforePublishedLockRollbackInspection,
  databasePath: databasePathValue,
  instanceId: instanceIdValue,
  stateDirectory: stateDirectoryValue,
}: AcquireUsageEngineLockOptions): Promise<UsageEngineLock> => {
  const instanceId = parseUsageEngineInstanceId(instanceIdValue);
  const target = await resolveDatabaseLockTarget(databasePathValue, true);
  if (!target) {
    throw new Error('Usage engine database directory could not be prepared for writer exclusion.');
  }
  const stateDirectory = await ensurePrivateStateDirectory(stateDirectoryValue);
  const lockPath = target.lockPath;
  const processStartTime = await processStartTimeTicks(process.pid);
  const recoveryOwner: RecoveryOwner = {
    createdAtMs: Date.now(),
    pid: process.pid,
    processStartTimeTicks: processStartTime,
  };
  const ownIntent = await createAcquisitionIntent(lockPath, target.directory, recoveryOwner);
  const metadata: UsageEngineLockMetadata = {
    createdAt: new Date().toISOString(),
    databasePath: target.databasePath,
    hostname: os.hostname(),
    instanceId,
    ownerId: randomUUID(),
    pid: process.pid,
    processStartTimeTicks: processStartTime,
    stateDirectory: stateDirectory.path,
    version: LOCK_METADATA_VERSION,
  };
  let acquired: Awaited<ReturnType<typeof publishLock>> | undefined;
  try {
    const [existingLock, existingRendezvous] = await Promise.all([
      lstat(lockPath).catch((error: unknown) => {
        if (errorHasCode(error, 'ENOENT')) {
          return;
        }
        throw error;
      }),
      lstat(path.join(stateDirectory.path, RENDEZVOUS_FILE_NAME)).catch((error: unknown) => {
        if (errorHasCode(error, 'ENOENT')) {
          return;
        }
        throw error;
      }),
    ]);
    if (!existingLock && existingRendezvous) {
      const claims = await listRecoveryClaims(lockPath, target.directory, target.databasePath);
      const rendezvousHasRecoveryOwner = claims.some((claim) => claim.metadata.stateDirectory === stateDirectory.path);
      if (!rendezvousHasRecoveryOwner) {
        throw new Error(`Usage engine orphan rendezvous was preserved: ${stateDirectory.path}`);
      }
    }
    acquired = await publishLock(lockPath, target.directory, target.databasePath, metadata, ownIntent, {
      afterPublishedLockRollbackAbsent,
      afterRecoveredLockLinked,
      beforePublishedLockRollbackInspection,
      beforeRecoveredLockPublication,
    });
  } catch (error) {
    if (!(await removePrivateFileIfUnchanged(ownIntent.path, ownIntent.identity))) {
      throw new AggregateError(
        [error, new Error(`Usage engine lock acquisition intent changed before cleanup: ${ownIntent.path}`)],
        'Usage engine lock acquisition and intent cleanup both failed.',
      );
    }
    throw error;
  }
  if (!(await removePrivateFileIfUnchanged(ownIntent.path, ownIntent.identity))) {
    await acquired.file.close().catch(() => undefined);
    await removeLockIfUnchanged(lockPath, acquired.identity);
    throw new Error(`Usage engine lock acquisition intent changed before completion: ${ownIntent.path}`);
  }
  const { file: lockFile, identity: lockIdentity } = acquired;
  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await lockFile.close().catch(() => undefined);
      await assertStateDirectoryUnchanged(target.directory);
      if (!(await removeLockIfUnchanged(lockPath, lockIdentity))) {
        throw new Error(`Usage engine lock changed before release: ${lockPath}`);
      }
    },
  };
};
