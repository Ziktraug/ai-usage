import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoundedProcessError,
  type BoundedProcessOptions,
  type BoundedProcessRunner,
} from '@ai-usage/local-machine/bounded-process';
import { canonicalInstantFromDate, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { Effect } from 'effect';
import { observeCheckoutStatus, parsePorcelainV2 } from './checkout-status';

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-10-21T20:00:00.000Z');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const temporaryDirectory = (label: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), `ai-usage-checkout-status-${label}-`));
  temporaryRoots.push(root);
  return root;
};

const porcelain = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

describe('parsePorcelainV2', () => {
  test('reads a clean checkout with an upstream', () => {
    expect(
      parsePorcelainV2(
        porcelain([`# branch.oid ${SHA}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0']),
      ),
    ).toEqual({
      ahead: 0,
      behind: 0,
      branch: 'main',
      headSha: SHA,
      modified: 0,
      staged: 0,
      unmerged: 0,
      untracked: 0,
      upstream: 'origin/main',
    });
  });

  test('counts staged, modified, renamed, unmerged and untracked entries', () => {
    expect(
      parsePorcelainV2(
        porcelain([
          `# branch.oid ${SHA}`,
          '# branch.head topic',
          '# branch.upstream origin/topic',
          '# branch.ab +3 -1',
          '# stash 2',
          `1 .M N... 100644 100644 100644 ${SHA} ${SHA} modified.txt`,
          `1 M. N... 100644 100644 100644 ${SHA} ${SHA} staged.txt`,
          `1 MM N... 100644 100644 100644 ${SHA} ${SHA} both.txt`,
          `2 R. N... 100644 100644 100644 ${SHA} ${SHA} R100 renamed.txt\told.txt`,
          `u UU N... 100644 100644 100644 100644 ${SHA} ${SHA} ${SHA} conflict.txt`,
          '? untracked.txt',
          '? "quoted name.txt"',
          '! ignored.log',
        ]),
      ),
    ).toEqual({
      ahead: 3,
      behind: 1,
      branch: 'topic',
      headSha: SHA,
      modified: 2,
      staged: 3,
      unmerged: 1,
      untracked: 2,
      upstream: 'origin/topic',
    });
  });

  test('reads detached, unborn and upstream-less heads', () => {
    expect(parsePorcelainV2(porcelain([`# branch.oid ${SHA}`, '# branch.head (detached)']))).toMatchObject({
      ahead: null,
      behind: null,
      branch: null,
      headSha: SHA,
      upstream: null,
    });
    expect(parsePorcelainV2(porcelain(['# branch.oid (initial)', '# branch.head main', '? README.md']))).toMatchObject({
      branch: 'main',
      headSha: null,
      untracked: 1,
      upstream: null,
    });
    expect(parsePorcelainV2(porcelain([`# branch.oid ${SHA}`, '# branch.head local-only']))).toMatchObject({
      ahead: null,
      behind: null,
      upstream: null,
    });
  });

  test('rejects output outside the documented record types', () => {
    expect(parsePorcelainV2('On branch main\nnothing to commit, working tree clean\n')).toBeNull();
    expect(parsePorcelainV2(porcelain(['# branch.oid not-a-sha', '# branch.head main']))).toBeNull();
    expect(parsePorcelainV2(porcelain(['# branch.head main']))).toBeNull();
    expect(parsePorcelainV2(porcelain([`# branch.oid ${SHA}`, '# branch.head main', '# branch.ab +x -1']))).toBeNull();
    expect(parsePorcelainV2(porcelain([`# branch.oid ${SHA}`, '# branch.head main', '1 M']))).toBeNull();
  });
});

type FakeResponse = { exitCode: number; stdout: string } | BoundedProcessError['kind'];

const fakeRunner =
  (
    respond: (subcommand: string, checkoutPath: string) => FakeResponse,
    calls: BoundedProcessOptions[] = [],
  ): BoundedProcessRunner =>
  (options) => {
    calls.push(options);
    const checkoutIndex = options.args.indexOf('-C');
    const checkoutPath = options.args[checkoutIndex + 1] ?? '';
    const subcommand = options.args[checkoutIndex + 2] ?? '';
    const response = respond(subcommand, checkoutPath);
    if (typeof response === 'string') {
      return Effect.fail(new BoundedProcessError({ kind: response, message: `Bounded process ${response}` }));
    }
    return Effect.succeed({ durationMs: 1, exitCode: response.exitCode, stdout: response.stdout });
  };

