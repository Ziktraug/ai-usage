import { isRecord } from './datasets';
import type {
  DelegationEvaluation,
  DelegationExecutedScope,
  DelegationHarnessGuarantee,
  DelegationJob,
  DelegationJobResult,
  DelegationQualification,
  DelegationRequest,
  DelegationReviewResult,
  DelegationScopeRequest,
  DelegationSelection,
  DelegationUsage,
  FrozenDelegationScope,
} from './delegation-contracts';
import { parseDelegationSelection } from './delegation-request';
import { DELEGATION_RESULT_BOUNDS, parseDelegationReviewResult } from './delegation-result';
import {
  DELEGATION_ACCEPTANCE_VERDICTS,
  DELEGATION_BOUNDS,
  DELEGATION_CONTEXTS,
  DELEGATION_EVALUATION_AUTHORS,
  DELEGATION_EVALUATION_KINDS,
  DELEGATION_EXECUTOR_HARNESSES,
  DELEGATION_IDEMPOTENCY_KEY_PATTERN,
  DELEGATION_JOB_STATES,
  DELEGATION_REFUSAL_REASONS,
  DELEGATION_RELEASE_EVIDENCE,
  DELEGATION_RESULT_KINDS,
  DELEGATION_SCOPE_KINDS,
  DELEGATION_VERIFICATION_VERDICTS,
  type DelegationAcceptanceVerdict,
  type DelegationEvaluationAuthor,
  type DelegationEvaluationKind,
  type DelegationJobState,
  type DelegationRefusalReason,
  type DelegationReleaseEvidence,
  type DelegationRouteBlocker,
  type DelegationVerificationVerdict,
  holdsDelegationReservation,
  isLiveDelegationState,
} from './delegation-vocabulary';
import { normalizeIsoTimestamp } from './provider-status';
import { isPrintableSkillObservationText } from './skill-observation';

/**
 * The stored delegation job and its evaluations: strict re-validation on the way out of the store
 * (a row that fails is counted, never shown), the evaluation input an edge accepts from a caller
 * (the author comes from the edge, never from the payload), and the bounded view MCP, CLI and Web
 * read. Execution, verification and acceptance stay three different facts throughout.
 */
export const DELEGATION_JOB_BOUNDS = {
  /** Evaluations of one kind the view lists. */
  maxEvaluationsInView: 20,
  /** Excluded routes the view lists from the qualification snapshot. */
  maxExcludedRoutesInView: 12,
  maxFailureReasonCharacters: 2000,
  maxGuaranteeEntries: 32,
  maxGuaranteeEntryCharacters: 300,
  /** `jobId`, `retryOf`, `qualificationId`, `routeId`, `poolId`, `nativeSessionId`, `launchMarker`, digests. */
  maxIdCharacters: 512,
  /** Files the executed scope lists; `fileCount` keeps the total. */
  maxScopeFiles: 256,
  maxScopePathCharacters: 1024,
  /** An abstention's free note. */
  maxSelectionNoteCharacters: 2000,
  /** `machineId`, `accountScope`, models, effort, versions, author labels. */
  maxTextCharacters: 256,
} as const;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

const isOneOf = <const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(record).every((key) => keys.has(key));

const hasEveryKey = (record: Record<string, unknown>, keys: ReadonlySet<string>): boolean => {
  for (const key of keys) {
    if (!(key in record)) {
      return false;
    }
  }
  return true;
};

const hasExactKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  hasOnlyKeys(record, keys) && hasEveryKey(record, keys);

const isRenderableMultilineText = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return false;
    }
  }
  return true;
};

const isLineText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  isPrintableSkillObservationText(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => isNonNegativeInteger(value) && value > 0;

/** `undefined` marks an invalid value; `null` is a valid absence. */
const optionalLine = (value: unknown, maximum: number): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return isLineText(value, maximum) ? value : undefined;
};
const optionalMultiline = (value: unknown, maximum: number): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && value.length <= maximum && isRenderableMultilineText(value) ? value : undefined;
};
const optionalInstant = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  const instant = typeof value === 'string' ? normalizeIsoTimestamp(value) : null;
  return instant === null ? undefined : instant;
};
const optionalCount = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }
  return isNonNegativeInteger(value) ? value : undefined;
};
const optionalInteger = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
};
const optionalOneOf = <const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): Values[number] | null | undefined => {
  if (value === null) {
    return null;
  }
  return isOneOf(values, value) ? value : undefined;
};
const optionalParsed = <Value>(value: unknown, parse: (input: unknown) => Value | null): Value | null | undefined => {
  if (value === null) {
    return null;
  }
  return parse(value) ?? undefined;
};

const parseLineList = (value: unknown, maxItems: number, maxCharacters: number): readonly string[] | null => {
  if (!Array.isArray(value) || value.length > maxItems) {
    return null;
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (!isLineText(entry, maxCharacters)) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
};

// ---------------------------------------------------------------------------------------------
// Nested facts
// ---------------------------------------------------------------------------------------------

const CLIENT_KEYS = ['correlationId', 'name', 'sessionRef'] as const;

const parseStoredScopeRequest = (value: unknown): DelegationScopeRequest | null => {
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    return null;
  }
  // A refused decision keeps the request it refused, so a reserved kind stays readable as its name.
  if (value.kind === 'commit' && isLineText(value.commit, DELEGATION_BOUNDS.maxRevisionCharacters)) {
    return { commit: value.commit, kind: 'commit' };
  }
  if (
    value.kind === 'range' &&
    isLineText(value.base, DELEGATION_BOUNDS.maxRevisionCharacters) &&
    isLineText(value.head, DELEGATION_BOUNDS.maxRevisionCharacters)
  ) {
    return { base: value.base, head: value.head, kind: 'range' };
  }
  if (isLineText(value.kind, DELEGATION_JOB_BOUNDS.maxTextCharacters) && !isOneOf(DELEGATION_SCOPE_KINDS, value.kind)) {
    return { kind: value.kind } as unknown as DelegationScopeRequest;
  }
  return null;
};

const parseStoredClient = (value: unknown): DelegationRequest['client'] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const client: { correlationId?: string; name?: string; sessionRef?: string } = {};
  const bounds = {
    correlationId: DELEGATION_BOUNDS.maxClientCorrelationCharacters,
    name: DELEGATION_BOUNDS.maxClientNameCharacters,
    sessionRef: DELEGATION_BOUNDS.maxClientSessionRefCharacters,
  } as const;
  for (const key of CLIENT_KEYS) {
    const entry = value[key];
    if (entry === undefined) {
      continue;
    }
    if (!isLineText(entry, bounds[key])) {
      return null;
    }
    client[key] = entry;
  }
  return client;
};

/**
 * The stored request, checked for shape and bounds: its deep validation (revision syntax, action
 * support) was the producer's job before the row existed, and a refused row must keep the request
 * it refused, reserved action or scope kind included. Keys this version does not know are dropped.
 */
