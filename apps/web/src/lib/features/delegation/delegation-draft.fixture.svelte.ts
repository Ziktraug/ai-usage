import { flushSync } from 'svelte';
import { createDraftSync } from './delegation-draft.svelte';
import type { EntryIdentity } from './delegation-rebase';

export interface DraftSettings<Draft> {
  readonly draft: Draft;
  readonly revision: string;
}

/**
 * One form's draft sync beside a settings source, outside a component (tests). `from` clones the
 * source's draft on every read, as the forms build a fresh draft from the settings view.
 */
export const mountDraftSync = <Draft>(initial: DraftSettings<Draft>, identity?: EntryIdentity) => {
  let settings = $state.raw(initial);
  let sync: ReturnType<typeof createDraftSync<Draft>> | undefined;
  const dispose = $effect.root(() => {
    sync = createDraftSync<Draft>({
      from: () => structuredClone(settings.draft),
      ...(identity === undefined ? {} : { identity }),
      revision: () => settings.revision,
    });
  });
  flushSync();
  if (sync === undefined) {
    throw new Error('The draft sync was not created.');
  }
  return {
    dispose,
    /** A refetch landed: the settings now say `next`. */
    publish(next: DraftSettings<Draft>): void {
      settings = next;
      flushSync();
    },
    sync,
  };
};
