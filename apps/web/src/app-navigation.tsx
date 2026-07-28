import { css, cx } from '@ai-usage/design-system/css';
import { Link, useRouterState } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { getBrowserRuntimeMode } from './browser-runtime-mode';
import {
  breakdownTabFor,
  type DashboardSearch,
  type DashboardTab,
  dashboardSearchDefaultsFor,
  primaryDashboardTabFor,
  validateDashboardSearch,
} from './dashboard-search';
import { ThemeToggle } from './dashboard-theme';
import {
  browserSessionSurfaceModeEnvironment,
  createSessionSurfaceModeController,
  type SessionSurfaceMode,
} from './session-surface-mode';

export const appNavigationContent = css({
  minW: 0,
  ml: { base: 0, md: '216px' },
  pb: { base: '72px', md: 0 },
  _print: { ml: 0, pb: 0 },
});

const desktopRail = css({
  position: 'fixed',
  insetBlock: 0,
  insetInlineStart: 0,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  w: '216px',
  p: '24px 16px',
  borderRight: '1px solid token(colors.line)',
  bg: 'surface',
  color: 'ink',
  _print: { display: 'none' },
});

const productName = css({
  px: '10px',
  pb: '24px',
  color: 'accent',
  fontSize: '15px',
  fontWeight: 750,
  letterSpacing: '-0.01em',
});

const navigationGroup = css({ display: 'grid', gap: '6px', mb: '22px' });
const navigationGroupLabel = css({
  px: '10px',
  pb: '3px',
  color: 'muted',
  fontSize: '10px',
  fontWeight: 750,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
});

