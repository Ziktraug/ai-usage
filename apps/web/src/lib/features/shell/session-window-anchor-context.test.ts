import { describe, expect, test } from 'bun:test';
import { createSessionWindowAnchorOwner } from './session-window-anchor-context';

describe('Session window anchor history owner', () => {
  test('consumes the capability once per history entry and preserves other state', () => {
    let state: App.PageState = { aiUsageNavigationKey: 'sessions-entry' };
    const replacements: App.PageState[] = [];
    const owner = createSessionWindowAnchorOwner({
      replace: (next) => {
        state = next;
        replacements.push(next);
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
  });
});
