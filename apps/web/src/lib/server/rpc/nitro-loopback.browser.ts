import { mkdtemp, rm } from 'node:fs/promises';
import { type IncomingHttpHeaders, request as requestHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { createWebRpcClient } from '../../rpc/client';

const PHASE_TIMEOUT_MS = 5000;
const PROOF_TIMEOUT_MS = 25_000;
const PRIVATE_PATH = '/private/history.db';
const environmentKeys = [
  'AI_USAGE_DATABASE_PATH',
  'AI_USAGE_HOME',
  'AI_USAGE_ROOT_DIR',
  'AI_USAGE_RPC_LOOPBACK_BUILD_DIR',
  'AI_USAGE_RPC_LOOPBACK_CACHE_DIR',
  'AI_USAGE_RPC_LOOPBACK_FIXTURE',
  'AI_USAGE_RPC_LOOPBACK_OUTPUT_DIR',
  'VITE_AI_USAGE_E2E',
] as const;

type CleanupTask = () => Promise<unknown> | unknown;
type RpcProcedure = (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;

interface HttpResult {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly status: number;
}

const fail = (message: string): never => {
  throw new Error(`V5 Nitro loopback fixture: ${message}`);
};

const assertEqual = <Value>(actual: Value, expected: Value, label: string): void => {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
};

const assert = (condition: boolean, label: string): void => {
  if (!condition) {
    fail(label);
  }
};

const bounded = async <Value>(
  operation: Promise<Value>,
  label: string,
  timeoutMs = PHASE_TIMEOUT_MS,
): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timeout);
  }
};

const runCleanupTasks = async (tasks: readonly CleanupTask[]): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const task of tasks) {
    const [result] = await Promise.allSettled([Promise.resolve().then(task)]);
    if (result.status === 'rejected') {
      errors.push(result.reason);
    }
  }
  return errors;
};

const httpRequest = async (
  url: URL,
  options: {
    readonly body?: Uint8Array | string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: string;
    readonly setHost?: boolean;
  } = {},
): Promise<HttpResult> =>
  await new Promise<HttpResult>((resolveRequest, rejectRequest) => {
    const request = requestHttp(
      url,
      {
        headers: options.headers,
        method: options.method,
        setHost: options.setHost,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        response.once('end', () => {
          request.destroy();
          resolveRequest({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
        response.once('error', rejectRequest);
      },
    );
    request.once('error', rejectRequest);
    request.end(options.body);
  });

const captureError = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return fail('expected an RPC error');
};

const errorProperty = (error: unknown, property: string): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, property) : undefined;

const clientFor = (origin: string, owner: string) =>
  createWebRpcClient({
    headers: {
      origin,
      'sec-fetch-site': 'same-origin',
      'x-ai-usage-request-owner': owner,
    },
    url: `${origin}/rpc`,
  });

const runProof = async (origin: string): Promise<void> => {
  const trustedHeaders = { origin, 'sec-fetch-site': 'same-origin' } as const;

  const smoke = await bounded(clientFor(origin, 'smoke').runtime.reportPerfEnabled({}), 'first Nitro RPC import');
  assertEqual(smoke, true, 'actual Nitro /rpc/** registration resolves its first dynamic handler import');

  const invalidQuota = (clientFor(origin, 'validation').quota.history as unknown as RpcProcedure)({
    unexpected: 'input',
  });
  const validationError = await bounded(captureError(invalidQuota), 'RPC input validation');
  assertEqual(errorProperty(validationError, 'code'), 'BAD_REQUEST', 'invalid contract input is typed');
  assert(!JSON.stringify(validationError).includes(PRIVATE_PATH), 'validation error is sanitized');

  const typedError = await bounded(
    captureError(clientFor(origin, 'private-error').report.revisionManifest({})),
    'typed RPC error',
  );
  assertEqual(errorProperty(typedError, 'code'), 'Unavailable', 'deep service failure keeps its public error family');
  assertEqual(
    errorProperty(typedError, 'message'),
    'The synthetic manifest is temporarily unavailable.',
    'deep service failure keeps its bounded public message',
  );
  assertEqual(JSON.stringify(errorProperty(typedError, 'data')), '{}', 'private error reason is removed');
  assert(!JSON.stringify(typedError).includes(PRIVATE_PATH), 'typed error never exposes a private path');

  const unknownLive = await bounded(
    fetch(`${origin}/rpc/private/secret`, { signal: AbortSignal.timeout(PHASE_TIMEOUT_MS) }),
    'live 404',
  );
  assertEqual(unknownLive.status, 404, 'unknown live RPC path is hidden');
  assertEqual((await unknownLive.json()).error.tag, 'NotFound', 'unknown live RPC path has the closed error family');

  const demoHeaders = { 'x-ai-usage-loopback-mode': 'demo' };
  const [knownDemo, unknownDemo] = await Promise.all([
    bounded(fetch(`${origin}/rpc/runtime/reportPerfEnabled`, { headers: demoHeaders }), 'known demo 404'),
    bounded(fetch(`${origin}/rpc/private/secret`, { headers: demoHeaders }), 'unknown demo 404'),
  ]);
  assertEqual(knownDemo.status, 404, 'known demo RPC is hidden');
  assertEqual(unknownDemo.status, 404, 'unknown demo RPC is hidden');
  assertEqual(await knownDemo.text(), '', 'known demo response is empty');
  assertEqual(await unknownDemo.text(), '', 'unknown demo response is uniformly empty');

  const missingHost = await bounded(
    httpRequest(new URL('/rpc/runtime/reportPerfEnabled', origin), { setHost: false }),
    'missing Host rejection',
  );
  assertEqual(missingHost.status, 400, 'missing Host is rejected');
  assert(!missingHost.body.includes(PRIVATE_PATH), 'HTTP-layer missing Host rejection is sanitized');

  const untrustedHost = await bounded(
    httpRequest(new URL('/rpc/runtime/reportPerfEnabled', origin), { headers: { host: 'example.com' } }),
    'untrusted Host rejection',
  );
  assertEqual(untrustedHost.status, 403, 'untrusted Host is rejected');
  assert(untrustedHost.body.includes('UntrustedHost'), 'untrusted Host uses the explicit policy error');

  const crossOrigin = await bounded(
    fetch(`${origin}/rpc/runtime/reportPerfEnabled`, {
      headers: { origin: 'http://example.com', 'sec-fetch-site': 'cross-site' },
    }),
    'cross-origin rejection',
  );
  assertEqual(crossOrigin.status, 403, 'cross-origin RPC is rejected');
  assert((await crossOrigin.text()).includes('CrossOriginRequest'), 'cross-origin RPC uses the explicit policy error');

  const missingCsrf = await bounded(
    fetch(`${origin}/rpc/projectGroup/save`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    'CSRF rejection',
  );
  assertEqual(missingCsrf.status, 403, 'mutation without origin proof is rejected');
  assert((await missingCsrf.text()).includes('CsrfRejected'), 'mutation exposes only the CSRF policy family');

  const trustedMutation = await bounded(
    fetch(`${origin}/rpc/projectGroup/save`, {
      body: '{}',
      headers: { ...trustedHeaders, 'content-type': 'application/json' },
      method: 'POST',
    }),
    'same-origin mutation',
  );
  assert(trustedMutation.status !== 403, 'same-origin mutation crosses CSRF policy before contract validation');

  const [alpha, beta] = await bounded(
    Promise.all([
      clientFor(origin, 'alpha').runtime.reportPerfEnabled({}),
      clientFor(origin, 'beta').runtime.reportPerfEnabled({}),
    ]),
    'concurrent request isolation',
  );
  assertEqual(alpha, true, 'alpha request retains its dependencies');
  assertEqual(beta, false, 'beta request retains its dependencies');

  const oversizedResponse = await bounded(
    fetch(`${origin}/rpc/report/revisionManifest`, {
      headers: { ...trustedHeaders, 'x-ai-usage-loopback-response': 'oversized' },
    }),
    'oversized response replacement',
  );
  assertEqual(oversizedResponse.status, 502, 'oversized RPC response is replaced');
  assertEqual(oversizedResponse.headers.get('x-private-path'), null, 'oversized response drops private headers');
  assertEqual(
    JSON.stringify(await oversizedResponse.json()),
    JSON.stringify({
      error: { message: 'The RPC response exceeded its byte limit.', tag: 'ResponseTooLarge' },
      ok: false,
    }),
    'oversized response uses the closed sanitized envelope',
  );
};

const repositoryDirectory = resolve(import.meta.dir, '../../../../../..');
const webDirectory = resolve(repositoryDirectory, 'apps/web');
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'ai-usage-v5-loopback-'));
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));
let proofError: unknown;
let server: ViteDevServer | undefined;

