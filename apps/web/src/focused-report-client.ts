import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedCsvRequest,
  type FocusedCsvResult,
  type FocusedHtmlPayloadResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportQueryKind,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  focusedBreakdownFingerprint,
  focusedCsvFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { type Accessor, createSignal } from 'solid-js';
import { reportManifestRequestFingerprint, type WebReportRevisionManifestResult } from './web-report-payload';

export interface FocusedReportSource {
  getBreakdown: (request: FocusedBreakdownRequest) => Promise<SessionQueryServerResult<FocusedBreakdownResult>>;
  getCsv: (request: FocusedCsvRequest) => Promise<SessionQueryServerResult<FocusedCsvResult>>;
  getHtmlPayload: (request: FocusedRevisionRequest) => Promise<SessionQueryServerResult<FocusedHtmlPayloadResult>>;
  getManifest: () => Promise<WebReportRevisionManifestResult>;
  getOverview: (request: FocusedOverviewRequest) => Promise<SessionQueryServerResult<FocusedOverviewResult>>;
  getSupport: (request: FocusedRevisionRequest) => Promise<SessionQueryServerResult<FocusedSupportResult>>;
  refreshRevision?: () => Promise<void>;
}

interface FocusedRequestByKind {
  breakdown: FocusedBreakdownRequest;
  csv: FocusedCsvRequest;
  'html-payload': FocusedRevisionRequest;
  overview: FocusedOverviewRequest;
  support: FocusedRevisionRequest;
}

interface FocusedResultByKind {
  breakdown: FocusedBreakdownResult;
  csv: FocusedCsvResult;
  'html-payload': FocusedHtmlPayloadResult;
  overview: FocusedOverviewResult;
  support: FocusedSupportResult;
}

const requestRevision = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  request: FocusedRequestByKind[Kind],
): string =>
  kind === 'overview' || kind === 'breakdown' || kind === 'csv'
    ? (request as FocusedOverviewRequest | FocusedBreakdownRequest | FocusedCsvRequest).query.revision
    : (request as FocusedRevisionRequest).revision;

const requestFingerprint = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  request: FocusedRequestByKind[Kind],
): string => {
  if (kind === 'overview') {
    return focusedOverviewFingerprint(request as FocusedOverviewRequest);
  }
  if (kind === 'breakdown') {
    return focusedBreakdownFingerprint(request as FocusedBreakdownRequest);
  }
  if (kind === 'csv') {
    return focusedCsvFingerprint(request as FocusedCsvRequest);
  }
  return focusedRevisionFingerprint(kind, request as FocusedRevisionRequest);
};

export class FocusedRevisionExpiredError extends Error {
  constructor() {
    super('The focused report revision expired');
    this.name = 'FocusedRevisionExpiredError';
  }
}

const validateServerResult = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  request: FocusedRequestByKind[Kind],
  result: SessionQueryServerResult<FocusedResultByKind[Kind]>,
): FocusedResultByKind[Kind] => {
  const revision = requestRevision(kind, request);
  const fingerprint = requestFingerprint(kind, request);
  if (result.revision !== revision || result.requestFingerprint !== fingerprint) {
    throw new Error(`Focused ${kind} response revision or fingerprint mismatch`);
  }
  if (!result.ok) {
    if (result.error.tag === 'RevisionExpired') {
      throw new FocusedRevisionExpiredError();
    }
    throw new Error(result.error.message);
  }
  // The production server runner strictly parses every nested focused result
  // before it reaches this transport. The browser rechecks the exact revision
  // and canonical request fingerprint above, then accepts that parsed value.
  return result.data;
};

const querySource = async <Kind extends FocusedReportQueryKind>(
  source: FocusedReportSource,
  kind: Kind,
  request: FocusedRequestByKind[Kind],
): Promise<FocusedResultByKind[Kind]> => {
  if (kind === 'overview') {
    return validateServerResult(
      kind,
      request,
      (await source.getOverview(request as FocusedOverviewRequest)) as SessionQueryServerResult<
        FocusedResultByKind[Kind]
      >,
    );
  }
  if (kind === 'breakdown') {
    return validateServerResult(
      kind,
      request,
      (await source.getBreakdown(request as FocusedBreakdownRequest)) as SessionQueryServerResult<
        FocusedResultByKind[Kind]
      >,
    );
  }
  if (kind === 'csv') {
    return validateServerResult(
      kind,
      request,
      (await source.getCsv(request as FocusedCsvRequest)) as SessionQueryServerResult<FocusedResultByKind[Kind]>,
    );
  }
  if (kind === 'html-payload') {
    return validateServerResult(
      kind,
      request,
      (await source.getHtmlPayload(request as FocusedRevisionRequest)) as SessionQueryServerResult<
        FocusedResultByKind[Kind]
      >,
    );
  }
  return validateServerResult(
    kind,
    request,
    (await source.getSupport(request as FocusedRevisionRequest)) as SessionQueryServerResult<FocusedResultByKind[Kind]>,
  );
};

