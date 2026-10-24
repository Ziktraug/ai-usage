import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BoundedProcessOptions,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { Effect } from 'effect';
import { discoverPullRequests, parsePullRequestSearch } from './github-pull-request-discovery';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
const fixture = (number = 12, repository = 'fixture/project') => ({
  number,
  repository: { nameWithOwner: repository },
  title: 'Synthetic change',
  url: `https://github.com/${repository}/pull/${String(number)}`,
  updatedAt: '2026-10-24T10:00:00Z',
  isDraft: false,
});
interface Response {
  readonly delayMs?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
}
const fakeGh = (responses: { readonly author?: Response; readonly review?: Response; readonly auth?: Response }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-usage-gh-discovery-'));
  roots.push(root);
  const command = path.join(root, 'gh');
  writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(responses));
  writeFileSync(path.join(root, 'calls.jsonl'), '');
  writeFileSync(
    command,
    `#!${process.execPath}\nimport {appendFileSync, readFileSync} from 'node:fs';\nconst args = process.argv.slice(2);\nconst scenario = JSON.parse(readFileSync(import.meta.dir + '/scenario.json','utf8'));\nappendFileSync(import.meta.dir + '/calls.jsonl',JSON.stringify({args, host:process.env.GH_HOST, tokenPresent:!!process.env.GH_TOKEN})+'\\n');\nprocess.stderr.write('PRIVATE_DISCOVERY_STDERR');\nconst response = args[0] === 'auth' ? scenario.auth : args.includes('--author=@me') ? scenario.author : scenario.review;\nif (response?.delayMs) await Bun.sleep(response.delayMs);\nprocess.stdout.write(response?.stdout ?? '[]');\nprocess.exit(response?.exitCode ?? 0);\n`,
  );
  chmodSync(command, 0o700);
  const calls: BoundedProcessOptions[] = [];
  const run: BoundedProcessRunner = (options) => {
    calls.push(options);
    return runBoundedProcess({ ...options, command });
  };
  return { run, calls, log: () => readFileSync(path.join(root, 'calls.jsonl'), 'utf8') };
};

