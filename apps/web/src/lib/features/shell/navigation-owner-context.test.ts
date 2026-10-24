import { describe, expect, test } from 'bun:test';
import { createShellNavigationOwner } from './navigation-owner-context';

const currentUrl = () => new URL('http://localhost/?tab=sessions');
const detailUrl = new URL('http://localhost/sessions/row-1?tab=sessions');
const otherUrl = new URL('http://localhost/sessions/row-2?tab=sessions');

const pendingNavigation = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve: () => resolve() };
};

describe('shell navigation ownership', () => {
  test('keeps two application instances isolated and consumes only the matching goto once', async () => {
    const navigation = pendingNavigation();
    const first = createShellNavigationOwner({ currentUrl, goto: () => navigation.promise });
    const second = createShellNavigationOwner({ currentUrl, goto: () => navigation.promise });
    const opening = first.goto(detailUrl, { replace: true });

    expect(second.consumeIntent('goto', detailUrl).replace).toBe(false);
    expect(first.consumeIntent('popstate', detailUrl).replace).toBe(false);
    expect(first.consumeIntent('link', detailUrl).replace).toBe(false);
    expect(first.consumeIntent('goto', otherUrl).replace).toBe(false);
    expect(first.consumeIntent('goto', detailUrl).replace).toBe(true);
    expect(first.consumeIntent('goto', detailUrl).replace).toBe(false);
    navigation.resolve();
    await opening;
  });

  test('cleans up cancellation before beforeNavigate without marking the next navigation', async () => {
    const navigation = pendingNavigation();
    const owner = createShellNavigationOwner({ currentUrl, goto: () => navigation.promise });
    const cancelled = owner.goto(detailUrl, { replace: true });
    navigation.resolve();
    await cancelled;
    expect(owner.consumeIntent('goto', detailUrl).replace).toBe(false);
  });

  test('cleans up a rejected goto and preserves the original failure', async () => {
    const failure = new Error('Navigation cancelled');
    const owner = createShellNavigationOwner({
      currentUrl,
      goto: () => Promise.reject(failure),
    });
    await expect(owner.goto(detailUrl, { replace: true })).rejects.toBe(failure);
    expect(owner.consumeIntent('goto', detailUrl).replace).toBe(false);
  });

  test('an older cancellation cannot clear a newer replacement to the same destination', async () => {
    const first = pendingNavigation();
    const second = pendingNavigation();
    let calls = 0;
    const owner = createShellNavigationOwner({
      currentUrl,
      goto: () => (++calls === 1 ? first.promise : second.promise),
    });
    const older = owner.goto(detailUrl, { replace: true });
    const newer = owner.goto(detailUrl, { replace: true });
    first.resolve();
    await older;
    expect(owner.consumeIntent('goto', detailUrl).replace).toBe(true);
    second.resolve();
    await newer;
  });

  test('keeps normal pushes distinct from replacements and forwards history state unchanged', async () => {
    const navigation = pendingNavigation();
    const calls: unknown[] = [];
    const owner = createShellNavigationOwner({
      currentUrl,
      goto: (url, gotoOptions) => {
        calls.push({ options: gotoOptions, url });
        return navigation.promise;
      },
    });
    const options = {
      reset: false,
      state: { aiUsageNavigationKey: 'entry-1' },
    };
    const opening = owner.goto('/sessions/row-1?tab=sessions', options);
    expect(owner.consumeIntent('goto', detailUrl).replace).toBe(false);
    expect(calls).toEqual([{ options, url: '/sessions/row-1?tab=sessions' }]);
    navigation.resolve();
    await opening;
  });

  test('keeps scroll preservation for the shell instead of passing it to SvelteKit', async () => {
    const navigation = pendingNavigation();
    const calls: unknown[] = [];
    const owner = createShellNavigationOwner({
      currentUrl,
      goto: (url, options) => {
        calls.push({ options, url });
        return navigation.promise;
      },
    });
    const opening = owner.goto(detailUrl, { preserveScroll: true, replace: true });
    expect(calls).toEqual([{ options: { replace: true }, url: detailUrl }]);
    expect(owner.consumeIntent('link', detailUrl)).toEqual({ preserveScroll: false, replace: false });
    expect(owner.consumeIntent('goto', detailUrl)).toEqual({ preserveScroll: true, replace: true });
    expect(owner.consumeIntent('goto', detailUrl)).toEqual({ preserveScroll: false, replace: false });
    navigation.resolve();
    await opening;
  });

  test('a newer push to the same URL supersedes an unconsumed replacement intent', async () => {
    const navigation = pendingNavigation();
    const owner = createShellNavigationOwner({ currentUrl, goto: () => navigation.promise });
    const replaced = owner.goto(detailUrl, { replace: true });
    const pushed = owner.goto(detailUrl);
    expect(owner.consumeIntent('goto', detailUrl).replace).toBe(false);
    navigation.resolve();
    await Promise.all([replaced, pushed]);
  });
});