const parseStoredDelegationRequest = (value: unknown): DelegationRequest | null => {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null;
  }
  const scope = parseStoredScopeRequest(value.scope);
  const criteria = parseLineList(
    value.criteria,
    DELEGATION_BOUNDS.maxCriteria,
    DELEGATION_BOUNDS.maxCriterionCharacters,
  );
  const constraints = parseLineList(
    value.constraints,
    DELEGATION_BOUNDS.maxConstraints,
    DELEGATION_BOUNDS.maxConstraintCharacters,
  );
  const client = parseStoredClient(value.client);
  let retryOf: string | undefined;
  let retryOfValid = true;
  if (value.retryOf !== undefined) {
    if (isLineText(value.retryOf, DELEGATION_JOB_BOUNDS.maxIdCharacters)) {
      retryOf = value.retryOf;
    } else {
      retryOfValid = false;
    }
  }
  if (
    !(
      isLineText(value.action, DELEGATION_JOB_BOUNDS.maxTextCharacters) &&
      isLineText(value.taskCategory, DELEGATION_JOB_BOUNDS.maxTextCharacters) &&
      typeof value.objective === 'string' &&
      value.objective.trim().length > 0 &&
      value.objective.length <= DELEGATION_BOUNDS.maxObjectiveCharacters &&
      isRenderableMultilineText(value.objective) &&
      isRecord(value.checkout) &&
      isLineText(value.checkout.path, DELEGATION_BOUNDS.maxCheckoutPathCharacters) &&
      value.checkout.path.startsWith('/')
    ) ||
    scope === null ||
    criteria === null ||
    constraints === null ||
    client === null ||
    !retryOfValid
  ) {
    return null;
  }
  const request: DelegationRequest = {
    action: value.action as DelegationRequest['action'],
    checkout: { path: value.checkout.path },
    constraints,
    criteria,
    objective: value.objective,
    schemaVersion: 1,
    scope,
    taskCategory: value.taskCategory as DelegationRequest['taskCategory'],
    ...(client === undefined ? {} : { client }),
    ...(retryOf === undefined ? {} : { retryOf }),
  };
  return request;
};

/** The qualification snapshot is kept opaque beyond its version and id; the qualifier re-validates it. */
const parseStoredQualification = (value: unknown): DelegationQualification | null => {
  if (
    !(
      isRecord(value) &&
      value.schemaVersion === 1 &&
      isLineText(value.qualificationId, DELEGATION_JOB_BOUNDS.maxIdCharacters)
    )
  ) {
    return null;
  }
  return value as unknown as DelegationQualification;
};

/**
 * A stored selection is re-validated with the same parser that admitted it at the edge
 * (`delegation-request.ts`), so a read never accepts what a write would have refused.
 */
const parseStoredSelection = (value: unknown): DelegationSelection | null => {
  const parsed = parseDelegationSelection(value);
  return parsed.kind === 'ok' ? parsed.selection : null;
};

const FROZEN_SCOPE_KEYS: ReadonlySet<string> = new Set([
  'base',
  'baseRef',
  'baseSha',
  'commitCount',
  'headRef',
  'headSha',
  'kind',
]);

/** Strict re-validation of a frozen scope: object ids of one format, a base consistent with the kind. */
export const parseFrozenDelegationScope = (value: unknown): FrozenDelegationScope | null => {
  if (!(isRecord(value) && hasExactKeys(value, FROZEN_SCOPE_KEYS))) {
    return null;
  }
  const { base, baseRef, baseSha, commitCount, headRef, headSha, kind } = value;
  const baseConsistent =
    kind === 'commit' ? base === 'empty-tree' || base === 'first-parent' : kind === 'range' && base === 'range-base';
  const parsedBaseRef = optionalLine(baseRef, DELEGATION_BOUNDS.maxRevisionCharacters);
  if (
    !(
      isOneOf(DELEGATION_SCOPE_KINDS, kind) &&
      baseConsistent &&
      typeof baseSha === 'string' &&
      OBJECT_ID.test(baseSha) &&
      typeof headSha === 'string' &&
      OBJECT_ID.test(headSha) &&
      baseSha.length === headSha.length &&
      isPositiveInteger(commitCount) &&
      isLineText(headRef, DELEGATION_BOUNDS.maxRevisionCharacters)
    ) ||
    parsedBaseRef === undefined
  ) {
    return null;
  }
  return {
    base: base as FrozenDelegationScope['base'],
    baseRef: parsedBaseRef,
    baseSha,
    commitCount,
    headRef,
    headSha,
    kind,
  };
};

const EXECUTED_SCOPE_KEYS: ReadonlySet<string> = new Set([
  'fileCount',
  'files',
  'includedBytes',
  'patchBytes',
  'patchSha256',
  'truncated',
  'workingTreeDirty',
]);
const EXECUTED_FILE_KEYS: ReadonlySet<string> = new Set(['coverage', 'path']);
const FILE_COVERAGES = ['binary', 'complete', 'omitted', 'partial'] as const;

/** Strict re-validation of the scope a worker actually received; a patch cut short is always declared truncated. */
export const parseDelegationExecutedScope = (value: unknown): DelegationExecutedScope | null => {
  if (!(isRecord(value) && hasExactKeys(value, EXECUTED_SCOPE_KEYS))) {
    return null;
  }
  const { fileCount, files, includedBytes, patchBytes, patchSha256, truncated, workingTreeDirty } = value;
  if (
    !(
      isNonNegativeInteger(fileCount) &&
      isNonNegativeInteger(includedBytes) &&
      isNonNegativeInteger(patchBytes) &&
      includedBytes <= patchBytes &&
      typeof truncated === 'boolean' &&
      (includedBytes === patchBytes || truncated) &&
      typeof workingTreeDirty === 'boolean' &&
      typeof patchSha256 === 'string' &&
      SHA256_HEX.test(patchSha256) &&
      Array.isArray(files) &&
      files.length <= DELEGATION_JOB_BOUNDS.maxScopeFiles &&
      files.length <= fileCount
    )
  ) {
    return null;
  }
  const parsedFiles: { coverage: DelegationExecutedScope['files'][number]['coverage']; path: string }[] = [];
  for (const entry of files) {
    if (
      !(
        isRecord(entry) &&
        hasExactKeys(entry, EXECUTED_FILE_KEYS) &&
        isOneOf(FILE_COVERAGES, entry.coverage) &&
        isLineText(entry.path, DELEGATION_JOB_BOUNDS.maxScopePathCharacters)
      )
    ) {
      return null;
    }
    parsedFiles.push({ coverage: entry.coverage, path: entry.path });
  }
  return { fileCount, files: parsedFiles, includedBytes, patchBytes, patchSha256, truncated, workingTreeDirty };
};

const GUARANTEE_KEYS: ReadonlySet<string> = new Set(['cliVersion', 'controls', 'effort', 'harness', 'limits', 'model']);

