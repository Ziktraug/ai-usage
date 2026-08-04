<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { RuntimeMode } from '../../../runtime-mode';
  import AppNavigation from './app-navigation.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from './dirty-navigation-context';
  import { createSessionWindowAnchorOwner, provideSessionWindowAnchorOwner } from './session-window-anchor-context';
  import { provideSourceControlSummary } from './source-control-summary-context';

  let {
    children,
    runtimeMode,
    sourceControlSummary,
  }: { children: Snippet; runtimeMode: RuntimeMode; sourceControlSummary?: Snippet } = $props();
  provideDirtyGuardRegistry(createDirtyGuardRegistry());
  provideSourceControlSummary(() => sourceControlSummary);
  provideSessionWindowAnchorOwner(
    createSessionWindowAnchorOwner({
      replace: (state) => replaceState(page.url, state),
      state: () => page.state,
    }),
  );

  const content = css({
    minW: 0,
    ml: { base: 0, md: '216px' },
    pb: { base: '72px', md: 0 },
    _print: { ml: 0, pb: 0 },
  });
</script>

<AppNavigation {runtimeMode} />
<div class={content} data-app-shell-content>
  {@render children()}
</div>
