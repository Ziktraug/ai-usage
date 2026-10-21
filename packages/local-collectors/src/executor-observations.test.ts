import { describe, expect, test } from 'bun:test';
import { EXECUTOR_BOUNDS, type ExecutorObservation } from '@ai-usage/report-core/work-executors';
import {
  BoundedProcessError,
  type BoundedRun,
  type BoundedRunSpec,
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

type Script = Readonly<Record<string, (() => Promise<{ exitCode: number; stdout: string }>) | undefined>>;

const scripted = (script: Script): { readonly calls: BoundedRunSpec[]; readonly run: BoundedRun } => {
  const calls: BoundedRunSpec[] = [];
  const run: BoundedRun = (spec) => {
    calls.push(spec);
    const handler = script[`${spec.command} ${spec.args.join(' ')}`];
    if (!handler) {
      throw new BoundedProcessError('spawn-failed', spec.command);
    }
    return handler();
  };
  return { calls, run };
};

const ok =
  (stdout: string, exitCode = 0) =>
  () =>
    Promise.resolve({ exitCode, stdout });
const failing = (kind: 'output-limit' | 'spawn-failed' | 'timeout', command: string) => () =>
  Promise.reject(new BoundedProcessError(kind, command));
const bothPresent = (command: string): string | null => `/usr/bin/${command}`;

const observe = (
  run: BoundedRun,
  which: (command: string) => string | null = bothPresent,
  harnesses?: ExecutorObservation['harness'][],
) =>
  observeExecutors({
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
        authEvidence: 'claude auth status exit 0 loggedIn=true authMethod=claude.ai',
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
    expect(calls).toEqual([]);
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
      authState: 'logged-out',
      outcome: 'observed',
    });
    // The real CLI writes "Logged in using …" to stderr, which the runner discards: exit 0 alone
    // is the signed-in signal, and a stdout mention is only extra evidence.
    const silentStdout = scripted({ 'codex --version': ok('codex-cli 0.163.0'), 'codex login status': ok('') });
    expect((await observe(silentStdout.run, bothPresent, ['codex']))[0]).toMatchObject({
      authEvidence: 'codex login status exit 0',
      authState: 'logged-in',
      outcome: 'observed',
    });
  });

  test('a timeout or failure of either command is an outcome, never a guess', async () => {
    const authTimeout = scripted({
      'codex --version': ok('codex-cli 0.163.0'),
      'codex login status': failing('timeout', 'codex'),
    });
    expect((await observe(authTimeout.run, bothPresent, ['codex']))[0]).toMatchObject({
      authEvidence: 'codex login status timeout',
      authState: 'unknown',
      outcome: 'timeout',
      version: 'codex-cli 0.163.0',
    });

    const versionTimeout = scripted({
      'claude --version': failing('timeout', 'claude'),
      'claude auth status': ok(CLAUDE_STATUS),
    });
    expect((await observe(versionTimeout.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude --version timeout; claude auth status exit 0 loggedIn=true authMethod=claude.ai',
      authState: 'logged-in',
      outcome: 'timeout',
      version: null,
    });

    const versionBroken = scripted({
      'claude --version': ok('no version here', 2),
      'claude auth status': failing('spawn-failed', 'claude'),
    });
    expect((await observe(versionBroken.run, bothPresent, ['claude-code']))[0]).toMatchObject({
      authEvidence: 'claude --version exit 2 without a version; claude auth status spawn-failed',
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

  test('kills a process that exceeds its deadline or its output budget, and names a missing binary', async () => {
    const timedOut = await runBoundedProcess({
      args: ['-e', 'await Bun.sleep(30_000)'],
      command: bun,
      maximumOutputBytes: 1024,
      timeoutMs: 200,
    }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(BoundedProcessError);
    expect((timedOut as BoundedProcessError).kind).toBe('timeout');

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
    expect((missing as BoundedProcessError).kind).toBe('spawn-failed');
  });
});

const installed = (['claude-code', 'codex'] as const).filter(
  (harness) => Bun.which(harness === 'claude-code' ? 'claude' : 'codex') !== null,
);

describe('observeExecutors against the installed CLIs', () => {
  // Metadata reads only (`--version`, `auth status`, `login status`); nothing is generated and no
  // credential file is read. Skipped explicitly where the binaries are absent (CI).
  test.skipIf(installed.length === 0)(
    'reads versions and sign-in state without retaining raw output',
    async () => {
      const observations = await observeExecutors({
        harnesses: installed,
        machineId: 'local-smoke',
        timeoutMs: 10_000,
      });
      expect(observations).toHaveLength(installed.length);
      for (const observation of observations) {
        expect(observation.binaryPath).not.toBeNull();
        expect(observation.authEvidence.length).toBeLessThanOrEqual(EXECUTOR_BOUNDS.maxText);
        expect(observation.authEvidence).not.toContain('@');
        expect(['observed', 'timeout', 'invalid']).toContain(observation.outcome);
        if (observation.outcome === 'observed') {
          expect(observation.version).not.toBeNull();
        }
      }
    },
    30_000,
  );
});
