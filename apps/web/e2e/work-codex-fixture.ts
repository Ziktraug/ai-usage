import { createHash } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCodexAppServerQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { importProviderQuotaBatch } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { type SeedWorkAttemptFixtureInput, WORK_ATTEMPT_FIXTURE_WORKTREE } from './work-attempt-fixture';

/** Explicit fake-process profile: no real Codex binary, credential or provider is contacted. */
export const CODEX_JOURNEY_ENV = 'AI_USAGE_CODEX_JOURNEY_E2E';
export const CODEX_JOURNEY_RECORD_ENV = 'AI_USAGE_CODEX_JOURNEY_RECORD';
export const CODEX_JOURNEY_FINGERPRINT = createHash('sha256')
  .update('ai-usage codex account v1\nfixture-account\nreview@example.test')
  .digest('hex')
  .slice(0, 16);
export const CODEX_JOURNEY_ACCOUNT = CODEX_JOURNEY_FINGERPRINT;

export const seedCodexJourneyFixture = async (input: SeedWorkAttemptFixtureInput): Promise<void> => {
  const sessions = path.join(input.home, '.codex', 'sessions', '2026', '07');
  const rootPath = path.join(sessions, 'rollout-2026-07-02T09-00-00-codex-root-025.jsonl');
  const original = await readFile(rootPath, 'utf8');
  const old = original
    .trim()
    .split('\n')
    .map((line) => {
      const event = JSON.parse(line);
      event.timestamp = new Date(Date.parse(event.timestamp) - 60 * 86_400_000).toISOString();
      if (event.type === 'session_meta') {
        event.payload.id = 'codex-old-context';
        event.payload.cwd = path.join(input.home, 'work', 'hidden-context');
      }
      if (event.payload.type === 'user_message') {
        event.payload.message = 'Old scoped exploration';
      }
      return JSON.stringify(event);
    });
  await writeFile(path.join(sessions, 'rollout-2026-05-03T09-00-00-codex-old-context.jsonl'), `${old.join('\n')}\n`);
  await writeFile(
    rootPath,
    `${original
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const event = JSON.parse(line);
        if (event.type === 'session_meta') {
          event.payload.cwd = path.join(input.repository, ...WORK_ATTEMPT_FIXTURE_WORKTREE);
        }
        return JSON.stringify(event);
      })
      .join('\n')}\n`,
  );
  await appendFile(
    rootPath,
    `${JSON.stringify({
      timestamp: '2026-07-02T09:04:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: 'fixture-native-question',
        arguments: JSON.stringify({
          questions: [
            {
              title: 'Keep the scoped context available across worktrees?',
              options: [
                { label: 'Keep', description: 'Retain context' },
                { label: 'Later', description: 'Defer' },
              ],
            },
          ],
        }),
      },
    })}\n`,
  );
  await appendFile(
    rootPath,
    `${JSON.stringify({ timestamp: '2026-07-02T09:04:01.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'fixture-native-question', output: JSON.stringify({ accepted: true }) } })}\n`,
  );
  const modePath = path.join(input.home, 'codex-fixture-mode');
  const logPath = path.join(input.home, 'codex-fixture-protocol.jsonl');
  await writeFile(modePath, 'success');
  // Reuse the adapter's tested fake protocol as data, with a visible pause for the browser lifecycle.
  const protocolPath = fileURLToPath(import.meta.resolve('@ai-usage/local-machine/testing/codex-review-app-server'));
  const fixturePath = path.join(input.fixtureBinDirectory, 'codex-protocol.ts');
  await writeFile(fixturePath, (await readFile(protocolPath, 'utf8')).replace('}, 25);', '}, 2500);'));
  const executable = path.join(input.fixtureBinDirectory, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.163.0\\n'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(9);
process.argv = [process.execPath, ${JSON.stringify(fixturePath)}, ${JSON.stringify(logPath)}, readFileSync(${JSON.stringify(modePath)}, 'utf8').trim()];
await import(${JSON.stringify(fixturePath)});
`,
  );
  await chmod(executable, 0o700);
  const configPath = path.join(input.home, '.config', 'ai-usage', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.delegation.routes.push({ accountScope: CODEX_JOURNEY_ACCOUNT, context: 'personal', harness: 'codex' });
  config.routing.executors.push({
    accountScope: CODEX_JOURNEY_ACCOUNT,
    accountFingerprint: CODEX_JOURNEY_FINGERPRINT,
    authorization: 'allowed',
    capabilities: ['read-only-review'],
    declaredAt: input.epoch.toISOString(),
    effort: 'high',
    harness: 'codex',
    model: 'gpt-6-astra',
    alternateModels: ['gpt-6-sol'],
    quality: 'review-capable',
    subscription: 'verified',
    targets: [{ kind: 'any-local-session' }],
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Acquisition stays disabled in the isolated production profile. Seed the same synthetic
  // account's quota at the pinned clock; launch still checks the fake app-server's live policy.
  const observation = normalizeCodexAppServerQuotaObservation({
    accountScope: CODEX_JOURNEY_ACCOUNT,
    machineId: input.machineId,
    machineLabel: input.machineLabel,
    observedAt: input.epoch,
    result: {
      rateLimits: {
        planType: 'pro',
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: Math.floor(input.epoch.getTime() / 1000) + 3600,
        },
        secondary: {
          usedPercent: 25,
          windowDurationMins: 10_080,
          resetsAt: Math.floor(input.epoch.getTime() / 1000) + 86_400,
        },
      },
    },
  });
  if (!observation || observation.windows.length === 0) {
    throw new Error('Invalid synthetic Codex quota observation.');
  }
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath: input.databasePath,
      items: [{ observation, sourceEventKey: 'codex-journey-e2e-fixture-1' }],
    }),
  );
  const record = process.env[CODEX_JOURNEY_RECORD_ENV];
  if (record) {
    await writeFile(record, JSON.stringify({ home: input.home, modePath, logPath }), { mode: 0o600 });
  }
};
