import { type MergePreviewProof, parseMergePreviewProof } from '@ai-usage/report-core/merge-proof';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import type { UsageEngineCommandCompletion, UsageEngineErrorCode } from '@ai-usage/usage-engine-control';
import type { StagedUsageEngineHandoff } from '@ai-usage/usage-engine-control/handoff';
import type { ManualOperationResult } from '../manual-transfer-contract';
import { readAbortableRequestBodyChunk } from './abortable-request-body.server';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { UsageEngineCommandCompletionError } from './usage-engine-command.server';

const BYTE_COUNT_PATTERN = /^\d+$/;

type InboxHandoffInput = StagedUsageEngineHandoff['input'];
type ManualMergeCommand =
  | { readonly command: 'import-cursor'; readonly input: InboxHandoffInput }
  | { readonly command: 'preview-merge'; readonly input: InboxHandoffInput }
  | ({
      readonly command: 'confirm-merge';
      readonly input: InboxHandoffInput;
    } & MergePreviewProof);
export type ManualMergeUploadAction = 'confirm' | 'cursor' | 'preview';
type ManualMergeUploadResult = ManualOperationResult<unknown>;
type ManualMergeUploadFailure = Extract<ManualMergeUploadResult, { readonly ok: false }>;

export interface ManualMergeUploadOptions {
  readonly executeCommand: (command: ManualMergeCommand) => Promise<UsageEngineCommandCompletion>;
  readonly maxBytes?: number;
  readonly stageHandoff: (bytes: Uint8Array, signal: AbortSignal) => Promise<StagedUsageEngineHandoff>;
}

const jsonFailure = (status: number, tag: string, message: string, reason?: string): Response =>
  Response.json(
    {
      error: { message, ...(reason === undefined ? {} : { reason }), tag },
      ok: false,
    } satisfies ManualMergeUploadFailure,
    { status },
  );

// A merge bundle is JSON and a Cursor usage export is CSV, so the media type is checked against the
// requested action rather than widened to a set that would let either body reach either command.
const CONTENT_TYPE_BY_ACTION = {
  confirm: 'application/json',
  cursor: 'text/csv',
  preview: 'application/json',
} as const satisfies Readonly<Record<ManualMergeUploadAction, string>>;

const validateContentType = (request: Request, action: ManualMergeUploadAction): Response | null => {
  const expected = CONTENT_TYPE_BY_ACTION[action];
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== expected) {
    return jsonFailure(415, 'UnsupportedMediaType', `Manual imports require Content-Type: ${expected}.`);
  }
  return null;
};

// The upload seam now serves two different documents. Public failure text is what the user acts on,
// so it names the document they actually chose rather than always describing a merge.
interface ManualMergeUploadVocabulary {
  readonly document: string;
  readonly encoding: string;
  readonly operation: string;
}

const MERGE_VOCABULARY: ManualMergeUploadVocabulary = {
  document: 'usage merge file',
  encoding: 'UTF-8 JSON',
  operation: 'merge',
};

const VOCABULARY_BY_ACTION = {
  confirm: MERGE_VOCABULARY,
  cursor: { document: 'Cursor usage export', encoding: 'UTF-8 CSV', operation: 'Cursor import' },
  preview: MERGE_VOCABULARY,
} as const satisfies Readonly<Record<ManualMergeUploadAction, ManualMergeUploadVocabulary>>;

type BoundedBodyResult = { readonly bytes: Uint8Array } | { readonly response: Response };

const readBoundedBody = async (
  request: Request,
  maxBytes: number,
  vocabulary: ManualMergeUploadVocabulary,
): Promise<BoundedBodyResult> => {
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
    return { response: jsonFailure(400, 'EmptyUpload', `Choose a non-empty ${vocabulary.document} to import.`) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await readAbortableRequestBodyChunk(reader, request.signal);
    if ('aborted' in chunk) {
      return { response: jsonFailure(499, 'UploadAborted', `The ${vocabulary.operation} upload was cancelled.`) };
    }
    if (chunk.done) {
      if (request.signal.aborted) {
        return { response: jsonFailure(499, 'UploadAborted', `The ${vocabulary.operation} upload was cancelled.`) };
      }
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
    return { response: jsonFailure(400, 'EmptyUpload', `Choose a non-empty ${vocabulary.document} to import.`) };
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      response: jsonFailure(400, 'InvalidEncoding', `Manual import files must contain valid ${vocabulary.encoding}.`),
    };
  }
  return { bytes };
};

