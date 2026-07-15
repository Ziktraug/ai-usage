import fs from 'node:fs';
import path from 'node:path';

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const createNewFileFlags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;

export const preparePrivateStoreFile = (filePath: string): void => {
  const directory = path.dirname(filePath);
  const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (directoryStat?.isSymbolicLink() || (directoryStat && !directoryStat.isDirectory())) {
    throw new Error(`usage-store directory is unsafe: ${directory}`);
  }
  fs.mkdirSync(directory, { mode: privateDirectoryMode, recursive: true });
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, privateDirectoryMode);
  }
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new Error(`usage-store file is unsafe: ${candidate}`);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(candidate, privateFileMode);
    }
  }
  if (!fs.existsSync(filePath)) {
    fs.closeSync(fs.openSync(filePath, createNewFileFlags, privateFileMode));
  }
};
