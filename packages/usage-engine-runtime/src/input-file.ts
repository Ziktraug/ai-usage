import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { UsageEngineFileInput } from '@ai-usage/usage-engine-control';
import { readOpenedFileBounded } from '@ai-usage/usage-engine-control/node';

const CURSOR_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CURSOR_COPY_CHUNK_BYTES = 64 * 1024;
const CURSOR_HEADER_PROBE_CHARACTERS = 4096;
const CURSOR_HEADER_COLUMNS = ['Date', 'User', 'Kind', 'Model', 'Cost'] as const;
const CURSOR_HEADER_SEPARATOR = /\r?\n/;
const HANDOFF_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}\.upload$/;
const CURSOR_TEMPORARY_FILE_PATTERN =
  /^\.cursor-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const CURSOR_TEMPORARY_GRACE_MS = 1000;
const MAX_CURSOR_IMPORT_DIRECTORY_ENTRIES = 4096;
const MAX_INBOX_SCAVENGE_ENTRIES = 10_000;
const MANAGED_CURSOR_EXPORT_PATTERN = /^(?:[0-9a-f]{64}|[0-9a-f]{12}-[a-zA-Z0-9._-]+)\.csv$/i;
// biome-ignore lint/suspicious/noBitwiseOperators: Node combines no-follow/nonblocking open flags.
const SAFE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
// biome-ignore lint/suspicious/noBitwiseOperators: Node combines no-follow directory open flags.
const SAFE_DIRECTORY_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0);

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileFingerprint extends FileIdentity {
  readonly changedAtMilliseconds: number;
  readonly mode: number;
  readonly modifiedAtMilliseconds: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}

interface OpenedCursorUsageInput {
  readonly file: FileHandle;
  readonly fingerprint: FileFingerprint;
  readonly isHandoff: boolean;
  readonly path: string;
}

export interface UsageEngineInputOptions {
  readonly inboxDirectory: string;
  readonly maximumBytes: number;
  readonly operatorCwd: string;
}

export interface OpenedUsageEngineInput {
  readonly bytes: Uint8Array;
  readonly remove?: () => Promise<void>;
  readonly text: string;
}

export interface StageCursorUsageExportOptions {
  readonly configCwd: string;
  readonly inboxDirectory: string;
  readonly maximumBytes?: number;
  readonly operatorCwd: string;
  readonly performHandoffCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
  readonly reportCleanupFailure?: () => void;
  readonly signal?: AbortSignal;
}

export interface StagedCursorUsageExport {
  readonly alreadyImported: boolean;
  readonly path: string;
}

export interface ScavengeUsageEngineInboxOptions {
  readonly gracePeriodMs: number;
  readonly inboxDirectory: string;
  readonly maximumEntries?: number;
  readonly now?: number;
}

export interface ScavengeUsageEngineInboxResult {
  readonly deletedBytes: number;
  readonly deletedFiles: number;
  readonly skippedSuspicious: number;
}

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const toFileFingerprint = (stats: Stats): FileFingerprint => ({
  changedAtMilliseconds: stats.ctimeMs,
  dev: stats.dev,
  ino: stats.ino,
  mode: stats.mode,
  modifiedAtMilliseconds: stats.mtimeMs,
  nlink: stats.nlink,
  size: stats.size,
  uid: stats.uid,
});

const sameFingerprint = (left: FileFingerprint, right: FileFingerprint): boolean =>
  sameIdentity(left, right) &&
  left.changedAtMilliseconds === right.changedAtMilliseconds &&
  left.mode === right.mode &&
  left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.uid === right.uid;

const hasCurrentOwner = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid();

const isOwnerOnly = (mode: number): boolean => process.platform === 'win32' || mode % 0o100 === 0;

const hasExactMode = (mode: number, expectedMode: number): boolean =>
  process.platform === 'win32' || mode % 0o1000 === expectedMode;

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, 'ESRCH');
  }
};

const throwIfSignalAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    const error = new Error('Usage engine input operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
};

const validateCanonicalDirectory = async (directoryValue: string, ownerOnly: boolean): Promise<string> => {
  const directory = path.resolve(directoryValue);
  const stats = await lstat(directory).catch(() => undefined);
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (ownerOnly && !(hasCurrentOwner(stats.uid) && isOwnerOnly(stats.mode))) ||
    (await realpath(directory).catch(() => undefined)) !== directory
  ) {
    throw new Error('Usage engine input directory is unsafe.');
  }
  return directory;
};

