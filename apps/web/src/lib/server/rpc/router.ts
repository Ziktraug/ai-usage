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
import type { WorkRpcDependencies } from './work';
import { createWorkRpcRouter } from './work';
import type { WorkAttemptsRpcDependencies } from './work-attempts';
import { createWorkAttemptsRpcRouter } from './work-attempts';
import type { WorkRoutingRpcDependencies } from './work-routing';
import { createWorkRoutingRpcRouter } from './work-routing';

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
  readonly work: WorkRpcDependencies;
  readonly workAttempts: WorkAttemptsRpcDependencies;
  readonly workRouting: WorkRoutingRpcDependencies;
}

export const createWebRpcRouter = (dependencies: WebRpcRouterDependencies) => ({
  ...createReportRpcRouter(dependencies.report),
  memory: createMemoryRpcRouter(dependencies.memory),
  projects: createProjectsRpcRouter(dependencies.projects),
  replication: createReplicationRpcRouter(dependencies.replication),
  session: createSessionRpcRouter(dependencies.session),
  skills: createSkillsRouter(dependencies.skills.selectCapability, dependencies.skills.preflight),
  sync: createSyncRpcRouter(dependencies.sync),
  work: createWorkRpcRouter(dependencies.work),
  workAttempts: createWorkAttemptsRpcRouter(dependencies.workAttempts),
  workRouting: createWorkRoutingRpcRouter(dependencies.workRouting),
});

export type WebRpcRouter = ReturnType<typeof createWebRpcRouter>;
