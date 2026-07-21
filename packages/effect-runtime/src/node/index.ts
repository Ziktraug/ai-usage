import { Effect, Layer } from 'effect';
import {
  combineWideEventSinks,
  makeWideEventSinkLayer,
  noopWideEventSink,
  WideEventSink,
  type WideEventSinkShape,
} from '../sink';
import { type ConsoleLogFormat, makeConsoleWideEventSink, selectConsoleLogFormat } from './console-sink';
import { createFileWideEventSink, type FileWideEventSinkOptions, makeFileWideEventSinkLayer } from './file-sink';
import { resolveWideEventLogDirectory } from './resolve-log-dir';

export type { ConsoleLogFormat } from './console-sink';
export {
  makeConsoleWideEventSink,
  renderPrettyWideEvent,
  selectConsoleLogFormat,
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
  } = {},
): Layer.Layer<WideEventSink> => makeFileWideEventSinkLayer(options);

export const makeWebWideEventSinkLayer = (
  options: Omit<FileWideEventSinkOptions, 'directory'> & {
    readonly directory?: string | null;
    readonly format?: ConsoleLogFormat;
    readonly consoleWrite?: (line: string) => void;
    readonly silenceConsole?: boolean;
  } = {},
): Layer.Layer<WideEventSink> =>
  Layer.scoped(
    WideEventSink,
    Effect.gen(function* () {
      const directory =
        options.directory === undefined
          ? yield* Effect.promise(() => resolveWideEventLogDirectory())
          : options.directory;

      const fileSink = directory === null ? noopWideEventSink : createFileWideEventSink({ ...options, directory });

      if (directory !== null && 'dispose' in fileSink) {
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => (fileSink as ReturnType<typeof createFileWideEventSink>).dispose()),
        );
      }

      const sinks: WideEventSinkShape[] = [fileSink];
      if (!options.silenceConsole) {
        sinks.push(
          makeConsoleWideEventSink({
            format: options.format ?? selectConsoleLogFormat(),
            ...(options.consoleWrite === undefined ? {} : { write: options.consoleWrite }),
          }),
        );
      }

      const [only] = sinks;
      return sinks.length === 1 && only !== undefined ? only : combineWideEventSinks(...sinks);
    }),
  );

export const makeSilentWideEventSinkLayer = (): Layer.Layer<WideEventSink> => makeWideEventSinkLayer(noopWideEventSink);
