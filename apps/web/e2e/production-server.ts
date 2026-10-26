import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
  seedHarnessHome,
} from '@ai-usage/local-machine/testing/harness-home';
import { CONTINUITY_HOME_RECORD_ENV, seedCampaignContinuity } from './campaign-continuity-fixture';
import { CLOCK_EPOCH_ENVIRONMENT_KEY } from './production-clock';
import { SESSION_SCROLL_EXPECTED_COUNT } from './session-scroll-fixture';
import { seedWorkAttemptFixture, workAttemptFixtureEnabled } from './work-attempt-fixture';
import { CODEX_JOURNEY_ENV, seedCodexJourneyFixture } from './work-codex-fixture';
import { CODEX_NATIVE_ENV, seedCodexNativeRefusalFixture } from './work-codex-native-fixture';

const DEFAULT_CODEX_SESSION_COUNT = 205;
const DEFAULT_LISTENER_PORT = '4175';
const SCALE_FIXTURE_ENVIRONMENT_KEY = 'AI_USAGE_SESSION_SCALE_E2E';
const LISTENER_PORT_ENVIRONMENT_KEY = 'AI_USAGE_PRODUCTION_E2E_PORT';
const LISTENER_PORT_PATTERN = /^\d{1,5}$/;
const PRODUCTION_FIXTURE_EPOCH =
  process.env[CODEX_NATIVE_ENV] === '1' ? new Date().toISOString() : '2026-07-03T12:00:00.000Z';
const rootDirectory = path.resolve(import.meta.dirname, '../../..');
const productionClockUrl = pathToFileURL(path.join(import.meta.dirname, 'production-clock.ts')).href;
const scaleFixture = process.env[SCALE_FIXTURE_ENVIRONMENT_KEY] === '1';
const campaignContinuityFixture = process.env.AI_USAGE_CAMPAIGN_CONTINUITY_E2E === '1';
const listenerPort = process.env[LISTENER_PORT_ENVIRONMENT_KEY] ?? DEFAULT_LISTENER_PORT;

if (!(LISTENER_PORT_PATTERN.test(listenerPort) && Number(listenerPort) <= 65_535)) {
  throw new Error(`${LISTENER_PORT_ENVIRONMENT_KEY} must be a valid TCP port`);
}

const temporaryHome = await realpath(await mkdtemp(path.join(tmpdir(), 'plan052-production-browser-')));
const fixtureBinDirectory = path.join(temporaryHome, 'fixture-bin');
const configDirectory = path.join(temporaryHome, 'config');
const engineStateDirectory = path.join(temporaryHome, 'engine-state');
const logDirectory = path.join(temporaryHome, 'logs');
const temporaryDirectory = path.join(temporaryHome, 'tmp');
const databasePath = path.join(temporaryHome, 'store', 'usage.sqlite');
const machineConfigPath = path.join(temporaryHome, '.config', 'ai-usage', 'machine.json');

const cleanupHome = (): void => {
  rmSync(temporaryHome, { force: true, recursive: true });
};

