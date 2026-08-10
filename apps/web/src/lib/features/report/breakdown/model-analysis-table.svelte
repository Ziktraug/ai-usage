<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { containedInteractive } from '@ai-usage/design-system/report';
  import {
    actionRow,
    groupCount,
    groupHeader,
    groupTitle,
    SegmentedControl,
    searchInput,
  } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { BreakdownSort } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import { analyticsExportRows, modelAnalysisEmptyMessage, modelAnalysisRows } from './model';
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
          <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Pricing coverage</th>
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
                <dt class={modelCardTerm}>Pricing coverage</dt>
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
