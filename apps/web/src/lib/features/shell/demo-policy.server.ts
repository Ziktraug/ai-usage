import type { RuntimeMode } from '../../../runtime-mode';
import { rpcProcedureRequestPolicies } from '../../server/rpc/request-policy';
import { isManagementPath } from './navigation';

export type DemoRouteDecision = 'allow' | 'not-found' | 'redirect-report';

const protectedPaths = new Set([
  '/api/manual-merge/download',
  '/api/manual-merge/upload',
  '/api/source-control',
  '/api/source-control/command',
]);

// Only procedures declared `demo: 'synthetic-only'` in the contract are served by a demo: today the
// Work view's synthetic task service, which lives in the demo process's memory.
const demoRpcPaths: ReadonlySet<string> = new Set(
  rpcProcedureRequestPolicies.filter(({ demo }) => demo === 'synthetic-only').map(({ path }) => `/rpc${path}`),
);

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
