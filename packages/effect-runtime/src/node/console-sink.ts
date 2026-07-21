import { Effect, Ref } from 'effect';
import type { ServiceHop, WideEventSnapshot } from '../model';
import { serializeWideEventSnapshot } from '../sanitize';
import type { WideEventSinkDiagnostics, WideEventSinkShape } from '../sink';

export type ConsoleLogFormat = 'json' | 'pretty';

const emptyDiagnostics = (): WideEventSinkDiagnostics => ({
  accepted: 0,
  dropped: 0,
  failed: 0,
});

const formatDuration = (value: number): string => `${value.toFixed(1)}ms`;

const renderHop = (hop: ServiceHop, depth: number): string[] => {
  const indent = '  '.repeat(depth);
  const line = `${indent}- ${hop.name} ${hop.outcome} ${formatDuration(hop.durationMs)}`;
  const children = (hop.children ?? []).flatMap((child) => renderHop(child, depth + 1));
  return [line, ...children];
};

export const renderPrettyWideEvent = (event: WideEventSnapshot): string => {
  const header = `[wide-event] ${event.boundary} ${event.outcome} ${formatDuration(event.durationMs)} eventId=${event.eventId}`;
  const hops = event.services.flatMap((hop) => renderHop(hop, 1));
  return [header, ...hops].join('\n');
};

export const selectConsoleLogFormat = (
  env: NodeJS.ProcessEnv = process.env,
  stderr: { isTTY?: boolean } = process.stderr,
): ConsoleLogFormat => {
  if (env.LOG_FORMAT === 'json') {
    return 'json';
  }
  return stderr.isTTY ? 'pretty' : 'json';
};

export const makeConsoleWideEventSink = (options?: {
  readonly format?: ConsoleLogFormat;
  readonly write?: (line: string) => void;
}): WideEventSinkShape => {
  const format = options?.format ?? selectConsoleLogFormat();
  const write = options?.write ?? ((line: string) => console.error(line));
  const diagnostics = Ref.unsafeMake(emptyDiagnostics());

  return {
    submit: (event) =>
      Effect.gen(function* () {
        try {
          const line = format === 'pretty' ? renderPrettyWideEvent(event) : serializeWideEventSnapshot(event);
          write(line);
          yield* Ref.update(diagnostics, (current) => ({
            ...current,
            accepted: current.accepted + 1,
          }));
        } catch {
          yield* Ref.update(diagnostics, (current) => ({
            ...current,
            failed: current.failed + 1,
          }));
        }
      }),
    diagnostics: () => Ref.get(diagnostics),
  };
};
