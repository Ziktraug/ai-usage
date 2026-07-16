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
import { createFileRoute, stripSearchParams } from '@tanstack/solid-router';
import { createSignal, ErrorBoundary, onMount, Show } from 'solid-js';
import { Dashboard } from '../dashboard';
import { type DashboardSearch, dashboardSearchDefaultsFor, validateDashboardSearch } from '../dashboard-search';
import { loadReportPayload, type ReportLoaderData } from '../report-runtime';

const fallbackSort = 'date' as const;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(fallbackSort);

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): DashboardSearch =>
    validateDashboardSearch(search, dashboardSearchDefaults),
  search: {
    middlewares: [stripSearchParams<DashboardSearch>(dashboardSearchDefaults)],
  },
  component: IndexRoute,
});

const loadingPanel = css({ display: 'grid', gap: '12px', maxW: '640px' });

const LoadedReport = (props: { data: ReportLoaderData }) =>
  props.data.kind === 'payload' ? (
    <Dashboard initialPayload={props.data.payload} />
  ) : (
    <Dashboard servedBootstrap={props.data.bootstrap} />
  );

function IndexRoute() {
  const [data, setData] = createSignal<ReportLoaderData>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError();
    try {
      setData(await loadReportPayload());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Report data could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    load().catch(() => undefined);
  });

  return (
    <ErrorBoundary fallback={(error) => <pre>{error instanceof Error ? error.message : String(error)}</pre>}>
      <Show
        fallback={
          <main class={page} data-hydrated="false">
            <div class={shell}>
              <header class={header}>
                <div class={titleBlock}>
                  <p class={meta}>ai-usage</p>
                  <h1 class={title}>Usage report</h1>
                </div>
              </header>
              <section aria-live="polite" class={`${panel} ${loadingPanel}`}>
                <h2 class={panelTitle}>{loading() ? 'Loading report data…' : 'Report unavailable'}</h2>
                <Show when={error()}>
                  {(message) => (
                    <>
                      <p class={panelSub}>{message()}</p>
                      <button
                        class={commandButton}
                        onClick={() => {
                          load().catch(() => undefined);
                        }}
                        type="button"
                      >
                        Retry
                      </button>
                    </>
                  )}
                </Show>
              </section>
            </div>
          </main>
        }
        when={data()}
      >
        {(value) => <LoadedReport data={value()} />}
      </Show>
    </ErrorBoundary>
  );
}
