import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BoundedProcessRunner, runBoundedProcess } from '@ai-usage/local-machine/bounded-process';
import { canonicalInstantFromDate, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { parsePullRequestObservation } from '@ai-usage/report-core/work-attention';
import { Effect, Exit } from 'effect';
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

interface FakeResponse {
  readonly delayMs?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
}
interface FakeScenario {
  readonly api?: Readonly<Record<string, FakeResponse>>;
  readonly authToken?: FakeResponse;
  readonly pullRequests?: Readonly<Record<string, FakeResponse>>;
}
const emptyConnection = { totalCount: 0, nodes: [] };
const STATUS_HISTORY_ONLY_PATTERN = /^Status history unavailable: /;
const reviewThreadsBody = (
  nodes: readonly unknown[],
  totalCount = nodes.length,
  history: { readonly reviews?: unknown; readonly timelineItems?: unknown } = {},
) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { totalCount, nodes },
          reviews: history.reviews ?? emptyConnection,
          timelineItems: history.timelineItems ?? emptyConnection,
        },
      },
    },
  });

/** Installs the fake `gh` on a private PATH that also carries the Bun executable for its shebang. */
const installFakeGh = (scenario: FakeScenario): FakeGh => {
  const binDirectory = mkdtempSync(path.join(tmpdir(), 'ai-usage-fake-gh-'));
  temporaryRoots.push(binDirectory);
  const ghPath = path.join(binDirectory, 'gh');
  copyFileSync(fixturePath, ghPath);
  chmodSync(ghPath, 0o700);
  writeFileSync(
    path.join(binDirectory, 'scenario.json'),
    JSON.stringify({
      authToken: { stdout: `${TOKEN_SENTINEL}\n` },
      ...scenario,
      api: { graphql: { stdout: reviewThreadsBody([]) }, ...scenario.api },
    }),
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
  test('matches only owner and repository path segments case-insensitively', () => {
    for (const repository of ['Fixture/project', 'fixture/Project', 'FIXTURE/PROJECT']) {
      expect(parsePullRequestView(view({ url: `https://github.com/${repository}/pull/66` }), link(66))).toMatchObject({
        state: 'OPEN',
      });
    }
    for (const url of [
      'http://github.com/Fixture/Project/pull/66',
      'https://elsewhere.test/Fixture/Project/pull/66',
      'https://github.com/other/Project/pull/66',
      'https://github.com/Fixture/other/pull/66',
      'https://github.com/Fixture/Project/PULL/66',
      'https://github.com/Fixture/Project/pull/67',
      'https://github.com/Fixture/Project/pull/066',
      'https://github.com/Fixture/Project/pull/66/',
    ]) {
      expect(parsePullRequestView(view({ url }), link(66))).toBeNull();
    }
  });

  test('ignores unknown keys and rejects missing or mistyped expected ones', () => {
    expect(parsePullRequestView(view({ extra: 'ignored', reviewDecision: '' }), link(66))).toMatchObject({
      checksRollup: 'success',
      reviewDecision: null,
      state: 'OPEN',
      title: 'Add the Work view',
    });
    expect(parsePullRequestView(view({ isCrossRepository: true }), link(66))?.crossRepository).toBe(true);
    expect(parsePullRequestView(view({}), link(66))?.crossRepository).toBeNull();
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
  test('observes discovered and stored repository spellings once with the first spelling and role', async () => {
    const fake = installFakeGh({
      api: { graphql: { stdout: reviewThreadsBody([{ isResolved: false }]) } },
      pullRequests: { 'Owner/Repo#1': { stdout: view({ url: 'https://github.com/Owner/Repo/pull/1' }) } },
    });
    const batch = await observe(fake, {
      links: [
        { ...link(1, 'Owner/Repo', 'GitHub.com'), discoveryRole: 'author' },
        link(1, 'owner/repo'),
        { ...link(1, 'OWNER/REPO'), discoveryRole: 'review-requested' },
      ],
    });
    expect(batch.observations).toEqual([
      expect.objectContaining({
        discoveryRole: 'author',
        host: 'github.com',
        number: 1,
        outcome: 'observed',
        repository: 'Owner/Repo',
        unresolvedReviewThreads: 1,
      }),
    ]);
    expect(batch.truncated).toBe(false);
    const calls = fake.calls();
    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['pr', 'view'],
      ['api', 'graphql'],
    ]);
    expect(calls[1]?.args.slice(0, 5)).toEqual(['pr', 'view', '1', '--repo', 'Owner/Repo']);
    expect(calls[2]?.args.slice(4)).toEqual(['-f', 'owner=Owner', '-f', 'name=Repo', '-F', 'number=1']);
  });

  test.each([undefined, null] as const)(
    'merges a later role into a %s role without changing the first spelling',
    async (discoveryRole) => {
      const fake = installFakeGh({
        pullRequests: { 'owner/repo#1': { stdout: view({ url: 'https://github.com/Owner/Repo/pull/1' }) } },
      });
      const batch = await observe(fake, {
        links: [
          { ...link(1, 'owner/repo'), ...(discoveryRole === undefined ? {} : { discoveryRole }) },
          { ...link(1, 'Owner/Repo'), discoveryRole: 'review-requested' },
          { ...link(1, 'OWNER/REPO'), discoveryRole: 'author' },
        ],
        maxLinks: 1,
      });
      expect(batch.truncated).toBe(false);
      expect(batch.observations).toEqual([
        expect.objectContaining({ discoveryRole: 'review-requested', outcome: 'observed', repository: 'owner/repo' }),
      ]);
      expect(fake.calls().map(({ args }) => args.slice(0, 2))).toEqual([
        ['auth', 'token'],
        ['pr', 'view'],
        ['api', 'graphql'],
      ]);
    },
  );

  test('bounds distinct identities after merging case variants and still rejects mismatched URLs', async () => {
    const fake = installFakeGh({
      pullRequests: {
        'Owner/Repo#1': { stdout: view({ url: 'https://github.com/owner/repo/pull/1' }) },
        'Owner/Repo#2': { stdout: view({ url: 'https://github.com/owner/other/pull/2' }) },
        'Owner/Repo#3': { stdout: view({ url: 'https://github.com/owner/repo/pull/4' }) },
      },
    });
    const batch = await observe(fake, {
      links: [
        link(1, 'Owner/Repo'),
        link(1, 'owner/repo'),
        link(2, 'Owner/Repo'),
        link(3, 'Owner/Repo'),
        link(4, 'Owner/Repo'),
      ],
      maxLinks: 3,
    });
    expect(batch.observations.map(({ number, outcome }) => [number, outcome])).toEqual([
      [1, 'observed'],
      [2, 'invalid'],
      [3, 'invalid'],
    ]);
    expect(batch.truncated).toBe(true);
    expect(
      fake
        .calls()
        .filter(({ args }) => args[0] === 'pr')
        .map(({ args }) => args[2]),
    ).toEqual(['1', '2', '3']);
    expect(fake.calls().filter(({ args }) => args[0] === 'api')).toHaveLength(1);
  });

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
      createdAt: null,
      closedAt: null,
      discoveryRole: null,
      draft: false,
      headRef: 'feat/work-view',
      history: { complete: true, items: [] },
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
      unresolvedReviewThreads: 0,
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
    expect(calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => args.slice(0, 5))).toEqual([
      ['pr', 'view', '66', '--repo', 'fixture/project'],
      ['pr', 'view', '67', '--repo', 'fixture/project'],
      ['pr', 'view', '68', '--repo', 'fixture/project'],
    ]);
    expect(calls[1]?.args.slice(5)).toEqual([
      '--json',
      'state,isDraft,reviewDecision,createdAt,closedAt,mergedAt,mergeable,mergeStateStatus,updatedAt,title,url,headRefName,baseRefName,isCrossRepository,statusCheckRollup',
    ]);
    expect(calls[0]?.token).toBeNull();
    // One view and one GraphQL detail read per pull request, whatever its state.
    expect(calls.slice(1).map(({ token }) => token)).toEqual(Array.from({ length: 6 }, () => TOKEN_SENTINEL));
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

    const apiCalls = fake.calls().filter(({ args }) => args[0] === 'api' && args[1] !== 'graphql');
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
      ['api', 'graphql'],
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
      ['api', 'graphql'],
      ['pr', 'view'],
      ['api', 'graphql'],
    ]);
    expect(fake.calls()[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(fake.calls()[0]?.token).toBeNull();
    expect(
      fake
        .calls()
        .slice(1)
        .map(({ token }) => token),
    ).toEqual(Array.from({ length: 4 }, () => TOKEN_SENTINEL));
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

test.each([{ stdout: '' }, { stdout: '  \n\t' }, { exitCode: 1, stdout: '' }])(
  'halts the active-account batch when no usable token is returned: %j',
  async (authToken) => {
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
  },
);

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

describe('pull request dates and unresolved review threads', () => {
  test('normalizes optional lifecycle dates with the same lenient instant contract as mergedAt', () => {
    expect(parsePullRequestView(view(), link(66))).toMatchObject({ createdAt: null, closedAt: null });
    expect(
      parsePullRequestView(
        view({ createdAt: '2026-10-19T11:00:00.123456+02:00', closedAt: '2026-10-20T06:00:00-04:00' }),
        link(66),
      ),
    ).toMatchObject({ createdAt: '2026-10-19T09:00:00.123Z', closedAt: '2026-10-20T10:00:00.000Z' });
    expect(parsePullRequestView(view({ createdAt: 0, closedAt: '2026-02-30T00:00:00Z' }), link(66))).toMatchObject({
      createdAt: '1970-01-01T00:00:00.000Z',
      closedAt: '2026-03-02T00:00:00.000Z',
    });
  });

  test('observes offset lifecycle dates without a warning', async () => {
    const fake = installFakeGh({
      pullRequests: {
        'fixture/project#66': {
          stdout: view({ createdAt: '2026-10-19T11:00:00+02:00', closedAt: '2026-10-20T06:00:00.456-04:00' }),
        },
      },
    });
    const observation = (await observe(fake)).observations[0];
    expect(observation).toMatchObject({
      createdAt: '2026-10-19T09:00:00.000Z',
      closedAt: '2026-10-20T10:00:00.456Z',
      outcome: 'observed',
      outcomeMessage: null,
      unresolvedReviewThreads: 0,
    });
    expect(parsePullRequestObservation(observation)).toEqual(observation ?? null);
  });

  test.each(['createdAt', 'closedAt'] as const)('keeps a malformed %s visible without hiding the PR', async (field) => {
    const fake = installFakeGh({
      pullRequests: { 'fixture/project#66': { stdout: view({ [field]: 'PRIVATE_INVALID_DATE' }) } },
    });
    const batch = await observe(fake);
    expect(batch.observations[0]).toMatchObject({
      [field]: null,
      outcome: 'observed',
      outcomeMessage: `Invalid lifecycle dates: ${field}`,
      title: 'Add the Work view',
      checksRollup: 'success',
      unresolvedReviewThreads: 0,
    });
    expect(JSON.stringify(batch)).not.toContain('PRIVATE_INVALID_DATE');
    expect(parsePullRequestObservation(batch.observations[0])).toEqual(batch.observations[0] ?? null);
    expect(fake.calls().map(({ args }) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['pr', 'view'],
      ['api', 'graphql'],
    ]);
  });

  test('appends both malformed lifecycle dates to the review-thread note and continues', async () => {
    const fake = installFakeGh({
      api: { graphql: { stdout: reviewThreadsBody([{ isResolved: false }], 2) } },
      pullRequests: {
        'fixture/project#66': { stdout: view({ createdAt: {}, closedAt: { toString: null } }) },
        'fixture/project#67': { stdout: view({ state: 'CLOSED', url: 'https://github.com/fixture/project/pull/67' }) },
      },
    });
    const batch = await observe(fake, { links: [link(66), link(67)] });
    expect(batch.observations[0]).toMatchObject({
      createdAt: null,
      closedAt: null,
      outcome: 'observed',
      outcomeMessage:
        'Review threads unavailable: incomplete review thread connection; Invalid lifecycle dates: createdAt, closedAt',
      unresolvedReviewThreads: null,
    });
    // The closed pull request reads its history; its review threads are not counted.
    expect(batch.observations[1]).toMatchObject({ outcome: 'observed', outcomeMessage: null });
    expect(fake.calls().filter(({ args }) => args[1] === 'graphql')).toHaveLength(2);
  });

  test.each([{}, { createdAt: null, closedAt: null }, { createdAt: '', closedAt: '' }])(
    'keeps absent optional lifecycle dates quiet: %j',
    async (dates) => {
      const fake = installFakeGh({ pullRequests: { 'fixture/project#66': { stdout: view(dates) } } });
      expect((await observe(fake)).observations[0]).toMatchObject({
        createdAt: null,
        closedAt: null,
        outcome: 'observed',
        outcomeMessage: null,
      });
    },
  );

  test('counts only unresolved threads in one complete bounded connection with the batch token', async () => {
    const fake = installFakeGh({
      api: {
        graphql: { stdout: reviewThreadsBody([{ isResolved: false }, { isResolved: true }, { isResolved: false }]) },
      },
      pullRequests: { 'fixture/project#66': { stdout: view({ createdAt: '2026-10-19T09:00:00Z' }) } },
    });
    const batch = await observe(fake);
    expect(batch.observations[0]).toMatchObject({
      outcome: 'observed',
      outcomeMessage: null,
      unresolvedReviewThreads: 2,
      createdAt: '2026-10-19T09:00:00.000Z',
      closedAt: null,
    });
    const graphCalls = fake.calls().filter(({ args }) => args[1] === 'graphql');
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]?.args).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringContaining('query=query($owner: String!, $name: String!, $number: Int!)'),
      '-f',
      'owner=fixture',
      '-f',
      'name=project',
      '-F',
      'number=66',
    ]);
    expect(graphCalls[0]?.args[3]).toContain('reviewThreads(first: 100) { totalCount nodes { isResolved } }');
    expect(graphCalls[0]?.token).toBe(TOKEN_SENTINEL);
    expect(JSON.stringify(graphCalls.map(({ args }) => args))).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(batch)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(batch)).not.toContain(STDERR_SENTINEL);
  });

  test.each([{ nodes: [] }, { nodes: [{ isResolved: true }] }])(
    'records a complete zero count for %j',
    async ({ nodes }) => {
      const fake = installFakeGh({
        api: { graphql: { stdout: reviewThreadsBody(nodes) } },
        pullRequests: { 'fixture/project#66': { stdout: view() } },
      });
      expect((await observe(fake)).observations[0]).toMatchObject({
        outcome: 'observed',
        unresolvedReviewThreads: 0,
        outcomeMessage: null,
      });
    },
  );

  test.each([
    {
      name: 'more than 100 threads',
      stdout: reviewThreadsBody(
        Array.from({ length: 100 }, () => ({ isResolved: false })),
        150,
      ),
    },
    { name: 'incomplete nodes', stdout: reviewThreadsBody([{ isResolved: false }], 2) },
    { name: 'extra nodes', stdout: reviewThreadsBody([{ isResolved: false }], 0) },
    { name: 'nonboolean node', stdout: reviewThreadsBody([{ isResolved: 'false' }]) },
    { name: 'null node', stdout: reviewThreadsBody([null]) },
    { name: 'negative count', stdout: reviewThreadsBody([], -1) },
    { name: 'fractional count', stdout: reviewThreadsBody([], 1.5) },
    { name: 'unsafe count', stdout: reviewThreadsBody([], Number.MAX_SAFE_INTEGER + 1) },
    { name: 'missing data', stdout: '{}' },
    { name: 'malformed JSON', stdout: 'not-json' },
    { name: 'null repository', stdout: '{"data":{"repository":null}}' },
    {
      name: 'partial GraphQL errors',
      stdout: JSON.stringify({
        ...JSON.parse(reviewThreadsBody([{ isResolved: false }])),
        errors: [{ message: 'PRIVATE_GRAPHQL_DIAGNOSTIC' }],
      }),
    },
    { name: 'mistyped GraphQL errors', stdout: JSON.stringify({ ...JSON.parse(reviewThreadsBody([])), errors: {} }) },
  ])('keeps $name visible as unknown without discarding the successful PR view', async ({ stdout }) => {
    const fake = installFakeGh({
      api: { graphql: { stdout } },
      pullRequests: { 'fixture/project#66': { stdout: view() } },
    });
    const batch = await observe(fake);
    expect(batch.observations[0]).toMatchObject({
      outcome: 'observed',
      unresolvedReviewThreads: null,
      outcomeMessage: expect.stringContaining('Review threads unavailable:'),
    });
    expect(JSON.stringify(batch)).not.toContain('PRIVATE_GRAPHQL_DIAGNOSTIC');
    expect(fake.calls().filter(({ args }) => args[1] === 'graphql')).toHaveLength(1);
  });

  test.each([{ exitCode: 1, stdout: 'PRIVATE_GRAPHQL_DIAGNOSTIC' }, { exitCode: 4 }, { delayMs: 1000 }])(
    'failed review-thread read does not halt the next PR: %j',
    async (response) => {
      const fake = installFakeGh({
        api: { graphql: response },
        pullRequests: {
          'fixture/project#66': { stdout: view() },
          'fixture/project#67': {
            stdout: view({ state: 'CLOSED', url: 'https://github.com/fixture/project/pull/67' }),
          },
        },
      });
      const batch = await observe(fake, { links: [link(66), link(67)], timeoutMs: 200 });
      expect(batch.observations.map(({ outcome }) => outcome)).toEqual(['observed', 'observed']);
      expect(batch.observations[0]).toMatchObject({
        unresolvedReviewThreads: null,
        outcomeMessage: expect.stringContaining('Review threads unavailable:'),
      });
      expect(batch.observations[0]).not.toHaveProperty('history');
      expect(batch.observations[1]).toMatchObject({
        unresolvedReviewThreads: null,
        outcomeMessage: expect.stringMatching(STATUS_HISTORY_ONLY_PATTERN),
      });
      expect(fake.calls().map(({ args }) => args.slice(0, 2))).toEqual([
        ['auth', 'token'],
        ['pr', 'view'],
        ['api', 'graphql'],
        ['pr', 'view'],
        ['api', 'graphql'],
      ]);
      expect(JSON.stringify(batch)).not.toContain('PRIVATE_GRAPHQL_DIAGNOSTIC');
    },
  );

  test.each(['CLOSED', 'MERGED'])(
    'keeps dates and reads the history without counting threads for %s',
    async (state) => {
      const closedAt = '2026-10-20T10:00:00Z';
      const fake = installFakeGh({
        pullRequests: {
          'fixture/project#66': {
            stdout: view({
              state,
              createdAt: '2026-10-19T09:00:00Z',
              closedAt,
              mergedAt: state === 'MERGED' ? closedAt : null,
            }),
          },
        },
      });
      expect((await observe(fake)).observations[0]).toMatchObject({
        state,
        createdAt: '2026-10-19T09:00:00.000Z',
        closedAt: '2026-10-20T10:00:00.000Z',
        mergedAt: state === 'MERGED' ? '2026-10-20T10:00:00.000Z' : null,
        history: { complete: true, items: [] },
        unresolvedReviewThreads: null,
        outcomeMessage: null,
      });
      expect(fake.calls().map(({ args }) => args.slice(0, 2))).toEqual([
        ['auth', 'token'],
        ['pr', 'view'],
        ['api', 'graphql'],
      ]);
    },
  );
});

