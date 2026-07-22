import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import type { WideEventSnapshot } from '../model';
import { combineWideEventSinks, makeCaptureWideEventSink } from '../sink';
import {
  makeConsoleWideEventSink,
  renderPrettyWideEvent,
  selectConsoleLogLevel,
  stripWideEventAnsi,
} from './console-sink';

const sampleEvent = (id: string): WideEventSnapshot => ({
  schemaVersion: 2,
  event: 'wide-event',
  eventId: id,
  boundary: 'test.boundary',
  startedAt: '2026-07-21T00:00:00.000Z',
  emittedAt: '2026-07-21T00:00:01.000Z',
  traceId: 'trace',
  spanId: 'span',
  outcome: 'success',
  durationMs: 1,
  error: null,
  resource: {
    instanceId: 'fixture-instance',
    runtimeMode: 'test',
    serviceName: 'ai-usage',
    serviceVersion: '0.1.0-test',
    surface: 'web',
  },
  annotations: { sourceId: 'cursor' },
  services: [],
});

const sourceRunFixture: WideEventSnapshot = {
  ...sampleEvent('source-success'),
  boundary: 'source.run',
  annotations: { changed: true, sourceId: 'cursor', warningsCount: 0 },
};

const publicationFixture: WideEventSnapshot = {
  ...sampleEvent('publication-success'),
  boundary: 'publication',
  annotations: { changed: true, revision: 'fixture-revision' },
};

const sessionsReadFixture: WideEventSnapshot = {
  ...sampleEvent('sessions-success'),
  boundary: 'web.sessions.read',
  annotations: { fingerprint: 'fixture-fingerprint', revision: 'fixture-revision' },
};

const degradedFixture: WideEventSnapshot = {
  ...sourceRunFixture,
  annotations: { changed: true, sourceId: 'cursor', warningsCount: 1 },
  eventId: 'source-degraded',
  outcome: 'degraded',
};

const failedFixture: WideEventSnapshot = {
  ...sessionsReadFixture,
  error: { code: 'query-failed', message: 'Fixture query failed', tag: 'QueryFailed' },
  eventId: 'sessions-failed',
  outcome: 'failure',
};

