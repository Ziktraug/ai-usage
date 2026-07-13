#!/usr/bin/env bun
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_SESSION_QUERY_RESULT_BYTES } from '@ai-usage/report-core/report-budgets';
import { writeReportPayloadArtifact } from './report-payload-artifact';
import { SESSION_QUERY_DATABASE_NAME } from './session-query-materialization';
import {
  assertSessionQueryDatabase,
  executeMaterializedSessionQuery,
  type SessionQueryKind,
  type SessionQuerySqliteDatabase,
} from './session-query-sqlite';

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

const parseKind = (value: string | undefined): SessionQueryKind => {
  if (value === 'campaign-children' || value === 'neighbors' || value === 'sessions') {
    return value;
  }
  throw new Error('Unknown report session query kind');
};

const assertPrivateOwnedPath = async (filePath: string, expected: 'directory' | 'file'): Promise<void> => {
  const [linkStat, fileStat] = await Promise.all([lstat(filePath), stat(filePath)]);
  const validKind = expected === 'directory' ? fileStat.isDirectory() : fileStat.isFile();
  if (
    linkStat.isSymbolicLink() ||
    !validKind ||
    !hasOwnerOnlyPermissions(fileStat.mode) ||
    !isOwnedByCurrentUser(fileStat.uid)
  ) {
    throw new Error(`Report revision ${expected} must be private, owned by the current user, and not a symlink`);
  }
};

const openReadOnlyDatabase = async (
  revisionDirectory: string,
): Promise<SessionQuerySqliteDatabase & { close(): void }> => {
  if (!path.isAbsolute(revisionDirectory)) {
    throw new Error('Report revision directory must be absolute');
  }
  await assertPrivateOwnedPath(revisionDirectory, 'directory');
  const databasePath = path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME);
  await assertPrivateOwnedPath(databasePath, 'file');
  const { constants, Database } = await import('bun:sqlite');
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set('immutable', '1');
  const database = new Database(
    databaseUrl.href,
    // SQLite open flags are a documented bitmask API.
    // biome-ignore lint/suspicious/noBitwiseOperators: No writable database handle is permitted here.
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  ) as SessionQuerySqliteDatabase & { close(): void; exec(sql: string): unknown };
  database.exec('PRAGMA query_only = ON');
  return database;
};

const revisionDirectory = process.argv[2];
const kind = parseKind(process.argv[3]);
const serializedRequest = process.argv[4];
const outputPath = process.argv[5];
if (!(revisionDirectory && serializedRequest && outputPath)) {
  throw new Error('Report session query runner requires a revision, request, and server-created output path');
}

const request: unknown = JSON.parse(serializedRequest);
const database = await openReadOnlyDatabase(revisionDirectory);
try {
  assertSessionQueryDatabase(database);
  const result = executeMaterializedSessionQuery(database, kind, request);
  await writeReportPayloadArtifact(outputPath, JSON.stringify(result), {
    maximumBytes: MAX_SESSION_QUERY_RESULT_BYTES,
  });
} finally {
  database.close();
}