const navigationLink = css({
  display: 'flex',
  alignItems: 'center',
  minH: '38px',
  px: '10px',
  border: '1px solid transparent',
  borderRadius: 'md',
  color: 'muted',
  fontSize: '13px',
  fontWeight: 650,
  textDecoration: 'none',
  transition: 'background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease',
  _hover: { bg: 'surfaceMuted', color: 'ink' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});

const navigationLinkActive = css({ borderColor: 'lineStrong', bg: 'accentSoft', color: 'ink' });
const railFooter = css({
  mt: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
});

const mobileNavigation = css({
  position: 'fixed',
  insetInline: 0,
  bottom: 0,
  zIndex: 50,
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  minH: '64px',
  px: '8px',
  pb: 'max(6px, env(safe-area-inset-bottom))',
  borderTop: '1px solid token(colors.line)',
  bg: 'surface',
  _print: { display: 'none' },
});
const mobileNavigationReportOnly = css({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });

const mobileLink = css({
  display: 'grid',
  placeItems: 'center',
  minW: 0,
  minH: '52px',
  px: '5px',
  border: 0,
  bg: 'transparent',
  color: 'muted',
  fontFamily: 'sans',
  fontSize: '11px',
  fontWeight: 700,
  textDecoration: 'none',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
});

const mobileLinkActive = css({ color: 'accent' });
const managePopover = css({
  position: 'fixed',
  right: '10px',
  bottom: '70px',
  zIndex: 51,
  display: 'grid',
  gap: '6px',
  minW: '190px',
  p: '10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: '0 16px 36px rgba(0, 0, 0, 0.24)',
});

const MANAGE_POPOVER_ID = 'app-manage-navigation';
const reportSearchDefaults = dashboardSearchDefaultsFor('date');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reportSearchFor = (search: unknown, tab: DashboardTab): DashboardSearch => ({
  ...validateDashboardSearch(isRecord(search) ? search : {}, reportSearchDefaults),
  tab,
});

const ReportDestinationLink = (props: { active: boolean; class: string; label: string; search: DashboardSearch }) => (
  <Link aria-current={props.active ? 'page' : undefined} class={props.class} search={props.search} to="/">
    {props.label}
  </Link>
);

const ManageDestinationLink = (props: {
  active: boolean;
  class: string;
  label: string;
  onSelect?: () => void;
  to: '/skills' | '/sources' | '/sync';
}) => (
  <Link aria-current={props.active ? 'page' : undefined} class={props.class} onClick={props.onSelect} to={props.to}>
    {props.label}
  </Link>
);

export const AppNavigation = () => {
  const location = useRouterState({ select: (state) => state.location });
  const [surfaceMode, setSurfaceMode] = createSignal<SessionSurfaceMode>('pending');
  const [manageOpen, setManageOpen] = createSignal(false);
  const showManage = getBrowserRuntimeMode() !== 'demo';
  let manageButton: HTMLButtonElement | undefined;
  const dashboardSearch = createMemo(() =>
    validateDashboardSearch(isRecord(location().search) ? location().search : {}, reportSearchDefaults),
  );
  const reportTab = createMemo(() => primaryDashboardTabFor(dashboardSearch().tab));
  const onReport = () => location().pathname === '/';
  const reportLinkClass = (active: boolean, mobile = false) =>
    cx(mobile ? mobileLink : navigationLink, active && (mobile ? mobileLinkActive : navigationLinkActive));
  const manageLinkClass = (pathname: string, mobile = false) =>
    reportLinkClass(location().pathname.startsWith(pathname), mobile);

  onMount(() => {
    const controller = createSessionSurfaceModeController(browserSessionSurfaceModeEnvironment());
    const stop = controller.start(setSurfaceMode);
    onCleanup(stop);
  });

  createEffect(
    on(
      () => location().href,
      () => setManageOpen(false),
    ),
  );
  createEffect(() => {
    if (!manageOpen()) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setManageOpen(false);
      manageButton?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    onCleanup(() => window.removeEventListener('keydown', closeOnEscape));
  });

  return (
    <>
      <Show when={surfaceMode() === 'desktop'}>
        <aside aria-label="Application navigation" class={desktopRail} data-app-navigation="desktop">
          <div class={productName}>ai-usage</div>
          <nav aria-label="Report views" class={navigationGroup}>
            <div class={navigationGroupLabel}>Report</div>
            <ReportDestinationLink
              active={onReport() && reportTab() === 'overview'}
              class={reportLinkClass(onReport() && reportTab() === 'overview')}
              label="Overview"
              search={reportSearchFor(location().search, 'overview')}
            />
            <ReportDestinationLink
              active={onReport() && reportTab() === 'sessions'}
              class={reportLinkClass(onReport() && reportTab() === 'sessions')}
              label="Sessions"
              search={reportSearchFor(location().search, 'sessions')}
            />
            <ReportDestinationLink
              active={onReport() && reportTab() === 'breakdown'}
              class={reportLinkClass(onReport() && reportTab() === 'breakdown')}
              label="Breakdown"
              search={reportSearchFor(location().search, breakdownTabFor(dashboardSearch().tab))}
            />
          </nav>
          <Show when={showManage}>
            <nav aria-label="Manage destinations" class={navigationGroup}>
              <div class={navigationGroupLabel}>Manage</div>
              <ManageDestinationLink
                active={location().pathname.startsWith('/skills')}
                class={manageLinkClass('/skills')}
                label="Skills"
                to="/skills"
              />
              <ManageDestinationLink
                active={location().pathname === '/sync'}
                class={manageLinkClass('/sync')}
                label="Sync"
                to="/sync"
              />
              <ManageDestinationLink
                active={location().pathname === '/sources'}
                class={manageLinkClass('/sources')}
                label="Sources"
                to="/sources"
              />
            </nav>
          </Show>
          <div class={railFooter}>
            <span class={navigationGroupLabel}>Theme</span>
            <ThemeToggle />
          </div>
        </aside>
      </Show>

      <Show when={surfaceMode() === 'mobile'}>
        <nav
          aria-label="Report views"
          class={cx(mobileNavigation, !showManage && mobileNavigationReportOnly)}
          data-app-navigation="mobile"
        >
          <ReportDestinationLink
            active={onReport() && reportTab() === 'overview'}
            class={reportLinkClass(onReport() && reportTab() === 'overview', true)}
            label="Overview"
            search={reportSearchFor(location().search, 'overview')}
          />
          <ReportDestinationLink
            active={onReport() && reportTab() === 'sessions'}
            class={reportLinkClass(onReport() && reportTab() === 'sessions', true)}
            label="Sessions"
            search={reportSearchFor(location().search, 'sessions')}
          />
          <ReportDestinationLink
            active={onReport() && reportTab() === 'breakdown'}
            class={reportLinkClass(onReport() && reportTab() === 'breakdown', true)}
            label="Breakdown"
            search={reportSearchFor(location().search, breakdownTabFor(dashboardSearch().tab))}
          />
          <Show when={showManage}>
            <button
              aria-controls={MANAGE_POPOVER_ID}
              aria-expanded={manageOpen()}
              class={cx(
                mobileLink,
                ['/skills', '/sync', '/sources'].some((path) => location().pathname.startsWith(path)) &&
                  mobileLinkActive,
              )}
              onClick={() => setManageOpen((open) => !open)}
              ref={(element) => {
                manageButton = element;
              }}
              type="button"
            >
              Manage
            </button>
          </Show>
        </nav>
        <Show when={showManage && manageOpen()}>
          <nav aria-label="Manage destinations" class={managePopover} id={MANAGE_POPOVER_ID}>
            <ManageDestinationLink
              active={location().pathname.startsWith('/skills')}
              class={manageLinkClass('/skills')}
              label="Skills"
              onSelect={() => setManageOpen(false)}
              to="/skills"
            />
            <ManageDestinationLink
              active={location().pathname === '/sync'}
              class={manageLinkClass('/sync')}
              label="Sync"
              onSelect={() => setManageOpen(false)}
              to="/sync"
            />
            <ManageDestinationLink
              active={location().pathname === '/sources'}
              class={manageLinkClass('/sources')}
              label="Sources"
              onSelect={() => setManageOpen(false)}
              to="/sources"
            />
            <ThemeToggle />
          </nav>
        </Show>
      </Show>
    </>
  );
};
