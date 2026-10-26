<script lang="ts">
  import { fieldError, fieldHint, fieldLabel, fieldTextarea } from './delegation-styles';

  let {
    hint = null,
    id,
    issues = [],
    label,
    value = $bindable(''),
  }: {
    hint?: string | null;
    id: string;
    issues?: readonly string[];
    label: string;
    value: string;
  } = $props();

  const describedBy = $derived(
    [hint ? `${id}-hint` : null, issues.length > 0 ? `${id}-issues` : null].filter(Boolean).join(' ') || undefined,
  );
</script>

<div class={fieldLabel}>
  <label for={id}>{label}</label>
  <textarea
    aria-describedby={describedBy}
    aria-invalid={issues.length > 0 ? 'true' : undefined}
    class={fieldTextarea}
    {id}
    rows="2"
    bind:value
  ></textarea>
  {#if hint}
    <p class={fieldHint} id="{id}-hint">{hint}</p>
  {/if}
  {#if issues.length > 0}
    <p class={fieldError} data-field-issue id="{id}-issues">{issues.join(' ')}</p>
  {/if}
</div>
