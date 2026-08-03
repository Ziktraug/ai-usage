import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedOverviewView,
  type FocusedReportQueryScope,
  type FocusedSupportResult,
  focusedAdvancedAnalysisFingerprint,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { type Accessor, batch, createSignal } from 'solid-js';
import { createReportClient } from './lib/rpc/report-client';
import { resolveSolidWebRpcClient } from './lib/rpc/solid-client';
import {
  normalizeWebReportRevisionBootstrapResult,
  reportManifestRequestFingerprint,
  type WebReportRevisionBootstrapResult,
} from './web-report-payload';

export interface FocusedReportSource {
  getBootstrap: (options?: { readonly signal?: AbortSignal }) => Promise<WebReportRevisionBootstrapResult>;
  getBreakdown: (
    request: FocusedBreakdownRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SessionQueryServerResult<FocusedBreakdownResult>>;
  getOverview: (
    request: FocusedOverviewRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SessionQueryServerResult<FocusedOverviewResult>>;
}

export class FocusedRevisionExpiredError extends Error {
  constructor() {
    super('The focused report revision expired');
    this.name = 'FocusedRevisionExpiredError';
  }
}

const validateServerResult = <Result>(
  kind: 'breakdown' | 'overview',
  revision: string,
  fingerprint: string,
  result: SessionQueryServerResult<Result>,
): Result => {
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

const validatedBootstrap = (
  result: WebReportRevisionBootstrapResult,
): Extract<WebReportRevisionBootstrapResult, { readonly ok: true }> => {
  if (result.requestFingerprint !== reportManifestRequestFingerprint) {
    throw new Error('Report manifest request fingerprint mismatch');
  }
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const supportFingerprint = focusedRevisionFingerprint('support', { revision: result.manifest.revision });
  if (
    result.bootstrap.revision !== result.manifest.revision ||
    result.bootstrap.requestFingerprint !== supportFingerprint
  ) {
    throw new Error('Report bootstrap revision or fingerprint mismatch');
  }
  return result;
};

export interface FocusedReportBootstrapDescriptor {
  bootstrap: FocusedSupportResult;
  captureFingerprint: string;
  revision: string;
}

export const fetchFocusedReportBootstrapDescriptor = async (
  source: FocusedReportSource,
  options?: { readonly signal?: AbortSignal },
): Promise<FocusedReportBootstrapDescriptor> => {
  const result = validatedBootstrap(await source.getBootstrap(options));
  return {
    bootstrap: result.bootstrap,
    captureFingerprint: result.manifest.captureFingerprint,
    revision: result.manifest.revision,
  };
};

export const fetchFocusedReportBootstrap = async (source: FocusedReportSource): Promise<FocusedSupportResult> =>
  (await fetchFocusedReportBootstrapDescriptor(source)).bootstrap;

export const fetchFocusedOverview = async (
  source: FocusedReportSource,
  request: FocusedOverviewRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<FocusedOverviewResult> =>
  validateServerResult(
    'overview',
    request.query.revision,
    focusedOverviewFingerprint(request),
    await source.getOverview(request, options),
  );

export const fetchFocusedBreakdown = async (
  source: FocusedReportSource,
  request: FocusedBreakdownRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<FocusedBreakdownResult> =>
  validateServerResult(
    'breakdown',
    request.query.revision,
    focusedBreakdownFingerprint(request),
    await source.getBreakdown(request, options),
  );

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

export interface FocusedOverviewDisplayModel {
  summary: FocusedOverviewResult['summary'];
  view: FocusedOverviewResult['view'];
}

type FocusedAdvancedAnalysisView = Pick<FocusedOverviewView, 'advancedSummary' | 'punchcard' | 'sessionShape'>;

interface FocusedAdvancedAnalysisCache {
  scopeFingerprint: string;
  view: FocusedAdvancedAnalysisView;
}

export interface FocusedReportStore {
  applyBreakdown: (request: FocusedBreakdownRequest, result: FocusedBreakdownResult) => FocusedStoreApplyResult;
  applyOverview: (request: FocusedOverviewRequest, result: FocusedOverviewResult) => FocusedStoreApplyResult;
  breakdown: Accessor<FocusedBreakdownResult | undefined>;
  canApplyBreakdown: (
    request: FocusedBreakdownRequest,
    result: FocusedBreakdownResult,
    revision?: string,
  ) => FocusedStoreApplyResult;
  canCommitRevision: (
    bootstrap: FocusedSupportResult,
    destination: FocusedRevisionDestination,
  ) => FocusedStoreApplyResult;
  commitRevision: (bootstrap: FocusedSupportResult, destination: FocusedRevisionDestination) => FocusedStoreApplyResult;
  dateDomain: Accessor<FocusedSupportResult['dateDomain']>;
  filterOptions: Accessor<FocusedSupportResult['filterOptions']>;
  hasAdvancedAnalysis: (query: FocusedReportQueryScope) => boolean;
  machineFreshness: Accessor<FocusedSupportResult['machineFreshness']>;
  overview: Accessor<FocusedOverviewResult | undefined>;
  overviewForDisplay: Accessor<FocusedOverviewDisplayModel | undefined>;
  providerRows: Accessor<FocusedSupportResult['providerRows']>;
  revision: Accessor<string>;
  snapshot: Accessor<FocusedReportStoreSnapshot>;
  support: Accessor<FocusedSupportResult['support']>;
  truncation: Accessor<FocusedSupportResult['truncation']>;
}

export const createFocusedReportStore = (initial: FocusedSupportResult): FocusedReportStore => {
  const [snapshot, setSnapshot] = createSignal<FocusedReportStoreSnapshot>({ bootstrap: initial });
  const [advancedAnalysisCache, setAdvancedAnalysisCache] = createSignal<FocusedAdvancedAnalysisCache>();
  const [overviewScopeFingerprint, setOverviewScopeFingerprint] = createSignal<string>();
  const breakdown = (): FocusedBreakdownResult | undefined => snapshot().breakdown;
  const dateDomain = (): FocusedSupportResult['dateDomain'] => snapshot().bootstrap.dateDomain;
  const filterOptions = (): FocusedSupportResult['filterOptions'] => snapshot().bootstrap.filterOptions;
  const machineFreshness = (): FocusedSupportResult['machineFreshness'] => snapshot().bootstrap.machineFreshness;
  const overview = (): FocusedOverviewResult | undefined => snapshot().overview;
  const providerRows = (): FocusedSupportResult['providerRows'] => snapshot().bootstrap.providerRows;
  const revision = (): string => snapshot().bootstrap.revision;
  const support = (): FocusedSupportResult['support'] => snapshot().bootstrap.support;
  const truncation = (): FocusedSupportResult['truncation'] => snapshot().bootstrap.truncation;
  const supersededRevisions = new Set<string>();
  const hasAdvancedAnalysis = (query: FocusedReportQueryScope): boolean =>
    advancedAnalysisCache()?.scopeFingerprint === focusedAdvancedAnalysisFingerprint(query);
  const rememberAdvancedAnalysis = (request: FocusedOverviewRequest, result: FocusedOverviewResult): void => {
    if (!request.includeAdvanced) {
      return;
    }
    setAdvancedAnalysisCache({
      scopeFingerprint: focusedAdvancedAnalysisFingerprint(request.query),
      view: {
        advancedSummary: result.view.advancedSummary,
        punchcard: result.view.punchcard,
        sessionShape: result.view.sessionShape,
      },
    });
  };
  const overviewForDisplay = (): FocusedOverviewDisplayModel | undefined => {
    const result = overview();
    if (!result) {
      return;
    }
    const cache = advancedAnalysisCache();
    const advancedView = cache && cache.scopeFingerprint === overviewScopeFingerprint() ? cache.view : undefined;
    return {
      summary: result.summary,
      view: {
        ...result.view,
        advancedSummary: advancedView?.advancedSummary ?? null,
        punchcard: advancedView?.punchcard ?? null,
        sessionShape: advancedView?.sessionShape ?? null,
      },
    };
  };

  const commitRevision = (
    bootstrap: FocusedSupportResult,
    destination: FocusedRevisionDestination,
  ): FocusedStoreApplyResult => {
    const validation = canCommitRevision(bootstrap, destination);
    if (!validation.applied) {
      return validation;
    }
    const currentRevision = revision();
    if (currentRevision !== bootstrap.revision) {
      supersededRevisions.add(currentRevision);
    }
    batch(() => {
      setSnapshot({
        bootstrap,
        ...(destination.kind === 'breakdown' ? { breakdown: destination.result } : {}),
        ...(destination.kind === 'overview' ? { overview: destination.result } : {}),
      });
      setAdvancedAnalysisCache(undefined);
      setOverviewScopeFingerprint(
        destination.kind === 'overview' ? focusedAdvancedAnalysisFingerprint(destination.request.query) : undefined,
      );
      if (destination.kind === 'overview') {
        rememberAdvancedAnalysis(destination.request, destination.result);
      }
    });
    return { applied: true };
  };

  function canCommitRevision(
    bootstrap: FocusedSupportResult,
    destination: FocusedRevisionDestination,
  ): FocusedStoreApplyResult {
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
    return { applied: true };
  }

  const applyOverview = (request: FocusedOverviewRequest, result: FocusedOverviewResult): FocusedStoreApplyResult => {
    if (result.revision !== revision() || request.query.revision !== revision()) {
      return { applied: false, reason: 'revision-mismatch' };
    }
    if (result.requestFingerprint !== focusedOverviewFingerprint(request)) {
      return { applied: false, reason: 'fingerprint-mismatch' };
    }
    if (overview() === result) {
      return { applied: true };
    }
    batch(() => {
      setSnapshot((current) => ({ ...current, overview: result }));
      setOverviewScopeFingerprint(focusedAdvancedAnalysisFingerprint(request.query));
      rememberAdvancedAnalysis(request, result);
    });
    return { applied: true };
  };

  const applyBreakdown = (
    request: FocusedBreakdownRequest,
    result: FocusedBreakdownResult,
  ): FocusedStoreApplyResult => {
    const validation = canApplyBreakdown(request, result);
    if (!validation.applied) {
      return validation;
    }
    if (breakdown() === result) {
      return { applied: true };
    }
    setSnapshot((current) => ({ ...current, breakdown: result }));
    return { applied: true };
  };

  const canApplyBreakdown = (
    request: FocusedBreakdownRequest,
    result: FocusedBreakdownResult,
    expectedRevision = revision(),
  ): FocusedStoreApplyResult => {
    if (result.revision !== expectedRevision || request.query.revision !== expectedRevision) {
      return { applied: false, reason: 'revision-mismatch' };
    }
    if (result.requestFingerprint !== focusedBreakdownFingerprint(request)) {
      return { applied: false, reason: 'fingerprint-mismatch' };
    }
    return { applied: true };
  };

  return {
    applyBreakdown,
    applyOverview,
    breakdown,
    canApplyBreakdown,
    canCommitRevision,
    dateDomain,
    filterOptions,
    hasAdvancedAnalysis,
    machineFreshness,
    overview,
    overviewForDisplay,
    providerRows,
    revision,
    commitRevision,
    snapshot,
    support,
    truncation,
  };
};

export const createServedFocusedReportSource = (): FocusedReportSource => {
  const client = async () => createReportClient(await resolveSolidWebRpcClient('focused-report'));
  return {
    getBreakdown: async (request, options) => await (await client()).getFocusedReportBreakdown(request, options),
    getBootstrap: async (options) =>
      normalizeWebReportRevisionBootstrapResult(await (await client()).getReportRevisionBootstrap(options)),
    getOverview: async (request, options) => await (await client()).getFocusedReportOverview(request, options),
  };
};
