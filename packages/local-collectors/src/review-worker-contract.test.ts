import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BOUNDED_PROCESS_INHERITED_PREFIXES,
  BOUNDED_PROCESS_INHERITED_VARIABLES,
} from '@ai-usage/local-machine/bounded-process';
import { DELEGATION_BOUNDS, DELEGATION_DEPTH_ENVIRONMENT_KEY } from '@ai-usage/report-core/delegation-vocabulary';
import { CLAUDE_EXECUTABLE_ENVIRONMENT_KEY } from './claude-command';
import { claudeReviewWorkerAdapter } from './claude-review-worker';
import {
  CODEX_EXECUTABLE_ENVIRONMENT_KEY,
  codexFailureReason,
  codexReviewArguments,
  codexReviewWorkerAdapter,
  parseCodexExecLine,
} from './codex-review-worker';
import {
  boundTextBytes,
  DELEGATION_HARNESS_CONTROLS,
  delegationLaunchMarkerToken,
  type ReviewWorkerAdapter,
  ReviewWorkerLaunchError,
  type ReviewWorkerSpec,
} from './review-worker';

/**
 * The adapter contract, run scenario by scenario against both adapters with fake executables: a
 * Bun script that answers the qualification commands like the real CLI, records how it was invoked
 * (argv, environment, cwd, stdin), then plays a scripted body. No prompt ever reaches a model.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MARKER = '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const PROMPT = 'You are a delegated read-only reviewer; do not delegate.\n<<<patch\n+two\n>>>end of patch\n';
const FINAL = '{"summary":"ok","findings":[],"coverage":{"reviewed":"all","notReviewed":[]},"checks":[],"limits":[]}';
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz';
const MODEL_HELP_LINE = /^.*--model.*\n/mu;
const FORBIDDEN_ARGUMENTS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--approve-for-me',
  '--add-dir',
  '--full-auto',
  '--search',
  'workspace-write',
  'danger-full-access',
  'bypassPermissions',
  '--dangerously-skip-permissions',
  '--mcp-config',
];

const CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --allowedTools, --allowed-tools <tools...>',
  '  --disallowedTools, --disallowed-tools <tools...>',
  '  --effort <level>',
  '  --model <model>',
  '  --output-format <format>',
  '  --permission-mode <mode>',
  '  -p, --print',
  '  --safe-mode',
  '  --session-id <uuid>',
  '  --setting-sources <sources>',
  '  --strict-mcp-config',
  '  --tools <tools...>',
  '  --verbose',
].join('\n');
/** What `codex exec --help` of 0.164.0 names, reduced to the options the worker relies on. */
const CODEX_HELP = [
  'Run Codex non-interactively',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  '  -c, --config <key=value>',
  '      --disable <FEATURE>',
  '  -m, --model <MODEL>',
  '  -s, --sandbox <SANDBOX_MODE>',
  '  -C, --cd <DIR>',
  '      --skip-git-repo-check',
  '      --ignore-user-config',
  '      --ignore-rules',
  '      --output-schema <FILE>',
  '      --color <COLOR>',
  '      --json',
  '  -o, --output-last-message <FILE>',
].join('\n');

const CLAUDE_INIT = JSON.stringify({
  model: 'claude-opus-4-1',
  session_id: 'native-claude-1',
  subtype: 'init',
  type: 'system',
});
const CLAUDE_RESULT = JSON.stringify({
  duration_ms: 1234,
  is_error: false,
  num_turns: 3,
  result: FINAL,
  session_id: 'native-claude-1',
  subtype: 'success',
  type: 'result',
  usage: { cache_creation_input_tokens: 5, cache_read_input_tokens: 50, input_tokens: 100, output_tokens: 20 },
});
const CLAUDE_ERROR = JSON.stringify({
  is_error: true,
  num_turns: 8,
  result: 'Reached max turns',
  subtype: 'error_max_turns',
  type: 'result',
});
const CODEX_THREAD = JSON.stringify({ thread_id: 'thread-codex-1', type: 'thread.started' });
const CODEX_TURN_STARTED = JSON.stringify({ type: 'turn.started' });
const CODEX_REASONING = JSON.stringify({
  item: { id: 'item_0', text: 'thinking', type: 'reasoning' },
  type: 'item.completed',
});
const CODEX_MESSAGE = JSON.stringify({
  item: { id: 'item_1', text: FINAL, type: 'agent_message' },
  type: 'item.completed',
});
const CODEX_TURN_COMPLETED = JSON.stringify({
  type: 'turn.completed',
  usage: { cached_input_tokens: 50, input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 7 },
});
const CODEX_ERROR = JSON.stringify({ error: { message: `rate limited\nwith ${SECRET}` }, type: 'turn.failed' });

