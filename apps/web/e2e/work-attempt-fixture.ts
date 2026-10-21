import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL } from '@ai-usage/local-machine/testing/harness-home';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { importProviderQuotaBatch, initializeUsageStore } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';

/**
 * The production-path fixture for one launched review (ADR 0053), enabled by
 * `AI_USAGE_WORK_ATTEMPT_E2E=1` so the default production profile keeps its golden counters:
 *
 * - a fake `claude` first on the engine's PATH: answers `--version` and `auth status` (so the
 *   `executors.capabilities` source observes a signed-in Claude Code) and `-p … --output-format
 *   stream-json` with one `system/init` line, a pause, and one `result` line; any other invocation
 *   fails. The Claude quota source is untouched: the Agent SDK runs its own bundled CLI, never PATH.
 * - the disposable home config: one `routing.executors[]` declaration for Claude Code and one
 *   `routing.reviewTargets[]` entry naming the seeded fixture repository, so the blocked root's
 *   worktree (a descendant) is admitted;
 * - the worktree directory the blocked Desktop root declares as `cwd`, so the harness can start there;
 * - one stored Claude quota observation dated at the pinned clock, because a `real`
 *   recommendation needs fresh quota and the isolated home has no Claude credentials to read any.
 */
export const WORK_ATTEMPT_FIXTURE_ENVIRONMENT_KEY = 'AI_USAGE_WORK_ATTEMPT_E2E';
export const WORK_ATTEMPT_FIXTURE_ACCOUNT = 'fixture';
export const WORK_ATTEMPT_FIXTURE_NATIVE_SESSION_ID = 'fixture-review-session-0001';
export const WORK_ATTEMPT_FIXTURE_RESULT =
  'Finding 1: packages/fixture/a.ts:1 (low) The fixture change has no test.\nFinding 2: README.md:3 (info) Wording only.';
/** The fake harness pauses this long between init and result, so a second request lands on a live attempt. */
export const WORK_ATTEMPT_FIXTURE_RUN_MS = 2500;
export const WORK_ATTEMPT_FIXTURE_WORKTREE = ['.claude', 'worktrees', 'checkout-3'] as const;

export const workAttemptFixtureEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[WORK_ATTEMPT_FIXTURE_ENVIRONMENT_KEY] === '1';

export const workAttemptFixtureCandidateId = (machineId: string): string =>
  `declared:${JSON.stringify([machineId, 'claude-code', WORK_ATTEMPT_FIXTURE_ACCOUNT])}`;

export interface SeedWorkAttemptFixtureInput {
  readonly databasePath: string;
  readonly epoch: Date;
  readonly fixtureBinDirectory: string;
  readonly home: string;
  readonly machineId: string;
  readonly machineLabel: string;
  /** The seeded fixture checkout (`seedHarnessHome().paths.repository`). */
  readonly repository: string;
}

const fakeClaudeSource = (): string =>
  [
    '#!/usr/bin/env bun',
    `process.stderr.write(${JSON.stringify(HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL)});`,
    'const args = process.argv.slice(2);',
    'const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    'if (args[0] === "--version" || args[0] === "-v") {',
    '  process.stdout.write("2.1.306 (Claude Code)\\n");',
    '  process.exit(0);',
    '}',
    'if (args[0] === "auth" && args[1] === "status") {',
    '  write({ authMethod: "claude.ai", loggedIn: true });',
    '  process.exit(0);',
    '}',
    'if (args[0] === "-p") {',
    '  const mode = args[args.indexOf("--permission-mode") + 1];',
    '  if (mode !== "plan" || args.includes("--dangerously-skip-permissions")) { process.exit(7); }',
    `  write({ session_id: ${JSON.stringify(WORK_ATTEMPT_FIXTURE_NATIVE_SESSION_ID)}, subtype: "init", tools: ["Read", "Grep", "Glob"], type: "system" });`,
    `  await new Promise((resolve) => setTimeout(resolve, ${WORK_ATTEMPT_FIXTURE_RUN_MS}));`,
    `  write({ duration_ms: ${WORK_ATTEMPT_FIXTURE_RUN_MS}, is_error: false, num_turns: 2, result: ${JSON.stringify(WORK_ATTEMPT_FIXTURE_RESULT)}, session_id: ${JSON.stringify(WORK_ATTEMPT_FIXTURE_NATIVE_SESSION_ID)}, subtype: "success", type: "result" });`,
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n');

export const seedWorkAttemptFixture = async (input: SeedWorkAttemptFixtureInput): Promise<void> => {
  const fakeClaudePath = path.join(input.fixtureBinDirectory, 'claude');
  await writeFile(fakeClaudePath, fakeClaudeSource());
  await chmod(fakeClaudePath, 0o700);

  const configDirectory = path.join(input.home, '.config', 'ai-usage');
  await mkdir(configDirectory, { mode: 0o700, recursive: true });
  await writeFile(
    path.join(configDirectory, 'config.json'),
    `${JSON.stringify(
      {
        routing: {
          executors: [
            {
              accountScope: WORK_ATTEMPT_FIXTURE_ACCOUNT,
              authorization: 'allowed',
              capabilities: ['read-only-review'],
              declaredAt: '2026-07-01T08:00:00.000Z',
              harness: 'claude-code',
              quality: 'review-capable',
              subscription: 'verified',
              targets: [{ kind: 'any-local-session' }],
            },
          ],
          reviewTargets: [{ checkoutPath: input.repository, label: 'fixture checkout' }],
        },
        // The isolated home has no Claude credentials: the live quota source would record a newer,
        // window-less reading on the same stream and hide the seeded one. One stored reading stands.
        sourcePolicies: { 'claude.usage-limits': { enabled: false } },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  // The blocked root declares a worktree under the repository as its cwd; the harness starts there.
  await mkdir(path.join(input.repository, ...WORK_ATTEMPT_FIXTURE_WORKTREE), { recursive: true });

  await mkdir(path.dirname(input.databasePath), { mode: 0o700, recursive: true });
  await Effect.runPromise(initializeUsageStore({ dbPath: input.databasePath }));
  const observation: ProviderQuotaObservation = {
    accountScope: null,
    machineId: input.machineId,
    machineLabel: input.machineLabel,
    observedAt: input.epoch.toISOString(),
    plan: 'max',
    providerGeneratedAt: null,
    providerKey: 'claude',
    providerLabel: 'Claude',
    source: { confidence: 'authoritative', key: 'work-attempt-e2e-fixture', mode: 'poll' },
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: '5h',
        id: 'five_hour',
        label: '5h',
        limitSeconds: 18_000,
        remainingPercent: 70,
        resetsAt: new Date(input.epoch.getTime() + 3 * 3_600_000).toISOString(),
        scope: 'global',
        usedPercent: 30,
      },
    ],
  };
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath: input.databasePath,
      items: [{ observation, sourceEventKey: 'work-attempt-e2e-fixture-1' }],
    }),
  );
};
