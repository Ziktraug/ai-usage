<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { projectBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import type { WebReportPayloadWithoutRows } from '../../../../web-report-payload';
  import ProjectGroupEditor from '../actions/project-group-editor.svelte';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import ProjectSummary from './project-summary.svelte';

  let {
    disabled,
    generatedAt,
    groups,
    onProjectFilter,
    onSave,
    payload,
  }: {
    disabled: boolean;
    generatedAt: string;
    groups: readonly ProjectGroup[];
    onProjectFilter: (value: string) => void;
    onSave: (projectGroups: readonly ProjectGroupConfig[]) => Promise<void>;
    payload: Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>;
  } = $props();

  let disclosure = $state<HTMLDetailsElement>();
  let summary = $state<HTMLElement>();
  const sources = $derived((payload.projectGroups ?? []).flatMap(({ sources: groupSources }) => groupSources));
  const openManagement = (): void => {
    if (!(disclosure && summary)) {
      return;
    }
    disclosure.open = true;
    summary.focus();
  };
  const createExport = async (): Promise<{ csv: string; filename: string }> => ({
    csv: projectBreakdownCsv(groups),
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
</script>

<section data-projects-panel>
  <ReportSharingActions {createExport} />
  <ProjectSummary {groups} onManageProjectGroups={openManagement} {onProjectFilter} />
  <details class={disclosureClass} bind:this={disclosure}>
    <summary bind:this={summary}>Manage project groups</summary>
    <ProjectGroupEditor {disabled} initialGroups={payload.projectGroupConfigs ?? []} {onSave} {sources} />
  </details>
</section>
