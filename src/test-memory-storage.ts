import path from 'node:path';
import type { LocalHistoryDatabase, LocalHistoryDirEntry, LocalHistoryStorage } from './local-history';

export class TestMemoryStorage implements LocalHistoryStorage {
  readonly home: string;
  private readonly files = new Map<string, string>();

  constructor(home = '/home/test') {
    this.home = home;
  }

  writeText(relativePath: string, content: string) {
    this.files.set(path.join(this.home, relativePath), content);
  }

  exists(filePath: string) {
    if (this.files.has(filePath)) return true;
    const prefix = filePath.endsWith(path.sep) ? filePath : `${filePath}${path.sep}`;
    return [...this.files.keys()].some((storedPath) => storedPath.startsWith(prefix));
  }

  readText(filePath: string) {
    const content = this.files.get(filePath);
    if (content == null) throw new Error(`Missing fixture file: ${filePath}`);
    return content;
  }

  readDir(dirPath: string): LocalHistoryDirEntry[] {
    const prefix = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
    const entries = new Map<string, boolean>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const [name, ...remaining] = rest.split(path.sep);
      if (!name) continue;
      entries.set(name, remaining.length > 0);
    }
    return [...entries.entries()]
      .map(([name, isDirectory]) => ({ name, isDirectory }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  openDatabase(_dbPath: string): LocalHistoryDatabase {
    throw new Error('TestMemoryStorage does not implement SQLite fixtures');
  }
}
