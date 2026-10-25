import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EXECUTOR_BOUNDS, type ExecutorObservation } from '@ai-usage/report-core/work-executors';
import {
  BoundedProcessError,
  type BoundedProcessFailureKind,
  type BoundedRun,
  type BoundedRunSpec,
  claudeAccountFingerprint,
  observeExecutors,
  runBoundedProcess,
} from './executor-observations';

const NOW = new Date('2026-10-21T21:00:00.000Z');
const SECRET_EMAIL = 'operator@example.test';
const CLAUDE_STATUS = JSON.stringify({
  authMethod: 'claude.ai',
  email: SECRET_EMAIL,
  loggedIn: true,
  orgId: 'org-secret',
  subscriptionType: 'max',
});

const FINGERPRINT_FORMAT = /^[0-9a-f]{16}$/u;
/**
 * Computed independently of the collector: the format is a contract, since an operator pins this
 * value in the declaration; changing it would contradict every pinned route at once.
 */
const EXPECTED_FINGERPRINT = createHash('sha256')
  .update(`ai-usage executor account v1\norg=org-secret\nemail=${SECRET_EMAIL}`)
  .digest('hex')
  .slice(0, 16);

type Script = Readonly<Record<string, (() => Promise<{ exitCode: number; stdout: string }>) | undefined>>;

const boundedFailure = (kind: BoundedProcessFailureKind, command: string): BoundedProcessError =>
  new BoundedProcessError({ kind, message: `${command}: ${kind}` });

const scripted = (script: Script): { readonly calls: BoundedRunSpec[]; readonly run: BoundedRun } => {
  const calls: BoundedRunSpec[] = [];
  const run: BoundedRun = (spec) => {
    calls.push(spec);
    const handler = script[`${spec.command} ${spec.args.join(' ')}`];
    if (!handler) {
      throw boundedFailure('unavailable', spec.command);
    }
    return handler();
  };
  return { calls, run };
};

const ok =
  (stdout: string, exitCode = 0) =>
  () =>
    Promise.resolve({ exitCode, stdout });
const failing = (kind: BoundedProcessFailureKind, command: string) => () =>
  Promise.reject(boundedFailure(kind, command));
const bothPresent = (command: string): string | null => `/usr/bin/${command}`;

const observe = (
  run: BoundedRun,
  which: (command: string) => string | null = bothPresent,
  harnesses?: ExecutorObservation['harness'][],
) =>
  observeExecutors({
    codexAccountProbe: async () => null,
    ...(harnesses === undefined ? {} : { harnesses }),
    machineId: 'machine-a',
    now: () => NOW,
    run,
    timeoutMs: 5000,
    which,
  });

