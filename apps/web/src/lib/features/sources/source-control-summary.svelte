<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { useSourceControl } from './context.svelte';
  import { pendingAriaBusyAttributes } from './model';
  import { presentSourceState, sourceToneClass } from './presentation';
  import { ghostButton, statusPill } from './styles';

  const sourceControl = useSourceControl();
  const state = $derived(sourceControl.state());
  const snapshot = $derived(state.snapshot);
  const enabledSources = $derived(snapshot?.sources.filter((source) => source.policy === 'enabled') ?? []);
  const warningCount = $derived(
    enabledSources.filter((source) => ['danger', 'warning'].includes(presentSourceState(source).tone)).length,
  );
  const runningSources = $derived(
    snapshot?.sources.filter((source) => source.lifecycle === 'running' || source.lifecycle === 'pausing') ?? [],
  );
  const queuedSources = $derived(snapshot?.sources.filter((source) => source.lifecycle === 'queued') ?? []);
  const nextDueSource = $derived(
    snapshot?.sources
      .filter((source) => source.nextDueAt !== undefined)
      .toSorted((left, right) => String(left.nextDueAt).localeCompare(String(right.nextDueAt)))[0],
  );
  const statusLabel = $derived.by(() => {
    if (!snapshot) {
      return state.connection === 'connecting' ? 'Connecting' : 'Unavailable';
    }
    if (state.connection === 'protocol-mismatch') {
      return 'Incompatible';
    }
    if (state.connection === 'disconnected') {
      return 'Reconnecting';
    }
    if (warningCount > 0) {
      return `${warningCount} warning${warningCount === 1 ? '' : 's'}`;
    }
    if (snapshot.runningCount > 0) {
      return `${snapshot.runningCount} running`;
    }
    return 'Sources ready';
  });
  const statusTone = $derived.by(() => {
    if (!snapshot || state.connection === 'disconnected' || state.connection === 'protocol-mismatch') {
      return 'warning';
    }
    return warningCount > 0 ? 'danger' : 'ok';
  });
  const runPending = $derived(state.pendingCommand !== null);
  let hasFocus = $state(false);
  let isHovered = $state(false);
  let clock = $state(Date.now());

  $effect(() => {
    if (!(hasFocus || isHovered) || runningSources.length === 0) {
      return;
    }
    clock = Date.now();
    const timer = window.setInterval(() => {
      clock = Date.now();
    }, 1000);
    return () => window.clearInterval(timer);
  });

  const elapsed = (startedAt: string | undefined): string => {
    if (!startedAt) {
      return 'elapsed time unavailable';
    }
    return `${Math.round(Math.max(0, clock - Date.parse(startedAt)) / 1000)}s elapsed`;
  };

  const summary = css({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    ml: { base: '0', md: 'auto' },
  });
  const summaryLink = css({
    display: 'inline-flex',
    flex: '1 1 auto',
    alignItems: 'center',
    gap: '6px',
    minW: 0,
    h: '36px',
    px: '10px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    fontSize: '12px',
    fontWeight: 650,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    _focus: { '& [data-source-card]': { display: 'grid' } },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _hover: { '& [data-source-card]': { display: 'grid' } },
  });
  const summaryDot = css({ w: '8px', h: '8px', borderRadius: 'full', bg: 'status.ok' });
  const summaryDotWarn = css({ bg: 'status.warn' });
  const summaryDotDanger = css({ bg: 'status.danger' });
  const summaryLabel = css({ minW: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  const card = css({
    display: 'none',
    position: 'absolute',
    zIndex: 40,
    top: 'calc(100% + 8px)',
    right: '0',
    width: 'min(360px, calc(100vw - 40px))',
    gap: '10px',
    p: '12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'lg',
  });
  const cardHeader = css({ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' });
  const cardTitle = css({ fontSize: '13px', fontWeight: 700 });
  const cardMeta = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });
  const sourceList = css({ display: 'grid', gap: '6px' });
  const sourceRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'center',
    minW: 0,
  });
  const sourceLabel = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' });
</script>

<section aria-label="Collection source status" class={summary}>
  <a
    class={summaryLink}
    href="/sources"
    onblur={() => (hasFocus = false)}
    onfocus={() => (hasFocus = true)}
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
  >
    <span
      aria-hidden="true"
      class={cx(summaryDot, statusTone === 'warning' ? summaryDotWarn : undefined, statusTone === 'danger' ? summaryDotDanger : undefined)}
    ></span>
    <span class={summaryLabel}>{statusLabel}</span>
    <div class={card} data-source-card>
      <div class={cardHeader}>
        <span class={cardTitle}>Collection sources</span
        ><span class={cx(statusPill, sourceToneClass(statusTone))}>{statusLabel}</span>
      </div>
      {#if snapshot}
        <div class={sourceList}>
          {#each enabledSources as source (source.id)}
            {@const presentation = presentSourceState(source)}
            <div class={sourceRow}>
              <span class={sourceLabel} title={`${source.label}: ${presentation.explanation}`}>{source.label}</span
              ><span class={cx(statusPill, sourceToneClass(presentation.tone))}>{presentation.label}</span>
            </div>
          {/each}
        </div>
        {#if runningSources.length > 0}
          <p class={cardMeta}>
            Running: {runningSources.map((source) => `${source.label} (${elapsed(source.lastStartedAt)})`).join(', ')}
          </p>
        {/if}
        {#if queuedSources.length > 0}
          <p class={cardMeta}>Queued: {queuedSources.map((source) => source.label).join(', ')}</p>
        {/if}
        {#if nextDueSource}
          <p class={cardMeta}>Next due: {nextDueSource.label} at {nextDueSource.nextDueAt}</p>
        {/if}
        <p class={cardMeta}>
          Last success:
          {enabledSources.flatMap((source) => source.lastSuccessAt ? [source.lastSuccessAt] : []).toSorted().at(-1) ?? 'none yet'}
        </p>
      {:else}
        <p class={cardMeta}>Waiting for the server-owned source snapshot.</p>
      {/if}
    </div>
  </a>
  <button
    {...pendingAriaBusyAttributes(runPending)}
    class={ghostButton}
    disabled={!snapshot || state.connection !== 'live' || runPending}
    onclick={() => sourceControl.execute({ command: 'run-all' }).catch(() => undefined)}
    type="button"
  >
    Run all
  </button>
</section>
