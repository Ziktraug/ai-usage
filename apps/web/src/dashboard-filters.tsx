import { activeFilterButton } from '@ai-usage/design-system/report';
import type { FieldFilterKey } from './dashboard-search';

export const fieldFilterLabels: Record<FieldFilterKey, string> = {
  provider: 'Provider',
  model: 'Model',
  project: 'Project',
};

export const FilterPill = (props: { label: string; value: string; onClear: () => void }) => (
  <button
    class={activeFilterButton}
    type="button"
    title={`Clear ${props.label} filter`}
    onClick={() => props.onClear()}
  >
    {props.label}: {props.value} ×
  </button>
);
