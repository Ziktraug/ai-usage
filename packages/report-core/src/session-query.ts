import { rtkSavingsPct } from './csv';
import { modelGroupKey } from './model-identity';
import { MAX_SESSION_QUERY_PAGE_SIZE, MAX_SESSION_QUERY_RESULT_BYTES } from './report-budgets';
import type { SerializedRow } from './report-data';
import {
  hasValidSerializedUsageDerivedFields,
  isRecord,
  isSerializedUsageRowShape,
  SERIALIZED_USAGE_ROW_KEYS,
} from './serialized-usage-validation';
import { usageRowModelContributions } from './usage-row';

export { MAX_SESSION_QUERY_PAGE_SIZE } from './report-budgets';

const MAX_CURSOR_LENGTH = 4096;
const MAX_FILTER_LIST_LENGTH = 100;
const MAX_REVISION_LENGTH = 512;
const MAX_STRING_LENGTH = 512;
const CURSOR_PATTERN = /^sq1\.([0-9a-f]{16})\.([0-9a-z]+)$/;
const OPENCODE_PROVIDER_SUFFIX = /\s*\(OC\)\s*$/;

export const sessionSortFields = [
  'date',
  'session',
  'harness',
  'machine',
  'provider',
  'project',
  'model',
  'tokIn',
  'tokOut',
  'cache',
  'tokCw',
  'fresh',
  'total',
  'rtkSaved',
  'cost',
  'actual',
  'quota',
  'duration',
  'calls',
  'turns',
  'tools',
  'lines',
  'subagent',
  'partial',
  'ambiguous',
] as const;

export type SessionSortField = (typeof sessionSortFields)[number];

export const sessionTextSortFields = [
  'session',
  'harness',
  'machine',
  'provider',
  'project',
  'model',
] as const satisfies readonly SessionSortField[];
export type SessionTextSortField = (typeof sessionTextSortFields)[number];

export const sessionFieldFilterKeys = ['provider', 'model', 'project'] as const;
export type SessionFieldFilterKey = (typeof sessionFieldFilterKeys)[number];
export type SessionFieldFilters = Partial<Record<SessionFieldFilterKey, string>>;

export interface SessionQueryFilters {
  fields: SessionFieldFilters;
  harness: string[];
  machine: string[];
  query: string;
}

export interface SessionQueryRange {
  from: string | null;
  to: string | null;
}

export interface SessionQuerySort {
  desc: boolean;
  id: SessionSortField;
}

export interface SessionQueryRequest {
  campaigns: boolean;
  cursor: string | null;
  filters: SessionQueryFilters;
  pageSize: number;
  range: SessionQueryRange;
  revision: string;
  sort: SessionQuerySort[];
}

export interface SessionCampaignChildrenRequest {
  campaignKey: string;
  query: SessionQueryRequest;
}

export interface SessionNeighborRequest {
  query: SessionQueryRequest;
  rowId: string;
}

export class SessionQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionQueryValidationError';
  }
}

export class SessionQueryCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionQueryCursorError';
  }
}

const assertSessionQueryResultSize = (value: unknown, label: string): void => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SessionQueryValidationError(`${label} must be JSON serializable`);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SESSION_QUERY_RESULT_BYTES) {
    throw new SessionQueryValidationError(`${label} exceeds the ${MAX_SESSION_QUERY_RESULT_BYTES}-byte limit`);
  }
};

export type SessionPresentationRow = SerializedRow & {
  activeTime: number | null;
  campaignKey?: string;
  campaignTotalCount?: number;
  campaignVisibleCount?: number;
  children?: SessionPresentationRow[];
  modelLabel: string;
  modelKey: string;
  projectLabel: string;
  projectKey: string;
  providerDisplay: string;
  rowId: string;
  searchText: string;
  sortDate: number;
  sortHarness: string;
  sortMachine: string;
  sortModel: string;
  sortProject: string;
  sortProvider: string;
  sortSession: string;
};

export interface SessionCampaignTotals {
  actualCost: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  costKnown: boolean;
  costQuota: number;
  durationMs: number | null;
  freshTokens: number;
  lineDelta: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  rtkCommandCount: number;
  rtkInputTokens: number;
  rtkOutputTokens: number;
  rtkSavedTokens: number;
  tokenTotal: number;
  tokIn: number;
  tokOut: number;
  tools: number;
  totalCost: number;
  turns: number;
}

export interface SessionCampaignView {
  allChildren: SessionPresentationRow[];
  allRows: SessionPresentationRow[];
  allTotals: SessionCampaignTotals;
  campaignKey: string;
  root: SessionPresentationRow;
  rootSourceSessionId: string;
  totalCount: number;
  visibleChildren: SessionPresentationRow[];
  visibleCount: number;
  visibleRows: SessionPresentationRow[];
  visibleTotals: SessionCampaignTotals;
}

export type SessionCampaignTableItem =
  | { kind: 'session'; row: SessionPresentationRow }
  | {
      campaign: SessionCampaignView;
      children: SessionPresentationRow[];
      kind: 'campaign';
      row: SessionPresentationRow;
    };

export type SessionPageItem =
  | { kind: 'session'; row: SessionPresentationRow }
  | { campaignKey: string; kind: 'campaign'; row: SessionPresentationRow };

export interface SessionPageResult {
  itemCount: number;
  items: SessionPageItem[];
  nextCursor: string | null;
  requestFingerprint: string;
  revision: string;
  sessionCount: number;
}

export interface SessionCampaignChildrenResult {
  campaignKey: string;
  itemCount: number;
  items: SessionPresentationRow[];
  nextCursor: string | null;
  requestFingerprint: string;
  revision: string;
  sessionCount: number;
}

export interface SessionNeighborResult {
  found: boolean;
  next: SessionPresentationRow | null;
  previous: SessionPresentationRow | null;
  requestFingerprint: string;
  revision: string;
}

export type SessionQueryProtocolErrorTag = 'QueryFailed' | 'RevisionExpired';

export interface SessionQueryProtocolError {
  message: string;
  revision: string;
  tag: SessionQueryProtocolErrorTag;
}

export type SessionQueryServerResult<Result> =
  | { data: Result; ok: true; requestFingerprint: string; revision: string }
  | {
      error: SessionQueryProtocolError;
      ok: false;
      requestFingerprint: string;
      revision: string;
    };