test.each(['throw', 'effect defect'] as const)(
  'contains a review-thread runner %s without losing the observation or later reads',
  async (failureKind) => {
    const fake = installFakeGh({
      api: { graphql: { stdout: reviewThreadsBody([{ isResolved: false }]) } },
      pullRequests: {
        'fixture/project#66': { stdout: view() },
        'fixture/project#67': { stdout: view({ url: 'https://github.com/fixture/project/pull/67' }) },
      },
    });
    const calls: (readonly string[])[] = [];
    const run: BoundedProcessRunner = (options) => {
      calls.push(options.args);
      if (options.args[1] === 'graphql') {
        expect(options.env?.GH_TOKEN).toBe(TOKEN_SENTINEL);
        if (options.args.includes('number=66')) {
          const defect = new Error(`PRIVATE_REVIEW_RUNNER_DEFECT ${TOKEN_SENTINEL}`);
          if (failureKind === 'throw') {
            throw defect;
          }
          return Effect.die(defect);
        }
      }
      return fake.run(options);
    };
    const batch = await observe(fake, { links: [link(66), link(67)], run });
    expect(batch.observations[0]).toMatchObject({
      outcome: 'observed',
      outcomeMessage: 'Review threads unavailable: gh runner failed; Status history unavailable: gh runner failed',
      title: 'Add the Work view',
      unresolvedReviewThreads: null,
    });
    expect(batch.observations[1]).toMatchObject({
      outcome: 'observed',
      outcomeMessage: null,
      unresolvedReviewThreads: 1,
    });
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['pr', 'view'],
      ['api', 'graphql'],
      ['pr', 'view'],
      ['api', 'graphql'],
    ]);
    expect(JSON.stringify(batch)).not.toContain('PRIVATE_REVIEW_RUNNER_DEFECT');
    expect(JSON.stringify(batch)).not.toContain(TOKEN_SENTINEL);
  },
);

