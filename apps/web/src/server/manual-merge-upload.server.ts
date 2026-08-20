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
  | { readonly command: 'preview-merge'; readonly input: InboxHandoffInput }
  | ({
      readonly command: 'confirm-merge';
      readonly input: InboxHandoffInput;
    } & MergePreviewProof);
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

const validateJsonContentType = (request: Request): Response | null => {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return jsonFailure(415, 'UnsupportedMediaType', 'Manual imports require Content-Type: application/json.');
  }
  return null;
};

type BoundedBodyResult = { readonly bytes: Uint8Array } | { readonly response: Response };

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
    const chunk = await readAbortableRequestBodyChunk(reader, request.signal);
    if ('aborted' in chunk) {
      return { response: jsonFailure(499, 'UploadAborted', 'The merge upload was cancelled.') };
    }
    if (chunk.done) {
      if (request.signal.aborted) {
        return { response: jsonFailure(499, 'UploadAborted', 'The merge upload was cancelled.') };
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
    return { response: jsonFailure(400, 'EmptyUpload', 'Choose a non-empty usage merge file to import.') };
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
    return { response: jsonFailure(400, 'InvalidEncoding', 'Manual import files must contain valid UTF-8 JSON.') };
  }
  return { bytes };
};

type ParsedManualMergeAction = { readonly action: 'preview' } | ({ readonly action: 'confirm' } & MergePreviewProof);

const parseManualMergeAction = (request: Request): ParsedManualMergeAction | Response => {
  const action = request.headers.get('x-ai-usage-merge-action');
  if (action === 'preview') {
    return { action };
  }
  if (action !== 'confirm') {
    return jsonFailure(400, 'InvalidAction', 'Choose preview or confirm for a manual import.');
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

const engineFailurePresentation = {
  aborted: { message: 'The merge command was cancelled.', status: 503 },
  'authentication-failed': { message: 'The usage engine is unavailable for this merge.', status: 503 },
  'command-failed': { message: 'The usage engine could not complete this merge.', status: 500 },
  'command-rejected': { message: 'The usage engine rejected the merge command.', status: 409 },
  'engine-busy': { message: 'The usage engine is unavailable for this merge.', status: 503 },
  'engine-unavailable': { message: 'The usage engine is unavailable for this merge.', status: 503 },
  'invalid-response': { message: 'The usage engine returned an invalid merge response.', status: 502 },
  'merge-invalid-input': { message: 'The merge file is invalid.', status: 422 },
  'merge-invalid-json': { message: 'The merge file does not contain valid JSON.', status: 400 },
  'merge-self-merge': { message: 'The merge file belongs to this machine.', status: 409 },
  'merge-store-failed': { message: 'The usage store could not apply the merge file.', status: 500 },
  'preview-stale': { message: 'The merge file changed after it was previewed.', status: 409 },
  'protocol-mismatch': { message: 'The usage engine version is incompatible with the web app.', status: 409 },
  'request-too-large': { message: 'The usage engine rejected the merge file size.', status: 413 },
  'response-too-large': { message: 'The usage engine returned an invalid merge response.', status: 502 },
  timeout: { message: 'The usage engine is unavailable for this merge.', status: 503 },
  'transport-failed': { message: 'The usage engine is unavailable for this merge.', status: 503 },
} as const satisfies Readonly<Record<UsageEngineErrorCode, { readonly message: string; readonly status: number }>>;

const engineFailureResponse = (error: UsageEngineCommandCompletionError): Response => {
  const presentation = engineFailurePresentation[error.code];
  return jsonFailure(presentation.status, 'UsageEngineCommandError', presentation.message, error.code);
};

const commandFor = (action: ParsedManualMergeAction, staged: StagedUsageEngineHandoff): ManualMergeCommand =>
  action.action === 'preview'
    ? { command: 'preview-merge', input: staged.input }
    : {
        confirmationToken: action.confirmationToken,
        documentDigest: action.documentDigest,
        command: 'confirm-merge',
        input: staged.input,
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

const completionResponse = (action: ParsedManualMergeAction, completion: UsageEngineCommandCompletion): Response => {
  const expectedCommand = action.action === 'preview' ? 'preview-merge' : 'confirm-merge';
  if (completion.state !== 'succeeded' || completion.command !== expectedCommand) {
    return engineFailureResponse(
      new UsageEngineCommandCompletionError('invalid-response', 'Usage engine returned a mismatched completion.'),
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
  const contentTypeFailure = validateJsonContentType(request);
  if (contentTypeFailure) {
    return contentTypeFailure;
  }
  const action = parseManualMergeAction(request);
  if (action instanceof Response) {
    return action;
  }
  const maximumBytes = options.maxBytes ?? MAX_PORTABLE_USAGE_BYTES;
  if (!(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= MAX_PORTABLE_USAGE_BYTES)) {
    return jsonFailure(500, 'UploadConfigurationError', 'Manual import upload limits are unavailable.');
  }
  const body = await readBoundedBody(request, maximumBytes);
  if ('response' in body) {
    return body.response;
  }
  if (request.signal.aborted) {
    return jsonFailure(499, 'UploadAborted', 'The merge upload was cancelled.');
  }

  const staging = await stageUntilAbort(body.bytes, request.signal, options.stageHandoff);
  if (staging.state === 'aborted') {
    return jsonFailure(499, 'UploadAborted', 'The merge upload was cancelled.');
  }
  if (staging.state === 'failed') {
    return jsonFailure(503, 'EngineInboxUnavailable', 'The usage engine inbox is unavailable.');
  }
  const { staged } = staging;
  if (request.signal.aborted) {
    try {
      await staged.cleanup();
    } catch {
      return jsonFailure(500, 'HandoffCleanupFailed', 'The merge upload could not be cleaned up safely.');
    }
    return jsonFailure(499, 'UploadAborted', 'The merge upload was cancelled.');
  }

  let response: Response;
  try {
    const completion = await options.executeCommand(commandFor(action, staged));
    response = completionResponse(action, completion);
  } catch (error) {
    response =
      error instanceof UsageEngineCommandCompletionError
        ? engineFailureResponse(error)
        : jsonFailure(503, 'UsageEngineUnavailable', 'The usage engine is unavailable for this merge.');
  }
  try {
    await staged.cleanup();
  } catch {
    return jsonFailure(500, 'HandoffCleanupFailed', 'The merge upload could not be cleaned up safely.');
  }
  return response;
};