const sessionSortFieldSet = new Set<string>(sessionSortFields);
const sessionFieldFilterKeySet = new Set<string>(sessionFieldFilterKeys);
const SESSION_PRESENTATION_ROW_KEYS = new Set([
  ...SERIALIZED_USAGE_ROW_KEYS,
  'activeTime',
  'campaignKey',
  'campaignTotalCount',
  'campaignVisibleCount',
  'modelLabel',
  'modelKey',
  'projectLabel',
  'projectKey',
  'providerDisplay',
  'rowId',
  'searchText',
  'sortDate',
  'sortHarness',
  'sortMachine',
  'sortModel',
  'sortProject',
  'sortProvider',
  'sortSession',
]);

export const isSessionSortField = (value: unknown): value is SessionSortField =>
  typeof value === 'string' && sessionSortFieldSet.has(value);

export const isSessionFieldFilterKey = (value: unknown): value is SessionFieldFilterKey =>
  typeof value === 'string' && sessionFieldFilterKeySet.has(value);

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new SessionQueryValidationError(`${label} must be an object`);
  }
  return value;
};

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const allowed = new Set(keys);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !allowed.has(key))) {
    throw new SessionQueryValidationError(`${label} has unknown or missing fields`);
  }
};

const requireTrimmedString = (value: unknown, label: string, maxLength = MAX_STRING_LENGTH): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    throw new SessionQueryValidationError(`${label} must be a non-empty trimmed string`);
  }
  return value;
};

export const compareSessionIdentityValues = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

export const compareSessionTextValues = (left: string, right: string): number => left.localeCompare(right);

const normalizeStringList = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > MAX_FILTER_LIST_LENGTH) {
    throw new SessionQueryValidationError(`${label} must be a bounded string array`);
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new SessionQueryValidationError(`${label} must contain only strings`);
    }
    const normalized = entry.trim();
    if (normalized.length === 0 || normalized.length > MAX_STRING_LENGTH) {
      throw new SessionQueryValidationError(`${label} contains an invalid string`);
    }
    unique.add(normalized);
  }
  return [...unique].sort(compareSessionIdentityValues);
};

const parseFieldFilters = (value: unknown): SessionFieldFilters => {
  const record = requireRecord(value, 'filters.fields');
  const filters: SessionFieldFilters = {};
  for (const [key, fieldValue] of Object.entries(record)) {
    if (!isSessionFieldFilterKey(key)) {
      throw new SessionQueryValidationError(`Unknown session field filter: ${key}`);
    }
    filters[key] = requireTrimmedString(fieldValue, `filters.fields.${key}`);
  }
  return Object.fromEntries(
    sessionFieldFilterKeys.flatMap((key) => (filters[key] === undefined ? [] : [[key, filters[key]]])),
  );
};

const parseFilters = (value: unknown): SessionQueryFilters => {
  const record = requireRecord(value, 'filters');
  assertExactKeys(record, ['fields', 'harness', 'machine', 'query'], 'filters');
  if (typeof record.query !== 'string' || record.query.length > MAX_STRING_LENGTH) {
    throw new SessionQueryValidationError('filters.query must be a bounded string');
  }
  return {
    fields: parseFieldFilters(record.fields),
    harness: normalizeStringList(record.harness, 'filters.harness'),
    machine: normalizeStringList(record.machine, 'filters.machine'),
    query: record.query.trim().toLowerCase(),
  };
};

const parseIsoDate = (value: unknown, label: string): string | null => {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new SessionQueryValidationError(`${label} must be an ISO timestamp or null`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new SessionQueryValidationError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
};

const parseRange = (value: unknown): SessionQueryRange => {
  const record = requireRecord(value, 'range');
  assertExactKeys(record, ['from', 'to'], 'range');
  const from = parseIsoDate(record.from, 'range.from');
  const to = parseIsoDate(record.to, 'range.to');
  if (from && to && from > to) {
    throw new SessionQueryValidationError('range.from must not be after range.to');
  }
  return { from, to };
};

const parseSort = (value: unknown): SessionQuerySort[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > sessionSortFields.length) {
    throw new SessionQueryValidationError('sort must be a non-empty bounded array');
  }
  const seen = new Set<SessionSortField>();
  return value.map((entry, index) => {
    const record = requireRecord(entry, `sort[${index}]`);
    assertExactKeys(record, ['desc', 'id'], `sort[${index}]`);
    if (typeof record.desc !== 'boolean' || !isSessionSortField(record.id)) {
      throw new SessionQueryValidationError(`sort[${index}] is invalid`);
    }
    if (seen.has(record.id)) {
      throw new SessionQueryValidationError(`sort contains duplicate field: ${record.id}`);
    }
    seen.add(record.id);
    return { desc: record.desc, id: record.id };
  });
};

const parseCursor = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new SessionQueryValidationError('cursor must be a bounded opaque string or null');
  }
  return value;
};

export const parseSessionQueryRequest = (value: unknown): SessionQueryRequest => {
  const record = requireRecord(value, 'session query request');
  assertExactKeys(record, ['campaigns', 'cursor', 'filters', 'pageSize', 'range', 'revision', 'sort'], 'request');
  if (typeof record.campaigns !== 'boolean') {
    throw new SessionQueryValidationError('campaigns must be a boolean');
  }
  if (
    typeof record.pageSize !== 'number' ||
    !Number.isSafeInteger(record.pageSize) ||
    record.pageSize < 1 ||
    record.pageSize > MAX_SESSION_QUERY_PAGE_SIZE
  ) {
    throw new SessionQueryValidationError(`pageSize must be between 1 and ${MAX_SESSION_QUERY_PAGE_SIZE}`);
  }
  return {
    campaigns: record.campaigns,
    cursor: parseCursor(record.cursor),
    filters: parseFilters(record.filters),
    pageSize: record.pageSize,
    range: parseRange(record.range),
    revision: requireTrimmedString(record.revision, 'revision', MAX_REVISION_LENGTH),
    sort: parseSort(record.sort),
  };
};

export const parseSessionCampaignChildrenRequest = (value: unknown): SessionCampaignChildrenRequest => {
  const record = requireRecord(value, 'campaign children request');
  assertExactKeys(record, ['campaignKey', 'query'], 'campaign children request');
  return {
    campaignKey: requireTrimmedString(record.campaignKey, 'campaignKey'),
    query: parseSessionQueryRequest(record.query),
  };
};

