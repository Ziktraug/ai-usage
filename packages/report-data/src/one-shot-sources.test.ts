import { describe, expect, test } from 'bun:test';
import type { CollectionSourceId } from '@ai-usage/report-core/source-control';
import { Duration, Effect, Ref } from 'effect';
import { executeOneShotSources, localOneShotSourceIds } from './one-shot-sources';
import type { ScheduledSource } from './source-adapters';

const source = (id: CollectionSourceId, calls: Ref.Ref<CollectionSourceId[]>): ScheduledSource => ({
  cadence: Duration.minutes(1),
  detect: Effect.succeed({
    availability: 'detected',
    reason: { code: 'none' },
  }),
  id,
  run: () =>
    Ref.update(calls, (current) => [...current, id]).pipe(
      Effect.as({
        changed: true,
        inputCount: 1,
        outputCount: 1,
        warnings: [],
      }),
    ),
});

describe('one-shot source execution', () => {
  test('selects local sources without provider communication', () => {
    expect(localOneShotSourceIds({ harness: null, includeCursor: true })).toEqual([
      'claude.sessions',
      'codex.sessions',
      'opencode.sessions',
      'cursor.sessions',
      'rtk.savings',
      'cursor.commit-attribution',
    ]);
    expect(localOneShotSourceIds({ harness: 'codex', includeCursor: false })).toEqual([
      'codex.sessions',
      'rtk.savings',
    ]);
    expect(localOneShotSourceIds({ harness: 'cursor', includeCursor: false })).toEqual([]);
    expect(localOneShotSourceIds({ harness: null, includeCursor: true })).not.toContain('codex.usage-limits');
  });

  test('honors sparse policy and continues neighboring sources', async () => {
    const program = Effect.gen(function* () {
      const calls = yield* Ref.make<CollectionSourceId[]>([]);
      const sources = new Map<CollectionSourceId, ScheduledSource>([
        ['claude.sessions', source('claude.sessions', calls)],
        ['codex.sessions', source('codex.sessions', calls)],
      ]);
      const result = yield* executeOneShotSources({
        policies: { 'codex.sessions': { enabled: false } },
        sourceIds: ['claude.sessions', 'codex.sessions'],
        sources,
      });

      expect(yield* Ref.get(calls)).toEqual(['claude.sessions']);
      expect(result.outcomes).toMatchObject([
        { sourceId: 'claude.sessions', status: 'success' },
        { sourceId: 'codex.sessions', status: 'paused' },
      ]);
      expect(result.changed).toBe(true);
    });

    await Effect.runPromise(program);
  });

  test('runs quota only when explicitly selected', async () => {
    const program = Effect.gen(function* () {
      const calls = yield* Ref.make<CollectionSourceId[]>([]);
      const sources = new Map<CollectionSourceId, ScheduledSource>([
        ['codex.sessions', source('codex.sessions', calls)],
        ['codex.usage-limits', source('codex.usage-limits', calls)],
      ]);
      yield* executeOneShotSources({
        sourceIds: ['codex.usage-limits'],
        sources,
      });
      expect(yield* Ref.get(calls)).toEqual(['codex.usage-limits']);
    });

    await Effect.runPromise(program);
  });
});
