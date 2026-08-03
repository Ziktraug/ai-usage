import type { RuntimeMode } from '../../../runtime-mode';
import { isManagementPath } from './navigation';

export type DemoRouteDecision = 'allow' | 'not-found' | 'redirect-report';

const protectedPaths = new Set([
  '/api/manual-merge/download',
  '/api/manual-merge/upload',
  '/api/source-control',
  '/api/source-control/command',
]);

export const demoRouteDecision = (pathname: string, mode: RuntimeMode): DemoRouteDecision => {
  if (mode !== 'demo') {
    return 'allow';
  }
  if (pathname === '/rpc' || pathname.startsWith('/rpc/') || protectedPaths.has(pathname)) {
    return 'not-found';
  }
  return isManagementPath(pathname) ? 'redirect-report' : 'allow';
};
