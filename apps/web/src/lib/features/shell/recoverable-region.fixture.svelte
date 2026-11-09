<script lang="ts">
  import { untrack } from 'svelte';
  import RecoverableRegion from './recoverable-region.svelte';
  import ThrowingRegion from './throwing-region.fixture.svelte';

  let { initialFailure = true, holdRetry = false }: { initialFailure?: boolean; holdRetry?: boolean } = $props();
  let fail = $state(untrack(() => initialFailure));
  let refetches = $state(0);
  let release: ((recovered: boolean) => void) | undefined;
  /** Fails the region without moving focus, unlike the in-region "Break region" button. */
  export const breakRegion = (): void => {
    fail = true;
  };
  const releaseHeldRetry = (recovered: boolean): void => {
    if (!release) {
      throw new Error('No held retry to release');
    }
    release(recovered);
    release = undefined;
  };
  /** Completes a retry held by `holdRetry` so the test can move focus while recovery is pending. */
  export const releaseRetry = (): void => releaseHeldRetry(true);
  /** Completes a held retry whose refetch succeeded while the child still fails to render. */
  export const releaseRetryFailing = (): void => releaseHeldRetry(false);
  const retry = (): Promise<void> => {
    refetches += 1;
    if (!holdRetry) {
      fail = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      release = (recovered) => {
        fail = !recovered;
        resolve();
      };
    });
  };
</script>
<div data-recovery-fixture>
  <p>Independent sibling remains usable</p>
  <label>
    Sibling filter
    <input data-sibling-filter type="text">
  </label>
  <RecoverableRegion label="Fixture panel" onRetry={retry}>
    <ThrowingRegion {fail} />
  </RecoverableRegion>
  <p data-region-refetches>{refetches}</p>
</div>
