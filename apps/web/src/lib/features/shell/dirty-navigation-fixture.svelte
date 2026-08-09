<script lang="ts">
  import { onMount } from 'svelte';
  import type { StateListener } from '../../foundation/subscription';
  import { useDirtyGuardRegistry } from './dirty-navigation-context';

  const savedDraft = 'Saved synthetic draft';
  const registry = useDirtyGuardRegistry();
  const listeners = new Set<StateListener<boolean>>();
  let draft = $state(savedDraft);
  let dirty = false;
  let editor = $state<HTMLTextAreaElement>();

  const publish = (next: boolean): void => {
    if (dirty === next) {
      return;
    }
    dirty = next;
    for (const listener of listeners) {
      listener(dirty);
    }
  };

  onMount(() =>
    registry.register({
      dirty: {
        getState: () => dirty,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      discard: () => {
        draft = savedDraft;
        publish(false);
      },
      focus: () => editor?.focus(),
    }),
  );
</script>

<label for="synthetic-skill-editor">Synthetic SKILL.md draft</label>
<textarea
  id="synthetic-skill-editor"
  oninput={() => publish(draft !== savedDraft)}
  bind:this={editor}
  bind:value={draft}
></textarea>
