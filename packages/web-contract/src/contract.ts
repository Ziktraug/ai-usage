import type { ContractRouterClient } from '@orpc/contract';
import { reportContract } from './report';
import { sessionContract } from './session';
import { skillsContract } from './skills';
import { syncContract } from './sync';

export const webContract = {
  ...reportContract,
  session: sessionContract,
  skills: skillsContract,
  sync: syncContract,
} as const;

export type WebContract = typeof webContract;
export type WebContractClient = ContractRouterClient<WebContract>;
