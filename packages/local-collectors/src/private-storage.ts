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

export const writePrivateJson = (filePath: string, value: unknown): void => {
  ensurePrivateDirectory(path.dirname(filePath));
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`ai-usage private file is unsafe: ${filePath}`);
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
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
