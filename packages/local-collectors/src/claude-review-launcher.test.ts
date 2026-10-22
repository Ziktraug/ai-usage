import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REVIEW_ATTEMPT_BOUNDS } from '@ai-usage/report-core/work-attempts';
import {
  CLAUDE_EXECUTABLE_ENVIRONMENT_KEY,
  ClaudeReviewLaunchError,
  claudeReviewArguments,
  launchClaudeReview,
  readCheckoutSummary,
} from './claude-review-launcher';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const GIT_LOG_LINE = /^[0-9a-f]{7,} second: add a line$/u;
const INIT_LINE = JSON.stringify({ session_id: 'native-fixture-1', subtype: 'init', type: 'system' });
const RESULT_LINE = JSON.stringify({
  duration_ms: 1234,
  is_error: false,
  num_turns: 3,
  result: 'Finding 1: src/a.ts:12 (medium) a null path reaches the launcher.',
  session_id: 'native-fixture-1',
  subtype: 'success',
  type: 'result',
});

/** A fake harness: a Bun script that prints the given lines and exits with the given code. */
const fakeClaude = async (body: string): Promise<{ readonly checkout: string; readonly executable: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-review-launcher-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const checkout = path.join(root, 'checkout');
  await mkdir(bin, { recursive: true });
  await mkdir(checkout, { recursive: true });
  const executable = path.join(bin, 'claude');
  await writeFile(executable, `#!${process.execPath}\n${body}\n`);
  await chmod(executable, 0o700);
  return { checkout, executable };
};