export const parseSessionNeighborRequest = (value: unknown): SessionNeighborRequest => {
  const record = requireRecord(value, 'session neighbor request');
  assertExactKeys(record, ['query', 'rowId'], 'session neighbor request');
  return {
    query: parseSessionQueryRequest(record.query),
    rowId: requireTrimmedString(record.rowId, 'rowId', MAX_CURSOR_LENGTH),
  };
};

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    // FNV-1a is deliberately defined in terms of an XOR step.
    // biome-ignore lint/suspicious/noBitwiseOperators: The bitwise operation is intrinsic to this hash.
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

const canonicalQueryScope = (request: SessionQueryRequest): string =>
  JSON.stringify({
    campaigns: request.campaigns,
    filters: {
      fields: Object.fromEntries(
        sessionFieldFilterKeys.flatMap((key) =>
          request.filters.fields[key] === undefined ? [] : [[key, request.filters.fields[key]]],
        ),
      ),
      harness: request.filters.harness,
      machine: request.filters.machine,
      query: request.filters.query,
    },
    pageSize: request.pageSize,
    range: request.range,
    sort: request.sort,
  });

export const sessionQueryFingerprint = (request: SessionQueryRequest): string => {
  const validated = parseSessionQueryRequest(request);
  return `session-query-v1:${fnv1a64(canonicalQueryScope(validated))}`;
};

export const sessionCampaignChildrenFingerprint = (request: SessionCampaignChildrenRequest): string => {
  const validated = parseSessionCampaignChildrenRequest(request);
  return `session-campaign-children-v1:${fnv1a64(`${validated.campaignKey}\n${canonicalQueryScope(validated.query)}`)}`;
};

export const sessionNeighborFingerprint = (request: SessionNeighborRequest): string => {
  const validated = parseSessionNeighborRequest(request);
  return `session-neighbor-v1:${fnv1a64(`${validated.rowId}\n${canonicalQueryScope(validated.query)}`)}`;
};

const requireNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionQueryValidationError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
};

const requireFiniteNumberOrNull = (value: unknown, label: string): number | null => {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SessionQueryValidationError(`${label} must be a finite number or null`);
  }
  return value;
};

export const parseSessionPresentationRow = (value: unknown, label: string): SessionPresentationRow => {
  const record = requireRecord(value, label);
  if (!isSerializedUsageRowShape(record, SESSION_PRESENTATION_ROW_KEYS)) {
    throw new SessionQueryValidationError(`${label} contains an invalid serialized usage row`);
  }
  if (record.campaignKey === undefined && !hasValidSerializedUsageDerivedFields(record)) {
    throw new SessionQueryValidationError(`${label} contains inconsistent serialized usage totals`);
  }
  const requiredStrings = [
    'modelLabel',
    'modelKey',
    'projectLabel',
    'projectKey',
    'providerDisplay',
    'rowId',
    'searchText',
    'sortHarness',
    'sortMachine',
    'sortModel',
    'sortProject',
    'sortProvider',
    'sortSession',
  ] as const;
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string' || (key === 'rowId' && record[key].length === 0)) {
      throw new SessionQueryValidationError(`${label}.${key} must be a string`);
    }
  }
  requireFiniteNumberOrNull(record.activeTime, `${label}.activeTime`);
  if (typeof record.sortDate !== 'number' || !Number.isFinite(record.sortDate)) {
    throw new SessionQueryValidationError(`${label}.sortDate must be a finite number`);
  }
  if (record.campaignKey !== undefined) {
    requireTrimmedString(record.campaignKey, `${label}.campaignKey`, MAX_CURSOR_LENGTH);
  }
  if (record.campaignTotalCount !== undefined) {
    requireNonNegativeSafeInteger(record.campaignTotalCount, `${label}.campaignTotalCount`);
  }
  if (record.campaignVisibleCount !== undefined) {
    requireNonNegativeSafeInteger(record.campaignVisibleCount, `${label}.campaignVisibleCount`);
  }
  return value as SessionPresentationRow;
};

const parseResultCursor = (value: unknown, label: string): string | null => {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(value)) {
    throw new SessionQueryValidationError(`${label} must be a valid opaque cursor or null`);
  }
  return value;
};

const parseSessionPageItem = (value: unknown, label: string): SessionPageItem => {
  const record = requireRecord(value, label);
  if (record.kind === 'session') {
    assertExactKeys(record, ['kind', 'row'], label);
    return { kind: 'session', row: parseSessionPresentationRow(record.row, `${label}.row`) };
  }
  if (record.kind === 'campaign') {
    assertExactKeys(record, ['campaignKey', 'kind', 'row'], label);
    return {
      campaignKey: requireTrimmedString(record.campaignKey, `${label}.campaignKey`, MAX_CURSOR_LENGTH),
      kind: 'campaign',
      row: parseSessionPresentationRow(record.row, `${label}.row`),
    };
  }
  throw new SessionQueryValidationError(`${label}.kind is invalid`);
};

const assertResultIdentity = (
  record: Record<string, unknown>,
  revision: string,
  requestFingerprint: string,
  label: string,
): void => {
  if (record.revision !== revision || record.requestFingerprint !== requestFingerprint) {
    throw new SessionQueryValidationError(`${label} has a mismatched revision or request fingerprint`);
  }
};

export const parseSessionPageResult = (value: unknown, input: SessionQueryRequest): SessionPageResult => {
  const request = parseSessionQueryRequest(input);
  const requestFingerprint = sessionQueryFingerprint(request);
  assertSessionQueryResultSize(value, 'session page result');
  const record = requireRecord(value, 'session page result');
  assertExactKeys(
    record,
    ['itemCount', 'items', 'nextCursor', 'requestFingerprint', 'revision', 'sessionCount'],
    'session page result',
  );
  assertResultIdentity(record, request.revision, requestFingerprint, 'session page result');
  if (!Array.isArray(record.items) || record.items.length > request.pageSize) {
    throw new SessionQueryValidationError('session page result items exceed the requested page size');
  }
  const itemCount = requireNonNegativeSafeInteger(record.itemCount, 'session page result.itemCount');
  const sessionCount = requireNonNegativeSafeInteger(record.sessionCount, 'session page result.sessionCount');
  if (itemCount < record.items.length || sessionCount < record.items.length) {
    throw new SessionQueryValidationError('session page result counts are smaller than the returned page');
  }
  return {
    itemCount,
    items: record.items.map((item, index) => parseSessionPageItem(item, `session page result.items[${index}]`)),
    nextCursor: parseResultCursor(record.nextCursor, 'session page result.nextCursor'),
    requestFingerprint,
    revision: request.revision,
    sessionCount,
  };
};

