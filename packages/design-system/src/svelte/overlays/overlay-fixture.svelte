<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import CellWithProvenance from './cell-with-provenance.svelte';
  import Drawer from './drawer.svelte';
  import Popover from './popover.svelte';
  import Tooltip from './tooltip.svelte';

  let drawerOpen = $state(false);
  let persistentDrawerOpen = $state(false);
  let drawerTrigger: HTMLButtonElement | null = $state(null);
  let drawerInitialFocus: HTMLButtonElement | null = $state(null);
  let persistentDrawerTrigger: HTMLButtonElement | null = $state(null);
  const desktopViewport = new MediaQuery('(min-width: 48rem)', false);
  const mobileDrawer = $derived(!desktopViewport.current);

  const facts = [
    {
      description: 'The provider omitted part of this interval.',
      label: 'Partial data',
      severity: 'warning',
    },
  ] as const;
</script>

<section aria-label="Overlay component fixture" data-drawer-open={drawerOpen} data-mobile-drawer={mobileDrawer}>
  <button type="button">Outside overlay target</button>
  <button onclick={() => (drawerOpen = true)} type="button" bind:this={drawerTrigger}>Open drawer</button>

  <Drawer
    closeOnInteractOutside={mobileDrawer}
    contentAriaLabel="Fixture drawer"
    finalFocusEl={() => drawerTrigger}
    initialFocusEl={() => (mobileDrawer ? drawerInitialFocus : drawerTrigger)}
    modal={mobileDrawer}
    onOpenChange={(open) => (drawerOpen = open)}
    open={drawerOpen}
    preventScroll={mobileDrawer}
    trapFocus={mobileDrawer}
  >
    <h2>Drawer fixture</h2>
    <button onclick={() => (drawerOpen = false)} type="button" bind:this={drawerInitialFocus}>Close drawer</button>
  </Drawer>

  <button onclick={() => (persistentDrawerOpen = true)} type="button" bind:this={persistentDrawerTrigger}>
    Open persistent drawer
  </button>

  <Drawer
    closeOnInteractOutside={false}
    contentAriaLabel="Persistent fixture drawer"
    finalFocusEl={() => persistentDrawerTrigger}
    modal={false}
    onOpenChange={(open) => (persistentDrawerOpen = open)}
    open={persistentDrawerOpen}
    trapFocus={false}
  >
    <h2>Persistent drawer fixture</h2>
    <button onclick={() => (persistentDrawerOpen = false)} type="button">Close persistent drawer</button>
  </Drawer>

  <Popover contentAriaLabel="Fixture popover actions" triggerAriaLabel="Open fixture popover">
    {#snippet trigger()}
      More
    {/snippet}
    <p>Popover fixture content</p>
    <button type="button">Popover fixture action</button>
    <button type="button">Popover fixture secondary action</button>
  </Popover>

  <Tooltip content="Tooltip fixture content">
    {#snippet trigger(_triggerProps)}
      <button {..._triggerProps} type="button">Tooltip target</button>
    {/snippet}
  </Tooltip>

  <CellWithProvenance {facts}>42 minutes</CellWithProvenance>
</section>
