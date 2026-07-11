import type { ManualOperationResult } from '../manual-transfer-contract';

export const MAX_MANUAL_MERGE_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_MANUAL_MERGE_UPLOAD_ROWS = 50_000;
const BYTE_COUNT_PATTERN = /^\d+$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

type ManualMergeUploadResult = ManualOperationResult<unknown>;
type ManualMergeUploadFailure = Extract<ManualMergeUploadResult, { ok: false }>;

interface ManualMergeUploadOptions {
  importBundle: (text: string) => Promise<ManualMergeUploadResult>;
  maxBytes?: number;
  maxRows?: number;
}

const jsonFailure = (status: number, tag: string, message: string, reason?: string) =>
  Response.json(
    {
      ok: false,
      error: { tag, message, ...(reason === undefined ? {} : { reason }) },
    } satisfies ManualMergeUploadFailure,
    { status },
  );

const firstForwardedValue = (value: string | null) => value?.split(',')[0]?.trim();

const isTrustedLocalHost = (host: string) => {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};

const validateRequestOrigin = (request: Request): Response | null => {
  const host = request.headers.get('host')?.trim();
  if (!host) {
    return jsonFailure(400, 'MissingHost', 'Manual imports require a Host header.');
  }
  if (!isTrustedLocalHost(host)) {
    return jsonFailure(403, 'UntrustedHost', 'Manual imports are only accepted by the local application.');
  }

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return jsonFailure(403, 'CrossOriginRequest', 'Manual imports are only accepted from this application.');
  }

  const origin = request.headers.get('origin');
  if (!origin) {
    return null;
  }

  try {
    const requestUrl = new URL(request.url);
    const forwardedProtocol = firstForwardedValue(request.headers.get('x-forwarded-proto'));
    const protocol =
      forwardedProtocol === 'http' || forwardedProtocol === 'https' ? `${forwardedProtocol}:` : requestUrl.protocol;
    const expectedOrigin = new URL(`${protocol}//${host}`).origin;
    if (new URL(origin).origin !== expectedOrigin) {
      return jsonFailure(403, 'CrossOriginRequest', 'Manual imports are only accepted from this application.');
    }
  } catch {
    return jsonFailure(400, 'InvalidOrigin', 'The request Origin or Host header is invalid.');
  }

  return null;
};

const validateJsonContentType = (request: Request): Response | null => {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return jsonFailure(415, 'UnsupportedMediaType', 'Manual imports require Content-Type: application/json.');
  }
  return null;
};

type BoundedBodyResult = { text: string } | { response: Response };

const readBoundedBody = async (request: Request, maxBytes: number): Promise<BoundedBodyResult> => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!BYTE_COUNT_PATTERN.test(contentLength)) {
      return { response: jsonFailure(400, 'InvalidContentLength', 'Content-Length must be a byte count.') };
    }
    if (Number(contentLength) > maxBytes) {
      return {
        response: jsonFailure(413, 'UploadTooLarge', `Manual import files must not exceed ${maxBytes} bytes.`),
      };
    }
  }

  if (!request.body) {
    return { response: jsonFailure(400, 'EmptyUpload', 'Choose a non-empty usage merge file to import.') };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    byteLength += chunk.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return {
        response: jsonFailure(413, 'UploadTooLarge', `Manual import files must not exceed ${maxBytes} bytes.`),
      };
    }
    chunks.push(chunk.value);
  }

  if (byteLength === 0) {
    return { response: jsonFailure(400, 'EmptyUpload', 'Choose a non-empty usage merge file to import.') };
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { response: jsonFailure(400, 'InvalidEncoding', 'Manual import files must contain valid UTF-8 JSON.') };
  }
};

const rowLimitFailure = (text: string, maxRows: number): Response | null => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return jsonFailure(400, 'MalformedJson', 'The manual import file does not contain valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const rows = (value as Record<string, unknown>).rows;
  if (Array.isArray(rows) && rows.length > maxRows) {
    return jsonFailure(413, 'TooManyRows', `Manual import files must not contain more than ${maxRows} rows.`);
  }
  return null;
};

const importFailureStatus = (failure: ManualMergeUploadFailure) => {
  if (failure.error.reason === 'invalid-input') {
    return 422;
  }
  if (failure.error.reason === 'self-merge') {
    return 409;
  }
  return 500;
};

export const handleManualMergeUpload = async (
  request: Request,
  options: ManualMergeUploadOptions,
): Promise<Response> => {
  const originFailure = validateRequestOrigin(request);
  if (originFailure) {
    return originFailure;
  }
  const contentTypeFailure = validateJsonContentType(request);
  if (contentTypeFailure) {
    return contentTypeFailure;
  }

  const body = await readBoundedBody(request, options.maxBytes ?? MAX_MANUAL_MERGE_UPLOAD_BYTES);
  if ('response' in body) {
    return body.response;
  }
  const rowFailure = rowLimitFailure(body.text, options.maxRows ?? MAX_MANUAL_MERGE_UPLOAD_ROWS);
  if (rowFailure) {
    return rowFailure;
  }

  try {
    const result = await options.importBundle(body.text);
    return Response.json(result, { status: result.ok ? 200 : importFailureStatus(result) });
  } catch {
    return jsonFailure(500, 'ImportFailed', 'The server could not process the manual import file.');
  }
};
