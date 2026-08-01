import { css } from '@ai-usage/design-system/css';
import { section, unavailableText } from '@ai-usage/design-system/report';
import { type Accessor, type ComponentProps, lazy, Show, Suspense } from 'solid-js';
import { DashboardBreakdown, type DashboardBreakdownProps } from './dashboard-breakdown';
import { DashboardPendingSurface } from './dashboard-pending-surface';
import type { DashboardTab } from './dashboard-search';
import { DashboardStatus, type DashboardStatusProps } from './dashboard-status';
import { Overview } from './overview';
import { SessionDrawer } from './session-drawer';
import type { SessionTable as SessionTableComponent } from './session-table';

const SessionTable = lazy(async () => {
  const module = await import('./session-table');
  return { default: module.SessionTable };
});

const layout = css({
  display: 'flex',
  flexDirection: 'column',
});

const view = css({
  order: 1,
});

const panel = css({
  minW: 0,
  _focus: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '4px',
  },
});

const status = css({
  order: 2,
});

export interface DashboardReportWorkspaceProps {
  breakdown: DashboardBreakdownProps;
  drawer?: ComponentProps<typeof SessionDrawer> | undefined;
  overview: ComponentProps<typeof Overview>;
  pending: Accessor<boolean>;
  sessions: ComponentProps<typeof SessionTableComponent>;
  status?: DashboardStatusProps | undefined;
  tab: DashboardTab;
}

export const DashboardReportWorkspace = (props: DashboardReportWorkspaceProps) => (
  <>
    <div class={layout}>
      <div class={view}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The active report panel must remain keyboard-reachable after removing the primary tabs. */}
        <div class={panel} data-dashboard-panel tabIndex={0}>
          <Show fallback={<DashboardPendingSurface />} when={!props.pending()}>
            <Show when={props.tab === 'overview'}>
              <section class={section}>
                <Overview {...props.overview} />
              </section>
            </Show>
            <Show when={props.tab === 'sessions'}>
              <section class={section}>
                <Suspense fallback={<div class={unavailableText}>Loading sessions…</div>}>
                  <SessionTable {...props.sessions} />
                </Suspense>
              </section>
            </Show>
            <Show when={props.tab !== 'overview' && props.tab !== 'sessions'}>
              <DashboardBreakdown
                data={props.breakdown.data}
                navigation={props.breakdown.navigation}
                onFieldFilter={props.breakdown.onFieldFilter}
                onHarnessFilter={props.breakdown.onHarnessFilter}
                projectEditor={props.breakdown.projectEditor}
              />
            </Show>
          </Show>
        </div>
      </div>
      <Show when={props.status}>
        {(dashboardStatus) => (
          <div class={status}>
            <DashboardStatus {...dashboardStatus()} />
          </div>
        )}
      </Show>
    </div>
    <Show when={props.drawer}>{(drawer) => <SessionDrawer {...drawer()} />}</Show>
  </>
);
