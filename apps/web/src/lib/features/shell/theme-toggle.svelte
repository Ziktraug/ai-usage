<script lang="ts">
  import { Toggle, themeToggleButton } from '@ai-usage/design-system/svelte';
  import { onMount } from 'svelte';
  import { browserThemePort, createThemeController, type Theme } from './theme';

  let mounted = $state(false);
  let theme = $state<Theme>('light');
  let controller: ReturnType<typeof createThemeController> | undefined;

  onMount(() => {
    controller = createThemeController(browserThemePort());
    const stop = controller.start((next) => {
      theme = next;
      mounted = true;
    });
    return () => {
      stop();
      controller = undefined;
    };
  });

  const onPressedChange = (pressed: boolean): void => {
    const next = pressed ? 'dark' : 'light';
    controller?.set(next);
    theme = next;
  };
</script>

{#if mounted}
  {#key theme}
    <Toggle
      ariaLabel={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      class={themeToggleButton}
      {onPressedChange}
      pressed={theme === 'dark'}
    >
      {#if theme === 'dark'}
        <svg aria-hidden="true" fill="currentColor" height="15" viewBox="0 0 24 24" width="15">
          <path d="M20.6 14.4A8.7 8.7 0 0 1 9.6 3.4a8.7 8.7 0 1 0 11 11Z"></path>
        </svg>
      {:else}
        <svg
          aria-hidden="true"
          fill="none"
          height="15"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="2"
          viewBox="0 0 24 24"
          width="15"
        >
          <circle cx="12" cy="12" r="4.4"></circle>
          <path
            d="M12 2.2v2.6M12 19.2v2.6M21.8 12h-2.6M4.8 12H2.2M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8M18.9 18.9l-1.8-1.8M6.9 6.9 5.1 5.1"
          ></path>
        </svg>
      {/if}
    </Toggle>
  {/key}
{:else}
  <span aria-hidden="true" class={themeToggleButton} style="visibility: hidden"></span>
{/if}
