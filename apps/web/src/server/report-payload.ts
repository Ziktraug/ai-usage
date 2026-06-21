import type { createUsageReportPayload } from '@ai-usage/report-core/report-data';
import { createServerFn } from '@tanstack/solid-start';

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };
type StartReportPayload = Omit<ReturnType<typeof createUsageReportPayload>, 'facets'> & {
  facets?: Record<string, JsonValue>;
};

const toStartPayload = (payload: ReturnType<typeof createUsageReportPayload>): StartReportPayload => {
  // Server functions only accept serializable data. The report payload is JSON by
  // construction, so this boundary both validates that assumption and narrows the
  // broad facets type from Record<string, unknown>.
  return JSON.parse(JSON.stringify(payload)) as StartReportPayload;
};

export const getReportPayload = createServerFn({ method: 'GET' })
  .validator((input: { force?: boolean } | undefined) => ({ force: input?.force === true }))
  .handler(({ data }) =>
    import('./report-payload.server').then(({ runReportPayloadCollection }) =>
      runReportPayloadCollection(data).then(toStartPayload),
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
