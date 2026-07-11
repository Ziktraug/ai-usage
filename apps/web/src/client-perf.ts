import type { WebReportPayload } from './web-report-payload';

type PerfValue = boolean | number | string | null | undefined;
type PerfFields = Record<string, PerfValue>;

let resolvedPerfEnabled: boolean | undefined;
let resolvePerfPromise: Promise<boolean> | null = null;

const isBrowser = () => typeof window !== 'undefined' && typeof performance !== 'undefined';

const urlPerfEnabled = () => {
  if (!isBrowser()) {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get('perf');
  return value === '1' || value === 'true';
};

const storedPerfEnabled = () => {
  if (!isBrowser()) {
    return false;
  }
  try {
    const value = window.localStorage.getItem('ai-usage-perf');
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
};

export const clientPerfEnabled = () => resolvedPerfEnabled === true || urlPerfEnabled() || storedPerfEnabled();

export const resolveClientPerfEnabled = async () => {
  if (clientPerfEnabled()) {
    return true;
  }
  if (resolvedPerfEnabled !== undefined) {
    return resolvedPerfEnabled;
  }
  resolvePerfPromise ??= import('./server/report-payload')
    .then(({ getReportPerfEnabled }) => getReportPerfEnabled())
    .then((enabled) => {
      resolvedPerfEnabled = enabled === true;
      return resolvedPerfEnabled;
    })
    .catch(() => {
      resolvedPerfEnabled = false;
      return false;
    });
  return await resolvePerfPromise;
};

const formatFields = (fields: PerfFields = {}) =>
  Object.entries(fields)
    .filter((entry): entry is [string, Exclude<PerfValue, undefined>] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

export const logClientPerf = (label: string, fields?: PerfFields) => {
  if (!clientPerfEnabled()) {
    return;
  }
  const summary = formatFields(fields);
  console.info(`[perf] ${label}${summary ? ` ${summary}` : ''}`);
};

export const payloadStats = (payload: WebReportPayload) => ({
  bytes: JSON.stringify(payload).length,
  rows: payload.rows.length,
  warnings: payload.warnings?.length ?? 0,
});

export const measureClientPerf = <A>(
  label: string,
  run: () => A,
  fields?: (value: A) => PerfFields,
  options: { minDurationMs?: number } = {},
) => {
  if (!clientPerfEnabled()) {
    return run();
  }
  const startedAt = performance.now();
  const value = run();
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs >= (options.minDurationMs ?? 1)) {
    logClientPerf(label, { durationMs, ...fields?.(value) });
  }
  return value;
};

export const createClientPerfTrace = (label: string, fields: PerfFields = {}) => {
  if (!clientPerfEnabled()) {
    return null;
  }
  const startedAt = performance.now();
  let lastAt = startedAt;

  const mark = (step: string, stepFields: PerfFields = {}) => {
    const now = performance.now();
    const durationMs = Math.round(now - startedAt);
    const deltaMs = Math.round(now - lastAt);
    lastAt = now;
    logClientPerf(`${label}.${step}`, { ...fields, durationMs, deltaMs, ...stepFields });
  };

  return {
    end: mark,
    mark,
  };
};

export const logNavigationPerf = (payload: WebReportPayload) => {
  if (!(clientPerfEnabled() && isBrowser())) {
    return;
  }
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  logClientPerf('aiUsage.web.client.initial', {
    ...payloadStats(payload),
    domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : undefined,
    loadMs: navigation?.loadEventEnd ? Math.round(navigation.loadEventEnd) : undefined,
    responseEndMs: navigation ? Math.round(navigation.responseEnd) : undefined,
  });
};