type Harness = 'claude-code' | 'codex';

interface Invocation {
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string | null;
}

interface Fake {
  readonly checkout: string;
  readonly executable: string;
  readonly invocation: () => Promise<Invocation | null>;
  readonly privateDirectory: string;
}

interface FakeOptions {
  readonly help?: string;
  readonly version?: string;
}

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

const emit = (...lines: string[]): string =>
  lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`).join('\n');

/** The fake harness; `body` runs after the qualification answers and the invocation record. */
const fakeHarness = async (harness: Harness, body: string, options: FakeOptions = {}): Promise<Fake> => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-worker-contract-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const checkout = path.join(root, 'checkout');
  const privateDirectory = path.join(root, 'private');
  const record = path.join(root, 'invocation.json');
  await mkdir(bin, { recursive: true });
  await mkdir(checkout, { recursive: true });
  await mkdir(privateDirectory, { mode: 0o700, recursive: true });
  await git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(path.join(checkout, 'a.txt'), 'one\n');
  await git(checkout, 'add', 'a.txt');
  await git(checkout, 'commit', '-q', '-m', 'first');
  const executable = path.join(bin, harness === 'claude-code' ? 'claude' : 'codex');
  const version = options.version ?? (harness === 'claude-code' ? '2.1.310 (Claude Code)' : 'codex-cli 0.164.0');
  const help = options.help ?? (harness === 'claude-code' ? CLAUDE_HELP : CODEX_HELP);
  const isHelp = harness === 'claude-code' ? 'args[0] === "--help"' : 'args[0] === "exec" && args[1] === "--help"';
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      'const args = process.argv.slice(2);',
      `if (args[0] === "--version") { process.stdout.write(${JSON.stringify(`${version}\n`)}); process.exit(0); }`,
      `if (${isHelp}) { process.stdout.write(${JSON.stringify(`${help}\n`)}); process.exit(0); }`,
      harness === 'codex'
        ? 'const stdin = args.at(-1) === "-" ? await new Response(Bun.stdin.stream()).text() : null;'
        : 'const stdin = null;',
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, stdin }));`,
      'const outputIndex = args.indexOf("-o");',
      'const outputPath = outputIndex < 0 ? null : args[outputIndex + 1];',
      body,
      '',
    ].join('\n'),
  );
  await chmod(executable, 0o700);
  return {
    checkout,
    executable,
    invocation: async () => {
      const file = Bun.file(record);
      return (await file.exists()) ? ((await file.json()) as Invocation) : null;
    },
    privateDirectory,
  };
};

const spec = (fake: Fake, overrides: Partial<ReviewWorkerSpec> = {}): ReviewWorkerSpec => ({
  checkoutPath: fake.checkout,
  effort: null,
  heartbeatMs: 20,
  launchMarker: MARKER,
  maxOutputBytes: 2 * 1024 * 1024,
  maxTurns: 8,
  model: null,
  outputSchema: null,
  privateDirectory: fake.privateDirectory,
  prompt: PROMPT,
  timeoutMs: 10_000,
  ...overrides,
});