test('does not convert review-thread interruption into a successful observation', async () => {
  const fake = installFakeGh({ pullRequests: { 'fixture/project#66': { stdout: view() } } });
  const calls: (readonly string[])[] = [];
  const run: BoundedProcessRunner = (options) => {
    calls.push(options.args);
    return options.args[1] === 'graphql' ? Effect.interrupt : fake.run(options);
  };
  const result = await Effect.runPromiseExit(
    observePullRequests({ links: [link(66), link(67)], machineId: 'machine-a', now: () => NOW, run }),
  );
  expect(Exit.hasInterrupts(result)).toBe(true);
  expect(calls.map((args) => args.slice(0, 2))).toEqual([
    ['auth', 'token'],
    ['pr', 'view'],
    ['api', 'graphql'],
  ]);
});

test('review-thread output obeys the same process ceiling and remains a visible partial observation', async () => {
  const fake = installFakeGh({
    api: { graphql: { stdout: 'x'.repeat(2048) } },
    pullRequests: { 'fixture/project#66': { stdout: view() } },
  });
  const controller = new AbortController();
  let graphReads = 0;
  const boundedRun: BoundedProcessRunner = (options) => {
    if (options.args[1] === 'graphql') {
      graphReads += 1;
      expect(options.command).toBe('gh');
      expect(options.maximumOutputBytes).toBe(1024);
      expect(options.timeoutMs).toBe(1000);
      expect(options.signal).toBe(controller.signal);
      expect(options.env?.GH_TOKEN).toBe(TOKEN_SENTINEL);
    }
    return fake.run(options);
  };
  const batch = await observe(fake, {
    maxOutputBytes: 1024,
    timeoutMs: 1000,
    run: boundedRun,
    signal: controller.signal,
  });
  expect(graphReads).toBe(1);
  expect(batch.observations[0]).toMatchObject({
    outcome: 'observed',
    unresolvedReviewThreads: null,
    outcomeMessage: 'Review threads unavailable: gh output-limit; Status history unavailable: gh output-limit',
  });
});

