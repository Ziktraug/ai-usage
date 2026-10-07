/**
 * Retry a command only when it failed because the Bun-hosted Vite dev server
 * stalled, never when a test genuinely failed.
 *
 * Two stall signatures are recognised, both independent per start:
 *
 * 1. The server never becomes ready (PR #48). The process parks in epoll_wait
 *    during Vite's startup and no wakeup arrives, so Playwright times out
 *    waiting for the URL. It costs roughly one Functional Browser run in
 *    eight, so a single retry takes that to about one in sixty -- without
 *    touching the runtime pin, which cannot move because Bun 1.4 trades this
 *    hang for a worse one under `turbo watch dev`.
 * 2. The server reports ready, then the SSR module runner's first `fetchModule`
 *    request never settles and Vite's in-process transport gives up after its
 *    60 s invoke timeout, so every document answers 500 (PR #60, 2026-10-07).
 *    On one unchanged tree in one unchanged environment, the demo job stalled
 *    twice on unrelated modules (a SvelteKit runtime file, then a usage-store
 *    file) and passed on the third start; eight local starts passed. The
 *    server-side `fetchModule` stays pending rather than failing, and its
 *    chain ends in a native threaded parse, which fits the same lost-wakeup
 *    family as the startup hang. The root cause is not identified.
 *
 * Each signature match is deliberately narrow and classified by name. A
 * blanket retry would paper over real regressions, which is the whole reason
 * flaky-test retries are usually a bad trade. The second signature requires
 * Vite's own transport error together with the `vite:invoke` / `fetchModule`
 * payload markers, so an application timeout, a Playwright assertion, or a
 * Playwright test timeout that merely says "timed out" exits immediately with
 * its own status. There is exactly one extra attempt.
 *
 * Usage: bun tools/retry-on-dev-server-hang.ts <command> [args...]
 */

export interface HangSignature {
  /** What the retry message says. */
  readonly description: string;
  /** All markers must appear on one output line. */
  readonly markers: readonly string[];
  /** Stable name for the job log and for tests. */
  readonly name: 'dev-server-startup' | 'module-runner-transport';
}

export const HANG_SIGNATURES: readonly HangSignature[] = [
  {
    description: 'Dev server never became ready (known Bun startup hang)',
    markers: ['Timed out waiting', 'config.webServer'],
    name: 'dev-server-startup',
  },
  {
    description: 'Vite module runner transport stalled after the dev server became ready (known Bun hang)',
    markers: ['transport invoke timed out after', '"event":"vite:invoke"', '"name":"fetchModule"'],
    name: 'module-runner-transport',
  },
];

export const MAX_ATTEMPTS = 2;

/** Classify one complete output line; `null` means it carries no hang signature. */
export const classifyHangLine = (line: string): HangSignature | null =>
  HANG_SIGNATURES.find((signature) => signature.markers.every((marker) => line.includes(marker))) ?? null;

/**
 * Feed stream chunks and classify complete lines. A signature can straddle
 * two chunks, so partial lines are carried over instead of scanned alone.
 */
export const createLineClassifier = (onSignature: (signature: HangSignature) => void) => {
  let partial = '';
  const scan = (line: string): void => {
    const signature = classifyHangLine(line);
    if (signature !== null) {
      onSignature(signature);
    }
  };
  return {
    flush(): void {
      if (partial.length > 0) {
        scan(partial);
        partial = '';
      }
    },
    push(text: string): void {
      const combined = partial + text;
      const lines = combined.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        scan(line);
      }
    },
  };
};

interface AttemptResult {
  readonly exitCode: number;
  readonly hangSignature: HangSignature | null;
}

const runAttempt = async (command: readonly string[]): Promise<AttemptResult> => {
  const child = Bun.spawn([...command], { stderr: 'pipe', stdin: 'inherit', stdout: 'pipe' });
  let hangSignature: HangSignature | null = null;
  const classifier = createLineClassifier((signature) => {
    hangSignature ??= signature;
  });
  // Forward output live so the job log stays readable, while scanning it for
  // the signature. Buffering until exit would hide progress on a 10-minute run.
  const forward = async (stream: ReadableStream<Uint8Array>, write: (text: string) => void): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      classifier.push(text);
      write(text);
    }
    classifier.push(decoder.decode());
    classifier.flush();
  };
  await Promise.all([
    forward(child.stdout, (text) => process.stdout.write(text)),
    forward(child.stderr, (text) => process.stderr.write(text)),
  ]);
  const exitCode = await child.exited;
  return { exitCode, hangSignature };
};

export const runWithRetry = async (command: readonly string[]): Promise<number> => {
  let lastExitCode = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { exitCode, hangSignature } = await runAttempt(command);
    lastExitCode = exitCode;
    if (exitCode === 0) {
      break;
    }
    if (hangSignature === null) {
      console.error(`\nFailed with no dev-server-hang signature; not retrying (attempt ${attempt}).`);
      break;
    }
    if (attempt < MAX_ATTEMPTS) {
      console.error(
        `\n${hangSignature.description} [${hangSignature.name}]. Retrying: attempt ${attempt + 1} of ${MAX_ATTEMPTS}.`,
      );
    } else {
      console.error(`\n${hangSignature.description} [${hangSignature.name}] on all ${MAX_ATTEMPTS} attempts; failing.`);
    }
  }
  return lastExitCode;
};

if (import.meta.main) {
  const command = process.argv.slice(2);
  if (command.length === 0) {
    throw new Error('Usage: retry-on-dev-server-hang.ts <command> [args...]');
  }
  process.exit(await runWithRetry(command));
}
