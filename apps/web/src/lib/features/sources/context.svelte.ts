import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import { createContext } from 'svelte';
import type { SourceControlClientState } from '../../../source-control-client';

export interface SourceControlContextValue {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly state: () => SourceControlClientState;
}

export const [useSourceControl, provideSourceControl] = createContext<SourceControlContextValue>();
