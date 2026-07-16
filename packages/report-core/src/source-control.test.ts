import { describe, expect, test } from 'bun:test';
import {
  collectionSourceDefinitions,
  collectionSourceIds,
  getCollectionSourceDefinition,
  isCollectionSourceId,
  isSourcePolicyOverrides,
  resolveSourceEnabled,
  updateSourcePolicyOverrides,
} from './source-control';

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
});
