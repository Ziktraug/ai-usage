import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  controlContract,
  sourceControlCommandResponseSchema,
  sourceControlCommandSchema,
  sourceControlCommandTransport,
  sourceControlSseTransport,
} from './control';

const FORBIDDEN_RPC_VALUE_PATTERN = /event|stream|bytes|file/i;

describe('control transport contract', () => {
  test('keeps SSE and commands explicit with frozen trust, CSRF, body, and abort policies', () => {
    expect(sourceControlSseTransport).toEqual({
      abort: 'request-signal',
      body: 'none',
      csrf: 'not-required',
      id: 'source-control-sse',
      method: 'GET',
      path: '/api/source-control',
      queryOwnership: 'none',
      response: 'bounded-sse-events',
      trustedLocal: 'required',
    });
    expect(sourceControlCommandTransport).toEqual({
      abort: 'request-signal',
      body: 'json-4kib',
      csrf: 'required',
      id: 'source-control-command',
      method: 'POST',
      path: '/api/source-control/command',
      queryOwnership: 'none',
      response: 'bounded-json',
      trustedLocal: 'required',
    });
    expect(controlContract).toEqual({});
  });

  test('uses the authoritative closed command and response parsers', () => {
    expect(safeParse(sourceControlCommandSchema, { command: 'run-all' }).success).toBe(true);
    expect(safeParse(sourceControlCommandSchema, { command: 'run-all', token: 'private' }).success).toBe(false);
    expect(
      safeParse(sourceControlCommandResponseSchema, {
        error: { message: 'Unavailable.', reason: 'engine-unavailable', tag: 'SourceControlCommandError' },
        ok: false,
      }).success,
    ).toBe(true);
    expect(
      safeParse(sourceControlCommandResponseSchema, {
        error: {
          message: 'Unavailable.',
          privatePath: '/private/rendezvous',
          reason: 'engine-unavailable',
          tag: 'SourceControlCommandError',
        },
        ok: false,
      }).success,
    ).toBe(false);
  });

  test('does not model streams or command bytes as RPC values', () => {
    expect(JSON.stringify(controlContract)).not.toMatch(FORBIDDEN_RPC_VALUE_PATTERN);
  });
});
