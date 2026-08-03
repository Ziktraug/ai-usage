<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';
  import type { RuntimeMode } from '../../../runtime-mode';
  import AppNavigation from './app-navigation.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from './dirty-navigation-context';

  let { children, runtimeMode }: { children: Snippet; runtimeMode: RuntimeMode } = $props();
  provideDirtyGuardRegistry(createDirtyGuardRegistry());

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
