import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type CodexMcpCommandRunner,
  memoryMcpServerName,
  registerCodexMemoryMcp,
  registerJsonMemoryMcp,
} from './registration';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-mcp-registration-'));
  roots.push(root);
  const privateStatePath = path.join(root, 'private');
  const registration = {
    args: ['/workspace/apps/mcp/src/main.ts'],
    command: '/usr/bin/bun',
  } as const;
  return { privateStatePath, registration, root };
};

describe('Memory MCP registration', () => {
  test('atomically adds one managed JSON entry, preserves other entries, and is idempotent under concurrency', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const configPath = path.join(root, '.mcp.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: { existing: { command: 'existing', args: [] } }, unrelated: true })}\n`,
    );

    const results = await Promise.all([
      registerJsonMemoryMcp({ configPath, privateStatePath, registration }),
      registerJsonMemoryMcp({ configPath, privateStatePath, registration }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(['created', 'unchanged']);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        [memoryMcpServerName]: registration,
        existing: { args: [], command: 'existing' },
      },
      unrelated: true,
    });
  });

  test('refuses a same-name unmanaged JSON entry without changing the file', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const configPath = path.join(root, 'mcp.json');
    const original = `${JSON.stringify({ mcpServers: { [memoryMcpServerName]: { args: [], command: 'other' } } })}\n`;
    await writeFile(configPath, original);

    await expect(registerJsonMemoryMcp({ configPath, privateStatePath, registration })).resolves.toEqual({
      kind: 'refused-unmanaged',
      reason: 'existing-server-differs',
      serverName: memoryMcpServerName,
    });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  test('refuses a symlink JSON target', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const actualPath = path.join(root, 'actual.json');
    const configPath = path.join(root, '.mcp.json');
    await writeFile(actualPath, '{}\n');
    await symlink(actualPath, configPath);
    await expect(registerJsonMemoryMcp({ configPath, privateStatePath, registration })).rejects.toThrow(
      'regular non-symlink file',
    );
  });

  test('uses Codex list/add/list while refusing an existing different entry', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const codexDirectory = path.join(root, '.codex');
    await mkdir(codexDirectory);
    const configPath = path.join(codexDirectory, 'config.toml');
    let server: unknown;
    const calls: string[][] = [];
    const runner: CodexMcpCommandRunner = {
      run: (args) => {
        calls.push([...args]);
        if (args[1] === 'list') {
          return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(server === undefined ? [] : [server]) });
        }
        server = {
          enabled: true,
          name: memoryMcpServerName,
          transport: { args: registration.args, command: registration.command, type: 'stdio' },
        };
        return Promise.resolve({ exitCode: 0, stdout: '' });
      },
    };

    await expect(registerCodexMemoryMcp({ configPath, privateStatePath, registration, runner })).resolves.toMatchObject(
      { kind: 'created' },
    );
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'add', memoryMcpServerName, '--', registration.command, ...registration.args],
      ['mcp', 'list', '--json'],
    ]);

    server = {
      enabled: true,
      name: memoryMcpServerName,
      transport: { args: [], command: 'unmanaged', type: 'stdio' },
    };
    calls.length = 0;
    await expect(registerCodexMemoryMcp({ configPath, privateStatePath, registration, runner })).resolves.toMatchObject(
      { kind: 'refused-unmanaged' },
    );
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });
});
