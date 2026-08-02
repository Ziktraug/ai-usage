import type { PublicErrorFamily } from '@ai-usage/web-contract/errors';
import {
  type CampaignLabelOverrideMutation,
  type CampaignLabelOverridesResult,
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportServerResult,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  parseFocusedBreakdownServerResult,
  parseFocusedOverviewServerResult,
  parseFocusedSupportServerResult,
  type ReportRevisionBootstrapResult,
  type ReportRevisionManifestResult,
  reportContract,
  type SaveProjectGroupsInput,
} from '@ai-usage/web-contract/report';
import { implement } from '@orpc/server';

interface ServiceCallOptions {
  readonly signal: AbortSignal | undefined;
}

export interface ReportRpcServices {
  readonly getCampaignLabelOverrides: (options: ServiceCallOptions) => Promise<CampaignLabelOverridesResult>;
  readonly getProviderQuotaHistory: (
    input: ProviderQuotaHistoryRequest,
    options: ServiceCallOptions,
  ) => Promise<ProviderQuotaHistoryResult>;
  readonly getReportPerfEnabled: (options: ServiceCallOptions) => Promise<boolean>;
  readonly getReportRevisionBootstrap: (options: ServiceCallOptions) => Promise<ReportRevisionBootstrapResult>;
  readonly getReportRevisionManifest: (options: ServiceCallOptions) => Promise<ReportRevisionManifestResult>;
  readonly runFocusedBreakdown: (
    input: FocusedBreakdownRequest,
    options: ServiceCallOptions,
  ) => Promise<FocusedReportServerResult<FocusedBreakdownResult>>;
  readonly runFocusedOverview: (
    input: FocusedOverviewRequest,
    options: ServiceCallOptions,
  ) => Promise<FocusedReportServerResult<FocusedOverviewResult>>;
  readonly runFocusedSupport: (
    input: FocusedRevisionRequest,
    options: ServiceCallOptions,
  ) => Promise<FocusedReportServerResult<FocusedSupportResult>>;
  readonly saveProjectGroups: (
    input: SaveProjectGroupsInput,
    options: ServiceCallOptions,
  ) => Promise<{ readonly accepted: true }>;
  readonly setCampaignLabelOverride: (
    input: CampaignLabelOverrideMutation,
    options: ServiceCallOptions,
  ) => Promise<CampaignLabelOverridesResult>;
}

export class ReportRpcServiceError extends Error {
  readonly family: PublicErrorFamily;
  readonly reason: string | undefined;

  constructor(family: PublicErrorFamily, message: string, reason?: string) {
    super(message);
    this.name = 'ReportRpcServiceError';
    this.family = family;
    this.reason = reason;
  }
}

interface PublicErrorOptions {
  readonly data: { readonly reason?: string };
  readonly message: string;
}

type PublicErrorFactory = (options: PublicErrorOptions) => Error;
type PublicErrorFactories = Readonly<Record<string, PublicErrorFactory>>;

const SAFE_REASON_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const MAX_PUBLIC_MESSAGE_CHARACTERS = 512;

const safeServiceOptions = (error: ReportRpcServiceError): PublicErrorOptions => ({
  data:
    error.reason && SAFE_REASON_PATTERN.test(error.reason)
      ? {
          reason: error.reason,
        }
      : {},
  message:
    error.message.length > 0 &&
    error.message.length <= MAX_PUBLIC_MESSAGE_CHARACTERS &&
    !(error.message.includes('\n') || error.message.includes('\r'))
      ? error.message
      : 'The report operation could not be completed.',
});

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw signal.reason;
  }
};

const callWithCancellation = async <Result>(
  signal: AbortSignal | undefined,
  call: () => Promise<Result>,
): Promise<Result> => {
  throwIfCancelled(signal);
  const result = await call();
  throwIfCancelled(signal);
  return result;
};

const throwMappedError = (
  error: unknown,
  fallbackFamily: string,
  fallbackMessage: string,
  factories: PublicErrorFactories,
  signal: AbortSignal | undefined,
): never => {
  throwIfCancelled(signal);
  const serviceError = error instanceof ReportRpcServiceError ? error : undefined;
  const family = serviceError && Object.hasOwn(factories, serviceError.family) ? serviceError.family : fallbackFamily;
  const factory = factories[family];
  if (!factory) {
    throw new Error('Missing public error mapping.');
  }
  throw factory(serviceError ? safeServiceOptions(serviceError) : { data: {}, message: fallbackMessage });
};

