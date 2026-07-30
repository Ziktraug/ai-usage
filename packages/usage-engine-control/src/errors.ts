import type {
  UsageEngineCommandResult,
  UsageEngineErrorCode,
  UsageEngineErrorPayload,
  UsageEngineEvent,
} from './contracts';

export const stableUsageEngineErrorMessages: Readonly<Record<UsageEngineErrorCode, string>> = {
  aborted: 'Usage engine request was aborted.',
  'authentication-failed': 'Usage engine authentication failed.',
  'command-rejected': 'Usage engine command was rejected.',
  'engine-busy': 'Usage engine is busy.',
  'engine-unavailable': 'Usage engine is unavailable.',
  'invalid-response': 'Usage engine returned an invalid response.',
  'preview-stale': 'The merge file changed after it was previewed.',
  'protocol-mismatch': 'Usage engine protocol version mismatch.',
  'request-too-large': 'Usage engine request exceeds its byte limit.',
  'response-too-large': 'Usage engine response exceeds its byte limit.',
  timeout: 'Usage engine request timed out.',
  'transport-failed': 'Usage engine transport failed.',
};

export const stabilizeUsageEngineErrorPayload = (error: UsageEngineErrorPayload): UsageEngineErrorPayload => ({
  code: error.code,
  message: stableUsageEngineErrorMessages[error.code],
});

export const stabilizeUsageEngineCommandResult = (result: UsageEngineCommandResult): UsageEngineCommandResult =>
  result.ok ? result : { ...result, error: stabilizeUsageEngineErrorPayload(result.error) };

export const stabilizeUsageEngineEvent = (event: UsageEngineEvent): UsageEngineEvent => {
  if (event.event !== 'command-completed' || event.completion.state !== 'failed') {
    return event;
  }
  return {
    ...event,
    completion: {
      ...event.completion,
      error: stabilizeUsageEngineErrorPayload(event.completion.error),
    },
  };
};
