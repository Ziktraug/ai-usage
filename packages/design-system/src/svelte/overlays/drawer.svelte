<script lang="ts">
  import { Drawer, type DrawerOpenChangeDetails } from '@ark-ui/svelte/drawer';
  import { Portal } from '@ark-ui/svelte/portal';
  import { type Snippet, tick, untrack } from 'svelte';
  import { drawerClass } from './styles';

  interface Props {
    children: Snippet;
    closeOnInteractOutside?: boolean;
    contentAriaLabel: string;
    contentClass?: string;
    finalFocusEl?: () => HTMLElement | null;
    initialFocusEl?: () => HTMLElement | null;
    modal?: boolean;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    preventScroll?: boolean;
    trapFocus?: boolean;
  }

  let {
    children,
    closeOnInteractOutside,
    contentAriaLabel,
    contentClass,
    finalFocusEl,
    initialFocusEl,
    modal,
    onOpenChange,
    open,
    preventScroll,
    trapFocus,
  }: Props = $props();

  let machineOpen = $state(untrack(() => open));
  let previousBehaviorSignature: string | undefined;
  let previousRequestedOpen = untrack(() => open);
  let pendingExternalClose = false;
  let pendingFinalFocusElement: HTMLElement | null = null;
  let pendingMachineTransition = Promise.resolve();
  let reentryId = 0;
  let suppressMachineOpenChange = false;

  const behaviorSignature = $derived(`${closeOnInteractOutside}:${modal}:${preventScroll}:${trapFocus}`);

  const reenterMachine = async (currentReentryId: number): Promise<void> => {
    suppressMachineOpenChange = true;
    machineOpen = false;
    await tick();

    if (currentReentryId !== reentryId || !open) {
      if (currentReentryId === reentryId) {
        suppressMachineOpenChange = false;
      }
      return;
    }

    machineOpen = true;
    await tick();
    if (currentReentryId === reentryId) {
      suppressMachineOpenChange = false;
    }
  };

  const closeMachine = async (currentReentryId: number): Promise<void> => {
    suppressMachineOpenChange = true;
    machineOpen = false;
    await tick();
    if (currentReentryId === reentryId) {
      suppressMachineOpenChange = false;
    }
  };

  const settleMachineTransition = async (
    previousTransition: Promise<void>,
    transition: () => Promise<void>,
    currentReentryId: number,
  ): Promise<void> => {
    try {
      await previousTransition;
      await transition();
    } catch {
      if (currentReentryId === reentryId) {
        suppressMachineOpenChange = false;
        machineOpen = open;
      }
    }
  };

  const scheduleMachineTransition = (transition: () => Promise<void>, currentReentryId: number): void => {
    pendingMachineTransition = settleMachineTransition(pendingMachineTransition, transition, currentReentryId);
  };

  const handleOpenChange = (details: DrawerOpenChangeDetails): void => {
    if (suppressMachineOpenChange) {
      return;
    }

    if (details.open) {
      pendingExternalClose = false;
      pendingFinalFocusElement = null;
      onOpenChange(true);
      return;
    }

    pendingExternalClose = true;
    pendingFinalFocusElement = finalFocusEl?.() ?? null;
  };

  const handleExitComplete = async (): Promise<void> => {
    if (!(pendingExternalClose || pendingFinalFocusElement)) {
      return;
    }

    const notifyExternalClose = pendingExternalClose;
    pendingExternalClose = false;
    const finalFocusElement = pendingFinalFocusElement;
    pendingFinalFocusElement = null;
    await tick();
    if (notifyExternalClose) {
      onOpenChange(false);
    }
    if (finalFocusElement?.isConnected) {
      finalFocusElement.focus({ preventScroll: true });
    }
  };

  $effect(() => {
    const currentRequestedOpen = open;
    if (previousRequestedOpen === currentRequestedOpen) {
      return;
    }

    previousRequestedOpen = currentRequestedOpen;
    reentryId += 1;
    const currentReentryId = reentryId;
    if (currentRequestedOpen) {
      scheduleMachineTransition(() => reenterMachine(currentReentryId), currentReentryId);
      return;
    }
    if (machineOpen) {
      pendingFinalFocusElement = finalFocusEl?.() ?? null;
    }
    scheduleMachineTransition(() => closeMachine(currentReentryId), currentReentryId);
  });

  $effect(() => {
    const currentBehaviorSignature = behaviorSignature;
    const behaviorChanged =
      previousBehaviorSignature !== undefined && previousBehaviorSignature !== currentBehaviorSignature;
    previousBehaviorSignature = currentBehaviorSignature;
    if (!(behaviorChanged && open)) {
      return;
    }

    reentryId += 1;
    const currentReentryId = reentryId;
    scheduleMachineTransition(() => reenterMachine(currentReentryId), currentReentryId);
  });
</script>

<Drawer.Root
  {closeOnInteractOutside}
  {finalFocusEl}
  {initialFocusEl}
  {modal}
  onExitComplete={handleExitComplete}
  onOpenChange={handleOpenChange}
  {preventScroll}
  {trapFocus}
  bind:open={machineOpen}
>
  <Portal>
    {#if modal !== false}
      <Drawer.Backdrop />
    {/if}
    <Drawer.Positioner>
      <Drawer.Content aria-label={contentAriaLabel} class={contentClass ?? drawerClass}>
        {@render children()}
      </Drawer.Content>
    </Drawer.Positioner>
  </Portal>
</Drawer.Root>

<style>
  :global([data-scope="drawer"][data-part="backdrop"]) {
    position: fixed;
    inset: 0;
    z-index: 59;
    pointer-events: auto;
    background: rgba(0, 0, 0, 0.48);
  }

  @media (prefers-reduced-motion: reduce) {
    :global([data-scope="drawer"][data-part="content"]) {
      animation: none !important;
    }
  }
</style>
