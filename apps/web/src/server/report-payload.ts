import {
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import { parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import { parseSourceControlCommand } from '@ai-usage/report-core/source-control';
import { createServerFn } from '@tanstack/solid-start';
import type { JsonValue } from '../web-report-payload';

const toSerializableJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const getReportPerfEnabled = createServerFn({ method: 'GET' }).handler(() =>
  import('./report-payload.server').then(({ reportPerfEnabled }) => reportPerfEnabled()),
);

export const getSourceControlSnapshot = createServerFn({
  method: 'GET',
}).handler(async () => {
  const [{ getRequest }, { validateTrustedLocalRequest }, sourceControlApi] = await Promise.all([
    import('@tanstack/solid-start/server'),
    import('./local-request-trust.server'),
    import('./source-control-api.server'),
  ]);
  const trustFailure = validateTrustedLocalRequest(getRequest());
  if (trustFailure) {
    throw trustFailure;
  }
  return await sourceControlApi.getSourceControlSnapshotForServer();
});

export const applySourceControlCommand = createServerFn({ method: 'POST' })
  .validator(parseSourceControlCommand)
  .handler(async ({ data }) => {
    const [{ getRequest }, { validateTrustedLocalRequest }, sourceControlApi] = await Promise.all([
      import('@tanstack/solid-start/server'),
      import('./local-request-trust.server'),
      import('./source-control-api.server'),
    ]);
    const trustFailure = validateTrustedLocalRequest(getRequest());
    if (trustFailure) {
      throw trustFailure;
    }
    return await sourceControlApi.applySourceControlCommandForServer(data);
  });

export const getReportRevisionManifest = createServerFn({ method: 'GET' }).handler(() =>
  import('./report-payload.server').then(({ getReportRevisionManifestForServer }) =>
    getReportRevisionManifestForServer(),
  ),
);

export const getReportSessionPage = createServerFn({ method: 'POST' })
  .validator(parseSessionQueryRequest)
  .handler(({ data }) =>
    import('./revision-query-runner.server').then(({ runRevisionQueryForServer }) =>
      runRevisionQueryForServer('sessions', data),
    ),
  );

export const getReportSessionCampaignChildren = createServerFn({ method: 'POST' })
  .validator(parseSessionCampaignChildrenRequest)
  .handler(({ data }) =>
    import('./revision-query-runner.server').then(({ runRevisionQueryForServer }) =>
      runRevisionQueryForServer('campaign-children', data),
    ),
  );

export const getReportSessionNeighbors = createServerFn({ method: 'POST' })
  .validator(parseSessionNeighborRequest)
  .handler(({ data }) =>
    import('./revision-query-runner.server').then(({ runRevisionQueryForServer }) =>
      runRevisionQueryForServer('neighbors', data),
    ),
  );

export const getFocusedReportSupport = createServerFn({ method: 'POST' })
  .validator(parseFocusedRevisionRequest)
  .handler(async ({ data }) =>
    toSerializableJson(
      await import('./revision-query-runner.server').then(({ runRevisionQueryForServer }) =>
        runRevisionQueryForServer('support', data),
      ),
    ),
  );

export const getFocusedReportOverview = createServerFn({ method: 'POST' })
  .validator(parseFocusedOverviewRequest)
  .handler(({ data }) =>
    import('./revision-query-runner.server').then(({ runRevisionQueryForServer }) =>
      runRevisionQueryForServer('overview', data),
    ),
  );

export const getFocusedReportBreakdown = createServerFn({ method: 'POST' })
  .validator(parseFocusedBreakdownRequest)
  .handler(({ data }) =>
    import('./revision-query-runner.server').then(({ runRevisionQueryForServer }) =>
      runRevisionQueryForServer('breakdown', data),
    ),
  );

export const startReportPayloadRefresh = createServerFn({ method: 'POST' }).handler(() =>
  import('./report-payload.server').then(({ startReportPayloadRefresh: startRefresh }) => startRefresh()),
);

export const getReportPayloadRefreshState = createServerFn({ method: 'GET' }).handler(() =>
  import('./report-payload.server').then(({ getReportPayloadRefreshState: getRefreshState }) => getRefreshState()),
);

export const saveProjectGroups = createServerFn({ method: 'POST' })
  .validator((input: { projectGroups?: unknown }) => ({
    projectGroups: parseProjectGroupConfigs(input.projectGroups),
  }))
  .handler(({ data }) =>
    import('./report-payload.server').then(({ saveProjectGroupsForServer }) =>
      saveProjectGroupsForServer(data.projectGroups),
    ),
  );
