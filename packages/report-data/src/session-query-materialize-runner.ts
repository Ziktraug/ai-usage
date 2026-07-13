#!/usr/bin/env bun
import fs from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { MAX_SESSION_QUERY_DATABASE_BYTES } from '@ai-usage/report-core/report-budgets';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { MAX_REPORT_RUNNER_ARTIFACT_BYTES } from './report-payload-artifact';
import { materializeSessionQueryDatabase, SESSION_QUERY_DATABASE_NAME } from './session-query-materialization';

const ROWS_ARTIFACT_NAME = 'rows.json';
const SUPPORT_ARTIFACT_NAME = 'support.json';
const READ_CHUNK_BYTES = 64 * 1024;
const readFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

const readJsonArtifact = async (revisionDirectory: string, artifactName: string): Promise<unknown> => {
  if (!path.isAbsolute(revisionDirectory)) {
    throw new Error('Report revision directory must be absolute');
  }
  const directoryStat = await stat(revisionDirectory);
  if (
    !(
      directoryStat.isDirectory() &&
      hasOwnerOnlyPermissions(directoryStat.mode) &&
      isOwnedByCurrentUser(directoryStat.uid)
    )
  ) {
    throw new Error('Report revision directory must be private and owned by the current user');
  }

  const handle = await open(path.join(revisionDirectory, artifactName), readFlags);
  try {
    const artifactStat = await handle.stat();
    if (
      !(artifactStat.isFile() && hasOwnerOnlyPermissions(artifactStat.mode) && isOwnedByCurrentUser(artifactStat.uid))
    ) {
      throw new Error('Report revision artifact must be a private regular file owned by the current user');
    }
    if (artifactStat.size > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Report revision artifact exceeds the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      const remainingBytes = MAX_REPORT_RUNNER_ARTIFACT_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Report revision artifact exceeds the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes)));
  } finally {
    await handle.close();
  }
};

const revisionDirectory = process.argv[2];
if (!revisionDirectory) {
  throw new Error('Report session query materializer requires a private revision directory');
}

const [rows, support] = await Promise.all([
  readJsonArtifact(revisionDirectory, ROWS_ARTIFACT_NAME),
  readJsonArtifact(revisionDirectory, SUPPORT_ARTIFACT_NAME),
]);
if (!Array.isArray(rows)) {
  throw new Error('Report revision rows artifact must contain an array');
}
if (typeof support !== 'object' || support === null || Array.isArray(support) || Object.hasOwn(support, 'rows')) {
  throw new Error('Report revision support artifact must contain payload context without rows');
}
await materializeSessionQueryDatabase(revisionDirectory, rows as SerializedRow[], support as FocusedReportSupport);
const databaseStat = await stat(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME));
if (databaseStat.size > MAX_SESSION_QUERY_DATABASE_BYTES) {
  throw new Error(`Report Session query database exceeds the ${MAX_SESSION_QUERY_DATABASE_BYTES}-byte limit`);
}
