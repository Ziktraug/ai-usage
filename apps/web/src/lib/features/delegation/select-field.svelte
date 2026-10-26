<script generics="Option extends string" lang="ts">
  import { fieldError, fieldHint, fieldInput, fieldLabel } from './delegation-styles';

  let {
    hint = null,
    id,
    issues = [],
    label,
    onchange,
    options,
    value = $bindable(),
  }: {
    hint?: string | null;
    id: string;
    issues?: readonly string[];
    label: string;
    onchange?: (value: Option) => void;
    options: readonly { readonly label: string; readonly value: Option }[];
    value: Option;
  } = $props();

  const describedBy = $derived(
    [hint ? `${id}-hint` : null, issues.length > 0 ? `${id}-issues` : null].filter(Boolean).join(' ') || undefined,
  );
</script>

<div class={fieldLabel}>
  <label for={id}>{label}</label>
  <select
    aria-describedby={describedBy}
    aria-invalid={issues.length > 0 ? 'true' : undefined}
    class={fieldInput}
    {id}
    onchange={() => onchange?.(value)}
    bind:value
  >
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
  {#if hint}
    <p class={fieldHint} id="{id}-hint">{hint}</p>
  {/if}
  {#if issues.length > 0}
    <p class={fieldError} data-field-issue id="{id}-issues">{issues.join(' ')}</p>
  {/if}
</div>