const manifestRevision = (manifest: WebReportRevisionManifestResult): string => {
  if (manifest.requestFingerprint !== reportManifestRequestFingerprint) {
    throw new Error('Report manifest request fingerprint mismatch');
  }
  if (!manifest.ok) {
    throw new Error(manifest.error.message);
  }
  return manifest.manifest.revision;
};

export const fetchFocusedReportBootstrap = async (
  source: FocusedReportSource,
  retryExpired = true,
): Promise<FocusedSupportResult> => {
  const revision = manifestRevision(await source.getManifest());
  try {
    return await querySource(source, 'support', { revision });
  } catch (error) {
    if (retryExpired && error instanceof FocusedRevisionExpiredError) {
      return await fetchFocusedReportBootstrap(source, false);
    }
    throw error;
  }
};

export const refreshFocusedReportBootstrap = async (source: FocusedReportSource): Promise<FocusedSupportResult> => {
  await source.refreshRevision?.();
  return await fetchFocusedReportBootstrap(source);
};

export const fetchFocusedOverview = (source: FocusedReportSource, request: FocusedOverviewRequest) =>
  querySource(source, 'overview', request);

export const fetchFocusedBreakdown = (source: FocusedReportSource, request: FocusedBreakdownRequest) =>
  querySource(source, 'breakdown', request);

export const fetchFocusedCsv = (source: FocusedReportSource, request: FocusedCsvRequest) =>
  querySource(source, 'csv', request);

export const fetchFocusedHtmlPayload = (source: FocusedReportSource, request: FocusedRevisionRequest) =>
  querySource(source, 'html-payload', request);

export type FocusedStoreApplyResult =
  | { applied: true }
  | { applied: false; reason: 'fingerprint-mismatch' | 'revision-mismatch' | 'superseded-revision' };

export type FocusedRevisionDestination =
  | { kind: 'breakdown'; request: FocusedBreakdownRequest; result: FocusedBreakdownResult }
  | { kind: 'overview'; request: FocusedOverviewRequest; result: FocusedOverviewResult }
  | { kind: 'sessions' };

export interface FocusedReportStoreSnapshot {
  bootstrap: FocusedSupportResult;
  breakdown?: FocusedBreakdownResult;
  overview?: FocusedOverviewResult;
}

export interface FocusedReportStore {
  applyBreakdown: (request: FocusedBreakdownRequest, result: FocusedBreakdownResult) => FocusedStoreApplyResult;
  applyOverview: (request: FocusedOverviewRequest, result: FocusedOverviewResult) => FocusedStoreApplyResult;
  breakdown: Accessor<FocusedBreakdownResult | undefined>;
  commitRevision: (bootstrap: FocusedSupportResult, destination: FocusedRevisionDestination) => FocusedStoreApplyResult;
  filterOptions: Accessor<FocusedSupportResult['filterOptions']>;
  overview: Accessor<FocusedOverviewResult | undefined>;
  providerRows: Accessor<FocusedSupportResult['providerRows']>;
  revision: Accessor<string>;
  snapshot: Accessor<FocusedReportStoreSnapshot>;
  support: Accessor<FocusedSupportResult['support']>;
  truncation: Accessor<FocusedSupportResult['truncation']>;
}

