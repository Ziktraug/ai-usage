import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { normalizeCodexAppServerQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Data, Effect } from 'effect';
import type { ProviderQuotaBatch, ProviderQuotaBatchSource, ProviderQuotaCollectRequest } from './provider-quota';

const INITIALIZE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;
const MAXIMUM_LINE_BYTES = 1024 * 1024;
const MAXIMUM_STDERR_BYTES = 64 * 1024;

export type CodexQuotaCollectionErrorReason =
  | 'unsupported'
  | 'timeout'
  | 'auth-required'
  | 'protocol'
  | 'malformed-result'
  | 'empty-limits'
  | 'aborted';

export class CodexQuotaCollectionError extends Data.TaggedError('CodexQuotaCollectionError')<{
  readonly message: string;
  readonly reason: CodexQuotaCollectionErrorReason;
  readonly stderrTail?: string;
}> {}

export interface CodexAppServerSourceOptions {
  args?: string[];
  command?: string;
  timeoutMs?: number;
}

const boundedTail = (current: string, chunk: string, maximumBytes: number): string => {
  const combined = `${current}${chunk}`;
  const encoded = Buffer.from(combined);
  return encoded.byteLength <= maximumBytes
    ? combined
    : encoded.subarray(encoded.byteLength - maximumBytes).toString('utf8');
};

const collectionError = (
  reason: CodexQuotaCollectionErrorReason,
  message: string,
  stderrTail = '',
): CodexQuotaCollectionError =>
  new CodexQuotaCollectionError({
    message,
    reason,
    ...(stderrTail.trim() ? { stderrTail } : {}),
  });

const rpcErrorReason = (error: unknown): CodexQuotaCollectionErrorReason => {
  if (typeof error === 'object' && error !== null) {
    const message = String((error as Record<string, unknown>).message ?? '').toLowerCase();
    if (
      message.includes('login') ||
      message.includes('logged in') ||
      message.includes('auth') ||
      message.includes('unauthorized')
    ) {
      return 'auth-required';
    }
  }
  return 'protocol';
};

const writeMessage = (child: ChildProcessWithoutNullStreams, value: unknown): void => {
  child.stdin.write(`${JSON.stringify(value)}\n`);
};

const collectFromProcess = async (
  request: ProviderQuotaCollectRequest,
  options: Required<CodexAppServerSourceOptions>,
): Promise<ProviderQuotaBatch> => {
  if (request.signal?.aborted) {
    throw collectionError('aborted', 'Codex app-server quota read was aborted');
  }
  const child = spawn(options.command, options.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrTail = '';
  let stdoutBuffer = Buffer.alloc(0);
  let initialized = false;
  let settled = false;

  const response = new Promise<ProviderQuotaBatch>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      if (child.exitCode === null) {
        child.kill();
      }
      rejectWith(collectionError('aborted', 'Codex app-server quota read was aborted', stderrTail));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      run();
    };
    const rejectWith = (error: CodexQuotaCollectionError): void => finish(() => reject(error));
    timer = setTimeout(
      () => rejectWith(collectionError('timeout', 'Codex app-server quota read timed out', stderrTail)),
      options.timeoutMs,
    );
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'ENOENT' ? 'unsupported' : 'protocol';
      rejectWith(
        collectionError(
          reason,
          reason === 'unsupported' ? 'Codex CLI is not installed' : 'Codex app-server failed to start',
        ),
      );
    });
    child.on('close', () => {
      if (!settled) {
        rejectWith(collectionError('protocol', 'Codex app-server exited before returning quota limits', stderrTail));
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = boundedTail(stderrTail, chunk.toString(), MAXIMUM_STDERR_BYTES);
    });

    const handleMessage = (message: unknown): void => {
      if (!(typeof message === 'object' && message !== null)) {
        return;
      }
      const record = message as Record<string, unknown>;
      if (record.id === INITIALIZE_REQUEST_ID) {
        if (record.error) {
          rejectWith(collectionError('protocol', 'Codex app-server rejected initialization', stderrTail));
          return;
        }
        initialized = true;
        writeMessage(child, { method: 'initialized' });
        writeMessage(child, { id: RATE_LIMITS_REQUEST_ID, method: 'account/rateLimits/read', params: {} });
        return;
      }
      if (record.id !== RATE_LIMITS_REQUEST_ID) {
        return;
      }
      if (!initialized) {
        rejectWith(
          collectionError('protocol', 'Codex app-server returned quota limits before initialization', stderrTail),
        );
        return;
      }
      if (record.error) {
        const reason = rpcErrorReason(record.error);
        rejectWith(
          collectionError(
            reason,
            reason === 'auth-required' ? 'Codex authentication is required' : 'Codex app-server quota request failed',
            stderrTail,
          ),
        );
        return;
      }
      const observation = normalizeCodexAppServerQuotaObservation({
        ...(request.accountScope === undefined ? {} : { accountScope: request.accountScope }),
        machineId: request.machineId,
        ...(request.machineLabel === undefined ? {} : { machineLabel: request.machineLabel }),
        observedAt: request.observedAt ?? new Date(),
        result: record.result,
      });
      if (!observation) {
        rejectWith(
          collectionError('malformed-result', 'Codex app-server returned an invalid quota result', stderrTail),
        );
        return;
      }
      if (observation.windows.length === 0) {
        rejectWith(collectionError('empty-limits', 'Codex app-server returned no quota windows', stderrTail));
        return;
      }
      finish(() => resolve({ checkpoints: [], hasMore: false, observations: [observation], sourceEvents: [] }));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      if (stdoutBuffer.byteLength > MAXIMUM_LINE_BYTES && !stdoutBuffer.includes(10)) {
        rejectWith(collectionError('protocol', 'Codex app-server emitted an oversized protocol line', stderrTail));
        return;
      }
      let lineEnd = stdoutBuffer.indexOf(10);
      while (lineEnd >= 0 && !settled) {
        const line = stdoutBuffer.subarray(0, lineEnd);
        stdoutBuffer = stdoutBuffer.subarray(lineEnd + 1);
        if (line.byteLength > MAXIMUM_LINE_BYTES) {
          rejectWith(collectionError('protocol', 'Codex app-server emitted an oversized protocol line', stderrTail));
          return;
        }
        if (line.byteLength > 0) {
          try {
            handleMessage(JSON.parse(line.toString('utf8')) as unknown);
          } catch {
            rejectWith(collectionError('protocol', 'Codex app-server emitted malformed JSON', stderrTail));
            return;
          }
        }
        lineEnd = stdoutBuffer.indexOf(10);
      }
    });

    writeMessage(child, {
      id: INITIALIZE_REQUEST_ID,
      method: 'initialize',
      params: {
        capabilities: null,
        clientInfo: { name: 'ai-usage', title: 'ai-usage', version: '0.1.0' },
      },
    });
  });

  try {
    return await response;
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill();
    }
  }
};

export const createCodexAppServerBatchSource = (
  options: CodexAppServerSourceOptions = {},
): ProviderQuotaBatchSource<CodexQuotaCollectionError> => {
  const resolved: Required<CodexAppServerSourceOptions> = {
    args: options.args ?? ['app-server', '--stdio'],
    command: options.command ?? 'codex',
    timeoutMs: options.timeoutMs ?? 10_000,
  };
  return {
    collect: (request) =>
      Effect.tryPromise({
        try: () => collectFromProcess(request, resolved),
        catch: (cause) =>
          cause instanceof CodexQuotaCollectionError
            ? cause
            : collectionError('protocol', 'Codex app-server quota collection failed'),
      }),
  };
};
