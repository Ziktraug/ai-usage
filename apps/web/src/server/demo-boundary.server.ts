import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';

const SERVER_FUNCTION_PREFIX = '/_serverFn/';
const SOURCE_CONTROL_PATHS = new Set(['/api/source-control', '/api/source-control/command']);

export const demoNotFoundResponse = (): Response =>
  new Response(null, {
    headers: { 'cache-control': 'no-store' },
    status: 404,
  });

const isProtectedDemoRequest = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return (
    pathname.startsWith(SERVER_FUNCTION_PREFIX) ||
    SOURCE_CONTROL_PATHS.has(pathname) ||
    (pathname === '/sync' && request.method === 'POST')
  );
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