export const createFocusedReportStore = (initial: FocusedSupportResult): FocusedReportStore => {
  const [snapshot, setSnapshot] = createSignal<FocusedReportStoreSnapshot>({ bootstrap: initial });
  const breakdown = (): FocusedBreakdownResult | undefined => snapshot().breakdown;
  const filterOptions = (): FocusedSupportResult['filterOptions'] => snapshot().bootstrap.filterOptions;
  const overview = (): FocusedOverviewResult | undefined => snapshot().overview;
  const providerRows = (): FocusedSupportResult['providerRows'] => snapshot().bootstrap.providerRows;
  const revision = (): string => snapshot().bootstrap.revision;
  const support = (): FocusedSupportResult['support'] => snapshot().bootstrap.support;
  const truncation = (): FocusedSupportResult['truncation'] => snapshot().bootstrap.truncation;
  const supersededRevisions = new Set<string>();

  const commitRevision = (
    bootstrap: FocusedSupportResult,
    destination: FocusedRevisionDestination,
  ): FocusedStoreApplyResult => {
    if (bootstrap.requestFingerprint !== focusedRevisionFingerprint('support', { revision: bootstrap.revision })) {
      return { applied: false, reason: 'fingerprint-mismatch' };
    }
    if (supersededRevisions.has(bootstrap.revision)) {
      return { applied: false, reason: 'superseded-revision' };
    }
    if (destination.kind === 'overview') {
      if (
        destination.request.query.revision !== bootstrap.revision ||
        destination.result.revision !== bootstrap.revision
      ) {
        return { applied: false, reason: 'revision-mismatch' };
      }
      if (destination.result.requestFingerprint !== focusedOverviewFingerprint(destination.request)) {
        return { applied: false, reason: 'fingerprint-mismatch' };
      }
    }
    if (destination.kind === 'breakdown') {
      if (
        destination.request.query.revision !== bootstrap.revision ||
        destination.result.revision !== bootstrap.revision
      ) {
        return { applied: false, reason: 'revision-mismatch' };
      }
      if (destination.result.requestFingerprint !== focusedBreakdownFingerprint(destination.request)) {
        return { applied: false, reason: 'fingerprint-mismatch' };
      }
    }
    const currentRevision = revision();
    if (currentRevision !== bootstrap.revision) {
      supersededRevisions.add(currentRevision);
    }
    setSnapshot({
      bootstrap,
      ...(destination.kind === 'breakdown' ? { breakdown: destination.result } : {}),
      ...(destination.kind === 'overview' ? { overview: destination.result } : {}),
    });
    return { applied: true };
  };

  const applyOverview = (request: FocusedOverviewRequest, result: FocusedOverviewResult): FocusedStoreApplyResult => {
    if (result.revision !== revision() || request.query.revision !== revision()) {
      return { applied: false, reason: 'revision-mismatch' };
    }
    if (result.requestFingerprint !== focusedOverviewFingerprint(request)) {
      return { applied: false, reason: 'fingerprint-mismatch' };
    }
    setSnapshot((current) => ({ ...current, overview: result }));
    return { applied: true };
  };

  const applyBreakdown = (
    request: FocusedBreakdownRequest,
    result: FocusedBreakdownResult,
  ): FocusedStoreApplyResult => {
    if (result.revision !== revision() || request.query.revision !== revision()) {
      return { applied: false, reason: 'revision-mismatch' };
    }
    if (result.requestFingerprint !== focusedBreakdownFingerprint(request)) {
      return { applied: false, reason: 'fingerprint-mismatch' };
    }
    setSnapshot((current) => ({ ...current, breakdown: result }));
    return { applied: true };
  };

  return {
    applyBreakdown,
    applyOverview,
    breakdown,
    filterOptions,
    overview,
    providerRows,
    revision,
    commitRevision,
    snapshot,
    support,
    truncation,
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

export const createServedFocusedReportSource = (): FocusedReportSource => {
  const serverApi = () => import('./server/report-payload');
  return {
    getBreakdown: async (request) => {
      const { getFocusedReportBreakdown } = await serverApi();
      return await getFocusedReportBreakdown({ data: request });
    },
    getCsv: async (request) => {
      const { getFocusedReportCsv } = await serverApi();
      return await getFocusedReportCsv({ data: request });
    },
    getHtmlPayload: async (request) => {
      const { getFocusedReportHtmlPayload } = await serverApi();
      return (await getFocusedReportHtmlPayload({
        data: request,
      })) as unknown as SessionQueryServerResult<FocusedHtmlPayloadResult>;
    },
    getManifest: async () => {
      const { getReportRevisionManifest } = await serverApi();
      return await getReportRevisionManifest();
    },
    getOverview: async (request) => {
      const { getFocusedReportOverview } = await serverApi();
      return await getFocusedReportOverview({ data: request });
    },
    getSupport: async (request) => {
      const { getFocusedReportSupport } = await serverApi();
      return (await getFocusedReportSupport({
        data: request,
      })) as unknown as SessionQueryServerResult<FocusedSupportResult>;
    },
    refreshRevision: async () => {
      const { getReportPayloadRefreshState, startReportPayloadRefresh } = await serverApi();
      const started = await startReportPayloadRefresh();
      while (true) {
        const state = await getReportPayloadRefreshState();
        if (state.runId < started.runId || state.status === 'running') {
          await sleep(300);
          continue;
        }
        if (state.status === 'failed') {
          throw new Error(state.error);
        }
        return;
      }
    },
  };
};
