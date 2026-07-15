import fs from 'node:fs';
import { open } from 'node:fs/promises';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import { parseUsageSnapshot, type UsageSnapshot } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';
import { CliArgumentError } from './errors';

// The supported 50,000-row deterministic audit fixture is below 40 MiB as a
// single snapshot. 64 MiB leaves explicit format headroom while bounding one
// untrusted local-file read to the web manual-import boundary.
const SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const snapshotOpenFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

interface SnapshotFileStat {
  isFile(): boolean;
  size: number;
}

export interface UsageSnapshotFileHandle {
  close(): Promise<void>;
  read(buffer: Uint8Array, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  stat(): Promise<SnapshotFileStat>;
}

export type OpenUsageSnapshotFile = (filePath: string) => Promise<UsageSnapshotFileHandle>;

const openUsageSnapshotFile: OpenUsageSnapshotFile = (filePath) => open(filePath, snapshotOpenFlags);

const snapshotFileError = (filePath: string) =>
  new CliArgumentError({
    message: `Cannot read usage snapshot file: ${filePath}`,
  });

const readBoundedSnapshotBytes = async (filePath: string, openFile: OpenUsageSnapshotFile): Promise<Uint8Array> => {
  const handle = await openFile(filePath);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_PORTABLE_USAGE_BYTES) {
      throw new Error('snapshot input must be a bounded regular file');
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_PORTABLE_USAGE_BYTES) {
      const remainingBytes = MAX_PORTABLE_USAGE_BYTES + 1 - totalBytes;
      const buffer = new Uint8Array(Math.min(SNAPSHOT_READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_PORTABLE_USAGE_BYTES) {
      throw new Error('snapshot input exceeds the byte limit');
    }

    const bytes = new Uint8Array(totalBytes);
    let writeOffset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

export const createUsageSnapshotFileReader =
  (openFile: OpenUsageSnapshotFile = openUsageSnapshotFile) =>
  (filePath: string): Effect.Effect<UsageSnapshot, CliArgumentError> =>
    Effect.tryPromise({
      try: async () => {
        const bytes = await readBoundedSnapshotBytes(filePath, openFile);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return parseUsageSnapshot(text);
      },
      catch: () => snapshotFileError(filePath),
    });

export const readUsageSnapshotFile = createUsageSnapshotFileReader();
