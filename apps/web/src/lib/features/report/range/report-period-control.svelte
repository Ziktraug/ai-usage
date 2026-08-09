<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits typed boolean ARIA states; browser tests assert their serialized values -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const toolbar = css({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
  });
  const label = css({ color: 'muted', fontSize: '12px', fontWeight: 'semibold' });
  const preset = css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minH: '44px',
    px: '11px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    fontSize: '12px',
    _hover: { borderColor: 'lineStrong' },
  });
  const selectedPreset = css({ borderColor: 'accent', bg: 'accentTint', color: 'ink' });
  const periodSummary = css({ color: 'muted', fontSize: '12px' });
  const customContent = css({
    zIndex: 50,
    display: 'grid',
    gap: '12px',
    w: 'min(360px, calc(100vw - 24px))',
    p: '14px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'overlay',
  });
  const customForm = css({ display: 'grid', gap: '12px' });
  const customHeading = css({ fontSize: '13px', fontWeight: 'semibold' });
  const customFields = css({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' });
  const field = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '11px' });
  const input = css({
    minW: 0,
    minH: '44px',
    px: '10px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    fontSize: '13px',
    _focusVisible: { borderColor: 'accent', boxShadow: '0 0 0 3px token(colors.focusRing)', outline: 'none' },
  });
  const invalidInput = css({ borderColor: 'status.danger' });
  const validationMessage = css({ color: 'status.danger', fontSize: '12px' });
  const customActions = css({ display: 'flex', justifyContent: 'flex-end' });
  const applyButton = css({
    minH: '44px',
    px: '14px',
    borderRadius: 'md',
    bg: 'accent',
    color: 'surface',
    fontSize: '12px',
    fontWeight: 'semibold',
  });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { Popover } from '@ai-usage/design-system/svelte';
  import type { FocusedDateDomain } from '@ai-usage/report-core/focused-report-query';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import { dateFromIndex } from '../../../../date-range';
  import type { SearchNavigationIntent, SearchNavigationOptions } from '../../../foundation/navigation/search-intent';
  import {
    type CustomRangeValidation,
    inputValueForRange,
    reportRangeEditKey,
    reportRangeProjection,
    validateCustomRangeInputs,
  } from './report-range-model';

  interface Props {
    dateDomain: FocusedDateDomain | null;
    generatedAt: string;
    navigate?: SearchNavigationIntent<DashboardSearch>;
    onRangeChange?: (range: DashboardDateRangeSearch) => void;
    range: DashboardDateRangeSearch;
  }

  let { dateDomain, generatedAt, navigate, onRangeChange = () => undefined, range }: Props = $props();

  const directPresetModes = ['7d', '30d', '90d'] as const;
  const generatedDate = $derived(new Date(generatedAt));
  const projection = $derived(reportRangeProjection(range, generatedDate, dateDomain));
  const customErrorId = 'report-custom-range-error';
  const committedInput = (edge: 'end' | 'start'): string => {
    const index = edge === 'start' ? projection.selectionIndexes[0] : projection.selectionIndexes[1];
    return inputValueForRange(dateFromIndex(projection.domainFirst, index));
  };
  const initialFrom = (): string => committedInput('start');
  const initialTo = (): string => committedInput('end');
  let draftFrom = $state(initialFrom());
  let draftTo = $state(initialTo());
  let validationError = $state<Extract<CustomRangeValidation, { status: 'invalid' }> | null>(null);
  const invalidFrom = $derived(validationError?.invalidField === 'from' || validationError?.invalidField === 'range');
  const invalidTo = $derived(validationError?.invalidField === 'to' || validationError?.invalidField === 'range');
  const initialRangeKey = (): string => reportRangeEditKey(range);
  let synchronizedRangeKey = $state(initialRangeKey());

  const restoreCommittedDraft = (): void => {
    draftFrom = committedInput('start');
    draftTo = committedInput('end');
    validationError = null;
  };

  $effect(() => {
    const key = reportRangeEditKey(range);
    if (key === synchronizedRangeKey) {
      return;
    }
    synchronizedRangeKey = key;
    restoreCommittedDraft();
  });

  const commitRange = (next: DashboardDateRangeSearch, options: SearchNavigationOptions = {}): void => {
    if (navigate) {
      navigate((current) => ({ ...current, range: next }), { ...options, resetScroll: false });
      return;
    }
    onRangeChange(next);
  };

  const selectPreset = (mode: Exclude<DashboardDateRangeSearch['mode'], 'custom'>): void => {
    validationError = null;
    commitRange({ mode });
  };

  const applyCustomRange = (): void => {
    const validation = validateCustomRangeInputs(draftFrom, draftTo);
    if (validation.status === 'invalid') {
      validationError = validation;
      return;
    }
    validationError = null;
    commitRange(validation.range);
  };

  const restoreOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    restoreCommittedDraft();
  };
</script>

{#snippet customTrigger()}
  <span>{range.mode === 'custom' ? 'Custom · selected' : 'Custom'} ▾</span>
{/snippet}

<section aria-label="Report period" class={toolbar} data-report-period-control>
  <span class={label}>Period</span>
  {#each directPresetModes as mode (mode)}
    <button
      aria-pressed={range.mode === mode}
      class={cx(preset, range.mode === mode ? selectedPreset : undefined)}
      onclick={() => selectPreset(mode)}
      type="button"
    >
      {mode}
    </button>
  {/each}
  <button
    aria-pressed={range.mode === 'today'}
    class={cx(preset, range.mode === 'today' ? selectedPreset : undefined)}
    onclick={() => selectPreset('today')}
    type="button"
  >
    Today
  </button>
  <button
    aria-pressed={range.mode === 'all'}
    class={cx(preset, range.mode === 'all' ? selectedPreset : undefined)}
    onclick={() => selectPreset('all')}
    type="button"
  >
    All time
  </button>
  <Popover
    contentClass={customContent}
    trigger={customTrigger}
    triggerAriaLabel={range.mode === 'custom'
      ? 'Choose a custom report period, selected'
      : 'Choose a custom report period'}
    triggerClass={cx(preset, range.mode === 'custom' ? selectedPreset : undefined)}
  >
    <form
      class={customForm}
      onsubmit={(event) => {
        event.preventDefault();
        applyCustomRange();
      }}
    >
      <h2 class={customHeading}>Custom period</h2>
      <div class={customFields}>
        <label class={field} for="report-period-from">From</label>
        <label class={field} for="report-period-to">To</label>
        <input
          aria-describedby={validationError ? customErrorId : undefined}
          aria-invalid={invalidFrom}
          class={cx(input, invalidFrom ? invalidInput : undefined)}
          id="report-period-from"
          oninput={(event) => {
            draftFrom = event.currentTarget.value;
          }}
          onkeydown={restoreOnEscape}
          type="text"
          value={draftFrom}
        >
        <input
          aria-describedby={validationError ? customErrorId : undefined}
          aria-invalid={invalidTo}
          class={cx(input, invalidTo ? invalidInput : undefined)}
          id="report-period-to"
          oninput={(event) => {
            draftTo = event.currentTarget.value;
          }}
          onkeydown={restoreOnEscape}
          type="text"
          value={draftTo}
        >
      </div>
      {#if validationError}
        <p class={validationMessage} id={customErrorId} role="alert">{validationError.message}</p>
      {/if}
      <div class={customActions}>
        <button class={applyButton} onkeydown={restoreOnEscape} type="submit">Apply custom period</button>
      </div>
    </form>
  </Popover>
  <span class={periodSummary} data-report-range-part="summary">{projection.summary}</span>
</section>
