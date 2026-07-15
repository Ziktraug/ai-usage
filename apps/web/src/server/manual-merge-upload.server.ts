import { MAX_PORTABLE_USAGE_BYTES, MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import type { ManualOperationResult } from '../manual-transfer-contract';
import { validateTrustedLocalRequest } from './local-request-trust.server';

const BYTE_COUNT_PATTERN = /^\d+$/;
const WHITESPACE_PATTERN = /\s/;

type ManualMergeUploadResult = ManualOperationResult<unknown>;
type ManualMergeUploadFailure = Extract<ManualMergeUploadResult, { ok: false }>;

interface ManualMergeUploadOptions {
  confirmBundle?: (
    document: { bytes: Uint8Array; text: string },
    expected: { digest: string; generation: number; storeStateToken: string },
  ) => Promise<ManualMergeUploadResult>;
  importBundle?: (text: string) => Promise<ManualMergeUploadResult>;
  maxBytes?: number;
  maxRows?: number;
  previewBundle?: (document: { bytes: Uint8Array; text: string }) => Promise<ManualMergeUploadResult>;
}

const jsonFailure = (status: number, tag: string, message: string, reason?: string) =>
  Response.json(
    {
      ok: false,
      error: { tag, message, ...(reason === undefined ? {} : { reason }) },
    } satisfies ManualMergeUploadFailure,
    { status },
  );

const validateJsonContentType = (request: Request): Response | null => {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return jsonFailure(415, 'UnsupportedMediaType', 'Manual imports require Content-Type: application/json.');
  }
  return null;
};

type BoundedBodyResult = { bytes: Uint8Array; text: string } | { response: Response };

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
    return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { response: jsonFailure(400, 'InvalidEncoding', 'Manual import files must contain valid UTF-8 JSON.') };
  }
};

const stringEnd = (text: string, start: number): number => {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  return -1;
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (WHITESPACE_PATTERN.test(text[index] ?? '')) {
    index++;
  }
  return index;
};

const topLevelRowsExceedLimit = (text: string, maxRows: number): boolean => {
  let objectDepth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const end = stringEnd(text, index);
      if (end < 0) {
        return false;
      }
      if (objectDepth === 1) {
        const token = text.slice(index, end + 1);
        let key: unknown;
        try {
          key = JSON.parse(token) as unknown;
        } catch {
          return false;
        }
        let cursor = skipWhitespace(text, end + 1);
        if (key === 'rows' && text[cursor] === ':') {
          cursor = skipWhitespace(text, cursor + 1);
          if (text[cursor] !== '[') {
            return false;
          }
          let nestedDepth = 0;
          let rows = 0;
          let hasValue = false;
          for (cursor++; cursor < text.length; cursor++) {
            const rowCharacter = text[cursor];
            if (rowCharacter === '"') {
              const rowStringEnd = stringEnd(text, cursor);
              if (rowStringEnd < 0) {
                return false;
              }
              if (nestedDepth === 0) {
                hasValue = true;
              }
              cursor = rowStringEnd;
            } else if (rowCharacter === '[' || rowCharacter === '{') {
              if (nestedDepth === 0) {
                hasValue = true;
              }
              nestedDepth++;
            } else if (rowCharacter === '}' || (rowCharacter === ']' && nestedDepth > 0)) {
              nestedDepth--;
            } else if (rowCharacter === ']' && nestedDepth === 0) {
              return hasValue ? rows + 1 > maxRows : false;
            } else if (rowCharacter === ',' && nestedDepth === 0) {
              rows++;
              if (rows >= maxRows) {
                return true;
              }
              hasValue = false;
            } else if (!WHITESPACE_PATTERN.test(rowCharacter ?? '') && nestedDepth === 0) {
              hasValue = true;
            }
          }
          return false;
        }
      }
      index = end;
    } else if (character === '{') {
      objectDepth++;
    } else if (character === '}') {
      objectDepth--;
    }
  }
  return false;
};

const rowLimitFailure = (text: string, maxRows: number): Response | null =>
  topLevelRowsExceedLimit(text, maxRows)
    ? jsonFailure(413, 'TooManyRows', `Manual import files must not contain more than ${maxRows} rows.`)
    : null;

const importFailureStatus = (failure: ManualMergeUploadFailure) => {
  if (failure.error.reason === 'invalid-input') {
    return 422;
  }
  if (failure.error.reason === 'self-merge' || failure.error.reason === 'preview-stale') {
    return 409;
  }
  return 500;
};

export const handleManualMergeUpload = async (
  request: Request,
  options: ManualMergeUploadOptions,
): Promise<Response> => {
  const originFailure = validateTrustedLocalRequest(request);
  if (originFailure) {
    return originFailure;
  }
  const contentTypeFailure = validateJsonContentType(request);
  if (contentTypeFailure) {
    return contentTypeFailure;
  }

  const body = await readBoundedBody(request, options.maxBytes ?? MAX_PORTABLE_USAGE_BYTES);
  if ('response' in body) {
    return body.response;
  }
  const rowFailure = rowLimitFailure(body.text, options.maxRows ?? MAX_PORTABLE_USAGE_ROWS);
  if (rowFailure) {
    return rowFailure;
  }
  try {
    JSON.parse(body.text);
  } catch {
    return jsonFailure(400, 'MalformedJson', 'The manual import file does not contain valid JSON.');
  }

  try {
    const action = request.headers.get('x-ai-usage-merge-action') ?? 'import';
    let result: ManualMergeUploadResult;
    if (action === 'preview' && options.previewBundle) {
      result = await options.previewBundle(body);
    } else if (action === 'confirm' && options.confirmBundle) {
      const digest = request.headers.get('x-ai-usage-merge-digest') ?? '';
      const generationText = request.headers.get('x-ai-usage-store-generation') ?? '';
      const storeStateToken = request.headers.get('x-ai-usage-store-state') ?? '';
      const generation = Number(generationText);
      if (!(digest && storeStateToken && Number.isSafeInteger(generation) && generation >= 0)) {
        return jsonFailure(400, 'InvalidConfirmation', 'Manual import confirmation preconditions are missing.');
      }
      result = await options.confirmBundle(body, { digest, generation, storeStateToken });
    } else if (action === 'import' && options.importBundle) {
      result = await options.importBundle(body.text);
    } else {
      return jsonFailure(400, 'InvalidAction', 'Manual import action is not supported.');
    }
    return Response.json(result, { status: result.ok ? 200 : importFailureStatus(result) });
  } catch {
    return jsonFailure(500, 'ImportFailed', 'The server could not process the manual import file.');
  }
};
