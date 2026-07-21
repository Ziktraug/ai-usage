import { css } from '@ai-usage/design-system/css';
import {
  commandButton,
  header,
  meta,
  page,
  panel,
  panelSub,
  panelTitle,
  shell,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import { createFileRoute, type ErrorComponentProps, stripSearchParams, useRouter } from '@tanstack/solid-router';
import { createEffect } from 'solid-js';
import { getBrowserRuntimeMode } from '../browser-runtime-mode';
import { Dashboard } from '../dashboard';
import { type DashboardSearch, dashboardSearchDefaultsFor, validateDashboardSearch } from '../dashboard-search';
import { loadReportPayload, type ReportLoaderData } from '../report-runtime';
import { useSourceControl } from '../source-control-context';

const fallbackSort = 'date' as const;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(fallbackSort);

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): DashboardSearch =>
    validateDashboardSearch(search, dashboardSearchDefaults),
  search: {
    middlewares: [stripSearchParams<DashboardSearch>(dashboardSearchDefaults)],
  },
  staleTime: Number.POSITIVE_INFINITY,
  loader: async () => await loadReportPayload(),
  errorComponent: ReportLoadError,
  component: IndexRoute,
});

const statusPanel = css({ display: 'grid', gap: '12px', maxW: '640px' });

const publicationRevision = (sourceControl: ReturnType<typeof useSourceControl>): string | undefined => {
  const state = sourceControl.state();
  return state.publication?.revision ?? state.snapshot?.publication.revision;
};

const runRouteInvalidation = async (invalidate: () => Promise<unknown>): Promise<void> => {
  try {
    await invalidate();
  } catch (error) {
    console.error(error);
  }
};

const ReportErrorShell = (props: { action?: () => void; message?: string; title: string }) => (
  <main class={page} data-hydrated="false">
    <div class={shell}>
      <header class={header}>
        <div class={titleBlock}>
          <p class={meta}>ai-usage</p>
          <h1 class={title}>Usage report</h1>
        </div>
      </header>
      <section aria-live="polite" class={`${panel} ${statusPanel}`}>
        <h2 class={panelTitle}>{props.title}</h2>
        {props.message ? <p class={panelSub}>{props.message}</p> : null}
        {props.action ? (
          <button class={commandButton} onClick={props.action} type="button">
            Retry
          </button>
        ) : null}
      </section>
    </div>
  </main>
);

function ReportLoadError(props: ErrorComponentProps) {
  const router = useRouter();
  const sourceControl = useSourceControl();
  let observedPublicationRevision = publicationRevision(sourceControl);
  const retry = (): void => {
    runRouteInvalidation(() => router.invalidate({ filter: (match) => match.routeId === '/', forcePending: true }));
  };

  createEffect(() => {
    if (
      getBrowserRuntimeMode() === 'e2e' &&
      Reflect.get(globalThis, '__aiUsageE2EDisableReportPublicationRetry') === true
    ) {
      return;
    }
    const revision = publicationRevision(sourceControl);
    if (!revision || revision === observedPublicationRevision) {
      return;
    }
    observedPublicationRevision = revision;
    retry();
  });

  return (
    <ReportErrorShell
      action={retry}
      message={props.error instanceof Error ? props.error.message : 'Report data could not be loaded.'}
      title="Report unavailable"
    />
  );
}

const LoadedReport = (props: { data: ReportLoaderData }) =>
  props.data.kind === 'payload' ? (
    <Dashboard initialPayload={props.data.payload} runtimeMode={props.data.mode} />
  ) : (
    <Dashboard runtimeMode={props.data.mode} servedBootstrap={props.data.bootstrap} />
  );

function IndexRoute() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const sourceControl = useSourceControl();
  let observedPublicationRevision: string | undefined;

  createEffect(() => {
    const revision = publicationRevision(sourceControl);
    if (!revision || revision === observedPublicationRevision) {
      return;
    }
    if (observedPublicationRevision === undefined) {
      observedPublicationRevision = revision;
      return;
    }
    observedPublicationRevision = revision;
    if (data().kind === 'payload') {
      runRouteInvalidation(() => router.invalidate({ filter: (match) => match.routeId === '/' }));
    }
  });

  return <LoadedReport data={data()} />;
}
