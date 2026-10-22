import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SeedWorkAttemptFixtureInput } from './work-attempt-fixture';

/** Explicit fake-process profile: no real Codex binary, credential or provider is contacted. */
export const CODEX_JOURNEY_ENV = 'AI_USAGE_CODEX_JOURNEY_E2E';
export const CODEX_JOURNEY_RECORD_ENV = 'AI_USAGE_CODEX_JOURNEY_RECORD';
export const CODEX_JOURNEY_FINGERPRINT = createHash('sha256')
  .update('ai-usage codex account v1\nfixture-account\nreview@example.test')
  .digest('hex')
  .slice(0, 16);
export const CODEX_JOURNEY_ACCOUNT = CODEX_JOURNEY_FINGERPRINT;

export const seedCodexJourneyFixture = async (input: SeedWorkAttemptFixtureInput): Promise<void> => {
  const modePath = path.join(input.home, 'codex-fixture-mode');
  const logPath = path.join(input.home, 'codex-fixture-protocol.jsonl');
  await writeFile(modePath, 'success');
  // Reuse the adapter's tested fake protocol as data, with a visible pause for the browser lifecycle.
  const protocolPath = path.resolve(
    import.meta.dirname,
    '../../../packages/local-collectors/src/test-fixtures/fake-codex-review-app-server.ts',
  );
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
  const record = process.env[CODEX_JOURNEY_RECORD_ENV];
  if (record) {
    await writeFile(record, JSON.stringify({ home: input.home, modePath, logPath }), { mode: 0o600 });
  }
};
