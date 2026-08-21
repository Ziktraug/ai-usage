import { calculateAnalytics } from '@ai-usage/report-core/analytics';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportSupport,
  type FocusedSupportResult,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { demoReportPayload } from './report-data';
import {
  parseReportRevision,
  reportManifestRequestFingerprint,
  type WebReportRevisionBootstrapResult,
  type WebReportRevisionManifestResult,
} from './web-report-payload';

export const FOCUSED_REPORT_E2E_CONTROL_KEY = '__aiUsageE2EFocusedReportControl';
export const FOCUSED_REPORT_E2E_ENABLED_KEY = '__aiUsageE2EFocusedReportEnabled';
export const FOCUSED_REPORT_E2E_NINETY_DAY_COMPARISON_KEY = '__aiUsageE2ENinetyDayComparison';
export const FOCUSED_REPORT_E2E_NO_LOCAL_DATA_KEY = '__aiUsageE2ENoLocalData';
export const FOCUSED_REPORT_E2E_VISIBLE_TREND_KEY = '__aiUsageE2EFocusedReportVisibleTrend';
/**
 * Opt-in only. The shared rows yield at most a handful of categories in any
 * dimension, so no timeline ever aggregates a tail into `Other`. This flag
 * appends one row per distinct model, inside the default report period, and
 * touches nothing else: the shared rows and every default-view total stay
 * exactly as they were, and the settled visual snapshots capture the harness
 * dimension, which this never widens.
 */
export const FOCUSED_REPORT_E2E_MODEL_TAIL_KEY = '__aiUsageE2EModelTail';

