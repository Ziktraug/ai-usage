import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BoundedProcessRunner, runBoundedProcess } from '@ai-usage/local-machine/bounded-process';
import { canonicalInstantFromDate, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { Effect } from 'effect';
import { observePullRequests, parsePullRequestView, rollupChecks } from './github-pull-requests';

const NOW = new Date('2026-10-21T21:00:00.000Z');
const STDERR_SENTINEL = 'PRIVATE_FAKE_GH_STDERR_SENTINEL';
const TOKEN_SENTINEL = 'PRIVATE_GH_TOKEN_SENTINEL_0042';
const fixturePath = path.join(import.meta.dir, 'test-fixtures', 'fake-gh.ts');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

interface FakeCall {
  args: string[];
  environment: string[];
  token: string | null;
}

interface FakeGh {
  readonly calls: () => FakeCall[];
  readonly run: BoundedProcessRunner;
}

/** Installs the fake `gh` on a private PATH that also carries the Bun executable for its shebang. */
const installFakeGh = (scenario: Readonly<Record<string, unknown>>): FakeGh => {
  const binDirectory = mkdtempSync(path.join(tmpdir(), 'ai-usage-fake-gh-'));
  temporaryRoots.push(binDirectory);
  const ghPath = path.join(binDirectory, 'gh');
  copyFileSync(fixturePath, ghPath);
  chmodSync(ghPath, 0o700);
  writeFileSync(
    path.join(binDirectory, 'scenario.json'),
    JSON.stringify({ authToken: { stdout: `${TOKEN_SENTINEL}\n` }, ...scenario }),
  );
  const searchPath = [binDirectory, path.dirname(process.execPath)].join(path.delimiter);
  return {
    calls: () => {
      const logPath = path.join(binDirectory, 'calls.jsonl');
      if (!existsSync(logPath)) {
        return [];
      }
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FakeCall);
    },
    run: (options) => runBoundedProcess({ ...options, env: { ...options.env, PATH: searchPath } }),
  };
};

const view = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    baseRefName: 'main',
    headRefName: 'feat/work-view',
    isDraft: false,
    mergedAt: null,
    reviewDecision: 'REVIEW_REQUIRED',
    state: 'OPEN',
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'verify', status: 'COMPLETED' },
      { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS' },
    ],
    title: 'Add the Work view',
    updatedAt: '2026-10-21T18:30:00Z',
    url: 'https://github.com/fixture/project/pull/66',
    ...overrides,
  });

const link = (number: number, repository = 'fixture/project', host = 'github.com') => ({ host, number, repository });

const observe = (fake: FakeGh, options: Partial<Parameters<typeof observePullRequests>[0]> = {}) =>
  Effect.runPromise(
    observePullRequests({
      links: [link(66)],
      machineId: 'machine-a',
      now: () => NOW,
      run: fake.run,
      timeoutMs: 5000,
      ...options,
    }),
  );

