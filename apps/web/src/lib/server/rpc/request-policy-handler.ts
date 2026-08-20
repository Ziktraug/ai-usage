import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import type { RuntimeMode } from '../../../runtime-mode';
import { demoNotFoundResponse } from '../../../server/demo-boundary.server';
import { validateTrustedLocalRequest } from '../../../server/local-request-trust.server';
import { getServerRuntimeMode } from '../../../server/runtime-mode.server';
import {
  explicitHttpRequestPolicies,
  type OperationRequestPolicy,
  operationRequestPolicies,
  type RequestPolicy,
} from './request-policy';

const MAX_RPC_CONTENT_LENGTH_BYTES = 12 * 1024 * 1024;
const MAX_RPC_URL_BYTES = 16 * 1024;
const MAX_SOURCE_CONTROL_COMMAND_BYTES = 4 * 1024;
const textEncoder = new TextEncoder();
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
export const rpcPathByOperation = {
  createManagedSkillTargetDirectory: '/skills/createTargetDirectory',
  getCampaignLabelOverrides: '/campaign/labelOverrides',
  getFocusedReportBreakdown: '/report/focusedBreakdown',
  getFocusedReportOverview: '/report/focusedOverview',
  getFocusedReportSupport: '/report/focusedSupport',
  getKnownSkillProjectPaths: '/skills/knownProjectPaths',
  getManagedSkillMarkdown: '/skills/managedMarkdown',
  getProjectSkillMarkdown: '/skills/projectMarkdown',
  getProviderQuotaHistory: '/quota/history',
  getReportPerfEnabled: '/runtime/reportPerfEnabled',
  getReportRevisionBootstrap: '/report/revisionBootstrap',
  getReportRevisionManifest: '/report/revisionManifest',
  getReportSessionCampaignChildren: '/session/campaignChildren',
  getReportSessionDetail: '/session/detail',
  getReportSessionNeighbors: '/session/neighbors',
  getReportSessionPage: '/session/page',
  getSkillManagementSnapshot: '/skills/snapshot',
  getSkillProjectInventories: '/skills/projectInventories',
  getSyncFleet: '/sync/fleet',
  previewReconcileAllManagedSkills: '/skills/previewReconcileAll',
  reconcileAllManagedSkills: '/skills/reconcileAll',
  reconcileManagedSkill: '/skills/reconcileOne',
  refreshSkillManagementSnapshot: '/skills/refreshSnapshot',
  resolveReportSessionVcs: '/session/vcs',
  saveManagedSkillMarkdown: '/skills/saveManagedMarkdown',
  saveProjectGroups: '/projectGroup/save',
  saveSkillManagementConfig: '/skills/saveConfig',
  setCampaignLabelOverride: '/campaign/setLabelOverride',
  setMachineLabel: '/sync/setMachineLabel',
  toggleManagedSkill: '/skills/toggleProjection',
} as const;

type RpcOperationName = keyof typeof rpcPathByOperation;

export const rpcOperationPolicies = operationRequestPolicies.filter(
  (policy): policy is OperationRequestPolicy & { operation: RpcOperationName } => policy.transport !== 'file',
);

const policiesByPath: ReadonlyMap<string, OperationRequestPolicy> = new Map(
  rpcOperationPolicies.map((policy) => [rpcPathByOperation[policy.operation], policy]),
);

export const rpcPathForOperation = (operation: RpcOperationName): string => rpcPathByOperation[operation];

export const rpcPolicyForPath = (pathname: string): OperationRequestPolicy | undefined => policiesByPath.get(pathname);

const explicitPoliciesByPath = new Map<string, RequestPolicy>();
for (const policy of explicitHttpRequestPolicies) {
  explicitPoliciesByPath.set(policy.target, policy);
}
const manualMergeDownloadPolicy = operationRequestPolicies.find(
  (policy) => policy.operation === 'exportManualMergeBundle',
);
if (!manualMergeDownloadPolicy) {
  throw new Error('The manual merge download policy is missing.');
}
explicitPoliciesByPath.set('/api/manual-merge/download', manualMergeDownloadPolicy);

export const explicitPolicyForPath = (pathname: string): RequestPolicy | undefined =>
  explicitPoliciesByPath.get(pathname);

const boundaryFailure = (status: number, tag: string, message: string, headers?: HeadersInit): Response =>
  Response.json(
    { error: { message, tag }, ok: false },
    { headers: { 'cache-control': 'no-store', ...headers }, status },
  );

