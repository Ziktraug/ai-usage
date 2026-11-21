import { describe, expect, test } from 'bun:test';
import { providerProgressState } from './provider-status-progress';

describe('provider status progress', () => {
  test('models unknown usage as an indeterminate progress state without a value', () => {
    const state = providerProgressState(null);

    expect(state).toEqual({ kind: 'indeterminate' });
    expect('value' in state).toBe(false);
  });
});
