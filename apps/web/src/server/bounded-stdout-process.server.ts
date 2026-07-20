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
  shell: false;
  timeoutMs: number;
}

export const runBoundedStdoutProcess = (options: BoundedStdoutProcessOptions): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: BoundedStdoutProcessError | null = null;
    let settled = false;
    const finish = (result: { stdout: string } | BoundedStdoutProcessError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (result instanceof BoundedStdoutProcessError) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const timeout = setTimeout(() => {
      failure = new BoundedStdoutProcessError('timed-out');
      child.kill('SIGKILL');
    }, options.timeoutMs);
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
      if (failure) {
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