describe('observeExecutors', () => {
  test('observes both harnesses as logged in from version and status commands, without raw output', async () => {
    const { calls, run } = scripted({
      'claude --version': ok('2.1.303 (Claude Code)\n'),
      'claude auth status': ok(CLAUDE_STATUS),
      'codex --version': ok('codex-cli 0.163.0\n'),
      'codex login status': ok(`Logged in using ChatGPT as ${SECRET_EMAIL}\n`),
    });
    const observations = await observe(run);
    expect(observations).toEqual([
      {
        accountFingerprint: EXPECTED_FINGERPRINT,
        authEvidence: 'claude auth status exit 0 loggedIn=true authMethod=claude.ai',
        authMethod: 'claude.ai',
        authState: 'logged-in',
        binaryPath: '/usr/bin/claude',
        harness: 'claude-code',
        machineId: 'machine-a',
        observedAt: NOW.toISOString(),
        outcome: 'observed',
        version: '2.1.303 (Claude Code)',
      },
      {
        authEvidence: 'codex login status exit 0 (output mentions "Logged in")',
        authMethod: 'chatgpt',
        authState: 'logged-in',
        binaryPath: '/usr/bin/codex',
        harness: 'codex',
        machineId: 'machine-a',
        observedAt: NOW.toISOString(),
        outcome: 'observed',
        version: 'codex-cli 0.163.0',
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(SECRET_EMAIL);
    expect(JSON.stringify(observations)).not.toContain('org-secret');
    expect(calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
      'claude --version',
      'claude auth status',
      'codex --version',
      'codex login status',
    ]);
    expect(calls.every((call) => call.timeoutMs === 5000 && call.maximumOutputBytes > 0)).toBe(true);
  });

  test('propagates an API-key sign-in method from either CLI, bounded and printable', async () => {
    const apiKey = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ authMethod: 'api-key', loggedIn: true })),
      'codex --version': ok('codex-cli 0.163.0'),
      'codex login status': ok('Logged in using an API key\n'),
    });
    expect((await observe(apiKey.run)).map(({ authMethod, authState }) => [authMethod, authState])).toEqual([
      ['api-key', 'logged-in'],
      ['api-key', 'logged-in'],
    ]);
    const console = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ authMethod: 'console', loggedIn: true })),
    });
    expect((await observe(console.run, bothPresent, ['claude-code']))[0]?.authMethod).toBe('console');
    // A method the CLI never named, or one that is not short printable text, is simply unknown.
    const unnamed = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ loggedIn: true })),
    });
    expect((await observe(unnamed.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude auth status exit 0 loggedIn=true',
      authMethod: null,
    });
    const garbled = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ authMethod: 'line\nbreak', loggedIn: true })),
    });
    expect((await observe(garbled.run, bothPresent, ['claude-code']))[0]?.authMethod).toBeNull();
    const long = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ authMethod: 'm'.repeat(200), loggedIn: true })),
    });
    expect((await observe(long.run, bothPresent, ['claude-code']))[0]?.authMethod).toBe(
      'm'.repeat(EXECUTOR_BOUNDS.maxAuthMethod),
    );
  });

  test('probes the account the launch will use: its CLAUDE_CONFIG_DIR and its executable override (ADR 0057)', async () => {
    const reviews = '/home/op/.claude-reviews';
    const override = '/opt/claude-review/bin/claude';
    const { calls, run } = scripted({
      [`${override} --version`]: ok('2.1.306 (Claude Code)\n'),
      [`${override} auth status`]: ok(CLAUDE_STATUS),
    });
    const [observation] = await observeExecutors({
      env: { AI_USAGE_CLAUDE_EXECUTABLE: override, CLAUDE_CONFIG_DIR: reviews, PATH: '/usr/bin' },
      harnesses: ['claude-code'],
      machineId: 'machine-a',
      now: () => NOW,
      run,
      timeoutMs: 5000,
      which: bothPresent,
    });
    expect(observation).toMatchObject({ accountFingerprint: EXPECTED_FINGERPRINT, binaryPath: override });
    expect(calls.map((call) => call.command)).toEqual([override, override]);
    expect(calls.every((call) => call.env?.CLAUDE_CONFIG_DIR === reviews)).toBe(true);

    // Without either variable the probe runs `claude` from the PATH with no extra environment.
    const plain = scripted({ 'claude --version': ok('2.1.306\n'), 'claude auth status': ok(CLAUDE_STATUS) });
    await observeExecutors({
      env: { PATH: '/usr/bin' },
      harnesses: ['claude-code'],
      machineId: 'machine-a',
      now: () => NOW,
      run: plain.run,
      timeoutMs: 5000,
      which: bothPresent,
    });
    expect(plain.calls.map((call) => [call.command, call.env?.CLAUDE_CONFIG_DIR])).toEqual([
      ['claude', undefined],
      ['claude', undefined],
    ]);

    // A relative override is refused exactly as the launcher refuses it, and nothing runs.
    const relative = scripted({});
    const [refused] = await observeExecutors({
      env: { AI_USAGE_CLAUDE_EXECUTABLE: 'bin/claude', PATH: '/usr/bin' },
      harnesses: ['claude-code'],
      machineId: 'machine-a',
      now: () => NOW,
      run: relative.run,
      timeoutMs: 5000,
      which: bothPresent,
    });
    expect(refused).toMatchObject({ binaryPath: null, outcome: 'unavailable' });
    expect(refused?.authEvidence).toContain('AI_USAGE_CLAUDE_EXECUTABLE must be an absolute path');
    expect(relative.calls).toEqual([]);
  });

  test('reports an absent binary as unavailable without running anything', async () => {
    const { calls, run } = scripted({});
    const observations = await observe(run, () => null);
    expect(
      observations.map((observation) => [observation.outcome, observation.binaryPath, observation.authState]),
    ).toEqual([
      ['unavailable', null, 'unknown'],
      ['unavailable', null, 'unknown'],
    ]);
    expect(observations[0]?.authEvidence).toBe('claude binary not found on PATH');
    expect(observations[0]?.authMethod).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a runner that cannot start the binary makes the executor unavailable, with no binary path', async () => {
    const { run } = scripted({});
    const [observation] = await observe(run, bothPresent, ['claude-code']);
    expect(observation).toEqual({
      authEvidence: 'claude --version unavailable to the bounded runner',
      authMethod: null,
      authState: 'unknown',
      binaryPath: null,
      harness: 'claude-code',
      machineId: 'machine-a',
      observedAt: NOW.toISOString(),
      outcome: 'unavailable',
      version: null,
    });
    const laterUnavailable = scripted({ 'codex --version': ok('codex-cli 0.163.0') });
    expect((await observe(laterUnavailable.run, bothPresent, ['codex']))[0]).toMatchObject({
      authEvidence: 'codex login status unavailable to the bounded runner',
      binaryPath: null,
      outcome: 'unavailable',
      version: null,
    });
  });

  test('fingerprints the reported account without keeping it, and only for a signed-in CLI (ADR 0057)', async () => {
    expect(claudeAccountFingerprint({ email: SECRET_EMAIL, orgId: 'org-secret' })).toBe(EXPECTED_FINGERPRINT);
    expect(claudeAccountFingerprint({ email: ` ${SECRET_EMAIL.toUpperCase()} `, orgId: 'org-secret' })).toBe(
      EXPECTED_FINGERPRINT,
    );
    expect(claudeAccountFingerprint({ email: SECRET_EMAIL, orgId: 'org-other' })).not.toBe(EXPECTED_FINGERPRINT);
    expect(claudeAccountFingerprint({ email: SECRET_EMAIL })).toMatch(FINGERPRINT_FORMAT);
    for (const silent of [{}, { email: '', orgId: '  ' }, { email: 7 }, { orgId: 'o'.repeat(513) }, null, 'x']) {
      expect(claudeAccountFingerprint(silent)).toBeNull();
    }
    const signedOut = await observe(
      scripted({
        'claude --version': ok('2.1.306 (Claude Code)\n'),
        'claude auth status': ok(JSON.stringify({ email: SECRET_EMAIL, loggedIn: false, orgId: 'org-secret' }), 1),
      }).run,
      bothPresent,
      ['claude-code'],
    );
    expect(signedOut[0] && 'accountFingerprint' in signedOut[0]).toBe(false);
    const anonymous = await observe(
      scripted({
        'claude --version': ok('2.1.306 (Claude Code)\n'),
        'claude auth status': ok(JSON.stringify({ authMethod: 'claude.ai', loggedIn: true })),
      }).run,
      bothPresent,
      ['claude-code'],
    );
    expect(anonymous[0] && 'accountFingerprint' in anonymous[0]).toBe(false);
  });

  test('classifies the Claude sign-in state from the loggedIn field only', async () => {
    const loggedOut = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ loggedIn: false }), 1),
    });
    expect((await observe(loggedOut.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude auth status exit 1 loggedIn=false',
      authState: 'logged-out',
      outcome: 'observed',
    });

    const legacy = scripted({
      'claude --version': ok('1.0.0 (Claude Code)'),
      'claude auth status': ok("error: unknown command 'auth'", 1),
    });
    expect((await observe(legacy.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'no non-interactive auth status command (claude auth status exit 1)',
      authState: 'unknown',
      outcome: 'observed',
    });

    const unrecognised = scripted({
      'claude --version': ok('2.1.303 (Claude Code)'),
      'claude auth status': ok(JSON.stringify({ status: 'fine' })),
    });
    expect((await observe(unrecognised.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude auth status exit 0 without a loggedIn field',
      authState: 'unknown',
    });
  });

  test('classifies the Codex sign-in state from the exit code and status line', async () => {
    const loggedOut = scripted({
      'codex --version': ok('codex-cli 0.163.0'),
      'codex login status': ok('Not logged in', 1),
    });
    expect((await observe(loggedOut.run, bothPresent, ['codex']))[0]).toMatchObject({
      authEvidence: 'codex login status exit 1',
      authMethod: null,
      authState: 'logged-out',
      outcome: 'observed',
    });
    // The real CLI writes "Logged in using …" to stderr, which the runner discards: exit 0 alone
    // is the signed-in signal, and a stdout mention is only extra evidence.
    const silentStdout = scripted({ 'codex --version': ok('codex-cli 0.163.0'), 'codex login status': ok('') });
    expect((await observe(silentStdout.run, bothPresent, ['codex']))[0]).toMatchObject({
      authEvidence: 'codex login status exit 0',
      authMethod: null,
      authState: 'logged-in',
      outcome: 'observed',
    });
  });

  test('a timeout or failure of either command is an outcome, never a guess', async () => {
    const authTimeout = scripted({
      'codex --version': ok('codex-cli 0.163.0'),
      'codex login status': failing('timed-out', 'codex'),
    });
    expect((await observe(authTimeout.run, bothPresent, ['codex']))[0]).toMatchObject({
      authEvidence: 'codex login status timed-out',
      authState: 'unknown',
      outcome: 'timeout',
      version: 'codex-cli 0.163.0',
    });

    const versionTimeout = scripted({
      'claude --version': failing('timed-out', 'claude'),
      'claude auth status': ok(CLAUDE_STATUS),
    });
    expect((await observe(versionTimeout.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude --version timed-out; claude auth status exit 0 loggedIn=true authMethod=claude.ai',
      authMethod: 'claude.ai',
      authState: 'logged-in',
      outcome: 'timeout',
      version: null,
    });

    const versionBroken = scripted({
      'claude --version': ok('no version here', 2),
      'claude auth status': failing('failed', 'claude'),
    });
    expect((await observe(versionBroken.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude --version exit 2 without a version; claude auth status failed',
      authState: 'unknown',
      outcome: 'invalid',
      version: null,
    });

    const overflow = scripted({
      'codex --version': failing('output-limit', 'codex'),
      'codex login status': ok('Logged in using ChatGPT'),
    });
    expect((await observe(overflow.run, bothPresent, ['codex']))[0]).toMatchObject({
      outcome: 'invalid',
      version: null,
    });
  });

  test('bounds every stored text field', async () => {
    const longVersion = `${'9'.repeat(10)}.${'1'.repeat(400)}`;
    const { run } = scripted({
      'codex --version': ok(longVersion),
      'codex login status': ok(`Logged in ${'x'.repeat(5000)}`),
    });
    const [observation] = await observe(run, () => `/${'p'.repeat(EXECUTOR_BOUNDS.maxPath)}`, ['codex']);
    expect(observation?.version?.length).toBe(EXECUTOR_BOUNDS.maxText);
    expect(observation?.authEvidence.length).toBeLessThanOrEqual(EXECUTOR_BOUNDS.maxText);
    expect(observation?.binaryPath).toBeNull();
  });
});

describe('runBoundedProcess', () => {
  const bun = process.execPath;

  test('captures stdout and the exit code without a shell', async () => {
    const result = await runBoundedProcess({
      args: ['-e', 'console.log("hello $HOME"); process.exit(3)'],
      command: bun,
      maximumOutputBytes: 1024,
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ exitCode: 3, stdout: 'hello $HOME\n' });
  });

  test('hands the probes the allow-listed environment only, never the whole process environment', async () => {
    const name = 'AI_USAGE_EXECUTOR_PROBE_SECRET';
    process.env[name] = 'leaked-if-inherited';
    try {
      const result = await runBoundedProcess({
        args: ['-e', `console.log(JSON.stringify([process.env.${name} ?? "absent", typeof process.env.PATH]))`],
        command: bun,
        maximumOutputBytes: 1024,
        timeoutMs: 10_000,
      });
      expect(JSON.parse(result.stdout)).toEqual(['absent', 'string']);
    } finally {
      delete process.env[name];
    }
  });

  test('kills a process that exceeds its deadline or its output budget, and names a missing binary', async () => {
    const timedOut = await runBoundedProcess({
      args: ['-e', 'await Bun.sleep(30_000)'],
      command: bun,
      maximumOutputBytes: 1024,
      timeoutMs: 200,
    }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(BoundedProcessError);
    expect((timedOut as BoundedProcessError).kind).toBe('timed-out');

    const overflow = await runBoundedProcess({
      args: ['-e', 'console.log("x".repeat(100_000))'],
      command: bun,
      maximumOutputBytes: 1000,
      timeoutMs: 10_000,
    }).catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(BoundedProcessError);
    expect((overflow as BoundedProcessError).kind).toBe('output-limit');

    const missing = await runBoundedProcess({
      args: [],
      command: '/nonexistent/ai-usage-executor-probe',
      maximumOutputBytes: 1024,
      timeoutMs: 1000,
    }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(BoundedProcessError);
    expect((missing as BoundedProcessError).kind).toBe('unavailable');
  });
});

const installed = (['claude-code', 'codex'] as const).filter(
  (harness) => Bun.which(harness === 'claude-code' ? 'claude' : 'codex') !== null,
);

// Metadata reads only (`--version`, `auth status`, `login status`); nothing is generated and no
// credential file is read. Skipped explicitly where the binaries are absent (CI).
describe.skipIf(installed.length === 0)('observeExecutors against the installed CLIs', () => {
  test('reads versions and sign-in state without retaining raw output', async () => {
    const observations = await observeExecutors({
      harnesses: installed,
      machineId: 'local-smoke',
      timeoutMs: 10_000,
    });
    expect(observations).toHaveLength(installed.length);
    for (const observation of observations) {
      expect(observation.authEvidence.length).toBeLessThanOrEqual(EXECUTOR_BOUNDS.maxText);
      expect(observation.authEvidence).not.toContain('@');
      expect(['observed', 'timeout', 'invalid', 'unavailable']).toContain(observation.outcome);
      if (observation.outcome !== 'unavailable') {
        expect(observation.binaryPath).not.toBeNull();
      }
      if (observation.outcome === 'observed') {
        expect(observation.version).not.toBeNull();
      }
    }
  }, 30_000);
});

test('Codex app-server identity replaces ambiguous login-status stdout without retaining account or quota bodies', async () => {
  const { run } = scripted({ 'codex --version': ok('codex-cli 0.163.0\n'), 'codex login status': ok('') });
  const observations = await observeExecutors({
    machineId: 'machine-a',
    harnesses: ['codex'],
    which: bothPresent,
    run,
    now: () => NOW,
    codexAccountProbe: async () => ({
      accountFingerprint: 'a'.repeat(16),
      authMethod: 'chatgpt',
      authState: 'logged-in',
      evidence: 'Codex app-server account/read: ChatGPT',
      quota: { private: 'must not persist' },
    }),
  });
  expect(observations[0]).toMatchObject({
    accountFingerprint: 'a'.repeat(16),
    authMethod: 'chatgpt',
    authState: 'logged-in',
  });
  expect(JSON.stringify(observations)).not.toContain('must not persist');
});