const handoffPath = async (input: Extract<UsageEngineFileInput, { kind: 'inbox-handoff' }>, directory: string) => {
  const inboxDirectory = await validateCanonicalDirectory(directory, true);
  const candidate = path.join(inboxDirectory, `${input.handoffId}.upload`);
  if (path.dirname(candidate) !== inboxDirectory) {
    throw new Error('Usage engine inbox handoff escaped its private directory.');
  }
  return candidate;
};

const operatorPath = async (
  input: Extract<UsageEngineFileInput, { kind: 'operator-file' }>,
  operatorCwd: string,
): Promise<string> => {
  const candidate = path.resolve(operatorCwd, input.filePath);
  await validateCanonicalDirectory(path.dirname(candidate), false);
  return candidate;
};

const openCursorUsageInput = async (
  input: UsageEngineFileInput,
  options: Pick<StageCursorUsageExportOptions, 'inboxDirectory' | 'operatorCwd'>,
): Promise<OpenedCursorUsageInput> => {
  const isHandoff = input.kind === 'inbox-handoff';
  const filePath = isHandoff
    ? await handoffPath(input, options.inboxDirectory)
    : await operatorPath(input, options.operatorCwd);
  const before = await lstat(filePath).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error('Usage engine input must be a regular file.');
  }
  if (before.nlink !== 1) {
    throw new Error('Usage engine input must be singly linked.');
  }
  if (!hasCurrentOwner(before.uid)) {
    throw new Error('Usage engine input must be owned by the current user.');
  }
  if (isHandoff && !isOwnerOnly(before.mode)) {
    throw new Error('Usage engine inbox handoff must be owner-only.');
  }
  const beforeFingerprint = toFileFingerprint(before);
  const inputFile = await open(filePath, SAFE_READ_FLAGS);
  try {
    const opened = await inputFile.stat();
    const openedFingerprint = toFileFingerprint(opened);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !hasCurrentOwner(opened.uid) ||
      !sameFingerprint(beforeFingerprint, openedFingerprint) ||
      (isHandoff && !isOwnerOnly(opened.mode))
    ) {
      throw new Error('Usage engine input changed while it was opened.');
    }
    return { file: inputFile, fingerprint: openedFingerprint, isHandoff, path: filePath };
  } catch (cause) {
    await inputFile.close().catch(() => undefined);
    throw cause;
  }
};

const removeCursorHandoffIfUnchanged = async (opened: OpenedCursorUsageInput): Promise<void> => {
  if (!opened.isHandoff) {
    return;
  }
  const current = await lstat(opened.path).catch(() => undefined);
  if (
    !current?.isFile() ||
    current.isSymbolicLink() ||
    !sameFingerprint(opened.fingerprint, toFileFingerprint(current)) ||
    current.nlink !== 1 ||
    !hasCurrentOwner(current.uid) ||
    !isOwnerOnly(current.mode)
  ) {
    throw new Error('Usage engine inbox handoff changed before removal and was preserved.');
  }
  try {
    await unlink(opened.path);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      throw new Error('Usage engine inbox handoff changed before removal and was preserved.');
    }
    throw error;
  }
};

