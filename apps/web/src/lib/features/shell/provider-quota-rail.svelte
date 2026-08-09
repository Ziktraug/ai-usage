<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';
  import type { HarnessKey } from '@ai-usage/report-core/harness-metadata';

  const panel = css({
    position: 'relative',
    mb: '10px',
    pt: '12px',
    borderTop: '1px solid token(colors.line)',
    // A pointer reveals the detail by hovering; the trigger below reveals it by click or keyboard.
    // The native `title` this replaces waits about a second, which is unusable when the ring is the
    // only affordance at icon width — and the navigation links in this rail already label themselves
    // the same way, in CSS, with no tooltip machine mounted on every route.
    //
    // Both openings are descendant selectors rather than a toggled utility class: `display: none` and
    // `display: grid` are two atomic rules of equal specificity, so a class swap would be decided by
    // stylesheet order instead of by state.
    '&:hover [data-quota-flyout], &[data-quota-open="true"] [data-quota-flyout]': { display: 'grid' },
  });
  const trigger = css({
    display: 'grid',
    gap: { md: '6px', xl: '3px' },
    w: 'full',
    p: 0,
    border: 0,
    borderRadius: 'md',
    bg: 'transparent',
    cursor: 'pointer',
    textAlign: 'start',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const groupLabel = css({
    display: { md: 'none', xl: 'block' },
    px: '10px',
    pb: '5px',
    color: 'muted',
    fontSize: '10px',
    fontWeight: 750,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  });
  const providerRow = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: { md: 'center', xl: 'flex-start' },
    gap: '9px',
    minH: '30px',
    px: { md: 0, xl: '10px' },
  });
  const providerName = css({
    display: { md: 'none', xl: 'block' },
    flex: 1,
    minW: 0,
    color: 'ink',
    fontSize: '12px',
    fontWeight: 650,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const providerValue = css({
    display: { md: 'none', xl: 'block' },
    color: 'ink',
    fontSize: '12px',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
  });
  const providerValueAbsent = css({ color: 'faint', fontWeight: 600 });
  // Identity lives on the mark, wearing the harness token that names the same provider throughout the
  // report. The ring around it is then free to carry pressure without the two encodings colliding.
  const markTones: Record<HarnessKey, string> = {
    claude: css({ color: 'harness.claude.fg' }),
    codex: css({ color: 'harness.codex.fg' }),
    cursor: css({ color: 'harness.cursor.fg' }),
    opencode: css({ color: 'harness.opencode.fg' }),
  };
  // Identity survives a missing measurement — a provider does not stop being Cursor because nothing
  // reads its quota. The hue is kept and only its emphasis drops, so the colour code stays legible
  // across the whole column while the dashed track carries "not measured" on its own.
  const markUnmeasured = css({ opacity: 0.5 });

  const flyout = css({
    position: 'absolute',
    insetInlineStart: '100%',
    bottom: 0,
    zIndex: 60,
    display: 'none',
    gap: '13px',
    w: '286px',
    ml: '10px',
    p: '14px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'overlay',
    _print: { display: 'none' },
  });
  const flyoutTitle = css({
    color: 'muted',
    fontSize: '10px',
    fontWeight: 750,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  });
  const flyoutProvider = css({ display: 'grid', gap: '5px' });
  const flyoutTop = css({ display: 'flex', alignItems: 'center', gap: '8px' });
  const flyoutName = css({ flex: 1, color: 'ink', fontSize: '13px', fontWeight: 700 });
  const flyoutHeadline = css({ color: 'ink', fontSize: '13px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' });
  const flyoutReason = css({ color: 'muted', fontSize: '11px' });
  // Window labels run long — a per-model weekly cap is named after the model. Pinning the percentage
  // on the label's own line and dropping the reset time beneath it lets the name wrap without ever
  // colliding with its value, which is the same two-line shape the Overview panel uses.
  const windowRow = css({ display: 'grid', gap: '1px' });
  const windowTop = css({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '10px',
    color: 'muted',
    fontSize: '11px',
  });
  const windowLabel = css({ minW: 0, overflowWrap: 'anywhere' });
  const windowValue = css({
    color: 'ink',
    flexShrink: 0,
    fontWeight: 650,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  });
  const windowMeta = css({ color: 'faint', fontSize: '10px' });
  // The providers nothing measures are stated once, together. Three identical "No quota source"
  // blocks would spend the flyout's height repeating an absence the rings above already show.
  const unmeasuredGroup = css({
    display: 'grid',
    gap: '6px',
    pt: '10px',
    borderTop: '1px solid token(colors.line)',
  });
  const unmeasuredMarks = css({ display: 'flex', alignItems: 'center', gap: '7px' });
  const unmeasuredNote = css({ color: 'muted', fontSize: '11px' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { fmtDate, fmtPct } from '../../foundation/presentation/format';
  import ProviderMark from './provider-mark.svelte';
  import type { ProviderQuotaRailEntry } from './provider-quota-rail';
  import QuotaRing from './quota-ring.svelte';

  let { entries }: { entries: readonly ProviderQuotaRailEntry[] } = $props();

  const flyoutId = 'app-provider-quota';
  let detailsOpen = $state(false);

  // A column of four dashes is not worth a permanent slot in the rail. It earns its place once one
  // provider reports a number, or one of them needs an action taken.
  // A provider earns a full block in the flyout when it has something to say — a measurement, or a
  // failure the reader can act on. Everything else is collapsed into the single closing note.
  const reported = $derived(entries.filter((entry) => entry.measured || entry.severity === 'danger'));
  const unreported = $derived(entries.filter((entry) => !(entry.measured || entry.severity === 'danger')));
  const worthShowing = $derived(reported.length > 0);
  const unmeasuredNoteText = $derived(
    `No quota source for ${unreported.map((entry) => entry.label).join(', ')}. Codex is the only provider publishing one today.`,
  );
  const headline = (entry: ProviderQuotaRailEntry): string =>
    entry.usedPercent === null ? '—' : fmtPct(entry.usedPercent);
  const context = (entry: ProviderQuotaRailEntry): string =>
    [entry.reason, entry.planLabel, entry.machineLabel].filter((value) => value !== null).join(' · ');

  $effect(() => {
    if (!detailsOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        detailsOpen = false;
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  });
</script>

{#snippet providerRing(_entry: ProviderQuotaRailEntry, _size: number)}
  {#snippet centerMark()}
    <span class={cx(markTones[_entry.key], _entry.measured ? undefined : markUnmeasured)}>
      <ProviderMark name={_entry.key} size={_size <= 26 ? 12 : 13} />
    </span>
  {/snippet}
  <QuotaRing center={centerMark} severity={_entry.severity} size={_size} usedPercent={_entry.usedPercent} />
{/snippet}

{#snippet triggerBody()}
  <span aria-hidden="true" class={groupLabel}>Quota</span>
  {#each entries as entry (entry.key)}
    <span aria-hidden="true" class={providerRow} data-provider-quota={entry.key}>
      {@render providerRing(entry, 26)}
      <span class={providerName}>{entry.label}</span>
      <span class={cx(providerValue, entry.usedPercent === null ? providerValueAbsent : undefined)}>
        {headline(entry)}
      </span>
    </span>
  {/each}
{/snippet}

{#if worthShowing}
  <div class={panel} data-provider-quota-rail data-quota-open={detailsOpen ? 'true' : 'false'}>
    <!-- Duplicated per `aria-expanded` state to keep the value a literal, the same shape
         `manage-button.svelte` uses; the body itself stays single-sourced in the snippet above. -->
    {#if detailsOpen}
      <button
        aria-controls={flyoutId}
        aria-expanded="true"
        aria-label="Provider quota"
        class={trigger}
        onclick={() => {
          detailsOpen = false;
        }}
        type="button"
      >
        {@render triggerBody()}
      </button>
    {:else}
      <button
        aria-controls={flyoutId}
        aria-expanded="false"
        aria-label="Provider quota"
        class={trigger}
        onclick={() => {
          detailsOpen = true;
        }}
        type="button"
      >
        {@render triggerBody()}
      </button>
    {/if}

    <div class={flyout} data-quota-flyout id={flyoutId}>
      <div class={flyoutTitle}>Current quota</div>
      {#each reported as entry (entry.key)}
        <div class={flyoutProvider}>
          <div class={flyoutTop}>
            {@render providerRing(entry, 28)}
            <span class={flyoutName}>{entry.label}</span>
            <span class={flyoutHeadline}>{headline(entry)}</span>
          </div>
          <div class={flyoutReason}>{context(entry)}</div>
          {#each entry.windows as window (window.id)}
            <div class={windowRow}>
              <div class={windowTop}>
                <span class={windowLabel}>{window.label}{window.blocked ? ' · blocked' : ''}</span>
                <span class={windowValue}>{window.usedPercent === null ? '—' : fmtPct(window.usedPercent)}</span>
              </div>
              <div class={windowMeta}>
                {window.resetsAt ? `Resets ${fmtDate(window.resetsAt)}` : 'Reset time unknown'}
              </div>
            </div>
          {/each}
        </div>
      {/each}
      {#if unreported.length > 0}
        <div class={unmeasuredGroup}>
          <div class={unmeasuredMarks}>
            {#each unreported as entry (entry.key)}
              <span class={cx(markTones[entry.key], markUnmeasured)}>
                <ProviderMark name={entry.key} size={14} />
              </span>
            {/each}
          </div>
          <div class={unmeasuredNote}>{unmeasuredNoteText}</div>
        </div>
      {/if}
    </div>
  </div>
{/if}
