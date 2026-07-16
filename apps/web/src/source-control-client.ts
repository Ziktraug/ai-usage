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

export type { SourceControlCommandResponse } from '@ai-usage/report-core/source-control';

export type SourceControlConnectionState = 'connecting' | 'live' | 'stale' | 'stopped';

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
  addEventListener(type: 'report-published' | 'snapshot', listener: (event: EventSourceMessage) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
}

export interface SourceControlClientOptions {
  readonly createEventSource?: () => SourceControlEventSource;
  readonly sendCommand?: (command: SourceControlCommand) => Promise<SourceControlCommandResponse>;
}

export interface SourceControlClient {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly getState: () => SourceControlClientState;
  readonly start: () => void;
  readonly stop: () => void;
  readonly subscribe: (listener: (state: SourceControlClientState) => void) => () => void;
}

const initialState: SourceControlClientState = {
  commandError: null,
  connection: 'stopped',
  pendingCommand: null,
  publication: null,
  snapshot: null,
};

const defaultEventSource = (): SourceControlEventSource => new EventSource('/api/source-control');

const defaultSendCommand = async (command: SourceControlCommand): Promise<SourceControlCommandResponse> => {
  const response = await fetch('/api/source-control/command', {
    body: JSON.stringify(command),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const result = parseSourceControlCommandResponse(await response.json());
  if (!(response.ok && result.ok)) {
    throw new Error(result.ok ? 'The source control command failed.' : result.error.message);
  }
  return result;
};

export const createSourceControlClient = (options: SourceControlClientOptions = {}): SourceControlClient => {
  const listeners = new Set<(state: SourceControlClientState) => void>();
  const createEventSource = options.createEventSource ?? defaultEventSource;
  const sendCommand = options.sendCommand ?? defaultSendCommand;
  let eventSource: SourceControlEventSource | null = null;
  let state = initialState;

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
      update({ connection: state.snapshot ? 'stale' : 'connecting' });
    };
    source.onerror = () => {
      update({ connection: state.snapshot ? 'stale' : 'connecting' });
    };
    source.addEventListener('snapshot', (event) => {
      try {
        acceptSnapshot(parseSourceControlSnapshot(JSON.parse(event.data) as unknown));
      } catch {
        update({ connection: state.snapshot ? 'stale' : 'connecting' });
      }
    });
    source.addEventListener('report-published', (event) => {
      try {
        acceptPublication(parseReportPublishedEvent(JSON.parse(event.data) as unknown));
      } catch {
        update({ connection: state.snapshot ? 'stale' : 'connecting' });
      }
    });
  };

  const stop = (): void => {
    eventSource?.close();
    eventSource = null;
    update({ connection: 'stopped', pendingCommand: null });
  };

  const execute = async (command: SourceControlCommand): Promise<boolean> => {
    if (state.pendingCommand) {
      return false;
    }
    update({ commandError: null, pendingCommand: command });
    try {
      const result = parseSourceControlCommandResponse(await sendCommand(command));
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      acceptSnapshot(parseSourceControlSnapshot(result.snapshot));
      return true;
    } catch (error) {
      update({
        commandError: error instanceof Error ? error.message : 'The source control command failed.',
      });
      return false;
    } finally {
      update({ pendingCommand: null });
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