const removeIfUnchanged = async (filePath: string, identity: FileIdentity): Promise<boolean> => {
  const current = await lstat(filePath).catch(() => undefined);
  if (
    !(
      current?.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1 &&
      hasCurrentOwner(current.uid) &&
      isOwnerOnly(current.mode) &&
      sameIdentity(current, identity)
    )
  ) {
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

export const readUsageEngineInput = async (
  input: UsageEngineFileInput,
  options: UsageEngineInputOptions,
): Promise<OpenedUsageEngineInput> => {
  if (!(Number.isSafeInteger(options.maximumBytes) && options.maximumBytes > 0)) {
    throw new Error('Usage engine input byte limit is invalid.');
  }
  const isHandoff = input.kind === 'inbox-handoff';
  const filePath = isHandoff
    ? await handoffPath(input, options.inboxDirectory)
    : await operatorPath(input, options.operatorCwd);
  const before = await lstat(filePath).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error('Usage engine input must be a regular file.');
  }
  if (before.nlink !== 1) {
    throw new Error('Usage engine input must be singly linked.');
  }
  if (!hasCurrentOwner(before.uid)) {
    throw new Error('Usage engine input must be owned by the current user.');
  }
  if (isHandoff && !isOwnerOnly(before.mode)) {
    throw new Error('Usage engine inbox handoff must be owner-only.');
  }
  if (before.size <= 0 || before.size > options.maximumBytes) {
    throw new Error('Usage engine input exceeds its byte limit.');
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines no-follow/nonblocking open flags.
  const inputFile = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await inputFile.stat();
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > options.maximumBytes ||
      opened.nlink !== 1 ||
      !hasCurrentOwner(opened.uid) ||
      !sameIdentity(before, opened) ||
      (isHandoff && !isOwnerOnly(opened.mode))
    ) {
      throw new Error('Usage engine input changed while it was opened.');
    }
    const bytes = await readOpenedFileBounded(inputFile, opened.size);
    const afterOpen = await inputFile.stat();
    if (
      bytes.byteLength !== opened.size ||
      bytes.byteLength > options.maximumBytes ||
      !sameIdentity(opened, afterOpen) ||
      afterOpen.size !== opened.size ||
      afterOpen.nlink !== 1 ||
      !hasCurrentOwner(afterOpen.uid) ||
      (isHandoff && !isOwnerOnly(afterOpen.mode))
    ) {
      throw new Error('Usage engine input changed size while it was read.');
    }
    const after = await lstat(filePath).catch(() => undefined);
    if (
      !(
        after?.isFile() &&
        !after.isSymbolicLink() &&
        sameIdentity(opened, after) &&
        after.size === opened.size &&
        after.nlink === 1 &&
        hasCurrentOwner(after.uid) &&
        (!isHandoff || isOwnerOnly(after.mode))
      )
    ) {
      throw new Error('Usage engine input changed while it was read.');
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Usage engine input must contain valid UTF-8.');
    }
    let removed = false;
    return {
      bytes,
      text,
      ...(isHandoff
        ? {
            remove: async () => {
              if (removed) {
                return;
              }
              if (!(await removeIfUnchanged(filePath, opened))) {
                throw new Error('Usage engine inbox handoff changed before removal and was preserved.');
              }
              removed = true;
            },
          }
        : {}),
    };
  } finally {
    await inputFile.close().catch(() => undefined);
  }
};

export const discardUsageEngineHandoff = async (input: UsageEngineFileInput, inboxDirectory: string): Promise<void> => {
  if (input.kind !== 'inbox-handoff') {
    return;
  }
  const filePath = await handoffPath(input, inboxDirectory);
  const stats = await lstat(filePath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!stats) {
    return;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    !hasCurrentOwner(stats.uid) ||
    !isOwnerOnly(stats.mode)
  ) {
    throw new Error('Usage engine inbox handoff is unsafe and was preserved.');
  }
  if (!(await removeIfUnchanged(filePath, stats))) {
    throw new Error('Usage engine inbox handoff changed before removal and was preserved.');
  }
};

export const scavengeUsageEngineInbox = async ({
  gracePeriodMs,
  inboxDirectory: inboxDirectoryValue,
  maximumEntries = MAX_INBOX_SCAVENGE_ENTRIES,
  now = Date.now(),
}: ScavengeUsageEngineInboxOptions): Promise<ScavengeUsageEngineInboxResult> => {
  if (
    !(
      Number.isSafeInteger(now) &&
      now >= 0 &&
      Number.isSafeInteger(gracePeriodMs) &&
      gracePeriodMs > 0 &&
      Number.isSafeInteger(maximumEntries) &&
      maximumEntries > 0 &&
      maximumEntries <= MAX_INBOX_SCAVENGE_ENTRIES
    )
  ) {
    throw new Error('Usage engine inbox recovery timing is invalid.');
  }
  const inboxStats = await lstat(path.resolve(inboxDirectoryValue)).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!inboxStats) {
    return { deletedBytes: 0, deletedFiles: 0, skippedSuspicious: 0 };
  }
  const inboxDirectory = await validateCanonicalDirectory(inboxDirectoryValue, true);
  const entries = await opendir(inboxDirectory);
  let deletedBytes = 0;
  let deletedFiles = 0;
  let skippedSuspicious = 0;
  let entryCount = 0;
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > maximumEntries) {
      skippedSuspicious += 1;
      break;
    }
    if (!HANDOFF_FILE_PATTERN.test(entry.name)) {
      skippedSuspicious += 1;
      continue;
    }
    const filePath = path.join(inboxDirectory, entry.name);
    const stats = await lstat(filePath).catch(() => undefined);
    if (!stats || stats.mtimeMs > now - gracePeriodMs) {
      continue;
    }
    if (
      !(entry.isFile() && stats.isFile()) ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode)
    ) {
      skippedSuspicious += 1;
      continue;
    }
    const beforeExists = await lstat(filePath).catch(() => undefined);
    if (!(beforeExists && sameIdentity(beforeExists, stats))) {
      skippedSuspicious += 1;
      continue;
    }
    await removeIfUnchanged(filePath, stats);
    if (await lstat(filePath).catch(() => undefined)) {
      skippedSuspicious += 1;
      continue;
    }
    deletedBytes += stats.size;
    deletedFiles += 1;
  }
  return { deletedBytes, deletedFiles, skippedSuspicious };
};

