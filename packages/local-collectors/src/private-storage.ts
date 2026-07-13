import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

const assertOwnedDirectory = (directory: string): void => {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error(`ai-usage private directory is unsafe: ${directory}`);
  }
};

export const ensurePrivateDirectory = (directory: string): void => {
  assertOwnedDirectory(directory);
  fs.mkdirSync(directory, { mode: privateDirectoryMode, recursive: true });
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, privateDirectoryMode);
  }
};

export const assertPrivateAuthoritativeFile = (filePath: string): void => {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!existing) {
    return;
  }
  if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
    throw new Error(`ai-usage private authoritative file is unsafe: ${filePath}`);
  }
};

export const readPrivateJson = (filePath: string, maxBytes: number): unknown | undefined => {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!existing) {
    return;
  }
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error(`ai-usage private file is unsafe: ${filePath}`);
  }
  if (existing.nlink !== 1 || existing.size > maxBytes) {
    return;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes) {
      return;
    }
    const bytes = Buffer.alloc(opened.size + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > maxBytes) {
      return;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) as unknown;
  } finally {
    fs.closeSync(descriptor);
  }
};

export const writePrivateJson = (filePath: string, value: unknown): void => {
  ensurePrivateDirectory(path.dirname(filePath));
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`ai-usage private file is unsafe: ${filePath}`);
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: privateFileMode,
    });
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      fs.chmodSync(filePath, privateFileMode);
    }
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};
