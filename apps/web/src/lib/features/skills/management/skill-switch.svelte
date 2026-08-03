<script lang="ts">
  import { switchButton } from './styles';

  let {
    disabled,
    enabled,
    name,
    onToggle,
    pending,
    showTitle = false,
  }: {
    disabled: boolean;
    enabled: boolean;
    name: string;
    onToggle: () => void;
    pending: boolean;
    showTitle?: boolean;
  } = $props();

  const busyAttributes = $derived({ 'aria-busy': pending ? 'true' : 'false' } as const);
</script>

{#if enabled}
  <button
    {...busyAttributes}
    aria-checked="true"
    aria-label={`Disable ${name}`}
    class={switchButton}
    data-pending={pending ? 'true' : undefined}
    {disabled}
    onclick={onToggle}
    role="switch"
    title={showTitle ? 'Disable' : undefined}
    type="button"
  ></button>
{:else}
  <button
    {...busyAttributes}
    aria-checked="false"
    aria-label={`Enable ${name}`}
    class={switchButton}
    data-pending={pending ? 'true' : undefined}
    {disabled}
    onclick={onToggle}
    role="switch"
    title={showTitle ? 'Enable' : undefined}
    type="button"
  ></button>
{/if}
