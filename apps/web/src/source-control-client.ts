import {
  chooseNewestSourceControlSnapshot,
  parseReportPublishedEvent,
  parseSourceControlCommandResponse,
  parseSourceControlSnapshot,
  type ReportPublishedEvent,
  type SourceControlCommand,
  type SourceControlCommandResponse,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import type { StateSubscription } from './lib/foundation/subscription';
import { createControlBrowserAdapter } from './lib/rpc/control-client';
import type { RuntimeMode } from './runtime-mode';

export type { SourceControlCommandResponse } from '@ai-usage/report-core/source-control';

export type SourceControlConnectionState = 'connecting' | 'disconnected' | 'live' | 'protocol-mismatch' | 'stopped';

export interface SourceControlClientState {
  readonly commandError: string | null;
  readonly connection: SourceControlConnectionState;
  readonly pendingCommand: SourceControlCommand | null;
  readonly publication: ReportPublishedEvent | null;
  readonly snapshot: SourceControlView | null;
}

interface EventSourceMessage {
  readonly data: string;
}

export interface SourceControlEventSource {
  addEventListener(
    type: 'control-state' | 'report-published' | 'snapshot',
    listener: (event: EventSourceMessage) => void,
  ): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
}

export interface SourceControlClientOptions {
  readonly createEventSource?: () => SourceControlEventSource;
  readonly sendCommand?: (command: SourceControlCommand, signal?: AbortSignal) => Promise<SourceControlCommandResponse>;
}

export interface SourceControlClient extends StateSubscription<SourceControlClientState> {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly start: () => void;
  readonly stop: () => void;
}

const initialState: SourceControlClientState = {
  commandError: null,
  connection: 'stopped',
  pendingCommand: null,
  publication: null,
  snapshot: null,
};

const controlBrowserAdapter = createControlBrowserAdapter();

const defaultEventSource = (): SourceControlEventSource =>
  controlBrowserAdapter.openEvents() as SourceControlEventSource;

const defaultSendCommand = (
  command: SourceControlCommand,
  signal?: AbortSignal,
): Promise<SourceControlCommandResponse> => controlBrowserAdapter.sendCommand(command, signal);

const parseControlState = (value: unknown): Exclude<SourceControlConnectionState, 'connecting' | 'stopped'> => {
  if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) {
    throw new Error('Source control connection state is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'state')) {
    throw new Error('Source control connection state is invalid.');
  }
  if (record.state !== 'disconnected' && record.state !== 'live' && record.state !== 'protocol-mismatch') {
    throw new Error('Source control connection state is invalid.');
  }
  return record.state;
};

export const createSourceControlClient = (options: SourceControlClientOptions = {}): SourceControlClient => {
  const listeners = new Set<(state: SourceControlClientState) => void>();
  const createEventSource = options.createEventSource ?? defaultEventSource;
  const sendCommand = options.sendCommand ?? defaultSendCommand;
  let eventSource: SourceControlEventSource | null = null;
  let state = initialState;
  let pendingCommandController: AbortController | null = null;

  const update = (patch: Partial<SourceControlClientState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  };

  const acceptSnapshot = (snapshot: SourceControlView): void => {
    const newest = chooseNewestSourceControlSnapshot(state.snapshot, snapshot);
    const revision = newest.publication.revision;
    const publishedAt = newest.publication.lastPublishedAt;
    const recoveredPublication =
      revision && publishedAt
        ? {
            instanceId: newest.instanceId,
            publishedAt,
            revision,
            sourceControlGeneration: newest.generation,
          }
        : null;
    update({
      commandError: null,
      connection: 'live',
      ...(recoveredPublication && recoveredPublication.revision !== state.publication?.revision
        ? { publication: recoveredPublication }
        : {}),
      snapshot: newest,
    });
  };

  const acceptPublication = (publication: ReportPublishedEvent): void => {
    if (
      state.publication?.instanceId === publication.instanceId &&
      state.publication.revision === publication.revision
    ) {
      return;
    }
    update({ commandError: null, connection: 'live', publication });
  };

  const start = (): void => {
    if (eventSource) {
      return;
    }
    update({ connection: 'connecting' });
    const source = createEventSource();
    eventSource = source;
    source.onopen = () => {
      update({ connection: state.snapshot ? 'disconnected' : 'connecting' });
    };
    source.onerror = () => {
      update({ connection: 'disconnected' });
    };
    source.addEventListener('snapshot', (event) => {
      try {
        acceptSnapshot(parseSourceControlSnapshot(JSON.parse(event.data) as unknown));
      } catch {
        update({ connection: 'disconnected' });
      }
    });
    source.addEventListener('report-published', (event) => {
      try {
        acceptPublication(parseReportPublishedEvent(JSON.parse(event.data) as unknown));
      } catch {
        update({ connection: 'disconnected' });
      }
    });
    source.addEventListener('control-state', (event) => {
      try {
        const connection = parseControlState(JSON.parse(event.data) as unknown);
        update({ connection });
        if (connection === 'protocol-mismatch') {
          source.close();
        }
      } catch {
        update({ connection: 'disconnected' });
      }
    });
  };

  const stop = (): void => {
    eventSource?.close();
    eventSource = null;
    pendingCommandController?.abort();
    pendingCommandController = null;
    update({ connection: 'stopped', pendingCommand: null });
  };

  const execute = async (command: SourceControlCommand): Promise<boolean> => {
    if (state.connection !== 'live' || state.pendingCommand) {
      return false;
    }
    const commandController = new AbortController();
    pendingCommandController = commandController;
    update({ commandError: null, pendingCommand: command });
    try {
      const result = parseSourceControlCommandResponse(await sendCommand(command, commandController.signal));
      commandController.signal.throwIfAborted();
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      acceptSnapshot(parseSourceControlSnapshot(result.snapshot));
      return true;
    } catch (error) {
      if (commandController.signal.aborted) {
        return false;
      }
      update({
        commandError: error instanceof Error ? error.message : 'The source control command failed.',
      });
      return false;
    } finally {
      if (pendingCommandController === commandController) {
        pendingCommandController = null;
        update({ pendingCommand: null });
      }
    }
  };

  return {
    execute,
    getState: () => state,
    start,
    stop,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
};

export const createInertSourceControlClient = (): SourceControlClient => ({
  execute: () => Promise.resolve(false),
  getState: () => initialState,
  start: () => undefined,
  stop: () => undefined,
  subscribe: (listener) => {
    listener(initialState);
    return () => undefined;
  },
});

export const createSourceControlClientForMode = (
  mode: RuntimeMode,
  createLiveClient: () => SourceControlClient = createSourceControlClient,
): SourceControlClient => (mode === 'demo' ? createInertSourceControlClient() : createLiveClient());
