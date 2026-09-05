<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    actionRow,
    groupCount,
    groupHeader,
    groupPanel,
    groupTitle,
    searchInput,
  } from '@ai-usage/design-system/svelte';
  import { projectBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import { projectSearchRows, projectsEmptyMessage } from '../../../../project-presentation';
  import type { WebReportPayloadWithoutRows } from '../../../../web-report-payload';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ProjectGroupEditor from '../actions/project-group-editor.svelte';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import ProjectSummary from './project-summary.svelte';
  import { analysisActions } from './styles';

  let {
    disabled,
    generatedAt,
    groups,
    machineCount = null,
    onProjectFilter,
    onSave,
    payload,
  }: {
    disabled: boolean;
    generatedAt: string;
    groups: readonly ProjectGroup[];
    /** Store-wide machine count when known exactly; null when unknown or truncated. */
    machineCount?: number | null;
    onProjectFilter: (value: string) => void;
    onSave: (projectGroups: readonly ProjectGroupConfig[]) => Promise<void>;
    payload: Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>;
  } = $props();

  let disclosure = $state<HTMLDetailsElement>();
  let query = $state('');
  let summary = $state<HTMLElement>();
  const sources = $derived((payload.projectGroups ?? []).flatMap(({ sources: groupSources }) => groupSources));
  const visible = $derived(projectSearchRows(groups, query, payload.projectGroups));
  const openManagement = (): void => {
    if (!(disclosure && summary)) {
      return;
    }
    disclosure.open = true;
    summary.focus();
  };
  const createExport = async (): Promise<{ csv: string; filename: string }> => ({
    csv: projectBreakdownCsv(visible),
    filename: reportCsvFilename('projects', generatedAt),
  });
  const disclosureClass = css({
    mt: '14px',
    '& > summary': {
      p: '12px 14px',
      border: '1px solid token(colors.line)',
      borderRadius: 'md',
      bg: 'surface',
      color: 'ink',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: 650,
    },
    '&[open] > summary': { mb: '10px' },
  });
  const projectsPanel = css({ minW: 0 });
</script>

<section class={projectsPanel} data-projects-panel>
  <section class={groupPanel} data-breakdown-panel="projects">
    <header class={groupHeader}>
      <h2 class={groupTitle}>Projects</h2>
      <span class={groupCount} title={`${fmtNum(visible.length)} projects`}>{fmtNum(visible.length)} projects</span>
      <div class={cx(actionRow, analysisActions)}>
        <input
          aria-label="Search this breakdown"
          class={searchInput}
          placeholder="Search this breakdown"
          type="search"
          bind:value={query}
        >
        <ReportSharingActions {createExport} />
      </div>
    </header>
    <ProjectSummary
      {...(payload.projectGroups === undefined ? {} : { catalogue: payload.projectGroups })}
      emptyMessage={projectsEmptyMessage(query)}
      groups={visible}
      onManageProjectGroups={openManagement}
      {onProjectFilter}
      showMachines={machineCount !== 1}
    />
  </section>
  <details class={disclosureClass} bind:this={disclosure}>
    <summary bind:this={summary}>Manage project groups</summary>
    <ProjectGroupEditor {disabled} initialGroups={payload.projectGroupConfigs ?? []} {onSave} {sources} />
  </details>
</section>
