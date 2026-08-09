import type { RuntimeMode } from '../../../../runtime-mode';
import { enforceRequestPolicy, explicitPolicyForPath } from '../../../server/rpc/request-policy-handler';

type ExplicitHandler = (request: Request) => Promise<Response>;
type EndpointPath = '/api/manual-merge/download' | '/api/manual-merge/upload';

export interface ManualMergeEndpointDependencies {
  readonly enforce?: (request: Request, path: EndpointPath, runtimeMode: RuntimeMode) => Promise<Response | null>;
  readonly loadDownload?: () => Promise<ExplicitHandler>;
  readonly loadUpload?: () => Promise<ExplicitHandler>;
}

const enforce = async (request: Request, path: EndpointPath, runtimeMode: RuntimeMode): Promise<Response | null> => {
  const policy = explicitPolicyForPath(path);
  if (!policy) {
    return new Response(null, { status: 500 });
  }
  const result = await enforceRequestPolicy(request, policy, runtimeMode);
  return result instanceof Response ? result : null;
};

const loadDownload = async (): Promise<ExplicitHandler> => {
  const [{ createManualMergeDownloadHandler }, syncData, { resolveUsageReadModelForServer }] = await Promise.all([
    import('../../../server/rpc/sync'),
    import('../../../../server/sync-data.server'),
    import('../../../../server/usage-read-model-resolver.server'),
  ]);
  return createManualMergeDownloadHandler({
    canonicalizeExport: (candidate, signal) => {
      signal.throwIfAborted();
      const result = syncData.canonicalizeManualMergeExportForServer(candidate);
      signal.throwIfAborted();
      return result;
    },
    exportBundle: async (signal) => {
      signal.throwIfAborted();
      const result = await syncData.exportManualMergeBundleForServer(await resolveUsageReadModelForServer(), {
        signal,
      });
      signal.throwIfAborted();
      return result;
    },
  });
};

const loadUpload = async (): Promise<ExplicitHandler> => {
  const [{ createManualMergeUploadHandler }, { handleSyncUploadRequest }] = await Promise.all([
    import('../../../server/rpc/sync'),
    import('../../../../server/sync-upload.server'),
  ]);
  return createManualMergeUploadHandler(handleSyncUploadRequest);
};

const handleEndpoint = async (
  request: Request,
  runtimeMode: RuntimeMode,
  path: EndpointPath,
  load: () => Promise<ExplicitHandler>,
  dependencies: ManualMergeEndpointDependencies,
): Promise<Response> => {
  const policyFailure = await (dependencies.enforce ?? enforce)(request, path, runtimeMode);
  if (policyFailure) {
    return policyFailure;
  }
  return await (await load())(request);
};

export const handleManualMergeDownloadEndpoint = async (
  request: Request,
  runtimeMode: RuntimeMode,
  dependencies: ManualMergeEndpointDependencies = {},
): Promise<Response> =>
  await handleEndpoint(
    request,
    runtimeMode,
    '/api/manual-merge/download',
    dependencies.loadDownload ?? loadDownload,
    dependencies,
  );

export const handleManualMergeUploadEndpoint = async (
  request: Request,
  runtimeMode: RuntimeMode,
  dependencies: ManualMergeEndpointDependencies = {},
): Promise<Response> =>
  await handleEndpoint(
    request,
    runtimeMode,
    '/api/manual-merge/upload',
    dependencies.loadUpload ?? loadUpload,
    dependencies,
  );
