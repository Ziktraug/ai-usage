import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CURSOR_CSV_MAX_BYTES = 64 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const HEADER_PROBE_BYTES = 4096;
const CURSOR_CSV_LINE_SEPARATOR = /\r?\n/;
// biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
const SAFE_SOURCE_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const cursorCsvLooksValid = (text: string): boolean => {
  const header = text.split(CURSOR_CSV_LINE_SEPARATOR, 1)[0] ?? '';
  return ['Date', 'User', 'Kind', 'Model', 'Cost'].every((column) => header.includes(column));
};

const safeImportName = (filePath: string): string => path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-');

const ensureImportDirectory = (directory: string): void => {
  const aiUsageDirectory = path.dirname(directory);
  for (const candidate of [aiUsageDirectory, directory]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
      throw new Error(`Cursor import directory is unsafe: ${candidate}`);
    }
    fs.mkdirSync(candidate, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    if (process.platform !== 'win32') {
      fs.chmodSync(candidate, PRIVATE_DIRECTORY_MODE);
    }
  }
};

const hashRegularFile = (filePath: string, maxBytes: number): string => {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`Cursor import artifact is unsafe: ${filePath}`);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      total += count;
      if (total > maxBytes) {
        throw new Error(`Cursor import exceeds its ${maxBytes}-byte limit.`);
      }
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
};

export interface CursorImportResult {
  alreadyImported: boolean;
  path: string;
}

export const importCursorUsageExportFile = (
  filePath: string,
  options: { cwd?: string; maxBytes?: number } = {},
): CursorImportResult => {
  const sourcePath = path.resolve(options.cwd ?? process.cwd(), filePath);
  const maxBytes = options.maxBytes ?? CURSOR_CSV_MAX_BYTES;
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size > maxBytes) {
    throw new Error(`Cursor import source must be a regular file no larger than ${maxBytes} bytes.`);
  }
  const importDirectory = path.join(options.cwd ?? process.cwd(), '.ai-usage', 'cursor-exports');
  ensureImportDirectory(importDirectory);
  const temporaryPath = path.join(importDirectory, `.cursor-import-${process.pid}-${randomUUID()}.tmp`);
  let sourceDescriptor: number | undefined;
  let temporaryDescriptor: number | undefined;
  try {
    sourceDescriptor = fs.openSync(sourcePath, SAFE_SOURCE_READ_FLAGS);
    temporaryDescriptor = fs.openSync(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const headerChunks: Buffer[] = [];
    let headerBytes = 0;
    let total = 0;
    while (true) {
      const count = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      total += count;
      if (total > maxBytes) {
        throw new Error(`Cursor import exceeds its ${maxBytes}-byte limit.`);
      }
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      fs.writeSync(temporaryDescriptor, chunk);
      if (headerBytes < HEADER_PROBE_BYTES) {
        const retained = chunk.subarray(0, HEADER_PROBE_BYTES - headerBytes);
        headerChunks.push(Buffer.from(retained));
        headerBytes += retained.length;
      }
    }
    if (!cursorCsvLooksValid(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(headerChunks)))) {
      throw new Error('not a Cursor usage-events CSV export');
    }
    fs.closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    const digest = hash.digest('hex');
    for (const entry of fs.readdirSync(importDirectory, { withFileTypes: true })) {
      if (!(entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))) {
        continue;
      }
      const existingPath = path.join(importDirectory, entry.name);
      if (hashRegularFile(existingPath, maxBytes) === digest) {
        fs.rmSync(temporaryPath, { force: true });
        return { path: existingPath, alreadyImported: true };
      }
    }
    const destination = path.join(importDirectory, `${digest.slice(0, 12)}-${safeImportName(sourcePath)}`);
    const destinationStat = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (destinationStat) {
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile() || destinationStat.nlink !== 1) {
        throw new Error(`Cursor import artifact is unsafe: ${destination}`);
      }
      if (hashRegularFile(destination, maxBytes) === digest) {
        fs.rmSync(temporaryPath, { force: true });
        return { path: destination, alreadyImported: true };
      }
      throw new Error(`Cursor import destination already exists with different content: ${destination}`);
    }
    fs.renameSync(temporaryPath, destination);
    if (process.platform !== 'win32') {
      fs.chmodSync(destination, PRIVATE_FILE_MODE);
    }
    return { path: destination, alreadyImported: false };
  } finally {
    if (sourceDescriptor !== undefined) {
      fs.closeSync(sourceDescriptor);
    }
    if (temporaryDescriptor !== undefined) {
      fs.closeSync(temporaryDescriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
};
