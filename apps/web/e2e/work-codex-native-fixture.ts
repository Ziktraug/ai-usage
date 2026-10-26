import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SeedWorkAttemptFixtureInput } from './work-attempt-fixture';

export const CODEX_NATIVE_ENV = 'AI_USAGE_CODEX_NATIVE_REFUSAL';
export const CODEX_NATIVE_RECORD_ENV = 'AI_USAGE_CODEX_NATIVE_RECORD';

/** Real CLI metadata with its existing auth; disposable AI Usage store/target, no generation allowed. */
export const seedCodexNativeRefusalFixture = async (input: SeedWorkAttemptFixtureInput): Promise<void> => {
  const binary = process.env.AI_USAGE_NATIVE_CODEX_BINARY;
  const nativeHome = process.env.AI_USAGE_NATIVE_CODEX_HOME;
  const record = process.env[CODEX_NATIVE_RECORD_ENV];
  const model = process.env.AI_USAGE_NATIVE_CODEX_MODEL;
  const effort = process.env.AI_USAGE_NATIVE_CODEX_EFFORT;
  if (!(binary && nativeHome && record && model && effort && path.isAbsolute(binary) && path.isAbsolute(nativeHome))) {
    throw new Error('Native refusal requires explicit real Codex binary/home and disposable record path');
  }
  const logPath = path.join(input.home, 'native-codex-methods.jsonl');
  const proxyPath = path.join(input.fixtureBinDirectory, 'codex');
  await writeFile(
    proxyPath,
    `#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { env: { ...process.env, CODEX_HOME: ${JSON.stringify(nativeHome)} }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end = buffer.indexOf('\\n');
  while (end >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: message.method ?? null }) + '\\n');
    if (message.method === 'thread/start' || message.method === 'turn/start') { child.kill(); process.exit(93); }
    child.stdin.write(line + '\\n'); end = buffer.indexOf('\\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
`,
  );
  await chmod(proxyPath, 0o700);
  const configPath = path.join(input.home, '.config', 'ai-usage', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.routing.executors = [
    {
      accountScope: 'native-subscription',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: input.epoch.toISOString(),
      effort,
      harness: 'codex',
      model,
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }],
    },
  ];
  config.sourcePolicies['codex.sessions'] = { enabled: false };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(record, JSON.stringify({ configPath, logPath, binary, nativeHome }), { mode: 0o600 });
};