const ensurePrivateChildDirectory = async (parentValue: string, name: string): Promise<string> => {
  const parent = await validateCanonicalDirectory(parentValue, false);
  const directory = path.join(parent, name);
  const existing = await lstat(directory).catch(() => undefined);
  if (!existing) {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  }
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory() || !hasCurrentOwner(before.uid)) {
    throw new Error('Cursor import directory is unsafe.');
  }
  const directoryHandle = await open(directory, SAFE_DIRECTORY_READ_FLAGS);
  try {
    const opened = await directoryHandle.stat();
    if (!(opened.isDirectory() && sameIdentity(before, opened) && hasCurrentOwner(opened.uid))) {
      throw new Error('Cursor import directory changed while it was opened.');
    }
    if (process.platform !== 'win32') {
      await directoryHandle.chmod(PRIVATE_DIRECTORY_MODE);
    }
    const afterOpened = await directoryHandle.stat();
    const afterPath = await lstat(directory);
    if (
      !(afterOpened.isDirectory() && afterPath.isDirectory()) ||
      afterPath.isSymbolicLink() ||
      !sameIdentity(afterOpened, afterPath) ||
      !hasCurrentOwner(afterOpened.uid) ||
      !hasExactMode(afterOpened.mode, PRIVATE_DIRECTORY_MODE) ||
      (await realpath(directory)) !== directory
    ) {
      throw new Error('Cursor import directory changed during validation.');
    }
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
  return directory;
};

interface OpenedManagedCursorArtifact {
  readonly file: FileHandle;
  readonly fingerprint: FileFingerprint;
  readonly path: string;
}

const openManagedCursorArtifact = async (
  filePath: string,
  maximumBytes: number,
): Promise<OpenedManagedCursorArtifact> => {
  const before = await lstat(filePath).catch(() => undefined);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !hasCurrentOwner(before.uid) ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    throw new Error('Cursor import directory contains an unsafe CSV artifact.');
  }
  const beforeFingerprint = toFileFingerprint(before);
  const file = await open(filePath, SAFE_READ_FLAGS);
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !hasCurrentOwner(opened.uid) ||
      !sameFingerprint(beforeFingerprint, toFileFingerprint(opened))
    ) {
      throw new Error('Cursor import artifact changed while it was opened.');
    }
    if (!hasExactMode(opened.mode, PRIVATE_FILE_MODE)) {
      throw new Error('Cursor import artifact is not owner-only.');
    }
    const afterPath = await lstat(filePath).catch(() => undefined);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !hasCurrentOwner(opened.uid) ||
      !hasExactMode(opened.mode, PRIVATE_FILE_MODE) ||
      !afterPath?.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameFingerprint(toFileFingerprint(opened), toFileFingerprint(afterPath))
    ) {
      throw new Error('Cursor import artifact changed during validation.');
    }
    return { file, fingerprint: toFileFingerprint(opened), path: filePath };
  } catch (cause) {
    await file.close().catch(() => undefined);
    throw cause;
  }
};

