<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { type SessionOrigin, sessionOriginLabel, sessionOrigins } from '@ai-usage/report-core/session-query';
  import { isDefaultDashboardOriginSelection } from '../../../../dashboard-search';
  import { button, panel, row, selectedButton } from './styles';

  let { onValueChange, value }: { onValueChange: (origins: SessionOrigin[]) => void; value: SessionOrigin[] } =
    $props();
  const normalized = $derived(value.length === 0 ? sessionOrigins : value);
  const label = $derived.by(() => {
    if (isDefaultDashboardOriginSelection(value)) {
      return 'Origin: all';
    }
    const selected = new Set(value);
    const excluded = sessionOrigins.filter((origin) => !selected.has(origin));
    return `Origin: excluding ${excluded.map((origin) => sessionOriginLabel(origin).toLowerCase()).join(' + ')}`;
  });
  const setChecked = (origin: SessionOrigin, checked: boolean): void => {
    const next = new Set(normalized);
    if (checked) {
      next.add(origin);
    } else {
      next.delete(origin);
    }
    const selection = sessionOrigins.filter((candidate) => next.has(candidate));
    onValueChange(selection.length === sessionOrigins.length ? [] : selection);
  };
</script>

<details>
  <summary class={cx(button, value.length > 0 ? selectedButton : undefined)}>{label}</summary>
  <div class={panel}>
    <div class={row}>
      <strong>Session origin</strong>
      <button class={button} onclick={() => onValueChange([])} type="button">All</button>
    </div>
    {#each sessionOrigins as origin}
      <div>
        <input
          aria-label={sessionOriginLabel(origin)}
          checked={normalized.includes(origin)}
          onchange={(event) => setChecked(origin, event.currentTarget.checked)}
          type="checkbox"
        >
        <span>{sessionOriginLabel(origin)}</span>
      </div>
    {/each}
  </div>
</details>
