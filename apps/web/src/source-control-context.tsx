import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import { createContext, createSignal, type JSX, onCleanup, onMount, useContext } from 'solid-js';
import {
  createSourceControlClient,
  type SourceControlClient,
  type SourceControlClientState,
} from './source-control-client';

interface SourceControlContextValue {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly state: () => SourceControlClientState;
}

const SourceControlContext = createContext<SourceControlContextValue>();

export const SourceControlProvider = (props: { children: JSX.Element; client?: SourceControlClient }) => {
  const client = props.client ?? createSourceControlClient();
  const [state, setState] = createSignal(client.getState());
  const unsubscribe = client.subscribe(setState);

  onMount(client.start);
  onCleanup(() => {
    unsubscribe();
    client.stop();
  });

  return (
    <SourceControlContext.Provider value={{ execute: client.execute, state }}>
      {props.children}
    </SourceControlContext.Provider>
  );
};

export const useSourceControl = (): SourceControlContextValue => {
  const context = useContext(SourceControlContext);
  if (!context) {
    throw new Error('Source control context is unavailable.');
  }
  return context;
};
