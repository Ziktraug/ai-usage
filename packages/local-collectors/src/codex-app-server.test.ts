import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { CodexQuotaCollectionError, createCodexAppServerBatchSource } from './codex-app-server';
import { codexAccountFingerprint } from './codex-app-server-client';

const fixturePath = path.join(import.meta.dir, 'test-fixtures', 'fake-codex-app-server.ts');

describe('Codex app-server quota collector', () => {
  test('binds quota to the same ChatGPT account handshake used by launch', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-app-server-'));
    const logPath = path.join(directory, 'requests.json');
    const source = createCodexAppServerBatchSource({
      args: [fixturePath, logPath, 'success'],
      command: process.execPath,
      timeoutMs: 2000,
    });

    const result = await Effect.runPromise(
      source.collect({
        accountScope:
          codexAccountFingerprint({ type: 'chatgpt', email: 'quota@example.test' }, { accountId: 'quota-account' }) ??
          '',
        machineId: 'machine-1',
        machineLabel: 'Laptop',
        observedAt: new Date('2026-07-15T10:00:00.000Z'),
      }),
    );

    expect(result.observations[0]?.windows.map(({ label }) => label)).toEqual(['5h', 'Weekly']);
    expect(JSON.parse(readFileSync(logPath, 'utf8'))).toEqual([
      { id: 1, method: 'initialize' },
      { method: 'initialized' },
      { id: 2, method: 'account/read' },
      { id: 3, method: 'account/rateLimits/read' },
    ]);
  });

  test('maps auth RPC failures without retaining raw response bodies', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-app-server-auth-'));
    const source = createCodexAppServerBatchSource({
      args: [fixturePath, path.join(directory, 'requests.json'), 'auth-error'],
      command: process.execPath,
      timeoutMs: 2000,
    });

    const result = await Effect.runPromise(
      Effect.result(source.collect({ machineId: 'machine-1', observedAt: new Date() })),
    );

    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(CodexQuotaCollectionError);
      expect(result.failure.reason).toBe('auth-required');
      expect(result.failure.message).not.toContain('secret fixture detail');
    }
  });
});
