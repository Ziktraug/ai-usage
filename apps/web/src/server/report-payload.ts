import {
  parseFocusedBreakdownRequest,
  parseFocusedCsvRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import { parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import { createServerFn } from '@tanstack/solid-start';
import type { JsonValue } from '../web-report-payload';

const toSerializableJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const getReportPerfEnabled = createServerFn({ method: 'GET' }).handler(() =>
  import('./report-payload.server').then(({ reportPerfEnabled }) => reportPerfEnabled()),
);

export const getReportRevisionManifest = createServerFn({ method: 'GET' }).handler(() =>
  import('./report-payload.server').then(({ getReportRevisionManifestForServer }) =>
    getReportRevisionManifestForServer(),
  ),
);

export const getReportSessionPage = createServerFn({ method: 'POST' })
  .validator(parseSessionQueryRequest)
  .handler(({ data }) =>
    import('./session-query-runner.server').then(({ runSessionQueryForServer }) =>
      runSessionQueryForServer('sessions', data),
    ),
  );

export const getReportSessionCampaignChildren = createServerFn({ method: 'POST' })
  .validator(parseSessionCampaignChildrenRequest)
  .handler(({ data }) =>
    import('./session-query-runner.server').then(({ runSessionQueryForServer }) =>
      runSessionQueryForServer('campaign-children', data),
    ),
  );

export const getReportSessionNeighbors = createServerFn({ method: 'POST' })
  .validator(parseSessionNeighborRequest)
  .handler(({ data }) =>
    import('./session-query-runner.server').then(({ runSessionQueryForServer }) =>
      runSessionQueryForServer('neighbors', data),
    ),
  );

export const getFocusedReportSupport = createServerFn({ method: 'POST' })
  .validator(parseFocusedRevisionRequest)
  .handler(async ({ data }) =>
    toSerializableJson(
      await import('./focused-report-query-runner.server').then(({ runFocusedReportQueryForServer }) =>
        runFocusedReportQueryForServer('support', data),
      ),
    ),
  );

export const getFocusedReportOverview = createServerFn({ method: 'POST' })
  .validator(parseFocusedOverviewRequest)
  .handler(({ data }) =>
    import('./focused-report-query-runner.server').then(({ runFocusedReportQueryForServer }) =>
      runFocusedReportQueryForServer('overview', data),
    ),
  );

export const getFocusedReportBreakdown = createServerFn({ method: 'POST' })
  .validator(parseFocusedBreakdownRequest)
  .handler(({ data }) =>
    import('./focused-report-query-runner.server').then(({ runFocusedReportQueryForServer }) =>
      runFocusedReportQueryForServer('breakdown', data),
    ),
  );

export const getFocusedReportCsv = createServerFn({ method: 'POST' })
  .validator(parseFocusedCsvRequest)
  .handler(({ data }) =>
    import('./focused-report-query-runner.server').then(({ runFocusedReportQueryForServer }) =>
      runFocusedReportQueryForServer('csv', data),
    ),
  );

export const getFocusedReportHtmlPayload = createServerFn({ method: 'POST' })
  .validator(parseFocusedRevisionRequest)
  .handler(async ({ data }) =>
    toSerializableJson(
      await import('./focused-report-query-runner.server').then(({ runFocusedReportQueryForServer }) =>
        runFocusedReportQueryForServer('html-payload', data),
      ),
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
