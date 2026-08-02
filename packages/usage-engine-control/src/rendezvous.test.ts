import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  parseUsageEngineLoopbackOrigin,
  parseUsageEngineRendezvous,
  UsageEngineRendezvousError,
  usageEngineLoopbackOrigin,
  usageEngineTargetIdFor,
} from './rendezvous';

const roots: string[] = [];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const rendezvousValue = {
  instanceId: '11111111-1111-4111-8111-111111111111',
  port: 41_321,
  protocolVersion: 1,
  targetId: 'a'.repeat(64),
  token: 'fixture-token-with-at-least-thirty-two-bytes',
};

describe('usage engine rendezvous', () => {
  test('loads an owner-only regular file and fixes the origin to numeric loopback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-engine-rendezvous-'));
    roots.push(root);
    const filePath = path.join(root, 'engine.json');
    await writeFile(filePath, `${JSON.stringify(rendezvousValue)}\n`, { mode: 0o600 });

    const rendezvous = await loadUsageEngineRendezvous(filePath);
    expect(String(usageEngineLoopbackOrigin(rendezvous))).toBe('http://127.0.0.1:41321');
    expect(String(rendezvous.token)).toBe('[REDACTED]');
    expect(JSON.stringify(rendezvous)).not.toContain(rendezvousValue.token);
  });

  test('waits through the exact transient hard-link publication window', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-engine-rendezvous-'));
    roots.push(root);
    const filePath = path.join(root, 'engine.json');
    const temporaryPath = path.join(root, '.rendezvous-123-11111111-1111-4111-8111-111111111111.tmp');
    await writeFile(filePath, `${JSON.stringify(rendezvousValue)}\n`, { mode: 0o600 });
    await link(filePath, temporaryPath);
    const finishPublication = Bun.sleep(20).then(async () => await rm(temporaryPath));

    await expect(loadUsageEngineRendezvous(filePath)).resolves.toMatchObject({ port: 41_321 });
    await finishPublication;
  });

  test('rejects symlinks, permissive files, unknown fields, and oversized documents', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-engine-rendezvous-'));
    roots.push(root);
    const filePath = path.join(root, 'engine.json');
    const linkPath = path.join(root, 'engine-link.json');
    const hardLinkPath = path.join(root, 'engine-hard-link.json');
    await writeFile(filePath, `${JSON.stringify(rendezvousValue)}\n`, { mode: 0o600 });
    await symlink(filePath, linkPath);
    await expect(loadUsageEngineRendezvous(linkPath)).rejects.toThrow('regular');

    await link(filePath, hardLinkPath);
    await expect(loadUsageEngineRendezvous(filePath)).rejects.toThrow('regular');
    await rm(hardLinkPath);

    await chmod(filePath, 0o644);
    await expect(loadUsageEngineRendezvous(filePath)).rejects.toThrow('owner-only');

    expect(() => parseUsageEngineRendezvous({ ...rendezvousValue, host: '127.0.0.1' })).toThrow('unknown');
    expect(() => parseUsageEngineRendezvous({ ...rendezvousValue, token: 'x'.repeat(5000) })).toThrow('token');
    expect(() => parseUsageEngineRendezvous({ ...rendezvousValue, token: '🔥'.repeat(32) })).toThrow('token');
    expect(() => parseUsageEngineRendezvous({ ...rendezvousValue, token: `${'x'.repeat(32)}+` })).toThrow('token');
    expect(() => parseUsageEngineRendezvous({ ...rendezvousValue, targetId: 'A'.repeat(64) })).toThrow('target');
    expect(() => parseUsageEngineRendezvous({ ...rendezvousValue, targetId: 'a'.repeat(63) })).toThrow('target');
    expect(() => usageEngineTargetIdFor({ configCwd: 'relative', databasePath: '/absolute/store' })).toThrow(
      'absolute',
    );
  });

  test('classifies a rendezvous protocol mismatch without exposing its contents', () => {
    const parseMismatch = (): void => {
      parseUsageEngineRendezvous({ ...rendezvousValue, protocolVersion: 2 });
    };
    expect(parseMismatch).toThrow(UsageEngineRendezvousError);
    expect(parseMismatch).toThrow(expect.objectContaining({ reason: 'protocol-mismatch' }));
  });

  test('binds rendezvous discovery to an opaque database and config target', () => {
    const databasePath = '/isolated/store/usage.sqlite';
    const configCwd = '/isolated/config';
    const targetId = usageEngineTargetIdFor({ configCwd, databasePath });
    const rendezvous = parseUsageEngineRendezvous({ ...rendezvousValue, targetId });

    expect(targetId).toMatch(SHA256_PATTERN);
    expect(targetId).toBe(usageEngineTargetIdFor({ configCwd, databasePath }));
    expect(targetId).not.toBe(usageEngineTargetIdFor({ configCwd, databasePath: `${databasePath}.other` }));
    expect(targetId).not.toBe(usageEngineTargetIdFor({ configCwd: `${configCwd}.other`, databasePath }));
    expect(JSON.stringify(rendezvous)).not.toContain(databasePath);
    expect(JSON.stringify(rendezvous)).not.toContain(configCwd);
    expect(() => assertUsageEngineRendezvousTarget(rendezvous, targetId)).not.toThrow();
    expect(() => assertUsageEngineRendezvousTarget(rendezvous, 'b'.repeat(64))).toThrow(
      expect.objectContaining({ reason: 'target-mismatch' }),
    );
  });

  test('rejects invalid UTF-8 and a non-private rendezvous directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-engine-rendezvous-'));
    roots.push(root);
    const filePath = path.join(root, 'engine.json');
    await writeFile(filePath, Uint8Array.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(loadUsageEngineRendezvous(filePath)).rejects.toThrow('UTF-8');

    await writeFile(filePath, `${JSON.stringify(rendezvousValue)}\n`, { mode: 0o600 });
    await chmod(root, 0o755);
    await expect(loadUsageEngineRendezvous(filePath)).rejects.toThrow('directory');
  });

  test('accepts only the canonical numeric loopback origin', () => {
    expect(String(parseUsageEngineLoopbackOrigin('http://127.0.0.1:41321'))).toBe('http://127.0.0.1:41321');
    for (const origin of [
      'http://localhost:41321',
      'http://127.0.0.2:41321',
      'http://127.1:41321',
      'http://[::1]:41321',
      'https://127.0.0.1:41321',
      'http://user@127.0.0.1:41321',
      'http://127.0.0.1:41321/path',
    ]) {
      expect(() => parseUsageEngineLoopbackOrigin(origin)).toThrow('loopback');
    }
  });
});