const requestContentLength = (request: Request): number | undefined => {
  const value = request.headers.get('content-length');
  if (value === null) {
    return;
  }
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    return Number.POSITIVE_INFINITY;
  }
  return Number(value);
};

const requestBodyIsWithinBound = async (request: Request, maximumBytes: number): Promise<boolean> => {
  const body = request.clone().body;
  if (!body) {
    return true;
  }
  const reader = body.getReader();
  let observedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return true;
      }
      observedBytes += chunk.value.byteLength;
      if (observedBytes > maximumBytes) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

const refererIsSameOrigin = (referer: string, requestOrigin: string): boolean => {
  if (!referer.startsWith(requestOrigin)) {
    return false;
  }
  if (referer.length === requestOrigin.length) {
    return true;
  }
  const boundary = referer.charAt(requestOrigin.length);
  return boundary === '/' || boundary === '?' || boundary === '#';
};

export const csrfRequestIsAllowed = (request: Request): boolean => {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null) {
    return fetchSite === 'same-origin';
  }
  const origin = request.headers.get('origin');
  if (origin !== null) {
    return origin === new URL(request.url).origin;
  }
  const referer = request.headers.get('referer');
  return referer !== null && refererIsSameOrigin(referer, new URL(request.url).origin);
};

export interface EnforcedRpcRequest {
  readonly policy: OperationRequestPolicy;
}

const maximumRequestBodyBytes = (policy: RequestPolicy): number | undefined => {
  if (policy.requestSize === 'bounded-rpc-json') {
    return MAX_RPC_CONTENT_LENGTH_BYTES;
  }
  if (policy.requestSize === 'source-control-command-json-4kib') {
    return MAX_SOURCE_CONTROL_COMMAND_BYTES;
  }
  if (policy.requestSize === 'portable-usage-json') {
    return MAX_PORTABLE_USAGE_BYTES;
  }
  return;
};

export const enforceRequestPolicy = async (
  request: Request,
  policy: RequestPolicy,
  runtimeMode: RuntimeMode = getServerRuntimeMode(),
): Promise<{ readonly policy: RequestPolicy } | Response> => {
  if (runtimeMode === 'demo') {
    return demoNotFoundResponse();
  }
  if (request.method !== policy.method) {
    return boundaryFailure(405, 'MethodNotAllowed', `This operation requires ${policy.method}.`, {
      allow: policy.method,
    });
  }
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    return trustFailure;
  }
  if (policy.csrf === 'required' && !csrfRequestIsAllowed(request)) {
    return boundaryFailure(403, 'CsrfRejected', 'The request origin could not be verified.');
  }
  if (textEncoder.encode(request.url).byteLength > MAX_RPC_URL_BYTES) {
    return boundaryFailure(414, 'RequestTooLarge', 'The request URL exceeded its byte limit.');
  }
  const maximumBodyBytes = maximumRequestBodyBytes(policy);
  if (maximumBodyBytes !== undefined) {
    const contentLength = requestContentLength(request);
    if (contentLength !== undefined && contentLength > maximumBodyBytes) {
      return boundaryFailure(413, 'RequestTooLarge', 'The request exceeded its byte limit.');
    }
    if (!(await requestBodyIsWithinBound(request, maximumBodyBytes))) {
      return boundaryFailure(413, 'RequestTooLarge', 'The request exceeded its byte limit.');
    }
  }
  return { policy };
};

export const enforceRpcRequestPolicy = async (
  request: Request,
  runtimeMode: RuntimeMode = getServerRuntimeMode(),
): Promise<EnforcedRpcRequest | Response> => {
  const pathname = new URL(request.url).pathname;
  const isRpcRequest = pathname === '/rpc' || pathname.startsWith('/rpc/');
  if (!isRpcRequest) {
    return boundaryFailure(404, 'NotFound', 'The RPC operation does not exist.');
  }
  if (runtimeMode === 'demo') {
    return demoNotFoundResponse();
  }
  const rpcPath = pathname.slice('/rpc'.length) || '/';
  const policy = rpcPolicyForPath(rpcPath);
  if (!policy) {
    return boundaryFailure(404, 'NotFound', 'The RPC operation does not exist.');
  }
  const result = await enforceRequestPolicy(request, policy, runtimeMode);
  return result instanceof Response ? result : { policy };
};