describe('personal pull request discovery', () => {
  test('unions authors and review requests once with author precedence and bounded safe argv', async () => {
    const fake = fakeGh({
      author: { stdout: JSON.stringify([fixture(), fixture(13)]) },
      review: { stdout: JSON.stringify([fixture(), fixture(14)]) },
    });
    const result = await Effect.runPromise(discoverPullRequests({ run: fake.run }));
    expect(result).toMatchObject({ accountLabel: null, outcome: 'observed', outcomeMessage: null, truncated: false });
    expect(result.links.map((link) => [link.number, link.discoveryRole])).toEqual([
      [12, 'author'],
      [13, 'author'],
      [14, 'review-requested'],
    ]);
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.command).toBe('gh');
      expect(call.maximumOutputBytes).toBe(1024 * 1024);
      expect(call.timeoutMs).toBe(10_000);
      expect(call.args).toContain('--state=open');
      expect(call.args).toContain('number,repository,title,url,updatedAt,isDraft');
      expect(call.env?.GH_HOST).toBe('github.com');
      expect(call.env?.GH_PROMPT_DISABLED).toBe('1');
    }
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DISCOVERY_STDERR');
  });
  test('uses configured account token ephemerally and restricts configured scope', async () => {
    const fake = fakeGh({
      auth: { stdout: 'synthetic-token\n' },
      author: { stdout: JSON.stringify([fixture(), fixture(20, 'other/project')]) },
    });
    const result = await Effect.runPromise(
      discoverPullRequests({
        run: fake.run,
        account: { ghUser: 'fixture-user' },
        owners: ['fixture'],
        repositories: ['fixture/project'],
        environment: { GH_HOST: 'wrong.invalid' },
      }),
    );
    expect(result.links).toHaveLength(1);
    expect(result.accountLabel).toBe('fixture-user');
    expect(fake.calls[0]?.args).toEqual(['auth', 'token', '--user', 'fixture-user', '--hostname', 'github.com']);
    expect(fake.calls[1]?.env?.GH_TOKEN).toBe('synthetic-token');
    expect(fake.calls[1]?.args).toContain('--owner');
    expect(fake.calls[1]?.args).toContain('--repo');
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(fake.log()).not.toContain('synthetic-token');
  });
  test('caps at 50 per search and reports potentially truncated results', async () => {
    const rows = Array.from({ length: 60 }, (_, index) => fixture(index + 1));
    const fake = fakeGh({
      author: { stdout: JSON.stringify(rows) },
      review: { stdout: JSON.stringify(rows.map((row) => fixture(row.number + 100))) },
    });
    const result = await Effect.runPromise(discoverPullRequests({ run: fake.run, limit: 500 }));
    expect(result.links).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(fake.calls[0]?.args).toContain('50');
  });
  test('invalid scopes never spawn a process', async () => {
    const fake = fakeGh({});
    expect((await Effect.runPromise(discoverPullRequests({ run: fake.run, owners: ['--all'] }))).outcome).toBe(
      'invalid',
    );
    expect(fake.calls).toHaveLength(0);
  });
  test.each([
    [4, '', 'unauthenticated'],
    [1, '{"status":"401"}', 'unauthenticated'],
    [1, '{"status":404}', 'not-found'],
    [1, '', 'network'],
  ] as const)('classifies exit %s and retains no stderr', async (exitCode, stdout, outcome) => {
    const fake = fakeGh({ author: { exitCode, stdout } });
    const result = await Effect.runPromise(discoverPullRequests({ run: fake.run }));
    expect(result.outcome).toBe(outcome);
    expect(fake.calls).toHaveLength(1);
    expect(result.links).toEqual([]);
  });
  test('retains partial successful search facts alongside the second search failure', async () => {
    const fake = fakeGh({ author: { stdout: JSON.stringify([fixture()]) }, review: { exitCode: 4 } });
    const result = await Effect.runPromise(discoverPullRequests({ run: fake.run }));
    expect(result.outcome).toBe('unauthenticated');
    expect(result.links).toHaveLength(1);
  });
  test('missing binary, timeout, output ceiling and malformed success are visible', async () => {
    const unavailable: BoundedProcessRunner = (options) =>
      runBoundedProcess({ ...options, command: '/nonexistent/ai-usage-test-gh' });
    expect((await Effect.runPromise(discoverPullRequests({ run: unavailable }))).outcome).toBe('unavailable');
    const slow = fakeGh({ author: { delayMs: 1000 } });
    expect((await Effect.runPromise(discoverPullRequests({ run: slow.run, timeoutMs: 50 }))).outcome).toBe('timeout');
    const large = fakeGh({ author: { stdout: 'x'.repeat(2048) } });
    expect((await Effect.runPromise(discoverPullRequests({ run: large.run, maxOutputBytes: 512 }))).outcome).toBe(
      'invalid',
    );
    const malformed = fakeGh({ author: { stdout: '{}' } });
    expect((await Effect.runPromise(discoverPullRequests({ run: malformed.run }))).outcome).toBe('invalid');
  });
  test('strictly parses consumed fields and ignores unknown fields', () => {
    expect(parsePullRequestSearch(JSON.stringify([{ ...fixture(), extra: true }]))).toHaveLength(1);
    for (const row of [
      { ...fixture(), number: -1 },
      { ...fixture(), isDraft: 'no' },
      { ...fixture(), title: 12 },
      { ...fixture(), updatedAt: 'later' },
      { ...fixture(), repository: { name: 'project' } },
      { ...fixture(), url: 'https://evil.invalid/fixture/project/pull/12' },
    ]) {
      expect(parsePullRequestSearch(JSON.stringify([row]))).toBeNull();
    }
    expect(parsePullRequestSearch('{')).toBeNull();
    expect(parsePullRequestSearch('{}')).toBeNull();
  });
});

test('a configured account without a stored token is unauthenticated before searches', async () => {
  for (const response of [{ exitCode: 1, stdout: '' }, { stdout: '' }]) {
    const fake = fakeGh({ auth: response });
    const result = await Effect.runPromise(
      discoverPullRequests({ run: fake.run, account: { ghUser: 'fixture-user' } }),
    );
    expect(result.outcome).toBe('unauthenticated');
    expect(fake.calls).toHaveLength(1);
  }
});
