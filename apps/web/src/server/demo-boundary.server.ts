import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';

const RPC_PREFIX = '/rpc/';
const PROTECTED_HTTP_PATHS = new Set([
  '/api/manual-merge/download',
  '/api/manual-merge/upload',
  '/api/source-control',
  '/api/source-control/command',
]);

export const demoNotFoundResponse = (): Response =>
  new Response(null, {
    headers: { 'cache-control': 'no-store' },
    status: 404,
  });

const isProtectedDemoRequest = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(RPC_PREFIX) || PROTECTED_HTTP_PATHS.has(pathname);
};

export const rejectProtectedDemoRequest = (
  request: Request,
  mode: RuntimeMode = getServerRuntimeMode(),
): Response | null => (mode === 'demo' && isProtectedDemoRequest(request) ? demoNotFoundResponse() : null);

export const runOutsideDemo = async <Result>(
  operation: () => Promise<Result> | Result,
  mode: RuntimeMode = getServerRuntimeMode(),
): Promise<Result | Response> => (mode === 'demo' ? demoNotFoundResponse() : await operation());

export const assertOutsideDemo = (mode: RuntimeMode = getServerRuntimeMode()): void => {
  if (mode === 'demo') {
    throw demoNotFoundResponse();
  }
};
