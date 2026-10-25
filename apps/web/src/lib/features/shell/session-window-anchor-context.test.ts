import { describe, expect, test } from 'bun:test';
import { createSessionWindowAnchorOwner } from './session-window-anchor-context';

describe('Session window anchor history owner', () => {
  test('consumes the capability once per history entry and preserves other state', () => {
    let state: App.PageState = { aiUsageNavigationKey: 'sessions-entry' };
    const replacements: App.PageState[] = [];
    const failures: unknown[] = [];
    const owner = createSessionWindowAnchorOwner({
      onFailure: (cause) => failures.push(cause),
      replace: (next) => {
        state = next;
        replacements.push(next);
        return Promise.resolve();
      },
      state: () => state,
    });

    expect(owner.available()).toBe(true);
    owner.consume();
    owner.consume();
    expect(replacements).toEqual([
      {
        aiUsageNavigationKey: 'sessions-entry',
        aiUsageSessionWindowAnchorConsumed: true,
      },
    ]);
    expect(owner.available()).toBe(false);

    state = { aiUsageNavigationKey: 'new-sessions-entry' };
    expect(owner.available()).toBe(true);
    owner.beginNavigation(true);
    expect(owner.available()).toBe(false);
    state = { aiUsageNavigationKey: 'preserved-sessions-entry' };
    owner.settleNavigation();
    expect(owner.available()).toBe(false);
    expect(state.aiUsageSessionWindowAnchorConsumed).toBe(true);

    owner.beginNavigation(true);
    owner.cancelNavigation();
    state = { aiUsageNavigationKey: 'cancelled-entry' };
    expect(owner.available()).toBe(true);
    state = replacements[0] ?? {};
    expect(owner.available()).toBe(false);
    expect(failures).toEqual([]);
  });

  test('reports a rejected history write instead of dropping it', async () => {
    const rejection = new Error('history write rejected');
    const failures: unknown[] = [];
    const owner = createSessionWindowAnchorOwner({
      onFailure: (cause) => failures.push(cause),
      replace: () => Promise.reject(rejection),
      state: () => ({ aiUsageNavigationKey: 'sessions-entry' }),
    });

    owner.consume();
    owner.beginNavigation(true);
    owner.settleNavigation();
    await Promise.resolve();

    expect(failures).toEqual([rejection, rejection]);
  });
});
