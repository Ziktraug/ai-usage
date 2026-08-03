<script lang="ts">
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { UsageReportProjectGroup, UsageReportProjectSource } from '@ai-usage/report-core/report-data';
  import type { SessionOrigin } from '@ai-usage/report-core/session-query';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import {
    type BreakdownSort,
    type DashboardSearch,
    type DashboardTab,
    dashboardSearchDefaultsFor,
    dashboardTabs,
    type FieldFilterKey,
  } from '../../../../dashboard-search';
  import { createE2EProviderQuotaHistoryFixture } from '../../../../provider-quota-e2e-fixture';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import type { QuotaQueryClient } from '../../../query/options/quota';
  import QueryProvider from '../../../query/provider.svelte';
  import CampaignLabelEditor, { type CampaignLabelEditorState } from '../actions/campaign-label-editor.svelte';
  import QuotaHistoryOwner from '../actions/quota-history-owner.svelte';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import type { SharingEnvironment } from '../actions/sharing';
  import ActiveFilters from './active-filters.svelte';
  import DashboardBreakdown from './dashboard-breakdown.svelte';
  import FilterBar from './filter-bar.svelte';
  import { createBreakdownNavigation } from './navigation';

  const analyticsGroup = (key: string, overrides: Partial<AnalyticsGroup> = {}): AnalyticsGroup => ({
    ambiguous: 0,
    cache: 50,
    cacheHitPct: 25,
    costPer100Lines: null,
    costPercent: 25,
    costPerSession: null,
    costSum: 0,
    fresh: 100,
    harness: key,
    inp: 150,
    key,
    lineCount: 0,
    linesA: 0,
    linesD: 0,
    medianCost: null,
    priced: 1,
    provider: key,
    sessions: 1,
    tools: 0,
    turns: 0,
    unpriced: 0,
    unpricedFreshTokens: 0,
    usageUnavailable: 0,
    ...overrides,
  });
  const projectGroup = (overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
    cache: 5,
    cost: 1.25,
    fresh: 10,
    key: 'unknown-project',
    label: '(unknown)',
    lineMeasurement: { measuredSessions: 1, totalSessions: 2 },
    linesAdded: 7,
    linesDeleted: 2,
    priced: 1,
    sessions: 2,
    tools: 4,
    turns: 3,
    ...overrides,
  });
  const source: UsageReportProjectSource = {
    gitRemote: '',
    id: 'source-a',
    machineId: 'raw-machine-id',
    machineLabel: 'Laptop',
    project: 'project-a',
    sessions: 2,
    sourcePath: '/synthetic/project-a',
    tokens: 10,
  };
  const payloadProjectGroup: UsageReportProjectGroup = {
    cache: 5,
    cost: 1.25,
    fresh: 10,
    grouped: true,
    id: 'group-a',
    linesAdded: 7,
    linesDeleted: 2,
    name: 'Existing group',
    priced: 1,
    sessions: 2,
    sources: [source],
    tokens: 15,
    tools: 4,
    turns: 3,
  };
  const initialProjectGroups: ProjectGroupConfig[] = [
    {
      id: 'group-a',
      name: 'Existing group',
      sources: [{ machineId: 'raw-machine-id', sourcePath: '/synthetic/project-a' }],
    },
  ];

  let search = $state<DashboardSearch>({
    ...dashboardSearchDefaultsFor('cost'),
    filters: { provider: 'openai' },
    machine: ['raw-machine-id'],
    origin: ['human'],
    q: 'needle',
    tab: 'models',
  });
  let navigationMode = $state('none');
  const navigation = createBreakdownNavigation((update, options) => {
    search = update(search);
    navigationMode = options?.replace === true ? 'replace' : 'push';
  });
  const setTab = (value: string): void => {
    if (dashboardTabs.includes(value as DashboardTab)) {
      navigation.setBreakdownTab(value as DashboardTab);
    }
  };
  const setFieldFilter = (key: FieldFilterKey, value: string): void => navigation.setFieldFilter(key, value);
  const setSort = (sort: BreakdownSort): void => navigation.setBreakdownSort(sort);

  const campaign = $state<CampaignLabelEditorState>({
    campaignKey: 'campaign-a',
    effectiveLabel: 'Campaign A',
    hasOverride: true,
    loadError: null,
    loadStatus: 'ready',
    mutationError: null,
    mutationStatus: 'idle',
    onRename: (label) => {
      campaign.effectiveLabel = label;
      campaign.hasOverride = true;
      return Promise.resolve(label);
    },
    onReset: () => {
      campaign.effectiveLabel = 'Campaign A';
      campaign.hasOverride = false;
      return Promise.resolve(campaign.effectiveLabel);
    },
    onRetry: () => Promise.resolve(true),
  });

  let projectSaveAttempts = $state(0);
  let projectSaveState = $state('idle');
  const saveProjectGroups = (_groups: readonly ProjectGroupConfig[]): Promise<void> => {
    projectSaveAttempts += 1;
    if (projectSaveAttempts === 1) {
      projectSaveState = 'error';
      return Promise.reject(new Error('Synthetic project save failed'));
    }
    projectSaveState = 'saved';
    return Promise.resolve();
  };

  let copiedUrl = $state('');
  let downloadedCsv = $state('');
  const successfulSharingEnvironment = (): SharingEnvironment => ({
    copyText: (text) => {
      copiedUrl = text;
      return Promise.resolve();
    },
    currentUrl: () => 'https://example.test/report?tab=models&provider=openai',
    download: ({ csv }) => {
      downloadedCsv = csv;
    },
  });
  const failedSharingEnvironment = (): SharingEnvironment => ({
    copyText: () => Promise.reject(new Error('Synthetic clipboard failure')),
    currentUrl: () => 'https://example.test/report?tab=models',
    download: () => {
      throw new Error('Synthetic download failure');
    },
  });

  let quotaOpen = $state(false);
  let quotaMode: RuntimeMode = $state('demo');
  let quotaRequests = $state(0);
  const quotaClient: QuotaQueryClient = {
    getProviderQuotaHistory: () => {
      quotaRequests += 1;
      return Promise.resolve(createE2EProviderQuotaHistoryFixture());
    },
  };

  const models = [
    analyticsGroup('measured', { costSum: 10 }),
    analyticsGroup('partial', { costSum: 5, priced: 0, unpriced: 1, unpricedFreshTokens: 100 }),
    analyticsGroup('unavailable', { usageUnavailable: 1 }),
    analyticsGroup('zero'),
  ];
  const harnesses = [analyticsGroup('codex', { costSum: 8, harness: 'codex' })];
  const harnessProviders = [analyticsGroup('codex:openai', { costSum: 8, harness: 'codex', provider: 'openai' })];