type ParsedManualMergeAction =
  | { readonly action: 'cursor' }
  | { readonly action: 'preview' }
  | ({ readonly action: 'confirm' } & MergePreviewProof);

const parseManualMergeAction = (request: Request): ParsedManualMergeAction | Response => {
  const action = request.headers.get('x-ai-usage-merge-action');
  if (action === 'cursor' || action === 'preview') {
    return { action };
  }
  if (action !== 'confirm') {
    return jsonFailure(400, 'InvalidAction', 'Choose preview, confirm, or cursor for a manual import.');
  }
  try {
    const proof = parseMergePreviewProof({
      confirmationToken: request.headers.get('x-ai-usage-merge-confirmation'),
      documentDigest: request.headers.get('x-ai-usage-merge-digest'),
    });
    return { ...proof, action };
  } catch {
    return jsonFailure(400, 'InvalidConfirmation', 'Manual import confirmation preconditions are invalid.');
  }
};

// The status per engine error code is the same for both documents; only the noun differs, so the
// message is written against the vocabulary of the action the user actually chose. The `merge-*`
// codes stay merge-worded because only the merge commands can produce them.
const engineFailurePresentation = {
  aborted: { message: (words) => `The ${words.operation} command was cancelled.`, status: 503 },
  'authentication-failed': {
    message: (words) => `The usage engine is unavailable for this ${words.operation}.`,
    status: 503,
  },
  'command-failed': { message: (words) => `The usage engine could not complete this ${words.operation}.`, status: 500 },
  'command-rejected': { message: (words) => `The usage engine rejected the ${words.operation} command.`, status: 409 },
  'engine-busy': { message: (words) => `The usage engine is unavailable for this ${words.operation}.`, status: 503 },
  'engine-unavailable': {
    message: (words) => `The usage engine is unavailable for this ${words.operation}.`,
    status: 503,
  },
  'invalid-response': {
    message: (words) => `The usage engine returned an invalid ${words.operation} response.`,
    status: 502,
  },
  'merge-invalid-input': { message: (words) => `The ${words.document} is invalid.`, status: 422 },
  'merge-invalid-json': { message: () => 'The merge file does not contain valid JSON.', status: 400 },
  'merge-self-merge': { message: () => 'The merge file belongs to this machine.', status: 409 },
  'merge-store-failed': { message: (words) => `The usage store could not apply the ${words.document}.`, status: 500 },
  'preview-stale': { message: () => 'The merge file changed after it was previewed.', status: 409 },
  'protocol-mismatch': { message: () => 'The usage engine version is incompatible with the web app.', status: 409 },
  'request-too-large': { message: (words) => `The usage engine rejected the ${words.document} size.`, status: 413 },
  'response-too-large': {
    message: (words) => `The usage engine returned an invalid ${words.operation} response.`,
    status: 502,
  },
  timeout: { message: (words) => `The usage engine is unavailable for this ${words.operation}.`, status: 503 },
  'transport-failed': {
    message: (words) => `The usage engine is unavailable for this ${words.operation}.`,
    status: 503,
  },
} as const satisfies Readonly<
  Record<
    UsageEngineErrorCode,
    { readonly message: (words: ManualMergeUploadVocabulary) => string; readonly status: number }
  >
>;

const engineFailureResponse = (
  error: UsageEngineCommandCompletionError,
  vocabulary: ManualMergeUploadVocabulary,
): Response => {
  const presentation = engineFailurePresentation[error.code];
  return jsonFailure(presentation.status, 'UsageEngineCommandError', presentation.message(vocabulary), error.code);
};

const ENGINE_COMMAND_BY_ACTION = {
  confirm: 'confirm-merge',
  cursor: 'import-cursor',
  preview: 'preview-merge',
} as const satisfies Readonly<Record<ManualMergeUploadAction, ManualMergeCommand['command']>>;

const commandFor = (action: ParsedManualMergeAction, staged: StagedUsageEngineHandoff): ManualMergeCommand => {
  if (action.action === 'confirm') {
    return {
      confirmationToken: action.confirmationToken,
      documentDigest: action.documentDigest,
      command: 'confirm-merge',
      input: staged.input,
    };
  }
  return { command: ENGINE_COMMAND_BY_ACTION[action.action], input: staged.input };
};

type StagingOutcome =
  | { readonly state: 'aborted' }
  | { readonly error: unknown; readonly state: 'failed' }
  | { readonly staged: StagedUsageEngineHandoff; readonly state: 'staged' };

