import type { WebContractClient } from '@ai-usage/web-contract';
import { createRouterClient, ORPCError } from '@orpc/server';
import type { RuntimeMode } from '../../../runtime-mode';
import { getServerRuntimeMode } from '../../../server/runtime-mode.server';
import { type E2ESkillsFixtureVariant, e2eSkillsFixtureVariantForHeaders } from './e2e-fixture-profile';
import { rpcPolicyForPath } from './request-policy-handler';
import { createWebRpcRouter, type WebRpcRouterDependencies } from './router';

export interface InProcessWebRpcClientOptions {
  /** The router's services; by default the ones `/rpc` builds for the same document request. */
  readonly createDependencies?: (request: Request) => Promise<WebRpcRouterDependencies>;
  /** By default the server's runtime mode, as `/rpc` enforces it. */
  readonly runtimeMode?: RuntimeMode;
}

/**
 * SSR used to reach `/rpc` through `event.fetch`, and the visual Skills fixture followed the document
 * only when the private e2e overrides were enabled; the in-process client keeps that rule.
 */
export const ssrSkillsFixtureVariant = (
  documentRequest: Request,
  privateE2eOverrides: boolean = process.env.AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES === '1',
): E2ESkillsFixtureVariant =>
  privateE2eOverrides ? e2eSkillsFixtureVariantForHeaders(documentRequest.headers) : 'extended';

// Loaded on first use, as `/rpc` loads it, so a route module does not pull the service graph in.
const defaultDependencies = async (request: Request): Promise<WebRpcRouterDependencies> => {
  const { createWebRpcRouterDependencies } = await import('./context.server');
  return await createWebRpcRouterDependencies(request, { skillsFixtureVariant: ssrSkillsFixtureVariant(request) });
};

/**
 * The typed RPC client server loads acquire through (ADR 0076): the router `/rpc` serves, called in
 * process with the services `/rpc` builds for the document request, so a load runs the same procedures
 * with the same input and output validation and the same typed errors as the browser.
 *
 * The per-operation rule that is not an HTTP rule applies as on `/rpc`: in a demo, a procedure not
 * declared synthetic-only answers `NOT_FOUND`, which is what the browser's client reads from the
 * boundary's empty 404. The HTTP rules do not apply because no HTTP request is made: method, Origin,
 * CSRF and byte bounds guard a request body and a response stream this client never produces, and the
 * document request has already passed the trusted-local hook.
 *
 * A document load only reads: a mutation would change state on a GET that CSRF never guards, so this
 * client refuses every procedure declared as a mutation before any service runs.
 */
export const createInProcessWebRpcClient = async (
  request: Request,
  options: InProcessWebRpcClientOptions = {},
): Promise<WebContractClient> => {
  const runtimeMode = options.runtimeMode ?? getServerRuntimeMode();
  const dependencies = await (options.createDependencies ?? defaultDependencies)(request);
  return createRouterClient(createWebRpcRouter(dependencies), {
    interceptors: [
      async ({ next, path }) => {
        const policy = rpcPolicyForPath(`/${path.join('/')}`);
        if (policy === undefined || (runtimeMode === 'demo' && policy.demo !== 'synthetic-only')) {
          throw new ORPCError('NOT_FOUND', { message: 'The RPC operation does not exist.', status: 404 });
        }
        if (policy.transport === 'mutation') {
          throw new ORPCError('METHOD_NOT_SUPPORTED', {
            message: 'A document load cannot run a mutation.',
            status: 405,
          });
        }
        return await next();
      },
    ],
  });
};
