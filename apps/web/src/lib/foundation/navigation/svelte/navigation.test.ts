import { describe, expect, test } from 'bun:test';
import {
  createDrawerIdentityOwner,
  createMemoryNavigationPort,
  createSvelteNavigationPort,
  drawerCommandForKey,
  installScrollLifecycle,
  type ScrollLifecycleEvent,
  scrollDirectiveFor,
} from './navigation';

const scrollFixture = () => {
  let before: ((event: ScrollLifecycleEvent) => void) | undefined;
  let after: ((event: Pick<ScrollLifecycleEvent, 'toKey'>) => void) | undefined;
  let scheduled: (() => void) | undefined;
  let position = { x: 0, y: 0 };
  const applied: { x: number; y: number }[] = [];
  let cancelled = 0;
  let disposed = 0;
  const lifecycle = installScrollLifecycle({
    afterNavigate: (listener) => {
      after = listener;
      return () => {
        after = undefined;
        disposed += 1;
      };
    },
    afterRender: (callback) => {
      scheduled = callback;
      return () => {
        scheduled = undefined;
        cancelled += 1;
      };
    },
    beforeNavigate: (listener) => {
      before = listener;
      return () => {
        before = undefined;
        disposed += 1;
      };
    },
    position: () => position,
    scrollTo: (next) => applied.push(next),
  });
  return {
    after: (toKey: string) => after?.({ toKey }),
    applied,
    before: (event: ScrollLifecycleEvent) => before?.(event),
    cancelled: () => cancelled,
    disposed: () => disposed,
    flush: () => {
      const callback = scheduled;
      scheduled = undefined;
      callback?.();
    },
    lifecycle,
    setPosition: (next: { x: number; y: number }) => {
      position = next;
    },
  };
};

