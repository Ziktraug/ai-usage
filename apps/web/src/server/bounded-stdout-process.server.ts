import {
  BoundedProcessError,
  type BoundedProcessFailureKind,
  executeBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';

export type BoundedStdoutProcessFailureKind = BoundedProcessFailureKind;

export class BoundedStdoutProcessError extends Error {
  readonly kind: BoundedStdoutProcessFailureKind;

  constructor(kind: BoundedStdoutProcessFailureKind) {
    super(`Bounded process ${kind}`);
    this.name = 'BoundedStdoutProcessError';
    this.kind = kind;
  }
}

export interface BoundedStdoutProcessOptions {
  args: readonly string[];
  command: string;
  maximumOutputBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

/**
 * The web server's view of the shared bounded runner (`@ai-usage/local-machine/bounded-process`):
 * a successful read is exit code 0 and stdout; any other exit is `failed`. The shared runner owns
 * the environment allow-list, the deadline, the output ceiling and the stderr discipline.
 */
export const runBoundedStdoutProcess = async (options: BoundedStdoutProcessOptions): Promise<{ stdout: string }> => {
  options.signal?.throwIfAborted();
  let result: Awaited<ReturnType<typeof executeBoundedProcess>>;
  try {
    result = await executeBoundedProcess({
      args: options.args,
      command: options.command,
      maximumOutputBytes: options.maximumOutputBytes,
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      throw new BoundedStdoutProcessError(error.kind);
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new BoundedStdoutProcessError('failed');
  }
  return { stdout: result.stdout };
};
