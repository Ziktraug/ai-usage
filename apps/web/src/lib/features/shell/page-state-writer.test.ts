import { describe, expect, test } from 'bun:test';
import { createPageStateWriter } from './page-state-writer';

const deferredWrites = () => {
  let href = 'http://local/?tab=sessions';
  let applied: App.PageState = {};
  const writes: { href: string; settle: (failure?: unknown) => void; state: App.PageState }[] = [];
  const writer = createPageStateWriter({
    href: () => href,
    read: () => applied,
    write: (writeHref, state) =>
      new Promise((resolve, reject) => {
        writes.push({
          href: writeHref,
          settle: (failure) => {
            if (failure === undefined) {
              applied = state;
              resolve();
            } else {
              reject(failure);
            }
          },
          state,
        });
      }),
  });
  return {
    navigate: (next: string, state: App.PageState = {}) => {
      href = next;
      applied = state;
    },
    writer,
    writes,
  };
};

describe('shell page state writer', () => {
  test('composes a second annotation on the first before SvelteKit applies either', async () => {
    const history = deferredWrites();
    const seeding = history.writer.replace({ ...history.writer.current(), aiUsageNavigationKey: 'entry-2' });
    const consuming = history.writer.replace({
      ...history.writer.current(),
      aiUsageSessionWindowAnchorConsumed: true,
    });

    expect(history.writes.map(({ state }) => state)).toEqual([
      { aiUsageNavigationKey: 'entry-2' },
      { aiUsageNavigationKey: 'entry-2', aiUsageSessionWindowAnchorConsumed: true },
    ]);
    for (const write of history.writes) {
      write.settle();
    }
    await Promise.all([seeding, consuming]);
    expect(history.writer.current()).toEqual({
      aiUsageNavigationKey: 'entry-2',
      aiUsageSessionWindowAnchorConsumed: true,
    });
  });

  test('never carries a pending annotation onto another entry', async () => {
    const history = deferredWrites();
    const seeding = history.writer.replace({ aiUsageNavigationKey: 'entry-2' });
    history.navigate('http://local/?tab=overview', { aiUsageNavigationKey: 'entry-3' });

    expect(history.writer.current()).toEqual({ aiUsageNavigationKey: 'entry-3' });
    history.writes[0]?.settle();
    await seeding;
  });

  test('surfaces a rejected write and stops reporting it as current', async () => {
    const history = deferredWrites();
    const failure = new Error('route missing');
    const seeding = history.writer.replace({ aiUsageNavigationKey: 'entry-2' });
    history.writes[0]?.settle(failure);

    await expect(seeding).rejects.toBe(failure);
    expect(history.writer.current()).toEqual({});
  });
});
