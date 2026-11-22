<script lang="ts">
  import type { WorkThreadRow } from '@ai-usage/report-core/work-thread-view';
  import {
    projectShortLabel,
    type ThreadBand,
    threadAge,
    threadDate,
    threadLifecycle,
    threadRecentActivity,
    threadRowMeta,
    type threadSituationCopy,
    threadWaitSince,
    threadWaitSinceLabel,
  } from '../work-thread-model';
  import WorkThreadRail from './work-thread-rail.svelte';

  const STRIP_WIDTH = 70;
  const STRIP_HEIGHT = 18;
  /** A day with sessions never reads as an idle (1 px) or milestone-only (2 px) day. */
  const SESSION_BAR_MIN = 3;

  let {
    row,
    situation,
    band,
    now,
    timeZone,
    href,
    onOpen,
    onKey,
    selected = false,
  }: {
    row: WorkThreadRow;
    situation: ReturnType<typeof threadSituationCopy>;
    band: ThreadBand;
    now: string;
    timeZone: string;
    href: string;
    onOpen: (event: MouseEvent) => void;
    onKey?: (event: KeyboardEvent) => void;
    /** The task shown in the pane beside the list. */
    selected?: boolean;
  } = $props();

  const since = $derived(threadWaitSince(row, situation));
  const sinceLabel = $derived(threadWaitSinceLabel(since.basis));
  const activity = $derived(threadRecentActivity(row.marks, now, timeZone));
  const bars = $derived.by(() => {
    const busiest = Math.max(...activity.days.map((day) => day.sessions));
    const slot = STRIP_WIDTH / activity.days.length;
    return activity.days.map((day, index) => {
      let kind: 'sessions' | 'milestone' | 'idle' = 'idle';
      let height = 1;
      if (day.sessions > 0) {
        kind = 'sessions';
        height = Math.max(SESSION_BAR_MIN, Math.round(((STRIP_HEIGHT - 2) * day.sessions) / busiest));
      } else if (day.milestones > 0) {
        kind = 'milestone';
        height = 2;
      }
      return { key: day.key, kind, height, today: day.today, x: index * slot + slot * 0.15, width: slot * 0.7 };
    });
  });
  const tone = $derived.by((): 'quiet' | 'failed' | 'yours' | 'running' | 'tidy' => {
    if (band === 'dormant' || band === 'done') {
      return 'quiet';
    }
    // A delivered task is tidying, whatever is left on it: its line never reads as urgent.
    if (band === 'to-tidy') {
      return 'tidy';
    }
    if (situation.reason === 'failing-checks' || situation.reason === 'merge-conflict') {
      return 'failed';
    }
    switch (situation.hint) {
      case 'to-resume':
        return 'yours';
      case 'in-progress':
      case 'waiting':
        return 'running';
      case 'ready-to-close':
        return 'tidy';
      default:
        return 'quiet';
    }
  });
</script>

<li
  aria-current={selected ? 'true' : undefined}
  class="wt-pilot-cols wt-row"
  data-band={band}
  data-work-thread={row.thread.threadId}
>
  <span
    class="wt-project-tag"
    title={row.thread.projectLabel ?? undefined}
    class:wt-no-project={row.thread.projectLabel === null}
    >{projectShortLabel(row.thread.projectLabel)}</span
  >
  <div class="wt-row-task">
    <!-- The row's single interactive element; its ::after stretches the click target over the row,
         so its tooltip is the one the pointer meets: it carries the full next step under the title. -->
    <a
      class="wt-row-title"
      {href}
      onclick={onOpen}
      onkeydown={onKey}
      title={`${row.thread.title}\nNext: ${situation.headline}`}
      >{row.thread.title}</a
    >
    <p class="wt-row-meta">{threadRowMeta(row)}</p>
  </div>
  <WorkThreadRail steps={threadLifecycle(row, situation.remainders)} />
  <svg
    aria-label={activity.description}
    class="wt-row-activity"
    height={STRIP_HEIGHT}
    preserveAspectRatio="none"
    role="img"
    viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
    width={STRIP_WIDTH}
  >
    {#each bars as bar (bar.key)}
      <rect
        data-day={bar.kind}
        fill="currentColor"
        height={bar.height}
        width={bar.width}
        x={bar.x}
        y={STRIP_HEIGHT - 1 - bar.height}
        class:wt-today={bar.today}
      />
    {/each}
  </svg>
  <p class="wt-row-next" data-tone={tone}>
    <span class="wt-sr">{'Next: '}</span>{situation.headline}
  </p>
  <time class="wt-row-age" datetime={since.at} title={`${sinceLabel} ${threadDate(since.at, timeZone, false, now)}`}
    ><span class="wt-sr">{`${sinceLabel} `}</span>{threadAge(since.at, now)}</time
  >
</li>
