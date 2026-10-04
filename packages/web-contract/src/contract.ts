import type { ContractRouterClient } from '@orpc/contract';
import { memoryContract } from './memory';
import { projectsContract } from './projects';
import { replicationContract } from './replication';
import { reportContract } from './report';
import { sessionContract } from './session';
import { sessionDistillationContract } from './session-distillation';
import { skillsContract } from './skills';
import { syncContract } from './sync';

export const webContract = {
  ...reportContract,
  memory: memoryContract,
  projects: projectsContract,
  replication: replicationContract,
  session: sessionContract,
  sessionDistillation: sessionDistillationContract,
  skills: skillsContract,
  sync: syncContract,
} as const;

export type WebContract = typeof webContract;
export type WebContractClient = ContractRouterClient<WebContract>;