describe('navigation and scroll adapters', () => {
  test('[url:history.replace-push-back-forward] maps goto options and numeric traversal exactly', async () => {
    const calls: unknown[] = [];
    const deltas: number[] = [];
    const port = createSvelteNavigationPort({
      getCurrentUrl: () => new URL('http://local/current'),
      goto: (...call) => {
        calls.push(call);
        return Promise.resolve();
      },
      history: {
        go: (delta) => {
          if (delta !== undefined) {
            deltas.push(delta);
          }
        },
      },
    });
    await port.navigate({ keepFocus: true, replace: true, resetScroll: false, url: '/next' });
    port.traverse(-1);
    port.traverse(1);
    port.traverse(0);
    expect(calls).toEqual([['/next', { keepFocus: true, noScroll: true, replaceState: true }]]);
    expect(deltas).toEqual([-1, 1]);
  });

  test('[url:history.replace-push-back-forward] keeps continuous edits shallow and focused', async () => {
    const gotoCalls: unknown[] = [];
    const shallowCalls: unknown[] = [];
    const port = createSvelteNavigationPort({
      getCurrentUrl: () => new URL('http://local/current'),
      goto: (...call) => {
        gotoCalls.push(call);
        return Promise.resolve();
      },
      history: { go: () => undefined },
      shallowNavigate: (...call) => shallowCalls.push(call),
    });

    await port.navigate({ keepFocus: true, replace: false, resetScroll: false, url: '/edited' });
    await port.navigate({ keepFocus: true, replace: true, resetScroll: false, url: '/replaced' });

    expect(shallowCalls).toEqual([
      ['/edited', false],
      ['/replaced', true],
    ]);
    expect(gotoCalls).toEqual([]);
  });

  test('[url:history.replace-push-back-forward] in-memory history preserves push, replace, back and forward', async () => {
    const port = createMemoryNavigationPort('http://local/?utm=kept');
    await port.navigate({ resetScroll: false, url: '/first?utm=kept&q=first' });
    await port.navigate({ replace: true, resetScroll: false, url: '/replacement?utm=kept&q=replaced' });
    await port.navigate({ resetScroll: false, url: '/last?utm=kept&q=last' });
    port.traverse(-1);
    expect(port.currentUrl().pathname).toBe('/replacement');
    expect(port.currentUrl().searchParams.get('q')).toBe('replaced');
    port.traverse(-1);
    expect(port.currentUrl().pathname).toBe('/');
    port.traverse(1);
    expect(port.currentUrl().pathname).toBe('/replacement');
    port.traverse(1);
    expect(port.currentUrl().searchParams.get('q')).toBe('last');
    expect(port.entries().every((url) => url.searchParams.get('utm') === 'kept')).toBe(true);
    expect(port.entries().map((url) => url.pathname)).toEqual(['/', '/replacement', '/last']);
  });

  test('[url:session.drawer-identity] retains structured local/exact identity without adding URL state', async () => {
    const port = createMemoryNavigationPort('http://local/?tab=sessions');
    const drawer = createDrawerIdentityOwner();
    expect(drawer.current()).toEqual({ key: null, revision: null, target: null });
    drawer.select({ kind: 'local', rowKey: 'local-row' });
    expect(drawer.current()).toEqual({
      key: 'local-row',
      revision: null,
      target: { kind: 'local', rowKey: 'local-row' },
    });
    drawer.select({ campaignKey: 'campaign-a', kind: 'served', revision: 'revision-1', rowKey: 'same-row' });
    await port.navigate({ url: '/?tab=overview' });
    port.traverse(-1);
    expect(drawer.current()).toEqual({
      key: 'same-row',
      revision: 'revision-1',
      target: { campaignKey: 'campaign-a', kind: 'served', revision: 'revision-1', rowKey: 'same-row' },
    });
    drawer.select({ campaignKey: 'campaign-b', kind: 'served', revision: 'revision-1', rowKey: 'same-row' });
    const collisionIdentity = drawer.current();
    expect(collisionIdentity.target?.kind === 'served' && collisionIdentity.target.campaignKey).toBe('campaign-b');
    expect(['j', 'ArrowDown'].map(drawerCommandForKey)).toEqual(['next', 'next']);
    expect(['k', 'ArrowUp'].map(drawerCommandForKey)).toEqual(['previous', 'previous']);
    drawer.select({ campaignKey: 'campaign-b', kind: 'served', revision: 'revision-1', rowKey: 'next-row' });
    expect(drawer.current().target).toMatchObject({ campaignKey: 'campaign-b', rowKey: 'next-row' });
    expect(drawerCommandForKey('Escape')).toBe('close');
    expect(drawerCommandForKey('Enter')).toBeUndefined();
    expect([...port.currentUrl().searchParams.keys()]).toEqual(['tab']);
    drawer.clear();
    expect(drawer.current()).toEqual({ key: null, revision: null, target: null });
    expect(port.currentUrl().searchParams.get('tab')).toBe('sessions');
  });

  test('reports typed async navigation failures without swallowing rejection', async () => {
    const failure = new Error('synthetic navigation failure');
    const observed: unknown[] = [];
    const port = createSvelteNavigationPort({
      getCurrentUrl: () => new URL('http://local/'),
      goto: () => Promise.reject(failure),
      history: { go: () => undefined },
      onFailure: (value) => observed.push(value),
    });
    await expect(port.navigate({ url: '/next' })).rejects.toBe(failure);
    expect(observed).toEqual([{ cause: failure, intent: { url: '/next' } }]);
  });

  test('[url:history.replace-push-back-forward] classifies explicit scroll without blanket framework override', () => {
    expect(scrollDirectiveFor({ requestedReset: false, type: 'goto' })).toEqual({ kind: 'preserve' });
    expect(scrollDirectiveFor({ requestedReset: true, type: 'link' })).toEqual({ kind: 'reset' });
    expect(scrollDirectiveFor({ restoredPosition: { x: 4, y: 90 }, type: 'popstate' })).toEqual({
      kind: 'restore',
      x: 4,
      y: 90,
    });
    expect(scrollDirectiveFor({ type: 'enter' })).toEqual({ kind: 'framework' });
  });

  test('[url:history.replace-push-back-forward] applies preserve/reset after render including zero coordinates', () => {
    const fixture = scrollFixture();
    fixture.before({ fromKey: 'a', requestedReset: false, toKey: 'b', type: 'goto' });
    fixture.after('b');
    expect(fixture.applied).toEqual([]);
    fixture.flush();
    expect(fixture.applied).toEqual([{ x: 0, y: 0 }]);
    fixture.setPosition({ x: 8, y: 9 });
    fixture.before({ fromKey: 'b', requestedReset: true, toKey: 'c', type: 'link' });
    fixture.after('c');
    fixture.flush();
    expect(fixture.applied.at(-1)).toEqual({ x: 0, y: 0 });
    fixture.before({ fromKey: 'c', toKey: 'd', type: 'enter' });
    fixture.after('d');
    fixture.flush();
    expect(fixture.applied).toHaveLength(2);
  });

  test('[url:history.replace-push-back-forward] restores popstate and cancels stale scheduled work', () => {
    const fixture = scrollFixture();
    fixture.before({ fromKey: 'a', requestedReset: true, toKey: 'b', type: 'goto' });
    fixture.after('b');
    fixture.flush();
    fixture.setPosition({ x: 20, y: 30 });
    fixture.before({ fromKey: 'b', toKey: 'a', type: 'popstate' });
    fixture.after('a');
    fixture.before({ fromKey: 'a', requestedReset: false, toKey: 'c', type: 'goto' });
    expect(fixture.cancelled()).toBe(1);
    fixture.flush();
    expect(fixture.applied).toEqual([{ x: 0, y: 0 }]);
    fixture.after('c');
    fixture.flush();
    expect(fixture.applied.at(-1)).toEqual({ x: 20, y: 30 });
  });

  test('[url:history.replace-push-back-forward] lifecycle cancellation/disposal is idempotent and remountable', () => {
    const first = scrollFixture();
    first.before({ fromKey: 'a', requestedReset: false, toKey: 'b', type: 'goto' });
    first.after('b');
    first.lifecycle.cancel();
    first.flush();
    first.lifecycle.dispose();
    first.lifecycle.dispose();
    expect(first.applied).toEqual([]);
    expect(first.disposed()).toBe(2);
    const remounted = scrollFixture();
    remounted.before({ fromKey: 'b', requestedReset: true, toKey: 'c', type: 'goto' });
    remounted.after('c');
    remounted.flush();
    expect(remounted.applied).toEqual([{ x: 0, y: 0 }]);
  });
});
