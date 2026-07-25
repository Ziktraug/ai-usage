import { describe, expect, test } from 'bun:test';
import { makeAiUsageWideEventResource } from './resource';

describe('wide-event process resource', () => {
  test('centralizes service identity and runtime classification', () => {
    expect(
      makeAiUsageWideEventResource({
        instanceId: 'cli-instance',
        nodeEnvironment: undefined,
        surface: 'cli',
      }),
    ).toEqual({
      instanceId: 'cli-instance',
      runtimeMode: 'development',
      serviceName: 'ai-usage',
      serviceVersion: '0.1.0',
      surface: 'cli',
    });
    expect(
      makeAiUsageWideEventResource({
        instanceId: 'web-instance',
        nodeEnvironment: undefined,
        surface: 'web',
        testRuntime: true,
      }).runtimeMode,
    ).toBe('test');
    expect(
      makeAiUsageWideEventResource({
        instanceId: 'production-instance',
        nodeEnvironment: 'production',
        surface: 'web',
        testRuntime: true,
      }).runtimeMode,
    ).toBe('production');
  });
});