try {
  process.env.AI_USAGE_DATABASE_PATH = resolve(temporaryDirectory, 'state', 'usage.sqlite');
  process.env.AI_USAGE_HOME = resolve(temporaryDirectory, 'home');
  process.env.AI_USAGE_ROOT_DIR = resolve(temporaryDirectory, 'config');
  process.env.AI_USAGE_RPC_LOOPBACK_BUILD_DIR = resolve(temporaryDirectory, 'nitro-work');
  process.env.AI_USAGE_RPC_LOOPBACK_CACHE_DIR = resolve(temporaryDirectory, 'vite-cache');
  process.env.AI_USAGE_RPC_LOOPBACK_FIXTURE = '1';
  process.env.AI_USAGE_RPC_LOOPBACK_OUTPUT_DIR = resolve(temporaryDirectory, 'nitro-output');
  process.env.VITE_AI_USAGE_E2E = '1';

  server = await bounded(
    createServer({
      configFile: resolve(webDirectory, 'vite-rpc-loopback.config.ts'),
      root: webDirectory,
    }),
    'Nitro fixture creation',
  );
  await bounded(server.listen(), 'Nitro fixture listen');
  const address = server.httpServer?.address();
  const numericAddress =
    address !== null && address !== undefined && typeof address === 'object'
      ? address
      : fail('Nitro did not expose an ephemeral numeric-loopback port');
  assertEqual(numericAddress.address, '127.0.0.1', 'Nitro fixture binds numeric loopback only');
  await bounded(runProof(`http://127.0.0.1:${numericAddress.port}`), 'complete loopback proof', PROOF_TIMEOUT_MS);
} catch (error) {
  proofError = error;
}

const cleanupErrors = await runCleanupTasks([
  () => server?.close(),
  () => rm(temporaryDirectory, { force: true, recursive: true }),
]);
for (const [key, value] of previousEnvironment) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

if (proofError !== undefined || cleanupErrors.length > 0) {
  throw new AggregateError(
    proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors],
    'V5 Nitro loopback proof or cleanup failed.',
  );
}

console.log(
  'V5 Nitro loopback fixture passed: registration/import, validation/errors, policy, response bounds and request isolation.',
);
