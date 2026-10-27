import type { WebContract } from '@ai-usage/web-contract';
import type { Router } from '@orpc/server';
import type { DelegationRpcDependencies } from './delegation';
import { createDelegationRpcRouter } from './delegation';
import type { ReportRpcServices } from './report';
import { createReportRpcRouter } from './report';
import type { SessionRpcDependencies } from './session';
import { createSessionRpcRouter } from './session';
import type { SelectSkillsCapability, SkillsRequestPreflight } from './skills';
import { createSkillsRouter } from './skills';
import type { SyncRpcDependencies } from './sync';
import { createSyncRpcRouter } from './sync';
import type { WorkRpcDependencies } from './work';
import { createWorkRpcRouter } from './work';
import type { WorkAttemptsRpcDependencies } from './work-attempts';
import { createWorkAttemptsRpcRouter } from './work-attempts';
import type { WorkRoutingRpcDependencies } from './work-routing';
import { createWorkRoutingRpcRouter } from './work-routing';
import { createWorkThreadsRpcRouter, type WorkThreadsRpcDependencies } from './work-threads';

export interface WebRpcRouterDependencies {
  readonly delegation: DelegationRpcDependencies;
  readonly report: ReportRpcServices;
  readonly session: SessionRpcDependencies;
  readonly skills: {
    readonly preflight: SkillsRequestPreflight;
    readonly selectCapability: SelectSkillsCapability;
  };
  readonly sync: SyncRpcDependencies;
  readonly work: WorkRpcDependencies;
  readonly workAttempts: WorkAttemptsRpcDependencies;
  readonly workRouting: WorkRoutingRpcDependencies;
  readonly workThreads: WorkThreadsRpcDependencies;
}

/** Implements every contract procedure: a declared procedure without an implementation does not type-check. */
export const createWebRpcRouter = (dependencies: WebRpcRouterDependencies) =>
  ({
    ...createReportRpcRouter(dependencies.report),
    delegation: createDelegationRpcRouter(dependencies.delegation),
    session: createSessionRpcRouter(dependencies.session),
    skills: createSkillsRouter(dependencies.skills.selectCapability, dependencies.skills.preflight),
    sync: createSyncRpcRouter(dependencies.sync),
    work: createWorkRpcRouter(dependencies.work),
    workAttempts: createWorkAttemptsRpcRouter(dependencies.workAttempts),
    workRouting: createWorkRoutingRpcRouter(dependencies.workRouting),
    workThreads: createWorkThreadsRpcRouter(dependencies.workThreads),
  }) satisfies Router<WebContract, Record<never, never>>;

export type WebRpcRouter = ReturnType<typeof createWebRpcRouter>;
