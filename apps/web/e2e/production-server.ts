import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SESSION_COUNT = 205;
const rootDirectory = path.resolve(import.meta.dirname, '../../..');
const temporaryHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-production-browser-'));
const sessionsDirectory = path.join(temporaryHome, '.codex/sessions/2026');

const sessionEntries = Array.from({ length: SESSION_COUNT }, (_, index) => {
  const sessionNumber = String(index + 1).padStart(3, '0');
  const sessionId = `production-browser-${sessionNumber}`;
  return {
    index,
    sessionId,
    sessionNumber,
  };
});

const writeFixture = async (): Promise<void> => {
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(
    path.join(temporaryHome, '.codex/session_index.jsonl'),
    `${sessionEntries
      .map(({ sessionId, sessionNumber }) =>
        JSON.stringify({ id: sessionId, thread_name: `Production browser session ${sessionNumber}` }),
      )
      .join('\n')}\n`,
  );
  await Promise.all(
    sessionEntries.map(async ({ index, sessionId }) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      const hour = String(index % 24).padStart(2, '0');
      const entries = [
        {
          payload: { cwd: `/work/production-project-${index % 5}`, id: sessionId },
          timestamp: `2026-06-${day}T${hour}:00:00.000Z`,
          type: 'session_meta',
        },
        {
          payload: { model: 'gpt-5.3-codex' },
          timestamp: `2026-06-${day}T${hour}:01:00.000Z`,
          type: 'turn_context',
        },
        {
          payload: {
            content: [{ input_text: `Verify production query ${index + 1}` }],
            role: 'user',
            type: 'message',
          },
          timestamp: `2026-06-${day}T${hour}:02:00.000Z`,
        },
        {
          payload: {
            info: {
              total_token_usage: {
                cached_input_tokens: index,
                input_tokens: 100 + index,
                output_tokens: 20 + index,
                total_tokens: 120 + index * 3,
              },
            },
            type: 'token_count',
          },
          timestamp: `2026-06-${day}T${hour}:03:00.000Z`,
        },
      ];
      await writeFile(
        path.join(sessionsDirectory, `${sessionId}.jsonl`),
        `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      );
    }),
  );
};

const cleanupHome = (): void => {
  rmSync(temporaryHome, { force: true, recursive: true });
};

try {
  await writeFixture();
  const child = Bun.spawn(['bun', 'run', '--cwd', 'apps/web', 'start'], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      AI_USAGE_ROOT_DIR: rootDirectory,
      HOME: temporaryHome,
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '4175',
      PORT: '4175',
      TZ: 'Europe/Paris',
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
      }, 3000);
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
}