const reportImplementation = implement(reportContract);

export const createReportRpcRouter = (services: ReportRpcServices) => ({
  campaign: {
    labelOverrides: reportImplementation.campaign.labelOverrides.handler(async ({ errors, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.getCampaignLabelOverrides({ signal }));
      } catch (error) {
        return throwMappedError(error, 'Unavailable', 'Campaign labels are temporarily unavailable.', errors, signal);
      }
    }),
    setLabelOverride: reportImplementation.campaign.setLabelOverride.handler(async ({ errors, input, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.setCampaignLabelOverride(input, { signal }));
      } catch (error) {
        return throwMappedError(error, 'Conflict', 'The campaign label could not be saved.', errors, signal);
      }
    }),
  },
  projectGroup: {
    save: reportImplementation.projectGroup.save.handler(async ({ errors, input, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.saveProjectGroups(input, { signal }));
      } catch (error) {
        return throwMappedError(
          error,
          'EngineUnavailable',
          'Project groups are temporarily unavailable.',
          errors,
          signal,
        );
      }
    }),
  },
  quota: {
    history: reportImplementation.quota.history.handler(async ({ errors, input, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.getProviderQuotaHistory(input, { signal }));
      } catch (error) {
        return throwMappedError(
          error,
          'Unavailable',
          'Provider quota history is temporarily unavailable.',
          errors,
          signal,
        );
      }
    }),
  },
  report: {
    focusedBreakdown: reportImplementation.report.focusedBreakdown.handler(async ({ errors, input, signal }) => {
      try {
        const result = await callWithCancellation(signal, () => services.runFocusedBreakdown(input, { signal }));
        return parseFocusedBreakdownServerResult(result, input);
      } catch (error) {
        return throwMappedError(
          error,
          'IncompatibleStore',
          'The requested report breakdown is unavailable.',
          errors,
          signal,
        );
      }
    }),
    focusedOverview: reportImplementation.report.focusedOverview.handler(async ({ errors, input, signal }) => {
      try {
        const result = await callWithCancellation(signal, () => services.runFocusedOverview(input, { signal }));
        return parseFocusedOverviewServerResult(result, input);
      } catch (error) {
        return throwMappedError(
          error,
          'IncompatibleStore',
          'The requested report overview is unavailable.',
          errors,
          signal,
        );
      }
    }),
    focusedSupport: reportImplementation.report.focusedSupport.handler(async ({ errors, input, signal }) => {
      try {
        const result = await callWithCancellation(signal, () => services.runFocusedSupport(input, { signal }));
        return parseFocusedSupportServerResult(result, input);
      } catch (error) {
        return throwMappedError(
          error,
          'IncompatibleStore',
          'The requested report support data is unavailable.',
          errors,
          signal,
        );
      }
    }),
    revisionBootstrap: reportImplementation.report.revisionBootstrap.handler(async ({ errors, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.getReportRevisionBootstrap({ signal }));
      } catch (error) {
        return throwMappedError(
          error,
          'Unavailable',
          'The report bootstrap is temporarily unavailable.',
          errors,
          signal,
        );
      }
    }),
    revisionManifest: reportImplementation.report.revisionManifest.handler(async ({ errors, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.getReportRevisionManifest({ signal }));
      } catch (error) {
        return throwMappedError(
          error,
          'Unavailable',
          'The report manifest is temporarily unavailable.',
          errors,
          signal,
        );
      }
    }),
  },
  runtime: {
    reportPerfEnabled: reportImplementation.runtime.reportPerfEnabled.handler(async ({ errors, signal }) => {
      try {
        return await callWithCancellation(signal, () => services.getReportPerfEnabled({ signal }));
      } catch (error) {
        return throwMappedError(
          error,
          'ForbiddenDemo',
          'Report performance diagnostics are unavailable.',
          errors,
          signal,
        );
      }
    }),
  },
});
