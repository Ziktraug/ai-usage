import type { MemoryRpcDependencies } from './memory';
import { createMemoryRpcRouter } from './memory';
import type { ProjectsRpcDependencies } from './projects';
import { createProjectsRpcRouter } from './projects';
import type { ReplicationRpcDependencies } from './replication';
import { createReplicationRpcRouter } from './replication';
import type { ReportRpcServices } from './report';
import { createReportRpcRouter } from './report';
import type { SessionRpcDependencies } from './session';
import { createSessionRpcRouter } from './session';
import type { SelectSkillsCapability, SkillsRequestPreflight } from './skills';
import { createSkillsRouter } from './skills';
import type { SyncRpcDependencies } from './sync';
import { createSyncRpcRouter } from './sync';

export interface WebRpcRouterDependencies {
  readonly memory: MemoryRpcDependencies;
  readonly projects: ProjectsRpcDependencies;
  readonly replication: ReplicationRpcDependencies;
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
  memory: createMemoryRpcRouter(dependencies.memory),
  projects: createProjectsRpcRouter(dependencies.projects),
  replication: createReplicationRpcRouter(dependencies.replication),
  session: createSessionRpcRouter(dependencies.session),
  skills: createSkillsRouter(dependencies.skills.selectCapability, dependencies.skills.preflight),
  sync: createSyncRpcRouter(dependencies.sync),
});

export type WebRpcRouter = ReturnType<typeof createWebRpcRouter>;