const cleanStatus = porcelain([
  `# branch.oid ${SHA}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
]);

describe('observeCheckoutStatus with an injected runner', () => {
  test('records missing paths without spawning anything and rejects unusable candidates', async () => {
    const calls: BoundedProcessOptions[] = [];
    const missing = path.join(temporaryDirectory('missing'), 'gone');
    const batch = await Effect.runPromise(
      observeCheckoutStatus({
        machineId: 'machine-a',
        now: () => NOW,
        paths: [missing, 'relative/path', `${missing}\0`],
        run: fakeRunner(() => ({ exitCode: 0, stdout: cleanStatus }), calls),
      }),
    );
    expect(calls).toHaveLength(0);
    expect(batch.rejected).toBe(2);
    expect(batch.observations).toEqual([
      {
        ahead: null,
        behind: null,
        branch: null,
        checkoutPath: missing,
        dirty: null,
        headSha: null,
        lastCommitAt: null,
        machineId: 'machine-a',
        modifiedCount: null,
        observedAt: canonicalInstantFromDate(NOW),
        outcome: 'missing',
        stagedCount: null,
        untrackedCount: null,
        upstream: null,
      },
    ]);
  });

  test('maps each failure to its own outcome and only ever runs status and log', async () => {
    const root = temporaryDirectory('outcomes');
    const directories = ['not-repo', 'timeout', 'garbage', 'exit-one', 'log-missing', 'log-timeout', 'failed'].map(
      (name) => {
        const directory = path.join(root, name);
        mkdirSync(directory);
        return directory;
      },
    );
    const calls: BoundedProcessOptions[] = [];
    const batch = await Effect.runPromise(
      observeCheckoutStatus({
        machineId: 'machine-a',
        now: () => NOW,
        paths: directories,
        run: fakeRunner((subcommand, checkoutPath) => {
          const name = path.basename(checkoutPath);
          if (subcommand === 'status') {
            switch (name) {
              case 'not-repo':
                return { exitCode: 128, stdout: '' };
              case 'timeout':
                return 'timed-out';
              case 'garbage':
                return { exitCode: 0, stdout: 'On branch main\n' };
              case 'exit-one':
                return { exitCode: 1, stdout: '' };
              case 'failed':
                return 'failed';
              default:
                return { exitCode: 0, stdout: cleanStatus };
            }
          }
          if (name === 'log-missing') {
            return { exitCode: 128, stdout: '' };
          }
          if (name === 'log-timeout') {
            return 'timed-out';
          }
          return { exitCode: 0, stdout: '2026-10-20T10:00:00+02:00\n' };
        }, calls),
      }),
    );
    expect(batch.observations.map(({ checkoutPath, outcome }) => [path.basename(checkoutPath), outcome])).toEqual([
      ['not-repo', 'not-a-repository'],
      ['timeout', 'timeout'],
      ['garbage', 'invalid'],
      ['exit-one', 'invalid'],
      ['log-missing', 'observed'],
      ['log-timeout', 'timeout'],
      ['failed', 'invalid'],
    ]);
    const logMissing = batch.observations.find(({ checkoutPath }) => path.basename(checkoutPath) === 'log-missing');
    expect(logMissing).toMatchObject({ branch: 'main', dirty: false, headSha: SHA, lastCommitAt: null });
    for (const call of calls) {
      expect(call.command).toBe('git');
      expect(call.args.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
      const subcommand = call.args[call.args.indexOf('-C') + 2];
      expect(['status', 'log']).toContain(subcommand ?? '');
      expect(call.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
      expect(call.timeoutMs).toBe(5000);
      expect(call.maximumOutputBytes).toBe(1024 * 1024);
    }
  });

  test('deduplicates resolved paths and reports truncation beyond maxPaths', async () => {
    const root = temporaryDirectory('bounds');
    const directories = ['a', 'b', 'c'].map((name) => {
      const directory = path.join(root, name);
      mkdirSync(directory);
      return directory;
    });
    const calls: BoundedProcessOptions[] = [];
    const batch = await Effect.runPromise(
      observeCheckoutStatus({
        machineId: 'machine-a',
        maxPaths: 2,
        now: () => NOW,
        paths: [directories[0]!, `${directories[0]}/`, directories[1]!, directories[2]!],
        run: fakeRunner((subcommand) =>
          subcommand === 'status'
            ? { exitCode: 0, stdout: cleanStatus }
            : { exitCode: 0, stdout: '2026-10-20T10:00:00Z' },
        ),
      }),
    );
    expect(batch.truncated).toBe(true);
    expect(batch.observations.map(({ checkoutPath }) => checkoutPath)).toEqual(directories.slice(0, 2));
    expect(calls).toHaveLength(0);
  });

  test('records a directory the engine may not traverse as denied', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return;
    }
    const root = temporaryDirectory('denied');
    const locked = path.join(root, 'locked');
    mkdirSync(locked);
    const inside = path.join(locked, 'checkout');
    mkdirSync(inside);
    chmodSync(locked, 0o000);
    try {
      const batch = await Effect.runPromise(
        observeCheckoutStatus({
          machineId: 'machine-a',
          now: () => NOW,
          paths: [inside],
          run: fakeRunner(() => ({ exitCode: 0, stdout: cleanStatus })),
        }),
      );
      expect(batch.observations[0]?.outcome).toBe('denied');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-10-20T10:00:00+00:00',
        GIT_COMMITTER_DATE: '2026-10-20T10:00:00+00:00',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

describe('observeCheckoutStatus against a real repository', () => {
  test('reads a fresh repository, its working tree changes and a linked worktree end to end', async () => {
    const root = temporaryDirectory('real');
    const repository = path.join(root, 'repository');
    const unborn = path.join(root, 'unborn');
    const plain = path.join(root, 'plain');
    const worktree = path.join(root, 'linked-worktree');
    mkdirSync(repository);
    mkdirSync(unborn);
    mkdirSync(plain);
    git(repository, 'init', '-q', '-b', 'main');
    git(unborn, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
    writeFileSync(path.join(repository, 'staged.txt'), 'two\n');
    git(repository, 'add', 'tracked.txt', 'staged.txt');
    git(repository, 'commit', '-q', '-m', 'initial');
    const headSha = git(repository, 'rev-parse', 'HEAD').trim();
    const committedAt = git(repository, 'log', '-1', '--format=%cI').trim();
    git(repository, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    const clean = await Effect.runPromise(
      observeCheckoutStatus({ machineId: 'machine-a', now: () => NOW, paths: [repository, unborn, plain, worktree] }),
    );
    expect(clean.observations.map(({ outcome }) => outcome)).toEqual([
      'observed',
      'observed',
      'not-a-repository',
      'observed',
    ]);
    expect(clean.observations[0]).toEqual({
      ahead: null,
      behind: null,
      branch: 'main',
      checkoutPath: repository,
      dirty: false,
      headSha,
      lastCommitAt: parseCanonicalInstant(new Date(committedAt).toISOString()),
      machineId: 'machine-a',
      modifiedCount: 0,
      observedAt: canonicalInstantFromDate(NOW),
      outcome: 'observed',
      stagedCount: 0,
      untrackedCount: 0,
      upstream: null,
    });
    expect(clean.observations[1]).toMatchObject({ branch: 'main', dirty: false, headSha: null, lastCommitAt: null });
    expect(clean.observations[3]).toMatchObject({ branch: 'feature', dirty: false, headSha });

    writeFileSync(path.join(repository, 'tracked.txt'), 'changed\n');
    writeFileSync(path.join(repository, 'staged.txt'), 'changed\n');
    git(repository, 'add', 'staged.txt');
    writeFileSync(path.join(repository, 'untracked.txt'), 'new\n');
    mkdirSync(path.join(repository, 'untracked-dir'));
    writeFileSync(path.join(repository, 'untracked-dir', 'a.txt'), 'a\n');
    writeFileSync(path.join(repository, 'untracked-dir', 'b.txt'), 'b\n');

    const dirty = await Effect.runPromise(
      observeCheckoutStatus({ machineId: 'machine-a', now: () => NOW, paths: [repository] }),
    );
    expect(dirty.observations[0]).toMatchObject({
      dirty: true,
      modifiedCount: 1,
      outcome: 'observed',
      stagedCount: 1,
      // Git collapses an untracked directory into one entry under --untracked-files=normal.
      untrackedCount: 2,
    });
    // The read left the working tree exactly as it found it.
    expect(git(repository, 'status', '--porcelain')).toContain('?? untracked.txt');
    expect(git(repository, 'status', '--porcelain')).toContain('M  staged.txt');
  });
});
