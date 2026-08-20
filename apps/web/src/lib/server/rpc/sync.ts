import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import { isJsonWireValue } from '@ai-usage/web-contract/schema-conventions';
import { parseSyncFleet, parseSyncMachineLabelResult, type SyncFleet, syncContract } from '@ai-usage/web-contract/sync';
import { implement } from '@orpc/server';

const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u;
const INCOMPATIBLE_REASONS = new Set(['migration-failure', 'schema-too-new', 'schema-too-old']);

interface OwnerError {
  readonly message: string;
  readonly reason?: string;
  readonly tag: string;
}

type OwnerResult<Data> =
  | { readonly data: Data; readonly ok: true }
  | { readonly error: OwnerError; readonly ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
};

const parseOwnerResult = <Data>(value: unknown, parseData: (input: unknown) => Data): OwnerResult<Data> => {
  if (!(isJsonWireValue(value) && isRecord(value))) {
    throw new Error('Sync owner result must be a JSON object');
  }
  if (value.ok === true) {
    if (!hasExactKeys(value, ['data', 'ok'])) {
      throw new Error('Sync owner success is invalid');
    }
    return { data: parseData(value.data), ok: true };
  }
  if (value.ok !== false || !hasExactKeys(value, ['error', 'ok']) || !isRecord(value.error)) {
    throw new Error('Sync owner failure is invalid');
  }
  const expectedErrorKeys = value.error.reason === undefined ? ['message', 'tag'] : ['message', 'reason', 'tag'];
  if (
    !hasExactKeys(value.error, expectedErrorKeys) ||
    typeof value.error.message !== 'string' ||
    value.error.message.length === 0 ||
    typeof value.error.tag !== 'string' ||
    value.error.tag.length === 0 ||
    (value.error.reason !== undefined && typeof value.error.reason !== 'string')
  ) {
    throw new Error('Sync owner error is invalid');
  }
  return {
    error: {
      message: value.error.message,
      ...(value.error.reason === undefined ? {} : { reason: value.error.reason }),
      tag: value.error.tag,
    },
    ok: false,
  };
};

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

export interface SyncRpcDependencies {
  readonly getFleet: (signal: AbortSignal | undefined) => Promise<unknown>;
  readonly setMachineLabel: (input: { readonly label: string }, signal: AbortSignal | undefined) => Promise<unknown>;
}

export const createSyncRpcRouter = (dependencies: SyncRpcDependencies) => {
  const sync = implement(syncContract);
  return {
    fleet: sync.fleet.handler(async ({ errors, signal }) => {
      signal?.throwIfAborted();
      let result: OwnerResult<SyncFleet>;
      try {
        result = parseOwnerResult(await dependencies.getFleet(signal), parseSyncFleet);
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.Unavailable({
          data: { reason: 'sync-fleet-unavailable' },
          message: 'Sync fleet data could not be read safely.',
        });
      }
      if (result.ok) {
        return result.data;
      }
      if (result.error.reason && INCOMPATIBLE_REASONS.has(result.error.reason)) {
        throw errors.IncompatibleStore({
          data: { reason: 'incompatible-store' },
          message: 'Stored usage data is incompatible with this web application.',
        });
      }
      throw errors.Unavailable({
        data: { reason: 'sync-fleet-unavailable' },
        message: 'Sync fleet data could not be read safely.',
      });
    }),
    // The engine owns machine identity: the renamed machine comes back from the command completion,
    // so a rename the engine refused cannot be reported as applied.
    setMachineLabel: sync.setMachineLabel.handler(async ({ errors, input, signal }) => {
      signal?.throwIfAborted();
      try {
        const machine = parseSyncMachineLabelResult(await dependencies.setMachineLabel({ label: input.label }, signal));
        signal?.throwIfAborted();
        return machine;
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.EngineUnavailable({
          data: { reason: 'machine-label-unavailable' },
          message: 'The machine could not be renamed.',
        });
      }
    }),
  };
};

export type SyncRpcRouter = ReturnType<typeof createSyncRpcRouter>;

interface ManualMergeExportData {
  readonly bytes: number;
  readonly filename: string;
  readonly rows: number;
  readonly text: string;
}

export interface ManualMergeExportCandidate extends ManualMergeExportData {
  readonly machine: unknown;
}

