import { expect, test } from 'bun:test';
import { type WebContract, webContract } from '@ai-usage/web-contract';
import type { Router } from '@orpc/server';
import type { WebRpcRouterDependencies } from './router';
import { createWebRpcRouter } from './router';

const routerWithoutServices = () =>
  createWebRpcRouter({
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

test('composes every router leaf under one root router', () => {
  expect(Object.keys(routerWithoutServices()).sort()).toEqual(Object.keys(webContract).sort());
});

test('refuses at compile time a router that leaves a declared procedure unimplemented', () => {
  const router = routerWithoutServices();
  const { cancel: _unimplemented, ...delegationWithoutCancel } = router.delegation;
  // @ts-expect-error -- the contract declares delegation.cancel, so a router without it is not a Web router.
  const incomplete: Router<WebContract, Record<never, never>> = { ...router, delegation: delegationWithoutCancel };

  expect(Object.keys(incomplete.delegation)).not.toContain('cancel');
});
