import { describe, expect, test } from 'bun:test';
import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import { MutationObserver, QueryObserver } from '@tanstack/svelte-query';
import type { SourceControlClientState } from '../../../source-control-client';
import { createWebQueryClient } from '../client';
import { currentReportAliasKeys } from '../publication';
import {
  sourceControlCommandMutationOptions,
  sourceControlStateKey,
  sourceControlStateQueryOptions,
  updateSourceControlState,
} from './source-control';

const initialState: SourceControlClientState = {
  commandError: null,
  connection: 'stopped',
  pendingCommand: null,
  publication: null,
  snapshot: null,
};

describe('Source control Query ownership', () => {
  test('stores EventSource publications under one bounded control-plane key', () => {
    const queryClient = createWebQueryClient();
    const observer = new QueryObserver(queryClient, sourceControlStateQueryOptions(initialState));
    const observed: SourceControlClientState[] = [];
    const unsubscribe = observer.subscribe(({ data }) => {
      if (data) {
        observed.push(data);
      }
    });
    const live = { ...initialState, connection: 'live' as const };

    updateSourceControlState(queryClient, live);

    expect(sourceControlStateKey()).toEqual(['web', 'control-plane', 'sources', 'snapshot']);
    expect(queryClient.getQueryData<SourceControlClientState>(sourceControlStateKey())).toEqual(live);
    expect(observed.at(-1)).toEqual(live);
    expect(currentReportAliasKeys()).not.toContainEqual(sourceControlStateKey());
    unsubscribe();
  });

  test('exposes command pending and errors through a Query mutation', async () => {
    const queryClient = createWebQueryClient();
    const request = Promise.withResolvers<boolean>();
    let rejection: string | null = null;
    const commands: SourceControlCommand[] = [];
    const observer = new MutationObserver(
      queryClient,
      sourceControlCommandMutationOptions({
        execute: async (command) => {
          commands.push(command);
          return await request.promise;
        },
        rejectedError: () => rejection,
      }),
    );
    const pending: boolean[] = [];
    const unsubscribe = observer.subscribe((result) => pending.push(result.isPending));
    const mutation = observer.mutate({ command: 'run-all' });

    await Promise.resolve();
    expect(pending).toContain(true);
    request.resolve(true);
    await expect(mutation).resolves.toBe(true);
    expect(commands).toEqual([{ command: 'run-all' }]);

    rejection = 'Command failed.';
    const rejectedObserver = new MutationObserver(
      queryClient,
      sourceControlCommandMutationOptions({
        execute: () => Promise.resolve(false),
        rejectedError: () => rejection,
      }),
    );
    await expect(rejectedObserver.mutate({ command: 'detect-all' })).rejects.toThrow('Command failed.');
    expect(rejectedObserver.getCurrentResult().error).toBeInstanceOf(Error);
    unsubscribe();
  });
});
