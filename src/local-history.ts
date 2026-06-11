import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalHistoryDirEntry {
  name: string;
  isDirectory: boolean;
}

export interface LocalHistoryDatabase {
  all(sql: string): any[];
  close(): void;
}

export interface LocalHistoryStorage {
  home: string;
  exists(filePath: string): boolean;
  readText(filePath: string): string;
  readDir(dirPath: string): LocalHistoryDirEntry[];
  openDatabase(dbPath: string): LocalHistoryDatabase;
}

export const createLocalHistoryStorage = (home = os.homedir()): LocalHistoryStorage => ({
  home,
  exists: (filePath) => fs.existsSync(filePath),
  readText: (filePath) => fs.readFileSync(filePath, 'utf8'),
  readDir: (dirPath) =>
    fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  openDatabase: (dbPath) => {
    const db = new Database(dbPath, { readonly: true });
    return {
      all: (sql) => db.query(sql).all() as any[],
      close: () => db.close(),
    };
  },
});

export const historyPath = (storage: LocalHistoryStorage, ...segments: string[]) =>
  path.join(storage.home, ...segments);

export const walkFiles = (
  storage: LocalHistoryStorage,
  dirPath: string,
  include: (fileName: string, filePath: string) => boolean,
): string[] => {
  if (!storage.exists(dirPath)) return [];

  const files: string[] = [];
  const walk = (currentPath: string) => {
    for (const entry of storage.readDir(currentPath)) {
      const filePath = path.join(currentPath, entry.name);
      if (entry.isDirectory) walk(filePath);
      else if (include(entry.name, filePath)) files.push(filePath);
    }
  };

  walk(dirPath);
  return files;
};
