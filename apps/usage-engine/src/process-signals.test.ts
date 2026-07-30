import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { interruptedExitCode } from './process';
import { createUsageEngineTermination } from './process-signals';

describe('usage engine process signals', () => {
  test('resolves the first and forced termination signals and removes both listeners idempotently', async () => {
    const emitter = new EventEmitter();
    const forcedExitCodes: number[] = [];
    const termination = createUsageEngineTermination(emitter, (signal) => {
      forcedExitCodes.push(interruptedExitCode(signal));
    });

    emitter.emit('SIGTERM');
    expect(forcedExitCodes).toEqual([]);
    emitter.emit('SIGINT');
    emitter.emit('SIGTERM');

    await expect(termination.promise).resolves.toBe('SIGTERM');
    await expect(termination.forced).resolves.toBe('SIGINT');
    expect(forcedExitCodes).toEqual([130]);
    termination.dispose();
    termination.dispose();
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });
});
