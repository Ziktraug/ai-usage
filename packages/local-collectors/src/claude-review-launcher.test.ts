import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REVIEW_ATTEMPT_BOUNDS } from '@ai-usage/report-core/work-attempts';
import { CLAUDE_REVIEW_REQUIRED_FLAGS, parseClaudeHelpFlags } from './claude-review-cli';
import {
  CLAUDE_EXECUTABLE_ENVIRONMENT_KEY,
  ClaudeReviewLaunchError,
  claudeReviewArguments,
  launchClaudeReview,
} from './claude-review-launcher';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const LAUNCH_SESSION_ID = '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const SHA = /^[0-9a-f]{40}$/u;
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
/** What `claude --help` of 2.1.306 names, reduced to the options the launcher relies on. */
const FAKE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --allowedTools, --allowed-tools <tools...>',
  '  --disallowedTools, --disallowed-tools <tools...>',
  '  --effort <level>',
  '  --model <model>',
  '  --output-format <format>',
  '  --permission-mode <mode>   (choices: "acceptEdits", "plan")',
  '  -p, --print',
  '  --safe-mode',
  '  --session-id <uuid>',
  '  --setting-sources <sources>',
  '  --strict-mcp-config',
  '  --tools <tools...>',
  '  --verbose',
].join('\n');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const run = Bun.spawn(['git', ...args], { cwd, env: GIT_ENV, stderr: 'ignore', stdout: 'ignore' });
  if ((await run.exited) !== 0) {
    throw new Error(`git ${args.join(' ')} failed in the fixture`);
  }
};

/** A checkout with two commits, so the review has a first parent and a one-line patch. */
const committedCheckout = async (checkout: string): Promise<void> => {
  await mkdir(checkout, { recursive: true });
  await git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(path.join(checkout, 'a.txt'), 'one\n');
  await git(checkout, 'add', 'a.txt');
  await git(checkout, 'commit', '-q', '-m', 'first');
  await writeFile(path.join(checkout, 'a.txt'), 'one\ntwo\n');
  await git(checkout, 'commit', '-q', '-am', 'second: add a line');
};

interface FakeOptions {
  readonly help?: string;
  readonly version?: string;
}

/**
 * A fake harness: a Bun script that answers `--version` and `--help` like the CLI, and otherwise
 * runs `body`; it records every review invocation's argv in `invocations.jsonl`.
 */
const fakeClaude = async (
  body: string,
  options: FakeOptions = {},
): Promise<{ readonly checkout: string; readonly executable: string; readonly invocations: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-review-launcher-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const checkout = path.join(root, 'checkout');
  const invocations = path.join(root, 'invocations.jsonl');
  await mkdir(bin, { recursive: true });
  await committedCheckout(checkout);
  const executable = path.join(bin, 'claude');
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      'const args = process.argv.slice(2);',
      `if (args[0] === "--version") { process.stdout.write(${JSON.stringify(`${options.version ?? '2.1.306 (Claude Code)'}\n`)}); process.exit(0); }`,
      `if (args[0] === "--help") { process.stdout.write(${JSON.stringify(`${options.help ?? FAKE_HELP}\n`)}); process.exit(0); }`,
      `appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(args) + "\\n");`,
      body,
      '',
    ].join('\n'),
  );
  await chmod(executable, 0o700);
  return { checkout, executable, invocations };
};