export const listManagedCursorUsageExportPaths = async (configCwd: string): Promise<readonly string[]> => {
  const importDirectoryValue = path.resolve(configCwd, '.ai-usage', 'cursor-exports');
  const importStats = await lstat(importDirectoryValue).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!importStats) {
    return [];
  }
  const importDirectory = await validateCanonicalDirectory(importDirectoryValue, true);
  const managedPaths: string[] = [];
  let entryCount = 0;
  const entries = await opendir(importDirectory);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_CURSOR_IMPORT_DIRECTORY_ENTRIES) {
      throw new Error('Cursor import directory scan exceeded its bounded entry limit.');
    }
    if (!entry.name.toLowerCase().endsWith('.csv')) {
      continue;
    }
    if (!MANAGED_CURSOR_EXPORT_PATTERN.test(entry.name)) {
      throw new Error('Cursor import directory contains a suspicious CSV artifact.');
    }
    const candidatePath = path.join(importDirectory, entry.name);
    if (!entry.isFile()) {
      throw new Error('Cursor import directory contains an unsafe CSV artifact.');
    }
    const opened = await openManagedCursorArtifact(candidatePath, CURSOR_EXPORT_MAX_BYTES);
    await opened.file.close();
    managedPaths.push(candidatePath);
  }
  return managedPaths.sort((left, right) => left.localeCompare(right));
};

const assertCursorHeader = (text: string): void => {
  const header = text.split(CURSOR_HEADER_SEPARATOR, 1)[0] ?? '';
  if (CURSOR_HEADER_COLUMNS.some((column) => !header.includes(column))) {
    throw new Error('Usage engine input is not a Cursor usage-events CSV export.');
  }
};

const scavengeAbandonedCursorTemporaryFiles = async (importDirectory: string): Promise<void> => {
  let entryCount = 0;
  const entries = await opendir(importDirectory);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_CURSOR_IMPORT_DIRECTORY_ENTRIES) {
      throw new Error('Cursor import temporary scan exceeded its bounded entry limit.');
    }
    const match = CURSOR_TEMPORARY_FILE_PATTERN.exec(entry.name);
    const pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid)) {
      continue;
    }
    const candidatePath = path.join(importDirectory, entry.name);
    const stats = await lstat(candidatePath).catch(() => undefined);
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode)
    ) {
      throw new Error('Cursor import temporary file was suspicious and preserved.');
    }
    if (Date.now() - stats.mtimeMs < CURSOR_TEMPORARY_GRACE_MS || processIsAlive(pid)) {
      continue;
    }
    await removeIfUnchanged(candidatePath, stats);
  }
};

const writeCompleteChunk = async (file: FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await file.write(chunk, offset, chunk.byteLength - offset, null);
    if (written.bytesWritten <= 0) {
      throw new Error('Cursor import temporary file stopped accepting bytes.');
    }
    offset += written.bytesWritten;
  }
};

const decodeCursorChunk = (decoder: TextDecoder, bytes?: Uint8Array): string => {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
  } catch {
    throw new Error('Usage engine input must contain valid UTF-8.');
  }
};

const appendCursorHeaderProbe = (
  current: { complete: boolean; text: string; tooLong: boolean },
  decoded: string,
): { complete: boolean; text: string; tooLong: boolean } => {
  if (current.complete || current.tooLong) {
    return current;
  }
  const newlineIndex = decoded.indexOf('\n');
  const nextText = newlineIndex === -1 ? decoded : decoded.slice(0, newlineIndex);
  const remainingCharacters = CURSOR_HEADER_PROBE_CHARACTERS - current.text.length;
  if (nextText.length > remainingCharacters) {
    return { complete: false, text: `${current.text}${nextText.slice(0, remainingCharacters)}`, tooLong: true };
  }
  return {
    complete: newlineIndex !== -1,
    text: `${current.text}${nextText}`,
    tooLong: false,
  };
};

