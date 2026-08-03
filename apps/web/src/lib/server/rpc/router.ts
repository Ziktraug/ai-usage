import type { ReportRpcServices } from './report';
import { createReportRpcRouter } from './report';
import type { SessionRpcDependencies } from './session';
import { createSessionRpcRouter } from './session';
import type { SelectSkillsCapability, SkillsRequestPreflight } from './skills';
import { createSkillsRouter } from './skills';
import type { SyncRpcDependencies } from './sync';
import { createSyncRpcRouter } from './sync';

export interface WebRpcRouterDependencies {
  readonly report: ReportRpcServices;
  readonly session: SessionRpcDependencies;
  readonly skills: {
    readonly preflight: SkillsRequestPreflight;
    readonly selectCapability: SelectSkillsCapability;
  };
  readonly sync: SyncRpcDependencies;
}

export const createWebRpcRouter = (dependencies: WebRpcRouterDependencies) => ({
  ...createReportRpcRouter(dependencies.report),
  session: createSessionRpcRouter(dependencies.session),
  skills: createSkillsRouter(dependencies.skills.selectCapability, dependencies.skills.preflight),
  sync: createSyncRpcRouter(dependencies.sync),
});

export type WebRpcRouter = ReturnType<typeof createWebRpcRouter>;