/** Per harness: the adapter, the lines a successful run emits, and how each failure looks. */
const HARNESSES: readonly {
  readonly adapter: ReviewWorkerAdapter;
  readonly errorBody: string;
  readonly executableKey: string;
  readonly expectedModel: string | null;
  readonly expectedSession: string;
  readonly helpWithoutFlag: { readonly flag: string; readonly help: string };
  readonly successBody: string;
}[] = [
  {
    adapter: claudeReviewWorkerAdapter,
    errorBody: emit(CLAUDE_INIT, CLAUDE_ERROR),
    executableKey: CLAUDE_EXECUTABLE_ENVIRONMENT_KEY,
    expectedModel: 'claude-opus-4-1',
    expectedSession: 'native-claude-1',
    helpWithoutFlag: { flag: '--setting-sources', help: CLAUDE_HELP.replace('  --setting-sources <sources>\n', '') },
    successBody: [
      emit(CLAUDE_INIT),
      'await new Promise((resolve) => setTimeout(resolve, 80));',
      emit(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
        CLAUDE_RESULT,
      ),
    ].join('\n'),
  },
  {
    adapter: codexReviewWorkerAdapter,
    errorBody: emit(CODEX_THREAD, CODEX_TURN_STARTED, CODEX_ERROR),
    executableKey: CODEX_EXECUTABLE_ENVIRONMENT_KEY,
    expectedModel: null,
    expectedSession: 'thread-codex-1',
    helpWithoutFlag: { flag: '--ignore-rules', help: CODEX_HELP.replace('      --ignore-rules\n', '') },
    successBody: [
      emit(CODEX_THREAD, CODEX_TURN_STARTED),
      'await new Promise((resolve) => setTimeout(resolve, 80));',
      emit(CODEX_REASONING, CODEX_MESSAGE, CODEX_TURN_COMPLETED),
      `if (outputPath) await Bun.write(outputPath, ${JSON.stringify(FINAL)});`,
    ].join('\n'),
  },
];

const allowListed = (name: string): boolean =>
  BOUNDED_PROCESS_INHERITED_VARIABLES.includes(name) ||
  BOUNDED_PROCESS_INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  name === DELEGATION_DEPTH_ENVIRONMENT_KEY ||
  name === 'CLAUDE_CONFIG_DIR' ||
  name === 'CODEX_HOME';

