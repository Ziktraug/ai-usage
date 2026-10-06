import { describe, expect, test } from 'bun:test';
import {
  collectionSourceDefinitions,
  type SourceControlEntryView,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import type { SourceControlClientState, SourceControlConnectionState } from '../../../source-control-client';
import { summarizeSourceControlStatus } from './source-control-summary-model';

const definition = collectionSourceDefinitions[0];
const secondDefinition = collectionSourceDefinitions[1];
if (definition === undefined || secondDefinition === undefined) {
  throw new Error('The source-control catalogue must expose two synthetic fixture sources.');
}

const sourceEntry = (
  overrides: Partial<SourceControlEntryView> & Pick<SourceControlEntryView, 'id' | 'label'>,
): SourceControlEntryView => ({
  availability: 'detected',
  cadenceMs: definition.cadenceMs,
  lastOutcome: 'success',
  lifecycle: 'scheduled',
  policy: 'enabled',
  reason: { code: 'none' },
  warnings: [],
  ...overrides,
});

const snapshotOf = (sources: SourceControlEntryView[], runningCount = 0): SourceControlView => ({
  generatedAt: '2026-08-23T10:00:00.000Z',
  generation: 7,
  instanceId: 'summary-model-test',
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 0,
    lastOutcome: 'success',
    pendingDemand: false,
    publishedGeneration: 1,
    queued: false,
    requestedGeneration: 1,
    rtkCompletedGeneration: 1,
    rtkRequiredGeneration: 1,
    running: false,
  },
  queueDepth: 0,
  runningCount,
  sources,
});

const stateOf = (
  snapshot: SourceControlView | null,
  connection: SourceControlConnectionState = 'live',
): SourceControlClientState => ({
  commandError: null,
  connection,
  pendingCommand: null,
  publication: null,
  snapshot,
});

const healthy = sourceEntry({ id: definition.id, label: definition.label });
const warned = sourceEntry({ id: definition.id, label: definition.label, lastOutcome: 'warning' });
const secondWarned = sourceEntry({ id: secondDefinition.id, label: secondDefinition.label, lastOutcome: 'warning' });

describe('collection source pill status', () => {
  test('reads as not-yet-known before the first snapshot arrives', () => {
    const status = summarizeSourceControlStatus(stateOf(null, 'stopped'));

    expect(status.label).toBe('Checking…');
    expect(status.phase).toBe('checking');
    expect(status.tone).toBe('info');
    expect(status.generation).toBeNull();
  });

  test('counts and names the enabled sources whose last run needs attention', () => {
    const status = summarizeSourceControlStatus(stateOf(snapshotOf([warned, healthy])));

    expect(status.label).toBe('1 warning');
    expect(status.tone).toBe('danger');
    expect(status.warningSources).toEqual([definition.label]);
  });

  test('pluralizes the warning count', () => {
    expect(summarizeSourceControlStatus(stateOf(snapshotOf([warned, secondWarned]))).label).toBe('2 warnings');
  });

  test('ignores a disabled source that failed', () => {
    const disabled = sourceEntry({
      id: secondDefinition.id,
      label: secondDefinition.label,
      lastOutcome: 'failed',
      policy: 'disabled',
    });

    const status = summarizeSourceControlStatus(stateOf(snapshotOf([healthy, disabled])));

    expect(status.label).toBe('Sources ready');
    expect(status.warningSources).toEqual([]);
  });

  test('reports running collection independently of warnings', () => {
    const running = sourceEntry({ id: definition.id, label: definition.label, lifecycle: 'running' });

    const status = summarizeSourceControlStatus(stateOf(snapshotOf([running, secondWarned], 1)));

    expect(status.label).toBe('Updating…');
    expect(status.detail).toContain(definition.label);
    expect(status.phase).toBe('collecting');
    expect(status.tone).toBe('info');
    expect(status.warningSources).toEqual([secondDefinition.label]);
  });

  test('distinguishes queued work, preparation and failed publication', () => {
    const snapshot = snapshotOf([healthy]);
    expect(
      summarizeSourceControlStatus(stateOf({ ...snapshot, publication: { ...snapshot.publication, queued: true } }))
        .phase,
    ).toBe('queued');
    expect(
      summarizeSourceControlStatus(stateOf({ ...snapshot, publication: { ...snapshot.publication, running: true } }))
        .phase,
    ).toBe('preparing');
    expect(
      summarizeSourceControlStatus(
        stateOf({ ...snapshot, publication: { ...snapshot.publication, lastOutcome: 'failed', pendingDemand: true } }),
      ).phase,
    ).toBe('failed');
  });

  test('reads as ready when every enabled source is healthy', () => {
    const status = summarizeSourceControlStatus(stateOf(snapshotOf([healthy])));

    expect(status.label).toBe('Sources ready');
    expect(status.tone).toBe('ok');
    expect(status.generation).toBe(7);
  });

  test('keeps a lost stream visible without discarding the snapshot it already has', () => {
    const status = summarizeSourceControlStatus(stateOf(snapshotOf([healthy]), 'disconnected'));

    expect(status.label).toBe('Reconnecting');
    expect(status.tone).toBe('warning');
    expect(status.generation).toBe(7);
  });

  test('does not report an old running snapshot as current activity after disconnect', () => {
    const snapshot = snapshotOf([healthy], 1);
    expect(summarizeSourceControlStatus(stateOf(snapshot, 'disconnected')).phase).toBe('unavailable');
  });
});
