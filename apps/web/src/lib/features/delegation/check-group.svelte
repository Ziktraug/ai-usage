<script generics="Option extends string" lang="ts">
  import { checkItem, checkRow, fieldError, fieldHint, fieldsetFrame, fieldsetLegend } from './delegation-styles';

  let {
    hint = null,
    idPrefix,
    issues = [],
    legend,
    options,
    value = $bindable(),
  }: {
    hint?: string | null;
    idPrefix: string;
    issues?: readonly string[];
    legend: string;
    options: readonly { readonly label: string; readonly value: Option }[];
    value: Option[];
  } = $props();

  // Keeps the options' order, so a selection reads the same however it was clicked.
  const toggle = (option: Option, checked: boolean): void => {
    value = options.map((entry) => entry.value).filter((entry) => (entry === option ? checked : value.includes(entry)));
  };
</script>

<fieldset class={fieldsetFrame}>
  <legend class={fieldsetLegend}>{legend}</legend>
  <div class={checkRow}>
    {#each options as option (option.value)}
      <label class={checkItem} for="{idPrefix}-{option.value}">
        <input
          checked={value.includes(option.value)}
          id="{idPrefix}-{option.value}"
          onchange={(event) => toggle(option.value, event.currentTarget.checked)}
          type="checkbox"
        >
        {option.label}
      </label>
    {/each}
  </div>
  {#if hint}
    <p class={fieldHint}>{hint}</p>
  {/if}
  {#if issues.length > 0}
    <p class={fieldError} data-field-issue>{issues.join(' ')}</p>
  {/if}
</fieldset>