interface FocusedReportSource {
  readonly getBootstrap: (options?: { readonly signal?: AbortSignal }) => Promise<WebReportRevisionBootstrapResult>;
  readonly getBreakdown: (
    request: FocusedBreakdownRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SessionQueryServerResult<FocusedBreakdownResult>>;
  readonly getOverview: (
    request: FocusedOverviewRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SessionQueryServerResult<FocusedOverviewResult>>;
}

const FIXTURE_CAPTURE_FINGERPRINT = 'e'.repeat(64);
const FIXTURE_REVISION = 'focused-e2e-revision';

interface FocusedResponseGate {
  arm: () => void;
  release: () => void;
  waitUntilBlocked: () => Promise<void>;
}

export interface FocusedReportE2EFixture {
  bootstrap: FocusedSupportResult;
  overviewRows: typeof demoReportPayload.rows;
  source: FocusedReportSource;
  waitForResponse: () => Promise<void>;
}

interface ResolvablePromise {
  promise: Promise<void>;
  resolve: () => void;
}

interface PendingResponseGate {
  blocked: ResolvablePromise;
  released: ResolvablePromise;
  settled: boolean;
}

const createResolvablePromise = (): ResolvablePromise => {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const reportSupport = (noLocalData: boolean): FocusedReportSupport => {
  const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
  return noLocalData
    ? {
        ...support,
        analytics: calculateAnalytics([], Date.parse(demoReportPayload.generatedAt)),
      }
    : support;
};

const success = <Result extends { requestFingerprint: string; revision: string }>(
  data: Result,
): SessionQueryServerResult<Result> => ({
  data,
  ok: true,
  requestFingerprint: data.requestFingerprint,
  revision: data.revision,
});

const createResponseGate = (): { control: FocusedResponseGate; waitForResponse: () => Promise<void> } => {
  let pending: PendingResponseGate | undefined;

  const arm = (): void => {
    if (pending && !pending.settled) {
      throw new Error('A focused E2E response gate is already armed');
    }
    pending = {
      blocked: createResolvablePromise(),
      released: createResolvablePromise(),
      settled: false,
    };
  };

  const release = (): void => {
    if (!pending) {
      throw new Error('No focused E2E response gate is armed');
    }
    pending.settled = true;
    pending.released.resolve();
  };

  const waitUntilBlocked = async (): Promise<void> => {
    if (!pending) {
      throw new Error('No focused E2E response gate is armed');
    }
    await pending.blocked.promise;
  };

  const waitForResponse = async (): Promise<void> => {
    const current = pending;
    if (!current || current.settled) {
      return;
    }
    current.blocked.resolve();
    await current.released.promise;
  };

  return {
    control: { arm, release, waitUntilBlocked },
    waitForResponse,
  };
};

/** Enough distinct models to cross MAX_TIMELINE_SERIES and leave a truncated tail. */
const MODEL_TAIL_ROW_COUNT = 20;
/**
 * One lineage for every appended row. Campaign identity is derived from the root
 * session ID, so distinct roots here would widen the campaign dimension too and
 * this addition would no longer be isolated to models.
 */
const MODEL_TAIL_ROOT_SESSION_ID = 'model-tail-root';

const withModelTail = (rows: typeof demoReportPayload.rows): typeof demoReportPayload.rows => {
  const template = rows[0];
  if (!template) {
    return rows;
  }
  const tail = Array.from({ length: MODEL_TAIL_ROW_COUNT }, (_, index) => {
    const ordinal = String(MODEL_TAIL_ROW_COUNT - index).padStart(2, '0');
    // Cheaper than every shared row, so the aggregated tail is exactly these models.
    const cost = (MODEL_TAIL_ROW_COUNT - index) / 100;
    const id = index === 0 ? MODEL_TAIL_ROOT_SESSION_ID : `model-tail-${ordinal}`;
    return {
      ...template,
      activeDate: '2026-06-05T09:00:00.000Z',
      costActual: cost,
      costApprox: cost,
      date: '2026-06-05T08:00:00.000Z',
      endDate: '2026-06-05T09:00:00.000Z',
      model: `tail-model-${ordinal}`,
      name: id,
      sessionLabel: id,
      source: {
        harnessKey: 'codex',
        machineId: 'fixture-machine',
        machineLabel: 'Fixture Machine',
        rootSourceSessionId: MODEL_TAIL_ROOT_SESSION_ID,
        sourceSessionId: id,
      },
    };
  });
  return [...rows, ...tail];
};

const focusedOverviewRows = (): typeof demoReportPayload.rows => {
  const rows =
    Reflect.get(globalThis, FOCUSED_REPORT_E2E_VISIBLE_TREND_KEY) === true
      ? demoReportPayload.rows.map((row) =>
          row.date === '2026-06-10T18:15:00.000Z'
            ? {
                ...row,
                costActual: 1.6,
                costApprox: 1.6,
                harness: 'Codex',
                model: 'gpt-5.3-codex',
                name: 'Build previous report UI',
                provider: 'Codex API',
                sessionLabel: 'Build previous report UI',
                source: { ...row.source, harnessKey: 'codex', sourceSessionId: 'trend-previous' },
              }
            : row,
        )
      : demoReportPayload.rows;
  const widened = Reflect.get(globalThis, FOCUSED_REPORT_E2E_MODEL_TAIL_KEY) === true ? withModelTail(rows) : rows;
  if (Reflect.get(globalThis, FOCUSED_REPORT_E2E_NINETY_DAY_COMPARISON_KEY) !== true) {
    return widened;
  }
  return widened.map((row) => {
    if (row.date === '2026-05-25T13:05:00.000Z') {
      return {
        ...row,
        activeDate: '2026-02-12T14:18:00.000Z',
        date: '2026-02-12T13:05:00.000Z',
        endDate: '2026-02-12T14:18:00.000Z',
        name: 'Build previous 90-day report UI',
        sessionLabel: 'Build previous 90-day report UI',
      };
    }
    if (row.date === '2026-04-12T09:20:00.000Z') {
      return {
        ...row,
        activeDate: '2025-12-12T10:05:00.000Z',
        date: '2025-12-12T09:20:00.000Z',
        endDate: '2025-12-12T10:05:00.000Z',
      };
    }
    return row;
  });
};

export const createFocusedReportE2EFixture = (): FocusedReportE2EFixture | undefined => {
  if (Reflect.get(globalThis, FOCUSED_REPORT_E2E_ENABLED_KEY) !== true) {
    return;
  }

  const gate = createResponseGate();
  Reflect.set(globalThis, FOCUSED_REPORT_E2E_CONTROL_KEY, gate.control);
  const noLocalData = Reflect.get(globalThis, FOCUSED_REPORT_E2E_NO_LOCAL_DATA_KEY) === true;
  const support = reportSupport(noLocalData);
  const overviewRows = noLocalData ? [] : focusedOverviewRows();
  const bootstrap = projectFocusedSupport(
    support,
    {
      harness: noLocalData ? [] : ['codex'],
      machine: noLocalData ? [] : [{ label: 'Fixture Machine', value: 'fixture-machine' }],
      truncated: false,
    },
    { revision: FIXTURE_REVISION },
  );
  const manifest: WebReportRevisionManifestResult = {
    manifest: {
      captureFingerprint: FIXTURE_CAPTURE_FINGERPRINT,
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
      generatedAt: demoReportPayload.generatedAt,
      publishedAt: Date.parse(demoReportPayload.generatedAt),
      revision: parseReportRevision(FIXTURE_REVISION),
      rowsBytes: 1,
      supportBytes: 1,
    },
    ok: true,
    requestFingerprint: reportManifestRequestFingerprint,
  };

  return {
    bootstrap,
    overviewRows,
    source: {
      getBreakdown: async (request) => {
        const data = projectFocusedBreakdown(overviewRows, support, request);
        await gate.waitForResponse();
        return success(data);
      },
      getBootstrap: async () => {
        await gate.waitForResponse();
        return { ...manifest, bootstrap };
      },
      getOverview: async (request) => {
        const data = projectFocusedOverview(overviewRows, support, request);
        await gate.waitForResponse();
        return success(data);
      },
    },
    waitForResponse: gate.waitForResponse,
  };
};
