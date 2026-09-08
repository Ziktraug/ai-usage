import { describe, expect, test } from 'bun:test';
import { runMemoryMcpProcess } from './main';

describe('Memory MCP process composition', () => {
  test('builds the local stdio composition without opening a Memory database', async () => {
    let connected = false;
    await runMemoryMcpProcess({
      connect: (server) => {
        connected = server !== null;
        return Promise.resolve();
      },
      cwd: '/workspace',
      environment: {
        AI_USAGE_ENGINE_STATE_DIR: '/isolated/state',
        AI_USAGE_HOME: '/isolated/home',
      },
    });
    expect(connected).toBe(true);
  });
});
