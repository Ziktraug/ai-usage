import {
  eyebrow,
  eyebrowRow,
  ghostButton,
  header,
  headerActions,
  headerTop,
  meta,
  navButton,
  page,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  summaryPill,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import { css } from '@ai-usage/design-system/css';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';

export const Route = createFileRoute('/sync')({
  component: SyncRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

const statusBand = css({
  display: 'grid',
  gap: '14px',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 1fr) auto' },
  alignItems: 'center',
  p: '16px 18px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

const statusContent = css({
  display: 'grid',
  gap: '8px',
  minW: 0,
});

const statusTitleRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
});

const statusTitle = css({
  fontSize: '15px',
  fontWeight: 650,
});

const statusMeta = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 12px',
  color: 'muted',
  fontSize: '12px',
});

const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  justifyContent: { base: 'flex-start', lg: 'flex-end' },
});

const summaryGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(4, minmax(0, 1fr))' },
  gap: '12px',
});

const sectionGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 1.35fr) minmax(320px, 0.65fr)' },
  gap: '16px',
  alignItems: 'start',
});

const placeholderList = css({
  display: 'grid',
  gap: '8px',
  color: 'muted',
  fontSize: '13px',
});

function SyncRoute() {
  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <div class={eyebrowRow}>
                <div class={eyebrow}>ai-usage</div>
              </div>
              <h1 class={title}>LAN sync</h1>
              <div class={meta}>Local snapshot serving and remote snapshot management.</div>
            </div>
            <div class={headerActions}>
              <Link to="/" search={dashboardSearchDefaults} class={navButton}>
                Report
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <div class={pageStack}>
          <section class={statusBand}>
            <div class={statusContent}>
              <div class={statusTitleRow}>
                <span class={statusTitle}>Local snapshot server</span>
                <span class={summaryPill}>Not serving</span>
              </div>
              <div class={statusMeta}>
                <span>Host and port controls will appear here.</span>
                <span>Tokens stay process-local when serving is enabled.</span>
              </div>
            </div>
            <div class={actionRow}>
              <button class={ghostButton} type="button" disabled>
                Start
              </button>
              <button class={ghostButton} type="button" disabled>
                Refresh
              </button>
            </div>
          </section>

          <section class={summaryGrid} aria-label="Sync summary">
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelTitle}>Configured remotes</div>
                <div class={panelSub}>Read-only state connects in the next slice.</div>
              </div>
            </div>
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelTitle}>Enabled remotes</div>
                <div class={panelSub}>Remote selection and token state.</div>
              </div>
            </div>
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelTitle}>Stored snapshots</div>
                <div class={panelSub}>Synced usage snapshot summaries.</div>
              </div>
            </div>
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelTitle}>Warnings</div>
                <div class={panelSub}>Sync and transport issues.</div>
              </div>
            </div>
          </section>

          <section class={sectionGrid}>
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelTitle}>Snapshot remotes</div>
                <div class={panelSub}>Configured remotes, pull status, and management actions.</div>
              </div>
              <div class={placeholderList}>
                <span>Name</span>
                <span>Enabled state</span>
                <span>Token status</span>
                <span>Machine and rows</span>
                <span>Last fetched timestamp</span>
              </div>
            </div>

            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelTitle}>Discovery and add remote</div>
                <div class={panelSub}>LAN scan and manual endpoint form.</div>
              </div>
              <div class={placeholderList}>
                <span>Scan default LAN candidates on port 3847.</span>
                <span>Validate `/health` before saving a remote.</span>
                <span>Persist only name, URL, and token environment variable.</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
