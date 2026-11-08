<script lang="ts">
  import { untrack } from 'svelte';
  import RecoverableRegion from './recoverable-region.svelte';
  import ThrowingRegion from './throwing-region.fixture.svelte';

  let { initialFailure = true }: { initialFailure?: boolean } = $props();
  let fail = $state(untrack(() => initialFailure));
  let refetches = $state(0);
</script>
<div data-recovery-fixture>
  <p>Independent sibling remains usable</p>
  <RecoverableRegion
    label="Fixture panel"
    onRetry={() => {
      refetches += 1;
      fail = false;
      return Promise.resolve();
    }}
  >
    <ThrowingRegion {fail} />
  </RecoverableRegion>
  <p data-region-refetches>{refetches}</p>
</div>
