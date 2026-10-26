import { normalizeCodexAppServerQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Data, Effect } from 'effect';
import {
  CodexAppServerError,
  type CodexAppServerOptions,
  openCodexAppServer,
  readCodexAccount,
} from './codex-app-server-client';
import type { ProviderQuotaBatchSource } from './provider-quota';

export type CodexQuotaCollectionErrorReason =
  | 'unsupported'
  | 'timeout'
  | 'auth-required'
  | 'protocol'
  | 'malformed-result'
  | 'empty-limits'
  | 'aborted';
export class CodexQuotaCollectionError extends Data.TaggedError('CodexQuotaCollectionError')<{
  readonly message: string;
  readonly reason: CodexQuotaCollectionErrorReason;
}> {}
export interface CodexAppServerSourceOptions extends CodexAppServerOptions {}

export const createCodexAppServerBatchSource = (
  options: CodexAppServerSourceOptions = {},
): ProviderQuotaBatchSource<CodexQuotaCollectionError> => ({
  collect: (request) =>
    Effect.tryPromise({
      try: async () => {
        request.signal?.throwIfAborted();
        const client = await openCodexAppServer(options);
        const abort = (): void => {
          client.stop().catch(() => undefined);
        };
        request.signal?.addEventListener('abort', abort, { once: true });
        try {
          request.signal?.throwIfAborted();
          const account = await readCodexAccount(client);
          if (account.authMethod !== 'chatgpt' || account.accountFingerprint === null) {
            throw new CodexQuotaCollectionError({
              message: 'Codex ChatGPT account identity is unavailable',
              reason: 'auth-required',
            });
          }
          // A caller-provided account label must not relabel a different signed-in account.
          if (
            request.accountScope !== undefined &&
            request.accountScope !== null &&
            request.accountScope !== account.accountFingerprint
          ) {
            throw new CodexQuotaCollectionError({
              message: 'Codex quota account does not match the requested scope',
              reason: 'auth-required',
            });
          }
          const observation = normalizeCodexAppServerQuotaObservation({
            accountScope: account.accountFingerprint,
            machineId: request.machineId,
            ...(request.machineLabel === undefined ? {} : { machineLabel: request.machineLabel }),
            observedAt: request.observedAt ?? new Date(),
            result: account.quota,
          });
          if (observation === null) {
            throw new CodexQuotaCollectionError({
              message: 'Codex app-server returned invalid quota limits',
              reason: 'malformed-result',
            });
          }
          if (observation.windows.length === 0) {
            throw new CodexQuotaCollectionError({
              message: 'Codex app-server returned no quota windows',
              reason: 'empty-limits',
            });
          }
          request.signal?.throwIfAborted();
          return { checkpoints: [], hasMore: false, observations: [observation], sourceEvents: [] };
        } finally {
          request.signal?.removeEventListener('abort', abort);
          await client.stop();
        }
      },
      catch: (cause) => {
        if (cause instanceof CodexQuotaCollectionError) {
          return cause;
        }
        let reason: CodexQuotaCollectionErrorReason = 'protocol';
        if (request.signal?.aborted) {
          reason = 'aborted';
        } else if (cause instanceof CodexAppServerError && cause.kind === 'timeout') {
          reason = 'timeout';
        } else if (cause instanceof CodexAppServerError && cause.kind === 'unavailable') {
          reason = 'unsupported';
        }
        return new CodexQuotaCollectionError({ reason, message: 'Codex app-server account/quota observation failed' });
      },
    }),
});
