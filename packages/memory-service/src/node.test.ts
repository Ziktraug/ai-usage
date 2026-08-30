import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MEMORY_SERVICE_PROTOCOL_VERSION } from './contracts';
import { createMemoryServiceToken, loadMemoryServiceRendezvous, publishMemoryServiceRendezvous } from './node';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('Memory service rendezvous', () => {
  test('publishes, validates, and removes one owner-only file', async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-rendezvous-'));
    roots.push(stateDirectory);
    const token = createMemoryServiceToken('0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
    const published = await publishMemoryServiceRendezvous({
      port: 4319,
      protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
      stateDirectory,
      token,
    });

    expect((await stat(published.path)).mode % 0o1000).toBe(0o600);
    expect(await loadMemoryServiceRendezvous(published.path)).toEqual({
      port: 4319,
      protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
      token,
    });
    await published.remove();
    await published.remove();
    await expect(loadMemoryServiceRendezvous(published.path)).rejects.toThrow();
  });

  test('preserves an existing rendezvous when abandonment cannot be proven', async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-rendezvous-'));
    roots.push(stateDirectory);
    const token = createMemoryServiceToken('0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
    const published = await publishMemoryServiceRendezvous({
      port: 4319,
      protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
      stateDirectory,
      token,
    });

    await expect(
      publishMemoryServiceRendezvous({
        port: 4320,
        protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
        stateDirectory,
        token,
      }),
    ).rejects.toThrow('already exists');
    expect(await loadMemoryServiceRendezvous(published.path)).toEqual({
      port: 4319,
      protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
      token,
    });
    await published.remove();
  });
});