describe.each(HARNESSES)('review worker adapter contract: $adapter.harness', (harness) => {
  const { adapter } = harness;
  const launch = (fake: Fake, overrides: Partial<ReviewWorkerSpec> = {}, events = {}, options = {}) =>
    adapter.launch(spec(fake, overrides), events, { executable: fake.executable, ...options });

  test('a structured final output finishes with the final text, the native session, usage and the guarantee', async () => {
    const fake = await fakeHarness(adapter.harness, harness.successBody);
    const inits: [string, string | null][] = [];
    let heartbeats = 0;
    const run = await launch(
      fake,
      { model: 'declared-model' },
      {
        onHeartbeat: () => {
          heartbeats += 1;
        },
        onInit: (id: string, model: string | null) => {
          inits.push([id, model]);
        },
      },
      { env: { HOME: process.env.HOME, LEAKED_SECRET: 'x', PATH: process.env.PATH } },
    );
    expect(run.pid).toBeGreaterThan(0);
    expect(run.guarantee).toEqual({
      cliVersion: adapter.harness === 'claude-code' ? '2.1.310' : '0.164.0',
      controls: [...DELEGATION_HARNESS_CONTROLS[adapter.harness].controls],
      effort: null,
      harness: adapter.harness,
      limits: [...DELEGATION_HARNESS_CONTROLS[adapter.harness].limits],
      model: 'declared-model',
    });
    const outcome = await run.outcome;
    expect(outcome).toMatchObject({
      exitCode: 0,
      failureReason: null,
      finalText: FINAL,
      kind: 'finished',
      nativeSessionId: harness.expectedSession,
      resolvedModel: harness.expectedModel,
      resultKind: 'review',
      usage: { cachedInputTokens: 50, inputTokens: 100, outputTokens: 20, source: 'harness-reported' },
    });
    expect(outcome.numTurns).toBeGreaterThanOrEqual(1);
    expect(outcome.durationMs).toBeGreaterThan(0);
    expect(inits).toEqual([[harness.expectedSession, harness.expectedModel]]);
    expect(heartbeats).toBeGreaterThanOrEqual(1);
  });

  test('runs in the checkout with the allow-listed environment plus the delegation depth, the marker in argv and no forbidden flag', async () => {
    const fake = await fakeHarness(adapter.harness, harness.successBody);
    const run = await launch(
      fake,
      {},
      {},
      {
        env: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config-fixture',
          CODEX_HOME: '/tmp/codex-home-fixture',
          HOME: process.env.HOME,
          LEAKED_SECRET: 'x',
          PATH: process.env.PATH,
        },
      },
    );
    await run.outcome;
    const invocation = await fake.invocation();
    expect(invocation).not.toBeNull();
    const { args, cwd, env, stdin } = invocation as Invocation;
    expect(cwd).toBe(fake.checkout);
    expect(env[DELEGATION_DEPTH_ENVIRONMENT_KEY]).toBe('1');
    expect(env.LEAKED_SECRET).toBeUndefined();
    expect(Object.keys(env).filter((name) => !allowListed(name))).toEqual([]);
    expect(args).toEqual([...run.args]);
    for (const forbidden of FORBIDDEN_ARGUMENTS) {
      expect(args).not.toContain(forbidden);
    }
    if (adapter.harness === 'claude-code') {
      expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config-fixture');
      expect(env.CODEX_HOME).toBeUndefined();
      expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual([
        '--session-id',
        MARKER,
      ]);
      expect(args[1]).toBe(PROMPT);
      expect(stdin).toBeNull();
    } else {
      expect(env.CODEX_HOME).toBe('/tmp/codex-home-fixture');
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(args.some((argument) => argument.includes(delegationLaunchMarkerToken(MARKER)))).toBe(true);
      expect(args.at(-1)).toBe('-');
      expect(stdin).toBe(PROMPT);
      expect(args).not.toContain(PROMPT);
    }
  });

  test('a harness error event fails the run as an error, keeping what the harness said', async () => {
    const fake = await fakeHarness(adapter.harness, harness.errorBody);
    const outcome = await (await launch(fake)).outcome;
    expect(outcome).toMatchObject({ kind: 'failed', nativeSessionId: harness.expectedSession, resultKind: 'error' });
    expect(outcome.failureReason).not.toBeNull();
    expect(outcome.failureReason).not.toContain(SECRET);
    expect((outcome.failureReason as string).length).toBeLessThanOrEqual(260);
  });

  test('garbled stdout fails without a result', async () => {
    const fake = await fakeHarness(adapter.harness, emit('not json at all', '{"half": ', '[1, 2, 3]'));
    const outcome = await (await launch(fake)).outcome;
    expect(outcome).toMatchObject({
      exitCode: 0,
      finalText: null,
      kind: 'failed',
      nativeSessionId: null,
      resultKind: 'error',
    });
    expect(outcome.failureReason).toContain('without a');
  });

  test('stdout over the cap fails as an overflow and the process is killed', async () => {
    const fake = await fakeHarness(
      adapter.harness,
      'const line = JSON.stringify({ type: "noise", payload: "x".repeat(1024) }) + "\\n";\nfor (let i = 0; i < 4096; i++) { process.stdout.write(line); }\nsetTimeout(() => process.exit(0), 30_000);',
    );
    const startedAt = Date.now();
    const outcome = await (await launch(fake, { maxOutputBytes: 64 * 1024 })).outcome;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ kind: 'failed', resultKind: 'error' });
    expect(outcome.failureReason).toContain('exceeded 65536 bytes');
    expect(outcome.exitCode).not.toBe(0);
  });

  test('the deadline ends the run as a timeout', async () => {
    const fake = await fakeHarness(adapter.harness, 'setTimeout(() => process.exit(0), 60_000);');
    const startedAt = Date.now();
    const outcome = await (await launch(fake, { timeoutMs: 200 })).outcome;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ kind: 'failed', resultKind: 'timeout' });
    expect(outcome.failureReason).toContain('timed out');
  });

  test('terminate("cancel") ends the run as cancelled; the first reason wins', async () => {
    const fake = await fakeHarness(adapter.harness, 'setTimeout(() => process.exit(0), 60_000);');
    const run = await launch(fake);
    await new Promise((resolve) => setTimeout(resolve, 150));
    run.terminate('cancel');
    run.terminate('shutdown');
    expect(await run.outcome).toMatchObject({
      failureReason: 'cancelled by the engine',
      kind: 'failed',
      resultKind: 'cancelled',
    });
  });

  test('a missing executable, a relative one, and a bad marker are typed launch errors; nothing runs', async () => {
    const fake = await fakeHarness(adapter.harness, harness.successBody);
    const missing = await adapter
      .launch(spec(fake), {}, { env: { PATH: '/nonexistent-bin' }, executable: 'harness-not-installed' })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ReviewWorkerLaunchError);
    expect(missing).toMatchObject({ harness: adapter.harness, kind: 'executable-missing' });
    for (const relative of ['./bin/harness', 'bin/harness']) {
      const refused = await adapter
        .launch(spec(fake), {}, { env: { [harness.executableKey]: relative, PATH: process.env.PATH } })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ kind: 'executable-invalid' });
      expect((refused as Error).message).toContain(harness.executableKey);
    }
    const marker = await launch(fake, { launchMarker: 'not-a-uuid' }).catch((error: unknown) => error);
    expect(marker).toMatchObject({ kind: 'spawn-failed' });
    expect(await fake.invocation()).toBeNull();
    // The executable environment override selects the fake without touching the PATH.
    const viaEnvironment = await adapter.launch(
      spec(fake),
      {},
      { env: { [harness.executableKey]: fake.executable, HOME: process.env.HOME, PATH: process.env.PATH } },
    );
    expect((await viaEnvironment.outcome).kind).toBe('finished');
  });

  test('a CLI whose --help lacks a relied-on flag, or that answers no version, is refused before anything runs', async () => {
    const withoutFlag = await fakeHarness(adapter.harness, harness.successBody, { help: harness.helpWithoutFlag.help });
    const refused = await launch(withoutFlag).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ReviewWorkerLaunchError);
    expect(refused).toMatchObject({ kind: 'cli-unqualified' });
    expect((refused as Error).message).toContain(harness.helpWithoutFlag.flag);
    expect(await withoutFlag.invocation()).toBeNull();
    const unversioned = await fakeHarness(adapter.harness, harness.successBody, { version: 'dev build' });
    await expect(launch(unversioned)).rejects.toMatchObject({ kind: 'cli-unqualified' });
    // A declared model needs `--model` from the CLI too.
    const withoutModel = await fakeHarness(adapter.harness, harness.successBody, {
      help: (adapter.harness === 'claude-code' ? CLAUDE_HELP : CODEX_HELP).replace(MODEL_HELP_LINE, ''),
    });
    const noModel = await launch(withoutModel, { model: 'opus' }).catch((error: unknown) => error);
    expect(noModel).toMatchObject({ kind: 'cli-unqualified' });
    expect((noModel as Error).message).toContain('--model');
  });

  test('bounds the final text at a character boundary', async () => {
    const long = `${'é'.repeat(20_000)}`;
    const body =
      adapter.harness === 'claude-code'
        ? emit(CLAUDE_INIT, JSON.stringify({ is_error: false, result: long, subtype: 'success', type: 'result' }))
        : emit(
            CODEX_THREAD,
            JSON.stringify({ item: { id: 'i', text: long, type: 'agent_message' }, type: 'item.completed' }),
            CODEX_TURN_COMPLETED,
          );
    const fake = await fakeHarness(adapter.harness, body);
    const outcome = await (await launch(fake)).outcome;
    expect(outcome.kind).toBe('finished');
    const text = outcome.finalText as string;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxWorkerFinalTextBytes);
    expect(Buffer.byteLength(text)).toBeGreaterThan(DELEGATION_BOUNDS.maxWorkerFinalTextBytes - 2);
    expect(text).not.toContain('\uFFFD');
  });
});