const copyCursorInputToTemporary = async (
  opened: OpenedCursorUsageInput,
  temporaryFile: FileHandle,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> => {
  if (opened.fingerprint.size <= 0 || opened.fingerprint.size > maximumBytes) {
    throw new Error('Usage engine input exceeds its byte limit.');
  }
  const buffer = Buffer.allocUnsafe(CURSOR_COPY_CHUNK_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const hash = createHash('sha256');
  let header = { complete: false, text: '', tooLong: false };
  let totalBytes = 0;
  while (true) {
    throwIfSignalAborted(signal);
    const remainingWithSentinel = maximumBytes + 1 - totalBytes;
    if (remainingWithSentinel <= 0) {
      throw new Error('Usage engine input exceeds its byte limit.');
    }
    const requestedBytes = Math.min(buffer.byteLength, remainingWithSentinel);
    const read = await opened.file.read(buffer, 0, requestedBytes, null);
    if (read.bytesRead === 0) {
      break;
    }
    totalBytes += read.bytesRead;
    if (totalBytes > maximumBytes) {
      throw new Error('Usage engine input exceeds its byte limit.');
    }
    const chunk = buffer.subarray(0, read.bytesRead);
    hash.update(chunk);
    header = appendCursorHeaderProbe(header, decodeCursorChunk(decoder, chunk));
    await writeCompleteChunk(temporaryFile, chunk);
  }
  header = appendCursorHeaderProbe(header, decodeCursorChunk(decoder));
  if (header.tooLong) {
    throw new Error('Usage engine input has an overlong Cursor CSV header.');
  }
  assertCursorHeader(header.text);
  const afterOpen = await opened.file.stat();
  const afterPath = await lstat(opened.path).catch(() => undefined);
  if (
    totalBytes !== opened.fingerprint.size ||
    !sameFingerprint(opened.fingerprint, toFileFingerprint(afterOpen)) ||
    !afterPath?.isFile() ||
    afterPath.isSymbolicLink() ||
    !sameFingerprint(opened.fingerprint, toFileFingerprint(afterPath))
  ) {
    throw new Error('Usage engine input changed while it was streamed.');
  }
  if (process.platform !== 'win32') {
    await temporaryFile.chmod(PRIVATE_FILE_MODE);
  }
  const temporaryStats = await temporaryFile.stat();
  if (
    !temporaryStats.isFile() ||
    temporaryStats.isSymbolicLink() ||
    temporaryStats.nlink !== 1 ||
    !hasCurrentOwner(temporaryStats.uid) ||
    !hasExactMode(temporaryStats.mode, PRIVATE_FILE_MODE) ||
    temporaryStats.size !== totalBytes
  ) {
    throw new Error('Cursor import temporary file is unsafe.');
  }
  await temporaryFile.sync();
  return hash.digest('hex');
};

const hashManagedCursorArtifact = async (
  opened: OpenedManagedCursorArtifact,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> => {
  const buffer = Buffer.allocUnsafe(CURSOR_COPY_CHUNK_BYTES);
  const hash = createHash('sha256');
  let totalBytes = 0;
  while (true) {
    throwIfSignalAborted(signal);
    const remainingWithSentinel = maximumBytes + 1 - totalBytes;
    if (remainingWithSentinel <= 0) {
      throw new Error('Cursor import artifact exceeds its byte limit.');
    }
    const read = await opened.file.read(buffer, 0, Math.min(buffer.byteLength, remainingWithSentinel), null);
    if (read.bytesRead === 0) {
      break;
    }
    totalBytes += read.bytesRead;
    if (totalBytes > maximumBytes) {
      throw new Error('Cursor import artifact exceeds its byte limit.');
    }
    hash.update(buffer.subarray(0, read.bytesRead));
  }
  const afterOpen = await opened.file.stat();
  const afterPath = await lstat(opened.path).catch(() => undefined);
  if (
    totalBytes !== opened.fingerprint.size ||
    !sameFingerprint(opened.fingerprint, toFileFingerprint(afterOpen)) ||
    !afterPath?.isFile() ||
    afterPath.isSymbolicLink() ||
    !sameFingerprint(opened.fingerprint, toFileFingerprint(afterPath))
  ) {
    throw new Error('Cursor import artifact changed while it was hashed.');
  }
  return hash.digest('hex');
};

const repairManagedCursorArtifactMode = async (filePath: string, maximumBytes: number): Promise<string | undefined> => {
  const before = await lstat(filePath).catch(() => undefined);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !hasCurrentOwner(before.uid) ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    throw new Error('Cursor import directory contains an unsafe CSV artifact.');
  }
  if (hasExactMode(before.mode, PRIVATE_FILE_MODE)) {
    return;
  }
  const beforeFingerprint = toFileFingerprint(before);
  const source = await open(filePath, SAFE_READ_FLAGS);
  const temporaryPath = path.join(path.dirname(filePath), `.cursor-${process.pid}-${randomUUID()}.tmp`);
  let temporaryFile: FileHandle | undefined;
  try {
    const opened = await source.stat();
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !hasCurrentOwner(opened.uid) ||
      !sameFingerprint(beforeFingerprint, toFileFingerprint(opened))
    ) {
      throw new Error('Cursor import artifact changed while it was opened for mode repair.');
    }
    temporaryFile = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    const buffer = Buffer.allocUnsafe(CURSOR_COPY_CHUNK_BYTES);
    const hash = createHash('sha256');
    let totalBytes = 0;
    while (true) {
      const remainingWithSentinel = maximumBytes + 1 - totalBytes;
      if (remainingWithSentinel <= 0) {
        throw new Error('Cursor import artifact exceeds its byte limit.');
      }
      const read = await source.read(buffer, 0, Math.min(buffer.byteLength, remainingWithSentinel), null);
      if (read.bytesRead === 0) {
        break;
      }
      totalBytes += read.bytesRead;
      if (totalBytes > maximumBytes) {
        throw new Error('Cursor import artifact exceeds its byte limit.');
      }
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      await writeCompleteChunk(temporaryFile, chunk);
    }
    const afterOpen = await source.stat();
    const afterPath = await lstat(filePath).catch(() => undefined);
    if (
      totalBytes !== beforeFingerprint.size ||
      !sameFingerprint(beforeFingerprint, toFileFingerprint(afterOpen)) ||
      !afterPath?.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameFingerprint(beforeFingerprint, toFileFingerprint(afterPath))
    ) {
      throw new Error('Cursor import artifact changed while its mode was repaired.');
    }
    if (process.platform !== 'win32') {
      await temporaryFile.chmod(PRIVATE_FILE_MODE);
    }
    const temporaryStats = await temporaryFile.stat();
    if (
      !temporaryStats.isFile() ||
      temporaryStats.isSymbolicLink() ||
      temporaryStats.nlink !== 1 ||
      !hasCurrentOwner(temporaryStats.uid) ||
      !hasExactMode(temporaryStats.mode, PRIVATE_FILE_MODE) ||
      temporaryStats.size !== totalBytes
    ) {
      throw new Error('Cursor import mode-repair temporary file is unsafe.');
    }
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await source.close();
    await rename(temporaryPath, filePath);
    const repaired = await lstat(filePath);
    if (
      !repaired.isFile() ||
      repaired.isSymbolicLink() ||
      repaired.nlink !== 1 ||
      !sameIdentity(temporaryStats, repaired) ||
      !hasCurrentOwner(repaired.uid) ||
      !hasExactMode(repaired.mode, PRIVATE_FILE_MODE) ||
      repaired.size !== totalBytes
    ) {
      throw new Error('Cursor import artifact mode repair could not be validated.');
    }
    await syncDirectory(path.dirname(filePath));
    return hash.digest('hex');
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const managedCursorArtifactNames = async (importDirectory: string): Promise<readonly string[]> => {
  const names: string[] = [];
  let entryCount = 0;
  const entries = await opendir(importDirectory);
  for await (const entry of entries) {
    entryCount++;
    if (entryCount > MAX_CURSOR_IMPORT_DIRECTORY_ENTRIES) {
      throw new Error('Cursor import directory scan exceeded its bounded entry limit.');
    }
    if (!entry.name.toLowerCase().endsWith('.csv')) {
      continue;
    }
    if (!(entry.isFile() && MANAGED_CURSOR_EXPORT_PATTERN.test(entry.name))) {
      throw new Error('Cursor import directory contains a suspicious CSV artifact.');
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
};

const findMatchingManagedCursorArtifact = async (
  importDirectory: string,
  digest: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  for (const name of await managedCursorArtifactNames(importDirectory)) {
    const candidatePath = path.join(importDirectory, name);
    const repairedDigest = await repairManagedCursorArtifactMode(candidatePath, maximumBytes);
    if (repairedDigest !== undefined) {
      if (repairedDigest === digest) {
        return candidatePath;
      }
      continue;
    }
    const opened = await openManagedCursorArtifact(candidatePath, maximumBytes);
    try {
      if ((await hashManagedCursorArtifact(opened, maximumBytes, signal)) === digest) {
        return candidatePath;
      }
    } finally {
      await opened.file.close().catch(() => undefined);
    }
  }
};

export const repairManagedCursorUsageExportModes = async (configCwd: string): Promise<void> => {
  const importDirectoryValue = path.resolve(configCwd, '.ai-usage', 'cursor-exports');
  const importStats = await lstat(importDirectoryValue).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!importStats) {
    return;
  }
  const importDirectory = await validateCanonicalDirectory(importDirectoryValue, true);
  for (const name of await managedCursorArtifactNames(importDirectory)) {
    const candidatePath = path.join(importDirectory, name);
    const repairedDigest = await repairManagedCursorArtifactMode(candidatePath, CURSOR_EXPORT_MAX_BYTES);
    if (repairedDigest === undefined) {
      const opened = await openManagedCursorArtifact(candidatePath, CURSOR_EXPORT_MAX_BYTES);
      await opened.file.close();
    }
  }
};

const safeCursorImportName = (filePath: string): string => {
  const sanitized = path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return sanitized.toLowerCase().endsWith('.csv') ? sanitized : `${sanitized}.csv`;
};

const cursorDestinationPath = (opened: OpenedCursorUsageInput, importDirectory: string, digest: string): string =>
  path.join(
    importDirectory,
    opened.isHandoff ? `${digest}.csv` : `${digest.slice(0, 12)}-${safeCursorImportName(opened.path)}`,
  );

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, SAFE_DIRECTORY_READ_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const runWithCursorInputCleanup = async <Value>(
  opened: OpenedCursorUsageInput,
  operation: () => Promise<Value>,
  options: Pick<StageCursorUsageExportOptions, 'performHandoffCleanup' | 'reportCleanupFailure'>,
): Promise<Value> => {
  let outcome = await operation().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  try {
    await opened.file.close();
  } catch (closeError) {
    if (outcome.ok) {
      outcome = { error: closeError, ok: false as const };
    }
  }
  if (!opened.isHandoff) {
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }
  try {
    const cleanup = async () => await removeCursorHandoffIfUnchanged(opened);
    if (options.performHandoffCleanup) {
      await options.performHandoffCleanup(cleanup);
    } else {
      await cleanup();
    }
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError([outcome.error, cleanupError], 'Cursor import and private handoff cleanup both failed.');
    }
    try {
      options.reportCleanupFailure?.();
    } catch {
      // Diagnostic callbacks cannot invalidate a durable Cursor stage.
    }
    return outcome.value;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
};

export const stageCursorUsageExport = async (
  input: UsageEngineFileInput,
  options: StageCursorUsageExportOptions,
): Promise<StagedCursorUsageExport> => {
  const maximumBytes = options.maximumBytes ?? CURSOR_EXPORT_MAX_BYTES;
  if (!(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= CURSOR_EXPORT_MAX_BYTES)) {
    throw new Error('Cursor import byte limit is invalid.');
  }
  const opened = await openCursorUsageInput(input, options);
  return await runWithCursorInputCleanup(
    opened,
    async () => {
      throwIfSignalAborted(options.signal);
      const aiUsageDirectory = await ensurePrivateChildDirectory(options.configCwd, '.ai-usage');
      const importDirectory = await ensurePrivateChildDirectory(aiUsageDirectory, 'cursor-exports');
      await scavengeAbandonedCursorTemporaryFiles(importDirectory);
      const temporaryPath = path.join(importDirectory, `.cursor-${process.pid}-${randomUUID()}.tmp`);
      let temporaryFile: FileHandle | undefined;
      try {
        temporaryFile = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
        const digest = await copyCursorInputToTemporary(opened, temporaryFile, maximumBytes, options.signal);
        const temporaryStats = await temporaryFile.stat();
        await temporaryFile.close();
        temporaryFile = undefined;
        throwIfSignalAborted(options.signal);
        const destination = cursorDestinationPath(opened, importDirectory, digest);
        const matchingPath = await findMatchingManagedCursorArtifact(
          importDirectory,
          digest,
          maximumBytes,
          options.signal,
        );
        if (matchingPath) {
          return { alreadyImported: true, path: matchingPath };
        }
        throwIfSignalAborted(options.signal);
        if (await lstat(destination).catch(() => undefined)) {
          throw new Error('Cursor import destination has unexpected content.');
        }
        await rename(temporaryPath, destination);
        const published = await lstat(destination);
        if (
          !published.isFile() ||
          published.isSymbolicLink() ||
          published.nlink !== 1 ||
          !sameIdentity(temporaryStats, published) ||
          !hasCurrentOwner(published.uid) ||
          !hasExactMode(published.mode, PRIVATE_FILE_MODE) ||
          published.size !== temporaryStats.size
        ) {
          throw new Error('Cursor import destination failed validation.');
        }
        await syncDirectory(importDirectory);
        return { alreadyImported: false, path: destination };
      } finally {
        await temporaryFile?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
    },
    options,
  );
};
