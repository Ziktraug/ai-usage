import type { ContractRouterClient } from '@orpc/contract';
import { delegationContract } from './delegation';
import { memoryContract } from './memory';
import { projectsContract } from './projects';
import { replicationContract } from './replication';
import { reportContract } from './report';
import { sessionContract } from './session';
import { skillsContract } from './skills';
import { syncContract } from './sync';
import { workContract } from './work';
import { workAttemptsContract } from './work-attempts';
import { workRoutingContract } from './work-routing';
import { workThreadsContract } from './work-threads';

export const webContract = {
  ...reportContract,
  delegation: delegationContract,
  memory: memoryContract,
  projects: projectsContract,
  replication: replicationContract,
  session: sessionContract,
  skills: skillsContract,
  sync: syncContract,
  work: workContract,
  workAttempts: workAttemptsContract,
  workRouting: workRoutingContract,
  workThreads: workThreadsContract,
} as const;

export type WebContract = typeof webContract;
export type WebContractClient = ContractRouterClient<WebContract>;
