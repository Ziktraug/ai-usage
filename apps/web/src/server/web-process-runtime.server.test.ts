import { describe, expect, test } from 'bun:test';
import type { WebProcessRuntime } from './web-process-runtime.server';
import {
  getWebProcessRuntime,
  installWebProcessRuntime,
  replaceWebProcessRuntime,
  tryGetWebProcessRuntime,
} from './web-process-runtime.server';

const unavailable = (): Promise<never> => Promise.reject(new Error('Unexpected runtime operation.'));

const runtimeFixture = (dispose: () => Promise<void> = async () => undefined): WebProcessRuntime => ({
  dispose,
  effects: { runEffect: unavailable },
  sourceControl: {
    detectAll: async () => undefined,
    getSnapshot: unavailable,
    requestPublication: async () => false,
    runAllEnabled: async () => 0,
    runNow: async () => false,
    setEnabled: async () => undefined,
    start: unavailable,
    subscribe: () => () => undefined,
  },
});

describe('web process runtime registry', () => {
  test('offers optional and strict lookup before the process runtime starts', () => {
    expect(tryGetWebProcessRuntime()).toBeUndefined();
    expect(() => getWebProcessRuntime()).toThrow('The source-control runtime has not started.');
  });

  test('rejects a second direct install', () => {
    const runtime = runtimeFixture();
    const uninstall = installWebProcessRuntime(runtime);
    try {
      expect(getWebProcessRuntime()).toBe(runtime);
      expect(() => installWebProcessRuntime(runtimeFixture())).toThrow(
        'A source-control runtime is already installed in this process.',
      );
    } finally {
      uninstall();
    }
    expect(tryGetWebProcessRuntime()).toBeUndefined();
  });

  test('waits for the complete registered teardown before exposing a successor', async () => {
    let markTeardownStarted!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      markTeardownStarted = resolve;
    });
    let releaseTeardown!: () => void;
    const teardownReleased = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const first = runtimeFixture();
    const second = runtimeFixture();
    const uninstallFirst = await replaceWebProcessRuntime(first, async () => {
      markTeardownStarted();
      await teardownReleased;
    });
    const replacement = replaceWebProcessRuntime(second);
    let uninstallSecond: (() => void) | undefined;
    try {
      await teardownStarted;
      expect(tryGetWebProcessRuntime()).toBeUndefined();
      releaseTeardown();
      uninstallSecond = await replacement;
      expect(getWebProcessRuntime()).toBe(second);
    } finally {
      releaseTeardown();
      uninstallSecond ??= await replacement;
      uninstallSecond();
      uninstallFirst();
    }
  });

  test('serializes concurrent replacements through every runtime teardown', async () => {
    const teardowns: string[] = [];
    const first = runtimeFixture(() => {
      teardowns.push('first');
      return Promise.resolve();
    });
    const second = runtimeFixture(() => {
      teardowns.push('second');
      return Promise.resolve();
    });
    const third = runtimeFixture();
    const uninstallFirst = installWebProcessRuntime(first);
    const secondReplacement = replaceWebProcessRuntime(second);
    const thirdReplacement = replaceWebProcessRuntime(third);
    const [uninstallSecond, uninstallThird] = await Promise.all([secondReplacement, thirdReplacement]);
    try {
      expect(teardowns).toEqual(['first', 'second']);
      expect(getWebProcessRuntime()).toBe(third);
      uninstallSecond();
      expect(getWebProcessRuntime()).toBe(third);
    } finally {
      uninstallThird();
      uninstallSecond();
      uninstallFirst();
    }
  });

  test('does not let a stale uninstall callback remove a newer runtime', async () => {
    const first = runtimeFixture();
    const second = runtimeFixture();
    const uninstallFirst = installWebProcessRuntime(first);
    const uninstallSecond = await replaceWebProcessRuntime(second);
    try {
      uninstallFirst();
      expect(getWebProcessRuntime()).toBe(second);
    } finally {
      uninstallSecond();
      uninstallFirst();
    }
  });
});
