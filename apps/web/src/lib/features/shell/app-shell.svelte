<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { RuntimeMode } from '../../../runtime-mode';
  import AppNavigation from './app-navigation.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from './dirty-navigation-context';
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

  // Mirrors the rail widths in `app-navigation.svelte`: 56px while it is an icon column, 216px once
  // it carries labels again at `xl`.
  const content = css({
    minW: 0,
    ml: { base: 0, md: '56px', xl: '216px' },
    pb: { base: '72px', md: 0 },
    _print: { ml: 0, pb: 0 },
  });
</script>

<AppNavigation {providerQuota} {runtimeMode} />
<div class={content} data-app-shell-content>
  {@render children()}
</div>
