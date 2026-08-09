import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import { type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type { SourceControlClientState } from '../../../source-control-client';
import { controlPlaneKey } from '../keys';
import { webQueryPolicies } from '../policies';

const sourceControlFamily = 'sources';

export const sourceControlStateKey = () => controlPlaneKey(sourceControlFamily, 'snapshot');

const unavailableStateRead = (): Promise<never> =>
  Promise.reject(new Error('Source control state is supplied by the EventSource bridge.'));

export const sourceControlStateQueryOptions = (initialData: SourceControlClientState) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: false,
    initialData,
    queryFn: unavailableStateRead,
    queryKey: sourceControlStateKey(),
  });

export const updateSourceControlState = (
  queryClient: QueryClient,
  state: SourceControlClientState,
): SourceControlClientState | undefined =>
  queryClient.setQueryData<SourceControlClientState>(sourceControlStateKey(), state);

export interface SourceControlCommandMutationDependencies {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly rejectedError: () => string | null;
}

export const sourceControlCommandMutationOptions = ({
  execute,
  rejectedError,
}: SourceControlCommandMutationDependencies) => ({
  mutationFn: async (command: SourceControlCommand): Promise<boolean> => {
    const accepted = await execute(command);
    const message = accepted ? null : rejectedError();
    if (message) {
      throw new Error(message);
    }
    return accepted;
  },
  mutationKey: ['web', 'control-plane', sourceControlFamily, 'command'] as const,
  retry: false as const,
});
