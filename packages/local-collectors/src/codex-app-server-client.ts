import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { boundedProcessEnvironment } from '@ai-usage/local-machine/bounded-process';
import { isRecord } from '@ai-usage/report-core/datasets';

/** One stdio transport for account, quota and owned reviews. No credentials are read by AI Usage. */
export interface CodexAppServerOptions {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maximumOutputBytes?: number;
  readonly timeoutMs?: number;
}

export class CodexAppServerError extends Error {
  readonly kind: 'unavailable' | 'protocol' | 'timeout' | 'output-limit' | 'closed';
  constructor(kind: CodexAppServerError['kind'], message: string) {
    super(message);
    this.name = 'CodexAppServerError';
    this.kind = kind;
  }
}

export interface CodexAppServerClient {
  readonly args: readonly string[];
  readonly closed: Promise<void>;
  readonly pid: number;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly stop: () => Promise<void>;
  readonly subscribe: (listener: (method: string, params: unknown) => void) => () => void;
}

/** Keep the same selected home and command for every Codex operation; API credentials are excluded. */
export const codexProcessEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> =>
  boundedProcessEnvironment(source.CODEX_HOME ? { CODEX_HOME: source.CODEX_HOME } : {}, source);

/** Resolve before changing cwd: a relative executable must never switch identity in the checkout. */
export const resolveCodexCommand = (options: Pick<CodexAppServerOptions, 'command' | 'env'> = {}): string => {
  const command = options.command ?? (options.env ?? process.env).AI_USAGE_CODEX_EXECUTABLE ?? 'codex';
  if (command.includes('/') && !path.isAbsolute(command)) {
    throw new CodexAppServerError('unavailable', 'Codex executable must be absolute or a name on PATH');
  }
  const executable = Bun.which(command, { PATH: codexProcessEnvironment(options.env).PATH ?? '' });
  if (executable === null) {
    throw new CodexAppServerError('unavailable', 'Codex executable is unavailable on the bounded PATH');
  }
  return executable;
};

export const openCodexAppServer = async (options: CodexAppServerOptions = {}): Promise<CodexAppServerClient> => {
  const env = codexProcessEnvironment(options.env);
  const command = resolveCodexCommand(options);
  const args = options.args ?? ['app-server', '--stdio'];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const listeners = new Set<(method: string, params: unknown) => void>();
  let nextId = 1;
  let failure: CodexAppServerError | null = null;
  let buffered = Buffer.alloc(0);
  let bytes = 0;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, [...args], { cwd: options.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    throw new CodexAppServerError('unavailable', 'Codex app-server could not start');
  }
  const fail = (error: CodexAppServerError): void => {
    failure ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      fail(new CodexAppServerError('closed', 'Codex app-server contact ended'));
      resolve();
    });
  });
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const terminateFailedProcess = (): void => {
    child.kill('SIGTERM');
    forceStop ??= setTimeout(() => child.kill('SIGKILL'), 1000);
  };
  closed.then(() => clearTimeout(forceStop));
  child.on('error', () => fail(new CodexAppServerError('unavailable', 'Codex app-server could not start')));
  child.stdin.on('error', () => fail(new CodexAppServerError('closed', 'Codex app-server input closed')));
  child.stderr.on('data', () => undefined);
  const write = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure !== null) {
      return;
    }
    bytes += chunk.byteLength;
    if (bytes > (options.maximumOutputBytes ?? 2 * 1024 * 1024)) {
      fail(new CodexAppServerError('output-limit', 'Codex app-server output limit reached'));
      terminateFailedProcess();
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    let end = buffered.indexOf(10);
    while (end >= 0 && failure === null) {
      const line = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      } catch {
        fail(new CodexAppServerError('protocol', 'Codex app-server returned invalid JSON'));
        terminateFailedProcess();
        return;
      }
      if (!isRecord(message)) {
        fail(new CodexAppServerError('protocol', 'Codex app-server returned an invalid message'));
        terminateFailedProcess();
        return;
      }
      if (typeof message.method === 'string') {
        // A review never grants approval, supplies credentials, or executes client-side tools.
        if (message.id !== undefined) {
          write({ id: message.id, error: { code: -32_000, message: 'AI Usage does not authorize runtime requests' } });
        }
        for (const listener of listeners) {
          listener(message.method, message.params);
        }
      } else if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (entry !== undefined) {
          clearTimeout(entry.timer);
          pending.delete(message.id);
          if (message.error === undefined) {
            entry.resolve(message.result);
          } else {
            entry.reject(new CodexAppServerError('protocol', 'Codex app-server refused the requested operation'));
          }
        }
      }
      end = buffered.indexOf(10);
    }
  });
  const stop = async (): Promise<void> => {
    child.stdin.end();
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (failure !== null) {
        reject(failure);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodexAppServerError('timeout', `Codex app-server ${method} timed out`));
      }, options.timeoutMs ?? 15_000);
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  try {
    await request('initialize', { clientInfo: { name: 'ai-usage', version: '0.1.0' }, capabilities: null });
    write({ method: 'initialized' });
    if (child.pid === undefined) {
      throw new CodexAppServerError('unavailable', 'Codex app-server has no process identity');
    }
    return {
      args,
      closed,
      pid: child.pid,
      request,
      stop,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

export interface CodexAccountObservation {
  readonly accountFingerprint: string | null;
  readonly authMethod: 'chatgpt' | 'api-key' | null;
  readonly authState: 'logged-in' | 'logged-out' | 'unknown';
  readonly evidence: string;
  readonly quota: unknown;
}

/** Hash account and quota identity together, with no raw identifier retained or logged. */
export const codexAccountFingerprint = (account: unknown, quota: unknown): string | null => {
  if (!(isRecord(account) && account.type === 'chatgpt' && isRecord(quota))) {
    return null;
  }
  const email = typeof account.email === 'string' ? account.email.trim().toLowerCase() : '';
  const accountId = typeof quota.accountId === 'string' ? quota.accountId.trim() : '';
  if (!(email && accountId) || email.length > 512 || accountId.length > 512) {
    return null;
  }
  return createHash('sha256').update(`ai-usage codex account v1\n${accountId}\n${email}`).digest('hex').slice(0, 16);
};

export const readCodexAccount = async (client: CodexAppServerClient): Promise<CodexAccountObservation> => {
  const response = await client.request('account/read', { refreshToken: false });
  const account = isRecord(response) ? response.account : undefined;
  if (account === null) {
    return {
      accountFingerprint: null,
      authMethod: null,
      authState: 'logged-out',
      evidence: 'Codex app-server account/read: signed out',
      quota: null,
    };
  }
  if (!isRecord(account)) {
    throw new CodexAppServerError('protocol', 'Codex account response is invalid');
  }
  if (account.type !== 'chatgpt') {
    return {
      accountFingerprint: null,
      authMethod: account.type === 'apiKey' ? 'api-key' : null,
      authState: 'logged-in',
      evidence: 'Codex account/read: subscription authentication not established',
      quota: null,
    };
  }
  const quota = await client.request('account/rateLimits/read', {});
  return {
    accountFingerprint: codexAccountFingerprint(account, quota),
    authMethod: 'chatgpt',
    authState: 'logged-in',
    evidence: 'Codex app-server account/read and account/rateLimits/read: ChatGPT',
    quota,
  };
};

export const probeCodexAccount = async (options: CodexAppServerOptions = {}): Promise<CodexAccountObservation> => {
  const client = await openCodexAppServer(options);
  try {
    return await readCodexAccount(client);
  } finally {
    await client.stop();
  }
};
