import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { codexAccountFingerprint, openCodexAppServer, resolveCodexCommand } from './codex-app-server-client';

const fixture = path.join(import.meta.dir, 'test-fixtures/fake-codex-review-app-server.ts');
describe('bounded Codex app-server transport', () => {
  test('rejects a relative executable before changing into the review checkout', () => {
    expect(() => resolveCodexCommand({ command: './codex' })).toThrow('must be absolute');
  });
  test.each(['malformed', 'oversized'])('rejects %s protocol before a usable client exists', async (mode) => {
    await expect(
      openCodexAppServer({
        command: process.execPath,
        args: [fixture, '', mode],
        maximumOutputBytes: 4096,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });
  test('fingerprint requires both reported account identities and never identifies API authentication as a subscription', () => {
    const first = codexAccountFingerprint({ type: 'chatgpt', email: 'one@example.test' }, { accountId: 'a' });
    expect(first).not.toBeNull();
    expect(codexAccountFingerprint({ type: 'chatgpt', email: 'one@example.test' }, { accountId: 'b' })).not.toBe(first);
    expect(codexAccountFingerprint({ type: 'chatgpt', email: 'two@example.test' }, { accountId: 'a' })).not.toBe(first);
    expect(codexAccountFingerprint({ type: 'chatgpt', email: 'one@example.test' }, {})).toBeNull();
    expect(codexAccountFingerprint({ type: 'apiKey', email: 'one@example.test' }, { accountId: 'a' })).toBeNull();
  });
});
