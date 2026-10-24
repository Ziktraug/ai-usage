import { getContext, setContext } from 'svelte';

/**
 * The shell annotates the current history entry from more than one place: the navigation rail
 * seeds its history key and the session table marks its window anchor consumed, often in the same
 * task. SvelteKit 3's `replaceState` applies a state asynchronously, so a second annotation that
 * read `page.state` before the first one landed would write the entry without it. Every
 * annotation goes through this writer, which composes on the latest requested state of the entry
 * until SvelteKit has applied it.
 */
export interface PageStateWriter {
  readonly current: () => App.PageState;
  readonly replace: (state: App.PageState) => Promise<void>;
}

export const createPageStateWriter = (port: {
  readonly href: () => string;
  readonly read: () => App.PageState;
  readonly write: (href: string, state: App.PageState) => Promise<void>;
}): PageStateWriter => {
  let pending: { readonly href: string; readonly state: App.PageState } | undefined;
  return {
    current: () => (pending !== undefined && pending.href === port.href() ? pending.state : port.read()),
    replace: async (state) => {
      const write = { href: port.href(), state };
      pending = write;
      try {
        await port.write(write.href, state);
      } finally {
        if (pending === write) {
          pending = undefined;
        }
      }
    },
  };
};

const pageStateWriterContextKey = Symbol('ai-usage-page-state-writer');

export const providePageStateWriter = (writer: PageStateWriter): void => {
  setContext(pageStateWriterContextKey, writer);
};

export const usePageStateWriter = (): PageStateWriter => {
  const writer = getContext<PageStateWriter | undefined>(pageStateWriterContextKey);
  if (!writer) {
    throw new Error('Page state writer context is unavailable');
  }
  return writer;
};
