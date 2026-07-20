import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_REPORT_RUNNER_ARTIFACT_BYTES,
  MAX_SESSION_QUERY_DATABASE_BYTES,
} from '@ai-usage/report-core/report-budgets';
import {
  type SessionDetailSourceAuthority,
  sessionDetailSourceAuthorities,
} from '@ai-usage/report-core/session-detail';
import { sessionRowIdentity } from '@ai-usage/report-core/session-query';
import {
  parseReportRevision,
  type ReportRequestFingerprint,
  type ReportRevision,
  type RevisionExpiredError,
  reportManifestRequestFingerprint,
  reportSliceRequestFingerprint,
  splitWebReportPayload,
  type WebReportPayload,
  type WebReportPayloadWithoutRows,
  type WebReportRevisionManifest,
  type WebReportRevisionManifestResult,
  type WebReportRowsSliceResult,
  type WebReportSliceRequest,
  type WebReportSupportSliceResult,
} from '../web-report-payload';

const REVISION_SCHEMA_VERSION = 1;
const ROWS_ARTIFACT_NAME = 'rows.json';
const ROW_SOURCE_AUTHORITIES_ARTIFACT_NAME = 'row-source-authorities.json';
const SUPPORT_ARTIFACT_NAME = 'support.json';
const MANIFEST_ARTIFACT_NAME = 'manifest.json';
const SESSION_QUERY_ARTIFACT_NAME = 'sessions.sqlite';
const ARTIFACT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_REVISION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETAINED_REVISIONS = 3;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_MANIFEST_KEYS = [
  'captureFingerprint',
  'expiresAt',
  'generatedAt',
  'payloadFingerprint',
  'publishedAt',
  'revision',
  'rowsArtifact',
  'rowsBytes',
  'schemaVersion',
  'supportArtifact',
  'supportBytes',
] as const;
const REVISION_MANIFEST_WITH_SESSION_QUERY_KEYS = [
  ...REVISION_MANIFEST_KEYS,
  'sessionQueryArtifact',
  'sessionQueryBytes',
] as const;
const REVISION_ARTIFACT_MANIFEST_KEYS = ['bytes', 'file', 'sha256'] as const;
const createFileFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const readFileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

interface RevisionArtifactManifest {
  bytes: number;
  file: string;
  sha256: string;
}

interface RevisionDiskManifest extends WebReportRevisionManifest {
  payloadFingerprint: string;
  rowsArtifact: RevisionArtifactManifest;
  schemaVersion: typeof REVISION_SCHEMA_VERSION;
  sessionQueryArtifact?: RevisionArtifactManifest;
  supportArtifact: RevisionArtifactManifest;
}

interface SessionQuerySnapshotIdentity {
  changedAtNanoseconds: string;
  device: string;
  inode: string;
  links: string;
  modifiedAtNanoseconds: string;
  size: string;
}

interface SessionQuerySnapshotValue {
  directory: string;
  identity: SessionQuerySnapshotIdentity;
}

interface SessionQuerySnapshot {
  promise: Promise<SessionQuerySnapshotValue>;
  reject: (error: unknown) => void;
  resolve: (value: SessionQuerySnapshotValue) => void;
  value?: SessionQuerySnapshotValue;
}

interface RevisionEntry {
  directory: string;
  manifest: RevisionDiskManifest;
  privateCaptureFingerprint: string;
  references: number;
  sessionQuerySnapshot?: SessionQuerySnapshot | undefined;
}

export interface ReportRevisionRegistryOptions {
  materialize?: (stagingDirectory: string) => Promise<void>;
  maxRetainedRevisions?: number;
  now?: () => number;
  revisionId?: () => string;
  rootDirectory?: string;
  ttlMs?: number;
}

export type ReportRevisionLeaseResult<Result> =
  | { manifest: WebReportRevisionManifest; ok: true; value: Result }
  | { error: RevisionExpiredError; ok: false };

export interface ReportRevisionRegistry {
  dispose(): Promise<void>;
  getCurrentManifest(): Promise<WebReportRevisionManifestResult>;
  getCurrentManifestForCapture(privateCaptureFingerprint: string): Promise<WebReportRevisionManifestResult>;
  invalidateLatest(): Promise<void>;
  publish(
    payload: WebReportPayload,
    options?: {
      rowSourceAuthorities?: readonly SessionDetailSourceAuthority[];
    },
  ): Promise<WebReportRevisionManifest>;
  readRows(request: WebReportSliceRequest): Promise<WebReportRowsSliceResult>;
  readSupport(request: WebReportSliceRequest): Promise<WebReportSupportSliceResult>;
  renewCurrentForCapture(
    expectedRevision: ReportRevision,
    privateCaptureFingerprint: string,
  ): Promise<WebReportRevisionManifestResult>;
  withSessionQueryLease<Result>(
    revision: ReportRevision,
    operation: (directory: string, manifest: WebReportRevisionManifest) => Promise<Result>,
  ): Promise<ReportRevisionLeaseResult<Result>>;
}

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';

const sha256 = (serialized: string): string => createHash('sha256').update(serialized).digest('hex');

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
};

export const reportCaptureFingerprintForPayload = (
  payload: WebReportPayload,
  rowSourceAuthorities?: readonly SessionDetailSourceAuthority[],
): string => {
  const { generatedAt: _generatedAt, ...semanticPayload } = payload;
  const fingerprintInput =
    rowSourceAuthorities === undefined ? semanticPayload : { payload: semanticPayload, rowSourceAuthorities };
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(fingerprintInput)))
    .digest('hex');
};

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));

const defaultRevisionId = (): string => `${Date.now().toString(36)}-${randomBytes(16).toString('hex')}`;

