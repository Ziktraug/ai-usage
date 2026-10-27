import { expect, test } from 'bun:test';
import type { WebRpcRouterDependencies } from './router';
import { createWebRpcRouter } from './router';

test('composes every router leaf under one root router', () => {
  const router = createWebRpcRouter({
    delegation: {},
    report: {},
    session: {},
    skills: {},
    sync: {},
    work: {},
    workAttempts: {},
    workRouting: {},
    workThreads: {},
  } as unknown as WebRpcRouterDependencies);

  expect(Object.keys(router).sort()).toEqual([
    'campaign',
    'delegation',
    'projectGroup',
    'quota',
    'report',
    'runtime',
    'session',
    'skills',
    'sync',
    'work',
    'workAttempts',
    'workRouting',
    'workThreads',
  ]);
});