export const parseSessionCampaignChildrenResult = (
  value: unknown,
  input: SessionCampaignChildrenRequest,
): SessionCampaignChildrenResult => {
  const request = parseSessionCampaignChildrenRequest(input);
  const requestFingerprint = sessionCampaignChildrenFingerprint(request);
  assertSessionQueryResultSize(value, 'campaign children result');
  const record = requireRecord(value, 'campaign children result');
  assertExactKeys(
    record,
    ['campaignKey', 'itemCount', 'items', 'nextCursor', 'requestFingerprint', 'revision', 'sessionCount'],
    'campaign children result',
  );
  assertResultIdentity(record, request.query.revision, requestFingerprint, 'campaign children result');
  if (record.campaignKey !== request.campaignKey) {
    throw new SessionQueryValidationError('campaign children result has a mismatched campaign key');
  }
  if (!Array.isArray(record.items) || record.items.length > request.query.pageSize) {
    throw new SessionQueryValidationError('campaign children result items exceed the requested page size');
  }
  const itemCount = requireNonNegativeSafeInteger(record.itemCount, 'campaign children result.itemCount');
  const sessionCount = requireNonNegativeSafeInteger(record.sessionCount, 'campaign children result.sessionCount');
  if (itemCount < record.items.length || sessionCount < record.items.length) {
    throw new SessionQueryValidationError('campaign children result counts are smaller than the returned page');
  }
  return {
    campaignKey: request.campaignKey,
    itemCount,
    items: record.items.map((item, index) =>
      parseSessionPresentationRow(item, `campaign children result.items[${index}]`),
    ),
    nextCursor: parseResultCursor(record.nextCursor, 'campaign children result.nextCursor'),
    requestFingerprint,
    revision: request.query.revision,
    sessionCount,
  };
};

export const parseSessionNeighborResult = (value: unknown, input: SessionNeighborRequest): SessionNeighborResult => {
  const request = parseSessionNeighborRequest(input);
  const requestFingerprint = sessionNeighborFingerprint(request);
  assertSessionQueryResultSize(value, 'session neighbor result');
  const record = requireRecord(value, 'session neighbor result');
  assertExactKeys(record, ['found', 'next', 'previous', 'requestFingerprint', 'revision'], 'session neighbor result');
  assertResultIdentity(record, request.query.revision, requestFingerprint, 'session neighbor result');
  if (typeof record.found !== 'boolean') {
    throw new SessionQueryValidationError('session neighbor result.found must be a boolean');
  }
  const next = record.next === null ? null : parseSessionPresentationRow(record.next, 'session neighbor result.next');
  const previous =
    record.previous === null ? null : parseSessionPresentationRow(record.previous, 'session neighbor result.previous');
  if (!record.found && (next !== null || previous !== null)) {
    throw new SessionQueryValidationError('a missing session neighbor result cannot contain neighbors');
  }
  return {
    found: record.found,
    next,
    previous,
    requestFingerprint,
    revision: request.query.revision,
  };
};

const parseSessionQueryServerResult = <Result>(
  value: unknown,
  revision: string,
  requestFingerprint: string,
  parseData: (data: unknown) => Result,
): SessionQueryServerResult<Result> => {
  assertSessionQueryResultSize(value, 'session query server result');
  const record = requireRecord(value, 'session query server result');
  if (record.ok === true) {
    assertExactKeys(record, ['data', 'ok', 'requestFingerprint', 'revision'], 'session query server result');
    assertResultIdentity(record, revision, requestFingerprint, 'session query server result');
    return { data: parseData(record.data), ok: true, requestFingerprint, revision };
  }
  if (record.ok !== false) {
    throw new SessionQueryValidationError('session query server result.ok must be a boolean');
  }
  assertExactKeys(record, ['error', 'ok', 'requestFingerprint', 'revision'], 'session query server result');
  assertResultIdentity(record, revision, requestFingerprint, 'session query server result');
  const error = requireRecord(record.error, 'session query server result.error');
  assertExactKeys(error, ['message', 'revision', 'tag'], 'session query server result.error');
  if (
    (error.tag !== 'QueryFailed' && error.tag !== 'RevisionExpired') ||
    error.revision !== revision ||
    typeof error.message !== 'string' ||
    error.message.length === 0
  ) {
    throw new SessionQueryValidationError('session query server result.error is invalid');
  }
  return {
    error: { message: error.message, revision, tag: error.tag },
    ok: false,
    requestFingerprint,
    revision,
  };
};

export const parseSessionPageServerResult = (
  value: unknown,
  input: SessionQueryRequest,
): SessionQueryServerResult<SessionPageResult> => {
  const request = parseSessionQueryRequest(input);
  return parseSessionQueryServerResult(value, request.revision, sessionQueryFingerprint(request), (data) =>
    parseSessionPageResult(data, request),
  );
};

export const parseSessionCampaignChildrenServerResult = (
  value: unknown,
  input: SessionCampaignChildrenRequest,
): SessionQueryServerResult<SessionCampaignChildrenResult> => {
  const request = parseSessionCampaignChildrenRequest(input);
  return parseSessionQueryServerResult(
    value,
    request.query.revision,
    sessionCampaignChildrenFingerprint(request),
    (data) => parseSessionCampaignChildrenResult(data, request),
  );
};

export const parseSessionNeighborServerResult = (
  value: unknown,
  input: SessionNeighborRequest,
): SessionQueryServerResult<SessionNeighborResult> => {
  const request = parseSessionNeighborRequest(input);
  return parseSessionQueryServerResult(value, request.query.revision, sessionNeighborFingerprint(request), (data) =>
    parseSessionNeighborResult(data, request),
  );
};

