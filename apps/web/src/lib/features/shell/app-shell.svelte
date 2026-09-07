<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { RuntimeMode } from '../../../runtime-mode';
  import AppNavigation from './app-navigation.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from './dirty-navigation-context';
  import {
    activeReportTab,
    isActiveManagementDestination,
    reportDestinationHeading,
    shellManagementDestinations,
  } from './navigation';
  import ProductMark from './product-mark.svelte';
  import type { ProviderQuotaRailEntry } from './provider-quota-rail';
  import { createSessionWindowAnchorOwner, provideSessionWindowAnchorOwner } from './session-window-anchor-context';
  import { provideSourceControlSummary } from './source-control-summary-context';

  let {
    children,
    providerQuota = [],
    runtimeMode,
    sourceControlSummary,
  }: {
    children: Snippet;
    providerQuota?: readonly ProviderQuotaRailEntry[];
    runtimeMode: RuntimeMode;
    sourceControlSummary?: Snippet;
  } = $props();
  provideDirtyGuardRegistry(createDirtyGuardRegistry());
  provideSourceControlSummary(() => sourceControlSummary);
  provideSessionWindowAnchorOwner(
    createSessionWindowAnchorOwner({
      replace: (state) => replaceState(page.url, state),
      state: () => page.state,
    }),
  );

  const destination = $derived(
    page.url.pathname === '/'
      ? reportDestinationHeading(activeReportTab(page.url))
      : (shellManagementDestinations.find(({ href }) => isActiveManagementDestination(page.url.pathname, href))
          ?.label ?? 'Workspace'),
  );
  const topbar = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minH: '54px',
    px: { base: '20px', md: '36px' },
    gap: '16px',
    borderBottom: '1px solid token(colors.line)',
    bg: 'canvas',
    color: 'muted',
    fontSize: '11px',
    _print: { display: 'none' },
  });
  const topbarLocation = css({ display: 'flex', alignItems: 'center', gap: '10px', minW: 0 });
  const mobileMark = css({ display: { base: 'flex', md: 'none' }, color: 'accent' });
  const locationRoot = css({ display: { base: 'none', md: 'inline' } });
  const locationCurrent = css({ color: 'ink', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
  const workspaceLabel = css({ whiteSpace: 'nowrap', fontSize: '10px', letterSpacing: '0.04em' });

  // Mirrors the rail widths in `app-navigation.svelte`: 56px while it is an icon column, 216px once
  // it carries labels again at `xl`.
  const content = css({
    '--ai-usage-shell-header-height': '54px',
    minW: 0,
    ml: { base: 0, md: '56px', xl: '216px' },
    pb: { base: '72px', md: 0 },
    _print: { '--ai-usage-shell-header-height': '0px', ml: 0, pb: 0 },
  });
</script>

<AppNavigation {providerQuota} {runtimeMode} />
<div class={content} data-app-shell-content>
  <header class={topbar} data-workspace-topbar>
    <div class={topbarLocation}>
      <span class={mobileMark}><ProductMark size={18} /></span>
      <span class={locationRoot}>ai-usage</span>
      <span aria-hidden="true" class={locationRoot}>/</span>
      <span class={locationCurrent}>{destination}</span>
    </div>
    <span class={workspaceLabel}>Local workspace</span>
  </header>
  {@render children()}
</div>
