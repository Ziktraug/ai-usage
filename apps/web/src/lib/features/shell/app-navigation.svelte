<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { onMount, tick } from 'svelte';
  import { afterNavigate, beforeNavigate, goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { RuntimeMode } from '../../../runtime-mode';
  import {
    browserSessionSurfaceModeEnvironment,
    createSessionSurfaceModeController,
    type SessionSurfaceMode,
  } from '../../../session-surface-mode';
  import {
    createDirtyNavigationController,
    type DirtyBeforeNavigate,
    type DirtyNavigationController,
    installDirtyNavigationBridge,
  } from '../../foundation/navigation/svelte/dirty-navigation';
  import {
    createSvelteNavigationPort,
    installScrollLifecycle,
    type ScrollLifecycle,
    type ScrollLifecycleEvent,
  } from '../../foundation/navigation/svelte/navigation';
  import { useDirtyGuardRegistry } from './dirty-navigation-context';
  import DiscardNavigationDialog from './discard-navigation-dialog.svelte';
  import ManageButton from './manage-button.svelte';
  import {
    activeReportTab,
    ensureHistoryEntryKey,
    isActiveManagementDestination,
    navigationTypeForScroll,
    reportDestinationUrl,
    shellManagementDestinations,
    shouldPreserveReportScroll,
  } from './navigation';
  import NavigationLink from './navigation-link.svelte';
  import { useSessionWindowAnchorOwner } from './session-window-anchor-context';
  import ThemeToggle from './theme-toggle.svelte';

  let { runtimeMode }: { runtimeMode: RuntimeMode } = $props();

  const desktopRail = css({
    position: 'fixed',
    insetBlock: 0,
    insetInlineStart: 0,
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    w: '216px',
    p: '24px 16px',
    borderRight: '1px solid token(colors.line)',
    bg: 'surface',
    color: 'ink',
    _print: { display: 'none' },
  });
  const productName = css({
    px: '10px',
    pb: '24px',
    color: 'accent',
    fontSize: '15px',
    fontWeight: 750,
    letterSpacing: '-0.01em',
  });
  const navigationGroup = css({ display: 'grid', gap: '6px', mb: '22px' });
  const navigationGroupLabel = css({
    px: '10px',
    pb: '3px',
    color: 'muted',
    fontSize: '10px',
    fontWeight: 750,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  });
  const navigationLink = css({
    display: 'flex',
    alignItems: 'center',
    minH: '38px',
    px: '10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: 'md',
    fontSize: '13px',
    fontWeight: 650,
    textDecoration: 'none',
    transition: 'background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease',
    _hover: { bg: 'surfaceMuted', color: 'ink' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const navigationLinkInactive = css({ borderColor: 'transparent', color: 'muted' });
  const navigationLinkActive = css({ borderColor: 'lineStrong', bg: 'accentSoft', color: 'ink' });
  const railFooter = css({
    mt: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  });
  const mobileNavigation = css({
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    zIndex: 50,
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    minH: '64px',
    px: '8px',
    pb: 'max(6px, env(safe-area-inset-bottom))',
    borderTop: '1px solid token(colors.line)',
    bg: 'surface',
    _print: { display: 'none' },
  });
  const mobileNavigationReportOnly = css({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
  const mobileLink = css({
    display: 'grid',
    placeItems: 'center',
    minW: 0,
    minH: '52px',
    px: '5px',
    border: 0,
    bg: 'transparent',
    fontFamily: 'sans',
    fontSize: '11px',
    fontWeight: 700,
    textDecoration: 'none',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
  const mobileLinkInactive = css({ color: 'muted' });
  const mobileLinkActive = css({ color: 'accent' });
  const managePopover = css({
    position: 'fixed',
    right: '10px',
    bottom: '70px',
    zIndex: 51,
    display: 'grid',
    gap: '6px',
    minW: '190px',
    p: '10px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: '0 16px 36px rgba(0, 0, 0, 0.24)',
  });

  const managePopoverId = 'app-manage-navigation';
  const reportTabs = [
    { label: 'Overview', tab: 'overview' },
    { label: 'Sessions', tab: 'sessions' },
    { label: 'Breakdown', tab: 'breakdown' },
  ] as const;
  const showManage = $derived(runtimeMode !== 'demo');
  const dirtyRegistry = useDirtyGuardRegistry();
  const sessionWindowAnchorOwner = useSessionWindowAnchorOwner();

  let surfaceMode = $state<SessionSurfaceMode>('pending');
  let manageOpen = $state(false);
  let manageButton = $state<HTMLButtonElement>();
  let navigationFailure = $state(false);
  let blockedNavigation = $state(false);
  let dirtyController: DirtyNavigationController | undefined;
  let currentEntryKey = '';
  let historyCursor = 0;
  let pendingEntryKey = '';
  let pendingHistoryCursor = 0;
  let entrySequence = 0;
  const keysByHistoryCursor = new Map<number, string>();
  let scrollLifecycle: ScrollLifecycle | undefined;
  let navigationHydrated = $state(false);
  const beforeScrollListeners = new Set<(event: ScrollLifecycleEvent) => void>();
  const afterScrollListeners = new Set<(event: Pick<ScrollLifecycleEvent, 'toKey'>) => void>();
  const beforeDirtyListeners = new Set<(event: DirtyBeforeNavigate) => void>();

  const createEntryKey = (): string => `web-${Date.now().toString(36)}-${(++entrySequence).toString(36)}`;
  const seedCurrentEntry = (preferredKey?: string): string => {
    const currentState = page.state;
    if (preferredKey && currentState.aiUsageNavigationKey !== preferredKey) {
      replaceState(page.url, { ...currentState, aiUsageNavigationKey: preferredKey });
      return preferredKey;
    }
    const result = ensureHistoryEntryKey(currentState, () => preferredKey ?? createEntryKey());
    if (result.state !== currentState) {
      replaceState(page.url, result.state);
    }
    return result.key;
  };

  beforeNavigate((navigation) => {
    const fromKey = currentEntryKey || seedCurrentEntry();
    const isHistoryTraversal = navigation.type === 'popstate' && navigation.delta !== undefined;
    const preserveReportScroll = shouldPreserveReportScroll(navigation.from?.url ?? null, navigation.to?.url ?? null);
    sessionWindowAnchorOwner.beginNavigation(preserveReportScroll);
    pendingHistoryCursor = isHistoryTraversal ? historyCursor + navigation.delta : historyCursor + 1;
    pendingEntryKey = isHistoryTraversal
      ? (keysByHistoryCursor.get(pendingHistoryCursor) ?? createEntryKey())
      : createEntryKey();
    const scrollEvent: ScrollLifecycleEvent = {
      fromKey,
      ...(preserveReportScroll ? { requestedReset: false } : {}),
      toKey: pendingEntryKey,
      type: navigationTypeForScroll(navigation.type),
    };
    for (const listener of beforeScrollListeners) {
      listener(scrollEvent);
    }
    const dirtyEvent: DirtyBeforeNavigate = {
      cancel: navigation.cancel,
      ...(navigation.delta === undefined ? {} : { delta: navigation.delta }),
      to: navigation.to ? { url: navigation.to.url } : null,
      type: navigation.type,
      willUnload: navigation.willUnload,
    };
    for (const listener of beforeDirtyListeners) {
      listener(dirtyEvent);
    }
  });

  afterNavigate(() => {
    queueMicrotask(() => {
      currentEntryKey = seedCurrentEntry(pendingEntryKey || undefined);
      if (pendingEntryKey) {
        historyCursor = pendingHistoryCursor;
      }
      keysByHistoryCursor.set(historyCursor, currentEntryKey);
      sessionWindowAnchorOwner.settleNavigation();
      pendingEntryKey = '';
      for (const listener of afterScrollListeners) {
        listener({ toKey: currentEntryKey });
      }
    });
  });

  const closeManageForNavigation = (_href: string): void => {
    manageOpen = false;
  };

  $effect(() => closeManageForNavigation(page.url.href));

  $effect(() => {
    if (!manageOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      manageOpen = false;
      tick()
        .then(() => manageButton?.focus())
        .catch(() => {
          navigationFailure = true;
        });
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  });

  onMount(() => {
    const surfaceController = createSessionSurfaceModeController(browserSessionSurfaceModeEnvironment());
    const stopSurface = surfaceController.start((mode) => {
      surfaceMode = mode;
    });
    scrollLifecycle = installScrollLifecycle({
      afterNavigate: (listener) => {
        afterScrollListeners.add(listener);
        return () => afterScrollListeners.delete(listener);
      },
      afterRender: (callback) => {
        let cancelled = false;
        let frame = 0;
        const schedule = async (): Promise<void> => {
          await tick();
          if (cancelled) {
            return;
          }
          frame = requestAnimationFrame(() => {
            if (!cancelled) {
              callback();
            }
          });
        };
        schedule().catch(() => {
          navigationFailure = true;
        });
        return () => {
          cancelled = true;
          cancelAnimationFrame(frame);
        };
      },
      beforeNavigate: (listener) => {
        beforeScrollListeners.add(listener);
        return () => beforeScrollListeners.delete(listener);
      },
      position: () => ({ x: window.scrollX, y: window.scrollY }),
      scrollTo: ({ x, y }) => window.scrollTo(x, y),
    });
    const port = createSvelteNavigationPort({
      getCurrentUrl: () => page.url,
      goto,
      history: window.history,
      onFailure: () => {
        sessionWindowAnchorOwner.cancelNavigation();
        navigationFailure = true;
      },
    });
    const controller = createDirtyNavigationController({
      discardChanges: dirtyRegistry.discard,
      focus: dirtyRegistry.focus,
      isDirty: dirtyRegistry.dirty.getState,
      onFailure: () => {
        navigationFailure = true;
      },
      replay: async (target) => {
        if (target.kind === 'history') {
          port.traverse(target.delta);
          return;
        }
        await port.navigate({
          ...(target.replace === undefined ? {} : { replace: target.replace }),
          resetScroll: false,
          url: target.url,
        });
      },
    });
    dirtyController = controller;
    const stopDirtyBridge = installDirtyNavigationBridge({
      beforeNavigate: (listener) => {
        beforeDirtyListeners.add(listener);
        return () => beforeDirtyListeners.delete(listener);
      },
      controller: {
        ...controller,
        handle: (navigation) => {
          const blocked = controller.handle(navigation);
          if (blocked) {
            scrollLifecycle?.cancel();
            sessionWindowAnchorOwner.cancelNavigation();
            blockedNavigation = controller.pending() !== undefined;
          }
          return blocked;
        },
      },
      dirty: dirtyRegistry.dirty,
      window,
    });
    navigationHydrated = true;
    return () => {
      stopDirtyBridge();
      scrollLifecycle?.dispose();
      scrollLifecycle = undefined;
      sessionWindowAnchorOwner.cancelNavigation();
      navigationHydrated = false;
      dirtyController = undefined;
      stopSurface();
    };
  });

  const keepBlockedNavigation = (): void => {
    blockedNavigation = false;
    dirtyController?.keep();
  };

  const discardBlockedNavigation = async (): Promise<void> => {
    try {
      if (await dirtyController?.discard()) {
        blockedNavigation = false;
      }
    } catch {
      navigationFailure = true;
    }
  };

  const linkClass = (active: boolean, mobile = false): string => {
    if (mobile) {
      return cx(mobileLink, active ? mobileLinkActive : mobileLinkInactive);
    }
    return cx(navigationLink, active ? navigationLinkActive : navigationLinkInactive);
  };
</script>

{#if navigationFailure}
  <p aria-live="polite" class={css({ srOnly: true })}>Navigation failed. Try again.</p>
{/if}

<DiscardNavigationDialog onDiscard={discardBlockedNavigation} onKeep={keepBlockedNavigation} open={blockedNavigation} />

{#if surfaceMode === 'desktop'}
  <aside
    aria-label="Application navigation"
    class={desktopRail}
    data-app-navigation="desktop"
    data-hydrated={navigationHydrated ? 'true' : 'false'}
  >
    <div class={productName}>ai-usage</div>
    <nav aria-label="Report views" class={navigationGroup}>
      <div class={navigationGroupLabel}>Report</div>
      {#each reportTabs as destination (destination.tab)}
        <NavigationLink
          active={page.url.pathname === '/' && activeReportTab(page.url) === destination.tab}
          class={linkClass(page.url.pathname === '/' && activeReportTab(page.url) === destination.tab)}
          href={reportDestinationUrl(page.url, destination.tab).href}
          label={destination.label}
          preserveScroll
        />
      {/each}
    </nav>
    {#if showManage}
      <nav aria-label="Manage destinations" class={navigationGroup}>
        <div class={navigationGroupLabel}>Manage</div>
        {#each shellManagementDestinations as destination (destination.href)}
          <NavigationLink
            active={isActiveManagementDestination(page.url.pathname, destination.href)}
            class={linkClass(isActiveManagementDestination(page.url.pathname, destination.href))}
            href={destination.href}
            label={destination.label}
          />
        {/each}
      </nav>
    {/if}
    <div class={railFooter}><span class={navigationGroupLabel}>Theme</span><ThemeToggle /></div>
  </aside>
{:else if surfaceMode === 'mobile'}
  <nav
    aria-label="Report views"
    class={cx(mobileNavigation, !showManage && mobileNavigationReportOnly)}
    data-app-navigation="mobile"
    data-hydrated={navigationHydrated ? 'true' : 'false'}
  >
    {#each reportTabs as destination (destination.tab)}
      <NavigationLink
        active={page.url.pathname === '/' && activeReportTab(page.url) === destination.tab}
        class={linkClass(page.url.pathname === '/' && activeReportTab(page.url) === destination.tab, true)}
        href={reportDestinationUrl(page.url, destination.tab).href}
        label={destination.label}
        preserveScroll
      />
    {/each}
    {#if showManage}
      <ManageButton
        class={cx(
          mobileLink,
          shellManagementDestinations.some(({ href }) => isActiveManagementDestination(page.url.pathname, href))
            ? mobileLinkActive
            : mobileLinkInactive,
        )}
        controls={managePopoverId}
        onToggle={() => { manageOpen = !manageOpen; }}
        open={manageOpen}
        bind:element={manageButton}
      />
    {/if}
  </nav>
  {#if showManage && manageOpen}
    <nav aria-label="Manage destinations" class={managePopover} id={managePopoverId}>
      {#each shellManagementDestinations as destination (destination.href)}
        <NavigationLink
          active={isActiveManagementDestination(page.url.pathname, destination.href)}
          class={linkClass(isActiveManagementDestination(page.url.pathname, destination.href))}
          href={destination.href}
          label={destination.label}
        />
      {/each}
      <ThemeToggle />
    </nav>
  {/if}
{/if}
