import {
  isCollectionSourceId,
  type SourceControlCommand,
  type SourceControlEntryView,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';

export type SourceControlConnectionState = 'connecting' | 'live' | 'stale' | 'stopped';

export interface SourceControlClientState {
  readonly commandError: string | null;
  readonly connection: SourceControlConnectionState;
  readonly pendingCommand: SourceControlCommand | null;
  readonly snapshot: SourceControlView | null;
}

export interface SourceControlCommandResponse {
  readonly error?: {
    readonly message?: string;
  };
  readonly ok: boolean;
  readonly snapshot?: SourceControlView;
}

interface EventSourceMessage {
  readonly data: string;
}

export interface SourceControlEventSource {
  addEventListener(type: 'snapshot', listener: (event: EventSourceMessage) => void): void;
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
  snapshot: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sourceEntryLooksValid = (value: unknown): value is SourceControlEntryView =>
  isRecord(value) &&
  isCollectionSourceId(value.id) &&
  typeof value.label === 'string' &&
  typeof value.policy === 'string' &&
  typeof value.availability === 'string' &&
  typeof value.lifecycle === 'string' &&
  typeof value.lastOutcome === 'string' &&
  Array.isArray(value.warnings);

export const parseSourceControlSnapshot = (value: unknown): SourceControlView => {
  if (
    !isRecord(value) ||
    typeof value.generatedAt !== 'string' ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    typeof value.queueDepth !== 'number' ||
    typeof value.runningCount !== 'number' ||
    !Array.isArray(value.sources) ||
    !value.sources.every(sourceEntryLooksValid) ||
    !isRecord(value.publication) ||
    typeof value.publication.dirty !== 'boolean' ||
    typeof value.publication.running !== 'boolean'
  ) {
    throw new Error('Source control snapshot is invalid.');
  }
  return value as unknown as SourceControlView;
};

const defaultEventSource = (): SourceControlEventSource => new EventSource('/api/source-control');

const defaultSendCommand = async (command: SourceControlCommand): Promise<SourceControlCommandResponse> => {
  const response = await fetch('/api/source-control/command', {
    body: JSON.stringify(command),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const result = (await response.json()) as SourceControlCommandResponse;
  if (!(response.ok && result.ok)) {
    throw new Error(result.error?.message ?? 'The source control command failed.');
  }
  return result;
};

const replaceSnapshot = (current: SourceControlView | null, candidate: SourceControlView): SourceControlView => {
  if (!current || current.instanceId !== candidate.instanceId || candidate.generation >= current.generation) {
    return candidate;
  }
  return current;
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
    update({
      commandError: null,
      connection: 'live',
      snapshot: replaceSnapshot(state.snapshot, snapshot),
    });
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
      const result = await sendCommand(command);
      if (!(result.ok && result.snapshot)) {
        throw new Error(result.error?.message ?? 'The source control command failed.');
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