const revisionExpired = (revision: ReportRevision): RevisionExpiredError => ({
  message: `Report revision ${revision} is missing or expired; request a new manifest and restart the refresh.`,
  revision,
  tag: 'RevisionExpired',
});

const publicManifest = (manifest: RevisionDiskManifest): WebReportRevisionManifest => ({
  captureFingerprint: manifest.captureFingerprint,
  expiresAt: manifest.expiresAt,
  generatedAt: manifest.generatedAt,
  publishedAt: manifest.publishedAt,
  revision: manifest.revision,
  rowsBytes: manifest.rowsBytes,
  ...(manifest.sessionQueryBytes === undefined ? {} : { sessionQueryBytes: manifest.sessionQueryBytes }),
  supportBytes: manifest.supportBytes,
});

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  const directoryStat = await stat(directory);
  if (
    !(
      directoryStat.isDirectory() &&
      hasOwnerOnlyPermissions(directoryStat.mode) &&
      isOwnedByCurrentUser(directoryStat.uid)
    )
  ) {
    throw new Error('Report revision storage must be a private directory owned by the current user');
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncFile = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, readFileFlags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const removeRevisionDirectory = async (directory: string): Promise<void> => {
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  await rm(directory, { force: true, recursive: true });
};

const writePrivateArtifact = async (filePath: string, serialized: string): Promise<void> => {
  const handle = await open(filePath, createFileFlags, 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
};

const readPrivateArtifact = async (filePath: string, maximumBytes: number): Promise<string> => {
  const handle = await open(filePath, readFileFlags);
  try {
    const artifactStat = await handle.stat();
    if (
      !(artifactStat.isFile() && hasOwnerOnlyPermissions(artifactStat.mode) && isOwnedByCurrentUser(artifactStat.uid))
    ) {
      throw new Error('Report revision artifact must be a private regular file owned by the current user');
    }
    if (artifactStat.size > maximumBytes) {
      throw new Error(`Report revision artifact exceeds the ${maximumBytes}-byte limit`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const remainingBytes = maximumBytes + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(ARTIFACT_READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (totalBytes > maximumBytes) {
      throw new Error(`Report revision artifact exceeds the ${maximumBytes}-byte limit`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
  } finally {
    await handle.close();
  }
};

const parseDiskManifest = (serialized: string, expectedRevision: ReportRevision): RevisionDiskManifest => {
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Report revision manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  const rowsArtifact = manifest.rowsArtifact as Record<string, unknown> | undefined;
  const sessionQueryArtifact = manifest.sessionQueryArtifact as Record<string, unknown> | undefined;
  const supportArtifact = manifest.supportArtifact as Record<string, unknown> | undefined;
  const revision = parseReportRevision(manifest.revision);
  const validArtifact = (artifact: Record<string, unknown> | undefined, expectedFile: string): boolean =>
    artifact !== undefined &&
    hasExactKeys(artifact, REVISION_ARTIFACT_MANIFEST_KEYS) &&
    artifact.file === expectedFile &&
    typeof artifact.bytes === 'number' &&
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes >= 0 &&
    typeof artifact.sha256 === 'string' &&
    SHA256_PATTERN.test(artifact.sha256);
  const includesSessionQuery = sessionQueryArtifact !== undefined || manifest.sessionQueryBytes !== undefined;
  if (
    !hasExactKeys(
      manifest,
      includesSessionQuery ? REVISION_MANIFEST_WITH_SESSION_QUERY_KEYS : REVISION_MANIFEST_KEYS,
    ) ||
    revision !== expectedRevision ||
    manifest.schemaVersion !== REVISION_SCHEMA_VERSION ||
    typeof manifest.captureFingerprint !== 'string' ||
    !SHA256_PATTERN.test(manifest.captureFingerprint) ||
    typeof manifest.payloadFingerprint !== 'string' ||
    !SHA256_PATTERN.test(manifest.payloadFingerprint) ||
    typeof manifest.generatedAt !== 'string' ||
    manifest.generatedAt.length === 0 ||
    typeof manifest.publishedAt !== 'number' ||
    !Number.isSafeInteger(manifest.publishedAt) ||
    typeof manifest.expiresAt !== 'number' ||
    !Number.isSafeInteger(manifest.expiresAt) ||
    manifest.expiresAt <= manifest.publishedAt ||
    typeof manifest.rowsBytes !== 'number' ||
    !Number.isSafeInteger(manifest.rowsBytes) ||
    typeof manifest.supportBytes !== 'number' ||
    !Number.isSafeInteger(manifest.supportBytes) ||
    (includesSessionQuery &&
      (!validArtifact(sessionQueryArtifact, SESSION_QUERY_ARTIFACT_NAME) ||
        typeof manifest.sessionQueryBytes !== 'number' ||
        !Number.isSafeInteger(manifest.sessionQueryBytes) ||
        sessionQueryArtifact?.bytes !== manifest.sessionQueryBytes ||
        manifest.sessionQueryBytes > MAX_SESSION_QUERY_DATABASE_BYTES)) ||
    !validArtifact(rowsArtifact, ROWS_ARTIFACT_NAME) ||
    !validArtifact(supportArtifact, SUPPORT_ARTIFACT_NAME) ||
    rowsArtifact?.bytes !== manifest.rowsBytes ||
    supportArtifact?.bytes !== manifest.supportBytes ||
    manifest.rowsBytes + manifest.supportBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES
  ) {
    throw new Error('Report revision manifest is invalid');
  }
  return value as RevisionDiskManifest;
};

const readValidatedArtifact = async (directory: string, artifact: RevisionArtifactManifest): Promise<string> => {
  const serialized = await readPrivateArtifact(path.join(directory, artifact.file), artifact.bytes);
  if (Buffer.byteLength(serialized) !== artifact.bytes || sha256(serialized) !== artifact.sha256) {
    throw new Error(`Report revision artifact ${artifact.file} does not match its manifest`);
  }
  return serialized;
};

const inspectPrivateArtifact = async (
  filePath: string,
  file: string,
  maximumBytes: number,
): Promise<RevisionArtifactManifest> => {
  const handle = await open(filePath, readFileFlags);
  try {
    const artifactStat = await handle.stat();
    if (
      !(artifactStat.isFile() && hasOwnerOnlyPermissions(artifactStat.mode) && isOwnedByCurrentUser(artifactStat.uid))
    ) {
      throw new Error('Report revision artifact must be a private regular file owned by the current user');
    }
    if (artifactStat.size > maximumBytes) {
      throw new Error(`Report revision artifact exceeds the ${maximumBytes}-byte limit`);
    }
    const digest = createHash('sha256');
    let bytes = 0;
    while (bytes <= maximumBytes) {
      const remainingBytes = maximumBytes + 1 - bytes;
      const buffer = Buffer.alloc(Math.min(ARTIFACT_READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (bytes > maximumBytes) {
      throw new Error(`Report revision artifact exceeds the ${maximumBytes}-byte limit`);
    }
    return { bytes, file, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
};

const createPendingSessionQuerySnapshot = (): SessionQuerySnapshot => {
  let rejectSnapshot: (error: unknown) => void = () => undefined;
  let resolveSnapshot: (value: SessionQuerySnapshotValue) => void = () => undefined;
  const promise = new Promise<SessionQuerySnapshotValue>((resolve, reject) => {
    rejectSnapshot = reject;
    resolveSnapshot = resolve;
  });
  return { promise, reject: rejectSnapshot, resolve: resolveSnapshot };
};

const createValidatedSessionQuerySnapshotDirectory = async (
  entry: RevisionEntry,
): Promise<SessionQuerySnapshotValue> => {
  const expected = entry.manifest.sessionQueryArtifact;
  if (!expected) {
    throw new Error('Report revision does not contain a Session query artifact');
  }
  const leaseDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-query-lease-'));
  await chmod(leaseDirectory, 0o700);
  let completed = false;
  try {
    const destinationPath = path.join(leaseDirectory, SESSION_QUERY_ARTIFACT_NAME);
    const source = await open(path.join(entry.directory, expected.file), readFileFlags);
    try {
      const destination = await open(destinationPath, createFileFlags, 0o600);
      try {
        const sourceStat = await source.stat();
        if (
          !(sourceStat.isFile() && hasOwnerOnlyPermissions(sourceStat.mode) && isOwnedByCurrentUser(sourceStat.uid))
        ) {
          throw new Error('Report revision artifact must be a private regular file owned by the current user');
        }
        if (sourceStat.size > MAX_SESSION_QUERY_DATABASE_BYTES) {
          throw new Error(`Report revision artifact exceeds the ${MAX_SESSION_QUERY_DATABASE_BYTES}-byte limit`);
        }

        const digest = createHash('sha256');
        let copiedBytes = 0;
        while (copiedBytes <= MAX_SESSION_QUERY_DATABASE_BYTES) {
          const remainingBytes = MAX_SESSION_QUERY_DATABASE_BYTES + 1 - copiedBytes;
          const buffer = Buffer.alloc(Math.min(ARTIFACT_READ_CHUNK_BYTES, remainingBytes));
          const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) {
            break;
          }
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk);
          await destination.writeFile(chunk);
          copiedBytes += bytesRead;
        }
        if (copiedBytes > MAX_SESSION_QUERY_DATABASE_BYTES) {
          throw new Error(`Report revision artifact exceeds the ${MAX_SESSION_QUERY_DATABASE_BYTES}-byte limit`);
        }
        if (copiedBytes !== expected.bytes || digest.digest('hex') !== expected.sha256) {
          throw new Error('Report revision Session query artifact does not match its manifest');
        }
        await destination.sync();
      } finally {
        await destination.close();
      }
    } finally {
      await source.close();
    }
    await chmod(destinationPath, 0o400);
    await syncFile(destinationPath);
    await chmod(leaseDirectory, 0o500);
    await syncDirectory(leaseDirectory);
    const identity = await inspectSessionQuerySnapshot(leaseDirectory, expected.bytes);
    completed = true;
    return { directory: leaseDirectory, identity };
  } finally {
    if (!completed) {
      await removeRevisionDirectory(leaseDirectory);
    }
  }
};

const inspectSessionQuerySnapshot = async (
  directory: string,
  expectedBytes: number,
): Promise<SessionQuerySnapshotIdentity> => {
  await ensurePrivateDirectory(directory);
  const handle = await open(path.join(directory, SESSION_QUERY_ARTIFACT_NAME), readFileFlags);
  try {
    const snapshotStat = await handle.stat({ bigint: true });
    if (
      !(
        snapshotStat.isFile() &&
        hasOwnerOnlyPermissions(Number(snapshotStat.mode)) &&
        isOwnedByCurrentUser(Number(snapshotStat.uid)) &&
        snapshotStat.size === BigInt(expectedBytes)
      )
    ) {
      throw new Error('Session query snapshot must be a private regular file matching its manifest size');
    }
    return {
      changedAtNanoseconds: snapshotStat.ctimeNs.toString(),
      device: snapshotStat.dev.toString(),
      inode: snapshotStat.ino.toString(),
      links: snapshotStat.nlink.toString(),
      modifiedAtNanoseconds: snapshotStat.mtimeNs.toString(),
      size: snapshotStat.size.toString(),
    };
  } finally {
    await handle.close();
  }
};

const validateSessionQuerySnapshot = async (
  snapshot: SessionQuerySnapshotValue,
  expectedBytes: number,
): Promise<void> => {
  const observedIdentity = await inspectSessionQuerySnapshot(snapshot.directory, expectedBytes);
  const expectedIdentity = snapshot.identity;
  if (
    observedIdentity.changedAtNanoseconds !== expectedIdentity.changedAtNanoseconds ||
    observedIdentity.device !== expectedIdentity.device ||
    observedIdentity.inode !== expectedIdentity.inode ||
    observedIdentity.links !== expectedIdentity.links ||
    observedIdentity.modifiedAtNanoseconds !== expectedIdentity.modifiedAtNanoseconds ||
    observedIdentity.size !== expectedIdentity.size
  ) {
    throw new Error('Session query snapshot changed since validation');
  }
};

const copyValidatedPrivateArtifact = async (
  sourcePath: string,
  destinationPath: string,
  expected: RevisionArtifactManifest,
  maximumBytes: number,
): Promise<RevisionArtifactManifest> => {
  const inspectedSource = await inspectPrivateArtifact(sourcePath, expected.file, maximumBytes);
  if (inspectedSource.bytes !== expected.bytes || inspectedSource.sha256 !== expected.sha256) {
    throw new Error(`Report revision ${expected.file} artifact does not match its manifest`);
  }
  const source = await open(sourcePath, readFileFlags);
  const destination = await open(destinationPath, createFileFlags, 0o600);
  try {
    let copiedBytes = 0;
    while (copiedBytes <= maximumBytes) {
      const remainingBytes = maximumBytes + 1 - copiedBytes;
      const buffer = Buffer.alloc(Math.min(ARTIFACT_READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      await destination.write(buffer.subarray(0, bytesRead));
      copiedBytes += bytesRead;
    }
    if (copiedBytes > maximumBytes) {
      throw new Error(`Report revision artifact exceeds the ${maximumBytes}-byte limit`);
    }
    await destination.sync();
  } finally {
    await Promise.all([source.close(), destination.close()]);
  }
  await chmod(destinationPath, 0o600);
  const copied = await inspectPrivateArtifact(destinationPath, expected.file, maximumBytes);
  if (copied.bytes !== expected.bytes || copied.sha256 !== expected.sha256) {
    throw new Error(`Copied report revision ${expected.file} artifact does not match its source`);
  }
  return copied;
};

export const createReportRevisionRegistry = (options: ReportRevisionRegistryOptions = {}): ReportRevisionRegistry => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_REVISION_TTL_MS;
  const maxRetainedRevisions = options.maxRetainedRevisions ?? DEFAULT_MAX_RETAINED_REVISIONS;
  const createRevisionId = options.revisionId ?? defaultRevisionId;
  if (!(Number.isSafeInteger(ttlMs) && ttlMs > 0)) {
    throw new Error('Report revision TTL must be a positive safe integer');
  }
  if (!(Number.isSafeInteger(maxRetainedRevisions) && maxRetainedRevisions > 0)) {
    throw new Error('Maximum retained report revisions must be a positive safe integer');
  }

  const ownsRootDirectory = options.rootDirectory === undefined;
  const rootDirectoryPromise = (async () => {
    if (options.rootDirectory === undefined) {
      const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-revisions-'));
      await chmod(directory, 0o700);
      return directory;
    }
    await mkdir(options.rootDirectory, { mode: 0o700, recursive: true });
    await chmod(options.rootDirectory, 0o700);
    await ensurePrivateDirectory(options.rootDirectory);
    return options.rootDirectory;
  })();
  const entries = new Map<ReportRevision, RevisionEntry>();
  let currentRevision: ReportRevision | undefined;
  let currentPublicationSequence = 0;
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;
  let lockTail: Promise<void> = Promise.resolve();
  let nextPublicationSequence = 0;
  const referenceDrainWaiters = new Set<() => void>();

  const withLock = <Result>(operation: () => Promise<Result> | Result): Promise<Result> => {
    const result = lockTail.then(operation, operation);
    lockTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const removeEntryArtifacts = async (entry: RevisionEntry): Promise<void> => {
    const snapshotDirectory = entry.sessionQuerySnapshot?.value?.directory;
    await Promise.all([
      removeRevisionDirectory(entry.directory),
      ...(snapshotDirectory === undefined ? [] : [removeRevisionDirectory(snapshotDirectory)]),
    ]);
  };

  const notifyReferenceDrainLocked = (): void => {
    if ([...entries.values()].some((entry) => entry.references > 0)) {
      return;
    }
    for (const resolve of referenceDrainWaiters) {
      resolve();
    }
    referenceDrainWaiters.clear();
  };

  const waitForReferenceDrainLocked = (): Promise<void> => {
    if (![...entries.values()].some((entry) => entry.references > 0)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      referenceDrainWaiters.add(resolve);
    });
  };

  const cleanupLocked = async (): Promise<void> => {
    const cleanupStartedAt = now();
    const orderedEntries = [...entries.values()].sort(
      (left, right) => right.manifest.publishedAt - left.manifest.publishedAt,
    );
    if (currentRevision !== undefined) {
      const current = entries.get(currentRevision);
      if (current === undefined || current.manifest.expiresAt <= cleanupStartedAt) {
        currentRevision = undefined;
      }
    }

    const remove = new Set<ReportRevision>();
    for (const entry of orderedEntries) {
      if (entry.manifest.expiresAt <= cleanupStartedAt && entry.references === 0) {
        remove.add(entry.manifest.revision);
      }
    }
    let retainedCount = entries.size - remove.size;
    for (const entry of orderedEntries.toReversed()) {
      if (retainedCount <= maxRetainedRevisions) {
        break;
      }
      if (
        entry.references === 0 &&
        entry.manifest.revision !== currentRevision &&
        !remove.has(entry.manifest.revision)
      ) {
        remove.add(entry.manifest.revision);
        retainedCount--;
      }
    }

    for (const revision of remove) {
      const entry = entries.get(revision);
      if (!entry) {
        continue;
      }
      await removeEntryArtifacts(entry);
      entries.delete(revision);
    }
  };

  const publish = async (
    payload: WebReportPayload,
    publishOptions: {
      rowSourceAuthorities?: readonly SessionDetailSourceAuthority[];
    } = {},
  ): Promise<WebReportRevisionManifest> => {
    if (disposed) {
      throw new Error('Report revision registry has been disposed');
    }
    const publicationSequence = ++nextPublicationSequence;
    const revision = parseReportRevision(createRevisionId());
    const { rowsSlice, supportSlice } = splitWebReportPayload(payload, revision);
    const serializedRows = JSON.stringify(rowsSlice.rows);
    const serializedSupport = JSON.stringify(supportSlice.payloadWithoutRows);
    const rowSourceAuthorities = publishOptions.rowSourceAuthorities ?? rowsSlice.rows.map(() => 'portable-opaque');
    if (rowSourceAuthorities.length !== rowsSlice.rows.length) {
      throw new Error('Report revision row source authorities must align with its rows');
    }
    const rowSourceAuthorityBindings: Array<{ rowId: string; sourceAuthority: SessionDetailSourceAuthority }> = [];
    for (const [index, row] of rowsSlice.rows.entries()) {
      const authorityValue = rowSourceAuthorities[index];
      const sourceAuthority = sessionDetailSourceAuthorities.find((authority) => authority === authorityValue);
      if (!sourceAuthority) {
        throw new Error(`Report revision row ${index} has an invalid source authority`);
      }
      rowSourceAuthorityBindings.push({ rowId: sessionRowIdentity(row), sourceAuthority });
    }
    const serializedRowSourceAuthorities = JSON.stringify(rowSourceAuthorityBindings);
    const rowsBytes = Buffer.byteLength(serializedRows);
    const supportBytes = Buffer.byteLength(serializedSupport);
    if (rowsBytes + supportBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Report revision artifacts exceed the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }
    if (Buffer.byteLength(serializedRowSourceAuthorities) > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(
        `Report revision row source authorities exceed the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`,
      );
    }

    const payloadFingerprint = reportCaptureFingerprintForPayload(payload);
    const privateCaptureFingerprint = reportCaptureFingerprintForPayload(payload, rowSourceAuthorities);
    const publishedAt = now();
    const diskManifest: RevisionDiskManifest = {
      captureFingerprint: payloadFingerprint,
      expiresAt: publishedAt + ttlMs,
      generatedAt: payload.generatedAt,
      payloadFingerprint,
      publishedAt,
      revision,
      rowsArtifact: { bytes: rowsBytes, file: ROWS_ARTIFACT_NAME, sha256: sha256(serializedRows) },
      rowsBytes,
      schemaVersion: REVISION_SCHEMA_VERSION,
      supportArtifact: { bytes: supportBytes, file: SUPPORT_ARTIFACT_NAME, sha256: sha256(serializedSupport) },
      supportBytes,
    };
    const rootDirectory = await rootDirectoryPromise;
    const stagingDirectory = path.join(rootDirectory, `.staging-${revision}`);
    const revisionDirectory = path.join(rootDirectory, String(revision));
    await mkdir(stagingDirectory, { mode: 0o700 });
    await chmod(stagingDirectory, 0o700);
    try {
      await writePrivateArtifact(path.join(stagingDirectory, ROWS_ARTIFACT_NAME), serializedRows);
      await writePrivateArtifact(path.join(stagingDirectory, SUPPORT_ARTIFACT_NAME), serializedSupport);
      if (options.materialize) {
        const rowSourceAuthoritiesPath = path.join(stagingDirectory, ROW_SOURCE_AUTHORITIES_ARTIFACT_NAME);
        await writePrivateArtifact(rowSourceAuthoritiesPath, serializedRowSourceAuthorities);
        await options.materialize(stagingDirectory);
        await rm(rowSourceAuthoritiesPath, { force: true });
        const sessionQueryArtifact = await inspectPrivateArtifact(
          path.join(stagingDirectory, SESSION_QUERY_ARTIFACT_NAME),
          SESSION_QUERY_ARTIFACT_NAME,
          MAX_SESSION_QUERY_DATABASE_BYTES,
        );
        diskManifest.sessionQueryArtifact = sessionQueryArtifact;
        diskManifest.sessionQueryBytes = sessionQueryArtifact.bytes;
      }
      await writePrivateArtifact(path.join(stagingDirectory, MANIFEST_ARTIFACT_NAME), JSON.stringify(diskManifest));
      await syncDirectory(stagingDirectory);

      const validatedManifest = parseDiskManifest(
        await readPrivateArtifact(path.join(stagingDirectory, MANIFEST_ARTIFACT_NAME), 64 * 1024),
        revision,
      );
      const [validatedRows, validatedSupport] = await Promise.all([
        readValidatedArtifact(stagingDirectory, validatedManifest.rowsArtifact),
        readValidatedArtifact(stagingDirectory, validatedManifest.supportArtifact),
      ]);
      const validatedRowsSlice = JSON.parse(validatedRows) as WebReportPayload['rows'];
      const validatedSupportSlice = JSON.parse(validatedSupport) as WebReportPayloadWithoutRows;
      const validatedCaptureFingerprint = reportCaptureFingerprintForPayload({
        ...validatedSupportSlice,
        rows: validatedRowsSlice,
      });
      if (validatedCaptureFingerprint !== validatedManifest.payloadFingerprint) {
        throw new Error('Report revision artifacts do not match their capture fingerprint');
      }
      if (!Array.isArray(validatedRowsSlice)) {
        throw new Error('Report revision rows artifact must contain an array');
      }
      const support: unknown = validatedSupportSlice;
      if (typeof support !== 'object' || support === null || Array.isArray(support) || Object.hasOwn(support, 'rows')) {
        throw new Error('Report revision support artifact must contain payload context without rows');
      }
      if (validatedManifest.sessionQueryArtifact) {
        const inspectedSessionQuery = await inspectPrivateArtifact(
          path.join(stagingDirectory, validatedManifest.sessionQueryArtifact.file),
          validatedManifest.sessionQueryArtifact.file,
          MAX_SESSION_QUERY_DATABASE_BYTES,
        );
        if (
          inspectedSessionQuery.bytes !== validatedManifest.sessionQueryArtifact.bytes ||
          inspectedSessionQuery.sha256 !== validatedManifest.sessionQueryArtifact.sha256
        ) {
          throw new Error('Report revision Session query artifact does not match its manifest');
        }
      }
      const artifactNames = [ROWS_ARTIFACT_NAME, SUPPORT_ARTIFACT_NAME, MANIFEST_ARTIFACT_NAME];
      if (validatedManifest.sessionQueryArtifact) {
        artifactNames.push(validatedManifest.sessionQueryArtifact.file);
      }
      for (const artifactName of artifactNames) {
        const artifactPath = path.join(stagingDirectory, artifactName);
        await chmod(artifactPath, 0o400);
        await syncFile(artifactPath);
      }
      await chmod(stagingDirectory, 0o500);
      await syncDirectory(stagingDirectory);

      return await withLock(async () => {
        if (disposed) {
          throw new Error('Report revision registry has been disposed');
        }
        if (entries.has(revision)) {
          throw new Error(`Report revision ${revision} already exists`);
        }
        await rename(stagingDirectory, revisionDirectory);
        await syncDirectory(rootDirectory);
        entries.set(revision, {
          directory: revisionDirectory,
          manifest: validatedManifest,
          privateCaptureFingerprint,
          references: 0,
        });
        if (publicationSequence >= currentPublicationSequence) {
          currentPublicationSequence = publicationSequence;
          currentRevision = revision;
        }
        await cleanupLocked();
        return publicManifest(validatedManifest);
      });
    } finally {
      await removeRevisionDirectory(stagingDirectory);
    }
  };

  const renewalUnavailable = (): WebReportRevisionManifestResult => ({
    error: {
      message: 'No current report revision matches the expected private capture.',
      tag: 'RevisionUnavailable',
    },
    ok: false,
    requestFingerprint: reportManifestRequestFingerprint,
  });

  const renewCurrentForCapture = async (
    expectedRevision: ReportRevision,
    privateCaptureFingerprint: string,
  ): Promise<WebReportRevisionManifestResult> => {
    const publicationSequence = ++nextPublicationSequence;
    const sourceEntry = await withLock(async () => {
      await cleanupLocked();
      const currentEntry = currentRevision === undefined ? undefined : entries.get(currentRevision);
      if (
        !(
          !disposed &&
          currentEntry &&
          currentEntry.manifest.revision === expectedRevision &&
          currentEntry.privateCaptureFingerprint === privateCaptureFingerprint
        )
      ) {
        return;
      }
      currentEntry.references++;
      return currentEntry;
    });
    if (!sourceEntry) {
      return renewalUnavailable();
    }

    let stagingDirectory: string | undefined;
    try {
      const revision = parseReportRevision(createRevisionId());
      const rootDirectory = await rootDirectoryPromise;
      const preparedStagingDirectory = path.join(rootDirectory, `.staging-${revision}`);
      stagingDirectory = preparedStagingDirectory;
      const revisionDirectory = path.join(rootDirectory, String(revision));
      const diskManifest = parseDiskManifest(
        await readPrivateArtifact(path.join(sourceEntry.directory, MANIFEST_ARTIFACT_NAME), 64 * 1024),
        sourceEntry.manifest.revision,
      );
      if (JSON.stringify(canonicalJson(diskManifest)) !== JSON.stringify(canonicalJson(sourceEntry.manifest))) {
        throw new Error('Report revision disk manifest does not match its in-memory manifest');
      }
      const sourceManifest = sourceEntry.manifest;
      await mkdir(preparedStagingDirectory, { mode: 0o700 });
      await chmod(preparedStagingDirectory, 0o700);
      const rowsArtifact = await copyValidatedPrivateArtifact(
        path.join(sourceEntry.directory, sourceManifest.rowsArtifact.file),
        path.join(preparedStagingDirectory, ROWS_ARTIFACT_NAME),
        sourceManifest.rowsArtifact,
        MAX_REPORT_RUNNER_ARTIFACT_BYTES,
      );
      const supportArtifact = await copyValidatedPrivateArtifact(
        path.join(sourceEntry.directory, sourceManifest.supportArtifact.file),
        path.join(preparedStagingDirectory, SUPPORT_ARTIFACT_NAME),
        sourceManifest.supportArtifact,
        MAX_REPORT_RUNNER_ARTIFACT_BYTES,
      );
      const sessionQueryArtifact = sourceManifest.sessionQueryArtifact
        ? await copyValidatedPrivateArtifact(
            path.join(sourceEntry.directory, sourceManifest.sessionQueryArtifact.file),
            path.join(preparedStagingDirectory, SESSION_QUERY_ARTIFACT_NAME),
            sourceManifest.sessionQueryArtifact,
            MAX_SESSION_QUERY_DATABASE_BYTES,
          )
        : undefined;
      const publishedAt = now();
      const renewedManifest: RevisionDiskManifest = {
        captureFingerprint: sourceManifest.captureFingerprint,
        expiresAt: publishedAt + ttlMs,
        generatedAt: sourceManifest.generatedAt,
        payloadFingerprint: sourceManifest.payloadFingerprint,
        publishedAt,
        revision,
        rowsArtifact,
        rowsBytes: rowsArtifact.bytes,
        schemaVersion: REVISION_SCHEMA_VERSION,
        ...(sessionQueryArtifact === undefined
          ? {}
          : { sessionQueryArtifact, sessionQueryBytes: sessionQueryArtifact.bytes }),
        supportArtifact,
        supportBytes: supportArtifact.bytes,
      };
      await writePrivateArtifact(
        path.join(preparedStagingDirectory, MANIFEST_ARTIFACT_NAME),
        JSON.stringify(renewedManifest),
      );
      const validatedManifest = parseDiskManifest(
        await readPrivateArtifact(path.join(preparedStagingDirectory, MANIFEST_ARTIFACT_NAME), 64 * 1024),
        revision,
      );
      const artifactNames = [ROWS_ARTIFACT_NAME, SUPPORT_ARTIFACT_NAME, MANIFEST_ARTIFACT_NAME];
      if (sessionQueryArtifact) {
        artifactNames.push(SESSION_QUERY_ARTIFACT_NAME);
      }
      for (const artifactName of artifactNames) {
        const artifactPath = path.join(preparedStagingDirectory, artifactName);
        await chmod(artifactPath, 0o400);
        await syncFile(artifactPath);
      }
      await chmod(preparedStagingDirectory, 0o500);
      await syncDirectory(preparedStagingDirectory);

      return await withLock(async () => {
        await cleanupLocked();
        const currentEntry = currentRevision === undefined ? undefined : entries.get(currentRevision);
        if (
          disposed ||
          currentEntry !== sourceEntry ||
          sourceEntry.manifest.expiresAt <= now() ||
          publicationSequence < currentPublicationSequence
        ) {
          return renewalUnavailable();
        }
        if (entries.has(revision)) {
          throw new Error(`Report revision ${revision} already exists`);
        }
        await rename(preparedStagingDirectory, revisionDirectory);
        await syncDirectory(rootDirectory);
        entries.set(revision, {
          directory: revisionDirectory,
          manifest: validatedManifest,
          privateCaptureFingerprint: sourceEntry.privateCaptureFingerprint,
          references: 0,
        });
        currentRevision = revision;
        currentPublicationSequence = publicationSequence;
        await cleanupLocked();
        return {
          manifest: publicManifest(validatedManifest),
          ok: true,
          requestFingerprint: reportManifestRequestFingerprint,
        };
      });
    } finally {
      try {
        if (stagingDirectory !== undefined) {
          await removeRevisionDirectory(stagingDirectory);
        }
      } finally {
        await release(sourceEntry.manifest.revision);
      }
    }
  };

  const getCurrentManifest = (): Promise<WebReportRevisionManifestResult> =>
    withLock(async () => {
      await cleanupLocked();
      const entry = currentRevision === undefined ? undefined : entries.get(currentRevision);
      if (!entry) {
        return {
          error: { message: 'No current report revision is available.', tag: 'RevisionUnavailable' },
          ok: false,
          requestFingerprint: reportManifestRequestFingerprint,
        };
      }
      return {
        manifest: publicManifest(entry.manifest),
        ok: true,
        requestFingerprint: reportManifestRequestFingerprint,
      };
    });

  const getCurrentManifestForCapture = (privateCaptureFingerprint: string): Promise<WebReportRevisionManifestResult> =>
    withLock(async () => {
      await cleanupLocked();
      const entry = currentRevision === undefined ? undefined : entries.get(currentRevision);
      if (!(entry && entry.privateCaptureFingerprint === privateCaptureFingerprint)) {
        return {
          error: { message: 'No current report revision matches this private capture.', tag: 'RevisionUnavailable' },
          ok: false,
          requestFingerprint: reportManifestRequestFingerprint,
        };
      }
      return {
        manifest: publicManifest(entry.manifest),
        ok: true,
        requestFingerprint: reportManifestRequestFingerprint,
      };
    });

  const acquire = async (revision: ReportRevision): Promise<RevisionEntry | undefined> =>
    await withLock(async () => {
      await cleanupLocked();
      const entry = entries.get(revision);
      if (disposed || !entry || entry.manifest.expiresAt <= now()) {
        return;
      }
      entry.references++;
      return entry;
    });

  const acquireSessionQueryLease = async (
    revision: ReportRevision,
  ): Promise<{ entry: RevisionEntry; snapshot: SessionQuerySnapshotValue } | undefined> => {
    const acquired = await withLock(async () => {
      await cleanupLocked();
      const entry = entries.get(revision);
      if (disposed || !entry || entry.manifest.expiresAt <= now()) {
        return;
      }
      entry.references++;
      if (entry.sessionQuerySnapshot) {
        return { createSnapshot: false, entry, snapshot: entry.sessionQuerySnapshot };
      }
      const snapshot = createPendingSessionQuerySnapshot();
      entry.sessionQuerySnapshot = snapshot;
      return { createSnapshot: true, entry, snapshot };
    });
    if (!acquired) {
      return;
    }

    const { createSnapshot, entry, snapshot } = acquired;
    if (createSnapshot) {
      try {
        const value = await createValidatedSessionQuerySnapshotDirectory(entry);
        snapshot.value = value;
        snapshot.resolve(value);
      } catch (error) {
        snapshot.reject(error);
      }
    }

    try {
      const value = await snapshot.promise;
      const expected = entry.manifest.sessionQueryArtifact;
      if (!expected) {
        throw new Error('Report revision does not contain a Session query artifact');
      }
      await validateSessionQuerySnapshot(value, expected.bytes);
      return { entry, snapshot: value };
    } catch (error) {
      await withLock(async () => {
        entry.references = Math.max(0, entry.references - 1);
        if (entry.sessionQuerySnapshot === snapshot && snapshot.value === undefined) {
          entry.sessionQuerySnapshot = undefined;
        }
        notifyReferenceDrainLocked();
        await cleanupLocked();
      });
      throw error;
    }
  };

  const release = (revision: ReportRevision): Promise<void> =>
    withLock(async () => {
      const entry = entries.get(revision);
      if (entry) {
        entry.references = Math.max(0, entry.references - 1);
      }
      notifyReferenceDrainLocked();
      await cleanupLocked();
    });

  const invalidFingerprintResult = (request: WebReportSliceRequest, expectedFingerprint: ReportRequestFingerprint) => ({
    error: {
      message: 'The report slice request fingerprint does not match the validated request.',
      revision: request.revision,
      tag: 'InvalidRequestFingerprint' as const,
    },
    ok: false as const,
    requestFingerprint: expectedFingerprint,
  });

  const readRows = async (request: WebReportSliceRequest): Promise<WebReportRowsSliceResult> => {
    const requestFingerprint = reportSliceRequestFingerprint('rows');
    if (request.requestFingerprint !== requestFingerprint) {
      return invalidFingerprintResult(request, requestFingerprint);
    }
    const entry = await acquire(request.revision);
    if (!entry) {
      return { error: revisionExpired(request.revision), ok: false, requestFingerprint };
    }
    try {
      const serialized = await readValidatedArtifact(entry.directory, entry.manifest.rowsArtifact);
      const rows = JSON.parse(serialized) as unknown;
      if (!Array.isArray(rows)) {
        throw new Error('Report revision rows artifact must contain an array');
      }
      return {
        ok: true,
        requestFingerprint,
        slice: { revision: request.revision, rows: rows as WebReportPayload['rows'] },
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { error: revisionExpired(request.revision), ok: false, requestFingerprint };
      }
      throw error;
    } finally {
      await release(request.revision);
    }
  };

  const readSupport = async (request: WebReportSliceRequest): Promise<WebReportSupportSliceResult> => {
    const requestFingerprint = reportSliceRequestFingerprint('support');
    if (request.requestFingerprint !== requestFingerprint) {
      return invalidFingerprintResult(request, requestFingerprint);
    }
    const entry = await acquire(request.revision);
    if (!entry) {
      return { error: revisionExpired(request.revision), ok: false, requestFingerprint };
    }
    try {
      const serialized = await readValidatedArtifact(entry.directory, entry.manifest.supportArtifact);
      const payloadWithoutRows = JSON.parse(serialized) as unknown;
      if (
        typeof payloadWithoutRows !== 'object' ||
        payloadWithoutRows === null ||
        Array.isArray(payloadWithoutRows) ||
        Object.hasOwn(payloadWithoutRows, 'rows')
      ) {
        throw new Error('Report revision support artifact must contain payload context without rows');
      }
      return {
        ok: true,
        requestFingerprint,
        slice: {
          payloadWithoutRows: payloadWithoutRows as WebReportPayloadWithoutRows,
          revision: request.revision,
        },
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { error: revisionExpired(request.revision), ok: false, requestFingerprint };
      }
      throw error;
    } finally {
      await release(request.revision);
    }
  };

  const withSessionQueryLease = async <Result>(
    revision: ReportRevision,
    operation: (directory: string, manifest: WebReportRevisionManifest) => Promise<Result>,
  ): Promise<ReportRevisionLeaseResult<Result>> => {
    const lease = await acquireSessionQueryLease(revision);
    if (!lease) {
      return { error: revisionExpired(revision), ok: false };
    }
    try {
      const value = await operation(lease.snapshot.directory, publicManifest(lease.entry.manifest));
      const expected = lease.entry.manifest.sessionQueryArtifact;
      if (!expected) {
        throw new Error('Report revision does not contain a Session query artifact');
      }
      await validateSessionQuerySnapshot(lease.snapshot, expected.bytes);
      return {
        manifest: publicManifest(lease.entry.manifest),
        ok: true,
        value,
      };
    } finally {
      await release(revision);
    }
  };

  const dispose = (): Promise<void> => {
    if (disposalPromise) {
      return disposalPromise;
    }
    disposalPromise = (async () => {
      const { drained } = await withLock(() => {
        disposed = true;
        currentRevision = undefined;
        return { drained: waitForReferenceDrainLocked() };
      });
      await drained;
      await withLock(async () => {
        const retainedEntries = [...entries.values()];
        await Promise.all(
          retainedEntries.map(async (entry) => {
            try {
              await entry.sessionQuerySnapshot?.promise;
            } catch {
              // Failed snapshot creation removes its own staging directory.
            }
          }),
        );
        entries.clear();
        await Promise.all(retainedEntries.map(removeEntryArtifacts));
        if (ownsRootDirectory) {
          await rm(await rootDirectoryPromise, { force: true, recursive: true });
        }
      });
    })();
    return disposalPromise;
  };

  return {
    dispose,
    getCurrentManifest,
    getCurrentManifestForCapture,
    invalidateLatest: () =>
      withLock(async () => {
        currentRevision = undefined;
        await cleanupLocked();
      }),
    publish,
    renewCurrentForCapture,
    readRows,
    readSupport,
    withSessionQueryLease,
  };
};
