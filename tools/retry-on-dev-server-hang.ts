/**
 * Retry a command only when it failed because the dev server never became
 * ready, never when a test genuinely failed.
 *
 * The hang is a Bun runtime defect (see PR #48): the server process parks in
 * epoll_wait during Vite's startup and no wakeup arrives, so Playwright times
 * out waiting for the URL. It is independent per start and costs roughly one
 * Functional Browser run in eight, so a single retry takes that to about one
 * in sixty -- without touching the runtime pin, which cannot move because Bun
 * 1.4 trades this hang for a worse one under `turbo watch dev`.
 *
 * The signature match is deliberately narrow. A blanket retry would paper over
 * real regressions, which is the whole reason flaky-test retries are usually a
 * bad trade; this one only fires on a message Playwright emits when the server
 * never answered, and a run that fails any other way exits immediately with
 * its own status.
 *
 * Usage: bun tools/retry-on-dev-server-hang.ts <command> [args...]
 */
const HANG_SIGNATURES = ['Timed out waiting', 'config.webServer'] as const;
const MAX_ATTEMPTS = 2;

const command = process.argv.slice(2);
if (command.length === 0) {
  throw new Error('Usage: retry-on-dev-server-hang.ts <command> [args...]');
}

interface AttemptResult {
  readonly exitCode: number;
  readonly sawHangSignature: boolean;
}

const runAttempt = async (): Promise<AttemptResult> => {
  const child = Bun.spawn(command, { stderr: 'pipe', stdin: 'inherit', stdout: 'pipe' });
  let sawHangSignature = false;
  // Forward output live so the job log stays readable, while scanning it for
  // the signature. Buffering until exit would hide progress on a 10-minute run.
  const forward = async (stream: ReadableStream<Uint8Array>, sink: typeof process.stdout): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (HANG_SIGNATURES.every((signature) => text.includes(signature))) {
        sawHangSignature = true;
      }
      sink.write(text);
    }
  };
  await Promise.all([forward(child.stdout, process.stdout), forward(child.stderr, process.stderr)]);
  const exitCode = await child.exited;
  return { exitCode, sawHangSignature };
};

let lastExitCode = 0;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const { exitCode, sawHangSignature } = await runAttempt();
  lastExitCode = exitCode;
  if (exitCode === 0) {
    break;
  }
  if (!sawHangSignature) {
    console.error(`\nFailed with no dev-server-hang signature; not retrying (attempt ${attempt}).`);
    break;
  }
  if (attempt < MAX_ATTEMPTS) {
    console.error(
      `\nDev server never became ready (known Bun startup hang). Retrying: attempt ${attempt + 1} of ${MAX_ATTEMPTS}.`,
    );
  } else {
    console.error(`\nDev server never became ready on all ${MAX_ATTEMPTS} attempts; failing.`);
  }
}

process.exit(lastExitCode);
