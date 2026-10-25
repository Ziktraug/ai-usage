<script lang="ts">
  import { fieldError, fieldHint, fieldInput, fieldLabel } from './delegation-styles';

  let {
    disabled = false,
    hint = null,
    id,
    inputmode,
    issues = [],
    label,
    list,
    placeholder = '',
    value = $bindable(''),
  }: {
    disabled?: boolean;
    hint?: string | null;
    id: string;
    inputmode?: 'numeric' | 'text' | undefined;
    issues?: readonly string[];
    label: string;
    list?: string | undefined;
    placeholder?: string;
    value: string;
  } = $props();

  const describedBy = $derived(
    [hint ? `${id}-hint` : null, issues.length > 0 ? `${id}-issues` : null].filter(Boolean).join(' ') || undefined,
  );
</script>

<div class={fieldLabel}>
  <label for={id}>{label}</label>
  <input
    aria-describedby={describedBy}
    aria-invalid={issues.length > 0 ? 'true' : undefined}
    class={fieldInput}
    {disabled}
    {id}
    {inputmode}
    {list}
    {placeholder}
    type="text"
    bind:value
  >
  {#if hint}
    <p class={fieldHint} id="{id}-hint">{hint}</p>
  {/if}
  {#if issues.length > 0}
    <p class={fieldError} data-field-issue id="{id}-issues">{issues.join(' ')}</p>
  {/if}
</div>