const activeTimeForRow = (row: SerializedRow): number | null => {
  const value = row.activeDate ?? row.date;
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export const sessionRowIdentity = (row: SerializedRow): string =>
  [
    row.source?.machineId ?? '',
    row.source?.sourceSessionId ?? '',
    row.activeDate ?? row.date ?? '',
    row.harness,
    row.provider,
    row.model,
    row.models?.join('+') ?? '',
    row.project,
    row.sessionLabel,
  ].join('|');

const sessionModelLabel = (row: SerializedRow): string => (row.models?.length ? row.models.join(' → ') : row.model);

export const sessionModelKeys = (row: SerializedRow): string[] => [
  ...new Set([
    ...usageRowModelContributions(row).map(({ key }) => key),
    ...(row.models?.length ? row.models : [row.model]).map((model) => modelGroupKey(model)),
  ]),
];

const providerPresentationLabel = (provider: string): string =>
  provider.replace(OPENCODE_PROVIDER_SUFFIX, ' · via OpenCode');

export const enrichSessionPresentationRow = (row: SerializedRow): SessionPresentationRow => {
  const activeTime = activeTimeForRow(row);
  const modelLabel = sessionModelLabel(row);
  const modelKey = modelGroupKey(row.model);
  const projectLabel = row.project || '(unknown)';
  const providerDisplay = providerPresentationLabel(row.provider);
  const machineLabel = row.source?.machineLabel ?? '';
  return {
    ...row,
    activeTime,
    modelLabel,
    modelKey,
    projectLabel,
    projectKey: projectLabel,
    providerDisplay,
    rowId: sessionRowIdentity(row),
    searchText:
      `${row.sessionLabel} ${row.project} ${row.rawProject ?? ''} ${projectLabel} ${modelLabel} ${row.provider} ${providerDisplay} ${row.harness} ${machineLabel}`.toLowerCase(),
    sortDate: activeTime ?? 0,
    sortHarness: row.harness.toLowerCase(),
    sortMachine: machineLabel.toLowerCase(),
    sortModel: modelKey.toLowerCase(),
    sortProject: projectLabel.toLowerCase(),
    sortProvider: providerDisplay.toLowerCase(),
    sortSession: row.sessionLabel.toLowerCase(),
  };
};

export const sortValueForSessionColumn = (row: SessionPresentationRow, columnId: SessionSortField): number | string => {
  switch (columnId) {
    case 'date':
      return row.sortDate;
    case 'session':
      return row.sortSession;
    case 'harness':
      return row.sortHarness;
    case 'machine':
      return row.sortMachine;
    case 'provider':
      return row.sortProvider;
    case 'project':
      return row.sortProject;
    case 'model':
      return row.sortModel;
    case 'tokIn':
      return row.tokIn;
    case 'tokOut':
      return row.tokOut;
    case 'cache':
      return row.tokCr;
    case 'tokCw':
      return row.tokCw;
    case 'fresh':
      return row.freshTokens;
    case 'total':
      return row.tokenTotal;
    case 'rtkSaved':
      return rtkSavingsPct(row) ?? 0;
    case 'cost':
      return row.costKnown || row.costApprox > 0 ? row.costApprox : Number.NEGATIVE_INFINITY;
    case 'actual':
      return row.costActual ?? Number.NEGATIVE_INFINITY;
    case 'quota':
      return row.costQuota ?? 0;
    case 'duration':
      return row.durationMs ?? 0;
    case 'calls':
      return row.calls;
    case 'turns':
      return row.turns;
    case 'tools':
      return row.tools;
    case 'lines':
      return row.lineDelta ?? 0;
    case 'subagent':
      return row.subagent ? 1 : 0;
    case 'partial':
      return row.partial ? 1 : 0;
    case 'ambiguous':
      return row.ambiguous ? 1 : 0;
    default:
      throw new Error(`Unknown session sort field: ${columnId}`);
  }
};

const compareSortValues = (left: number | string, right: number | string): number => {
  if (typeof left === 'string' || typeof right === 'string') {
    return compareSessionTextValues(String(left), String(right));
  }
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
};

export const compareSessionPresentationRows =
  (sorting: readonly { desc: boolean; id: string }[]) =>
  (left: SessionPresentationRow, right: SessionPresentationRow): number => {
    for (const sort of sorting) {
      if (!isSessionSortField(sort.id)) {
        continue;
      }
      const comparison = compareSortValues(
        sortValueForSessionColumn(left, sort.id),
        sortValueForSessionColumn(right, sort.id),
      );
      if (comparison !== 0) {
        return sort.desc ? -comparison : comparison;
      }
    }
    return compareSessionIdentityValues(left.rowId, right.rowId);
  };

export const buildSortedSessionPresentationRows = (
  rows: SessionPresentationRow[],
  sorting: readonly { desc: boolean; id: string }[],
): SessionPresentationRow[] => [...rows].sort(compareSessionPresentationRows(sorting));

export const sessionCampaignKeyFor = (row: SessionPresentationRow, rootSourceSessionId: string): string =>
  [row.source?.machineId ?? 'local', row.source?.harnessKey ?? row.harness, rootSourceSessionId].join(':');

const campaignIdentityForRow = (row: SessionPresentationRow) => {
  const sourceSessionId = row.source?.sourceSessionId ?? null;
  const rootSourceSessionId = row.source?.rootSourceSessionId ?? null;
  if (!(sourceSessionId && rootSourceSessionId)) {
    return null;
  }
  return {
    campaignKey: sessionCampaignKeyFor(row, rootSourceSessionId),
    rootSourceSessionId,
    sourceSessionId,
  };
};

const sumNullable = (
  rows: SessionPresentationRow[],
  value: (row: SessionPresentationRow) => number | null | undefined,
): number | null => {
  let present = false;
  let total = 0;
  for (const row of rows) {
    const next = value(row);
    if (next == null) {
      continue;
    }
    present = true;
    total += next;
  }
  return present ? total : null;
};

const campaignRootFromRows = (rows: SessionPresentationRow[]): SessionPresentationRow | undefined =>
  rows.find((row) => {
    const sourceSessionId = row.source?.sourceSessionId;
    return Boolean(sourceSessionId && sourceSessionId === row.source?.rootSourceSessionId);
  });

/**
 * The root duration represents the orchestrator's active work. Child
 * rollout spans overlap the root and each other, so summing them inflates the
 * campaign duration.
 */
export const buildSessionCampaignTotals = (
  rows: SessionPresentationRow[],
  campaignRoot = campaignRootFromRows(rows),
): SessionCampaignTotals => ({
  actualCost: rows.reduce((sum, row) => sum + (row.costActual ?? 0), 0),
  cacheRead: rows.reduce((sum, row) => sum + row.tokCr, 0),
  cacheWrite: rows.reduce((sum, row) => sum + row.tokCw, 0),
  calls: rows.reduce((sum, row) => sum + row.calls, 0),
  costKnown: rows.every((row) => row.costKnown),
  costQuota: rows.reduce((sum, row) => sum + (row.costQuota ?? 0), 0),
  durationMs: campaignRoot?.durationMs ?? null,
  freshTokens: rows.reduce((sum, row) => sum + row.freshTokens, 0),
  lineDelta: sumNullable(rows, (row) => row.lineDelta),
  linesAdded: sumNullable(rows, (row) => row.linesAdded),
  linesDeleted: sumNullable(rows, (row) => row.linesDeleted),
  rtkCommandCount: rows.reduce((sum, row) => sum + (row.rtkCommandCount ?? 0), 0),
  rtkInputTokens: rows.reduce((sum, row) => sum + (row.rtkInputTokens ?? 0), 0),
  rtkOutputTokens: rows.reduce((sum, row) => sum + (row.rtkOutputTokens ?? 0), 0),
  rtkSavedTokens: rows.reduce((sum, row) => sum + (row.rtkSavedTokens ?? 0), 0),
  tokenTotal: rows.reduce((sum, row) => sum + row.tokenTotal, 0),
  tokIn: rows.reduce((sum, row) => sum + row.tokIn, 0),
  tokOut: rows.reduce((sum, row) => sum + row.tokOut, 0),
  tools: rows.reduce((sum, row) => sum + row.tools, 0),
  totalCost: rows.reduce((sum, row) => sum + row.costApprox, 0),
  turns: rows.reduce((sum, row) => sum + row.turns, 0),
});

export const buildSessionCampaignViews = (
  allRows: SessionPresentationRow[],
  visibleRows: SessionPresentationRow[],
): SessionCampaignView[] => {
  const visibleIds = new Set(visibleRows.map((row) => row.rowId));
  const groups = new Map<string, SessionPresentationRow[]>();
  for (const row of allRows) {
    const identity = campaignIdentityForRow(row);
    if (!identity) {
      continue;
    }
    const group = groups.get(identity.campaignKey) ?? [];
    group.push(row);
    groups.set(identity.campaignKey, group);
  }

  const campaigns: SessionCampaignView[] = [];
  for (const [campaignKey, rows] of groups) {
    const firstIdentity = campaignIdentityForRow(rows[0]!);
    if (!firstIdentity) {
      continue;
    }
    const root = rows.find((row) => row.source?.sourceSessionId === firstIdentity.rootSourceSessionId);
    if (!root) {
      continue;
    }
    const allChildren = rows.filter((row) => row !== root);
    const hasDirectChildren = rows.some(
      (row) => row.source?.parentSourceSessionId === firstIdentity.rootSourceSessionId,
    );
    if (rows.length < 2 && !hasDirectChildren) {
      continue;
    }
    const visibleChildren = allChildren.filter((row) => visibleIds.has(row.rowId));
    const visibleRowsForTotals = [visibleIds.has(root.rowId) ? root : null, ...visibleChildren].filter(
      (row): row is SessionPresentationRow => Boolean(row),
    );
    if (visibleRowsForTotals.length === 0) {
      continue;
    }
    campaigns.push({
      allChildren,
      allRows: rows,
      allTotals: buildSessionCampaignTotals(rows, root),
      campaignKey,
      root,
      rootSourceSessionId: firstIdentity.rootSourceSessionId,
      totalCount: rows.length,
      visibleChildren,
      visibleCount: visibleRowsForTotals.length,
      visibleRows: visibleRowsForTotals,
      visibleTotals: buildSessionCampaignTotals(visibleRowsForTotals, root),
    });
  }
  return campaigns;
};

const campaignSortValue = (campaign: SessionCampaignView, columnId: SessionSortField): number | string => {
  const { root, visibleRows, visibleTotals: totals } = campaign;
  switch (columnId) {
    case 'date':
      return Math.max(...visibleRows.map((row) => row.sortDate), root.sortDate);
    case 'tokIn':
      return totals.tokIn;
    case 'tokOut':
      return totals.tokOut;
    case 'cache':
      return totals.cacheRead;
    case 'tokCw':
      return totals.cacheWrite;
    case 'fresh':
      return totals.freshTokens;
    case 'total':
      return totals.tokenTotal;
    case 'rtkSaved':
      return totals.rtkInputTokens ? (totals.rtkSavedTokens / totals.rtkInputTokens) * 100 : 0;
    case 'cost':
      return totals.costKnown || totals.totalCost > 0 ? totals.totalCost : Number.NEGATIVE_INFINITY;
    case 'actual':
      return totals.actualCost;
    case 'quota':
      return totals.costQuota;
    case 'duration':
      return totals.durationMs ?? 0;
    case 'calls':
      return totals.calls;
    case 'turns':
      return totals.turns;
    case 'tools':
      return totals.tools;
    case 'lines':
      return totals.lineDelta ?? 0;
    case 'subagent':
      return visibleRows.some((row) => row.subagent) ? 1 : 0;
    case 'partial':
      return visibleRows.some((row) => row.partial) ? 1 : 0;
    case 'ambiguous':
      return visibleRows.some((row) => row.ambiguous) ? 1 : 0;
    default:
      return sortValueForSessionColumn(root, columnId);
  }
};

const campaignItemIdentity = (item: SessionCampaignTableItem): string =>
  item.kind === 'campaign' ? `campaign:${item.campaign.campaignKey}` : `session:${item.row.rowId}`;

const campaignItemSortValue = (item: SessionCampaignTableItem, columnId: SessionSortField): number | string =>
  item.kind === 'campaign' ? campaignSortValue(item.campaign, columnId) : sortValueForSessionColumn(item.row, columnId);

const compareCampaignItems =
  (sorting: readonly { desc: boolean; id: string }[]) =>
  (left: SessionCampaignTableItem, right: SessionCampaignTableItem): number => {
    for (const sort of sorting) {
      if (!isSessionSortField(sort.id)) {
        continue;
      }
      const comparison = compareSortValues(campaignItemSortValue(left, sort.id), campaignItemSortValue(right, sort.id));
      if (comparison !== 0) {
        return sort.desc ? -comparison : comparison;
      }
    }
    return compareSessionIdentityValues(campaignItemIdentity(left), campaignItemIdentity(right));
  };

export const buildSessionCampaignTableItems = (
  allRows: SessionPresentationRow[],
  visibleRows: SessionPresentationRow[],
  sorting: readonly { desc: boolean; id: string }[],
  groupCampaigns: boolean,
  preparedCampaigns?: SessionCampaignView[],
): SessionCampaignTableItem[] => {
  if (!groupCampaigns) {
    return buildSortedSessionPresentationRows(visibleRows, sorting).map((row) => ({ kind: 'session', row }));
  }
  const campaigns = preparedCampaigns ?? buildSessionCampaignViews(allRows, visibleRows);
  const campaignByKey = new Map(campaigns.map((campaign) => [campaign.campaignKey, campaign]));
  const childIds = new Set(campaigns.flatMap((campaign) => campaign.allChildren.map((row) => row.rowId)));
  const emittedCampaigns = new Set<string>();
  const items: SessionCampaignTableItem[] = [];

  for (const row of visibleRows) {
    const identity = campaignIdentityForRow(row);
    const campaign = identity ? campaignByKey.get(identity.campaignKey) : undefined;
    if (campaign) {
      if (!emittedCampaigns.has(campaign.campaignKey)) {
        emittedCampaigns.add(campaign.campaignKey);
        items.push({ campaign, children: campaign.visibleChildren, kind: 'campaign', row: campaign.root });
      }
      continue;
    }
    if (!childIds.has(row.rowId)) {
      items.push({ kind: 'session', row });
    }
  }
  for (const campaign of campaigns) {
    if (!emittedCampaigns.has(campaign.campaignKey)) {
      emittedCampaigns.add(campaign.campaignKey);
      items.push({ campaign, children: campaign.visibleChildren, kind: 'campaign', row: campaign.root });
    }
  }
  return items.sort(compareCampaignItems(sorting));
};

export const sessionCampaignDisplayRow = (
  campaign: SessionCampaignView,
  sorting: readonly { desc: boolean; id: string }[],
  includeChildren = true,
): SessionPresentationRow => {
  const totals = campaign.visibleTotals;
  const rootWithoutModelAttribution = { ...campaign.root };
  Reflect.deleteProperty(rootWithoutModelAttribution, 'modelSegments');
  const latestVisibleRow = campaign.visibleRows.reduce(
    (latest, row) => (row.sortDate > latest.sortDate ? row : latest),
    campaign.visibleRows[0] ?? campaign.root,
  );
  return {
    ...rootWithoutModelAttribution,
    activeDate: latestVisibleRow.activeDate,
    activeTime: latestVisibleRow.activeTime,
    ambiguous: campaign.visibleRows.some((row) => row.ambiguous),
    campaignKey: campaign.campaignKey,
    campaignTotalCount: campaign.totalCount,
    campaignVisibleCount: campaign.visibleCount,
    calls: totals.calls,
    ...(includeChildren ? { children: buildSortedSessionPresentationRows(campaign.visibleChildren, sorting) } : {}),
    costActual: totals.actualCost,
    costApprox: totals.totalCost,
    costKnown: totals.costKnown,
    costQuota: totals.costQuota,
    durationMs: totals.durationMs,
    freshTokens: totals.freshTokens,
    lineDelta: totals.lineDelta,
    linesAdded: totals.linesAdded,
    linesDeleted: totals.linesDeleted,
    // The latest child only controls campaign recency; model identity remains
    // representative of the root orchestrator session.
    model: campaign.root.model,
    modelKey: campaign.root.modelKey,
    modelLabel: campaign.root.modelLabel,
    partial: campaign.visibleRows.some((row) => row.partial),
    rtkCommandCount: totals.rtkCommandCount,
    rtkInputTokens: totals.rtkInputTokens,
    rtkOutputTokens: totals.rtkOutputTokens,
    rtkSavedTokens: totals.rtkSavedTokens,
    sessionLabel: campaign.root.sessionLabel,
    sortDate: latestVisibleRow.sortDate,
    sortModel: campaign.root.sortModel,
    subagent: true,
    tokCr: totals.cacheRead,
    tokCw: totals.cacheWrite,
    tokenTotal: totals.tokenTotal,
    tokIn: totals.tokIn,
    tokOut: totals.tokOut,
    tools: totals.tools,
    turns: totals.turns,
    usageUnavailable: campaign.visibleRows.every((row) => row.usageUnavailable),
  };
};

export const buildSessionCampaignTableRows = (
  allRows: SessionPresentationRow[],
  visibleRows: SessionPresentationRow[],
  sorting: readonly { desc: boolean; id: string }[],
  groupCampaigns: boolean,
  preparedCampaigns?: SessionCampaignView[],
): SessionPresentationRow[] =>
  buildSessionCampaignTableItems(allRows, visibleRows, sorting, groupCampaigns, preparedCampaigns).map((item) =>
    item.kind === 'campaign' ? sessionCampaignDisplayRow(item.campaign, sorting) : item.row,
  );

export const campaignBadgeLabelForSessionRow = (row: SessionPresentationRow): string | null => {
  if (!row.campaignKey || row.campaignTotalCount == null || row.campaignVisibleCount == null) {
    return null;
  }
  return row.campaignVisibleCount === row.campaignTotalCount
    ? `Campaign · ${row.campaignTotalCount} sessions`
    : `Campaign · ${row.campaignVisibleCount}/${row.campaignTotalCount} sessions`;
};

const matchesSessionQuery = (row: SessionPresentationRow, request: SessionQueryRequest): boolean => {
  const { fields } = request.filters;
  if (request.filters.query && !row.searchText.includes(request.filters.query)) {
    return false;
  }
  if (request.filters.harness.length && !request.filters.harness.includes(row.harness)) {
    return false;
  }
  if (request.filters.machine.length && !request.filters.machine.includes(row.source?.machineLabel ?? '')) {
    return false;
  }
  if (fields.provider !== undefined && row.providerDisplay !== fields.provider) {
    return false;
  }
  if (fields.model !== undefined && !sessionModelKeys(row).includes(fields.model)) {
    return false;
  }
  if (fields.project !== undefined && row.projectKey !== fields.project) {
    return false;
  }
  if (request.range.from && (row.activeTime === null || row.activeTime < Date.parse(request.range.from))) {
    return false;
  }
  if (request.range.to && (row.activeTime === null || row.activeTime > Date.parse(request.range.to))) {
    return false;
  }
  return true;
};

const cursorScopeHash = (revision: string, requestFingerprint: string): string =>
  fnv1a64(`${revision}\n${requestFingerprint}`);

const parseCursorScope = (
  request: Pick<SessionQueryRequest, 'cursor' | 'revision'>,
  requestFingerprint: string,
): { cursor: string | null; requestFingerprint: string; revision: string } => ({
  cursor: parseCursor(request.cursor),
  requestFingerprint: requireTrimmedString(requestFingerprint, 'requestFingerprint'),
  revision: requireTrimmedString(request.revision, 'revision', MAX_REVISION_LENGTH),
});

const offsetFromCursor = (cursor: string | null, revision: string, requestFingerprint: string): number => {
  if (cursor === null) {
    return 0;
  }
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match || match[1] !== cursorScopeHash(revision, requestFingerprint)) {
    throw new SessionQueryCursorError('Session query cursor does not match the requested revision and query');
  }
  const offset = Number.parseInt(match[2] ?? '', 36);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SessionQueryCursorError('Session query cursor contains an invalid offset');
  }
  return offset;
};

