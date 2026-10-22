import { WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { queryOptions } from '@tanstack/svelte-query';
import type { WorkAttentionClient } from '../../rpc/work-attention-client';
import { unwrapWorkAttentionResult, type WorkAttentionIdentity, workAttentionKey } from '../identities/work-attention';
import { webQueryPolicies } from '../policies';

export { WorkAttentionQueryError, workAttentionKey } from '../identities/work-attention';

export interface WorkAttentionQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

/** One bounded page of ranked roots; the dataset says itself when the ranking is a selection. */
export const WORK_ATTENTION_LIMIT = 100;

export const workAttentionRequest = (machineId: string | null = null): WorkAttentionIdentity => ({
  limit: WORK_ATTENTION_LIMIT,
  machineId,
});

/**
 * The one query for the Work attention identity. Its only producer is the collection cycle and it
 * carries no proof with a lifetime, so it follows the collection-facts policy: revalidated on an
 * interval and on focus, and on mount only when stale. The server-rendered answer is the page
 * load's one read; a reader returning after the stale time gets a new one.
 */
export const workAttentionQueryOptions = (
  client: WorkAttentionClient,
  identity: WorkAttentionIdentity,
  context: WorkAttentionQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.collectionFactsSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) =>
      unwrapWorkAttentionResult(
        await client.attention(
          {
            limit: identity.limit,
            machineId: identity.machineId,
            ...(identity.scope === undefined ? {} : { scope: identity.scope }),
            ...(identity.sinceDays === undefined ? {} : { sinceDays: identity.sinceDays }),
          },
          { signal },
        ),
      ),
    queryKey: workAttentionKey(identity),
  });

const daysPattern = /^\d+$/;

export type WorkContextSearchRead =
  | { readonly ok: true; readonly input: WorkAttentionIdentity }
  | { readonly ok: false; readonly error: { readonly tag: 'InvalidProjectContext'; readonly message: string } };

/** Invalid context never falls back to a global read. Empty scope is an intentional all-project read. */
export const workAttentionRequestFromSearch = (params: URLSearchParams): WorkContextSearchRead => {
  const project = params.get('context-project')?.trim() ?? '';
  const days = params.get('context-days') ?? '30';
  const sinceDays = Number(days);
  if (
    project &&
    (project.includes('/') ||
      project.includes('\\') ||
      project === '.' ||
      project === '..' ||
      project.length > WORK_ATTENTION_BOUNDS.maxPath)
  ) {
    return {
      ok: false,
      error: { tag: 'InvalidProjectContext', message: 'Enter an exact project label, not a checkout path.' },
    };
  }
  if (!(daysPattern.test(days) && Number.isSafeInteger(sinceDays)) || sinceDays < 1 || sinceDays > 3650) {
    return {
      ok: false,
      error: { tag: 'InvalidProjectContext', message: 'Choose a history window from 1 to 3650 days.' },
    };
  }
  return {
    ok: true,
    input: {
      ...workAttentionRequest(),
      ...(project ? { scope: { kind: 'project-label' as const, projectLabel: project } } : {}),
      ...(sinceDays === 30 ? {} : { sinceDays }),
    },
  };
};
