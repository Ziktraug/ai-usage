import { css } from '@ai-usage/design-system/css';
import { section } from '@ai-usage/design-system/report';
import { CursorAttributionPanel } from './cursor-attribution-panel';
import type { DashboardBreakdownProps } from './dashboard-breakdown';
import { createAnalyticsExport, createProjectExport } from './dashboard-breakdown-export';
import { GroupPanel } from './group-panel';
import { breakdownModelLabel } from './group-panel-presentation';
import { ProjectGroupEditor } from './project-group-editor';
import { ProjectSummary } from './project-summary';
import { ReportSharingActions } from './report-sharing-actions';

const projectGroupDisclosure = css({
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
  '&[open] > summary': {
    mb: '10px',
  },
});

export const ModelsBreakdownPanel = (props: DashboardBreakdownProps) => (
  <section class={section}>
    <GroupPanel
      countLabel="models"
      groups={props.data.models}
      harnessTones
      onFilter={(value) => props.onFieldFilter('model', value)}
      onSortChange={props.navigation.onSortChange}
      renderActions={(groups) => (
        <ReportSharingActions
          createExport={() =>
            createAnalyticsExport(
              'models',
              props.data.generatedAt,
              groups.map((group) => ({ group, label: breakdownModelLabel(group.key) })),
            )
          }
        />
      )}
      sort={props.navigation.sort}
      title="By model"
    />
  </section>
);

export const ProjectsBreakdownPanel = (props: DashboardBreakdownProps) => {
  let disclosureElement: HTMLDetailsElement | undefined;
  let summaryElement: HTMLElement | undefined;
  const openProjectGroupManagement = (): void => {
    if (!(disclosureElement && summaryElement)) {
      return;
    }
    disclosureElement.open = true;
    summaryElement.focus();
  };

  return (
    <section class={section} data-projects-panel>
      <ProjectSummary
        actions={
          <ReportSharingActions createExport={() => createProjectExport(props.data.generatedAt, props.data.projects)} />
        }
        groups={props.data.projects}
        onManageProjectGroups={openProjectGroupManagement}
        onProjectFilter={(value) => props.onFieldFilter('project', value)}
      />
      <details
        class={projectGroupDisclosure}
        ref={(element) => {
          disclosureElement = element;
        }}
      >
        <summary
          ref={(element) => {
            summaryElement = element;
          }}
        >
          Manage project groups
        </summary>
        <ProjectGroupEditor
          disabled={props.projectEditor.disabled}
          onSave={props.projectEditor.onSave}
          payload={props.projectEditor.payload}
        />
      </details>
    </section>
  );
};

export const CursorBreakdownPanel = (props: DashboardBreakdownProps) => (
  <section class={section}>
    <CursorAttributionPanel rows={props.data.cursorRows} />
  </section>
);
