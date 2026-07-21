import type { RuntimeMode } from '../runtime-mode';
import { runOutsideDemo } from './demo-boundary.server';
import { getServerRuntimeMode } from './runtime-mode.server';

type SyncUploadHandler = (request: Request) => Promise<Response>;

const loadSyncUploadHandler = async (): Promise<SyncUploadHandler> => {
  const [mergeServer, { handleManualMergeUpload }] = await Promise.all([
    import('./manual-merge.server'),
    import('./manual-merge-upload.server'),
  ]);
  return (request) =>
    handleManualMergeUpload(request, {
      previewBundle: (document) => mergeServer.previewManualMergeBundleForServer(document),
      confirmBundle: (document, expected) =>
        mergeServer.confirmManualMergeBundleForServer({
          ...document,
          expectedDigest: expected.digest,
          expectedStoreGeneration: expected.generation,
          expectedStoreStateToken: expected.storeStateToken,
        }),
    });
};

export const handleSyncUploadRequest = async (
  request: Request,
  options: {
    loadHandler?: () => Promise<SyncUploadHandler>;
    mode?: RuntimeMode;
  } = {},
): Promise<Response> => {
  const result = await runOutsideDemo(async () => {
    const handler = await (options.loadHandler ?? loadSyncUploadHandler)();
    return await handler(request);
  }, options.mode ?? getServerRuntimeMode());
  return result;
};