</script>

{#snippet sourceControlSummary()}
  <button type="button">Synthetic source control</button>
{/snippet}

<main
  data-copied-url={copiedUrl}
  data-downloaded-csv={downloadedCsv}
  data-navigation-mode={navigationMode}
  data-project-save-state={projectSaveState}
  data-quota-requests={quotaRequests}
  data-search-machine={search.machine.join(',')}
  data-search-origin={search.origin.join(',')}
>
  <h1>P8 synthetic report interactions</h1>
  <section data-testid="filters">
    <FilterBar
      harnessOptions={['codex', 'claude-code']}
      machineOptions={['raw-machine-id', 'other-machine-id']}
      {navigation}
      presentMachineLabel={(value) => (value === 'raw-machine-id' ? 'Laptop' : 'Desktop')}
      {search}
      {sourceControlSummary}
    />
    <ActiveFilters
      hidden={3}
      {navigation}
      presentMachineLabel={(value) => (value === 'raw-machine-id' ? 'Laptop' : value)}
      {search}
      total={10}
      visible={7}
    />
  </section>

  <section data-testid="breakdown">
    <DashboardBreakdown
      data={{
        cursorRows: [],
        generatedAt: '2026-07-29T18:45:00.000Z',
        harnesses,
        harnessProviders,
        models,
        projects: [projectGroup()],
      }}
      navigation={{ onSortChange: setSort, onTabChange: setTab, sort: search.breakdownSort, tab: search.tab }}
      onFieldFilter={setFieldFilter}
      onHarnessFilter={(value) => navigation.setHarness([value])}
      projectEditor={{
        disabled: false,
        onSave: saveProjectGroups,
        payload: { projectGroupConfigs: initialProjectGroups, projectGroups: [payloadProjectGroup] },
      }}
    />
  </section>

  <section data-testid="campaign">
    <CampaignLabelEditor editor={campaign} />
  </section>

  <section data-testid="sharing-success">
    <ReportSharingActions
      createExport={() => Promise.resolve({ csv: 'label,value\nvisible,1\n', filename: 'visible.csv' })}
      environment={successfulSharingEnvironment}
    />
  </section>
  <section data-testid="sharing-failure">
    <ReportSharingActions
      createExport={() => Promise.resolve({ csv: 'label,value\nvisible,1\n', filename: 'visible.csv' })}
      environment={failedSharingEnvironment}
    />
  </section>

  <section data-testid="quota-controls">
    <button onclick={() => (quotaOpen = true)} type="button">Open demo quota history</button>
    <button onclick={() => (quotaMode = 'live')} type="button">Use live quota mode</button>
    <button onclick={() => (quotaOpen = true)} type="button">Open live quota history</button>
    <QueryProvider>
      <QuotaHistoryOwner
        client={quotaClient}
        generation="synthetic-generation"
        onClose={() => (quotaOpen = false)}
        open={quotaOpen}
        runtimeMode={quotaMode}
      />
    </QueryProvider>
  </section>
</main>
