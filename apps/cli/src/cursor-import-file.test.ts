import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importCursorUsageExportFile } from './cursor-import-file';

const validCsv = 'Date,User,Kind,Model,Cost\n2026-01-01,user,usage,model,1.25\n';

test('streams, stores privately, and deduplicates Cursor imports without changing the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-import-'));
  try {
    const sourcePath = path.join(root, 'source.csv');
    fs.writeFileSync(sourcePath, validCsv, { mode: 0o644 });
    const sourceBefore = fs.lstatSync(sourcePath);
    const first = importCursorUsageExportFile(sourcePath, { cwd: root });
    const second = importCursorUsageExportFile(sourcePath, { cwd: root });
    expect(first.alreadyImported).toBe(false);
    expect(second).toEqual({ ...first, alreadyImported: true });
    expect(fs.readFileSync(first.path, 'utf8')).toBe(validCsv);
    const sourceAfter = fs.lstatSync(sourcePath);
    expect({ ino: sourceAfter.ino, mode: sourceAfter.mode, size: sourceAfter.size }).toEqual({
      ino: sourceBefore.ino,
      mode: sourceBefore.mode,
      size: sourceBefore.size,
    });
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(first.path).mode % 0o1000).toBe(0o600);
      expect(fs.lstatSync(path.dirname(first.path)).mode % 0o1000).toBe(0o700);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('rejects symlink sources, unsafe import directories, and over-budget input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-import-'));
  try {
    const sourcePath = path.join(root, 'source.csv');
    fs.writeFileSync(sourcePath, validCsv);
    const sourceLink = path.join(root, 'source-link.csv');
    fs.symlinkSync(sourcePath, sourceLink);
    expect(() => importCursorUsageExportFile(sourceLink, { cwd: root })).toThrow('regular file');
    expect(() => importCursorUsageExportFile(sourcePath, { cwd: root, maxBytes: validCsv.length - 1 })).toThrow(
      'regular file',
    );
    const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-import-unsafe-'));
    fs.mkdirSync(path.join(unsafeRoot, 'target'));
    fs.symlinkSync(path.join(unsafeRoot, 'target'), path.join(unsafeRoot, '.ai-usage'));
    expect(() => importCursorUsageExportFile(sourcePath, { cwd: unsafeRoot })).toThrow('directory is unsafe');
    fs.rmSync(unsafeRoot, { force: true, recursive: true });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
