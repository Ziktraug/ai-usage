import { describe, expect, test } from 'bun:test';
import {
  collectionSourceDefinitions,
  type SourceControlCommand,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import {
  createSourceControlClient,
  type SourceControlCommandResponse,
  type SourceControlEventSource,
} from './source-control-client';

const snapshot = (generation: number, instanceId = 'process-a'): SourceControlView => ({
  generatedAt: '2026-07-16T10:00:00.000Z',
  generation,
  instanceId,
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 0,
    lastOutcome: 'success',
    pendingDemand: false,
    publishedGeneration: 0,
    queued: false,
    requestedGeneration: 1,
    rtkCompletedGeneration: 0,
    rtkRequiredGeneration: 0,
    running: false,
  },
  queueDepth: 0,
  runningCount: 0,
  sources: collectionSourceDefinitions.map((definition) => ({
    availability: 'detected',
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'success',
    lifecycle: 'scheduled',
    policy: 'enabled',
    reason: { code: 'none' },
    warnings: [],
  })),
});

class FakeEventSource implements SourceControlEventSource {
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, (event: { data: string }) => void>();

  addEventListener(type: 'report-published' | 'snapshot', listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(value: SourceControlView): void {
    this.listeners.get('snapshot')?.({ data: JSON.stringify(value) });
  }

  emitPublication(revision: string): void {
    this.listeners.get('report-published')?.({
      data: JSON.stringify({
        instanceId: 'process-a',
        publishedAt: '2026-07-16T10:00:00.000Z',
        revision,
        sourceControlGeneration: 4,
      }),
    });
  }
}

describe('source control client', () => {
  test('starts only once, replaces snapshots, and closes cleanly', () => {
    const eventSource = new FakeEventSource();
    let connectionCount = 0;
    const client = createSourceControlClient({
      createEventSource: () => {
        connectionCount++;
        return eventSource;
      },
    });

    client.start();
    client.start();
    expect(connectionCount).toBe(1);
    expect(client.getState().connection).toBe('connecting');

    eventSource.emit(snapshot(3));
    eventSource.emit(snapshot(2));
    expect(client.getState().snapshot?.generation).toBe(3);
    expect(client.getState().connection).toBe('live');
    expect(client.getState().snapshot?.sources.map(({ id }) => id)).toEqual(
      collectionSourceDefinitions.map(({ id }) => id),
    );

    eventSource.onerror?.(new Event('error'));
    expect(client.getState().connection).toBe('stale');
    eventSource.emit(snapshot(0, 'process-b'));
    expect(client.getState().snapshot?.instanceId).toBe('process-b');
    expect(client.getState().snapshot?.generation).toBe(0);

    client.stop();
    expect(eventSource.closed).toBe(true);
    expect(client.getState().connection).toBe('stopped');
  });

  test('keeps lifecycle server-confirmed and blocks conflicting commands', async () => {
    let resolveCommand: ((value: SourceControlCommandResponse) => void) | undefined;
    const commands: SourceControlCommand[] = [];
    const client = createSourceControlClient({
      sendCommand: (command) => {
        commands.push(command);
        return new Promise((resolve) => {
          resolveCommand = resolve;
        });
      },
    });

    const first = client.execute({ command: 'run-now', sourceId: 'codex.sessions' });
    expect(client.getState().pendingCommand).toEqual({ command: 'run-now', sourceId: 'codex.sessions' });
    expect(client.getState().snapshot).toBeNull();
    expect(await client.execute({ command: 'run-all' })).toBe(false);
    expect(commands).toHaveLength(1);

    resolveCommand?.({ accepted: true, ok: true, snapshot: snapshot(4) });
    expect(await first).toBe(true);
    expect(client.getState().pendingCommand).toBeNull();
    expect(client.getState().snapshot?.sources[0]?.lifecycle).toBe('scheduled');
  });

  test('retains the last snapshot and exposes bounded command failure text', async () => {
    const eventSource = new FakeEventSource();
    const client = createSourceControlClient({
      createEventSource: () => eventSource,
      sendCommand: () => Promise.reject(new Error('The source policy could not be saved.')),
    });
    client.start();
    eventSource.emit(snapshot(1));

    expect(await client.execute({ command: 'set-enabled', enabled: false, sourceId: 'codex.sessions' })).toBe(false);
    expect(client.getState().snapshot?.generation).toBe(1);
    expect(client.getState().commandError).toBe('The source policy could not be saved.');
  });

  test('strictly accepts and deduplicates explicit publication events', () => {
    const eventSource = new FakeEventSource();
    const client = createSourceControlClient({ createEventSource: () => eventSource });
    let publicationUpdates = 0;
    client.subscribe((state) => {
      if (state.publication) {
        publicationUpdates++;
      }
    });
    client.start();
    eventSource.emit(snapshot(3));
    eventSource.emitPublication('revision-4');
    eventSource.emitPublication('revision-4');
    expect(client.getState().publication?.revision).toBe('revision-4');
    expect(publicationUpdates).toBe(1);
  });
});
