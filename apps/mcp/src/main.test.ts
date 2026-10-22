import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalWorkContextMcpReadService, runMemoryMcpProcess } from './main';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-context-mcp-'));
  temporaryRoots.push(root);
  return root;
};

describe('Memory MCP process composition', () => {
  test('builds the local stdio composition without opening a Memory or usage database', async () => {
    const root = await temporaryRoot();
    let connected = false;
    await runMemoryMcpProcess({
      connect: (server) => {
        connected = server !== null;
        return Promise.resolve();
      },
      cwd: '/workspace',
      environment: {
        AI_USAGE_DATABASE_PATH: path.join(root, 'store', 'usage-store.sqlite'),
        AI_USAGE_ENGINE_STATE_DIR: '/isolated/state',
        AI_USAGE_HOME: '/isolated/home',
      },
    });
    expect(connected).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  test('reads the Work context read-only and reports a missing store as a typed code, never creating it', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    const work = createLocalWorkContextMcpReadService(dbPath);
    const signal = new AbortController().signal;

    expect(await work.readWorkContext({ checkoutPath: '/fixture/checkout', kind: 'checkout' }, signal)).toEqual({
      code: 'store-missing',
      kind: 'error',
    });
    expect(await work.readWorkContext({ checkoutPath: 'relative/checkout', kind: 'checkout' }, signal)).toEqual({
      code: 'invalid-input',
      kind: 'error',
    });
    expect(await readdir(root)).toEqual([]);
  });
});
