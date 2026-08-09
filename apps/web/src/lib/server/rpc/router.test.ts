import { expect, test } from 'bun:test';
import type { WebRpcRouterDependencies } from './router';
import { createWebRpcRouter } from './router';

test('composes every V1-V4 router leaf under one root router', () => {
  const router = createWebRpcRouter({
    report: {},
    session: {},
    skills: {},
    sync: {},
  } as unknown as WebRpcRouterDependencies);

  expect(Object.keys(router).sort()).toEqual([
    'campaign',
    'projectGroup',
    'quota',
    'report',
    'runtime',
    'session',
    'skills',
    'sync',
  ]);
});
