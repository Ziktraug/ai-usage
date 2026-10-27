import type { ContractRouterClient } from '@orpc/contract';
import { delegationContract } from './delegation';
import { reportContract } from './report';
import type { RpcContractRouter } from './rpc-procedure';
import { sessionContract } from './session';
import { skillsContract } from './skills';
import { syncContract } from './sync';
import { workContract } from './work';
import { workAttemptsContract } from './work-attempts';
import { workRoutingContract } from './work-routing';
import { workThreadsContract } from './work-threads';

/**
 * Every Web RPC procedure, each declared once with `rpcProcedure`. The shape check rejects a leaf built
 * without that declaration, so the request policy, its path table and the browser's GET table, all
 * derived from this object, can never miss a procedure.
 */
export const webContract = {
  ...reportContract,
  delegation: delegationContract,
  session: sessionContract,
  skills: skillsContract,
  sync: syncContract,
  work: workContract,
  workAttempts: workAttemptsContract,
  workRouting: workRoutingContract,
  workThreads: workThreadsContract,
} as const satisfies RpcContractRouter;

export type WebContract = typeof webContract;
export type WebContractClient = ContractRouterClient<WebContract>;