/** Validate an opaque cursor and return its storage offset for a validated query scope. */
export const sessionQueryPageOffset = (
  request: Pick<SessionQueryRequest, 'cursor' | 'revision'>,
  requestFingerprint: string,
): number => {
  const scope = parseCursorScope(request, requestFingerprint);
  return offsetFromCursor(scope.cursor, scope.revision, scope.requestFingerprint);
};

/** Issue the next opaque cursor after storage has fetched pageSize + 1 rows. */
export const sessionQueryNextCursor = (
  request: Pick<SessionQueryRequest, 'cursor' | 'revision'>,
  requestFingerprint: string,
  nextOffset: number,
): string => {
  const scope = parseCursorScope(request, requestFingerprint);
  if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) {
    throw new SessionQueryCursorError('Session query cursor offset must be a non-negative safe integer');
  }
  return `sq1.${cursorScopeHash(scope.revision, scope.requestFingerprint)}.${nextOffset.toString(36)}`;
};

const boundedPage = <T>(
  items: T[],
  pageSize: number,
  offset: number,
): { hasMore: boolean; items: T[]; nextOffset: number } => {
  const pageWithSentinel = items.slice(offset, offset + pageSize + 1);
  const hasMore = pageWithSentinel.length > pageSize;
  return {
    hasMore,
    items: hasMore ? pageWithSentinel.slice(0, pageSize) : pageWithSentinel,
    nextOffset: offset + pageSize,
  };
};

