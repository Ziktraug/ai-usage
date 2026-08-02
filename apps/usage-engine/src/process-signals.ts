import type { UsageEngineTerminationSignal } from './process';

interface SignalEmitter {
  readonly on: (event: UsageEngineTerminationSignal, listener: () => void) => unknown;
  readonly removeListener: (event: UsageEngineTerminationSignal, listener: () => void) => unknown;
}

export interface UsageEngineTermination {
  readonly dispose: () => void;
  readonly forced: Promise<UsageEngineTerminationSignal>;
  readonly promise: Promise<UsageEngineTerminationSignal>;
}

export const createUsageEngineTermination = (
  emitter: SignalEmitter = process,
  forceExit?: (signal: UsageEngineTerminationSignal) => void,
): UsageEngineTermination => {
  let firstSettled = false;
  let forcedSettled = false;
  let resolveSignal: ((signal: UsageEngineTerminationSignal) => void) | undefined;
  let resolveForcedSignal: ((signal: UsageEngineTerminationSignal) => void) | undefined;
  const promise = new Promise<UsageEngineTerminationSignal>((resolve) => {
    resolveSignal = resolve;
  });
  const forced = new Promise<UsageEngineTerminationSignal>((resolve) => {
    resolveForcedSignal = resolve;
  });
  const receiveSignal = (signal: UsageEngineTerminationSignal): void => {
    if (!firstSettled) {
      firstSettled = true;
      resolveSignal?.(signal);
      return;
    }
    if (!forcedSettled) {
      forcedSettled = true;
      resolveForcedSignal?.(signal);
      forceExit?.(signal);
    }
  };
  const onInterrupt = (): void => receiveSignal('SIGINT');
  const onTerminate = (): void => receiveSignal('SIGTERM');
  emitter.on('SIGINT', onInterrupt);
  emitter.on('SIGTERM', onTerminate);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      emitter.removeListener('SIGINT', onInterrupt);
      emitter.removeListener('SIGTERM', onTerminate);
    },
    forced,
    promise,
  };
};
