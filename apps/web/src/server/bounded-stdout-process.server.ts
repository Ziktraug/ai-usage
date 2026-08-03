import { spawn } from 'node:child_process';

export type BoundedStdoutProcessFailureKind = 'failed' | 'output-limit' | 'timed-out' | 'unavailable';

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

export const runBoundedStdoutProcess = async (options: BoundedStdoutProcessOptions): Promise<{ stdout: string }> => {
  options.signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: BoundedStdoutProcessError | null = null;
    let settled = false;
    let aborted: unknown;
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (result: { stdout: string } | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const abort = (): void => {
      const reason = options.signal?.reason;
      aborted = reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError');
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => {
      failure = new BoundedStdoutProcessError('timed-out');
      child.kill('SIGKILL');
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > options.maximumOutputBytes) {
        failure = new BoundedStdoutProcessError('output-limit');
        child.kill('SIGKILL');
        return;
      }
      chunks.push(buffer);
    });
    // Drain provider stderr but never retain or expose it.
    child.stderr.on('data', () => undefined);
    child.once('error', () => finish(new BoundedStdoutProcessError('unavailable')));
    child.once('close', (code) => {
      if (aborted instanceof Error) {
        finish(aborted);
      } else if (failure) {
        finish(failure);
      } else if (code === 0) {
        try {
          finish({ stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) });
        } catch {
          finish(new BoundedStdoutProcessError('failed'));
        }
      } else {
        finish(new BoundedStdoutProcessError('failed'));
      }
    });
  });
};