/**
 * Static/fixture projection for parity with the storage query contract. Served
 * adapters must page in SQLite with LIMIT pageSize + 1 rather than use this
 * in-memory helper as a storage implementation.
 */
export const projectSessionPage = (rows: SerializedRow[], input: SessionQueryRequest): SessionPageResult => {
  const request = parseSessionQueryRequest(input);
  const requestFingerprint = sessionQueryFingerprint(request);
  const offset = sessionQueryPageOffset(request, requestFingerprint);
  const allRows = rows.map(enrichSessionPresentationRow);
  const visibleRows = allRows.filter((row) => matchesSessionQuery(row, request));
  const campaignItems = buildSessionCampaignTableItems(allRows, visibleRows, request.sort, request.campaigns);
  const page = boundedPage(campaignItems, request.pageSize, offset);
  const items: SessionPageItem[] = page.items.map((item) =>
    item.kind === 'campaign'
      ? {
          campaignKey: item.campaign.campaignKey,
          kind: 'campaign',
          row: sessionCampaignDisplayRow(item.campaign, request.sort, false),
        }
      : { kind: 'session', row: item.row },
  );
  return {
    itemCount: campaignItems.length,
    items,
    nextCursor: page.hasMore ? sessionQueryNextCursor(request, requestFingerprint, page.nextOffset) : null,
    requestFingerprint,
    revision: request.revision,
    sessionCount: visibleRows.length,
  };
};

