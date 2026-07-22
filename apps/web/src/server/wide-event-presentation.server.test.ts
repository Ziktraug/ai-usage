import { describe, expect, test } from 'bun:test';
import { renderPrettyWideEvent, stripWideEventAnsi, type WideEventSnapshot } from '@ai-usage/effect-runtime/node';
import { projectWebWideEvent } from './wide-event-presentation.server';

const baseEvent = (overrides: Partial<WideEventSnapshot> = {}): WideEventSnapshot => ({
  annotations: {},
  boundary: 'source.run',
  durationMs: 5,
  emittedAt: '2026-07-22T10:18:33.342Z',
  error: null,
  event: 'wide-event',
  eventId: 'bd0aa8a8-fixture',
  outcome: 'success',
  resource: {
    instanceId: 'fixture-instance',
    runtimeMode: 'test',
    serviceName: 'ai-usage',
    serviceVersion: '0.1.0-test',
    surface: 'web',
  },
  schemaVersion: 2,
  services: [],
  spanId: 'span',
  startedAt: '2026-07-22T10:18:33.337Z',
  traceId: 'trace',
  ...overrides,
});

const header = (event: WideEventSnapshot): string =>
  stripWideEventAnsi(renderPrettyWideEvent(event, { projector: projectWebWideEvent })).split('\n')[0] ?? '';

describe('web wide-event presentation', () => {
  test('projects changed and unchanged source runs semantically', () => {
    expect(
      header(
        baseEvent({
          annotations: {
            changed: false,
            inputCount: 38,
            outputCount: 38,
            queueDelayMs: 293,
            sourceId: 'cursor.commit-attribution',
          },
        }),
      ),
    ).toBe('10:18:33.342Z  ✓  cursor.commit-attribution  5.0ms  unchanged  38→38  queue=293ms  event=bd0aa8a8');

    expect(
      header(
        baseEvent({
          annotations: { changed: true, inputCount: 4, outputCount: 5, sourceId: 'claude.sessions' },
        }),
      ),
    ).toContain('claude.sessions  5.0ms  changed  4→5');
  });

  test('projects source anomalies, publications, and Session results', () => {
    const degraded = baseEvent({
      annotations: {
        changed: true,
        sourceId: 'cursor.sessions',
        warningCodes: ['partial-history'],
        warningsCount: 1,
      },
      outcome: 'degraded',
    });
    expect(stripWideEventAnsi(renderPrettyWideEvent(degraded, { projector: projectWebWideEvent }))).toContain(
      'warningCodes=["partial-history"]',
    );

    const publication = baseEvent({
      annotations: { changed: true, revision: 'mrvx1234567890' },
      boundary: 'publication',
      durationMs: 372,
    });
    expect(header(publication)).toContain('publication  372.0ms  changed  revision=mrvx1234…');

    const sessions = baseEvent({
      annotations: { hasMore: true, itemCount: 20, sessionCount: 48 },
      boundary: 'web.sessions.read',
    });
    expect(header(sessions)).toContain('sessions  5.0ms  items=20  sessions=48  more');

    const failedSessions = baseEvent({
      annotations: { failureKind: 'query-failed' },
      boundary: 'web.sessions.read',
      outcome: 'failure',
    });
    expect(stripWideEventAnsi(renderPrettyWideEvent(failedSessions, { projector: projectWebWideEvent }))).toContain(
      'failureKind=query-failed',
    );
  });

  test('keeps representative info headers within 140 characters and falls back for unknown boundaries', () => {
    const representative = header(
      baseEvent({
        annotations: {
          changed: false,
          inputCount: 999_999,
          outputCount: 999_999,
          queueDelayMs: 5054,
          sourceId: 'cursor.commit-attribution',
        },
      }),
    );
    expect(representative.length).toBeLessThanOrEqual(140);
    expect(header(baseEvent({ boundary: 'future.boundary' }))).toContain('future.boundary');
  });
});
