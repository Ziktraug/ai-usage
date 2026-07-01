import { css } from '@ai-usage/design-system/css';
import {
  dateCell,
  header,
  headerActions,
  headerTop,
  meta,
  muted,
  navButton,
  page,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  strongCell,
  summaryPill,
  table,
  tableWrap,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createMemo, For, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import { getSkillManagementSnapshot } from '../server/skills';
import { buildSkillSummaryTiles, projectionStateLabel, skillProjectionSummary } from '../skills-page-model';

export const Route = createFileRoute('/skills')({
  loader: async () => ({
    skills: await getSkillManagementSnapshot(),
  }),
  component: SkillsRoute,
});

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

type SkillSnapshotResult =
  | { ok: true; data: SkillManagementSnapshot }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

const skillSnapshotResultFrom = (value: unknown): SkillSnapshotResult => {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return { ok: false, error: { message: 'Invalid skills snapshot response', tag: 'InvalidResponse' } };
  }
  return value as SkillSnapshotResult;
};

const summaryGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(5, minmax(0, 1fr))' },
  gap: '12px',
});

const sectionGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 1.15fr) minmax(320px, 0.85fr)' },
  gap: '16px',
  alignItems: 'start',
});

const stack = css({
  display: 'grid',
  gap: '12px',
});

const emptyState = css({
  p: '18px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.6,
});

const tableCompact = css({
  minW: '760px',
});

const statusText = css({
  display: 'inline-flex',
  alignItems: 'center',
  h: '22px',
  px: '8px',
  borderRadius: 'full',
  border: '1px solid token(colors.line)',
  bg: 'surface',
  fontSize: '11px',
  fontWeight: 650,
});

function SkillsRoute() {
  const data = Route.useLoaderData();
  const result = createMemo(() => skillSnapshotResultFrom(data().skills));
  const snapshot = createMemo(() => {
    const current = result();
    return current.ok ? current.data : undefined;
  });
  const errorMessage = createMemo(() => {
    const current = result();
    return current.ok ? '' : current.error.message;
  });
  const summaryTiles = createMemo(() => (snapshot() ? buildSkillSummaryTiles(snapshot()!) : []));

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <h1 class={title}>Skill management</h1>
              <div class={meta}>
                <Show fallback="Snapshot unavailable" when={snapshot()}>
                  {(value) =>
                    value().configured
                      ? `Source ${value().config.sourceRepoPath ?? 'not configured'}`
                      : 'Skill source repository not configured'
                  }
                </Show>
              </div>
            </div>
            <div class={headerActions}>
              <Link class={navButton} search={dashboardSearchDefaults} to="/">
                Report
              </Link>
              <Link class={navButton} to="/sync">
                Sync
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <div class={pageStack}>
          <Show fallback={<ErrorPanel message={errorMessage()} />} when={result().ok}>
            <Show fallback={<UnconfiguredPanel />} when={snapshot()}>
              {(loadedSnapshot) => (
                <Show fallback={<UnconfiguredPanel />} when={loadedSnapshot().configured}>
                  <ConfiguredSnapshot snapshot={loadedSnapshot()} summaryTiles={summaryTiles()} />
                </Show>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </main>
  );
}

function ConfiguredSnapshot(props: {
  snapshot: SkillManagementSnapshot;
  summaryTiles: readonly ReturnType<typeof buildSkillSummaryTiles>[number][];
}) {
  return (
    <>
      <section class={summaryGrid}>
        <For each={props.summaryTiles}>
          {(tile) => (
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelSub}>{tile.label}</div>
                <div class={panelTitle}>{tile.value}</div>
              </div>
            </div>
          )}
        </For>
      </section>

      <section class={sectionGrid}>
        <div class={stack}>
          <SkillsTable snapshot={props.snapshot} />
          <UnmanagedTable snapshot={props.snapshot} />
        </div>
        <div class={stack}>
          <TargetsTable snapshot={props.snapshot} />
          <DiagnosticsPanel snapshot={props.snapshot} />
          <NativeRulesPanel />
        </div>
      </section>
    </>
  );
}

function ErrorPanel(props: { message: string }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Snapshot error</h2>
        <p class={panelSub}>{props.message}</p>
      </div>
    </section>
  );
}

function UnconfiguredPanel() {
  return (
    <section class={emptyState}>
      Configure <span class={strongCell}>skills.sourceRepoPath</span> in the ai-usage config to load the local skill
      source repository.
    </section>
  );
}

function SkillsTable(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section>
      <div class={tableWrap}>
        <table class={`${table} ${tableCompact}`}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Enabled</th>
              <th>Tokens</th>
              <th>Validation</th>
              <th>Targets</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.snapshot.skills}>
              {(skill) => (
                <tr>
                  <td class={strongCell}>{skill.name}</td>
                  <td>{skill.description || <span class={muted}>No description</span>}</td>
                  <td>{skill.enabled ? 'Enabled' : 'Disabled'}</td>
                  <td class={dateCell}>{skill.tokenCount?.total ?? 0} approx</td>
                  <td>
                    <span class={statusText}>{skill.validationStatus}</span>
                  </td>
                  <td>{skillProjectionSummary(skill, props.snapshot.projections)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TargetsTable(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Targets</h2>
        <p class={panelSub}>{props.snapshot.summary.targetCount} configured runtime targets</p>
      </div>
      <div class={stack}>
        <For each={props.snapshot.targets}>
          {(target) => (
            <div>
              <div class={strongCell}>{target.label}</div>
              <div class={meta}>
                {target.enabled ? 'Enabled' : 'Disabled'} · {target.missing ? 'Missing directory' : 'Observed'} ·{' '}
                {target.path}
              </div>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

function UnmanagedTable(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Unmanaged target entries</h2>
        <p class={panelSub}>{props.snapshot.summary.unmanagedEntryCount} entries outside managed source skills</p>
      </div>
      <Show
        fallback={<p class={meta}>No unmanaged target entries.</p>}
        when={props.snapshot.unmanagedEntries.length > 0}
      >
        <div class={stack}>
          <For each={props.snapshot.unmanagedEntries}>
            {(entry) => (
              <div>
                <span class={summaryPill}>{projectionStateLabel(entry.state)}</span>
                <div class={meta}>{entry.expectedPath}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function DiagnosticsPanel(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Diagnostics</h2>
        <p class={panelSub}>{props.snapshot.summary.diagnosticCount} findings</p>
      </div>
      <Show fallback={<p class={meta}>No diagnostics.</p>} when={props.snapshot.diagnostics.length > 0}>
        <div class={stack}>
          <For each={props.snapshot.diagnostics}>
            {(diagnostic) => (
              <div>
                <span class={summaryPill}>{diagnostic.severity}</span>
                <div class={strongCell}>{diagnostic.code}</div>
                <div class={meta}>{diagnostic.message}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function NativeRulesPanel() {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Native rules</h2>
        <p class={panelSub}>Read-only diagnostics will appear here when local project paths are configured.</p>
      </div>
    </section>
  );
}
