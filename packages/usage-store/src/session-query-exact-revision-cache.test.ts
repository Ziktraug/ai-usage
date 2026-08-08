import { describe, expect, test } from 'bun:test';
import { createSessionQueryExactRevisionCache } from './session-query-exact-revision-cache';

describe('exact-revision session query cache', () => {
  test('bounds totals and refreshes projection recency independently', () => {
    const cache = createSessionQueryExactRevisionCache<number, string>({ projections: 2, totals: 1 });
    cache.rememberTotals('first', 1);
    cache.rememberTotals('second', 2);
    cache.rememberProjection('first', 'one');
    cache.rememberProjection('second', 'two');

    expect(cache.projection('first')).toBe('one');
    cache.rememberProjection('third', 'three');

    expect(cache.totals('first')).toBeUndefined();
    expect(cache.totals('second')).toBe(2);
    expect(cache.projection('first')).toBe('one');
    expect(cache.projection('second')).toBeUndefined();
    expect(cache.projection('third')).toBe('three');
  });

  test('resets both cache families', () => {
    const cache = createSessionQueryExactRevisionCache<number, string>({ projections: 1, totals: 1 });
    cache.rememberTotals('identity', 1);
    cache.rememberProjection('identity', 'projection');

    cache.reset();

    expect(cache.totals('identity')).toBeUndefined();
    expect(cache.projection('identity')).toBeUndefined();
  });
});
