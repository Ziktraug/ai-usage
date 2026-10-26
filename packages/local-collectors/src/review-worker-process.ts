/**
 * The one way a review harness process is run (ADR 0053, 0055; delegation workers): no shell, the
 * caller's explicit environment only, `cwd` the admitted checkout, stdout read incrementally as
 * lines under a total byte cap, stderr discarded, stdin closed or fed one given string, a deadline
 * that sends SIGTERM then SIGKILL after a grace period, a heartbeat while the process lives, and a
 * `stop(reason)` that records why the engine ended it. The first recorded stop reason is the one
 * reported; nothing after it changes the verdict. A stop (a cancel, a shutdown, the deadline) that
 * arrives once the child has already exited on its own is ignored: the outcome of a process that
 * produced its final message and ended is the process's own, never relabelled by a late request.
 *
 * The helper knows nothing of the harness: the caller gives it each line and classifies the end.
 * A spawn failure is thrown as the runtime raised it; the caller names it without quoting the
 * argument vector (`spawnFailureDetail`).
 */
export type ProcessStopReason = 'cancel' | 'deadline' | 'overflow' | 'shutdown' | 'timeout';
/** The reasons a caller may give; `deadline` and `overflow` are the runner's own. */
export type ProcessStopRequest = Exclude<ProcessStopReason, 'deadline' | 'overflow'>;

export const TERMINATE_GRACE_MS = 5000;

export interface BoundedJsonlProcessSpec {
  readonly args: readonly string[];
  readonly cwd: string;
  /** Handed to the child as its whole environment; nothing else leaks in. */
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly heartbeatMs: number;
  readonly maxOutputBytes: number;
  /** Written to the child's stdin, then closed; `null` gives the child no stdin at all. */
  readonly stdin: string | null;
  readonly timeoutMs: number;
}

export interface BoundedJsonlProcessHandlers {
  readonly onHeartbeat?: (() => Promise<void> | void) | undefined;
  /** One stdout line without its newline, in order; awaited before the next line is handed over. */
  readonly onLine: (line: string) => Promise<void> | void;
}

export interface BoundedJsonlProcessEnd {
  /** What `exited` resolved to: the exit code, or 128 + the signal number when killed. */
  readonly exitCode: number | null;
  /** `null` when the process ended on its own; else the first reason this runner stopped it. */
  readonly stop: ProcessStopReason | null;
  readonly wallMs: number;
}

export interface BoundedJsonlProcess {
  readonly end: Promise<BoundedJsonlProcessEnd>;
  readonly pid: number;
  /** SIGTERM now, SIGKILL after the grace period; only the first call's reason is recorded. */
  readonly stop: (reason: ProcessStopRequest) => void;
}

/**
 * A spawn error by its class and code only. The runtime's own message quotes the offending
 * argument, which is the prompt (commit SHAs, subject, session title); a stored failure reason
 * must never carry it.
 */
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/u;

export const spawnFailureDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code = 'code' in error && typeof error.code === 'string' && ERROR_CODE.test(error.code) ? error.code : null;
  return code === null ? error.name : `${error.name} ${code}`;
};

export const spawnBoundedJsonlProcess = (
  spec: BoundedJsonlProcessSpec,
  handlers: BoundedJsonlProcessHandlers,
): BoundedJsonlProcess => {
  const child = Bun.spawn([spec.executable, ...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env },
    stderr: 'ignore',
    stdin: spec.stdin === null ? 'ignore' : Buffer.from(spec.stdin, 'utf8'),
    stdout: 'pipe',
  });
  const startedAt = performance.now();
  let stopReason: ProcessStopReason | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  /** The child ended on its own (an exit code or a signal the runner did not send), whether or not `end` has settled. */
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const stop = (reason: ProcessStopReason): void => {
    if (stopReason !== null || exited()) {
      return;
    }
    stopReason = reason;
    if (reason === 'overflow') {
      child.kill('SIGKILL');
      return;
    }
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, TERMINATE_GRACE_MS);
  };
  const deadline = setTimeout(() => stop('deadline'), spec.timeoutMs);
  const heartbeat = setInterval(() => {
    Promise.resolve(handlers.onHeartbeat?.()).catch(() => undefined);
  }, spec.heartbeatMs);

  const end = (async (): Promise<BoundedJsonlProcessEnd> => {
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    let overflow = false;
    try {
      const stdout = child.stdout;
      if (stdout instanceof ReadableStream) {
        for await (const chunk of stdout) {
          bytes += chunk.byteLength;
          if (bytes > spec.maxOutputBytes) {
            overflow = true;
            stop('overflow');
            break;
          }
          pending += decoder.decode(chunk, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            await handlers.onLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
          }
        }
        if (!overflow && pending.length > 0) {
          await handlers.onLine(pending);
        }
      }
    } catch {
      // A broken pipe after the process died is settled below by the exit code.
    }
    const exitCode = await child.exited;
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    return { exitCode, stop: stopReason, wallMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  })();

  return { end, pid: child.pid, stop };
};