export const projectSessionCampaignChildren = (
  rows: SerializedRow[],
  input: SessionCampaignChildrenRequest,
): SessionCampaignChildrenResult => {
  const request = parseSessionCampaignChildrenRequest(input);
  const requestFingerprint = sessionCampaignChildrenFingerprint(request);
  const offset = sessionQueryPageOffset(request.query, requestFingerprint);
  const allRows = rows.map(enrichSessionPresentationRow);
  const visibleRows = allRows.filter((row) => matchesSessionQuery(row, request.query));
  const campaign = buildSessionCampaignViews(allRows, visibleRows).find(
    (candidate) => candidate.campaignKey === request.campaignKey,
  );
  const children = campaign ? buildSortedSessionPresentationRows(campaign.visibleChildren, request.query.sort) : [];
  const page = boundedPage(children, request.query.pageSize, offset);
  return {
    campaignKey: request.campaignKey,
    itemCount: children.length,
    items: page.items,
    nextCursor: page.hasMore ? sessionQueryNextCursor(request.query, requestFingerprint, page.nextOffset) : null,
    requestFingerprint,
    revision: request.query.revision,
    sessionCount: children.length,
  };
};

export const projectSessionNeighbors = (
  rows: SerializedRow[],
  input: SessionNeighborRequest,
): SessionNeighborResult => {
  const request = parseSessionNeighborRequest(input);
  const requestFingerprint = sessionNeighborFingerprint(request);
  const sequence = buildSortedSessionPresentationRows(
    rows.map(enrichSessionPresentationRow).filter((row) => matchesSessionQuery(row, request.query)),
    request.query.sort,
  );
  const index = sequence.findIndex((row) => row.rowId === request.rowId);
  return {
    found: index >= 0,
    next: index >= 0 ? (sequence[index + 1] ?? null) : null,
    previous: index >= 0 ? (sequence[index - 1] ?? null) : null,
    requestFingerprint,
    revision: request.query.revision,
  };
};
