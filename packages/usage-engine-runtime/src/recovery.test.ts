import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isTrustedUsageEngineTemporaryRoot, scavengeLegacyUsageEngineArtifacts } from './recovery';

const fixtures: string[] = [];
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const OLD = new Date(NOW - 48 * 60 * 60 * 1000);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createFixture = async (): Promise<string> => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'plan052-engine-recovery-'));
  fixtures.push(fixture);
  return fixture;
};

const oldArtifact = async (root: string, name: string, bytes = 'fixture'): Promise<string> => {
  const directory = path.join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, 'artifact.bin'), bytes, { mode: 0o600 });
  await utimes(path.join(directory, 'artifact.bin'), OLD, OLD);
  await utimes(directory, OLD, OLD);
  return directory;
};

describe('legacy runtime artifact recovery', () => {
  test('accepts either a current-user root or a sticky shared system temp root', () => {
    expect(isTrustedUsageEngineTemporaryRoot({ mode: 0o700, uid: 1000 }, 1000)).toBe(true);
    expect(isTrustedUsageEngineTemporaryRoot({ mode: 0o755, uid: 1000 }, 1000)).toBe(false);
    expect(isTrustedUsageEngineTemporaryRoot({ mode: 0o777, uid: 1000 }, 1000)).toBe(false);
    expect(isTrustedUsageEngineTemporaryRoot({ mode: 0o1777, uid: 0 }, 1000)).toBe(true);
    expect(isTrustedUsageEngineTemporaryRoot({ mode: 0o755, uid: 0 }, 1000)).toBe(false);
    expect(isTrustedUsageEngineTemporaryRoot({ mode: 0o777, uid: 0 }, 1000)).toBe(false);
  });

  test('deletes only old exact-prefix owned trees and reports aggregate counts and bytes', async () => {
    const root = await createFixture();
    const lease = await oldArtifact(root, 'ai-usage-session-query-lease-owned', '12345');
    const revisions = await oldArtifact(root, 'ai-usage-report-revisions-owned', '1234567');
    const unrelated = await oldArtifact(root, 'ai-usage-other-owned', 'must stay');
    const result = await scavengeLegacyUsageEngineArtifacts({ gracePeriodMs: 60_000, now: NOW, temporaryRoot: root });

    expect(result).toEqual({ deletedBytes: 12, deletedEntries: 4, deletedRoots: 2, skippedSuspicious: 0 });
    await expect(Bun.file(lease).exists()).resolves.toBe(false);
    await expect(Bun.file(revisions).exists()).resolves.toBe(false);
    expect(await readFile(path.join(unrelated, 'artifact.bin'), 'utf8')).toBe('must stay');
  });

  test('skips recent, symlink-containing, and live-owned candidates without exposing their paths', async () => {
    const root = await createFixture();
    const recent = path.join(root, 'ai-usage-session-query-lease-recent');
    await mkdir(recent);
    await writeFile(path.join(recent, 'artifact.bin'), 'recent');

    const suspicious = await oldArtifact(root, 'ai-usage-report-revisions-symlink');
    const foreign = path.join(root, 'foreign');
    await writeFile(foreign, 'foreign');
    await symlink(foreign, path.join(suspicious, 'link'));
    await utimes(suspicious, OLD, OLD);

    const live = await oldArtifact(root, 'ai-usage-session-query-lease-live');
    await writeFile(
      path.join(live, '.owner.json'),
      `${JSON.stringify({ pid: process.pid, processStartTimeTicks: null })}\n`,
      { mode: 0o600 },
    );
    await utimes(path.join(live, '.owner.json'), OLD, OLD);
    await utimes(live, OLD, OLD);

    const result = await scavengeLegacyUsageEngineArtifacts({ gracePeriodMs: 60_000, now: NOW, temporaryRoot: root });
    expect(result).toEqual({ deletedBytes: 0, deletedEntries: 0, deletedRoots: 0, skippedSuspicious: 2 });
    await expect(Bun.file(path.join(recent, 'artifact.bin')).exists()).resolves.toBe(true);
    await expect(Bun.file(path.join(suspicious, 'link')).exists()).resolves.toBe(true);
    await expect(Bun.file(path.join(live, '.owner.json')).exists()).resolves.toBe(true);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  test('rejects an unsafe temporary root instead of scanning outside the injected boundary', async () => {
    const root = await createFixture();
    const target = await createFixture();
    const linkedRoot = path.join(root, 'linked-root');
    await symlink(target, linkedRoot);

    await expect(
      scavengeLegacyUsageEngineArtifacts({ gracePeriodMs: 60_000, now: NOW, temporaryRoot: linkedRoot }),
    ).rejects.toThrow('temporary root must be a canonical owned directory');
  });

  test('stops a root scan at its explicit entry bound', async () => {
    const root = await createFixture();
    await mkdir(path.join(root, 'unrelated-a'));
    await mkdir(path.join(root, 'unrelated-b'));

    const result = await scavengeLegacyUsageEngineArtifacts({
      gracePeriodMs: 60_000,
      maximumRootEntries: 1,
      now: NOW,
      temporaryRoot: root,
    });

    expect(result).toEqual({ deletedBytes: 0, deletedEntries: 0, deletedRoots: 0, skippedSuspicious: 1 });
  });
});
