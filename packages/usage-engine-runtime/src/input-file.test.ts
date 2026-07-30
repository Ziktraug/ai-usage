import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUsageEngineHandoffId } from '@ai-usage/usage-engine-control';
import {
  listManagedCursorUsageExportPaths,
  readUsageEngineInput,
  repairManagedCursorUsageExportModes,
  scavengeUsageEngineInbox,
  stageCursorUsageExport,
} from './input-file';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-input-'));
  roots.push(root);
  const inboxDirectory = path.join(root, 'state', 'inbox');
  const operatorCwd = path.join(root, 'operator');
  await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
  await mkdir(operatorCwd, { recursive: true });
  return { inboxDirectory, operatorCwd, root };
};

describe('usage engine file inputs', () => {
  test('reads a bounded no-follow operator file and rejects symlinks and hard links', async () => {
    const { inboxDirectory, operatorCwd } = await fixture();
    const filePath = path.join(operatorCwd, 'merge.json');
    await writeFile(filePath, '{"version":3}\n');

    const opened = await readUsageEngineInput(
      { filePath: 'merge.json', kind: 'operator-file' },
      { inboxDirectory, maximumBytes: 1024, operatorCwd },
    );
    expect(opened.text).toBe('{"version":3}\n');
    expect(opened.remove).toBeUndefined();

    const symlinkPath = path.join(operatorCwd, 'linked.json');
    await symlink(filePath, symlinkPath);
    await expect(
      readUsageEngineInput(
        { filePath: symlinkPath, kind: 'operator-file' },
        { inboxDirectory, maximumBytes: 1024, operatorCwd },
      ),
    ).rejects.toThrow('regular file');
    const hardLinkPath = path.join(operatorCwd, 'hard.json');
    await link(filePath, hardLinkPath);
    await expect(
      readUsageEngineInput({ filePath, kind: 'operator-file' }, { inboxDirectory, maximumBytes: 1024, operatorCwd }),
    ).rejects.toThrow('singly linked');
  });

  test('accepts a current-user operator file under the canonical sticky system temp parent', async () => {
    const { inboxDirectory, operatorCwd } = await fixture();
    const filePath = path.join(tmpdir(), `plan052-operator-${randomUUID()}.json`);
    roots.push(filePath);
    await writeFile(filePath, '{"version":3}\n', { mode: 0o600 });

    const opened = await readUsageEngineInput(
      { filePath, kind: 'operator-file' },
      { inboxDirectory, maximumBytes: 1024, operatorCwd },
    );

    expect(opened.text).toBe('{"version":3}\n');
  });

  test('resolves only an owner-only inbox handoff and removes the same inode once', async () => {
    const { inboxDirectory, operatorCwd } = await fixture();
    const handoffPath = path.join(inboxDirectory, 'handoff-safe.upload');
    await writeFile(handoffPath, 'private payload', { mode: 0o600 });
    const opened = await readUsageEngineInput(
      { handoffId: parseUsageEngineHandoffId('handoff-safe'), kind: 'inbox-handoff' },
      { inboxDirectory, maximumBytes: 1024, operatorCwd },
    );

    expect(opened.text).toBe('private payload');
    await opened.remove?.();
    await opened.remove?.();
    expect(await Bun.file(handoffPath).exists()).toBe(false);
  });

  test('fails closed when a handoff gains a hard link after it was opened', async () => {
    const { inboxDirectory, operatorCwd } = await fixture();
    const handoffPath = path.join(inboxDirectory, 'handoff-raced.upload');
    const aliasPath = path.join(inboxDirectory, 'handoff-raced.alias');
    await writeFile(handoffPath, 'private payload', { mode: 0o600 });
    const opened = await readUsageEngineInput(
      { handoffId: parseUsageEngineHandoffId('handoff-raced'), kind: 'inbox-handoff' },
      { inboxDirectory, maximumBytes: 1024, operatorCwd },
    );
    await link(handoffPath, aliasPath);

    await expect(opened.remove?.()).rejects.toThrow('changed before removal');
    await expect(Bun.file(handoffPath).exists()).resolves.toBe(true);
    await expect(Bun.file(aliasPath).exists()).resolves.toBe(true);
  });

  test('stages a validated Cursor export privately and consumes a handoff only after success', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const handoffPath = path.join(inboxDirectory, 'cursor-safe.upload');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(handoffPath, csv, { mode: 0o600 });

    const result = await stageCursorUsageExport(
      { handoffId: parseUsageEngineHandoffId('cursor-safe'), kind: 'inbox-handoff' },
      { configCwd: root, inboxDirectory, operatorCwd },
    );

    expect(result.alreadyImported).toBe(false);
    expect(path.dirname(result.path)).toBe(path.join(root, '.ai-usage', 'cursor-exports'));
    expect(await Bun.file(handoffPath).exists()).toBe(false);
    expect(await Bun.file(result.path).text()).toBe(csv);
  });

  test('streams an operator Cursor export without changing its bytes or metadata', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const sourcePath = path.join(operatorCwd, 'cursor-operator.csv');
    const csv = `Date,User,Kind,Model,Cost\n${'2026-07-30,user,chat,gpt-5,1\n'.repeat(4096)}`;
    await writeFile(sourcePath, csv, { mode: 0o640 });
    const before = await lstat(sourcePath);
    const bytesBefore = await readFile(sourcePath);

    const first = await stageCursorUsageExport(
      { filePath: sourcePath, kind: 'operator-file' },
      { configCwd: root, inboxDirectory, operatorCwd },
    );
    const repeated = await stageCursorUsageExport(
      { filePath: sourcePath, kind: 'operator-file' },
      { configCwd: root, inboxDirectory, operatorCwd },
    );

    const after = await lstat(sourcePath);
    expect(repeated).toEqual({ alreadyImported: true, path: first.path });
    expect(await readFile(sourcePath)).toEqual(bytesBefore);
    expect({ ino: after.ino, mode: after.mode, modifiedAt: after.mtimeMs, size: after.size }).toEqual({
      ino: before.ino,
      mode: before.mode,
      modifiedAt: before.mtimeMs,
      size: before.size,
    });
    if (process.platform !== 'win32') {
      expect((await lstat(path.dirname(first.path))).mode % 0o1000).toBe(0o700);
      expect((await lstat(first.path)).mode % 0o1000).toBe(0o600);
    }
  });

  test('accepts the exact Cursor byte limit and rejects limit plus one', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const exactPath = path.join(operatorCwd, 'cursor-exact.csv');
    const oversizedPath = path.join(operatorCwd, 'cursor-oversized.csv');
    const exact = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(exactPath, exact);
    await writeFile(oversizedPath, `${exact}x`);
    const options = {
      configCwd: root,
      inboxDirectory,
      maximumBytes: Buffer.byteLength(exact),
      operatorCwd,
    };

    await expect(
      stageCursorUsageExport({ filePath: exactPath, kind: 'operator-file' }, options),
    ).resolves.toMatchObject({
      alreadyImported: false,
    });
    await expect(stageCursorUsageExport({ filePath: oversizedPath, kind: 'operator-file' }, options)).rejects.toThrow(
      'byte limit',
    );
    await expect(Bun.file(oversizedPath).text()).resolves.toBe(`${exact}x`);
  });

  test('consumes a safe handoff after streaming rejects invalid UTF-8', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const handoffPath = path.join(inboxDirectory, 'cursor-invalid-utf8.upload');
    const bytes = Buffer.concat([Buffer.from('Date,User,Kind,Model,Cost\n'), Buffer.from([0xff])]);
    await writeFile(handoffPath, bytes, { mode: 0o600 });

    await expect(
      stageCursorUsageExport(
        { handoffId: parseUsageEngineHandoffId('cursor-invalid-utf8'), kind: 'inbox-handoff' },
        { configCwd: root, inboxDirectory, operatorCwd },
      ),
    ).rejects.toThrow('valid UTF-8');
    await expect(Bun.file(handoffPath).exists()).resolves.toBe(false);
  });

  test('reuses and repairs a permissive legacy Cursor artifact without creating a duplicate', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const sourcePath = path.join(operatorCwd, 'cursor-legacy.csv');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(sourcePath, csv);
    const digest = createHash('sha256').update(csv).digest('hex');
    const importDirectory = path.join(root, '.ai-usage', 'cursor-exports');
    await mkdir(importDirectory, { mode: 0o700, recursive: true });
    const legacyPath = path.join(importDirectory, `${digest.slice(0, 12)}-cursor-legacy.csv`);
    await writeFile(legacyPath, csv, { mode: 0o644 });
    const legacyBefore = await lstat(legacyPath);

    await expect(listManagedCursorUsageExportPaths(root)).rejects.toThrow('not owner-only');
    expect((await lstat(legacyPath)).mode % 0o1000).toBe(process.platform === 'win32' ? 0o644 : 0o644);
    await repairManagedCursorUsageExportModes(root);
    expect(await listManagedCursorUsageExportPaths(root)).toEqual([legacyPath]);
    const legacyAfterRepair = await lstat(legacyPath);
    if (process.platform !== 'win32') {
      expect(legacyAfterRepair.ino).not.toBe(legacyBefore.ino);
    }

    const result = await stageCursorUsageExport(
      { filePath: sourcePath, kind: 'operator-file' },
      { configCwd: root, inboxDirectory, operatorCwd },
    );

    expect(result).toEqual({ alreadyImported: true, path: legacyPath });
    expect((await lstat(legacyPath)).mode % 0o1000).toBe(process.platform === 'win32' ? 0o644 : 0o600);
    expect((await import('node:fs/promises')).readdir(importDirectory)).resolves.toHaveLength(1);
  });

  test('rejects a hard-linked Cursor artifact without reading or chmoding its alias', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const sourcePath = path.join(operatorCwd, 'cursor-hardlink-source.csv');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(sourcePath, csv);
    const digest = createHash('sha256').update(csv).digest('hex');
    const importDirectory = path.join(root, '.ai-usage', 'cursor-exports');
    await mkdir(importDirectory, { mode: 0o700, recursive: true });
    const artifactPath = path.join(importDirectory, `${digest}.csv`);
    const aliasPath = path.join(root, 'cursor-hardlink-alias.csv');
    await writeFile(artifactPath, 'alias-private-bytes', { mode: 0o644 });
    await link(artifactPath, aliasPath);
    const aliasBefore = await lstat(aliasPath);
    const aliasBytesBefore = await readFile(aliasPath);

    await expect(
      stageCursorUsageExport(
        { filePath: sourcePath, kind: 'operator-file' },
        { configCwd: root, inboxDirectory, operatorCwd },
      ),
    ).rejects.toThrow('unsafe CSV artifact');

    const aliasAfter = await lstat(aliasPath);
    expect(await readFile(aliasPath)).toEqual(aliasBytesBefore);
    expect({ mode: aliasAfter.mode, nlink: aliasAfter.nlink }).toEqual({
      mode: aliasBefore.mode,
      nlink: aliasBefore.nlink,
    });
  });

  test('rejects symlinked Cursor state without changing the target or operator source', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const sourcePath = path.join(operatorCwd, 'cursor-symlink-source.csv');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(sourcePath, csv, { mode: 0o640 });
    const sourceBefore = await lstat(sourcePath);
    const targetDirectory = path.join(root, 'unmanaged-target');
    await mkdir(targetDirectory);
    await symlink(targetDirectory, path.join(root, '.ai-usage'));

    await expect(
      stageCursorUsageExport(
        { filePath: sourcePath, kind: 'operator-file' },
        { configCwd: root, inboxDirectory, operatorCwd },
      ),
    ).rejects.toThrow('directory is unsafe');

    const sourceAfter = await lstat(sourcePath);
    expect(await readFile(sourcePath)).toEqual(Buffer.from(csv));
    expect({ ino: sourceAfter.ino, mode: sourceAfter.mode }).toEqual({
      ino: sourceBefore.ino,
      mode: sourceBefore.mode,
    });
    expect((await import('node:fs/promises')).readdir(targetDirectory)).resolves.toEqual([]);
  });

  test('keeps a durable Cursor stage successful when handoff cleanup fails', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const handoffPath = path.join(inboxDirectory, 'cursor-cleanup-failure.upload');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    const cleanupFailures: string[] = [];
    await writeFile(handoffPath, csv, { mode: 0o600 });

    const result = await stageCursorUsageExport(
      { handoffId: parseUsageEngineHandoffId('cursor-cleanup-failure'), kind: 'inbox-handoff' },
      {
        configCwd: root,
        inboxDirectory,
        operatorCwd,
        performHandoffCleanup: () => Promise.reject(new Error('injected cleanup failure')),
        reportCleanupFailure: () => cleanupFailures.push('cursor-handoff'),
      },
    );

    expect(await Bun.file(result.path).text()).toBe(csv);
    expect(await Bun.file(handoffPath).exists()).toBe(true);
    expect(cleanupFailures).toEqual(['cursor-handoff']);
  });

  test('preserves an interrupted hard link instead of mutating either alias', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const csvPath = path.join(operatorCwd, 'cursor-repair.csv');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(csvPath, csv);
    const input = { filePath: csvPath, kind: 'operator-file' as const };
    const options = { configCwd: root, inboxDirectory, operatorCwd };
    const first = await stageCursorUsageExport(input, options);
    const interruptedTemporaryPath = path.join(
      path.dirname(first.path),
      '.cursor-2147483647-11111111-1111-4111-8111-111111111111.tmp',
    );
    await link(first.path, interruptedTemporaryPath);
    const old = new Date(Date.now() - 10_000);
    await utimes(interruptedTemporaryPath, old, old);

    const destinationBefore = await lstat(first.path);
    const aliasBytesBefore = await readFile(interruptedTemporaryPath);

    await expect(stageCursorUsageExport(input, options)).rejects.toThrow('preserved');

    expect(await readFile(interruptedTemporaryPath)).toEqual(aliasBytesBefore);
    expect((await lstat(interruptedTemporaryPath)).mode).toBe(destinationBefore.mode);
    expect((await lstat(first.path)).nlink).toBe(2);
  });

  test('preserves a recent live temporary alias instead of treating it as crash recovery', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const sourcePath = path.join(operatorCwd, 'cursor-live-alias.csv');
    const csv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    await writeFile(sourcePath, csv);
    const input = { filePath: sourcePath, kind: 'operator-file' as const };
    const options = { configCwd: root, inboxDirectory, operatorCwd };
    const first = await stageCursorUsageExport(input, options);
    const aliasPath = path.join(
      path.dirname(first.path),
      `.cursor-${process.pid}-44444444-4444-4444-8444-444444444444.tmp`,
    );
    await link(first.path, aliasPath);
    const aliasBefore = await lstat(aliasPath);

    await expect(stageCursorUsageExport(input, options)).rejects.toThrow('preserved');

    expect(await Bun.file(aliasPath).text()).toBe(csv);
    expect((await lstat(aliasPath)).mode).toBe(aliasBefore.mode);
    expect((await lstat(first.path)).nlink).toBe(2);
  });

  test('scavenges only old singly linked Cursor temporaries owned by a dead process', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const firstCsvPath = path.join(operatorCwd, 'cursor-first.csv');
    const secondCsvPath = path.join(operatorCwd, 'cursor-second.csv');
    const firstCsv = 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n';
    const secondCsv = 'Date,User,Kind,Model,Cost\n2026-07-31,user,chat,gpt-5,2\n';
    await writeFile(firstCsvPath, firstCsv);
    await writeFile(secondCsvPath, secondCsv);
    const options = { configCwd: root, inboxDirectory, operatorCwd };
    const first = await stageCursorUsageExport({ filePath: firstCsvPath, kind: 'operator-file' }, options);
    const importDirectory = path.dirname(first.path);
    const abandonedPath = path.join(importDirectory, '.cursor-2147483647-22222222-2222-4222-8222-222222222222.tmp');
    const liveOwnerPath = path.join(importDirectory, `.cursor-${process.pid}-33333333-3333-4333-8333-333333333333.tmp`);
    await writeFile(abandonedPath, firstCsv, { mode: 0o600 });
    await writeFile(liveOwnerPath, firstCsv, { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(abandonedPath, old, old);
    await utimes(liveOwnerPath, old, old);

    await stageCursorUsageExport({ filePath: secondCsvPath, kind: 'operator-file' }, options);

    await expect(Bun.file(abandonedPath).exists()).resolves.toBe(false);
    await expect(Bun.file(liveOwnerPath).exists()).resolves.toBe(true);
  });

  test('consumes a safe handoff after Cursor validation rejects it', async () => {
    const { inboxDirectory, operatorCwd, root } = await fixture();
    const handoffPath = path.join(inboxDirectory, 'cursor-invalid.upload');
    await writeFile(handoffPath, 'not,cursor,csv\n', { mode: 0o600 });

    await expect(
      stageCursorUsageExport(
        { handoffId: parseUsageEngineHandoffId('cursor-invalid'), kind: 'inbox-handoff' },
        { configCwd: root, inboxDirectory, operatorCwd },
      ),
    ).rejects.toThrow('not a Cursor');
    await expect(Bun.file(handoffPath).exists()).resolves.toBe(false);
  });

  test('scavenges only old safe exact handoffs and preserves recent or suspicious inbox entries', async () => {
    const { inboxDirectory } = await fixture();
    const old = new Date('2026-07-29T00:00:00.000Z');
    const now = Date.parse('2026-07-30T00:00:00.000Z');
    const stalePath = path.join(inboxDirectory, 'stale-handoff.upload');
    const recentPath = path.join(inboxDirectory, 'recent-handoff.upload');
    const foreignPath = path.join(inboxDirectory, 'foreign.txt');
    await writeFile(stalePath, 'stale', { mode: 0o600 });
    await writeFile(recentPath, 'recent', { mode: 0o600 });
    await writeFile(foreignPath, 'foreign', { mode: 0o600 });
    await utimes(stalePath, old, old);

    const result = await scavengeUsageEngineInbox({
      gracePeriodMs: 60_000,
      inboxDirectory,
      now,
    });

    expect(result).toEqual({ deletedBytes: 5, deletedFiles: 1, skippedSuspicious: 1 });
    await expect(Bun.file(stalePath).exists()).resolves.toBe(false);
    await expect(Bun.file(recentPath).exists()).resolves.toBe(true);
    await expect(Bun.file(foreignPath).exists()).resolves.toBe(true);
  });

  test('stops an inbox scan at its explicit entry bound', async () => {
    const { inboxDirectory } = await fixture();
    await writeFile(path.join(inboxDirectory, 'foreign-a.txt'), 'a');
    await writeFile(path.join(inboxDirectory, 'foreign-b.txt'), 'b');

    const result = await scavengeUsageEngineInbox({
      gracePeriodMs: 60_000,
      inboxDirectory,
      maximumEntries: 1,
      now: Date.parse('2026-07-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ deletedBytes: 0, deletedFiles: 0, skippedSuspicious: 2 });
  });
});
