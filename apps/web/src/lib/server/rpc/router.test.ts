import { expect, test } from 'bun:test';
import type { WebRpcRouterDependencies } from './router';
import { createWebRpcRouter } from './router';

test('composes every router leaf under one root router', () => {
  const router = createWebRpcRouter({
    memory: {},
    projects: {},
    report: {},
    replication: {},
    session: {},
    skills: {},
    sync: {},
  } as unknown as WebRpcRouterDependencies);

  expect(Object.keys(router).sort()).toEqual([
    'campaign',
    'memory',
    'projectGroup',
    'projects',
    'quota',
    'replication',
    'report',
    'runtime',
    'session',
    'skills',
    'sync',
  ]);
});