describe('rollupChecks', () => {
  test('maps GitHub check states to the four-value rollup', () => {
    expect(rollupChecks([])).toBe('unknown');
    expect(rollupChecks(null)).toBe('unknown');
    expect(rollupChecks([{ state: 'SUCCESS' }, { conclusion: 'SKIPPED', status: 'COMPLETED' }])).toBe('success');
    expect(rollupChecks([{ state: 'SUCCESS' }, { conclusion: 'NEUTRAL', status: 'COMPLETED' }])).toBe('success');
    expect(rollupChecks([{ state: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe('pending');
    expect(rollupChecks([{ status: 'QUEUED' }, { conclusion: 'FAILURE', status: 'COMPLETED' }])).toBe('failure');
    expect(rollupChecks([{ state: 'ERROR' }])).toBe('failure');
    expect(rollupChecks([{ conclusion: 'CANCELLED', status: 'COMPLETED' }])).toBe('failure');
    expect(rollupChecks([{ conclusion: 'TIMED_OUT', status: 'COMPLETED' }])).toBe('failure');
    expect(rollupChecks([{ state: 'EXPECTED' }, { status: 'WAITING' }])).toBe('pending');
    expect(rollupChecks([{ state: 'SUCCESS' }, { conclusion: 'STALE', status: 'COMPLETED' }])).toBe('unknown');
    expect(rollupChecks([{ state: 'SUCCESS' }, 'not-an-object'])).toBe('unknown');
  });
});

describe('parsePullRequestView', () => {
  test('ignores unknown keys and rejects missing or mistyped expected ones', () => {
    expect(parsePullRequestView(view({ extra: 'ignored', reviewDecision: '' }), link(66))).toMatchObject({
      checksRollup: 'success',
      reviewDecision: null,
      state: 'OPEN',
      title: 'Add the Work view',
    });
    expect(parsePullRequestView(view({ state: 'open' }), link(66))).toBeNull();
    expect(parsePullRequestView(view({ isDraft: 'no' }), link(66))).toBeNull();
    expect(parsePullRequestView(view({ updatedAt: 'yesterday' }), link(66))).toBeNull();
    expect(parsePullRequestView(view({ url: 'https://github.com/other/project/pull/66' }), link(66))).toBeNull();
    expect(parsePullRequestView(view({ url: 'http://github.com/fixture/project/pull/66' }), link(66))).toBeNull();
    expect(parsePullRequestView(view({ statusCheckRollup: 'green' }), link(66))).toBeNull();
    expect(parsePullRequestView('not json', link(66))).toBeNull();
    expect(parsePullRequestView('[]', link(66))).toBeNull();
  });
});

describe('observePullRequests through a fake gh on PATH', () => {
  test('observes open, merged and draft pull requests, deduplicates links and bounds the batch', async () => {
    const fake = installFakeGh({
      pullRequests: {
        'fixture/project#66': { stdout: view() },
        'fixture/project#67': {
          stdout: view({
            mergedAt: '2026-10-20T09:00:00Z',
            reviewDecision: 'APPROVED',
            state: 'MERGED',
            statusCheckRollup: [{ __typename: 'StatusContext', state: 'FAILURE' }],
            url: 'https://github.com/fixture/project/pull/67',
          }),
        },
        'fixture/project#68': {
          stdout: view({
            isDraft: true,
            reviewDecision: null,
            statusCheckRollup: [{ __typename: 'CheckRun', conclusion: null, status: 'IN_PROGRESS' }],
            url: 'https://github.com/fixture/project/pull/68',
          }),
        },
      },
    });
    const batch = await observe(fake, {
      links: [
        link(66),
        link(67),
        { host: 'GitHub.com', number: 66, repository: 'fixture/project' },
        link(68),
        link(69),
      ],
      maxLinks: 3,
    });
    expect(batch.truncated).toBe(true);
    expect(batch.rejected).toBe(0);
    expect(batch.accountLabel).toBeNull();
    expect(batch.observations).toHaveLength(3);
    expect(batch.observations[0]).toEqual({
      accountLabel: null,
      baseRef: 'main',
      checksRollup: 'success',
      discoveryRole: null,
      draft: false,
      headRef: 'feat/work-view',
      host: 'github.com',
      machineId: 'machine-a',
      mergeable: null,
      mergedAt: null,
      mergeStateStatus: null,
      number: 66,
      observedAt: canonicalInstantFromDate(NOW),
      outcome: 'observed',
      outcomeMessage: null,
      repository: 'fixture/project',
      reviewDecision: 'REVIEW_REQUIRED',
      state: 'OPEN',
      title: 'Add the Work view',
      updatedAt: parseCanonicalInstant('2026-10-21T18:30:00.000Z'),
      url: 'https://github.com/fixture/project/pull/66',
    });
    expect(batch.observations[1]).toMatchObject({
      checksRollup: 'failure',
      mergedAt: '2026-10-20T09:00:00.000Z',
      number: 67,
      outcome: 'observed',
      reviewDecision: 'APPROVED',
      state: 'MERGED',
    });
    expect(batch.observations[2]).toMatchObject({
      checksRollup: 'pending',
      draft: true,
      number: 68,
      outcome: 'observed',
      reviewDecision: null,
    });
    const calls = fake.calls();
    expect(calls[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(calls.slice(1).map(({ args }) => args.slice(0, 5))).toEqual([
      ['pr', 'view', '66', '--repo', 'fixture/project'],
      ['pr', 'view', '67', '--repo', 'fixture/project'],
      ['pr', 'view', '68', '--repo', 'fixture/project'],
    ]);
    expect(calls[1]?.args.slice(5)).toEqual([
      '--json',
      'state,isDraft,reviewDecision,mergedAt,mergeable,mergeStateStatus,updatedAt,title,url,headRefName,baseRefName,statusCheckRollup',
    ]);
    expect(calls[0]?.token).toBeNull();
    expect(calls.slice(1).map(({ token }) => token)).toEqual([TOKEN_SENTINEL, TOKEN_SENTINEL, TOKEN_SENTINEL]);
    for (const call of calls) {
      expect(call.environment).toContain('GH_PROMPT_DISABLED');
      expect(call.environment).toContain('GH_NO_UPDATE_NOTIFIER');
    }
    expect(JSON.stringify(batch)).not.toContain(STDERR_SENTINEL);
  });

  test('records unsupported hosts and malformed links without calling gh', async () => {
    const fake = installFakeGh({});
    const batch = await observe(fake, {
      links: [
        link(12, 'group/project', 'gitlab.com'),
        { host: 'github.com', number: 0, repository: 'fixture/project' },
        { host: 'github.com', number: 5, repository: 'not-a-repository' },
      ],
    });
    expect(batch.rejected).toBe(2);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        host: 'gitlab.com',
        number: 12,
        outcome: 'disabled',
        outcomeMessage: 'host not supported in this version',
        state: null,
      }),
    ]);
    expect(fake.calls()).toEqual([]);
  });

  test('maps exit 4 to unauthenticated and stops calling for the rest of the run', async () => {
    const fake = installFakeGh({ pullRequests: { 'fixture/project#66': { exitCode: 4 } } });
    const batch = await observe(fake, { links: [link(66), link(67)] });
    expect(batch.observations.map(({ number, outcome, outcomeMessage }) => [number, outcome, outcomeMessage])).toEqual([
      [66, 'unauthenticated', 'gh reported that authentication is required (exit 4)'],
      [67, 'unauthenticated', 'not attempted: gh reported that authentication is required (exit 4)'],
    ]);
    expect(fake.calls()).toHaveLength(2);
  });

  test('distinguishes not-found from network silence with one bounded REST follow-up', async () => {
    const fake = installFakeGh({
      api: {
        'repos/fixture/project/pulls/404': {
          exitCode: 1,
          stdout: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
        },
        'repos/fixture/project/pulls/401': { exitCode: 1, stdout: '{"message":"Bad credentials","status":"401"}' },
      },
      pullRequests: {
        'fixture/project#404': { exitCode: 1 },
        'fixture/project#401': { exitCode: 1 },
        'fixture/project#500': { exitCode: 1 },
        'fixture/project#67': { stdout: view({ url: 'https://github.com/fixture/project/pull/67' }) },
      },
    });
    const notFound = await observe(fake, { links: [link(404), link(67)] });
    expect(notFound.observations.map(({ outcome }) => outcome)).toEqual(['not-found', 'observed']);
    expect(notFound.observations[0]?.outcomeMessage).toBe(
      'GitHub returned HTTP 404 (not found or not visible to this account)',
    );

    const beforeNetwork = fake.calls().length;
    const network = await observe(fake, { links: [link(500), link(67)] });
    expect(network.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
      ['network', 'gh exited 1 without output (network failure or not found)'],
      ['network', 'not attempted: gh exited 1 without output (network failure or not found)'],
    ]);

    const networkCalls = fake.calls().slice(beforeNetwork);
    expect(networkCalls.map(({ args }) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['pr', 'view'],
      ['api', 'repos/fixture/project/pulls/500'],
    ]);
    expect(networkCalls.slice(1).map(({ token }) => token)).toEqual([TOKEN_SENTINEL, TOKEN_SENTINEL]);
    expect(JSON.stringify(network)).not.toContain(TOKEN_SENTINEL);

    const rejected = await observe(fake, { links: [link(401), link(67)] });
    expect(rejected.observations.map(({ outcome }) => outcome)).toEqual(['unauthenticated', 'unauthenticated']);
    expect(rejected.observations[0]?.outcomeMessage).toBe('GitHub rejected the credentials (HTTP 401)');

    const apiCalls = fake.calls().filter(({ args }) => args[0] === 'api');
    expect(apiCalls.map(({ args }) => args[1])).toEqual([
      'repos/fixture/project/pulls/404',
      'repos/fixture/project/pulls/500',
      'repos/fixture/project/pulls/401',
    ]);
  });

  test('records a timeout and does not wait on the remaining links', async () => {
    const fake = installFakeGh({
      pullRequests: {
        'fixture/project#66': { delayMs: 3000, stdout: view() },
        'fixture/project#67': { stdout: view({ url: 'https://github.com/fixture/project/pull/67' }) },
      },
    });
    const startedAt = performance.now();
    const batch = await observe(fake, { links: [link(66), link(67)], timeoutMs: 200 });
    expect(performance.now() - startedAt).toBeLessThan(2500);
    expect(batch.observations.map(({ outcome }) => outcome)).toEqual(['timeout', 'timeout']);
    expect(batch.observations[1]?.outcomeMessage).toBe('not attempted: gh timed out');
    expect(fake.calls()).toHaveLength(2);
  });

  test('records malformed or mismatched JSON as invalid and keeps going', async () => {
    const fake = installFakeGh({
      pullRequests: {
        'fixture/project#66': { stdout: '{"state":"OPEN",' },
        'fixture/project#67': { stdout: view({ url: 'https://github.com/elsewhere/project/pull/67' }) },
        'fixture/project#68': { stdout: view({ url: 'https://github.com/fixture/project/pull/68' }) },
      },
    });
    const batch = await observe(fake, { links: [link(66), link(67), link(68)] });
    expect(batch.observations.map(({ outcome }) => outcome)).toEqual(['invalid', 'invalid', 'observed']);
    expect(batch.observations[0]?.outcomeMessage).toBe('gh returned an unexpected pull request shape');
  });

  test('reports a missing gh as disabled without any other call', async () => {
    const batch = await Effect.runPromise(
      observePullRequests({
        links: [link(66), link(67)],
        machineId: 'machine-a',
        now: () => NOW,
        run: (options) => runBoundedProcess({ ...options, env: { ...options.env, PATH: '/nonexistent-bin' } }),
      }),
    );
    expect(batch.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
      ['disabled', 'not attempted: gh is not installed'],
      ['disabled', 'not attempted: gh is not installed'],
    ]);
  });

  test('passes a configured account token to gh pr view only and never into an observation', async () => {
    const fake = installFakeGh({
      authToken: { stdout: `${TOKEN_SENTINEL}\n` },
      pullRequests: { 'fixture/project#66': { stdout: view() } },
    });
    const batch = await observe(fake, { account: { ghUser: 'alice' } });
    expect(batch.accountLabel).toBe('alice');
    expect(batch.observations[0]).toMatchObject({ accountLabel: 'alice', outcome: 'observed', state: 'OPEN' });
    expect(JSON.stringify(batch)).not.toContain(TOKEN_SENTINEL);
    const calls = fake.calls();
    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['pr', 'view'],
    ]);
    expect(calls[0]?.args).toEqual(['auth', 'token', '--user', 'alice', '--hostname', 'github.com']);
    expect(calls[0]?.token).toBeNull();
    expect(calls[1]?.token).toBe(TOKEN_SENTINEL);
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(batch)).not.toContain(STDERR_SENTINEL);
  });

  test('records every link as unauthenticated when the configured account has no stored token', async () => {
    const fake = installFakeGh({
      authToken: { exitCode: 1 },
      pullRequests: { 'fixture/project#66': { stdout: view() } },
    });
    const batch = await observe(fake, { account: { ghUser: 'alice' }, links: [link(66), link(67)] });
    expect(batch.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
      ['unauthenticated', 'not attempted: gh has no stored token for alice on github.com'],
      ['unauthenticated', 'not attempted: gh has no stored token for alice on github.com'],
    ]);
    expect(fake.calls().map(({ args }) => args[0])).toEqual(['auth']);
  });
});

