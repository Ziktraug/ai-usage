import fs from 'node:fs';

const privateDirectoryMode = 0o700;

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
