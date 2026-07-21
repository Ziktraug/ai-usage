import { describe, expect, test } from 'bun:test';
import { Redacted } from 'effect';
import { MAX_ANNOTATION_LEVELS, MAX_COMPLETED_HOPS, MAX_SERIALIZED_EVENT_BYTES, type WideEventSnapshot } from './model';
import { sanitizeWideEventSnapshot, serializeWideEventSnapshot } from './sanitize';

const baseEvent = (overrides: Partial<WideEventSnapshot> = {}): WideEventSnapshot => ({
  schemaVersion: 1,
  event: 'wide-event',
  eventId: 'event-1',
  boundary: 'test.boundary',
  startedAt: '2026-07-21T00:00:00.000Z',
  emittedAt: '2026-07-21T00:00:01.000Z',
  traceId: 'trace-1',
  spanId: 'span-1',
  outcome: 'success',
  durationMs: 12,
  error: null,
  annotations: {},
  services: [],
  ...overrides,
});

describe('wide-event sanitizer', () => {
  test('redacts sensitive keys and Redacted values', () => {
    const result = sanitizeWideEventSnapshot(
      baseEvent({
        annotations: {
          token: 'abc',
          password: 'pw',
          authorization: 'Bearer x',
          secret: 's',
          cookie: 'c',
          safe: 'ok',
          nested: { apiToken: 'hidden', count: 1 },
          redacted: Redacted.make('hidden') as unknown as string,
        },
      }),
    );
    expect(result.value.annotations.token).toBe('[REDACTED]');
    expect(result.value.annotations.password).toBe('[REDACTED]');
    expect(result.value.annotations.authorization).toBe('[REDACTED]');
    expect(result.value.annotations.secret).toBe('[REDACTED]');
    expect(result.value.annotations.cookie).toBe('[REDACTED]');
    expect(result.value.annotations.safe).toBe('ok');
    expect(result.value.annotations.nested).toEqual({
      apiToken: '[REDACTED]',
      count: 1,
    });
    expect(result.value.annotations.redacted).toBe('[REDACTED]');
  });

  test('handles cycles, throwing getters, and bigint', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter boom');
      },
    });

    const result = sanitizeWideEventSnapshot(
      baseEvent({
        annotations: {
          cyclic: cyclic as never,
          hostile: hostile as never,
          big: 10n as never,
        },
      }),
    );

    expect(result.truncated).toBe(true);
    const cyclicValue = result.value.annotations.cyclic as Record<string, unknown>;
    expect(cyclicValue.self).toBe('[Circular]');
    expect(result.value.annotations.hostile).toEqual({ boom: '[Unreadable]' });
    expect(result.value.annotations.big).toBe('10');
  });

  test('truncates deep annotation trees', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let index = 0; index < MAX_ANNOTATION_LEVELS + 2; index += 1) {
      deep = { child: deep };
    }
    const result = sanitizeWideEventSnapshot(baseEvent({ annotations: { deep: deep as never } }));
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.value.annotations)).toContain('[Truncated]');
  });

  test('truncates too many hops and marks observabilityTruncated', () => {
    const services = Array.from({ length: MAX_COMPLETED_HOPS + 5 }, (_, index) => ({
      name: `hop-${index}`,
      traceId: 't',
      spanId: `s-${index}`,
      outcome: 'success' as const,
      durationMs: 1,
    }));
    const result = sanitizeWideEventSnapshot(baseEvent({ services }));
    expect(result.truncated).toBe(true);
    expect(result.value.services.length).toBeLessThanOrEqual(MAX_COMPLETED_HOPS);
    expect(result.value.annotations.observabilityTruncated).toBe(true);
  });

  test('oversized events fall back to a minimal safe snapshot', () => {
    const huge = 'x'.repeat(8 * 1024);
    const result = sanitizeWideEventSnapshot(
      baseEvent({
        annotations: { payload: huge },
        services: Array.from({ length: 80 }, (_, index) => ({
          name: `hop-${index}`,
          traceId: 't',
          spanId: `s-${index}`,
          outcome: 'success' as const,
          durationMs: 1,
          annotations: { payload: huge },
        })),
      }),
    );
    expect(result.truncated).toBe(true);
    expect(result.value.annotations.observabilityTruncated).toBe(true);
    expect(serializeWideEventSnapshot(result.value).length).toBeLessThan(MAX_SERIALIZED_EVENT_BYTES);
    expect(result.value.eventId).toBe('event-1');
    expect(result.value.boundary).toBe('test.boundary');
  });

  test('public error messages are bounded', () => {
    const result = sanitizeWideEventSnapshot(
      baseEvent({
        outcome: 'failure',
        error: {
          tag: 'ProviderQuotaRefreshAborted',
          message: 'm'.repeat(4096),
        },
      }),
    );
    expect(result.value.error?.message?.length).toBeLessThanOrEqual(1024);
  });

  test('marks truncated hop identity strings at the root', () => {
    const result = sanitizeWideEventSnapshot(
      baseEvent({
        services: [
          {
            durationMs: 1,
            name: 'n'.repeat(8 * 1024),
            outcome: 'success',
            spanId: 's'.repeat(8 * 1024),
            traceId: 't'.repeat(8 * 1024),
          },
        ],
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.value.annotations.observabilityTruncated).toBe(true);
    expect(result.value.services[0]?.name.length).toBeLessThanOrEqual(4096);
    expect(result.value.services[0]?.spanId.length).toBeLessThanOrEqual(4096);
    expect(result.value.services[0]?.traceId.length).toBeLessThanOrEqual(4096);
  });

  test('bounds root identity strings even in the minimal fallback snapshot', () => {
    const oversizedIdentity = 'x'.repeat(MAX_SERIALIZED_EVENT_BYTES);
    const result = sanitizeWideEventSnapshot(
      baseEvent({
        boundary: oversizedIdentity,
        eventId: oversizedIdentity,
        spanId: oversizedIdentity,
        traceId: oversizedIdentity,
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.value.annotations.observabilityTruncated).toBe(true);
    expect(result.value.boundary.length).toBeLessThanOrEqual(4096);
    expect(result.value.eventId.length).toBeLessThanOrEqual(4096);
    expect(new TextEncoder().encode(serializeWideEventSnapshot(result.value)).byteLength).toBeLessThanOrEqual(
      MAX_SERIALIZED_EVENT_BYTES,
    );
  });
});
