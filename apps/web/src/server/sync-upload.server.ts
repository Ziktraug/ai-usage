import type { RuntimeMode } from '../runtime-mode';
import { runOutsideDemo } from './demo-boundary.server';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getServerRuntimeMode } from './runtime-mode.server';

type SyncUploadHandler = (request: Request) => Promise<Response>;

const loadSyncUploadHandler = async (mode: Exclude<RuntimeMode, 'demo'>): Promise<SyncUploadHandler> => {
  const [
    { handleManualMergeUpload },
    { executeUsageEngineCommandToCompletion },
    { resolveUsageEngineControlClientForServer },
  ] = await Promise.all([
    import('./manual-merge-upload.server'),
    import('./usage-engine-command.server'),
    import('./usage-engine-control-resolver.server'),
  ]);
  const control = await resolveUsageEngineControlClientForServer(mode);
  const stageHandoff =
    mode === 'e2e'
      ? (await import('./e2e/sync-fixture.server')).stageSyncE2EHandoff
      : await Promise.all([
          import('@ai-usage/usage-engine-control/handoff'),
          import('./usage-runtime-paths.server'),
        ]).then(([{ stageUsageEngineHandoff }, { resolveUsageWebRuntimePaths }]) => {
          const inboxDirectory = resolveUsageWebRuntimePaths().inboxDirectory;
          return (bytes: Uint8Array) => stageUsageEngineHandoff(bytes, { inboxDirectory });
        });
  return (request) =>
    handleManualMergeUpload(request, {
      executeCommand: (command) => executeUsageEngineCommandToCompletion(control, command, { signal: request.signal }),
      stageHandoff,
    });
};

export const handleSyncUploadRequest = async (
  request: Request,
  options: {
    loadHandler?: () => Promise<SyncUploadHandler>;
    mode?: RuntimeMode;
  } = {},
): Promise<Response> => {
  const mode = options.mode ?? getServerRuntimeMode();
  const result = await runOutsideDemo(async () => {
    const trustFailure = validateTrustedLocalRequest(request);
    if (trustFailure) {
      return trustFailure;
    }
    const handler = await (
      options.loadHandler ?? (() => loadSyncUploadHandler(mode as Exclude<RuntimeMode, 'demo'>))
    )();
    return await handler(request);
  }, mode);
  return result;
};