const cleanupLateStaging = (staging: Promise<StagedUsageEngineHandoff>): void => {
  staging.then(
    async (staged) => {
      try {
        await staged.cleanup();
      } catch {
        // Recovery preserves or scavenges an identity-validated handoff when detached cleanup cannot finish.
      }
    },
    () => undefined,
  );
};

const stageUntilAbort = async (
  bytes: Uint8Array,
  signal: AbortSignal,
  stageHandoff: ManualMergeUploadOptions['stageHandoff'],
): Promise<StagingOutcome> => {
  if (signal.aborted) {
    return { state: 'aborted' };
  }
  const staging = stageHandoff(bytes, signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<StagingOutcome>((resolve) => {
    onAbort = () => resolve({ state: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  const settled = staging.then<StagingOutcome, StagingOutcome>(
    (staged) => ({ staged, state: 'staged' }),
    (error: unknown) => ({ error, state: 'failed' }),
  );
  const outcome = await Promise.race([settled, aborted]);
  if (onAbort) {
    signal.removeEventListener('abort', onAbort);
  }
  if (outcome.state === 'aborted') {
    cleanupLateStaging(staging);
  }
  return outcome;
};

const completionResponse = (
  action: ParsedManualMergeAction,
  completion: UsageEngineCommandCompletion,
  vocabulary: ManualMergeUploadVocabulary,
): Response => {
  const expectedCommand = ENGINE_COMMAND_BY_ACTION[action.action];
  if (completion.state !== 'succeeded' || completion.command !== expectedCommand) {
    return engineFailureResponse(
      new UsageEngineCommandCompletionError('invalid-response', 'Usage engine returned a mismatched completion.'),
      vocabulary,
    );
  }
  return Response.json({ data: completion.output, ok: true } satisfies ManualMergeUploadResult, { status: 200 });
};

export const handleManualMergeUpload = async (
  request: Request,
  options: ManualMergeUploadOptions,
): Promise<Response> => {
  const originFailure = validateTrustedLocalRequest(request);
  if (originFailure) {
    return originFailure;
  }
  const action = parseManualMergeAction(request);
  if (action instanceof Response) {
    return action;
  }
  const contentTypeFailure = validateContentType(request, action.action);
  if (contentTypeFailure) {
    return contentTypeFailure;
  }
  const vocabulary = VOCABULARY_BY_ACTION[action.action];
  const maximumBytes = options.maxBytes ?? MAX_PORTABLE_USAGE_BYTES;
  if (!(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= MAX_PORTABLE_USAGE_BYTES)) {
    return jsonFailure(500, 'UploadConfigurationError', 'Manual import upload limits are unavailable.');
  }
  const body = await readBoundedBody(request, maximumBytes, vocabulary);
  if ('response' in body) {
    return body.response;
  }
  if (request.signal.aborted) {
    return jsonFailure(499, 'UploadAborted', `The ${vocabulary.operation} upload was cancelled.`);
  }

  const staging = await stageUntilAbort(body.bytes, request.signal, options.stageHandoff);
  if (staging.state === 'aborted') {
    return jsonFailure(499, 'UploadAborted', `The ${vocabulary.operation} upload was cancelled.`);
  }
  if (staging.state === 'failed') {
    return jsonFailure(503, 'EngineInboxUnavailable', 'The usage engine inbox is unavailable.');
  }
  const { staged } = staging;
  if (request.signal.aborted) {
    try {
      await staged.cleanup();
    } catch {
      return jsonFailure(
        500,
        'HandoffCleanupFailed',
        `The ${vocabulary.operation} upload could not be cleaned up safely.`,
      );
    }
    return jsonFailure(499, 'UploadAborted', `The ${vocabulary.operation} upload was cancelled.`);
  }

  let response: Response;
  try {
    const completion = await options.executeCommand(commandFor(action, staged));
    response = completionResponse(action, completion, vocabulary);
  } catch (error) {
    response =
      error instanceof UsageEngineCommandCompletionError
        ? engineFailureResponse(error, vocabulary)
        : jsonFailure(
            503,
            'UsageEngineUnavailable',
            `The usage engine is unavailable for this ${vocabulary.operation}.`,
          );
  }
  try {
    await staged.cleanup();
  } catch {
    return jsonFailure(500, 'HandoffCleanupFailed', 'The merge upload could not be cleaned up safely.');
  }
  return response;
};