describe('console wide-event sink', () => {
  test('renders a semantic pretty view and one physical JSON line', () => {
    const lines: string[] = [];
    const pretty = makeConsoleWideEventSink({
      format: 'pretty',
      write: (line) => lines.push(line),
    });
    Effect.runSync(
      pretty.submit({
        ...sampleEvent('pretty'),
        services: [
          {
            name: 'child',
            traceId: 't',
            spanId: 's',
            outcome: 'success',
            durationMs: 2,
          },
        ],
      }),
    );
    expect(stripWideEventAnsi(lines[0] ?? '')).toBe('00:00:01.000Z  ✓  test.boundary  1.0ms  event=pretty');

    const jsonLines: string[] = [];
    const json = makeConsoleWideEventSink({
      format: 'json',
      write: (line) => jsonLines.push(line),
    });
    Effect.runSync(json.submit(sampleEvent('json')));
    expect(jsonLines).toHaveLength(1);
    expect(jsonLines[0]?.includes('\n')).toBe(false);
    expect(JSON.parse(jsonLines[0]!).eventId).toBe('json');
  });

  test('keeps identity fields in pretty output', () => {
    const text = renderPrettyWideEvent(sampleEvent('pretty-id'));
    expect(text).toContain('test.boundary');
    expect(text).toContain('event=pretty-i');
  });

  test('expands public failure context as bounded multiline detail', () => {
    const text = renderPrettyWideEvent({
      ...sampleEvent('12345678-1234-1234-1234-123456789abc'),
      error: { code: 'paused', message: 'Collection is paused', tag: 'CliArgumentError' },
      outcome: 'failure',
    });

    expect(text).toContain('error CliArgumentError/paused: "Collection is paused"');
    expect(text).toContain('event=12345678');
    expect(text.includes('\n')).toBe(true);
  });

  test('routes outcomes by severity and filters only the console transport', () => {
    const writes: Array<{ line: string; severity: string }> = [];
    const sink = makeConsoleWideEventSink({
      format: 'pretty',
      level: 'warn',
      write: (line, severity) => writes.push({ line, severity }),
    });

    Effect.runSync(sink.submit(sourceRunFixture));
    Effect.runSync(sink.submit(degradedFixture));
    Effect.runSync(sink.submit(failedFixture));

    expect(writes.map(({ severity }) => severity)).toEqual(['warn', 'error']);
    expect(writes.map(({ line }) => stripWideEventAnsi(line).split('\n')[0])).toEqual([
      '00:00:01.000Z  !  source.run  1.0ms  event=source-d',
      '00:00:01.000Z  ✗  web.sessions.read  1.0ms  event=sessions',
    ]);
  });

  test('debug includes complete hops, annotations, and resource context', () => {
    const text = renderPrettyWideEvent(
      {
        ...sourceRunFixture,
        services: [
          {
            annotations: { phase: 'outer' },
            children: [
              {
                durationMs: 1,
                name: 'inner',
                outcome: 'success',
                spanId: 'inner-span',
                traceId: 'trace',
              },
            ],
            durationMs: 2,
            name: 'outer',
            outcome: 'success',
            spanId: 'outer-span',
            traceId: 'trace',
          },
        ],
      },
      { detail: 'debug' },
    );

    const stripped = stripWideEventAnsi(text);
    expect(stripped).toContain('└─ ✓ outer 2.0ms  phase=outer');
    expect(stripped).toContain('   └─ ✓ inner 1.0ms');
    expect(stripped).toContain('annotations changed=true sourceId=cursor warningsCount=0');
    expect(stripped).toContain('resource web/test ai-usage@0.1.0-test instance=fixture-instance');
  });

  test('reports omitted hops only when the rendering budget was exceeded', () => {
    const services = Array.from({ length: 32 }, (_, index) => ({
      durationMs: 1,
      name: `hop-${index}`,
      outcome: 'success' as const,
      spanId: `span-${index}`,
      traceId: 'trace',
    }));

    const text = stripWideEventAnsi(
      renderPrettyWideEvent({ ...sampleEvent('exact-hop-budget'), services }, { detail: 'debug' }),
    );

    expect(text).not.toContain('additional hops omitted');
    expect(
      stripWideEventAnsi(
        renderPrettyWideEvent(
          {
            ...sampleEvent('exceeded-hop-budget'),
            services: [
              ...services,
              {
                durationMs: 1,
                name: 'hop-32',
                outcome: 'success',
                spanId: 'span-32',
                traceId: 'trace',
              },
            ],
          },
          { detail: 'debug' },
        ),
      ),
    ).toContain('additional hops omitted');
  });

  test('shows a nested failing hop in anomaly output at info detail', () => {
    const text = stripWideEventAnsi(
      renderPrettyWideEvent({
        ...sampleEvent('nested-failure'),
        annotations: { failureKind: 'query-failed' },
        outcome: 'failure',
        services: [
          {
            children: [
              {
                durationMs: 1,
                name: 'revision.parse',
                outcome: 'failure',
                spanId: 'parse-span',
                traceId: 'trace',
              },
            ],
            durationMs: 2,
            name: 'revision.execute',
            outcome: 'success',
            spanId: 'execute-span',
            traceId: 'trace',
          },
        ],
      }),
    );

    expect(text).toContain('└─ ✗ revision.parse 1.0ms');
  });

  test('parses LOG_LEVEL defensively', () => {
    expect(selectConsoleLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
    expect(selectConsoleLogLevel({ LOG_LEVEL: 'unexpected' })).toBe('info');
  });

  test('reports logical submissions separately from transport delivery', () => {
    const file = makeCaptureWideEventSink();
    const consoleSink = makeCaptureWideEventSink();
    const combined = combineWideEventSinks({ name: 'file', sink: file }, { name: 'console', sink: consoleSink });

    Effect.runSync(combined.submit(sourceRunFixture));
    expect(Effect.runSync(combined.diagnostics())).toEqual({
      accepted: 1,
      dropped: 0,
      failed: 0,
      submitted: 1,
      transports: {
        console: { accepted: 1, dropped: 0, failed: 0 },
        file: { accepted: 1, dropped: 0, failed: 0 },
      },
    });
  });

  test('fixtures represent audited boundary and anomaly shapes without local data', () => {
    expect([
      sourceRunFixture.boundary,
      publicationFixture.boundary,
      sessionsReadFixture.boundary,
      degradedFixture.outcome,
      failedFixture.outcome,
    ]).toEqual(['source.run', 'publication', 'web.sessions.read', 'degraded', 'failure']);
  });
});
