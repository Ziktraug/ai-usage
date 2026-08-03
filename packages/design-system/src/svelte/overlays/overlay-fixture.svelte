<script lang="ts">
  import CellWithProvenance from './cell-with-provenance.svelte';
  import Drawer from './drawer.svelte';
  import Popover from './popover.svelte';
  import Tooltip from './tooltip.svelte';

  let drawerOpen = $state(false);
  let drawerTrigger: HTMLButtonElement | null = $state(null);
  let drawerInitialFocus: HTMLButtonElement | null = $state(null);

  const facts = [
    {
      description: 'The provider omitted part of this interval.',
      label: 'Partial data',
      severity: 'warning',
    },
  ] as const;
</script>

<section aria-label="Overlay component fixture">
  <button onclick={() => (drawerOpen = true)} type="button" bind:this={drawerTrigger}>Open drawer</button>

  <Drawer
    contentAriaLabel="Fixture drawer"
    finalFocusEl={() => drawerTrigger}
    initialFocusEl={() => drawerInitialFocus}
    onOpenChange={(open) => (drawerOpen = open)}
    open={drawerOpen}
  >
    <h2>Drawer fixture</h2>
    <button onclick={() => (drawerOpen = false)} type="button" bind:this={drawerInitialFocus}>Close drawer</button>
  </Drawer>

  <Popover triggerAriaLabel="Open fixture popover">
    {#snippet trigger()}
      More
    {/snippet}
    <p>Popover fixture content</p>
  </Popover>

  <Tooltip content="Tooltip fixture content">
    <button type="button">Tooltip target</button>
  </Tooltip>

  <CellWithProvenance {facts}>42 minutes</CellWithProvenance>
</section>
