import type { Page, Request } from '@playwright/test';
import { isRpcPathname } from './rpc-test-transport';

const ROUTE_DATA_SUFFIX = '/__data.json';
const REQUEST_OWNER_HEADER = 'x-ai-usage-request-owner';

const RPC_OPERATIONS = {
  '/rpc/campaign/labelOverrides': 'campaign.labelOverrides',
  '/rpc/campaign/setLabelOverride': 'campaign.setLabelOverride',
  '/rpc/projectGroup/save': 'projectGroup.save',
  '/rpc/quota/history': 'quota.history',
  '/rpc/replication/status': 'replication.status',
  '/rpc/report/focusedBreakdown': 'report.focusedBreakdown',
  '/rpc/report/focusedOverview': 'report.focusedOverview',
  '/rpc/report/focusedSupport': 'report.focusedSupport',
  '/rpc/report/revisionBootstrap': 'report.revisionBootstrap',
  '/rpc/report/revisionManifest': 'report.revisionManifest',
  '/rpc/runtime/reportPerfEnabled': 'runtime.reportPerfEnabled',
  '/rpc/session/campaign-children': 'session.campaignChildren',
  '/rpc/session/detail': 'session.detail',
  '/rpc/session/neighbors': 'session.neighbors',
  '/rpc/session/page': 'session.page',
  '/rpc/session/vcs': 'session.vcs',
  '/rpc/skills': 'skills.snapshot',
  '/rpc/skills/createTargetDirectory': 'skills.createTargetDirectory',
  '/rpc/skills/knownProjectPaths': 'skills.knownProjectPaths',
  '/rpc/skills/managedMarkdown': 'skills.managedMarkdown',
  '/rpc/skills/observations': 'skills.observations',
  '/rpc/skills/previewReconcileAll': 'skills.previewReconcileAll',
  '/rpc/skills/projectInventories': 'skills.projectInventories',
  '/rpc/skills/projectMarkdown': 'skills.projectMarkdown',
  '/rpc/skills/reconcileAll': 'skills.reconcileAll',
  '/rpc/skills/reconcileOne': 'skills.reconcileOne',
  '/rpc/skills/refreshSnapshot': 'skills.refreshSnapshot',
  '/rpc/skills/saveConfig': 'skills.saveConfig',
  '/rpc/skills/saveManagedMarkdown': 'skills.saveManagedMarkdown',
  '/rpc/skills/snapshot': 'skills.snapshot',
  '/rpc/skills/toggleProjection': 'skills.toggleProjection',
  '/rpc/skills/config': 'skills.saveConfig',
  '/rpc/skills/inventories': 'skills.projectInventories',
  '/rpc/skills/known-paths': 'skills.knownProjectPaths',
  '/rpc/skills/markdown': 'skills.saveManagedMarkdown',
  '/rpc/skills/markdown/read': 'skills.managedMarkdown',
  '/rpc/skills/project-markdown': 'skills.projectMarkdown',
  '/rpc/skills/reconcile': 'skills.reconcileAll',
  '/rpc/skills/reconcile/preview': 'skills.previewReconcileAll',
  '/rpc/skills/refresh': 'skills.refreshSnapshot',
  '/rpc/skills/targets': 'skills.createTargetDirectory',
  '/rpc/skills/toggle': 'skills.toggleProjection',
  '/rpc/sync/fleet': 'sync.fleet',
} as const satisfies Readonly<Record<string, string>>;

export type RpcOperation = (typeof RPC_OPERATIONS)[keyof typeof RPC_OPERATIONS];

export interface ServerStateRequestRecord {
  readonly method: string;
  readonly operation?: RpcOperation;
  readonly owner?: string;
  readonly pathname: string;
  readonly resourceType: string;
  readonly url: string;
}

export interface ServerStateRequestCounts {
  readonly operations: Readonly<Record<string, number>>;
  readonly owners: Readonly<Record<string, number>>;
  readonly routeData: number;
  readonly totalRpc: number;
}

const sortedCounts = (values: readonly string[]): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
};

export const rpcOperationForPathname = (pathname: string): RpcOperation | undefined => {
  if (!isRpcPathname(pathname)) {
    return;
  }
  const operation =
    RPC_OPERATIONS[pathname as keyof typeof RPC_OPERATIONS] ??
    (pathname.startsWith('/rpc/skills/reconcile/') ? 'skills.reconcileOne' : undefined);
  if (operation === undefined) {
    throw new Error(`Unmapped browser oRPC procedure path: ${pathname}`);
  }
  return operation;
};

export const summarizeServerStateRequests = (
  records: readonly ServerStateRequestRecord[],
): ServerStateRequestCounts => {
  const rpcRecords = records.filter(({ operation }) => operation !== undefined);
  return {
    operations: sortedCounts(rpcRecords.map(({ operation }) => operation ?? 'unmapped')),
    owners: sortedCounts(rpcRecords.map(({ owner }) => owner ?? 'unowned')),
    routeData: records.filter(({ pathname }) => pathname.endsWith(ROUTE_DATA_SUFFIX)).length,
    totalRpc: rpcRecords.length,
  };
};

const recordFromRequest = (request: Request): ServerStateRequestRecord => {
  const parsedUrl = new URL(request.url());
  const owner = request.headers()[REQUEST_OWNER_HEADER];
  const operation = rpcOperationForPathname(parsedUrl.pathname);
  return {
    method: request.method(),
    ...(operation === undefined ? {} : { operation }),
    ...(owner === undefined ? {} : { owner }),
    pathname: parsedUrl.pathname,
    resourceType: request.resourceType(),
    url: `${parsedUrl.pathname}${parsedUrl.search}`,
  };
};

export interface ServerStateNetworkTrace {
  readonly checkpoint: (name: string) => void;
  readonly counts: (since?: string) => ServerStateRequestCounts;
  readonly dispose: () => void;
  readonly records: (since?: string) => readonly ServerStateRequestRecord[];
}

export const createServerStateNetworkTrace = (page: Page): ServerStateNetworkTrace => {
  const requests: ServerStateRequestRecord[] = [];
  const checkpoints = new Map<string, number>();
  const observe = (request: Request): void => {
    const pathname = new URL(request.url()).pathname;
    if (isRpcPathname(pathname) || pathname.endsWith(ROUTE_DATA_SUFFIX)) {
      requests.push(recordFromRequest(request));
    }
  };
  const startFor = (name: string | undefined): number => {
    if (name === undefined) {
      return 0;
    }
    const start = checkpoints.get(name);
    if (start === undefined) {
      throw new Error(`Unknown server-state network checkpoint: ${name}`);
    }
    return start;
  };

  page.on('request', observe);
  return {
    checkpoint: (name) => {
      if (checkpoints.has(name)) {
        throw new Error(`Duplicate server-state network checkpoint: ${name}`);
      }
      checkpoints.set(name, requests.length);
    },
    counts: (since) => summarizeServerStateRequests(requests.slice(startFor(since))),
    dispose: () => page.off('request', observe),
    records: (since) => requests.slice(startFor(since)),
  };
};