describe('pull request status history', () => {
  const at = (time: string) => `2026-10-2${time}Z`;
  test('reads reviews and timeline events as dated milestones, oldest first, with their actors', async () => {
    const fake = installFakeGh({
      api: {
        graphql: {
          stdout: reviewThreadsBody([], 0, {
            reviews: {
              totalCount: 2,
              nodes: [
                { state: 'CHANGES_REQUESTED', submittedAt: at('0T10:00:00'), author: { login: 'reviewer' } },
                { state: 'APPROVED', submittedAt: at('1T09:00:00'), author: null },
              ],
            },
            timelineItems: {
              totalCount: 2,
              nodes: [
                { __typename: 'ReadyForReviewEvent', createdAt: at('0T08:00:00'), actor: { login: 'author' } },
                { __typename: 'ConvertToDraftEvent', createdAt: at('0T07:00:00'), actor: { login: 'author' } },
              ],
            },
          }),
        },
      },
      pullRequests: { 'fixture/project#66': { stdout: view({ state: 'MERGED', mergedAt: at('1T10:00:00') }) } },
    });
    const [observation] = (await observe(fake)).observations;
    expect(observation?.history).toEqual({
      complete: true,
      items: [
        { actor: 'author', at: parseCanonicalInstant('2026-10-20T07:00:00.000Z'), kind: 'converted-to-draft' },
        { actor: 'author', at: parseCanonicalInstant('2026-10-20T08:00:00.000Z'), kind: 'ready-for-review' },
        { actor: 'reviewer', at: parseCanonicalInstant('2026-10-20T10:00:00.000Z'), kind: 'changes-requested' },
        { actor: null, at: parseCanonicalInstant('2026-10-21T09:00:00.000Z'), kind: 'approved' },
      ],
    });
    expect(observation?.outcomeMessage).toBeNull();
    expect(parsePullRequestObservation(observation)).toEqual(observation ?? null);
    const [query] = fake.calls().filter(({ args }) => args[1] === 'graphql');
    expect(query?.args[3]).toContain('reviews(last: 50, states: [APPROVED, CHANGES_REQUESTED])');
    expect(query?.args[3]).toContain(
      'timelineItems(last: 30, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, CLOSED_EVENT, REOPENED_EVENT])',
    );
  });

  test('a connection holding more than it returned keeps the newest items as a partial history', async () => {
    const fake = installFakeGh({
      api: {
        graphql: {
          stdout: reviewThreadsBody([], 0, {
            reviews: {
              totalCount: 51,
              nodes: [{ state: 'APPROVED', submittedAt: at('1T09:00:00'), author: { login: 'reviewer' } }],
            },
          }),
        },
      },
      pullRequests: { 'fixture/project#66': { stdout: view() } },
    });
    const [observation] = (await observe(fake)).observations;
    expect(observation?.history).toEqual({
      complete: false,
      items: [{ actor: 'reviewer', at: parseCanonicalInstant('2026-10-21T09:00:00.000Z'), kind: 'approved' }],
    });
  });

  test.each([
    {
      name: 'unknown review state',
      reviews: { totalCount: 1, nodes: [{ state: 'COMMENTED', submittedAt: at('1T09:00:00'), author: null }] },
    },
    {
      name: 'undated review',
      reviews: { totalCount: 1, nodes: [{ state: 'APPROVED', submittedAt: null, author: null }] },
    },
    {
      name: 'mistyped author',
      reviews: { totalCount: 1, nodes: [{ state: 'APPROVED', submittedAt: at('1T09:00:00'), author: 'x' }] },
    },
    {
      name: 'unknown timeline item',
      timelineItems: { totalCount: 1, nodes: [{ __typename: 'LabeledEvent', createdAt: at('1T09:00:00') }] },
    },
    {
      name: 'more nodes than counted',
      timelineItems: {
        totalCount: 0,
        nodes: [{ __typename: 'ClosedEvent', createdAt: at('1T09:00:00'), actor: null }],
      },
    },
    { name: 'mistyped connection', reviews: 'none' },
  ])('a malformed history ($name) is not established, and the thread count still is', async (history) => {
    const fake = installFakeGh({
      api: { graphql: { stdout: reviewThreadsBody([{ isResolved: false }], 1, history) } },
      pullRequests: { 'fixture/project#66': { stdout: view() } },
    });
    const [observation] = (await observe(fake)).observations;
    expect(observation).not.toHaveProperty('history');
    expect(observation).toMatchObject({
      outcome: 'observed',
      unresolvedReviewThreads: 1,
      outcomeMessage: expect.stringMatching(STATUS_HISTORY_ONLY_PATTERN),
    });
  });
});
