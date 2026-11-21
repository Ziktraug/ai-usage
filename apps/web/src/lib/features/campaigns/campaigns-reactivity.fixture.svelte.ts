import { flushSync } from 'svelte';

/**
 * Records every value `read` yields as a component effect sees it, outside a component (tests): the
 * first value at once, then one more each time `flush` follows a change of what it read. A read
 * that is not reactive stays at its first value.
 */
export const observe = <Value>(read: () => Value) => {
  const seen: Value[] = [];
  const dispose = $effect.root(() => {
    $effect(() => {
      seen.push(read());
    });
  });
  flushSync();
  return {
    dispose,
    flush: (): void => {
      flushSync();
    },
    seen,
  };
};
