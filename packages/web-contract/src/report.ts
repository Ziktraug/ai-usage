import {
  type CampaignLabelOverride as CoreCampaignLabelOverride,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from '@ai-usage/report-core/campaign-label';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedReportQueryResult,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import {
  type ProviderQuotaHistoryRequest as CoreProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult as CoreProviderQuotaHistoryResult,
  parseProviderQuotaHistoryRequest,
  parseProviderQuotaHistoryResult,
} from '@ai-usage/report-core/provider-quota';
import {
  MAX_BREAKDOWN_REFRESH_BYTES,
  MAX_OVERVIEW_REFRESH_BYTES,
  MAX_SERVED_BOOTSTRAP_BYTES,
} from '@ai-usage/report-core/report-budgets';
import { parseServedRevision } from '@ai-usage/report-core/served-revision';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { type ContractRouterClient, oc } from '@orpc/contract';
import { boolean, literal, pipe, rawTransform, strictObject, unknown as unknownSchema } from 'valibot';
import { publicErrorMap } from './errors';
import { emptyInputSchema, isJsonWireValue } from './schema-conventions';

const PROJECT_SOURCE_REFERENCE_PATTERN = /^project-source:[a-f0-9]{64}$/u;
const REPORT_MANIFEST_FINGERPRINT = 'report-manifest:v1:{}';
const MAX_PROJECT_GROUPS = 256;
const MAX_PROJECT_GROUP_TEXT_CHARACTERS = 240;
const MAX_PROJECT_GROUP_COMMAND_BYTES = 68 * 1024;
const MAX_PUBLIC_ERROR_MESSAGE_CHARACTERS = 512;
const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertExactKeys = (record: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const expected = new Set(keys);
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`Invalid ${label}.`);
  }
};

const assertAllowedKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label}.`);
  }
};

const assertBoundedJson = (value: unknown, maximumBytes: number, label: string): void => {
  if (!isJsonWireValue(value) || textEncoder.encode(JSON.stringify(value)).byteLength > maximumBytes) {
    throw new Error(`Invalid ${label}.`);
  }
};

const parsedSchema = <Output>(label: string, parser: (value: unknown) => Output) =>
  pipe(
    unknownSchema(),
    rawTransform<unknown, Output>(({ dataset, addIssue, NEVER }) => {
      try {
        return parser(dataset.value);
      } catch {
        addIssue({ message: `Invalid ${label}.` });
        return NEVER;
      }
    }),
  );

const parseNonEmptyText = (value: unknown, label: string, maximum = MAX_PROJECT_GROUP_TEXT_CHARACTERS): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
};

const parseNonEmptyProtocolMessage = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid focused report error message.');
  }
  return value;
};

const parseNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (!(Number.isSafeInteger(value) && Number(value) >= 0)) {
    throw new Error(`Invalid ${label}.`);
  }
  return Number(value);
};

const parseReportRevision = (value: unknown): string => {
  try {
    return parseServedRevision(value, 'report revision');
  } catch {
    throw new Error('Invalid report revision.');
  }
};

export interface ReportRevisionManifest {
  readonly captureFingerprint: string;
  readonly expiresAt: number;
  readonly generatedAt: string;
  readonly publishedAt: number;
  readonly revision: string;
  readonly rowsBytes: number;
  readonly sessionQueryBytes?: number;
  readonly supportBytes: number;
}

export type ReportRevisionManifestResult =
  | { readonly manifest: ReportRevisionManifest; readonly ok: true; readonly requestFingerprint: string }
  | {
      readonly error: { readonly message: string; readonly tag: 'RevisionUnavailable' };
      readonly ok: false;
      readonly requestFingerprint: string;
    };

export type ReportRevisionBootstrapResult =
  | {
      readonly bootstrap: FocusedSupportResult;
      readonly manifest: ReportRevisionManifest;
      readonly ok: true;
      readonly requestFingerprint: string;
    }
  | Extract<ReportRevisionManifestResult, { readonly ok: false }>;

const parseManifest = (value: unknown): ReportRevisionManifest => {
  if (!isRecord(value)) {
    throw new Error('Invalid report manifest.');
  }
  assertAllowedKeys(
    value,
    ['captureFingerprint', 'expiresAt', 'generatedAt', 'publishedAt', 'revision', 'rowsBytes', 'supportBytes'],
    ['sessionQueryBytes'],
    'report manifest',
  );
  const captureFingerprint = parseNonEmptyText(value.captureFingerprint, 'capture fingerprint', 512);
  const generatedAt = parseCanonicalInstant(value.generatedAt, 'generated timestamp');
  return {
    captureFingerprint,
    expiresAt: parseNonNegativeSafeInteger(value.expiresAt, 'manifest expiry'),
    generatedAt,
    publishedAt: parseNonNegativeSafeInteger(value.publishedAt, 'manifest publication'),
    revision: parseReportRevision(value.revision),
    rowsBytes: parseNonNegativeSafeInteger(value.rowsBytes, 'manifest rows bytes'),
    ...(value.sessionQueryBytes === undefined
      ? {}
      : { sessionQueryBytes: parseNonNegativeSafeInteger(value.sessionQueryBytes, 'manifest Session bytes') }),
    supportBytes: parseNonNegativeSafeInteger(value.supportBytes, 'manifest support bytes'),
  };
};

const parseRevisionUnavailable = (
  value: unknown,
): { readonly message: string; readonly tag: 'RevisionUnavailable' } => {
  if (!isRecord(value)) {
    throw new Error('Invalid revision unavailable error.');
  }
  assertExactKeys(value, ['message', 'tag'], 'revision unavailable error');
  if (value.tag !== 'RevisionUnavailable') {
    throw new Error('Invalid revision unavailable tag.');
  }
  return {
    message: parseNonEmptyText(value.message, 'revision unavailable message', MAX_PUBLIC_ERROR_MESSAGE_CHARACTERS),
    tag: value.tag,
  };
};

const parseReportRevisionManifestResult = (value: unknown): ReportRevisionManifestResult => {
  assertBoundedJson(value, MAX_SERVED_BOOTSTRAP_BYTES, 'report manifest result');
  if (!isRecord(value) || value.requestFingerprint !== REPORT_MANIFEST_FINGERPRINT) {
    throw new Error('Invalid report manifest result.');
  }
  if (value.ok === true) {
    assertExactKeys(value, ['manifest', 'ok', 'requestFingerprint'], 'report manifest result');
    return { manifest: parseManifest(value.manifest), ok: true, requestFingerprint: REPORT_MANIFEST_FINGERPRINT };
  }
  if (value.ok !== false) {
    throw new Error('Invalid report manifest result status.');
  }
  assertExactKeys(value, ['error', 'ok', 'requestFingerprint'], 'report manifest result');
  return { error: parseRevisionUnavailable(value.error), ok: false, requestFingerprint: REPORT_MANIFEST_FINGERPRINT };
};

const parseReportRevisionBootstrapResult = (value: unknown): ReportRevisionBootstrapResult => {
  assertBoundedJson(value, MAX_SERVED_BOOTSTRAP_BYTES, 'report bootstrap result');
  if (!(isRecord(value) && value.requestFingerprint === REPORT_MANIFEST_FINGERPRINT)) {
    throw new Error('Invalid report bootstrap result.');
  }
  if (value.ok !== true) {
    if (value.ok !== false) {
      throw new Error('Invalid report bootstrap result status.');
    }
    assertExactKeys(value, ['error', 'ok', 'requestFingerprint'], 'report bootstrap result');
    return {
      error: parseRevisionUnavailable(value.error),
      ok: false,
      requestFingerprint: REPORT_MANIFEST_FINGERPRINT,
    };
  }
  assertExactKeys(value, ['bootstrap', 'manifest', 'ok', 'requestFingerprint'], 'report bootstrap result');
  const manifest = parseManifest(value.manifest);
  return {
    bootstrap: parseFocusedReportQueryResult('support', value.bootstrap, { revision: manifest.revision }),
    manifest,
    ok: true,
    requestFingerprint: REPORT_MANIFEST_FINGERPRINT,
  };
};

export type FocusedReportServerResult<Result> = SessionQueryServerResult<Result>;

const parseFocusedEnvelopeShape = <Result>(value: unknown, maximumBytes: number): FocusedReportServerResult<Result> => {
  assertBoundedJson(value, maximumBytes, 'focused report result');
  if (!isRecord(value)) {
    throw new Error('Invalid focused report result.');
  }
  const revision = parseReportRevision(value.revision);
  const requestFingerprint = parseNonEmptyText(value.requestFingerprint, 'request fingerprint', 512);
  if (value.ok === true) {
    assertExactKeys(value, ['data', 'ok', 'requestFingerprint', 'revision'], 'focused report result');
    if (!isRecord(value.data)) {
      throw new Error('Invalid focused report data.');
    }
    return { data: value.data as Result, ok: true, requestFingerprint, revision };
  }
  if (value.ok !== false || !isRecord(value.error)) {
    throw new Error('Invalid focused report result status.');
  }
  assertExactKeys(value, ['error', 'ok', 'requestFingerprint', 'revision'], 'focused report result');
  assertExactKeys(value.error, ['message', 'revision', 'tag'], 'focused report error');
  if (
    (value.error.tag !== 'QueryFailed' && value.error.tag !== 'RevisionExpired') ||
    value.error.revision !== revision
  ) {
    throw new Error('Invalid focused report error.');
  }
  return {
    error: {
      message: parseNonEmptyProtocolMessage(value.error.message),
      revision,
      tag: value.error.tag,
    },
    ok: false,
    requestFingerprint,
    revision,
  };
};

const parseFocusedResultFor = <Request, Result>(
  value: unknown,
  request: Request,
  maximumBytes: number,
  revision: string,
  fingerprint: string,
  parseData: (value: unknown, request: Request) => Result,
): FocusedReportServerResult<Result> => {
  const envelope = parseFocusedEnvelopeShape<Result>(value, maximumBytes);
  if (envelope.revision !== revision || envelope.requestFingerprint !== fingerprint) {
    throw new Error('Focused report result identity does not match its request.');
  }
  return envelope.ok ? { ...envelope, data: parseData(envelope.data, request) } : envelope;
};

export const parseFocusedSupportServerResult = (
  value: unknown,
  input: FocusedRevisionRequest,
): FocusedReportServerResult<FocusedSupportResult> => {
  const request = parseFocusedRevisionRequest(input);
  return parseFocusedResultFor(
    value,
    request,
    MAX_SERVED_BOOTSTRAP_BYTES,
    request.revision,
    focusedRevisionFingerprint('support', request),
    (data, parsed) => parseFocusedReportQueryResult('support', data, parsed),
  );
};

export const parseFocusedOverviewServerResult = (
  value: unknown,
  input: FocusedOverviewRequest,
): FocusedReportServerResult<FocusedOverviewResult> => {
  const request = parseFocusedOverviewRequest(input);
  return parseFocusedResultFor(
    value,
    request,
    MAX_OVERVIEW_REFRESH_BYTES,
    request.query.revision,
    focusedOverviewFingerprint(request),
    (data, parsed) => parseFocusedReportQueryResult('overview', data, parsed),
  );
};

export const parseFocusedBreakdownServerResult = (
  value: unknown,
  input: FocusedBreakdownRequest,
): FocusedReportServerResult<FocusedBreakdownResult> => {
  const request = parseFocusedBreakdownRequest(input);
  return parseFocusedResultFor(
    value,
    request,
    MAX_BREAKDOWN_REFRESH_BYTES,
    request.query.revision,
    focusedBreakdownFingerprint(request),
    (data, parsed) => parseFocusedReportQueryResult('breakdown', data, parsed),
  );
};

const focusedRevisionRequestSchema = parsedSchema('focused revision request', parseFocusedRevisionRequest);
const focusedOverviewRequestSchema = parsedSchema('focused overview request', parseFocusedOverviewRequest);
const focusedBreakdownRequestSchema = parsedSchema('focused breakdown request', parseFocusedBreakdownRequest);
const focusedSupportOutputSchema = parsedSchema<FocusedReportServerResult<FocusedSupportResult>>(
  'focused support result',
  (value) => parseFocusedEnvelopeShape(value, MAX_SERVED_BOOTSTRAP_BYTES),
);
const focusedOverviewOutputSchema = parsedSchema<FocusedReportServerResult<FocusedOverviewResult>>(
  'focused overview result',
  (value) => parseFocusedEnvelopeShape(value, MAX_OVERVIEW_REFRESH_BYTES),
);
const focusedBreakdownOutputSchema = parsedSchema<FocusedReportServerResult<FocusedBreakdownResult>>(
  'focused breakdown result',
  (value) => parseFocusedEnvelopeShape(value, MAX_BREAKDOWN_REFRESH_BYTES),
);
export interface ProjectGroupReference {
  readonly id: string;
  readonly name: string;
  readonly sources: readonly string[];
}

export interface SaveProjectGroupsInput {
  readonly command: 'replace-project-groups-by-reference';
  readonly projectGroups: readonly ProjectGroupReference[];
  readonly revision: string;
}

const parseSaveProjectGroupsInput = (value: unknown): SaveProjectGroupsInput => {
  assertBoundedJson(value, MAX_PROJECT_GROUP_COMMAND_BYTES, 'project group command');
  if (!isRecord(value)) {
    throw new Error('Invalid project group command.');
  }
  assertExactKeys(value, ['command', 'projectGroups', 'revision'], 'project group command');
  if (
    value.command !== 'replace-project-groups-by-reference' ||
    !Array.isArray(value.projectGroups) ||
    value.projectGroups.length > MAX_PROJECT_GROUPS
  ) {
    throw new Error('Invalid project group command.');
  }
  const groupIds = new Set<string>();
  const projectGroups = value.projectGroups.map((entry): ProjectGroupReference => {
    if (!isRecord(entry)) {
      throw new Error('Invalid project group reference.');
    }
    assertExactKeys(entry, ['id', 'name', 'sources'], 'project group reference');
    const id = parseNonEmptyText(entry.id, 'project group ID');
    if (groupIds.has(id) || !Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new Error('Invalid project group reference.');
    }
    groupIds.add(id);
    const sources = entry.sources.map((source) => {
      if (typeof source !== 'string' || !PROJECT_SOURCE_REFERENCE_PATTERN.test(source)) {
        throw new Error('Invalid project source reference.');
      }
      return source;
    });
    if (new Set(sources).size !== sources.length) {
      throw new Error('Duplicate project source reference.');
    }
    return { id, name: parseNonEmptyText(entry.name, 'project group name'), sources };
  });
  return { command: value.command, projectGroups, revision: parseReportRevision(value.revision) };
};

const campaignMutationSchema = parsedSchema('campaign label mutation', parseCampaignLabelOverrideMutation);
export interface CampaignLabelOverridesResult {
  readonly campaignLabelOverrides: CoreCampaignLabelOverride[];
}

const campaignOverridesResultSchema = parsedSchema<CampaignLabelOverridesResult>(
  'campaign label overrides result',
  (value) => {
    assertBoundedJson(value, MAX_SERVED_BOOTSTRAP_BYTES, 'campaign label overrides result');
    if (!isRecord(value)) {
      throw new Error('Invalid campaign label overrides result.');
    }
    assertExactKeys(value, ['campaignLabelOverrides'], 'campaign label overrides result');
    return { campaignLabelOverrides: parseCampaignLabelOverrides(value.campaignLabelOverrides) };
  },
);
const saveProjectGroupsInputSchema = parsedSchema('project group command', parseSaveProjectGroupsInput);
const acceptedOutputSchema = strictObject({ accepted: literal(true) });
const providerQuotaRequestSchema = parsedSchema<CoreProviderQuotaHistoryRequest>(
  'provider quota history request',
  parseProviderQuotaHistoryRequest,
);
const providerQuotaResultSchema = parsedSchema<CoreProviderQuotaHistoryResult>(
  'provider quota history result',
  (value) => {
    assertBoundedJson(value, MAX_OVERVIEW_REFRESH_BYTES, 'provider quota history result');
    return parseProviderQuotaHistoryResult(value);
  },
);

const reportReadErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  IncompatibleStore: publicErrorMap.IncompatibleStore,
  Unavailable: publicErrorMap.Unavailable,
} as const;
const exactReportErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  IncompatibleStore: publicErrorMap.IncompatibleStore,
  InvalidInput: publicErrorMap.InvalidInput,
  RevisionExpired: publicErrorMap.RevisionExpired,
} as const;

export const reportContract = {
  campaign: {
    labelOverrides: oc
      .route({ method: 'GET' })
      .input(emptyInputSchema)
      .output(campaignOverridesResultSchema)
      .errors({ ForbiddenDemo: publicErrorMap.ForbiddenDemo, Unavailable: publicErrorMap.Unavailable }),
    setLabelOverride: oc
      .route({ method: 'POST' })
      .input(campaignMutationSchema)
      .output(campaignOverridesResultSchema)
      .errors({
        Conflict: publicErrorMap.Conflict,
        Forbidden: publicErrorMap.Forbidden,
        ForbiddenDemo: publicErrorMap.ForbiddenDemo,
        InvalidInput: publicErrorMap.InvalidInput,
      }),
  },
  projectGroup: {
    save: oc.route({ method: 'POST' }).input(saveProjectGroupsInputSchema).output(acceptedOutputSchema).errors({
      Conflict: publicErrorMap.Conflict,
      EngineUnavailable: publicErrorMap.EngineUnavailable,
      Forbidden: publicErrorMap.Forbidden,
      ForbiddenDemo: publicErrorMap.ForbiddenDemo,
      InvalidInput: publicErrorMap.InvalidInput,
    }),
  },
  quota: {
    history: oc.route({ method: 'POST' }).input(providerQuotaRequestSchema).output(providerQuotaResultSchema).errors({
      ForbiddenDemo: publicErrorMap.ForbiddenDemo,
      InvalidInput: publicErrorMap.InvalidInput,
      Unavailable: publicErrorMap.Unavailable,
    }),
  },
  report: {
    focusedBreakdown: oc
      .route({ method: 'POST' })
      .input(focusedBreakdownRequestSchema)
      .output(focusedBreakdownOutputSchema)
      .errors(exactReportErrors),
    focusedOverview: oc
      .route({ method: 'POST' })
      .input(focusedOverviewRequestSchema)
      .output(focusedOverviewOutputSchema)
      .errors(exactReportErrors),
    focusedSupport: oc
      .route({ method: 'POST' })
      .input(focusedRevisionRequestSchema)
      .output(focusedSupportOutputSchema)
      .errors(exactReportErrors),
    revisionBootstrap: oc
      .route({ method: 'GET' })
      .input(emptyInputSchema)
      .output(parsedSchema('report bootstrap result', parseReportRevisionBootstrapResult))
      .errors(reportReadErrors),
    revisionManifest: oc
      .route({ method: 'GET' })
      .input(emptyInputSchema)
      .output(parsedSchema('report manifest result', parseReportRevisionManifestResult))
      .errors(reportReadErrors),
  },
  runtime: {
    reportPerfEnabled: oc
      .route({ method: 'GET' })
      .input(emptyInputSchema)
      .output(boolean())
      .errors({ ForbiddenDemo: publicErrorMap.ForbiddenDemo }),
  },
} as const;

export type ReportContractClient = ContractRouterClient<typeof reportContract>;
export type { CampaignLabelOverride, CampaignLabelOverrideMutation } from '@ai-usage/report-core/campaign-label';
export type {
  FocusedBreakdownRequest,
  FocusedBreakdownResult,
  FocusedOverviewRequest,
  FocusedOverviewResult,
  FocusedRevisionRequest,
  FocusedSupportResult,
} from '@ai-usage/report-core/focused-report-query';
export type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