const emit = (...lines: string[]): string =>
  lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`).join('\n');

describe('claude review launcher', () => {
  test('states the exact read-only argument vector', () => {
    const args = claudeReviewArguments({ effort: 'high', maxTurns: 6, model: 'opus' }, 'PROMPT');
    expect(args).toEqual([
      '-p',
      'PROMPT',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--disallowedTools',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'WebFetch',
      'WebSearch',
      '--max-turns',
      '6',
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
    expect(claudeReviewArguments({ effort: null, model: null }, 'P')).toEqual(
      expect.not.arrayContaining(['--model', '--effort', '--dangerously-skip-permissions']),
    );
    expect(claudeReviewArguments({ effort: null, model: null }, 'P')).toContain('8');
  });

  test('runs the fake harness in the checkout with an allow-listed environment and reads init and result', async () => {
    const { checkout, executable } = await fakeClaude(
      [
        'const args = process.argv.slice(2);',
        'if (process.env.LEAKED_SECRET !== undefined) { process.exit(9); }',
        'if (!process.cwd().endsWith("/checkout")) { process.exit(8); }',
        'if (!(args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "plan")) { process.exit(7); }',
        emit(INIT_LINE),
        'await new Promise((resolve) => setTimeout(resolve, 80));',
        emit(
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
          RESULT_LINE,
        ),
        'process.stdout.write(JSON.stringify({ cwd: process.cwd(), prompt: args[1] }) + "\\n");',
      ].join('\n'),
    );
    const inits: string[] = [];
    let heartbeats = 0;
    const launch = await launchClaudeReview(
      { checkoutPath: checkout, effort: null, heartbeatMs: 20, model: 'opus', sessionTitle: 'Fixture title' },
      {
        onHeartbeat: () => {
          heartbeats += 1;
        },
        onInit: (id) => {
          inits.push(id);
        },
      },
      { env: { LEAKED_SECRET: 'x', PATH: process.env.PATH, HOME: process.env.HOME }, executable },
    );
    expect(launch.pid).toBeGreaterThan(0);
    expect(launch.args[1]).toBe(launch.prompt);
    expect(launch.prompt).toContain('Target session: Fixture title');
    expect(launch.prompt).toContain('Latest commit (git log -1): unavailable');
    const outcome = await launch.outcome;
    expect(outcome).toEqual({
      durationMs: 1234,
      exitCode: 0,
      failureReason: null,
      kind: 'finished',
      nativeSessionId: 'native-fixture-1',
      numTurns: 3,
      resultExcerpt: 'Finding 1: src/a.ts:12 (medium) a null path reaches the launcher.',
      resultKind: 'review',
    });
    expect(inits).toEqual(['native-fixture-1']);
    expect(heartbeats).toBeGreaterThanOrEqual(1);
  });

  test('classifies an error result, an exit without result, a timeout and an output overflow', async () => {
    const errorResult = await fakeClaude(
      emit(
        INIT_LINE,
        JSON.stringify({
          is_error: true,
          num_turns: 8,
          result: 'Reached max turns',
          subtype: 'error_max_turns',
          type: 'result',
        }),
      ),
    );
    const errored = await (
      await launchClaudeReview(
        { checkoutPath: errorResult.checkout, effort: null, model: null, sessionTitle: null },
        {},
        { executable: errorResult.executable },
      )
    ).outcome;
    expect(errored).toMatchObject({
      failureReason: 'the harness reported an error result (error_max_turns)',
      kind: 'failed',
      nativeSessionId: 'native-fixture-1',
      numTurns: 8,
      resultExcerpt: 'Reached max turns',
      resultKind: 'error',
    });

    const silent = await fakeClaude(`${emit(INIT_LINE)}\nprocess.exit(1);`);
    const exited = await (
      await launchClaudeReview(
        { checkoutPath: silent.checkout, effort: null, model: null, sessionTitle: null },
        {},
        { executable: silent.executable },
      )
    ).outcome;
    expect(exited).toMatchObject({
      exitCode: 1,
      failureReason: 'exit 1 without a result message',
      kind: 'failed',
      resultExcerpt: null,
      resultKind: 'error',
    });

    const sleeper = await fakeClaude(`${emit(INIT_LINE)}\nsetTimeout(() => process.exit(0), 60_000);`);
    const startedAt = Date.now();
    const timedOut = await (
      await launchClaudeReview(
        { checkoutPath: sleeper.checkout, effort: null, model: null, sessionTitle: null, timeoutMs: 200 },
        {},
        { executable: sleeper.executable },
      )
    ).outcome;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(timedOut).toMatchObject({ kind: 'failed', nativeSessionId: 'native-fixture-1', resultKind: 'timeout' });
    expect(timedOut.failureReason).toContain('timed out');

    const flood = await fakeClaude(
      'const line = JSON.stringify({ type: "assistant", message: "x".repeat(1024) }) + "\\n";\nfor (let i = 0; i < 4096; i++) { process.stdout.write(line); }\nsetTimeout(() => process.exit(0), 30_000);',
    );
    const overflowed = await (
      await launchClaudeReview(
        { checkoutPath: flood.checkout, effort: null, maxOutputBytes: 64 * 1024, model: null, sessionTitle: null },
        {},
        { executable: flood.executable },
      )
    ).outcome;
    expect(overflowed).toMatchObject({ kind: 'failed', resultKind: 'error' });
    expect(overflowed.failureReason).toContain('exceeded');
  });

  test('terminates on request and bounds the excerpt', async () => {
    const sleeper = await fakeClaude(`${emit(INIT_LINE)}\nsetTimeout(() => process.exit(0), 60_000);`);
    const launch = await launchClaudeReview(
      { checkoutPath: sleeper.checkout, effort: null, model: null, sessionTitle: null },
      {},
      { executable: sleeper.executable },
    );
    launch.terminate();
    expect(await launch.outcome).toMatchObject({ failureReason: 'terminated by the engine', kind: 'failed' });

    const verbose = await fakeClaude(
      emit(
        INIT_LINE,
        JSON.stringify({ is_error: false, result: 'y'.repeat(9000), subtype: 'success', type: 'result' }),
      ),
    );
    const bounded = await (
      await launchClaudeReview(
        { checkoutPath: verbose.checkout, effort: null, model: null, sessionTitle: null },
        {},
        { executable: verbose.executable },
      )
    ).outcome;
    expect(bounded.kind).toBe('finished');
    expect(bounded.resultExcerpt?.length).toBeLessThanOrEqual(REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
  });

  test('refuses to launch without an executable and honours the executable environment override', async () => {
    const { checkout, executable } = await fakeClaude(emit(INIT_LINE, RESULT_LINE));
    await expect(
      launchClaudeReview(
        { checkoutPath: checkout, effort: null, model: null, sessionTitle: null },
        {},
        { env: { PATH: '/nonexistent-bin' }, executable: 'claude-not-installed' },
      ),
    ).rejects.toBeInstanceOf(ClaudeReviewLaunchError);
    const launch = await launchClaudeReview(
      { checkoutPath: checkout, effort: null, model: null, sessionTitle: null },
      {},
      { env: { [CLAUDE_EXECUTABLE_ENVIRONMENT_KEY]: executable, HOME: process.env.HOME, PATH: process.env.PATH } },
    );
    expect((await launch.outcome).kind).toBe('finished');
  });

  test('refuses a relative executable path instead of resolving it against the checkout', async () => {
    const { checkout } = await fakeClaude(emit(INIT_LINE, RESULT_LINE));
    // A `bin/claude` under the checkout would otherwise be what `./bin/claude` runs.
    await mkdir(path.join(checkout, 'bin'), { recursive: true });
    await writeFile(path.join(checkout, 'bin', 'claude'), `#!${process.execPath}\nprocess.exit(3);\n`);
    await chmod(path.join(checkout, 'bin', 'claude'), 0o700);
    for (const relative of ['./bin/claude', 'bin/claude', '../checkout/bin/claude']) {
      const refused = await launchClaudeReview(
        { checkoutPath: checkout, effort: null, model: null, sessionTitle: null },
        {},
        { env: { [CLAUDE_EXECUTABLE_ENVIRONMENT_KEY]: relative, HOME: process.env.HOME, PATH: process.env.PATH } },
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ClaudeReviewLaunchError);
      expect(refused).toMatchObject({
        kind: 'executable-invalid',
        message: `${CLAUDE_EXECUTABLE_ENVIRONMENT_KEY} must be an absolute path or a bare command name; got "${relative}"`,
      });
    }
  });

  test('reads the git summaries of a real checkout and degrades outside one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claude-review-git-'));
    roots.push(root);
    const git = async (...args: string[]) => {
      const run = Bun.spawn(['git', ...args], {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
        },
        stderr: 'ignore',
        stdout: 'ignore',
      });
      expect(await run.exited).toBe(0);
    };
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', 'first');
    await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    await git('commit', '-q', '-am', 'second: add a line');
    const summary = await readCheckoutSummary(root);
    expect(summary.gitLog).toMatch(GIT_LOG_LINE);
    expect(summary.gitDiffStat).toContain('a.txt');
    expect(await readCheckoutSummary(path.join(root, 'missing'))).toEqual({ gitDiffStat: null, gitLog: null });
  });
});
