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
  const customFields = css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' });
  const field = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    color: 'muted',
    fontSize: '11px',
    fontWeight: 'semibold',
  });
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
  const brushRow = css({ minW: 0, pt: '2px', w: '100%' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { FocusedDateDomain } from '@ai-usage/report-core/focused-report-query';
  import { tick } from 'svelte';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import { dateFromIndex } from '../../../../date-range';
  import type { SearchNavigationIntent, SearchNavigationOptions } from '../../../foundation/navigation/search-intent';
  import RangeBrush from './range-brush.svelte';
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
  let fromInputElement = $state<HTMLInputElement | null>(null);
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

  // Entering custom mode keeps the currently effective window, so the report does not move —
  // the two date fields appear inline, seeded and ready to edit.
  const selectCustom = async (): Promise<void> => {
    if (range.mode !== 'custom') {
      validationError = null;
      commitRange({ from: committedInput('start'), mode: 'custom', to: committedInput('end') });
    }
    await tick();
    fromInputElement?.focus();
  };

  // Each completed field edit commits on its own, like the original range control: a valid pair
  // navigates immediately, an invalid one announces why and leaves the committed range alone.
  const commitDraftEdit = (): void => {
    const validation = validateCustomRangeInputs(draftFrom, draftTo);
    if (validation.status === 'invalid') {
      validationError = validation;
      return;
    }
    validationError = null;
    if (reportRangeEditKey(validation.range) === reportRangeEditKey(range)) {
      return;
    }
    commitRange(validation.range);
  };

  const restoreOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    restoreCommittedDraft();
  };
</script>

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
  <button
    aria-label={range.mode === 'custom' ? 'Choose a custom report period, selected' : 'Choose a custom report period'}
    aria-pressed={range.mode === 'custom'}
    class={cx(preset, range.mode === 'custom' ? selectedPreset : undefined)}
    onclick={selectCustom}
    type="button"
  >
    Custom
  </button>
  {#if range.mode === 'custom'}
    <div class={customFields} data-report-range-part="adjustments">
      <label class={field} for="report-period-from">From</label>
      <input
        aria-describedby={validationError ? customErrorId : undefined}
        aria-invalid={invalidFrom}
        autocomplete="off"
        class={cx(input, invalidFrom ? invalidInput : undefined)}
        id="report-period-from"
        maxlength="10"
        onchange={(event) => {
          draftFrom = event.currentTarget.value;
          commitDraftEdit();
        }}
        onkeydown={restoreOnEscape}
        placeholder="YYYY-MM-DD"
        spellcheck="false"
        title="Date as YYYY-MM-DD"
        type="text"
        value={draftFrom}
        bind:this={fromInputElement}
      >
      <label class={field} for="report-period-to">To</label>
      <input
        aria-describedby={validationError ? customErrorId : undefined}
        aria-invalid={invalidTo}
        autocomplete="off"
        class={cx(input, invalidTo ? invalidInput : undefined)}
        id="report-period-to"
        maxlength="10"
        onchange={(event) => {
          draftTo = event.currentTarget.value;
          commitDraftEdit();
        }}
        onkeydown={restoreOnEscape}
        placeholder="YYYY-MM-DD"
        spellcheck="false"
        title="Date as YYYY-MM-DD"
        type="text"
        value={draftTo}
      >
      {#if validationError}
        <p class={validationMessage} id={customErrorId} role="alert">{validationError.message}</p>
      {/if}
    </div>
  {/if}
  <span class={periodSummary} data-report-range-part="summary">{projection.summary}</span>
  {#if range.mode === 'custom'}
    <div class={brushRow}>
      <RangeBrush {dateDomain} {generatedAt} {onRangeChange} {range} {...navigate ? { navigate } : {}} />
    </div>
  {/if}
</section>
