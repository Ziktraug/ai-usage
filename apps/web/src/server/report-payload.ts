import {
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import { parseSessionDetailRequest } from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsResolveRequest } from '@ai-usage/report-core/session-vcs';
import { parseWebUsageEngineCommand } from '@ai-usage/usage-engine-control';
import { createServerFn } from '@tanstack/solid-start';
import type { JsonValue } from '../web-report-payload';

const toSerializableJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

const runLiveServerFunction = async <Result>(operation: () => Promise<Result> | Result): Promise<Result> => {
  const { assertOutsideDemo } = await import('./demo-boundary.server');
  assertOutsideDemo();
  return await operation();
};

export const getReportPerfEnabled = createServerFn({ method: 'GET' }).handler(
  async () =>
    await runLiveServerFunction(async () => {
      const { reportPerfEnabled } = await import('./report-payload.server');
      return reportPerfEnabled();
    }),
);

export const getReportSessionDetail = createServerFn({ method: 'POST' })
  .validator(parseSessionDetailRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const [{ getRequest }, { validateTrustedLocalRequest }, sessionDetailApi] = await Promise.all([
          import('@tanstack/solid-start/server'),
          import('./local-request-trust.server'),
          import('./session-detail.server'),
        ]);
        const trustFailure = validateTrustedLocalRequest(getRequest());
        if (trustFailure) {
          throw trustFailure;
        }
        return await sessionDetailApi.getLocalSessionDetailForServer(data);
      }),
  );

export const resolveReportSessionVcs = createServerFn({ method: 'POST' })
  .validator(parseSessionVcsResolveRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const [{ getRequest }, { validateTrustedLocalRequest }, sessionVcsApi] = await Promise.all([
          import('@tanstack/solid-start/server'),
          import('./local-request-trust.server'),
          import('./session-vcs.server'),
        ]);
        const trustFailure = validateTrustedLocalRequest(getRequest());
        if (trustFailure) {
          throw trustFailure;
        }
        return await sessionVcsApi.resolveSessionVcsForServer(data);
      }),
  );

export const getReportRevisionManifest = createServerFn({ method: 'GET' }).handler(
  async () =>
    await runLiveServerFunction(async () => {
      const { getReportRevisionManifestForServer } = await import('./report-payload.server');
      return await getReportRevisionManifestForServer();
    }),
);

export const getReportRevisionBootstrap = createServerFn({ method: 'GET' }).handler(
  async () =>
    await runLiveServerFunction(async () => {
      const { getReportRevisionBootstrapForServer } = await import('./report-payload.server');
      return await getReportRevisionBootstrapForServer();
    }),
);

export const getReportSessionPage = createServerFn({ method: 'POST' })
  .validator(parseSessionQueryRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const { runRevisionQueryForServer } = await import('./revision-query-runner.server');
        return await runRevisionQueryForServer('sessions', data);
      }),
  );

export const getReportSessionCampaignChildren = createServerFn({ method: 'POST' })
  .validator(parseSessionCampaignChildrenRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const { runRevisionQueryForServer } = await import('./revision-query-runner.server');
        return await runRevisionQueryForServer('campaign-children', data);
      }),
  );

export const getReportSessionNeighbors = createServerFn({ method: 'POST' })
  .validator(parseSessionNeighborRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const { runRevisionQueryForServer } = await import('./revision-query-runner.server');
        return await runRevisionQueryForServer('neighbors', data);
      }),
  );

export const getFocusedReportSupport = createServerFn({ method: 'POST' })
  .validator(parseFocusedRevisionRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const { runRevisionQueryForServer } = await import('./revision-query-runner.server');
        return toSerializableJson(await runRevisionQueryForServer('support', data));
      }),
  );

export const getFocusedReportOverview = createServerFn({ method: 'POST' })
  .validator(parseFocusedOverviewRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const { runRevisionQueryForServer } = await import('./revision-query-runner.server');
        return await runRevisionQueryForServer('overview', data);
      }),
  );

export const getFocusedReportBreakdown = createServerFn({ method: 'POST' })
  .validator(parseFocusedBreakdownRequest)
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const { runRevisionQueryForServer } = await import('./revision-query-runner.server');
        return await runRevisionQueryForServer('breakdown', data);
      }),
  );

export const saveProjectGroups = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const command = parseWebUsageEngineCommand(input);
    if (command.command !== 'replace-project-groups-by-reference') {
      throw new Error('Expected a project group reference command.');
    }
    return command;
  })
  .handler(
    async ({ data }) =>
      await runLiveServerFunction(async () => {
        const [{ getRequest }, { saveProjectGroupsFromRequestForServer }] = await Promise.all([
          import('@tanstack/solid-start/server'),
          import('./report-payload.server'),
        ]);
        return await saveProjectGroupsFromRequestForServer(getRequest(), data);
      }),
  );
