<script lang="ts">
  import { type SessionOrigin, sessionOriginLabel, sessionOrigins } from '@ai-usage/report-core/session-query';
  import { isDefaultDashboardOriginSelection } from '../../../../dashboard-search';
  import CheckboxFilter from './checkbox-filter.svelte';

  let { onValueChange, value }: { onValueChange: (origins: SessionOrigin[]) => void; value: SessionOrigin[] } =
    $props();

  const originSummary = (origins: readonly string[]): string => {
    const selection = origins as readonly SessionOrigin[];
    if (isDefaultDashboardOriginSelection(selection)) {
      return 'Origin: all';
    }
    const selected = new Set(selection);
    const excluded = sessionOrigins.filter((origin) => !selected.has(origin));
    return `Origin: excluding ${excluded.map((origin) => sessionOriginLabel(origin).toLowerCase()).join(' + ')}`;
  };
</script>

<CheckboxFilter
  label="Filter by origin"
  noun="origins"
  onValueChange={(origins) => onValueChange(origins as SessionOrigin[])}
  optionLabel={(origin) => sessionOriginLabel(origin as SessionOrigin)}
  options={[...sessionOrigins]}
  placeholder="All origins"
  summary={originSummary}
  title="Session origin"
  {value}
/>