describe('pull request discovery roles and mergeability', () => {
  test('keeps behind separate from conflict and accepts old missing fields', () => {
    expect(parsePullRequestView(view(), link(66))).toMatchObject({ mergeable: null, mergeStateStatus: null });
    expect(parsePullRequestView(view({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }), link(66))).toMatchObject({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
    });
    expect(parsePullRequestView(view({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), link(66))).toMatchObject(
      { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    );
    expect(
      parsePullRequestView(view({ mergeable: 'UNKNOWN', mergeStateStatus: 'FUTURE_STATUS' }), link(66)),
    ).toMatchObject({ mergeable: 'UNKNOWN', mergeStateStatus: 'FUTURE_STATUS' });
    expect(parsePullRequestView(view({ mergeable: 'yes' }), link(66))).toBeNull();
    expect(parsePullRequestView(view({ mergeStateStatus: 42 }), link(66))).toBeNull();
  });
  test('propagates a discovery role and requests raw mergeability fields', async () => {
    const fake = installFakeGh({
      pullRequests: { 'fixture/project#66': { stdout: view({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }) } },
    });
    const batch = await observe(fake, { links: [{ ...link(66), discoveryRole: 'review-requested' }] });
    expect(batch.observations[0]).toMatchObject({
      discoveryRole: 'review-requested',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
    });
    const fields = fake
      .calls()
      .find(({ args }) => args[0] === 'pr')
      ?.args.at(-1)
      ?.split(',');
    expect(fields).toContain('mergeable');
    expect(fields).toContain('mergeStateStatus');
  });
  test('link-only observations have a null role and failed discoveries retain their role', async () => {
    const good = installFakeGh({ pullRequests: { 'fixture/project#66': { stdout: view() } } });
    expect((await observe(good)).observations[0]?.discoveryRole).toBeNull();
    const failed = installFakeGh({ pullRequests: { 'fixture/project#66': { exitCode: 4 } } });
    expect(
      (await observe(failed, { links: [{ ...link(66), discoveryRole: 'author' }] })).observations[0],
    ).toMatchObject({ discoveryRole: 'author', outcome: 'unauthenticated', mergeable: null, mergeStateStatus: null });
  });
});

test('resolves the active account token before observing when automatic credential lookup fails', async () => {
  const fake = installFakeGh({
    authToken: { stdout: `${TOKEN_SENTINEL}\n` },
    pullRequests: {
      'fixture/project#66': { stdout: view() },
      'fixture/project#67': { stdout: view({ url: 'https://github.com/fixture/project/pull/67' }) },
    },
  });
  const requireExplicitToken: BoundedProcessRunner = (options) => {
    if (options.args[0] === 'pr' && options.env?.GH_TOKEN !== TOKEN_SENTINEL) {
      return Effect.succeed({ durationMs: 0, exitCode: 4, stdout: '' });
    }
    return fake.run(options);
  };
  const stderr = spyOn(process.stderr, 'write');
  try {
    const batch = await observe(fake, { links: [link(66), link(67)], run: requireExplicitToken });
    expect(batch.observations.map(({ outcome }) => outcome)).toEqual(['observed', 'observed']);
    expect(batch.accountLabel).toBeNull();
    expect(fake.calls().map(({ args }) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['pr', 'view'],
      ['pr', 'view'],
    ]);
    expect(fake.calls()[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(fake.calls()[0]?.token).toBeNull();
    expect(
      fake
        .calls()
        .slice(1)
        .map(({ token }) => token),
    ).toEqual([TOKEN_SENTINEL, TOKEN_SENTINEL]);
    expect(JSON.stringify(fake.calls().map(({ args }) => args))).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(batch)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(batch)).not.toContain(STDERR_SENTINEL);
    const emittedStderr = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(emittedStderr).not.toContain(TOKEN_SENTINEL);
    expect(emittedStderr).not.toContain(STDERR_SENTINEL);
  } finally {
    stderr.mockRestore();
  }
});

test.each([
  { stdout: '' },
  { stdout: '  \n\t' },
  { exitCode: 1, stdout: '' },
])('halts the active-account batch when no usable token is returned: %j', async (authToken) => {
  const fake = installFakeGh({
    authToken,
    pullRequests: { 'fixture/project#66': { stdout: view() } },
  });
  const batch = await observe(fake, { links: [link(66), link(67)] });
  expect(batch.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
    ['unauthenticated', 'not attempted: gh has no stored token for the active account on github.com'],
    ['unauthenticated', 'not attempted: gh has no stored token for the active account on github.com'],
  ]);
  expect(fake.calls().map(({ args }) => args)).toEqual([['auth', 'token', '--hostname', 'github.com']]);
  expect(JSON.stringify(batch)).not.toContain(TOKEN_SENTINEL);
  expect(JSON.stringify(batch)).not.toContain(STDERR_SENTINEL);
});

test('halts after a bounded active-account token read timeout without observing a link', async () => {
  const fake = installFakeGh({ authToken: { delayMs: 3000, stdout: TOKEN_SENTINEL } });
  const batch = await observe(fake, { links: [link(66), link(67)], timeoutMs: 200 });
  expect(batch.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
    ['timeout', 'not attempted: gh timed out while reading the account token'],
    ['timeout', 'not attempted: gh timed out while reading the account token'],
  ]);
  expect(fake.calls().map(({ args }) => args)).toEqual([['auth', 'token', '--hostname', 'github.com']]);
  expect(JSON.stringify(batch)).not.toContain(TOKEN_SENTINEL);
});
