import { parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import { createServerFn } from '@tanstack/solid-start';
import { toWebReportPayload } from '../web-report-payload';

export const getReportPayload = createServerFn({ method: 'GET' })
  .validator((input: { force?: boolean } | undefined) => ({ force: input?.force === true }))
  .handler(({ data }) =>
    import('./report-payload.server').then(({ runReportPayloadCollection }) =>
      runReportPayloadCollection(data).then(toWebReportPayload),
    ),
  );

export const getReportPerfEnabled = createServerFn({ method: 'GET' }).handler(() =>
  import('./report-payload.server').then(({ reportPerfEnabled }) => reportPerfEnabled()),
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
