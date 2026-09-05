<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { containedInteractive } from '@ai-usage/design-system/report';
  import {
    actionRow,
    dimensionSwatch,
    groupCount,
    groupHeader,
    groupTitle,
    SegmentedControl,
    searchInput,
    stableSeriesColor,
  } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { BreakdownSort } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import { analyticsExportRows, modelAnalysisEmptyMessage, modelAnalysisRows, modelComparisonBars } from './model';
  import {
    analysisActions,
    analysisPanel,
    modelAssistiveText,
    modelCard,
    modelCardHeader,
    modelCardMetric,
    modelCardMetrics,
    modelCardPrimaryValue,
    modelCards,
    modelCardsDescription,
    modelCardTerm,
    modelCardValue,
    modelEmpty,
    modelNameButton,
    modelNumericCell,
    modelQualification,
    modelTable,
    modelTableCell,
    modelTableDescription,
    modelTableHeaderCell,
    modelTableIntro,
    modelTableIntroTitle,
    modelTableViewport,
    modelTextCell,
  } from './styles';

  let {
    generatedAt,
    groups,
    onModelFilter,
    onSortChange,
    sort,
  }: {
    generatedAt: string;
    groups: readonly AnalyticsGroup[];
    onModelFilter: (value: string) => void;
    onSortChange: (sort: BreakdownSort) => void;
    sort: BreakdownSort;
  } = $props();

  let query = $state('');
  const sortLabels: Record<BreakdownSort, string> = { sessions: 'Sessions', tokens: 'Tokens', value: 'Value' };
  const sortValues = ['value', 'tokens', 'sessions'] as const satisfies readonly BreakdownSort[];
  const sortItems = sortValues.map((value) => ({ label: sortLabels[value], value }));
  const changeSort = (value: string): void => {
    if (value === 'value' || value === 'tokens' || value === 'sessions') {
      onSortChange(value);
    }
  };
  const visibleRows = $derived(modelAnalysisRows(groups, query, sort));
  const bars = $derived(modelComparisonBars(visibleRows, sort));
  // Ranked palette first (stable per rank, distinct up to its slot count), then a stable per-key
  // colour: every model keeps its own colour, none is rolled into "other".
  const swatchFor = (key: string, rank: number) => {
    const ranked = dimensionSwatch('model', key, { rank });
    return ranked.className || ranked.style ? ranked : { style: { background: stableSeriesColor(key) } };
  };
  const comparison = css({
    display: 'grid',
    gap: '6px',
    p: '12px 16px',
    borderBottom: '1px solid token(colors.line)',
    minW: 0,
    overflow: 'hidden',
  });
  const comparisonTitle = css({
    m: 0,
    color: 'muted',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  });
  const barList = css({ display: 'grid', gap: '4px', m: 0, p: 0, listStyle: 'none' });
  // Narrow: label and value share a line, the track runs under them. Wide: one line per model.
  const barRow = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr) auto', md: 'minmax(140px, 220px) minmax(0, 1fr) auto' },
    gridTemplateAreas: { base: '"label value" "track track"', md: '"label track value"' },
    gap: { base: '4px 10px', md: '10px' },
    alignItems: 'center',
    fontSize: '12px',
    minW: 0,
  });
  const barLabel = css({
    gridArea: 'label',
    color: 'ink',
    minW: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const barTrackClass = css({
    gridArea: 'track',
    position: 'relative',
    h: '10px',
    minW: 0,
    borderRadius: 'sm',
    bg: 'track',
    overflow: 'hidden',
  });
  const barFillClass = css({
    display: 'block',
    h: '100%',
    borderRadius: 'sm',
    // A lower bound is drawn hatched: the length is a floor, not a measurement.
    '&[data-lower-bound="true"]': {
      backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 3px, rgba(255, 255, 255, 0.45) 3px 6px)',
    },
  });
  const barValue = css({ gridArea: 'value', textStyle: 'numeric', color: 'ink', whiteSpace: 'nowrap' });
  const barNone = css({ color: 'faint', fontSize: '11px' });
  const createExport = async (): Promise<{ csv: string; filename: string }> => ({
    csv: analyticsBreakdownCsv(analyticsExportRows(visibleRows)),
    filename: reportCsvFilename('models', generatedAt),
  });

  const tableDescription =
    'Known API-equivalent value divided by processed tokens, multiplied by 1,000,000. API value / 1M tokens is an observed aggregate comparison, not a published model price. Processed tokens are cache read + cache write + input + output. Share is calculated from the known API-value subtotal.';
  const emptyMessage = $derived(modelAnalysisEmptyMessage(query));
</script>

<section class={cx(containedInteractive, analysisPanel)} data-breakdown-panel="models">
  <header class={groupHeader}>
    <h2 class={groupTitle}>Models</h2>
    <span class={groupCount} title={`${fmtNum(visibleRows.length)} models`}>{fmtNum(visibleRows.length)} models</span>
    <div class={cx(actionRow, analysisActions)}>
      <input
        aria-label="Search this breakdown"
        class={searchInput}
        placeholder="Search this breakdown"
        type="search"
        bind:value={query}
      >
      <SegmentedControl
        ariaLabel="Sort breakdown"
        defaultValue="value"
        items={sortItems}
        onValueChange={changeSort}
        value={sort}
      />
      <ReportSharingActions {createExport} />
    </div>
  </header>

  {#if bars.length > 0}
    <section
      aria-label={`Model comparison by ${sortLabels[sort].toLowerCase()}`}
      class={comparison}
      data-model-comparison
    >
      <p class={comparisonTitle}>By {sortLabels[sort].toLowerCase()}</p>
      <ol class={barList}>
        {#each bars as bar (bar.key)}
          {@const swatch = swatchFor(bar.key, bar.rank)}
          <li class={barRow} data-model-bar={bar.key}>
            <span class={barLabel} title={bar.label}>{bar.label}</span>
            <span aria-hidden="true" class={barTrackClass}>
              {#if bar.widthPercent !== null}
                <span
                  class={cx(barFillClass, swatch.className)}
                  data-lower-bound={bar.lowerBound ? 'true' : undefined}
                  style:background={swatch.style?.background}
                  style:width={`${bar.widthPercent}%`}
                ></span>
              {:else}
                <span class={barNone}>no measure</span>
              {/if}
            </span>
            <span class={barValue}>{bar.measureLabel}</span>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  <div class={modelTableViewport} data-model-analysis-table>
    <div class={modelTableIntro}>
      <p class={modelTableIntroTitle}>Model API-value analysis</p>
      <p class={modelTableDescription} id="model-analysis-table-description">{tableDescription}</p>
    </div>
    <table aria-describedby="model-analysis-table-description" class={modelTable}>
      <caption class={modelAssistiveText}>
        Model API-value analysis
      </caption>
      <thead>
        <tr>
          <th class={cx(modelTableHeaderCell, modelTextCell)} scope="col">Model</th>
          <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">API value</th>
          <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Share</th>
          <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Processed tokens</th>
          <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Rates known</th>
          <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">API value / 1M tokens</th>
        </tr>
      </thead>
      <tbody>
        {#if visibleRows.length === 0}
          <tr>
            <td class={modelEmpty} colspan="6"><span role="status">{emptyMessage}</span></td>
          </tr>
        {:else}
          {#each visibleRows as row (row.group.key)}
            <tr data-price-state={row.priceState}>
              <th class={cx(modelTableCell, modelTextCell)} scope="row">
                <button
                  aria-label={`Filter sessions by model ${row.label}`}
                  class={modelNameButton}
                  onclick={() => onModelFilter(row.group.key)}
                  type="button"
                >
                  {row.label}
                </button>
              </th>
              <td class={cx(modelTableCell, modelNumericCell)}>
                <span>{row.value.label}</span>
                <span class={modelAssistiveText}>{row.value.title}</span>
                {#if row.valueQualification}
                  <span class={modelQualification}>{row.valueQualification}</span>
                {/if}
              </td>
              <td class={cx(modelTableCell, modelNumericCell)}>{row.shareLabel}</td>
              <td class={cx(modelTableCell, modelNumericCell)}>
                <span>{row.processedTokensLabel}</span>
                <span class={modelAssistiveText}>{row.processedTokensTitle}</span>
                {#if row.processedTokensQualification}
                  <span class={modelQualification}>{row.processedTokensQualification}</span>
                {/if}
              </td>
              <td class={cx(modelTableCell, modelNumericCell)}>
                <span>{row.pricingCoverageLabel}</span>
                {#if row.pricingQualification}
                  <span class={modelQualification}>{row.pricingQualification}</span>
                {/if}
              </td>
              <td class={cx(modelTableCell, modelNumericCell)}>
                <span>{row.valuePerMillion.label}</span>
                <span class={modelAssistiveText}>{row.valuePerMillion.title}</span>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  <p class={modelCardsDescription} id="model-analysis-cards-description">{tableDescription}</p>
  <ul
    aria-describedby="model-analysis-cards-description"
    aria-label="Model API-value analysis"
    class={modelCards}
    data-model-analysis-cards
  >
    {#if visibleRows.length === 0}
      <li class={modelEmpty} role="status">{emptyMessage}</li>
    {:else}
      {#each visibleRows as row (row.group.key)}
        <li>
          <article aria-label={row.label} class={modelCard} data-price-state={row.priceState}>
            <header class={modelCardHeader}>
              <h3>
                <button
                  aria-label={`Filter sessions by model ${row.label}`}
                  class={modelNameButton}
                  onclick={() => onModelFilter(row.group.key)}
                  type="button"
                >
                  {row.label}
                </button>
              </h3>
              <div class={modelCardPrimaryValue}>
                <span class={modelCardTerm}>API value</span>
                <span>{row.value.label}</span>
                <span class={modelAssistiveText}>{row.value.title}</span>
              </div>
            </header>
            {#if row.valueQualification}
              <!-- Full width under the header: the value column does not shrink, so a sentence there
                   pushed a 390px card past the viewport. -->
              <p class={modelQualification}>{row.valueQualification}</p>
            {/if}
            <dl class={modelCardMetrics}>
              <div class={modelCardMetric}>
                <dt class={modelCardTerm}>Share</dt>
                <dd class={modelCardValue}>
                  {row.shareLabel}
                  <span class={modelAssistiveText}>Share of the known API-value subtotal.</span>
                </dd>
              </div>
              <div class={modelCardMetric}>
                <dt class={modelCardTerm}>Processed tokens</dt>
                <dd class={modelCardValue}>
                  <span>{row.processedTokensLabel}</span>
                  <span class={modelAssistiveText}>{row.processedTokensTitle}</span>
                  {#if row.processedTokensQualification}
                    <span class={modelQualification}>{row.processedTokensQualification}</span>
                  {/if}
                </dd>
              </div>
              <div class={modelCardMetric}>
                <dt class={modelCardTerm}>Rates known</dt>
                <dd class={modelCardValue}>
                  <span>{row.pricingCoverageLabel}</span>
                  {#if row.pricingQualification}
                    <span class={modelQualification}>{row.pricingQualification}</span>
                  {/if}
                </dd>
              </div>
              <div class={modelCardMetric}>
                <dt class={modelCardTerm}>API value / 1M tokens</dt>
                <dd class={modelCardValue}>
                  <span>{row.valuePerMillion.label}</span>
                  <span class={modelAssistiveText}>{row.valuePerMillion.title}</span>
                </dd>
              </div>
            </dl>
          </article>
        </li>
      {/each}
    {/if}
  </ul>
</section>
