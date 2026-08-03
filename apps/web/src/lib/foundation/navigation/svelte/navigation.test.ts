import { describe, expect, test } from 'bun:test';
import { createMemoryNavigationPort, createSvelteNavigationPort, scrollDirectiveFor } from './navigation';

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

  test('[url:history.replace-push-back-forward] in-memory history preserves push, replace, back and forward', async () => {
    const port = createMemoryNavigationPort('http://local/');
    await port.navigate({ url: '/first' });
    await port.navigate({ replace: true, url: '/replacement' });
    await port.navigate({ url: '/last' });
    port.traverse(-1);
    expect(port.currentUrl().pathname).toBe('/replacement');
    port.traverse(-1);
    expect(port.currentUrl().pathname).toBe('/');
    port.traverse(1);
    expect(port.currentUrl().pathname).toBe('/replacement');
    expect(port.entries().map((url) => url.pathname)).toEqual(['/', '/replacement', '/last']);
  });

  test('[url:session.drawer-identity] leaves local drawer identity outside browser URLs', async () => {
    const port = createMemoryNavigationPort('http://local/?tab=sessions');
    const selectedDrawerKey = 'campaign:row-1';
    await port.navigate({ url: '/?tab=overview' });
    port.traverse(-1);
    expect(selectedDrawerKey).toBe('campaign:row-1');
    expect([...port.currentUrl().searchParams.keys()]).toEqual(['tab']);
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

  test('preserves explicit scroll, restores popstate and otherwise leaves SvelteKit in control', () => {
    expect(scrollDirectiveFor({ requestedReset: false, type: 'goto' })).toEqual({ kind: 'preserve' });
    expect(scrollDirectiveFor({ requestedReset: true, type: 'link' })).toEqual({ kind: 'reset' });
    expect(scrollDirectiveFor({ restoredPosition: { x: 4, y: 90 }, type: 'popstate' })).toEqual({
      kind: 'restore',
      x: 4,
      y: 90,
    });
    expect(scrollDirectiveFor({ type: 'enter' })).toEqual({ kind: 'framework' });
  });
});
