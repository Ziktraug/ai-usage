import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import { getContext, setContext } from 'svelte';
import type { SourceControlClientState } from '../../../source-control-client';

export interface SourceControlContextValue {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly state: () => SourceControlClientState;
}

const sourceControlContextKey = Symbol('source-control');

export const provideSourceControl = (value: SourceControlContextValue): SourceControlContextValue => {
  setContext(sourceControlContextKey, value);
  return value;
};

export const useSourceControl = (): SourceControlContextValue => {
  const context = getContext<SourceControlContextValue | undefined>(sourceControlContextKey);
  if (!context) {
    throw new Error('Source control context is unavailable.');
  }
  return context;
};