/** Strict re-validation of the launched harness's guarantee: what it was allowed to do, and what that does not cover. */
export const parseDelegationHarnessGuarantee = (value: unknown): DelegationHarnessGuarantee | null => {
  if (!(isRecord(value) && hasExactKeys(value, GUARANTEE_KEYS))) {
    return null;
  }
  const controls = parseLineList(
    value.controls,
    DELEGATION_JOB_BOUNDS.maxGuaranteeEntries,
    DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters,
  );
  const limits = parseLineList(
    value.limits,
    DELEGATION_JOB_BOUNDS.maxGuaranteeEntries,
    DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters,
  );
  const effort = optionalLine(value.effort, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const model = optionalLine(value.model, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  if (
    !(
      isLineText(value.cliVersion, DELEGATION_JOB_BOUNDS.maxTextCharacters) &&
      isOneOf(DELEGATION_EXECUTOR_HARNESSES, value.harness)
    ) ||
    controls === null ||
    limits === null ||
    effort === undefined ||
    model === undefined
  ) {
    return null;
  }
  return { cliVersion: value.cliVersion, controls, effort, harness: value.harness, limits, model };
};

const USAGE_KEYS: ReadonlySet<string> = new Set(['cachedInputTokens', 'inputTokens', 'outputTokens', 'source']);

const parseDelegationUsage = (value: unknown): DelegationUsage | null => {
  if (!(isRecord(value) && hasExactKeys(value, USAGE_KEYS)) || value.source !== 'harness-reported') {
    return null;
  }
  const cachedInputTokens = optionalCount(value.cachedInputTokens);
  const inputTokens = optionalCount(value.inputTokens);
  const outputTokens = optionalCount(value.outputTokens);
  if (cachedInputTokens === undefined || inputTokens === undefined || outputTokens === undefined) {
    return null;
  }
  return { cachedInputTokens, inputTokens, outputTokens, source: 'harness-reported' };
};

const RESULT_KEYS: ReadonlySet<string> = new Set(['excerpt', 'kind', 'review']);

/** Strict re-validation of a stored result: a `review` kind carries the parsed review, every other kind carries none. */
export const parseDelegationJobResult = (value: unknown): DelegationJobResult | null => {
  if (!(isRecord(value) && hasExactKeys(value, RESULT_KEYS) && isOneOf(DELEGATION_RESULT_KINDS, value.kind))) {
    return null;
  }
  const excerpt = optionalMultiline(value.excerpt, DELEGATION_RESULT_BOUNDS.maxExcerptCharacters);
  const review = optionalParsed(value.review, parseDelegationReviewResult);
  if (excerpt === undefined || review === undefined || (value.kind === 'review') !== (review !== null)) {
    return null;
  }
  return { excerpt, kind: value.kind, review };
};

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

const JOB_KEYS: ReadonlySet<string> = new Set([
  'accountScope',
  'action',
  'attemptNumber',
  'cancelRequestedAt',
  'checkoutPath',
  'context',
  'effort',
  'endedAt',
  'executedScope',
  'executorHarness',
  'exitCode',
  'failureReason',
  'guarantee',
  'harnessVersion',
  'idempotencyKey',
  'jobId',
  'launchMarker',
  'machineId',
  'modelRequested',
  'modelResolved',
  'nativeSessionId',
  'pid',
  'poolId',
  'qualification',
  'qualificationId',
  'refusalReason',
  'releasedAt',
  'releaseEvidence',
  'request',
  'requestDigest',
  'requestedAt',
  'result',
  'retryOf',
  'routeId',
  'scope',
  'selection',
  'startedAt',
  'state',
  'taskCategory',
  'traceVersion',
  'updatedAt',
  'usage',
]);

const optionalCheckoutPath = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return isLineText(value, DELEGATION_BOUNDS.maxCheckoutPathCharacters) && value.startsWith('/') ? value : undefined;
};

/**
 * Strict re-validation of one stored job. Every vocabulary value is checked, the nested facts are
 * re-parsed, and two consistency rules hold: a refusal reason exactly on a refused row, and release
 * facts (instant and evidence) as a pair only on a lost row. The request is checked for shape and
 * bounds, the qualification snapshot for its version and id; their deep validation is the producer's.
 */
export const parseDelegationJob = (value: unknown): DelegationJob | null => {
  if (!(isRecord(value) && hasExactKeys(value, JOB_KEYS))) {
    return null;
  }
  const state = value.state;
  if (!isOneOf(DELEGATION_JOB_STATES, state)) {
    return null;
  }
  const request = parseStoredDelegationRequest(value.request);
  const qualification = optionalParsed(value.qualification, parseStoredQualification);
  const selection = optionalParsed(value.selection, parseStoredSelection);
  const scope = optionalParsed(value.scope, parseFrozenDelegationScope);
  const executedScope = optionalParsed(value.executedScope, parseDelegationExecutedScope);
  const guarantee = optionalParsed(value.guarantee, parseDelegationHarnessGuarantee);
  const usage = optionalParsed(value.usage, parseDelegationUsage);
  const result = optionalParsed(value.result, parseDelegationJobResult);
  const requestedAt = optionalInstant(value.requestedAt);
  const updatedAt = optionalInstant(value.updatedAt);
  const startedAt = optionalInstant(value.startedAt);
  const endedAt = optionalInstant(value.endedAt);
  const cancelRequestedAt = optionalInstant(value.cancelRequestedAt);
  const releasedAt = optionalInstant(value.releasedAt);
  const releaseEvidence = optionalOneOf(DELEGATION_RELEASE_EVIDENCE, value.releaseEvidence);
  const refusalReason = optionalOneOf(DELEGATION_REFUSAL_REASONS, value.refusalReason);
  const context = optionalOneOf(DELEGATION_CONTEXTS, value.context);
  const executorHarness = optionalOneOf(DELEGATION_EXECUTOR_HARNESSES, value.executorHarness);
  const checkoutPath = optionalCheckoutPath(value.checkoutPath);
  const accountScope = optionalLine(value.accountScope, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const effort = optionalLine(value.effort, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const modelRequested = optionalLine(value.modelRequested, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const modelResolved = optionalLine(value.modelResolved, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const harnessVersion = optionalLine(value.harnessVersion, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const launchMarker = optionalLine(value.launchMarker, DELEGATION_JOB_BOUNDS.maxIdCharacters);
  const nativeSessionId = optionalLine(value.nativeSessionId, DELEGATION_JOB_BOUNDS.maxIdCharacters);
  const poolId = optionalLine(value.poolId, DELEGATION_JOB_BOUNDS.maxIdCharacters);
  const qualificationId = optionalLine(value.qualificationId, DELEGATION_JOB_BOUNDS.maxIdCharacters);
  const retryOf = optionalLine(value.retryOf, DELEGATION_JOB_BOUNDS.maxIdCharacters);
  const routeId = optionalLine(value.routeId, DELEGATION_JOB_BOUNDS.maxIdCharacters);
  const failureReason = optionalMultiline(value.failureReason, DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters);
  const exitCode = optionalInteger(value.exitCode);
  const pid = optionalCount(value.pid);
  if (
    request === null ||
    qualification === undefined ||
    selection === undefined ||
    scope === undefined ||
    executedScope === undefined ||
    guarantee === undefined ||
    usage === undefined ||
    result === undefined ||
    requestedAt === null ||
    requestedAt === undefined ||
    updatedAt === null ||
    updatedAt === undefined ||
    startedAt === undefined ||
    endedAt === undefined ||
    cancelRequestedAt === undefined ||
    releasedAt === undefined ||
    releaseEvidence === undefined ||
    refusalReason === undefined ||
    context === undefined ||
    executorHarness === undefined ||
    checkoutPath === undefined ||
    accountScope === undefined ||
    effort === undefined ||
    modelRequested === undefined ||
    modelResolved === undefined ||
    harnessVersion === undefined ||
    launchMarker === undefined ||
    nativeSessionId === undefined ||
    poolId === undefined ||
    qualificationId === undefined ||
    retryOf === undefined ||
    routeId === undefined ||
    failureReason === undefined ||
    exitCode === undefined ||
    pid === undefined ||
    !isLineText(value.jobId, DELEGATION_JOB_BOUNDS.maxIdCharacters) ||
    !isLineText(value.machineId, DELEGATION_JOB_BOUNDS.maxTextCharacters) ||
    !(typeof value.idempotencyKey === 'string' && DELEGATION_IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) ||
    !isLineText(value.requestDigest, DELEGATION_JOB_BOUNDS.maxIdCharacters) ||
    !isLineText(value.action, DELEGATION_JOB_BOUNDS.maxTextCharacters) ||
    !isLineText(value.taskCategory, DELEGATION_JOB_BOUNDS.maxTextCharacters) ||
    !isPositiveInteger(value.attemptNumber) ||
    !isPositiveInteger(value.traceVersion) ||
    (refusalReason === null) !== (state !== 'refused') ||
    (releasedAt === null) !== (releaseEvidence === null) ||
    (releasedAt !== null && state !== 'lost')
  ) {
    return null;
  }
  return {
    accountScope,
    action: value.action,
    attemptNumber: value.attemptNumber,
    cancelRequestedAt,
    checkoutPath,
    context,
    effort,
    endedAt,
    executedScope,
    executorHarness,
    exitCode,
    failureReason,
    guarantee,
    harnessVersion,
    idempotencyKey: value.idempotencyKey,
    jobId: value.jobId,
    launchMarker,
    machineId: value.machineId,
    modelRequested,
    modelResolved,
    nativeSessionId,
    pid,
    poolId,
    qualification,
    qualificationId,
    refusalReason,
    releasedAt,
    releaseEvidence,
    request,
    requestDigest: value.requestDigest,
    requestedAt,
    result,
    retryOf,
    routeId,
    scope,
    selection,
    startedAt,
    state,
    taskCategory: value.taskCategory,
    traceVersion: value.traceVersion,
    updatedAt,
    usage,
  };
};

// ---------------------------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------------------------

const EVALUATION_KEYS: ReadonlySet<string> = new Set([
  'author',
  'authorLabel',
  'checks',
  'evaluationId',
  'jobId',
  'kind',
  'note',
  'recordedAt',
  'verdict',
]);

/** A verification verdict only with `verification`, an acceptance verdict only with `acceptance`. */
export const isDelegationVerdictForKind = (
  kind: DelegationEvaluationKind,
  verdict: unknown,
): verdict is DelegationEvaluation['verdict'] =>
  kind === 'verification'
    ? isOneOf(DELEGATION_VERIFICATION_VERDICTS, verdict)
    : isOneOf(DELEGATION_ACCEPTANCE_VERDICTS, verdict);

/** Strict re-validation of one stored evaluation. */
export const parseDelegationEvaluation = (value: unknown): DelegationEvaluation | null => {
  if (!(isRecord(value) && hasExactKeys(value, EVALUATION_KEYS))) {
    return null;
  }
  const { author, authorLabel: label, checks, evaluationId, jobId, kind, note, recordedAt, verdict } = value;
  const authorLabel = optionalLine(label, DELEGATION_JOB_BOUNDS.maxTextCharacters);
  const parsedNote = optionalMultiline(note, DELEGATION_BOUNDS.maxEvaluationNoteCharacters);
  const parsedChecks = parseLineList(
    checks,
    DELEGATION_BOUNDS.maxEvaluationChecks,
    DELEGATION_BOUNDS.maxEvaluationCheckCharacters,
  );
  const instant = optionalInstant(recordedAt);
  if (
    !(
      isOneOf(DELEGATION_EVALUATION_AUTHORS, author) &&
      isOneOf(DELEGATION_EVALUATION_KINDS, kind) &&
      isDelegationVerdictForKind(kind, verdict) &&
      isLineText(evaluationId, DELEGATION_JOB_BOUNDS.maxIdCharacters) &&
      isLineText(jobId, DELEGATION_JOB_BOUNDS.maxIdCharacters)
    ) ||
    authorLabel === undefined ||
    parsedNote === undefined ||
    parsedChecks === null ||
    instant === null ||
    instant === undefined
  ) {
    return null;
  }
  return {
    author,
    authorLabel,
    checks: parsedChecks,
    evaluationId,
    jobId,
    kind,
    note: parsedNote,
    recordedAt: instant,
    verdict,
  };
};

/** What an edge records for a job: the payload's judgment, the edge's author. */
export interface DelegationEvaluationInput {
  readonly author: DelegationEvaluationAuthor;
  readonly authorLabel: string | null;
  readonly checks: readonly string[];
  readonly kind: DelegationEvaluationKind;
  readonly note: string | null;
  readonly verdict: DelegationAcceptanceVerdict | DelegationVerificationVerdict;
}

export type DelegationEvaluationInputResult =
  | { readonly evaluation: DelegationEvaluationInput; readonly kind: 'ok' }
  | { readonly issues: readonly string[]; readonly kind: 'invalid' };

const EVALUATION_INPUT_KEYS: ReadonlySet<string> = new Set(['checks', 'kind', 'note', 'verdict']);

/**
 * Validates a caller's evaluation payload (`kind`, `verdict`, optional `note` and `checks`). The
 * author and its label come from the edge that received the payload, never from the payload: a
 * payload naming an author is invalid, so a model cannot record an acceptance as the operator's.
 */
export const parseDelegationEvaluationInput = (
  value: unknown,
  edge: { readonly author: DelegationEvaluationAuthor; readonly authorLabel: string | null },
): DelegationEvaluationInputResult => {
  if (!isRecord(value)) {
    return { issues: ['evaluation must be an object with kind and verdict'], kind: 'invalid' };
  }
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if (key === 'author' || key === 'authorLabel') {
      issues.push(`${key} is set by the recording edge, not by the payload`);
    } else if (!EVALUATION_INPUT_KEYS.has(key)) {
      issues.push(`unknown field: ${key}`);
    }
  }
  const { checks, kind, note, verdict } = value;
  if (!isOneOf(DELEGATION_EVALUATION_KINDS, kind)) {
    issues.push(`kind must be one of ${DELEGATION_EVALUATION_KINDS.join(', ')}`);
  } else if (!isDelegationVerdictForKind(kind, verdict)) {
    const verdicts = kind === 'verification' ? DELEGATION_VERIFICATION_VERDICTS : DELEGATION_ACCEPTANCE_VERDICTS;
    issues.push(`verdict must be one of ${verdicts.join(', ')} for a ${kind}`);
  }
  const parsedNote = note === undefined ? null : optionalMultiline(note, DELEGATION_BOUNDS.maxEvaluationNoteCharacters);
  if (parsedNote === undefined) {
    issues.push(`note must be text of at most ${DELEGATION_BOUNDS.maxEvaluationNoteCharacters} characters`);
  }
  const parsedChecks =
    checks === undefined
      ? []
      : parseLineList(checks, DELEGATION_BOUNDS.maxEvaluationChecks, DELEGATION_BOUNDS.maxEvaluationCheckCharacters);
  if (parsedChecks === null) {
    issues.push(
      `checks must be at most ${DELEGATION_BOUNDS.maxEvaluationChecks} lines of at most ${DELEGATION_BOUNDS.maxEvaluationCheckCharacters} characters`,
    );
  }
  if (issues.length > 0 || !isOneOf(DELEGATION_EVALUATION_KINDS, kind) || !isDelegationVerdictForKind(kind, verdict)) {
    return { issues, kind: 'invalid' };
  }
  const label = edge.authorLabel?.replace(/\s+/gu, ' ').trim() ?? '';
  return {
    evaluation: {
      author: edge.author,
      authorLabel: label.length === 0 ? null : label.slice(0, DELEGATION_JOB_BOUNDS.maxTextCharacters),
      checks: parsedChecks ?? [],
      kind,
      note: parsedNote ?? null,
      verdict,
    },
    kind: 'ok',
  };
};

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

export interface DelegationEvaluationView {
  readonly author: DelegationEvaluationAuthor;
  readonly authorLabel: string | null;
  readonly checks: readonly string[];
  readonly evaluationId: string;
  readonly kind: DelegationEvaluationKind;
  readonly note: string | null;
  readonly recordedAt: string;
  readonly verdict: DelegationAcceptanceVerdict | DelegationVerificationVerdict;
}

export type DelegationExecutionStatus = 'cancelled' | 'failed' | 'not-run' | 'running' | 'succeeded' | 'unknown';

export interface DelegationJobView {
  readonly attemptNumber: number;
  readonly cancelRequestedAt: string | null;
  readonly endedAt: string | null;
  readonly evaluations: {
    /** The latest acceptance recorded by the operator; a model's acceptance is its statement, listed below. */
    readonly acceptance: DelegationEvaluationView | null;
    readonly acceptances: readonly DelegationEvaluationView[];
    readonly automatedChecks: readonly DelegationEvaluationView[];
    readonly verifications: readonly DelegationEvaluationView[];
  };
  readonly executedScope: DelegationExecutedScope | null;
  /** The failure recorded on a job that was not refused; a refusal's message is under `refusal`. */
  readonly failure: string | null;
  /**
   * The scope as the engine froze it when the job was admitted: the object ids actually reviewed,
   * read from the record and never re-resolved, so a client reading after `HEAD` moved still knows
   * which revision the result is about. `null` when nothing was frozen (refused before the scope
   * was resolved) or when an older record carries none; it is never rebuilt from the checkout.
   */
  readonly frozenScope: FrozenDelegationScope | null;
  readonly guarantee: DelegationHarnessGuarantee | null;
  /** Seconds since the last heartbeat or transition, for live states; `null` otherwise. */
  readonly heartbeatAgeSeconds: number | null;
  readonly jobId: string;
  readonly live: boolean;
  readonly machineId: string;
  readonly notes: readonly string[];
  readonly qualification: {
    readonly admissibleRoutes: number;
    readonly catalogRevision: string | null;
    readonly excludedRoutes: readonly {
      readonly blockers: readonly DelegationRouteBlocker[];
      readonly routeId: string;
    }[];
    readonly omittedExcludedRoutes: number;
    readonly policyRevision: string | null;
    readonly qualificationId: string;
    readonly qualifiedAt: string | null;
  } | null;
  readonly refusal: { readonly message: string; readonly reason: DelegationRefusalReason } | null;
  readonly request: {
    readonly action: string;
    readonly checkoutPath: string;
    readonly constraints: readonly string[];
    readonly criteria: readonly string[];
    readonly objective: string;
    readonly scope: DelegationScopeRequest;
    readonly taskCategory: string;
  };
  readonly requestedAt: string;
  readonly reservation: {
    readonly evidence: DelegationReleaseEvidence | null;
    readonly held: boolean;
    readonly releasedAt: string | null;
  };
  readonly result: {
    readonly checks: readonly string[];
    readonly coverage: DelegationReviewResult['coverage'] | null;
    readonly excerpt: string | null;
    readonly findings: DelegationReviewResult['findings'];
    readonly kind: DelegationJobResult['kind'];
    readonly limits: readonly string[];
    readonly summary: string | null;
  } | null;
  readonly retryOf: string | null;
  readonly route: {
    readonly accountScope: string | null;
    readonly context: DelegationJob['context'];
    readonly effort: string | null;
    readonly harness: DelegationJob['executorHarness'];
    readonly harnessVersion: string | null;
    readonly modelRequested: string | null;
    /** `unknown` when the harness did not report the model it ran. */
    readonly modelResolved: string;
    readonly poolId: string | null;
    readonly routeId: string;
  } | null;
  readonly selection: DelegationSelection | null;
  readonly startedAt: string | null;
  readonly state: DelegationJobState;
  readonly status: {
    readonly accepted: 'pending' | DelegationAcceptanceVerdict;
    readonly executed: DelegationExecutionStatus;
    readonly verified: 'not-verified' | DelegationVerificationVerdict;
  };
  /**
   * What the byte bound cut from this view; the store keeps the whole record. Every counter is a
   * number of entries omitted from the list it names, except `characters`, the characters cut from
   * the free texts (objective, summary, excerpt, coverage, notes, failure and refusal messages,
   * finding details) as a last resort. `evaluations` counts the verifications and acceptances not
   * listed: the oldest go first, and the latest operator acceptance is always listed. Excluded routes
   * left out of the qualification summary are counted in `qualification.omittedExcludedRoutes`.
   */
  readonly truncation: {
    readonly automatedChecks: number;
    readonly characters: number;
    readonly constraints: number;
    readonly criteria: number;
    /** Check lines omitted from the listed evaluations. */
    readonly evaluationChecks: number;
    readonly evaluations: number;
    readonly evidence: number;
    readonly findings: number;
    readonly guaranteeControls: number;
    readonly guaranteeLimits: number;
    readonly notReviewed: number;
    /** Rationale lines omitted from a selector's choice. */
    readonly rationale: number;
    readonly resultChecks: number;
    readonly resultLimits: number;
    /** Scope files omitted from `executedScope.files`; `executedScope.fileCount` keeps the total. */
    readonly scopeFiles: number;
  };
  readonly updatedAt: string;
  readonly usage: DelegationUsage | null;
}

/**
 * Thrown when no admissible reduction brings a view under `DELEGATION_BOUNDS.maxJobViewBytes`. By
 * construction it is unreachable for a record the parsers admit (every list can be emptied and every
 * free text cut to one character; what is left is bounded by the field bounds well under the
 * budget), so reaching it means the field bounds changed without this projection.
 */
export class DelegationJobViewBoundError extends Error {
  readonly bytes: number;
  readonly jobId: string;
  override readonly name = 'DelegationJobViewBoundError';

  constructor(jobId: string, bytes: number) {
    super(
      `The delegation job view stays at ${bytes} bytes after every reduction, over its bound of ${DELEGATION_BOUNDS.maxJobViewBytes}.`,
    );
    this.bytes = bytes;
    this.jobId = jobId;
  }
}

export interface DelegationJobViewOptions {
  readonly now: string;
}

const EXECUTION_STATUS: Readonly<Record<DelegationJobState, DelegationExecutionStatus>> = {
  abstained: 'not-run',
  cancelled: 'cancelled',
  failed: 'failed',
  finished: 'succeeded',
  lost: 'unknown',
  refused: 'not-run',
  requested: 'not-run',
  running: 'running',
  starting: 'running',
};

const newestFirst = (evaluations: readonly DelegationEvaluation[]): DelegationEvaluation[] =>
  [...evaluations].sort(
    (left, right) =>
      right.recordedAt.localeCompare(left.recordedAt) || right.evaluationId.localeCompare(left.evaluationId),
  );

type ExcludedRouteSummary = NonNullable<DelegationJobView['qualification']>['excludedRoutes'][number];

/** The excluded routes a qualification snapshot carries, read defensively: the snapshot is opaque to the job parser. */
const excludedRoutesOf = (qualification: DelegationQualification | null): readonly ExcludedRouteSummary[] => {
  const raw = qualification as unknown as Record<string, unknown> | null;
  const routes = raw !== null && Array.isArray(raw.routes) ? raw.routes : [];
  const excluded: { blockers: DelegationRouteBlocker[]; routeId: string }[] = [];
  for (const route of routes) {
    if (!(isRecord(route) && route.admissible === false && typeof route.routeId === 'string')) {
      continue;
    }
    const blockers = Array.isArray(route.blockers)
      ? route.blockers.filter((blocker): blocker is DelegationRouteBlocker => typeof blocker === 'string')
      : [];
    excluded.push({ blockers, routeId: route.routeId });
  }
  return excluded;
};

/**
 * The qualification snapshot is opaque to the job parser, so the view reads it defensively. `shown`
 * is how many excluded routes the view lists; the rest are counted in `omittedExcludedRoutes`.
 */
const summarizeQualification = (
  qualification: DelegationQualification | null,
  shown: number,
): DelegationJobView['qualification'] => {
  if (qualification === null) {
    return null;
  }
  const raw = qualification as unknown as Record<string, unknown>;
  const versions = isRecord(raw.versions) ? raw.versions : {};
  const excluded = excludedRoutesOf(qualification);
  const admissibleIds = Array.isArray(raw.admissibleRouteIds) ? raw.admissibleRouteIds.length : 0;
  return {
    admissibleRoutes: admissibleIds,
    catalogRevision: typeof versions.catalogRevision === 'string' ? versions.catalogRevision : null,
    excludedRoutes: excluded
      .slice(0, shown)
      .map((route) => ({ blockers: [...route.blockers], routeId: route.routeId })),
    omittedExcludedRoutes: Math.max(0, excluded.length - shown),
    policyRevision: typeof versions.policyRevision === 'string' ? versions.policyRevision : null,
    qualificationId: qualification.qualificationId,
    qualifiedAt: typeof raw.qualifiedAt === 'string' ? raw.qualifiedAt : null,
  };
};

const heartbeatAge = (job: DelegationJob, now: string): number | null => {
  if (!isLiveDelegationState(job.state)) {
    return null;
  }
  const age = (Date.parse(now) - Date.parse(job.updatedAt)) / 1000;
  return Number.isFinite(age) ? Math.max(0, Math.floor(age)) : null;
};

/**
 * Every cut the byte bound may make, as entries dropped from the list each names, plus `prose`,
 * the character cap applied to every free text (`null` = none). Lists are cut from their tail
 * (evaluations: the oldest first; evidence: from the last kept finding backwards).
 */
interface ViewTrim {
  readonly acceptances: number;
  readonly automatedChecks: number;
  readonly constraints: number;
  readonly criteria: number;
  readonly evaluationChecks: number;
  readonly evidence: number;
  readonly excludedRoutes: number;
  readonly findings: number;
  readonly guaranteeControls: number;
  readonly guaranteeLimits: number;
  readonly notReviewed: number;
  readonly prose: number | null;
  readonly rationale: number;
  readonly resultChecks: number;
  readonly resultLimits: number;
  readonly scopeFiles: number;
  readonly verifications: number;
}

const NO_TRIM: ViewTrim = {
  acceptances: 0,
  automatedChecks: 0,
  constraints: 0,
  criteria: 0,
  evaluationChecks: 0,
  evidence: 0,
  excludedRoutes: 0,
  findings: 0,
  guaranteeControls: 0,
  guaranteeLimits: 0,
  notReviewed: 0,
  prose: null,
  rationale: 0,
  resultChecks: 0,
  resultLimits: 0,
  scopeFiles: 0,
  verifications: 0,
};

const isHighSurrogate = (unit: number): boolean => unit >= 0xd8_00 && unit <= 0xdb_ff;

/**
 * The first `limit` UTF-16 units of a text, never splitting a surrogate pair (the pair is kept when
 * the cut falls inside it). Shrinking `limit` never lengthens the result, which the search relies on.
 */
const clipText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, isHighSurrogate(text.charCodeAt(limit - 1)) ? limit + 1 : limit);
};

const dropTail = <Entry>(entries: readonly Entry[], count: number): Entry[] =>
  entries.slice(0, Math.max(0, entries.length - count));

/** The selection as the view carries it: a choice with `rationaleCut` lines dropped, an abstention with its note as `prose` keeps it. */
const trimmedSelection = (
  selection: DelegationSelection | null,
  rationaleCut: number,
  prose: (text: string) => string,
): DelegationSelection | null => {
  if (selection === null) {
    return null;
  }
  if (selection.kind === 'abstain') {
    return { ...selection, ...(selection.note === undefined ? {} : { note: prose(selection.note) }) };
  }
  return {
    ...selection,
    ...(selection.rationale === undefined ? {} : { rationale: dropTail(selection.rationale, rationaleCut) }),
  };
};

const EXECUTION_NOT_VERIFICATION =
  "A finished execution is not a verification: the result is the worker's statement until a verification records whether it holds.";
const VERIFICATION_NOT_ACCEPTANCE =
  'A verification is not an acceptance: only an acceptance records that the result was accepted, rejected or taken over.';

/** Short labels, so that the omission note stays within an edge's note bound with every counter set. */
const TRUNCATION_LABELS: Readonly<Record<keyof DelegationJobView['truncation'], string>> = {
  automatedChecks: 'automated checks',
  characters: 'free-text characters',
  constraints: 'constraints',
  criteria: 'criteria',
  evaluationChecks: 'evaluation checks',
  evaluations: 'evaluations',
  evidence: 'evidence entries',
  findings: 'findings',
  guaranteeControls: 'guarantee controls',
  guaranteeLimits: 'guarantee limits',
  notReviewed: 'notReviewed entries',
  rationale: 'rationale lines',
  resultChecks: 'result checks',
  resultLimits: 'result limits',
  scopeFiles: 'scope files',
};

const buildNotes = (job: DelegationJob, truncation: DelegationJobView['truncation']): string[] => {
  const notes = [EXECUTION_NOT_VERIFICATION, VERIFICATION_NOT_ACCEPTANCE];
  if (job.state === 'lost') {
    notes.push(
      holdsDelegationReservation(job)
        ? 'The engine lost contact with this job and nothing was relaunched; its reservation is held until release evidence is recorded.'
        : `The engine lost contact with this job and nothing was relaunched; its reservation was released (${job.releaseEvidence ?? 'evidence recorded'}).`,
    );
  }
  if (job.routeId !== null && job.startedAt !== null && job.modelResolved === null) {
    notes.push(
      'The harness did not report which model ran: the requested model is shown and the resolved model is unknown.',
    );
  }
  if (job.executedScope?.truncated === true) {
    notes.push('The worker received a truncated patch; its review is partial by construction.');
  }
  const omitted = (Object.keys(TRUNCATION_LABELS) as (keyof typeof TRUNCATION_LABELS)[])
    .filter((key) => truncation[key] > 0)
    .map((key) => `${truncation[key]} ${TRUNCATION_LABELS[key]}`);
  if (omitted.length > 0) {
    notes.push(
      `This view omitted ${omitted.join(', ')} to stay under its byte bound; the store keeps the whole record.`,
    );
  }
  return notes;
};

const viewBytes = (view: DelegationJobView): number => new TextEncoder().encode(JSON.stringify(view)).byteLength;

/**
 * The smallest cut in `0..available` after which `fits` holds, or `available` when none does. Valid
 * because a larger cut never produces a larger view, so `fits` is monotone in the cut.
 */
const smallestFittingCut = (available: number, fits: (cut: number) => boolean): number => {
  if (available <= 0 || fits(0)) {
    return 0;
  }
  if (!fits(available)) {
    return available;
  }
  let low = 0;
  let high = available;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
};

/** The listed evaluations at a trim, in list order; the checks cut counts down from the last listed one. */
interface ListedEvaluations {
  readonly acceptances: readonly DelegationEvaluation[];
  readonly automatedChecks: readonly DelegationEvaluation[];
  readonly verifications: readonly DelegationEvaluation[];
}

/**
 * The bounded, JSON-safe view of one job with its evaluations, as MCP, CLI and Web read it. The
 * status separates what ran (`executed`), what a verification found (`verified`) and what the
 * operator recorded (`accepted`); the notes say that no step implies the next. The status facts are
 * read from every evaluation, listed or not.
 *
 * The serialized JSON is kept under `DELEGATION_BOUNDS.maxJobViewBytes` (UTF-8 bytes) on every
 * return path. The reductions apply in this order, each only as far as needed and each counted in
 * `truncation`: scope files, criteria, constraints, excluded routes, rationale lines, the oldest
 * verifications, the older acceptances (never the latest operator acceptance), the oldest automated
 * checks, findings, evidence, the `notReviewed` list, result checks and limits, guarantee controls
 * and limits, the check lines of the listed evaluations, and last the free texts (cut to a common
 * character cap, never below one character). Identifiers, object ids, timestamps, the state, the
 * frozen scope, the refusal and failure facts and the route are never cut. What remains once every
 * list is empty and every free text is one character is bounded by the field bounds (for well-formed
 * strings, at most three UTF-8 bytes per UTF-16 unit) well under the budget, so the final guard is
 * unreachable for a record the parsers admit.
 */
export const projectDelegationJobView = (
  job: DelegationJob,
  evaluations: readonly DelegationEvaluation[],
  options: DelegationJobViewOptions,
): DelegationJobView => {
  const ordered = newestFirst(evaluations.filter((evaluation) => evaluation.jobId === job.jobId));
  const automated = ordered.filter((evaluation) => evaluation.author === 'automated-check');
  const verifications = ordered.filter(
    (evaluation) => evaluation.kind === 'verification' && evaluation.author !== 'automated-check',
  );
  const acceptances = ordered.filter(
    (evaluation) => evaluation.kind === 'acceptance' && evaluation.author !== 'automated-check',
  );
  const operatorAcceptance = acceptances.find((evaluation) => evaluation.author === 'operator') ?? null;
  const otherAcceptances = acceptances.filter((evaluation) => evaluation !== operatorAcceptance);
  // The list slots: the latest operator acceptance always takes one when it exists.
  const verificationSlots = Math.min(verifications.length, DELEGATION_JOB_BOUNDS.maxEvaluationsInView);
  const otherAcceptanceSlots = Math.min(
    otherAcceptances.length,
    DELEGATION_JOB_BOUNDS.maxEvaluationsInView - (operatorAcceptance === null ? 0 : 1),
  );
  const automatedSlots = Math.min(automated.length, DELEGATION_JOB_BOUNDS.maxEvaluationsInView);
  const excludedRouteSlots = Math.min(
    excludedRoutesOf(job.qualification).length,
    DELEGATION_JOB_BOUNDS.maxExcludedRoutesInView,
  );
  const latestVerification = verifications[0];
  const review = job.result?.review ?? null;
  const heartbeatAgeSeconds = heartbeatAge(job, options.now);

  const listedAt = (trim: ViewTrim): ListedEvaluations => {
    const keptOthers = new Set(dropTail(otherAcceptances.slice(0, otherAcceptanceSlots), trim.acceptances));
    return {
      acceptances: acceptances.filter((evaluation) => evaluation === operatorAcceptance || keptOthers.has(evaluation)),
      automatedChecks: dropTail(automated.slice(0, automatedSlots), trim.automatedChecks),
      verifications: dropTail(verifications.slice(0, verificationSlots), trim.verifications),
    };
  };
  const keptFindings = (trim: ViewTrim): DelegationReviewResult['findings'] =>
    review === null ? [] : dropTail(review.findings, trim.findings);
  const keptEvidenceCount = (trim: ViewTrim): number =>
    keptFindings(trim).reduce((count, finding) => count + finding.evidence.length, 0);
  const listedChecksCount = (trim: ViewTrim): number => {
    const listed = listedAt(trim);
    return [...listed.automatedChecks, ...listed.verifications, ...listed.acceptances].reduce(
      (count, evaluation) => count + evaluation.checks.length,
      0,
    );
  };

  const build = (trim: ViewTrim): DelegationJobView => {
    let characters = 0;
    const prose = (text: string): string => {
      if (trim.prose === null) {
        return text;
      }
      const kept = clipText(text, trim.prose);
      characters += text.length - kept.length;
      return kept;
    };
    const optionalProse = (text: string | null): string | null => (text === null ? null : prose(text));
    const listed = listedAt(trim);
    const listedOrder = [...listed.automatedChecks, ...listed.verifications, ...listed.acceptances];
    // Check lines go from the last listed evaluation backwards, one line at a time.
    const keptChecks = new Map<string, number>();
    let checksToDrop = trim.evaluationChecks;
    for (let index = listedOrder.length - 1; index >= 0; index--) {
      const evaluation = listedOrder[index];
      if (evaluation === undefined) {
        continue;
      }
      const drop = Math.min(checksToDrop, evaluation.checks.length);
      keptChecks.set(evaluation.evaluationId, evaluation.checks.length - drop);
      checksToDrop -= drop;
    }
    const evaluationView = (evaluation: DelegationEvaluation): DelegationEvaluationView => ({
      author: evaluation.author,
      authorLabel: evaluation.authorLabel,
      checks: evaluation.checks.slice(0, keptChecks.get(evaluation.evaluationId) ?? evaluation.checks.length),
      evaluationId: evaluation.evaluationId,
      kind: evaluation.kind,
      note: optionalProse(evaluation.note),
      recordedAt: evaluation.recordedAt,
      verdict: evaluation.verdict,
    });
    // One view per listed evaluation, so a text cut is counted once even where the view lists it twice.
    const views = new Map(listedOrder.map((evaluation) => [evaluation.evaluationId, evaluationView(evaluation)]));
    const viewOf = (evaluation: DelegationEvaluation): DelegationEvaluationView =>
      views.get(evaluation.evaluationId) ?? evaluationView(evaluation);
    const shownAcceptances = listed.acceptances.map(viewOf);
    const findings = keptFindings(trim).map((finding) => ({
      ...finding,
      detail: prose(finding.detail),
      evidence: [...finding.evidence],
    }));
    // Evidence goes from the last kept finding backwards, one entry at a time.
    let evidenceToDrop = trim.evidence;
    for (let index = findings.length - 1; index >= 0 && evidenceToDrop > 0; index--) {
      const finding = findings[index];
      if (finding === undefined) {
        continue;
      }
      const drop = Math.min(evidenceToDrop, finding.evidence.length);
      finding.evidence.splice(finding.evidence.length - drop, drop);
      evidenceToDrop -= drop;
    }
    const result: DelegationJobView['result'] =
      job.result === null
        ? null
        : {
            checks: review === null ? [] : dropTail(review.checks, trim.resultChecks),
            coverage:
              review === null
                ? null
                : {
                    notReviewed: dropTail(review.coverage.notReviewed, trim.notReviewed),
                    reviewed: prose(review.coverage.reviewed),
                  },
            excerpt: optionalProse(job.result.excerpt),
            findings,
            kind: job.result.kind,
            limits: review === null ? [] : dropTail(review.limits, trim.resultLimits),
            summary: review === null ? null : prose(review.summary),
          };
    const selection = trimmedSelection(job.selection, trim.rationale, prose);
    const truncation: DelegationJobView['truncation'] = {
      automatedChecks: automated.length - listed.automatedChecks.length,
      characters: 0,
      constraints: trim.constraints,
      criteria: trim.criteria,
      evaluationChecks: trim.evaluationChecks,
      evaluations:
        verifications.length - listed.verifications.length + (acceptances.length - listed.acceptances.length),
      evidence: trim.evidence,
      findings: trim.findings,
      guaranteeControls: trim.guaranteeControls,
      guaranteeLimits: trim.guaranteeLimits,
      notReviewed: trim.notReviewed,
      rationale: trim.rationale,
      resultChecks: trim.resultChecks,
      resultLimits: trim.resultLimits,
      scopeFiles: trim.scopeFiles,
    };
    const refusal =
      job.refusalReason === null
        ? null
        : { message: prose(job.failureReason ?? `refused: ${job.refusalReason}`), reason: job.refusalReason };
    const failure = job.refusalReason === null ? optionalProse(job.failureReason) : null;
    const objective = prose(job.request.objective);
    // The counter is read after every free text above went through `prose`.
    const counted: DelegationJobView['truncation'] = { ...truncation, characters };
    return {
      attemptNumber: job.attemptNumber,
      cancelRequestedAt: job.cancelRequestedAt,
      endedAt: job.endedAt,
      evaluations: {
        acceptance: operatorAcceptance === null ? null : viewOf(operatorAcceptance),
        acceptances: shownAcceptances,
        automatedChecks: listed.automatedChecks.map(viewOf),
        verifications: listed.verifications.map(viewOf),
      },
      executedScope:
        job.executedScope === null
          ? null
          : {
              ...job.executedScope,
              files: dropTail(job.executedScope.files, trim.scopeFiles).map((file) => ({ ...file })),
            },
      failure,
      frozenScope: job.scope === null ? null : { ...job.scope },
      guarantee:
        job.guarantee === null
          ? null
          : {
              ...job.guarantee,
              controls: dropTail(job.guarantee.controls, trim.guaranteeControls),
              limits: dropTail(job.guarantee.limits, trim.guaranteeLimits),
            },
      heartbeatAgeSeconds,
      jobId: job.jobId,
      live: isLiveDelegationState(job.state),
      machineId: job.machineId,
      notes: buildNotes(job, counted),
      qualification: summarizeQualification(job.qualification, excludedRouteSlots - trim.excludedRoutes),
      refusal,
      request: {
        action: job.request.action,
        checkoutPath: job.request.checkout.path,
        constraints: dropTail(job.request.constraints, trim.constraints),
        criteria: dropTail(job.request.criteria, trim.criteria),
        objective,
        scope: { ...job.request.scope },
        taskCategory: job.request.taskCategory,
      },
      requestedAt: job.requestedAt,
      reservation: { evidence: job.releaseEvidence, held: holdsDelegationReservation(job), releasedAt: job.releasedAt },
      result,
      retryOf: job.retryOf,
      route:
        job.routeId === null
          ? null
          : {
              accountScope: job.accountScope,
              context: job.context,
              effort: job.effort,
              harness: job.executorHarness,
              harnessVersion: job.harnessVersion,
              modelRequested: job.modelRequested,
              modelResolved: job.modelResolved ?? 'unknown',
              poolId: job.poolId,
              routeId: job.routeId,
            },
      selection,
      startedAt: job.startedAt,
      state: job.state,
      status: {
        accepted: operatorAcceptance === null ? 'pending' : (operatorAcceptance.verdict as DelegationAcceptanceVerdict),
        executed: EXECUTION_STATUS[job.state],
        verified:
          latestVerification === undefined
            ? 'not-verified'
            : (latestVerification.verdict as DelegationVerificationVerdict),
      },
      truncation: counted,
      updatedAt: job.updatedAt,
      usage: job.usage === null ? null : { ...job.usage },
    };
  };

  const fitsAt = (trim: ViewTrim): boolean => viewBytes(build(trim)) <= DELEGATION_BOUNDS.maxJobViewBytes;
  type CountedCut = Exclude<keyof ViewTrim, 'prose'>;
  /** The list cuts in the order they apply; each is tried only as far as the bound needs. */
  const steps: readonly { readonly available: (trim: ViewTrim) => number; readonly key: CountedCut }[] = [
    { available: () => job.executedScope?.files.length ?? 0, key: 'scopeFiles' },
    { available: () => job.request.criteria.length, key: 'criteria' },
    { available: () => job.request.constraints.length, key: 'constraints' },
    { available: () => excludedRouteSlots, key: 'excludedRoutes' },
    {
      available: () => (job.selection?.kind === 'choice' ? (job.selection.rationale?.length ?? 0) : 0),
      key: 'rationale',
    },
    { available: () => verificationSlots, key: 'verifications' },
    { available: () => otherAcceptanceSlots, key: 'acceptances' },
    { available: () => automatedSlots, key: 'automatedChecks' },
    { available: () => review?.findings.length ?? 0, key: 'findings' },
    { available: keptEvidenceCount, key: 'evidence' },
    { available: () => review?.coverage.notReviewed.length ?? 0, key: 'notReviewed' },
    { available: () => review?.checks.length ?? 0, key: 'resultChecks' },
    { available: () => review?.limits.length ?? 0, key: 'resultLimits' },
    { available: () => job.guarantee?.controls.length ?? 0, key: 'guaranteeControls' },
    { available: () => job.guarantee?.limits.length ?? 0, key: 'guaranteeLimits' },
    { available: listedChecksCount, key: 'evaluationChecks' },
  ];
  let applied = NO_TRIM;
  let view = build(applied);
  for (const step of steps) {
    if (viewBytes(view) <= DELEGATION_BOUNDS.maxJobViewBytes) {
      return view;
    }
    const cut = smallestFittingCut(step.available(applied), (candidate) =>
      fitsAt({ ...applied, [step.key]: candidate }),
    );
    applied = { ...applied, [step.key]: cut };
    view = build(applied);
  }
  if (viewBytes(view) <= DELEGATION_BOUNDS.maxJobViewBytes) {
    return view;
  }
  // Last resort: one character cap for every free text, the largest that fits, never below one.
  const longestProse = Math.max(
    1,
    job.request.objective.length,
    job.failureReason?.length ?? 0,
    job.result?.excerpt?.length ?? 0,
    review?.summary.length ?? 0,
    review?.coverage.reviewed.length ?? 0,
    job.selection?.kind === 'abstain' ? (job.selection.note?.length ?? 0) : 0,
    ...keptFindings(applied).map((finding) => finding.detail.length),
    ...evaluations.map((evaluation) => evaluation.note?.length ?? 0),
  );
  const proseCut = smallestFittingCut(longestProse - 1, (candidate) =>
    fitsAt({ ...applied, prose: longestProse - candidate }),
  );
  applied = { ...applied, prose: longestProse - proseCut };
  view = build(applied);
  const bytes = viewBytes(view);
  if (bytes > DELEGATION_BOUNDS.maxJobViewBytes) {
    throw new DelegationJobViewBoundError(job.jobId, bytes);
  }
  return view;
};

// ---------------------------------------------------------------------------------------------
// The list entry
// ---------------------------------------------------------------------------------------------

export const DELEGATION_JOB_SUMMARY_BOUNDS = {
  /** Characters of the result summary and of the failure one list entry carries. */
  maxTextCharacters: 300,
  /** Characters of an object id shown in a list entry. */
  shortRevisionCharacters: 12,
} as const;

/**
 * One job as a list carries it (MCP `delegation.list`, bounded Web lists): the identifiers, the
 * state, the route, the requested scope with object ids shortened, the frozen scope as recorded
 * (object ids whole), the three status facts, the result kind with the whole result's finding count
 * and a short summary, the refusal reason or a short failure. Everything else (findings, evidence,
 * evaluations, scope files, guarantee, notes) is the job view's, read one job at a time.
 */
export interface DelegationJobSummary {
  readonly checkoutPath: string;
  readonly endedAt: string | null;
  /** The failure recorded on a job that was not refused, cut to the summary bound. */
  readonly failure: string | null;
  /** Findings of the whole stored result, the ones the view trimmed included; `null` without a review. */
  readonly findingCount: number | null;
  /** The scope the engine froze for this job, as recorded and whole; `null` when none was (see the view). */
  readonly frozenScope: FrozenDelegationScope | null;
  readonly jobId: string;
  readonly live: boolean;
  readonly refusalReason: DelegationRefusalReason | null;
  readonly requestedAt: string;
  readonly resultKind: DelegationJobResult['kind'] | null;
  readonly route: {
    readonly context: DelegationJob['context'];
    readonly harness: DelegationJob['executorHarness'];
    readonly modelRequested: string | null;
    /** `unknown` when the harness did not report the model it ran. */
    readonly modelResolved: string;
  } | null;
  /** The requested scope: its kind and its revisions as given, object ids shortened. */
  readonly scope: { readonly base: string | null; readonly head: string | null; readonly kind: string };
  readonly state: DelegationJobState;
  readonly status: DelegationJobView['status'];
  /** The worker's own summary, cut to the summary bound. */
  readonly summary: string | null;
}

const shortRevision = (revision: string): string =>
  OBJECT_ID.test(revision) ? revision.slice(0, DELEGATION_JOB_SUMMARY_BOUNDS.shortRevisionCharacters) : revision;

const summaryText = (value: string | null): string | null =>
  value === null ? null : value.slice(0, DELEGATION_JOB_SUMMARY_BOUNDS.maxTextCharacters);

const summarizeScope = (scope: DelegationScopeRequest): DelegationJobSummary['scope'] => {
  const kind: string = scope.kind;
  if (scope.kind === 'commit') {
    return { base: null, head: shortRevision(scope.commit), kind };
  }
  if (scope.kind === 'range') {
    return { base: shortRevision(scope.base), head: shortRevision(scope.head), kind };
  }
  // A refused row keeps the reserved scope kind it refused; this version reads no revision from it.
  return { base: null, head: null, kind };
};

export const summarizeDelegationJobView = (view: DelegationJobView): DelegationJobSummary => ({
  checkoutPath: view.request.checkoutPath,
  endedAt: view.endedAt,
  failure: summaryText(view.failure),
  findingCount: view.result?.kind === 'review' ? view.result.findings.length + view.truncation.findings : null,
  frozenScope: view.frozenScope === null ? null : { ...view.frozenScope },
  jobId: view.jobId,
  live: view.live,
  refusalReason: view.refusal?.reason ?? null,
  requestedAt: view.requestedAt,
  resultKind: view.result?.kind ?? null,
  route:
    view.route === null
      ? null
      : {
          context: view.route.context,
          harness: view.route.harness,
          modelRequested: view.route.modelRequested,
          modelResolved: view.route.modelResolved,
        },
  scope: summarizeScope(view.request.scope),
  state: view.state,
  status: { ...view.status },
  summary: summaryText(view.result?.summary ?? null),
});
