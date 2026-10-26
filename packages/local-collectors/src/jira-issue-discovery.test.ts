import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BoundedProcessOptions,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { Effect } from 'effect';
import { discoverJiraIssues, JIRA_DISCOVERY_JQL, parseJiraIssueSearch } from './jira-issue-discovery';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
const fakeAcli = (response: { readonly stdout?: string; readonly exitCode?: number; readonly delayMs?: number }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-usage-acli-discovery-'));
  roots.push(root);
  const command = path.join(root, 'acli');
  writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(response));
  writeFileSync(
    command,
    `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconst response = JSON.parse(readFileSync(import.meta.dir + '/scenario.json','utf8'));\nprocess.stderr.write('PRIVATE_JIRA_DISCOVERY_STDERR');\nif(response.delayMs) await Bun.sleep(response.delayMs);\nprocess.stdout.write(response.stdout ?? '[]');\nprocess.exit(response.exitCode ?? 0);\n`,
  );
  chmodSync(command, 0o700);
  const calls: BoundedProcessOptions[] = [];
  const run: BoundedProcessRunner = (options) => {
    calls.push(options);
    return runBoundedProcess({ ...options, command });
  };
  return { run, calls };
};

describe('personal Jira discovery with assumed CLI fixtures', () => {
  test('makes one bounded personal query and deduplicates issue keys', async () => {
    const fake = fakeAcli({
      stdout: JSON.stringify({
        issues: [{ key: 'DEMO-12', fields: { summary: 'Fake issue' } }, { key: 'DEMO-12' }, { key: 'DEMO-13' }],
        total: 3,
      }),
    });
    const result = await Effect.runPromise(discoverJiraIssues({ run: fake.run }));
    expect(result).toEqual({
      keys: ['DEMO-12', 'DEMO-13'],
      outcome: 'observed',
      outcomeMessage: null,
      truncated: false,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual([
      'jira',
      'workitem',
      'search',
      '--jql',
      JIRA_DISCOVERY_JQL,
      '--json',
      '--limit',
      '50',
    ]);
    expect(fake.calls[0]?.command).toBe('acli');
    expect(fake.calls[0]?.maximumOutputBytes).toBe(512 * 1024);
    expect(fake.calls[0]?.timeoutMs).toBe(10_000);
    expect(fake.calls[0]?.env).toEqual({ CI: '1', NO_COLOR: '1', PAGER: 'cat' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_JIRA_DISCOVERY_STDERR');
  });
  test('caps keys and reports search ceiling or envelope truncation', async () => {
    const fake = fakeAcli({
      stdout: JSON.stringify(Array.from({ length: 60 }, (_, index) => ({ key: `DEMO-${String(index + 1)}` }))),
    });
    const result = await Effect.runPromise(discoverJiraIssues({ run: fake.run, limit: 500 }));
    expect(result.keys).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(fake.calls[0]?.args).toContain('50');
    const envelope = fakeAcli({ stdout: JSON.stringify({ issues: [{ key: 'DEMO-12' }], total: 10 }) });
    expect((await Effect.runPromise(discoverJiraIssues({ run: envelope.run }))).truncated).toBe(true);
  });
  test('missing binary is unavailable rather than observed empty issues', async () => {
    const run: BoundedProcessRunner = (options) =>
      runBoundedProcess({ ...options, command: '/nonexistent/ai-usage-test-acli' });
    expect(await Effect.runPromise(discoverJiraIssues({ run }))).toEqual({
      keys: [],
      outcome: 'unavailable',
      outcomeMessage: 'acli not installed',
      truncated: false,
    });
  });
  test.each([
    [1, '{"status":401}', 'unauthenticated'],
    [1, '{"statusCode":"403"}', 'unauthenticated'],
    [1, '{"error":{"code":404}}', 'not-found'],
    [1, '', 'network'],
  ] as const)('classifies exit %s', async (exitCode, stdout, outcome) => {
    const fake = fakeAcli({ exitCode, stdout });
    expect((await Effect.runPromise(discoverJiraIssues({ run: fake.run }))).outcome).toBe(outcome);
  });
  test('bounds runtime/output and reports malformed bodies', async () => {
    const slow = fakeAcli({ delayMs: 1000 });
    expect((await Effect.runPromise(discoverJiraIssues({ run: slow.run, timeoutMs: 50 }))).outcome).toBe('timeout');
    const large = fakeAcli({ stdout: 'x'.repeat(2048) });
    expect((await Effect.runPromise(discoverJiraIssues({ run: large.run, maxOutputBytes: 512 }))).outcome).toBe(
      'invalid',
    );
    const malformed = fakeAcli({ stdout: '{}' });
    expect((await Effect.runPromise(discoverJiraIssues({ run: malformed.run }))).outcome).toBe('invalid');
  });
  test('strictly validates keys and optional envelope totals', () => {
    for (const value of [
      {},
      [{ key: 12 }],
      [{ key: 'DEMO-0' }],
      [{ key: 'demo-12' }],
      [{ key: '--all' }],
      { issues: [], total: '1' },
      { issues: [{ key: 'DEMO-12' }], total: 0 },
    ]) {
      expect(parseJiraIssueSearch(JSON.stringify(value))).toBeNull();
    }
    expect(parseJiraIssueSearch('not-json')).toBeNull();
    expect(parseJiraIssueSearch('[]')).toEqual({ keys: [], total: null });
  });
});