describe('codex review worker specifics', () => {
  test('refuses a checkout carrying .codex/config.toml without reading it or running anything', async () => {
    const fake = await fakeHarness('codex', emit(CODEX_THREAD, CODEX_MESSAGE, CODEX_TURN_COMPLETED));
    await mkdir(path.join(fake.checkout, '.codex'));
    await writeFile(path.join(fake.checkout, '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
    const refused = await codexReviewWorkerAdapter
      .launch(spec(fake), {}, { executable: fake.executable })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ReviewWorkerLaunchError);
    expect(refused).toMatchObject({ harness: 'codex', kind: 'project-config-present' });
    expect((refused as Error).message).not.toContain('danger-full-access');
    expect(await fake.invocation()).toBeNull();
  });

  test('states the exact argument vector, writes the schema to the private directory, passes it, and removes both private files', async () => {
    const fake = await fakeHarness('codex', emit(CODEX_THREAD, CODEX_MESSAGE, CODEX_TURN_COMPLETED));
    const schema = { properties: { summary: { type: 'string' } }, type: 'object' };
    const run = await codexReviewWorkerAdapter.launch(
      spec(fake, { effort: 'high', model: 'gpt-5-codex', outputSchema: schema }),
      {},
      { executable: fake.executable },
    );
    const token = delegationLaunchMarkerToken(MARKER);
    const outputPath = path.join(fake.privateDirectory, `${token}.last-message.txt`);
    const schemaPath = path.join(fake.privateDirectory, `${token}.schema.json`);
    expect(run.args).toEqual(
      codexReviewArguments({
        checkoutPath: fake.checkout,
        effort: 'high',
        model: 'gpt-5-codex',
        outputPath,
        schemaPath,
      }),
    );
    expect(run.args).toEqual([
      'exec',
      '-C',
      fake.checkout,
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'mcp_servers={}',
      '-c',
      'web_search="disabled"',
      '-c',
      'hide_agent_reasoning=true',
      '--disable',
      'hooks',
      '--disable',
      'multi_agent',
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="high"',
      '--json',
      '--color',
      'never',
      '-o',
      outputPath,
      '--output-schema',
      schemaPath,
      '-',
    ]);
    // While the process runs, the schema file is there for the CLI to read.
    expect(JSON.parse(await Bun.file(schemaPath).text())).toEqual(schema);
    expect((await run.outcome).kind).toBe('finished');
    expect(await readdir(fake.privateDirectory)).toEqual([]);
    const plain = codexReviewArguments({
      checkoutPath: '/c',
      effort: null,
      model: null,
      outputPath: '/p/o',
      schemaPath: null,
    });
    expect(plain).not.toContain('-m');
    expect(plain).not.toContain('--output-schema');
    expect(plain.filter((argument) => argument.startsWith('model_reasoning_effort'))).toEqual([]);
  });

  test('falls back to the last-message file when no agent message was streamed, and refuses an unsafe effort token', async () => {
    const fake = await fakeHarness(
      'codex',
      `${emit(CODEX_THREAD, CODEX_TURN_COMPLETED)}\nif (outputPath) await Bun.write(outputPath, ${JSON.stringify(FINAL)});`,
    );
    const outcome = await (await codexReviewWorkerAdapter.launch(spec(fake), {}, { executable: fake.executable }))
      .outcome;
    expect(outcome).toMatchObject({ finalText: FINAL, kind: 'finished', numTurns: 1, resultKind: 'review' });
    expect(await readdir(fake.privateDirectory)).toEqual([]);
    const unsafe = await codexReviewWorkerAdapter
      .launch(spec(fake, { effort: 'high" sandbox_mode="danger-full-access' }), {}, { executable: fake.executable })
      .catch((error: unknown) => error);
    expect(unsafe).toMatchObject({ kind: 'spawn-failed' });
  });

  test('a non-zero exit after a message, and a harness error event, both fail; usage is summed over turns', async () => {
    const exited = await fakeHarness(
      'codex',
      `${emit(CODEX_THREAD, CODEX_MESSAGE, CODEX_TURN_COMPLETED)}\nprocess.exit(2);`,
    );
    expect(
      await (await codexReviewWorkerAdapter.launch(spec(exited), {}, { executable: exited.executable })).outcome,
    ).toMatchObject({
      exitCode: 2,
      failureReason: 'exit 2',
      finalText: FINAL,
      kind: 'failed',
      resultKind: 'error',
    });
    const twoTurns = await fakeHarness(
      'codex',
      emit(CODEX_THREAD, CODEX_TURN_COMPLETED, CODEX_MESSAGE, CODEX_TURN_COMPLETED),
    );
    expect(
      await (await codexReviewWorkerAdapter.launch(spec(twoTurns), {}, { executable: twoTurns.executable })).outcome,
    ).toMatchObject({
      numTurns: 2,
      usage: { cachedInputTokens: 100, inputTokens: 200, outputTokens: 40, source: 'harness-reported' },
    });
    const errored = await fakeHarness('codex', emit(CODEX_THREAD, CODEX_ERROR, CODEX_MESSAGE));
    expect(
      await (await codexReviewWorkerAdapter.launch(spec(errored), {}, { executable: errored.executable })).outcome,
    ).toMatchObject({
      failureReason: 'codex turn.failed: rate limited with [redacted]',
      kind: 'failed',
      resultKind: 'error',
    });
  });

  test('reads exec events strictly and bounds every failure reason', () => {
    expect(parseCodexExecLine(CODEX_THREAD)).toEqual({ kind: 'thread-started', threadId: 'thread-codex-1' });
    expect(parseCodexExecLine(JSON.stringify({ thread_id: 'bad\nid', type: 'thread.started' }))).toBeNull();
    expect(parseCodexExecLine(CODEX_TURN_COMPLETED)).toEqual({
      kind: 'turn-completed',
      usage: { cachedInputTokens: 50, inputTokens: 100, outputTokens: 20, source: 'harness-reported' },
    });
    expect(parseCodexExecLine(JSON.stringify({ type: 'turn.completed' }))).toEqual({
      kind: 'turn-completed',
      usage: null,
    });
    expect(parseCodexExecLine(CODEX_MESSAGE)).toEqual({ kind: 'agent-message', text: FINAL });
    expect(parseCodexExecLine(CODEX_REASONING)).toBeNull();
    expect(parseCodexExecLine(JSON.stringify({ message: 'boom', type: 'error' }))).toEqual({
      detail: 'boom',
      eventType: 'error',
      kind: 'failure',
    });
    expect(parseCodexExecLine('')).toBeNull();
    expect(parseCodexExecLine('nope')).toBeNull();
    expect(codexFailureReason('error', `Bearer abc.def-ghi then ${'z'.repeat(400)}`)).toBe(
      `codex error: [redacted] then ${'z'.repeat(400)}`.slice(0, 'codex error: '.length + 200),
    );
    expect(codexFailureReason('error', 'tab\there\u0007bell')).toBe('codex error: tab here bell');
    expect(codexFailureReason('error', 42)).toBe('codex error');
  });
});

describe('final text bounding', () => {
  test('cuts at a character boundary and never splits a multi-byte sequence', () => {
    expect(boundTextBytes('abc', 10)).toBe('abc');
    expect(boundTextBytes('aéb', 2)).toBe('a');
    expect(boundTextBytes('aéb', 3)).toBe('aé');
    expect(boundTextBytes('😀😀', 5)).toBe('😀');
    expect(boundTextBytes('😀😀', 8)).toBe('😀😀');
  });
});
