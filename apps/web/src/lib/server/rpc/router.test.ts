import { expect, test } from 'bun:test';
import type { WebRpcRouterDependencies } from './router';
import { createWebRpcRouter } from './router';

test('composes every router leaf under one root router', () => {
  const router = createWebRpcRouter({
    delegation: {},
    memory: {},
    projects: {},
    report: {},
    replication: {},
    session: {},
    skills: {},
    sync: {},
    work: {},
    workAttempts: {},
    workRouting: {},
  } as unknown as WebRpcRouterDependencies);

  expect(Object.keys(router).sort()).toEqual([
    'campaign',
    'delegation',
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
    'work',
    'workAttempts',
    'workRouting',
  ]);
});
