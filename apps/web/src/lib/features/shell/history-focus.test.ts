import { describe, expect, test } from 'bun:test';
import { createHistoryFocusReset } from './history-focus';

const URL_AFTER_BACK = new URL('http://local/campaigns');

const fakeDocument = (initiallyFocused: string | undefined) => {
  let focused = initiallyFocused;
  const events: string[] = [];
  const reset = createHistoryFocusReset({
    blur: () => {
      if (focused !== undefined) {
        events.push(`blur ${focused}`);
        focused = undefined;
      }
    },
    focused: () => focused,
    resetFocus: (url) => {
      events.push(`reset ${url.pathname}`);
      focused = undefined;
    },
  });
  return {
    events,
    focus: (element: string) => {
      focused = element;
    },
    focused: () => focused,
    reset,
  };
};

describe('history focus reset', () => {
  test('resets focus after Back as SvelteKit 2 did, whatever the entry was created with', () => {
    const document = fakeDocument('campaign card');

    document.reset.beforeUpdate('popstate');
    document.reset.afterUpdate('popstate', URL_AFTER_BACK);

    expect(document.events).toEqual(['blur campaign card', 'reset /campaigns']);
    expect(document.focused()).toBeUndefined();
  });

  test('leaves focus a component claimed while the traversal rendered', () => {
    const document = fakeDocument('open session');

    document.reset.beforeUpdate('popstate');
    document.focus('drawer trigger');
    document.reset.afterUpdate('popstate', URL_AFTER_BACK);

    expect(document.events).toEqual(['blur open session']);
    expect(document.focused()).toBe('drawer trigger');
  });

  test('never touches focus for a navigation that is not a history traversal', () => {
    const document = fakeDocument('models tab');

    document.reset.beforeUpdate('goto');
    document.reset.afterUpdate('goto', URL_AFTER_BACK);

    expect(document.events).toEqual([]);
    expect(document.focused()).toBe('models tab');
  });

  test('does not carry a superseded traversal into the next navigation', () => {
    const document = fakeDocument('apply filters');

    document.reset.beforeUpdate('popstate');
    document.focus('search field');
    // The traversal was superseded before it rendered; a later push keeps its focus.
    document.reset.beforeUpdate('link');
    document.reset.afterUpdate('link', URL_AFTER_BACK);

    expect(document.events).toEqual(['blur apply filters']);
    expect(document.focused()).toBe('search field');
  });
});
