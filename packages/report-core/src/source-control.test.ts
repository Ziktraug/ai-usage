import { describe, expect, test } from 'bun:test';
import {
  chooseNewestSourceControlSnapshot,
  collectionSourceDefinitions,
  collectionSourceIds,
  getCollectionSourceDefinition,
  isCollectionSourceId,
  isSourcePolicyOverrides,
  parseReportPublishedEvent,
  parseSourceControlCommand,
  parseSourceControlCommandResponse,
  parseSourceControlSnapshot,
  resolveSourceEnabled,
  sourceControlBounds,
  updateSourcePolicyOverrides,
} from './source-control';

const snapshot = (generation = 1) => ({
  generatedAt: '2026-07-16T10:00:00.000Z',
  generation,
  instanceId: 'instance-a',
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 1,
    lastOutcome: 'success',
    lastPublishedAt: '2026-07-16T10:00:00.000Z',
    pendingDemand: false,
    publishedGeneration: 1,
    queued: false,
    requestedGeneration: 1,
    revision: 'revision-1',
    rtkCompletedGeneration: 1,
    rtkRequiredGeneration: 1,
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

describe('collection source contracts', () => {
  test('defines every stable source exactly once with the agreed defaults', () => {
    expect(collectionSourceDefinitions.map(({ id }) => id)).toEqual([...collectionSourceIds]);
    expect(new Set(collectionSourceIds).size).toBe(collectionSourceIds.length);
    expect(getCollectionSourceDefinition('codex.usage-limits').cadenceMs).toBe(300_000);
    expect(
      collectionSourceDefinitions
        .filter(({ id }) => id !== 'codex.usage-limits')
        .every(({ cadenceMs }) => cadenceMs === 60_000),
    ).toBe(true);
    expect(collectionSourceDefinitions.every(({ defaultEnabled }) => defaultEnabled)).toBe(true);
  });

  test('validates stable ids and strict sparse overrides', () => {
    expect(isCollectionSourceId('cursor.sessions')).toBe(true);
    expect(isCollectionSourceId('cursor.sqlite')).toBe(false);
    expect(
      isSourcePolicyOverrides({
        'codex.sessions': { enabled: false },
        'cursor.sessions': { enabled: true },
      }),
    ).toBe(true);
    expect(isSourcePolicyOverrides({ 'unknown.sessions': { enabled: false } })).toBe(false);
    expect(isSourcePolicyOverrides({ 'codex.sessions': { enabled: 'false' } })).toBe(false);
    expect(isSourcePolicyOverrides({ 'codex.sessions': { enabled: false, cadence: 1 } })).toBe(false);
  });

  test('resolves defaults and removes redundant overrides', () => {
    expect(resolveSourceEnabled('codex.sessions')).toBe(true);
    const disabled = updateSourcePolicyOverrides(undefined, 'codex.sessions', false);
    expect(disabled).toEqual({ 'codex.sessions': { enabled: false } });
    expect(resolveSourceEnabled('codex.sessions', disabled)).toBe(false);
    expect(updateSourcePolicyOverrides(disabled, 'codex.sessions', true)).toBeUndefined();
    expect(updateSourcePolicyOverrides(disabled, 'codex.sessions', undefined)).toBeUndefined();
  });

  test('parses only strict commands with stable source ids', () => {
    expect(
      parseSourceControlCommand({
        command: 'set-enabled',
        enabled: false,
        sourceId: 'codex.sessions',
      }),
    ).toEqual({
      command: 'set-enabled',
      enabled: false,
      sourceId: 'codex.sessions',
    });
    expect(parseSourceControlCommand({ command: 'run-all' })).toEqual({
      command: 'run-all',
    });
    expect(() =>
      parseSourceControlCommand({
        command: 'run-now',
        sourceId: 'unknown.sessions',
      }),
    ).toThrow('known source ID');
    expect(() =>
      parseSourceControlCommand({
        command: 'detect-all',
        unexpected: true,
      }),
    ).toThrow('unknown fields');
  });

  test('strictly parses nested snapshots, command responses, publication events, and replacement', () => {
    const parsed = parseSourceControlSnapshot(snapshot());
    expect(parseSourceControlCommandResponse({ accepted: true, ok: true, snapshot: parsed }).ok).toBe(true);
    expect(
      parseReportPublishedEvent({
        instanceId: 'instance-a',
        publishedAt: '2026-07-16T10:00:00.000Z',
        revision: 'revision-1',
        sourceControlGeneration: 1,
      }).revision,
    ).toBe('revision-1');
    expect(chooseNewestSourceControlSnapshot(parsed, parseSourceControlSnapshot(snapshot(0))).generation).toBe(1);
  });

  test('rejects malformed nested and oversized source-control payloads', () => {
    expect(() =>
      parseSourceControlSnapshot({
        ...snapshot(),
        sources: [{ ...snapshot().sources[0], lifecycle: 'invented' }],
      }),
    ).toThrow('invalid');
    expect(() =>
      parseSourceControlSnapshot({
        ...snapshot(),
        sources: [{ ...snapshot().sources[0], warnings: [{ code: 'x', message: 'x'.repeat(70_000) }] }],
      }),
    ).toThrow('size limit');
    expect(() =>
      parseSourceControlCommandResponse({ accepted: true, ok: true, snapshot: { ...snapshot(), queueDepth: -1 } }),
    ).toThrow('invalid');
  });

  test('requires the exact canonical catalogue', () => {
    const complete = snapshot();
    expect(() => parseSourceControlSnapshot({ ...complete, sources: [] })).toThrow('invalid');
    expect(() => parseSourceControlSnapshot({ ...complete, sources: complete.sources.slice(1) })).toThrow('invalid');
    expect(() =>
      parseSourceControlSnapshot({ ...complete, sources: [...complete.sources.slice(0, -1), complete.sources[0]] }),
    ).toThrow('invalid');
    expect(() =>
      parseSourceControlSnapshot({
        ...complete,
        sources: complete.sources.map((source, index) =>
          index === 0 ? { ...source, id: 'unknown.sessions' } : source,
        ),
      }),
    ).toThrow('invalid');
  });

  test('rejects out-of-bound numbers, invalid generations, and inconsistent lifecycle counts', () => {
    const complete = snapshot();
    expect(() =>
      parseSourceControlSnapshot({
        ...complete,
        sources: complete.sources.map((source, index) =>
          index === 0 ? { ...source, inputCount: sourceControlBounds.maxCount + 1 } : source,
        ),
      }),
    ).toThrow('invalid');
    expect(() =>
      parseSourceControlSnapshot({ ...complete, queueDepth: sourceControlBounds.maxQueueDepth + 1 }),
    ).toThrow('invalid');
    expect(() =>
      parseSourceControlSnapshot({
        ...complete,
        publication: { ...complete.publication, rtkCompletedGeneration: 2 },
      }),
    ).toThrow('invalid');
    expect(() =>
      parseSourceControlSnapshot({
        ...complete,
        sources: complete.sources.map((source, index) => (index === 0 ? { ...source, lifecycle: 'running' } : source)),
      }),
    ).toThrow('invalid');
  });
});
