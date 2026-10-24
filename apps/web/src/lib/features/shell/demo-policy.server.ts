import type { RuntimeMode } from '../../../runtime-mode';
import { isManagementPath } from './navigation';

export type DemoRouteDecision = 'allow' | 'not-found' | 'redirect-report';

const protectedPaths = new Set([
  '/api/manual-merge/download',
  '/api/manual-merge/upload',
  '/api/source-control',
  '/api/source-control/command',
]);

// The Work view's synthetic task service lives in the demo process's memory: its three procedures
// are the only RPC transport a demo serves.
const demoRpcPaths = new Set(['/rpc/workThreads/list', '/rpc/workThreads/detail', '/rpc/workThreads/command']);

export const demoRouteDecision = (pathname: string, mode: RuntimeMode): DemoRouteDecision => {
  if (mode !== 'demo') {
    return 'allow';
  }
  if (demoRpcPaths.has(pathname)) {
    return 'allow';
  }
  if (pathname === '/rpc' || pathname.startsWith('/rpc/') || protectedPaths.has(pathname)) {
    return 'not-found';
  }
  return isManagementPath(pathname) ? 'redirect-report' : 'allow';
};