const emit = (...lines: string[]): string =>
  lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`).join('\n');

const spec = (checkout: string, overrides: Record<string, unknown> = {}) => ({
  checkoutPath: checkout,
  effort: null,
  launchSessionId: LAUNCH_SESSION_ID,
  model: null,
  sessionTitle: null,
  ...overrides,
});

describe('claude review launcher', () => {
  test('states the exact read-only argument vector, settings and hooks excluded', () => {
    const args = claudeReviewArguments(
      { effort: 'high', launchSessionId: LAUNCH_SESSION_ID, maxTurns: 6, model: 'opus' },
      'PROMPT',
    );
    expect(args).toEqual([
      '-p',
      'PROMPT',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      LAUNCH_SESSION_ID,
      '--setting-sources',
      '',
      '--safe-mode',
      '--tools',
      'Read',
      'Grep',
      'Glob',
      '--strict-mcp-config',
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
      'Agent',
      'Task',
      'TodoWrite',
      'Skill',
      '--max-turns',
      '6',
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
    const plain = claudeReviewArguments({ effort: null, launchSessionId: LAUNCH_SESSION_ID, model: null }, 'P');
    expect(plain).toEqual(
      expect.not.arrayContaining(['--model', '--effort', '--dangerously-skip-permissions', '--mcp-config', '--bare']),
    );
    expect(plain).toContain('8');
    // Every flag the vector relies on is one the qualification demands from `--help`.
    for (const flag of plain.filter((arg) => arg.startsWith('--') && arg !== '--max-turns')) {
      expect(CLAUDE_REVIEW_REQUIRED_FLAGS as readonly string[]).toContain(flag);
    }
  });

  test('runs the fake harness in the checkout with an allow-listed environment, the commit patch and its scope', async () => {
    const { checkout, executable } = await fakeClaude(
      [
        'if (process.env.LEAKED_SECRET !== undefined) { process.exit(9); }',
        'if (!process.cwd().endsWith("/checkout")) { process.exit(8); }',
        'if (!(args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "plan")) { process.exit(7); }',
        emit(INIT_LINE),
        'await new Promise((resolve) => setTimeout(resolve, 80));',
        emit(
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
          RESULT_LINE,
        ),
      ].join('\n'),
    );
    const inits: string[] = [];
    let heartbeats = 0;
    const launch = await launchClaudeReview(
      spec(checkout, { heartbeatMs: 20, model: 'opus', sessionTitle: 'Fixture title' }),
      {
        onHeartbeat: () => {
          heartbeats += 1;
        },
        onInit: (id) => {
          inits.push(id);
        },
      },
      {
        env: { HOME: process.env.HOME, LEAKED_SECRET: 'x', PATH: process.env.PATH },
        executable,
        managedSettingsPaths: [path.join(checkout, 'no-managed-settings.json')],
      },
    );
    expect(launch.pid).toBeGreaterThan(0);
    expect(launch.args[1]).toBe(launch.prompt);
    expect(launch.args.slice(5, 7)).toEqual(['--session-id', LAUNCH_SESSION_ID]);
    expect(launch.prompt).toContain('Target session: Fixture title');
    expect(launch.scope).toMatchObject({ base: 'first-parent', kind: 'commit', subject: 'second: add a line' });
    expect(launch.scope.headSha).toMatch(SHA);
    expect(launch.prompt).toContain(`one commit, ${launch.scope.headSha}`);
    expect(launch.prompt).toContain(' one\n+two\n>>>end of patch');
    expect(launch.guarantee).toEqual({
      cliVersion: '2.1.306',
      effort: null,
      model: 'opus',
      managedSettings: 'absent',
      safeMode: true,
      settingSources: [],
      tools: ['Read', 'Grep', 'Glob'],
    });
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
      await launchClaudeReview(spec(errorResult.checkout), {}, { executable: errorResult.executable })
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
    const exited = await (await launchClaudeReview(spec(silent.checkout), {}, { executable: silent.executable }))
      .outcome;
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
      await launchClaudeReview(spec(sleeper.checkout, { timeoutMs: 200 }), {}, { executable: sleeper.executable })
    ).outcome;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(timedOut).toMatchObject({ kind: 'failed', nativeSessionId: 'native-fixture-1', resultKind: 'timeout' });
    expect(timedOut.failureReason).toContain('timed out');

    const flood = await fakeClaude(
      'const line = JSON.stringify({ type: "assistant", message: "x".repeat(1024) }) + "\\n";\nfor (let i = 0; i < 4096; i++) { process.stdout.write(line); }\nsetTimeout(() => process.exit(0), 30_000);',
    );
    const overflowed = await (
      await launchClaudeReview(
        spec(flood.checkout, { maxOutputBytes: 64 * 1024 }),
        {},
        { executable: flood.executable },
      )
    ).outcome;
    expect(overflowed).toMatchObject({ kind: 'failed', resultKind: 'error' });
    expect(overflowed.failureReason).toContain('exceeded');
  });

  test('terminates on request, keeps what the harness said, and bounds the excerpt', async () => {
    const sleeper = await fakeClaude(`${emit(INIT_LINE)}\nsetTimeout(() => process.exit(0), 60_000);`);
    const launch = await launchClaudeReview(spec(sleeper.checkout), {}, { executable: sleeper.executable });
    await new Promise((resolve) => setTimeout(resolve, 150));
    launch.terminate();
    expect(await launch.outcome).toMatchObject({
      failureReason: 'terminated by the engine',
      kind: 'failed',
      nativeSessionId: 'native-fixture-1',
    });

    const verbose = await fakeClaude(
      emit(
        INIT_LINE,
        JSON.stringify({ is_error: false, result: 'y'.repeat(9000), subtype: 'success', type: 'result' }),
      ),
    );
    const bounded = await (await launchClaudeReview(spec(verbose.checkout), {}, { executable: verbose.executable }))
      .outcome;
    expect(bounded.kind).toBe('finished');
    expect(bounded.resultExcerpt?.length).toBeLessThanOrEqual(REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
  });

  test('refuses to launch without an executable and honours the executable environment override', async () => {
    const { checkout, executable } = await fakeClaude(emit(INIT_LINE, RESULT_LINE));
    await expect(
      launchClaudeReview(spec(checkout), {}, { env: { PATH: '/nonexistent-bin' }, executable: 'claude-not-installed' }),
    ).rejects.toBeInstanceOf(ClaudeReviewLaunchError);
    const launch = await launchClaudeReview(
      spec(checkout),
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
        spec(checkout),
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

  test('refuses a CLI whose --help lacks a control the guarantee rests on, before any review runs', async () => {
    const withoutSources = await fakeClaude(emit(INIT_LINE, RESULT_LINE), {
      help: FAKE_HELP.replace('  --setting-sources <sources>\n', ''),
    });
    const refused = await launchClaudeReview(
      spec(withoutSources.checkout),
      {},
      {
        executable: withoutSources.executable,
      },
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'cli-unqualified' });
    expect((refused as Error).message).toContain('--setting-sources');
    expect(await Bun.file(withoutSources.invocations).exists()).toBe(false);

    const unversioned = await fakeClaude(emit(INIT_LINE, RESULT_LINE), { version: 'Claude Code (dev build)' });
    await expect(
      launchClaudeReview(spec(unversioned.checkout), {}, { executable: unversioned.executable }),
    ).rejects.toMatchObject({ kind: 'cli-unqualified' });
    // A declared model needs `--model` from the CLI too.
    const withoutModel = await fakeClaude(emit(INIT_LINE, RESULT_LINE), {
      help: FAKE_HELP.replace('  --model <model>\n', ''),
    });
    await expect(
      launchClaudeReview(spec(withoutModel.checkout, { model: 'opus' }), {}, { executable: withoutModel.executable }),
    ).rejects.toMatchObject({ kind: 'cli-unqualified' });
    expect(parseClaudeHelpFlags('  --allowedTools, --allowed-tools <tools...>  use --tools')).toEqual(
      new Set(['--allowedTools', '--allowed-tools', '--tools']),
    );
  });

  test('refuses a checkout without a commit to review, before any review runs', async () => {
    const { checkout, executable, invocations } = await fakeClaude(emit(INIT_LINE, RESULT_LINE));
    const empty = path.join(path.dirname(checkout), 'not-a-repository');
    await mkdir(empty);
    await expect(launchClaudeReview(spec(empty), {}, { executable })).rejects.toMatchObject({
      kind: 'scope-unavailable',
    });
    expect(await Bun.file(invocations).exists()).toBe(false);
  });

  test('declares managed settings when a policy file exists, since no flag can exclude them', async () => {
    const { checkout, executable } = await fakeClaude(emit(INIT_LINE, RESULT_LINE));
    const policy = path.join(path.dirname(checkout), 'managed-settings.json');
    await writeFile(policy, '{}\n');
    const launch = await launchClaudeReview(spec(checkout), {}, { executable, managedSettingsPaths: [policy] });
    expect(launch.guarantee.managedSettings).toBe('present');
    await launch.outcome;
  });

  test('a checkout hook (PreToolUse, SessionStart, UserPromptSubmit) never runs: no settings source, safe mode', async () => {
    // The fake loads settings the way the CLI documents it: project and local settings unless
    // `--setting-sources` excludes them, and no hook at all under `--safe-mode`. It runs every
    // declared hook command, so the marker proves whether a hook would have fired.
    const { checkout, executable } = await fakeClaude(
      [
        'const { existsSync, readFileSync } = await import("node:fs");',
        'const sourcesIndex = args.indexOf("--setting-sources");',
        'const sources = sourcesIndex < 0 ? ["user", "project", "local"] : args[sourcesIndex + 1].split(",").filter(Boolean);',
        'const files = [["project", ".claude/settings.json"], ["local", ".claude/settings.local.json"]];',
        'for (const [source, file] of files) {',
        '  if (!sources.includes(source) || args.includes("--safe-mode") || !existsSync(file)) continue;',
        '  const hooks = JSON.parse(readFileSync(file, "utf8")).hooks ?? {};',
        '  for (const entries of Object.values(hooks)) for (const entry of entries) for (const hook of entry.hooks) {',
        '    Bun.spawnSync(["sh", "-c", hook.command]);',
        '  }',
        '}',
        emit(INIT_LINE, RESULT_LINE),
      ].join('\n'),
    );
    const marker = path.join(path.dirname(checkout), 'hook-ran');
    const hook = { hooks: [{ command: `touch ${JSON.stringify(marker)}`, type: 'command' }], matcher: '*' };
    await mkdir(path.join(checkout, '.claude'), { recursive: true });
    await writeFile(
      path.join(checkout, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [hook], SessionStart: [hook] } }),
    );
    await writeFile(
      path.join(checkout, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [hook] } }),
    );
    await git(checkout, 'add', '.claude');
    await git(checkout, 'commit', '-q', '-m', 'hooks');
    const launch = await launchClaudeReview(spec(checkout), {}, { executable });
    expect((await launch.outcome).kind).toBe('finished');
    expect(await Bun.file(marker).exists()).toBe(false);
    // Control: the same fake without the exclusions runs the checkout's hook.
    const control = Bun.spawn([executable, '-p', 'x'], { cwd: checkout, stderr: 'ignore', stdout: 'ignore' });
    expect(await control.exited).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  });
});
