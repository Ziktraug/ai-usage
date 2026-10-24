import { describe, expect, test } from 'bun:test';
import { createSkillsFallbackNavigationRequest, createSkillsFallbackNavigator } from './skills-fallback-navigation';

const MISSING_SKILL = 'http://local/skills/global/missing?utm=kept#section';
const WORKTABLE = 'http://local/skills?utm=kept#section';

// A settled write releases the navigator a few promise reactions later; a task boundary covers them.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const deferredHistory = (initialHref: string) => {
  let href = initialHref;
  const failures: unknown[] = [];
  const outcomes: ('accepted' | 'failed')[] = [];
  const writes: { settle: (failure?: unknown) => void; state: App.PageState; url: string }[] = [];
  const navigator = createSkillsFallbackNavigator({
    currentHref: () => href,
    onAccepted: () => outcomes.push('accepted'),
    onFailure: (cause) => {
      failures.push(cause);
      outcomes.push('failed');
    },
    replace: (url, state) =>
      new Promise((resolve, reject) => {
        writes.push({
          settle: (failure) => {
            if (failure === undefined) {
              href = String(url);
              resolve();
            } else {
              reject(failure);
            }
          },
          state,
          url: String(url),
        });
      }),
  });
  return {
    failures,
    navigate: (next: string) => {
      href = next;
    },
    navigator,
    outcomes,
    writes,
  };
};

describe('Skills fallback navigation request', () => {
  test('preserves the supplied application history state and frozen fallback intent', () => {
    const state: App.PageState = { aiUsageNavigationKey: 'skills-history-entry' };

    const request = createSkillsFallbackNavigationRequest(MISSING_SKILL, state);

    expect(request.state).toBe(state);
    expect(request.intent).toMatchObject({ replace: true, resetScroll: false });
    expect(String(request.intent.url)).toBe(WORKTABLE);
  });
});

describe('Skills fallback navigator', () => {
  test('rewrites the address once per fallback although every write hands back a new state', async () => {
    const history = deferredHistory(MISSING_SKILL);

    history.navigator.apply({ aiUsageNavigationKey: 'entry' });
    // SvelteKit 3 re-parses the state of every `replaceState`, so `page.state` changes identity
    // and the effect that asked for the fallback runs again, before and after the write lands.
    history.navigator.apply({ aiUsageNavigationKey: 'entry' });
    expect(history.writes.map(({ state, url }) => ({ state, url }))).toEqual([
      { state: { aiUsageNavigationKey: 'entry' }, url: WORKTABLE },
    ]);

    history.writes[0]?.settle();
    await settled();
    history.navigator.apply({ aiUsageNavigationKey: 'entry' });
    history.navigator.apply({ aiUsageNavigationKey: 'entry' });

    expect(history.writes).toHaveLength(1);
    expect(history.failures).toEqual([]);
    expect(history.outcomes).toEqual(['accepted']);
  });

  test('falls back again after a later navigation names a missing skill', async () => {
    const history = deferredHistory(MISSING_SKILL);
    history.navigator.apply({});
    history.writes[0]?.settle();
    await settled();

    history.navigate('http://local/skills/global/also-missing');
    history.navigator.apply({ aiUsageNavigationKey: 'next-entry' });

    expect(history.writes.map(({ url }) => url)).toEqual([WORKTABLE, 'http://local/skills']);
  });

  test('reports a rejected rewrite and can retry it', async () => {
    const history = deferredHistory(MISSING_SKILL);
    const rejection = new Error('replaceState rejected');

    history.navigator.apply({});
    history.writes[0]?.settle(rejection);
    await settled();

    expect(history.failures).toEqual([rejection]);
    history.navigator.apply({});
    expect(history.writes).toHaveLength(2);
  });

  test('reports a later accepted rewrite after a rejected one, so the shown failure can clear', async () => {
    const history = deferredHistory(MISSING_SKILL);

    history.navigator.apply({});
    history.writes[0]?.settle(new Error('replaceState rejected'));
    await settled();
    expect(history.outcomes).toEqual(['failed']);

    history.navigator.apply({});
    history.writes[1]?.settle();
    await settled();

    expect(history.outcomes).toEqual(['failed', 'accepted']);
  });
});
