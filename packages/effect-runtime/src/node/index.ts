import { Effect, Layer } from 'effect';
import { makeWideEventResourceLayer, type WideEventResourceInput, type WideEventResourceService } from '../resource';
import {
  combineWideEventSinks,
  makeWideEventSinkLayer,
  noopWideEventSink,
  WideEventSink,
  type WideEventSinkShape,
} from '../sink';
import {
  type ConsoleLogFormat,
  type ConsoleWideEventWriter,
  defaultConsoleWideEventWriter,
  makeConsoleWideEventSink,
  type PrettyWideEventProjector,
  selectConsoleLogFormat,
} from './console-sink';
import { createFileWideEventSink, type FileWideEventSinkOptions, makeFileWideEventSinkLayer } from './file-sink';
import { resolveWideEventLogDirectory } from './resolve-log-dir';

export type { LogValue, WideEventSnapshot } from '../model';
export type {
  ConsoleLogFormat,
  ConsoleLogLevel,
  ConsoleSeverity,
  ConsoleWideEventWriter,
  PrettyWideEventProjector,
  PrettyWideEventView,
} from './console-sink';
export {
  defaultConsoleWideEventWriter,
  genericPrettyWideEventProjector,
  makeConsoleWideEventSink,
  renderPrettyWideEvent,
  selectConsoleLogFormat,
  selectConsoleLogLevel,
  stripWideEventAnsi,
} from './console-sink';
export type { FileWideEventSinkOptions } from './file-sink';
export { createFileWideEventSink, makeFileWideEventSinkLayer } from './file-sink';
export {
  acquireCooperativeLock,
  assertSafeRegularFilePath,
  ensureOwnedLogDirectory,
  withCooperativeLock,
} from './lock';
export { resolveWideEventLogDirectory } from './resolve-log-dir';

export const makeCliWideEventSinkLayer = (
  options: Omit<FileWideEventSinkOptions, 'directory'> & {
    readonly directory?: string | null;
    readonly resource: WideEventResourceInput;
  },
): Layer.Layer<WideEventResourceService | WideEventSink> =>
  Layer.merge(makeFileWideEventSinkLayer(options), makeWideEventResourceLayer(options.resource));

export const makeWebWideEventSinkLayer = (
  options: Omit<FileWideEventSinkOptions, 'directory'> & {
    readonly directory?: string | null;
    readonly format?: ConsoleLogFormat;
    readonly resource: WideEventResourceInput;
    readonly consoleWrite?: ConsoleWideEventWriter;
    readonly projector?: PrettyWideEventProjector;
    readonly silenceConsole?: boolean;
  },
): Layer.Layer<WideEventResourceService | WideEventSink> =>
  Layer.merge(
    Layer.scoped(
      WideEventSink,
      Effect.gen(function* () {
        const directory =
          options.directory === undefined
            ? yield* Effect.promise(() => resolveWideEventLogDirectory())
            : options.directory;

        const consoleWriter = options.consoleWrite ?? defaultConsoleWideEventWriter;
        const fileSink =
          directory === null
            ? noopWideEventSink
            : createFileWideEventSink({
                ...options,
                directory,
                warn: ({ counters, kind, message }) =>
                  consoleWriter(
                    `[wide-event:file] ${kind} ${message} dropped=${counters.dropped} failed=${counters.failed}`,
                    'warn',
                  ),
              });

        const sinks: Array<{ name: string; sink: WideEventSinkShape }> = [{ name: 'file', sink: fileSink }];
        let consoleSink: WideEventSinkShape = noopWideEventSink;
        if (!options.silenceConsole) {
          consoleSink = makeConsoleWideEventSink({
            format: options.format ?? selectConsoleLogFormat(),
            write: consoleWriter,
            ...(options.projector === undefined ? {} : { projector: options.projector }),
          });
          sinks.push({ name: 'console', sink: consoleSink });
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (directory !== null && 'dispose' in fileSink) {
              await (fileSink as ReturnType<typeof createFileWideEventSink>).dispose();
            }
            const [fileDiagnostics, consoleDiagnostics] = await Promise.all([
              Effect.runPromise(fileSink.diagnostics()),
              Effect.runPromise(consoleSink.diagnostics()),
            ]);
            const lost =
              fileDiagnostics.dropped + fileDiagnostics.failed + consoleDiagnostics.dropped + consoleDiagnostics.failed;
            if (lost > 0) {
              try {
                consoleWriter(
                  `[wide-event] delivery summary file(dropped=${fileDiagnostics.dropped},failed=${fileDiagnostics.failed}) console(dropped=${consoleDiagnostics.dropped},failed=${consoleDiagnostics.failed})`,
                  'warn',
                );
              } catch {
                // Observability diagnostics must not fail runtime shutdown.
              }
            }
          }),
        );

        return combineWideEventSinks(...sinks);
      }),
    ),
    makeWideEventResourceLayer(options.resource),
  );

export const makeSilentWideEventSinkLayer = (
  resource: WideEventResourceInput,
): Layer.Layer<WideEventResourceService | WideEventSink> =>
  Layer.merge(makeWideEventSinkLayer(noopWideEventSink), makeWideEventResourceLayer(resource));
