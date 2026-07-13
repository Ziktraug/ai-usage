import type { UsageReportPayload } from '@ai-usage/report-core/report-data';

export type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

export type WebReportPayload = Omit<UsageReportPayload, 'datasets' | 'facets' | 'tableRows'> & {
  datasets?: Record<string, JsonValue>;
  facets?: Record<string, JsonValue>;
};

declare const reportRevisionBrand: unique symbol;

export type ReportRevision = string & { readonly [reportRevisionBrand]: true };

export type WebReportPayloadWithoutRows = Omit<WebReportPayload, 'rows'>;

export interface WebReportRowsSlice {
  revision: ReportRevision;
  rows: WebReportPayload['rows'];
}

export interface WebReportSupportSlice {
  payloadWithoutRows: WebReportPayloadWithoutRows;
  revision: ReportRevision;
}

export interface WebReportPayloadSlices {
  rowsSlice: WebReportRowsSlice;
  supportSlice: WebReportSupportSlice;
}

export type WebReportSliceKind = 'rows' | 'support';

declare const reportRequestFingerprintBrand: unique symbol;

export type ReportRequestFingerprint = string & { readonly [reportRequestFingerprintBrand]: true };

export interface WebReportRevisionManifest {
  captureFingerprint: string;
  expiresAt: number;
  generatedAt: string;
  publishedAt: number;
  revision: ReportRevision;
  rowsBytes: number;
  sessionQueryBytes?: number;
  supportBytes: number;
}

export interface WebReportSliceRequest {
  requestFingerprint: ReportRequestFingerprint;
  revision: ReportRevision;
}

export interface RevisionExpiredError {
  message: string;
  revision: ReportRevision;
  tag: 'RevisionExpired';
}

export interface InvalidRequestFingerprintError {
  message: string;
  revision: ReportRevision;
  tag: 'InvalidRequestFingerprint';
}

export interface RevisionUnavailableError {
  message: string;
  tag: 'RevisionUnavailable';
}

export type WebReportRevisionManifestResult =
  | {
      manifest: WebReportRevisionManifest;
      ok: true;
      requestFingerprint: ReportRequestFingerprint;
    }
  | {
      error: RevisionUnavailableError;
      ok: false;
      requestFingerprint: ReportRequestFingerprint;
    };

export type WebReportRowsSliceResult =
  | {
      ok: true;
      requestFingerprint: ReportRequestFingerprint;
      slice: WebReportRowsSlice;
    }
  | {
      error: InvalidRequestFingerprintError | RevisionExpiredError;
      ok: false;
      requestFingerprint: ReportRequestFingerprint;
    };

export type WebReportSupportSliceResult =
  | {
      ok: true;
      requestFingerprint: ReportRequestFingerprint;
      slice: WebReportSupportSlice;
    }
  | {
      error: InvalidRequestFingerprintError | RevisionExpiredError;
      ok: false;
      requestFingerprint: ReportRequestFingerprint;
    };

const REPORT_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPORT_REQUEST_FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:{},"-]{0,511}$/;

export const reportManifestRequestFingerprint = 'report-manifest:v1:{}' as ReportRequestFingerprint;

export const reportSliceRequestFingerprint = (kind: WebReportSliceKind): ReportRequestFingerprint =>
  `report-${kind}:v1:{}` as ReportRequestFingerprint;

export const parseReportRevision = (value: unknown): ReportRevision => {
  if (typeof value !== 'string' || !REPORT_REVISION_PATTERN.test(value)) {
    throw new Error('Report revision must be a non-empty opaque identifier');
  }
  return value as ReportRevision;
};

export const parseReportRequestFingerprint = (value: unknown): ReportRequestFingerprint => {
  if (typeof value !== 'string' || !REPORT_REQUEST_FINGERPRINT_PATTERN.test(value)) {
    throw new Error('Report request fingerprint must be a non-empty opaque identifier');
  }
  return value as ReportRequestFingerprint;
};

export const parseWebReportSliceRequest = (value: unknown): WebReportSliceRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Report slice request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'requestFingerprint' && key !== 'revision')) {
    throw new Error('Report slice request contains unsupported fields');
  }
  return {
    requestFingerprint: parseReportRequestFingerprint(record.requestFingerprint),
    revision: parseReportRevision(record.revision),
  };
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);

const withoutLegacyCursorAttribution = (
  datasets: Record<string, JsonValue> | undefined,
  facets: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined => {
  if (!(Array.isArray(datasets?.cursorCommitAttribution) && facets)) {
    return facets;
  }
  const cursor = facets.cursor;
  if (!(isJsonRecord(cursor) && Object.hasOwn(cursor, 'commitAttribution'))) {
    return facets;
  }

  const { commitAttribution: _legacyCommitAttribution, ...cursorWithoutAttribution } = cursor;
  if (Object.keys(cursorWithoutAttribution).length > 0) {
    return { ...facets, cursor: cursorWithoutAttribution };
  }
  const { cursor: _legacyCursorFacet, ...facetsWithoutCursor } = facets;
  return Object.keys(facetsWithoutCursor).length > 0 ? facetsWithoutCursor : undefined;
};

export const toWebReportPayload = (payload: UsageReportPayload): WebReportPayload => {
  const { datasets, facets, tableRows: _tableRows, ...webPayload } = payload;
  if (datasets !== undefined && !isJsonRecord(datasets)) {
    throw new Error('Report datasets must contain only JSON-serializable values');
  }
  if (facets !== undefined && !isJsonRecord(facets)) {
    throw new Error('Report facets must contain only JSON-serializable values');
  }
  const webFacets = withoutLegacyCursorAttribution(datasets, facets);
  return {
    ...webPayload,
    ...(datasets === undefined ? {} : { datasets }),
    ...(webFacets === undefined ? {} : { facets: webFacets }),
  };
};

export const splitWebReportPayload = (payload: WebReportPayload, revision: ReportRevision): WebReportPayloadSlices => {
  const { rows, ...payloadWithoutRows } = payload;
  return {
    rowsSlice: { revision, rows },
    supportSlice: { payloadWithoutRows, revision },
  };
};

export const mergeWebReportSlices = (
  rowsSlice: WebReportRowsSlice,
  supportSlice: WebReportSupportSlice,
): WebReportPayload => {
  if (rowsSlice.revision !== supportSlice.revision) {
    throw new Error('Report slices must use the same revision');
  }
  return { ...supportSlice.payloadWithoutRows, rows: rowsSlice.rows };
};
