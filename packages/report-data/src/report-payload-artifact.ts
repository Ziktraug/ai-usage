import fs from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { MAX_REPORT_RUNNER_ARTIFACT_BYTES } from '@ai-usage/report-core/report-budgets';

export { MAX_REPORT_RUNNER_ARTIFACT_BYTES } from '@ai-usage/report-core/report-budgets';

const ARTIFACT_WRITE_CHUNK_BYTES = 64 * 1024;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const artifactWriteFlags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

export interface ReportPayloadArtifactWriteOptions {
  maximumBytes?: number;
}

export const writeReportPayloadArtifact = async (
  outputPath: string,
  serializedPayload: string,
  { maximumBytes = MAX_REPORT_RUNNER_ARTIFACT_BYTES }: ReportPayloadArtifactWriteOptions = {},
): Promise<number> => {
  if (!path.isAbsolute(outputPath)) {
    throw new Error('Report payload artifact path must be absolute');
  }

  const parentStat = await lstat(path.dirname(outputPath));
  const isPrivateDirectory = parentStat.isDirectory() && hasOwnerOnlyPermissions(parentStat.mode);
  if (!(isPrivateDirectory && isOwnedByCurrentUser(parentStat.uid))) {
    throw new Error('Report payload artifact directory must be private and owned by the current user');
  }

  const payloadBytes = Buffer.byteLength(serializedPayload, 'utf8');
  if (payloadBytes > maximumBytes) {
    throw new Error(`Report payload artifact exceeds the ${maximumBytes}-byte limit`);
  }

  const artifact = await open(outputPath, artifactWriteFlags);
  try {
    const artifactStat = await artifact.stat();
    if (
      !artifactStat.isFile() ||
      artifactStat.size !== 0 ||
      !hasOwnerOnlyPermissions(artifactStat.mode) ||
      !isOwnedByCurrentUser(artifactStat.uid)
    ) {
      throw new Error('Report payload artifact must be an empty private regular file owned by the current user');
    }

    const buffer = Buffer.from(serializedPayload, 'utf8');
    let totalBytesWritten = 0;
    while (totalBytesWritten < buffer.byteLength) {
      const remainingBytes = buffer.byteLength - totalBytesWritten;
      const writeLength = Math.min(ARTIFACT_WRITE_CHUNK_BYTES, remainingBytes);
      const { bytesWritten } = await artifact.write(buffer, totalBytesWritten, writeLength, totalBytesWritten);
      if (bytesWritten === 0) {
        throw new Error('Report payload artifact write made no progress');
      }
      totalBytesWritten += bytesWritten;
      if (totalBytesWritten > maximumBytes) {
        throw new Error(`Report payload artifact exceeds the ${maximumBytes}-byte limit`);
      }
    }
    return totalBytesWritten;
  } finally {
    await artifact.close();
  }
};
