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
 *   `executors.capabilities` source observes a signed-in Claude Code), `--help` with the options
 *   the launcher qualifies (ADR 0055), and `-p … --output-format stream-json` with one
 *   `system/init` line, a pause, and one `result` line, both carrying the `--session-id` it was
 *   given, as the real CLI does. It exits non-zero unless the launch excluded every settings
 *   source, ran in safe mode with only Read, Grep and Glob, in plan mode; any other invocation
 *   fails. The Claude quota source is untouched: the Agent SDK runs its own bundled CLI, never PATH.
 * - the disposable home config: one `routing.executors[]` declaration for Claude Code, one
 *   `routing.reviewTargets[]` entry naming the seeded fixture repository, so the blocked root's
 *   worktree (a descendant) is admitted, and one `delegation.routes[]` annotation giving that
 *   route a context, which the common review policy requires of every launch (ADR 0077);
 * - the worktree directory the blocked Desktop root declares as `cwd`, a git repository with two
 *   commits, so the harness starts there and the review's scope is the second commit;
 * - one stored Claude quota observation dated at the pinned clock, because a `real`
 *   recommendation needs fresh quota and the isolated home has no Claude credentials to read any.
 */
export const WORK_ATTEMPT_FIXTURE_ENVIRONMENT_KEY = 'AI_USAGE_WORK_ATTEMPT_E2E';
export const WORK_ATTEMPT_FIXTURE_ACCOUNT = 'fixture';
/** The subject of the commit the review is given (the worktree's HEAD). */
export const WORK_ATTEMPT_FIXTURE_COMMIT_SUBJECT = 'fixture: change the review target';
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

/** What `claude --help` must name for the launcher to qualify the CLI (claude-review-cli.ts). */
const FAKE_HELP_OPTIONS = [
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
] as const;

const FIXTURE_GIT_ENVIRONMENT = {
  GIT_AUTHOR_DATE: '2026-07-01T08:00:00Z',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_COMMITTER_DATE: '2026-07-01T08:00:00Z',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
} as const;

/** A two-commit repository at the worktree, so the review has one commit and a first parent to compare it with. */
const seedReviewedCheckout = async (checkout: string): Promise<void> => {
  const git = async (...args: string[]): Promise<void> => {
    const run = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: checkout,
      env: { HOME: checkout, PATH: process.env.PATH ?? '', ...FIXTURE_GIT_ENVIRONMENT },
      stderr: 'ignore',
      stdout: 'ignore',
    });
    if ((await run.exited) !== 0) {
      throw new Error(`git ${args[0]} failed while seeding the review fixture checkout`);
    }
  };
  await git('init', '-q', '-b', 'main');
  await writeFile(path.join(checkout, 'a.ts'), 'export const value = 1;\n');
  await git('add', 'a.ts');
  await git('commit', '-q', '-m', 'fixture: first');
  await writeFile(path.join(checkout, 'a.ts'), 'export const value = 2;\n');
  await git('commit', '-q', '-am', WORK_ATTEMPT_FIXTURE_COMMIT_SUBJECT);
};

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
    'if (args[0] === "--help") {',
    `  process.stdout.write(${JSON.stringify(`${FAKE_HELP_OPTIONS.join('\n')}\n`)});`,
    '  process.exit(0);',
    '}',
    'if (args[0] === "-p") {',
    '  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);',
    '  if (value("--permission-mode") !== "plan" || args.includes("--dangerously-skip-permissions")) { process.exit(7); }',
    '  if (value("--setting-sources") !== "" || !args.includes("--safe-mode")) { process.exit(6); }',
    '  const tools = args.slice(args.indexOf("--tools") + 1, args.indexOf("--strict-mcp-config"));',
    '  if (tools.join(",") !== "Read,Grep,Glob") { process.exit(5); }',
    '  const sessionId = value("--session-id") ?? "";',
    '  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) { process.exit(4); }',
    '  write({ session_id: sessionId, subtype: "init", tools: ["Read", "Grep", "Glob"], type: "system" });',
    `  await new Promise((resolve) => setTimeout(resolve, ${WORK_ATTEMPT_FIXTURE_RUN_MS}));`,
    `  write({ duration_ms: ${WORK_ATTEMPT_FIXTURE_RUN_MS}, is_error: false, num_turns: 2, result: ${JSON.stringify(WORK_ATTEMPT_FIXTURE_RESULT)}, session_id: sessionId, subtype: "success", type: "result" });`,
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
        // The common review policy every launch passes (ADR 0077, PR #73 F1) admits a route only
        // with a declared context; nothing else is declared, so no rule applies to the launch.
        delegation: {
          routes: [{ accountScope: WORK_ATTEMPT_FIXTURE_ACCOUNT, context: 'personal', harness: 'claude-code' }],
        },
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
  const worktree = path.join(input.repository, ...WORK_ATTEMPT_FIXTURE_WORKTREE);
  await mkdir(worktree, { recursive: true });
  await seedReviewedCheckout(worktree);

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
