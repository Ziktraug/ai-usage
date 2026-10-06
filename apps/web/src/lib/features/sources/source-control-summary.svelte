<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { Popover } from '@ark-ui/svelte/popover';
  import { Portal } from '@ark-ui/svelte/portal';
  import { onDestroy } from 'svelte';
  import { fmtDate } from '../../foundation/presentation/format';
  import { useSourceControl } from './context.svelte';
  import { pendingAriaBusyAttributes } from './model';
  import { presentSourceState, sourceToneClass } from './presentation';
  import { summarizeSourceControlStatus } from './source-control-summary-model';
  import { ghostButton, statusPill } from './styles';

  let { navigationKey = '' }: { navigationKey?: string } = $props();

  const sourceControl = useSourceControl();
  const controlState = $derived(sourceControl.state());
  const snapshot = $derived(controlState.snapshot);
  const status = $derived(summarizeSourceControlStatus(controlState));
  const enabledSources = $derived(snapshot?.sources.filter((source) => source.policy === 'enabled') ?? []);
  const runningSources = $derived(
    snapshot?.sources.filter((source) => source.lifecycle === 'running' || source.lifecycle === 'pausing') ?? [],
  );
  const activeSources = $derived(
    enabledSources.filter(
      (source) =>
        source.lifecycle === 'running' ||
        source.lifecycle === 'pausing' ||
        source.lifecycle === 'queued' ||
        status.warningSources.includes(source.label),
    ),
  );
  const historicalSources = $derived(
    enabledSources.filter(
      (source) => status.historicalSources.includes(source.label) && !activeSources.includes(source),
    ),
  );
  const nextDueSource = $derived(
    enabledSources
      .filter((source) => source.nextDueAt !== undefined)
      .toSorted((left, right) => String(left.nextDueAt).localeCompare(String(right.nextDueAt)))[0],
  );
  const runPending = $derived(controlState.pendingCommand !== null);
  let isOpen = $state(false);
  let hoverOpened = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let contentHasFocus = false;
  let clock = $state(Date.now());

  const cancelClose = (): void => {
    clearTimeout(closeTimer);
  };
  const enter = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') {
      return;
    }
    cancelClose();
    if (!isOpen) {
      hoverOpened = true;
      isOpen = true;
    }
  };
  const leave = (): void => {
    cancelClose();
    if (!hoverOpened) {
      return;
    }
    // Keep the panel reachable across its small positioning gap, and retain it while using its controls.
    closeTimer = setTimeout(() => {
      if (!contentHasFocus) {
        isOpen = false;
      }
    }, 180);
  };
  onDestroy(cancelClose);
  const closeForNavigation = (): void => {
    cancelClose();
    // Route navigation owns focus. A hover preview must never restore focus over a new drawer.
    hoverOpened = true;
    contentHasFocus = false;
    isOpen = false;
  };
  $effect(() => {
    if (navigationKey) {
      closeForNavigation();
    }
  });
  $effect(() => {
    if (!isOpen || runningSources.length === 0) {
      return;
    }
    clock = Date.now();
    const timer = window.setInterval(() => {
      clock = Date.now();
    }, 1000);
    return () => window.clearInterval(timer);
  });
  const elapsed = (startedAt: string | undefined): string =>
    startedAt
      ? `${Math.round(Math.max(0, clock - Date.parse(startedAt)) / 1000)}s elapsed`
      : 'elapsed time unavailable';

  const summary = css({ flexShrink: 0 });
  const trigger = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minH: '44px',
    px: '4px',
    color: 'muted',
    fontSize: '11px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    borderRadius: 'sm',
    _hover: { color: 'ink' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const dot = css({ w: '6px', h: '6px', flexShrink: 0, borderRadius: 'full', bg: 'status.ok' });
  const activeDot = css({ bg: 'accent' });
  const warningDot = css({ bg: 'status.warn' });
  const positioner = css({ zIndex: 70 });
  const card = css({
    zIndex: 70,
    display: 'grid',
    gap: '12px',
    w: '320px',
    maxW: 'calc(100vw - 24px)',
    maxH: 'min(520px, calc(100dvh - 80px))',
    overflowY: 'auto',
    p: '16px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    boxShadow: 'overlay',
    fontSize: '12px',
    lineHeight: 1.5,
  });
  const title = css({ fontSize: '13px', fontWeight: 600 });
  const muted = css({ color: 'muted' });
  const sourceList = css({ display: 'grid', gap: '6px' });
  const sourceRow = css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });
  const attribution = css({ color: 'muted', fontSize: '10px' });
  const actions = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    pt: '8px',
    borderTop: '1px solid token(colors.line)',
    '& a, & button': { minH: '36px' },
  });
  const link = css({
    display: 'inline-flex',
    alignItems: 'center',
    color: 'accent',
    textDecoration: 'none',
    _hover: { textDecoration: 'underline' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
</script>

<section
  aria-label="Collection source status"
  class={summary}
  data-source-summary
  data-source-summary-generation={status.generation ?? ''}
  data-source-summary-phase={status.phase}
>
  <Popover.Root
    autoFocus={false}
    lazyMount
    onOpenChange={(details) => { cancelClose(); isOpen = details.open; if (!details.open) { contentHasFocus = false; } }}
    open={isOpen}
    positioning={{ placement: 'bottom-end', gutter: 8, strategy: 'fixed', overflowPadding: 12 }}
    restoreFocus={!hoverOpened}
    unmountOnExit
  >
    <Popover.Trigger
      aria-label="Collection status"
      class={trigger}
      onclick={() => { hoverOpened = false; }}
      onpointerenter={enter}
      onpointerleave={leave}
      type="button"
    >
      <span
        aria-hidden="true"
        class={cx(dot, status.tone === 'info' && activeDot, (status.tone === 'warning' || status.tone === 'danger') && warningDot)}
      ></span>
      <span aria-live="polite" data-source-summary-status>{status.label}</span>
    </Popover.Trigger>
    <Portal>
      <Popover.Positioner class={positioner}>
        <Popover.Content
          aria-label="Collection details"
          class={card}
          data-source-card
          onfocusin={() => { contentHasFocus = true; hoverOpened = false; }}
          onfocusout={(event) => { contentHasFocus = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget); }}
          onpointerenter={enter}
          onpointerleave={leave}
        >
          <div>
            <p class={title}>Collection</p>
            <p class={muted}>{status.detail}</p>
          </div>
          {#if snapshot}
            {#if activeSources.length > 0}
              <div class={sourceList}>
                {#each activeSources as source (source.id)}
                  {@const presentation = presentSourceState(source)}
                  <div>
                    <div class={sourceRow}>
                      <span>{source.label}</span>
                      <span class={cx(statusPill, sourceToneClass(presentation.tone))}>{presentation.label}</span>
                    </div>
                    {#if source.warnings.length > 0}
                      {#each source.warnings as warning (`${warning.code}:${warning.message ?? ''}`)}
                        <p class={muted}>{warning.message ?? warning.code}</p>
                      {/each}
                    {:else if presentation.tone === 'danger' || presentation.tone === 'warning'}
                      <p class={muted}>{presentation.explanation}</p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
            {#if historicalSources.length > 0}
              <div class={sourceList} data-source-history-notes>
                <p class={muted}>Historical data</p>
                {#each historicalSources as source (source.id)}
                  <div>
                    <p>{source.label}</p>
                    {#each source.warnings as warning (`${warning.code}:${warning.message ?? ''}`)}
                      <p class={muted}>{warning.message ?? warning.code}</p>
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
            {#if runningSources.length > 0}
              <p class={muted}>
                Running:
                {runningSources.map((source) => `${source.label} (${elapsed(source.lastStartedAt)})`).join(', ')}
              </p>
            {/if}
            <div class={muted}>
              <p>{enabledSources.length} enabled collection sources</p>
              {#if snapshot.publication.lastPublishedAt}
                <p>
                  Last report prepared:
                  <time datetime={snapshot.publication.lastPublishedAt}
                    >{fmtDate(snapshot.publication.lastPublishedAt)}</time
                  >
                </p>
              {/if}
              {#if nextDueSource}
                <p>
                  Next check: {nextDueSource.label} ·
                  <time datetime={nextDueSource.nextDueAt}>{fmtDate(nextDueSource.nextDueAt!)}</time>
                </p>
              {/if}
            </div>
            <p class={attribution} data-source-summary-attribution>
              Source status checked at {fmtDate(snapshot.generatedAt)}.
            </p>
          {/if}
          {#if controlState.commandError}
            <p role="alert">{controlState.commandError}</p>
          {/if}
          <div class={actions}>
            <a class={link} href="/sources" onclick={closeForNavigation}>View sources</a>
            <button
              {...pendingAriaBusyAttributes(runPending)}
              class={ghostButton}
              disabled={!snapshot || controlState.connection !== 'live' || runPending}
              onclick={() => sourceControl.execute({ command: 'run-all' }).catch(() => undefined)}
              type="button"
            >
              Collect now
            </button>
          </div>
        </Popover.Content>
      </Popover.Positioner>
    </Portal>
  </Popover.Root>
</section>
