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
  rowsArtifact: RevisionArtifactManifest;
  schemaVersion: typeof REVISION_SCHEMA_VERSION;
  sessionQueryArtifact?: RevisionArtifactManifest;
  supportArtifact: RevisionArtifactManifest;
}

interface RevisionEntry {
  directory: string;
  manifest: RevisionDiskManifest;
  references: number;
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
  invalidateLatest(): Promise<void>;
  publish(payload: WebReportPayload): Promise<WebReportRevisionManifest>;
  readRows(request: WebReportSliceRequest): Promise<WebReportRowsSliceResult>;
  readSupport(request: WebReportSliceRequest): Promise<WebReportSupportSliceResult>;
  renewCurrent(): Promise<WebReportRevisionManifestResult>;
  withRevisionDirectory<Result>(
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

export const reportCaptureFingerprintForPayload = (payload: WebReportPayload): string => {
  const { generatedAt: _generatedAt, ...semanticPayload } = payload;
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(semanticPayload)))
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
  let disposed = false;
  let lockTail: Promise<void> = Promise.resolve();

  const withLock = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = lockTail.then(operation, operation);
    lockTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      await removeRevisionDirectory(entry.directory);
      entries.delete(revision);
    }
  };

  const publish = async (payload: WebReportPayload): Promise<WebReportRevisionManifest> => {
    if (disposed) {
      throw new Error('Report revision registry has been disposed');
    }
    const revision = parseReportRevision(createRevisionId());
    const { rowsSlice, supportSlice } = splitWebReportPayload(payload, revision);
    const serializedRows = JSON.stringify(rowsSlice.rows);
    const serializedSupport = JSON.stringify(supportSlice.payloadWithoutRows);
    const rowsBytes = Buffer.byteLength(serializedRows);
    const supportBytes = Buffer.byteLength(serializedSupport);
    if (rowsBytes + supportBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Report revision artifacts exceed the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }

    const publishedAt = now();
    const diskManifest: RevisionDiskManifest = {
      captureFingerprint: reportCaptureFingerprintForPayload(payload),
      expiresAt: publishedAt + ttlMs,
      generatedAt: payload.generatedAt,
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
        await options.materialize(stagingDirectory);
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
      if (validatedCaptureFingerprint !== validatedManifest.captureFingerprint) {
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
        entries.set(revision, { directory: revisionDirectory, manifest: validatedManifest, references: 0 });
        currentRevision = revision;
        await cleanupLocked();
        return publicManifest(validatedManifest);
      });
    } finally {
      await removeRevisionDirectory(stagingDirectory);
    }
  };

  const renewCurrent = (): Promise<WebReportRevisionManifestResult> =>
    withLock(async () => {
      await cleanupLocked();
      const sourceEntry = currentRevision === undefined ? undefined : entries.get(currentRevision);
      if (!sourceEntry) {
        return {
          error: { message: 'No current report revision is available.', tag: 'RevisionUnavailable' },
          ok: false,
          requestFingerprint: reportManifestRequestFingerprint,
        };
      }
      const sourceManifest = parseDiskManifest(
        await readPrivateArtifact(path.join(sourceEntry.directory, MANIFEST_ARTIFACT_NAME), 64 * 1024),
        sourceEntry.manifest.revision,
      );
      const revision = parseReportRevision(createRevisionId());
      const publishedAt = now();
      const rootDirectory = await rootDirectoryPromise;
      const stagingDirectory = path.join(rootDirectory, `.staging-${revision}`);
      const revisionDirectory = path.join(rootDirectory, String(revision));
      await mkdir(stagingDirectory, { mode: 0o700 });
      await chmod(stagingDirectory, 0o700);
      try {
        const rowsArtifact = await copyValidatedPrivateArtifact(
          path.join(sourceEntry.directory, sourceManifest.rowsArtifact.file),
          path.join(stagingDirectory, ROWS_ARTIFACT_NAME),
          sourceManifest.rowsArtifact,
          MAX_REPORT_RUNNER_ARTIFACT_BYTES,
        );
        const supportArtifact = await copyValidatedPrivateArtifact(
          path.join(sourceEntry.directory, sourceManifest.supportArtifact.file),
          path.join(stagingDirectory, SUPPORT_ARTIFACT_NAME),
          sourceManifest.supportArtifact,
          MAX_REPORT_RUNNER_ARTIFACT_BYTES,
        );
        const sessionQueryArtifact = sourceManifest.sessionQueryArtifact
          ? await copyValidatedPrivateArtifact(
              path.join(sourceEntry.directory, sourceManifest.sessionQueryArtifact.file),
              path.join(stagingDirectory, SESSION_QUERY_ARTIFACT_NAME),
              sourceManifest.sessionQueryArtifact,
              MAX_SESSION_QUERY_DATABASE_BYTES,
            )
          : undefined;
        const renewedManifest: RevisionDiskManifest = {
          captureFingerprint: sourceManifest.captureFingerprint,
          expiresAt: publishedAt + ttlMs,
          generatedAt: sourceManifest.generatedAt,
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
          path.join(stagingDirectory, MANIFEST_ARTIFACT_NAME),
          JSON.stringify(renewedManifest),
        );
        const validatedManifest = parseDiskManifest(
          await readPrivateArtifact(path.join(stagingDirectory, MANIFEST_ARTIFACT_NAME), 64 * 1024),
          revision,
        );
        const artifactNames = [ROWS_ARTIFACT_NAME, SUPPORT_ARTIFACT_NAME, MANIFEST_ARTIFACT_NAME];
        if (sessionQueryArtifact) {
          artifactNames.push(SESSION_QUERY_ARTIFACT_NAME);
        }
        for (const artifactName of artifactNames) {
          const artifactPath = path.join(stagingDirectory, artifactName);
          await chmod(artifactPath, 0o400);
          await syncFile(artifactPath);
        }
        await chmod(stagingDirectory, 0o500);
        await syncDirectory(stagingDirectory);
        await rename(stagingDirectory, revisionDirectory);
        await syncDirectory(rootDirectory);
        entries.set(revision, { directory: revisionDirectory, manifest: validatedManifest, references: 0 });
        currentRevision = revision;
        await cleanupLocked();
        return {
          manifest: publicManifest(validatedManifest),
          ok: true,
          requestFingerprint: reportManifestRequestFingerprint,
        };
      } finally {
        await removeRevisionDirectory(stagingDirectory);
      }
    });

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

  const acquire = async (revision: ReportRevision): Promise<RevisionEntry | undefined> =>
    await withLock(async () => {
      await cleanupLocked();
      const entry = entries.get(revision);
      if (!entry || entry.manifest.expiresAt <= now()) {
        return;
      }
      entry.references++;
      return entry;
    });

  const release = (revision: ReportRevision): Promise<void> =>
    withLock(async () => {
      const entry = entries.get(revision);
      if (entry) {
        entry.references = Math.max(0, entry.references - 1);
      }
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

  const withRevisionDirectory = async <Result>(
    revision: ReportRevision,
    operation: (directory: string, manifest: WebReportRevisionManifest) => Promise<Result>,
  ): Promise<ReportRevisionLeaseResult<Result>> => {
    const entry = await acquire(revision);
    if (!entry) {
      return { error: revisionExpired(revision), ok: false };
    }
    try {
      return {
        manifest: publicManifest(entry.manifest),
        ok: true,
        value: await operation(entry.directory, publicManifest(entry.manifest)),
      };
    } finally {
      await release(revision);
    }
  };

  return {
    dispose: () =>
      withLock(async () => {
        disposed = true;
        currentRevision = undefined;
        const directories = [...entries.values()].map((entry) => entry.directory);
        entries.clear();
        await Promise.all(directories.map(removeRevisionDirectory));
        if (ownsRootDirectory) {
          await rm(await rootDirectoryPromise, { force: true, recursive: true });
        }
      }),
    getCurrentManifest,
    invalidateLatest: () =>
      withLock(async () => {
        currentRevision = undefined;
        await cleanupLocked();
      }),
    publish,
    renewCurrent,
    readRows,
    readSupport,
    withRevisionDirectory,
  };
};