const parseManualMergeExportData = (
  value: unknown,
  expectedKeys: readonly string[],
  errorPrefix: string,
  byteIdentityError: string,
): ManualMergeExportData => {
  if (!isJsonWireValue(value)) {
    throw new Error(`${errorPrefix} is invalid`);
  }
  if (!(isRecord(value) && hasExactKeys(value, expectedKeys))) {
    throw new Error(`${errorPrefix} is invalid`);
  }
  if (
    typeof value.filename !== 'string' ||
    !SAFE_FILENAME_PATTERN.test(value.filename) ||
    !value.filename.endsWith('.json') ||
    typeof value.text !== 'string' ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0 ||
    Number(value.bytes) > MAX_PORTABLE_USAGE_BYTES ||
    !Number.isSafeInteger(value.rows) ||
    Number(value.rows) < 0
  ) {
    throw new Error(`${errorPrefix} metadata is invalid`);
  }
  const bytes = new TextEncoder().encode(value.text).byteLength;
  if (bytes !== value.bytes) {
    throw new Error(byteIdentityError);
  }
  return { bytes, filename: value.filename, rows: Number(value.rows), text: value.text };
};

const parseManualMergeExportCandidate = (value: unknown): ManualMergeExportCandidate => {
  const data = parseManualMergeExportData(
    value,
    ['bytes', 'filename', 'machine', 'rows', 'text'],
    'Manual merge export data',
    'Manual merge export identity is invalid',
  );
  if (!(isRecord(value) && isRecord(value.machine))) {
    throw new Error('Manual merge export identity is invalid');
  }
  return {
    bytes: data.bytes,
    filename: data.filename,
    machine: value.machine,
    rows: data.rows,
    text: data.text,
  };
};

const parseCanonicalManualMergeExport = (value: unknown): ManualMergeExportData =>
  parseManualMergeExportData(
    value,
    ['bytes', 'filename', 'rows', 'text'],
    'Canonical manual merge export',
    'Canonical manual merge export byte identity is invalid',
  );

export interface ManualMergeExplicitDependencies {
  /**
   * The deep domain owner parses the candidate, serializes it authoritatively,
   * and derives its canonical machine/generatedAt filename before returning it.
   */
  readonly canonicalizeExport: (
    candidate: ManualMergeExportCandidate,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
  readonly exportBundle: (signal: AbortSignal) => Promise<unknown>;
  readonly handleUpload: (request: Request) => Promise<Response>;
}

const explicitFailure = (status: number, reason: string, message: string): Response =>
  Response.json({ error: { message, reason, tag: 'ManualMergeTransportError' }, ok: false }, { status });

const methodNotAllowed = (): Response => new Response(null, { headers: { allow: 'POST' }, status: 405 });

export const createManualMergeDownloadHandler =
  (dependencies: Pick<ManualMergeExplicitDependencies, 'canonicalizeExport' | 'exportBundle'>) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return methodNotAllowed();
    }
    if (request.body !== null) {
      return explicitFailure(400, 'unexpected-body', 'Manual exports do not accept a request body.');
    }
    if (request.signal.aborted) {
      return explicitFailure(499, 'aborted', 'The manual export was cancelled.');
    }
    let result: OwnerResult<ManualMergeExportCandidate>;
    try {
      result = parseOwnerResult(await dependencies.exportBundle(request.signal), parseManualMergeExportCandidate);
    } catch (error) {
      if (isAbortError(error, request.signal)) {
        return explicitFailure(499, 'aborted', 'The manual export was cancelled.');
      }
      return explicitFailure(503, 'export-unavailable', 'The manual export could not be created safely.');
    }
    if (request.signal.aborted) {
      return explicitFailure(499, 'aborted', 'The manual export was cancelled.');
    }
    if (!result.ok) {
      const incompatible = result.error.reason && INCOMPATIBLE_REASONS.has(result.error.reason);
      return incompatible
        ? explicitFailure(409, 'incompatible-store', 'Stored usage data is incompatible with this web application.')
        : explicitFailure(503, 'export-unavailable', 'The manual export could not be created safely.');
    }
    let canonical: ManualMergeExportData;
    try {
      canonical = parseCanonicalManualMergeExport(await dependencies.canonicalizeExport(result.data, request.signal));
    } catch (error) {
      if (isAbortError(error, request.signal)) {
        return explicitFailure(499, 'aborted', 'The manual export was cancelled.');
      }
      return explicitFailure(503, 'export-unavailable', 'The manual export could not be created safely.');
    }
    if (request.signal.aborted) {
      return explicitFailure(499, 'aborted', 'The manual export was cancelled.');
    }
    return new Response(canonical.text, {
      headers: {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${canonical.filename}"`,
        'content-length': String(canonical.bytes),
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
      status: 200,
    });
  };

export const createManualMergeUploadHandler =
  (handleUpload: ManualMergeExplicitDependencies['handleUpload']) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return methodNotAllowed();
    }
    return await handleUpload(request);
  };

export const createManualMergeExplicitHandlers = (dependencies: ManualMergeExplicitDependencies) => ({
  download: createManualMergeDownloadHandler(dependencies),
  upload: createManualMergeUploadHandler(dependencies.handleUpload),
});
