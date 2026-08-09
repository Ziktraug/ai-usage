import { parseSourceControlCommand, parseSourceControlCommandResponse } from '@ai-usage/report-core/source-control';
import { custom, pipe, transform } from 'valibot';

const parserSchema = <Output>(parser: (input: unknown) => Output, message: string) =>
  pipe(
    custom<unknown>((input) => {
      try {
        parser(input);
        return true;
      } catch {
        return false;
      }
    }, message),
    transform((input) => parser(input)),
  );

export const sourceControlCommandSchema = parserSchema(
  parseSourceControlCommand,
  'Expected an exact bounded source-control command.',
);
export const sourceControlCommandResponseSchema = parserSchema(
  parseSourceControlCommandResponse,
  'Expected an exact bounded source-control command response.',
);

export interface ExplicitControlTransportDescriptor {
  readonly abort: 'request-signal';
  readonly body: 'json-4kib' | 'none';
  readonly csrf: 'not-required' | 'required';
  readonly id: 'source-control-command' | 'source-control-sse';
  readonly method: 'GET' | 'POST';
  readonly path: '/api/source-control' | '/api/source-control/command';
  readonly queryOwnership: 'none';
  readonly response: 'bounded-json' | 'bounded-sse-events';
  readonly trustedLocal: 'required';
}

export const sourceControlSseTransport = {
  abort: 'request-signal',
  body: 'none',
  csrf: 'not-required',
  id: 'source-control-sse',
  method: 'GET',
  path: '/api/source-control',
  queryOwnership: 'none',
  response: 'bounded-sse-events',
  trustedLocal: 'required',
} as const satisfies ExplicitControlTransportDescriptor;

export const sourceControlCommandTransport = {
  abort: 'request-signal',
  body: 'json-4kib',
  csrf: 'required',
  id: 'source-control-command',
  method: 'POST',
  path: '/api/source-control/command',
  queryOwnership: 'none',
  response: 'bounded-json',
  trustedLocal: 'required',
} as const satisfies ExplicitControlTransportDescriptor;

// Source control intentionally has no oRPC procedure: events and commands remain
// explicit transports with lifecycle and byte semantics that Query/RPC must not own.
export const controlContract = {} as const;

export type { SourceControlCommand, SourceControlCommandResponse } from '@ai-usage/report-core/source-control';