try {
  await Promise.all(
    [
      fixtureBinDirectory,
      configDirectory,
      engineStateDirectory,
      logDirectory,
      temporaryDirectory,
      path.dirname(databasePath),
      path.dirname(machineConfigPath),
    ].map(async (directory) => await mkdir(directory, { mode: 0o700, recursive: true })),
  );
  const fakeGhPath = path.join(fixtureBinDirectory, 'gh');
  await writeFile(
    fakeGhPath,
    [
      '#!/usr/bin/env bun',
      'import { appendFileSync } from "node:fs";',
      `process.stderr.write(${JSON.stringify(HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL)});`,
      // The same fake answers the web resolver (pr list), the engine's pull request source
      // (personal searches, pr view, review threads, then REST api on failure); unsupported commands still fail.
      // Record only argv, never environment or token output, inside this disposable HOME.
      'const args = process.argv.slice(2);',
      'appendFileSync(import.meta.dirname + "/../work-thread-gh-argv.jsonl", JSON.stringify(args) + "\\n", { mode: 0o600 });',
      'const [command, subcommand, ...rest] = args;',
      'if (command === "pr" && subcommand === "list") {',
      '  process.stdout.write(JSON.stringify([{ number: 42, url: "https://github.com/fixture/ai-usage/pull/42" }]));',
      '} else if (command === "search" && subcommand === "prs" && (rest.includes("--author=@me") || rest.includes("--review-requested=@me"))) {',
      '  process.stdout.write(JSON.stringify(rest.includes("--author=@me") ? [{ number: 77, repository: { nameWithOwner: "fixture/discovered" }, title: "Discovered fixture pull request", url: "https://github.com/fixture/discovered/pull/77", updatedAt: "2026-07-03T11:00:00Z", isDraft: false }] : []));',
      // Discovery reads the active account token before searching; the fixture account has one.
      '} else if (command === "auth" && subcommand === "token") {',
      '  process.stdout.write("fixture-token\\n");',
      '} else if (command === "pr" && subcommand === "view") {',
      '  const repository = rest[rest.indexOf("--repo") + 1] ?? "fixture/ai-usage";',
      '  const number = Number(rest[0] ?? "42");',
      '  const discovered = repository === "fixture/discovered" && number === 77;',
      '  process.stdout.write(JSON.stringify({ baseRefName: "main", headRefName: "fixture/topic", isDraft: false, createdAt: "2026-07-01T09:00:00Z", closedAt: null, mergedAt: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "REVIEW_REQUIRED", state: "OPEN", statusCheckRollup: discovered ? [{ status: "COMPLETED", conclusion: "SUCCESS" }] : [], title: discovered ? "Discovered fixture pull request" : "Fixture pull request", updatedAt: "2026-07-03T11:00:00Z", url: "https://github.com/" + repository + "/pull/" + String(number) }));',
      '} else if (command === "api" && subcommand === "graphql") {',
      '  const fields = Object.fromEntries(rest.filter((_, index) => index % 2 === 1).map((field) => { const separator = field.indexOf("="); return [field.slice(0, separator), field.slice(separator + 1)]; }));',
      '  if (!fields.query?.trimStart().startsWith("query(") || !fields.query.includes("reviewThreads(first: 100)") || !fields.owner || !fields.name || !/^\\d+$/.test(fields.number ?? "")) {',
      '    process.exitCode = 1;',
      '  } else {',
      '    const discovered = fields.owner === "fixture" && fields.name === "discovered" && fields.number === "77";',
      '    const nodes = discovered ? [{ isResolved: false }, { isResolved: true }, { isResolved: false }] : [];',
      '    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, nodes } } } } }));',
      '  }',
      '} else if (command === "api") {',
      '  process.stdout.write(JSON.stringify({ message: "Not Found", status: "404" }));',
      '  process.exitCode = 1;',
      '} else {',
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'),
  );
  await chmod(fakeGhPath, 0o700);
  // A host Codex app-server migrates its native state database even without
  // credentials. Keep quota acquisition unavailable in this isolated fixture
  // so it cannot mutate the seeded thread evidence used by session details.
  const fakeCodexPath = path.join(fixtureBinDirectory, 'codex');
  await writeFile(
    fakeCodexPath,
    '#!/usr/bin/env bun\nprocess.stderr.write("Codex quota acquisition is unavailable in the production fixture.\\n");\nprocess.exitCode = 1;\n',
  );
  await chmod(fakeCodexPath, 0o700);
  // Native history fixtures must never fall through to an installed harness or provider CLI.
  // Attempt-specific profiles can replace these files with their own protocol simulators below.
  for (const command of ['claude', 'opencode', 'cursor', 'acli']) {
    const executable = path.join(fixtureBinDirectory, command);
    await writeFile(
      executable,
      '#!/usr/bin/env bun\nprocess.stderr.write("Unavailable in the isolated production fixture.\\n");\nprocess.exitCode = 1;\n',
      { mode: 0o700 },
    );
  }
  const codexSessionCount = scaleFixture ? SESSION_SCROLL_EXPECTED_COUNT : DEFAULT_CODEX_SESSION_COUNT;
  const defaultProfile = !(scaleFixture || campaignContinuityFixture);
  const seeded = await seedHarnessHome(temporaryHome, {
    codexSessionCount: campaignContinuityFixture ? 2 : codexSessionCount,
    harnesses: defaultProfile ? ['claude', 'codex'] : ['codex'],
    // The Claude Desktop session registry (24 roots, 17 children) joins the default profile only:
    // its ages are relative to the pinned clock so the Work view reads "1 h ago" on every run and
    // the 30-day window keeps the same roots, and the scale and continuity profiles keep the
    // golden counters they assert on. It produces no Session rows.
    ...(defaultProfile
      ? { claudeDesktopEpoch: new Date(PRODUCTION_FIXTURE_EPOCH), claudeDesktopSessions: 'representative' as const }
      : {}),
  });
  if (campaignContinuityFixture) {
    await seedCampaignContinuity(temporaryHome);
    const homeRecord = process.env[CONTINUITY_HOME_RECORD_ENV];
    if (homeRecord) {
      await writeFile(homeRecord, JSON.stringify({ home: temporaryHome }), { mode: 0o600 });
    }
  }
  await writeFile(
    machineConfigPath,
    `${JSON.stringify({ id: 'production-e2e-machine', label: 'Production fixture machine' })}\n`,
    { mode: 0o600 },
  );
  if (defaultProfile && workAttemptFixtureEnabled()) {
    // Opt-in only (ADR 0053): a fake `claude`, a declared route and review target, and one fresh
    // quota reading, so the Work view can launch and follow one read-only review in the browser.
    const workFixture = {
      databasePath,
      epoch: new Date(PRODUCTION_FIXTURE_EPOCH),
      fixtureBinDirectory,
      home: temporaryHome,
      machineId: 'production-e2e-machine',
      machineLabel: 'Production fixture machine',
      repository: seeded.paths.repository,
    };
    await seedWorkAttemptFixture(workFixture);
    if (process.env[CODEX_JOURNEY_ENV] === '1') {
      await seedCodexJourneyFixture(workFixture);
    }
    if (process.env[CODEX_NATIVE_ENV] === '1') {
      await seedCodexNativeRefusalFixture(workFixture);
    }
  }
  // The SDK can launch its bundled executable without consulting PATH. Disable acquisition and
  // executor probes in the disposable user config as well as masking installed executables.
  const fixtureConfigPath = path.join(temporaryHome, '.config', 'ai-usage', 'config.json');
  const existingConfig: unknown = await readFile(fixtureConfigPath, 'utf8')
    .then(JSON.parse)
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    });
  if (typeof existingConfig !== 'object' || existingConfig === null || Array.isArray(existingConfig)) {
    throw new Error('Invalid isolated production config.');
  }
  const policies = 'sourcePolicies' in existingConfig ? existingConfig.sourcePolicies : {};
  if (typeof policies !== 'object' || policies === null || Array.isArray(policies)) {
    throw new Error('Invalid isolated source policies.');
  }
  await writeFile(
    fixtureConfigPath,
    JSON.stringify({
      ...existingConfig,
      sourcePolicies: {
        ...policies,
        'claude.usage-limits': { enabled: false },
        'codex.usage-limits': { enabled: false },
        // The masked acli would make Jira read as installed and failing; no fixture profile observes
        // Jira, so the source stays off and its coverage keeps reading "not observed".
        'jira.issues': { enabled: false },
        'executors.capabilities': { enabled: defaultProfile && workAttemptFixtureEnabled() },
      },
    }),
    { mode: 0o600 },
  );
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'start'], {
    cwd: rootDirectory,
    env: {
      AI_USAGE_DATABASE_PATH: databasePath,
      AI_USAGE_ENGINE_PORT: '0',
      AI_USAGE_ENGINE_STATE_DIR: engineStateDirectory,
      AI_USAGE_HOME: temporaryHome,
      AI_USAGE_LOG_DIR: logDirectory,
      AI_USAGE_ROOT_DIR: configDirectory,
      AI_USAGE_TEMP_ROOT: temporaryDirectory,
      [CLOCK_EPOCH_ENVIRONMENT_KEY]: PRODUCTION_FIXTURE_EPOCH,
      HOME: temporaryHome,
      HOST: '127.0.0.1',
      IDLE_TIMEOUT: '45',
      NO_COLOR: '1',
      BUN_OPTIONS: `--preload=${productionClockUrl}`,
      PATH: `${fixtureBinDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      PORT: listenerPort,
      TMPDIR: temporaryDirectory,
      TZ: 'Europe/Paris',
      XDG_CACHE_HOME: path.join(temporaryHome, '.cache'),
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      XDG_DATA_HOME: path.join(temporaryHome, '.local', 'share'),
      ...(process.env.CI === undefined ? {} : { CI: process.env.CI }),
      ...(process.env.AI_USAGE_PERF === undefined ? {} : { AI_USAGE_PERF: process.env.AI_USAGE_PERF }),
    },
    stderr: 'inherit',
    stdout: 'inherit',
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 12_000);
      forceKill.unref();
    }
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const exitCode = await child.exited;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = exitCode;
} finally {
  // The child's exit is awaited above before its HOME is removed. This keeps
  // shutdown from racing revision-registry and SQLite cleanup.
  cleanupHome();
  const homeRecord = process.env[CONTINUITY_HOME_RECORD_ENV];
  if (campaignContinuityFixture && homeRecord) {
    rmSync(homeRecord, { force: true });
  }
}
