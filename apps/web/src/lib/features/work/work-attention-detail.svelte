<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    HarnessBadge,
    ProvenanceMarker,
    statusPill,
    statusPillInfo,
    statusPillOk,
    statusPillWarn,
  } from '@ai-usage/design-system/svelte';
  import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
  import { type SessionPresentationRow, sessionOriginLabel } from '@ai-usage/report-core/session-query';
  import type { WorkRoot } from '@ai-usage/report-core/work-attention';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';
  import { browser } from '$app/env';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { loadNextCampaignPage } from '../../query/options/campaigns';
  import { optionalSessionLookupQueryOptions } from '../../query/options/session';
  import { sessionCampaignInfiniteOptions } from '../../query/options/session-window';
  import { workRequest } from '../../query/options/work';
  import type { SessionClientAdapter } from '../../rpc/session-client';
  import { sessionRoutePathname } from '../sessions/detail/session-route';
  import {
    formatExactInstant,
    formatRelativeAge,
    groupWorkFactsBySource,
    WORK_FACT_SOURCE_LABELS,
    WORK_STANDING_LABELS,
    workDeclaredStatusLabel,
    workFactInstant,
    workFactSummary,
    workHarnessLabel,
    workRootId,
    workRootLastDecision,
    workRootNextAction,
    workRootStanding,
  } from './work-attention-model';
  import WorkRouting from './work-routing.svelte';
  import {
    workButton,
    workCloseButton,
    workDetail,
    workDetailHeader,
    workDetailLabel,
    workDetailQuestion,
    workDetailQuestionToReconsider,
    workDetailText,
    workDetailTitle,
    workFactItem,
    workFactList,
    workHeading,
    workInterpretation,
    workLink,
    workMarker,
    workMuted,
    workRow,
    workRowTop,
    workStack,
  } from './work-styles';

  let {
    root,
    reference,
    mode,
    sessionClient,
    revision,
    loadedRows,
    providers,
    quotaUnavailable,
    onClose,
    closeButton = $bindable(),
  }: {
    root: WorkRoot;
    reference: string;
    mode: RuntimeMode;
    sessionClient: SessionClientAdapter;
    revision: string;
    /** Served rows already on the page; the joined Session is taken from here before any lookup. */
    loadedRows: readonly SessionPresentationRow[];
    providers: readonly ProviderStatus[];
    quotaUnavailable: boolean;
    onClose: () => void;
    closeButton?: HTMLButtonElement | undefined;
  } = $props();

  let childrenOpen = $state(false);
  const id = $derived(workRootId(root));
  const loadedRow = $derived(root.session ? loadedRows.find((row) => row.rowId === root.session?.rowId) : undefined);
  const lookup = createQuery(() =>
    optionalSessionLookupQueryOptions(
      sessionClient,
      root.session && !loadedRow ? { revision, rowId: root.session.rowId } : undefined,
      { browser },
    ),
  );
  const sessionRow = $derived(loadedRow ?? (lookup.data?.ok ? (lookup.data.data.row ?? undefined) : undefined));
  const campaignKey = $derived(root.session?.campaignKey ?? null);
  const children = createInfiniteQuery(() => ({
    ...sessionCampaignInfiniteOptions(sessionClient, workRequest(revision), campaignKey ?? 'none', 'campaign-sessions'),
    enabled: browser && childrenOpen && campaignKey !== null,
  }));
  const members = $derived(children.data?.pages.flatMap((page) => page.items) ?? []);
  const factGroups = $derived(groupWorkFactsBySource(root.facts));
  const detailHref = (rowId: string) => `${sessionRoutePathname({ kind: 'session', rowId })}?tab=sessions&range=all`;
  const statusTones = { blocked: statusPillWarn, completed: statusPillOk, review_ready: statusPillInfo } as const;
  const standing = $derived(workRootStanding(root));
  const decision = $derived(workRootLastDecision(root));
  const next = $derived(workRootNextAction(root));
  const request = $derived(
    root.declared?.needsAction ?? (root.declared?.status === 'review_ready' ? 'Review requested' : null),
  );
  const resetChildren = (_id: string): void => {
    childrenOpen = false;
  };
  $effect(() => resetChildren(id));
</script>

<article aria-labelledby="work-detail-heading" class={workDetail} data-work-detail={id}>
  <header class={workDetailHeader}>
    <div class={workStack}>
      <div class={workRowTop}>
        <HarnessBadge name={workHarnessLabel(root.key.harness)} />
        {#if root.titleSource === 'auto'}
          <span class={workMarker}>title: automatic</span>
        {/if}
        {#if root.archived}
          <span class={workMarker}>archived</span>
        {/if}
      </div>
      <h2 class={workDetailTitle} id="work-detail-heading">{root.title}</h2>
    </div>
    <button aria-label="Close detail" class={workCloseButton} onclick={onClose} type="button" bind:this={closeButton}>
      Close
    </button>
  </header>

  <!-- Request first, then its context, the last decision and the next action; diagnostics follow. -->
  <section aria-labelledby="work-detail-request" class={workStack} data-work-request={standing}>
    <h3 class={workDetailLabel} id="work-detail-request">Request · {WORK_STANDING_LABELS[standing]}</h3>
    {#if request}
      <p class={standing === 'current' ? workDetailQuestion : workDetailQuestionToReconsider} data-work-question>
        {request}
      </p>
    {/if}
    {#if root.declared && request}
      <p class={workMuted}>
        asked
        <time datetime={root.declared.at} title={formatExactInstant(root.declared.at)}
          >{formatRelativeAge(root.declared.at, reference)}</time
        >
        · {formatExactInstant(root.declared.at)}
      </p>
    {/if}
    <p class={workMuted} data-work-context>
      {root.project.label}
      {#if root.project.branch}
        · {root.project.branch}{root.project.worktreeName ? ` (worktree ${root.project.worktreeName})` : ''}
      {/if}
      {#if root.project.checkoutPath}
        · {root.project.checkoutPath}
      {/if}
      · {root.key.machineId}
    </p>
    {#if root.project.servedLabel !== null && root.project.servedLabel !== root.project.label}
      <p class={workMuted} data-work-served-label>report project: {root.project.servedLabel}</p>
    {/if}
    {#if decision}
      <p class={workDetailText} data-work-decision>
        Last decision: {decision.text}
        {#if decision.instant}
          · {decision.instantLabel}
          <time datetime={decision.instant} title={formatExactInstant(decision.instant)}
            >{formatExactInstant(decision.instant)}</time
          >
        {/if}
      </p>
    {/if}
    {#if next}
      <p class={workDetailText} data-work-next>Next: {next}</p>
    {/if}
  </section>

  <section aria-labelledby="work-detail-declaration" class={workStack}>
    <h3 class={workDetailLabel} id="work-detail-declaration">Declared by the session</h3>
    {#if root.declared}
      <div class={workRow}>
        <span class={cx(statusPill, statusTones[root.declared.status])}
          >{workDeclaredStatusLabel(root.declared.status)}</span
        >
        {#if !request}
          <!-- A request already carries this date above, as the time it was asked. -->
          <span class={workMuted}>
            declared
            <time datetime={root.declared.at} title={formatExactInstant(root.declared.at)}
              >{formatRelativeAge(root.declared.at, reference)}</time
            >
            · {formatExactInstant(root.declared.at)}
          </span>
        {/if}
      </div>
      <p class={workDetailText}>{root.declared.detail}</p>
      <p class={workMuted}>
        Declared by the session at {formatExactInstant(root.declared.at)}; its current state is unobserved.
      </p>
    {:else if root.attention === 'not-observable'}
      <!-- ADR 0059: the harness declares nothing, so nothing is presented as pending or as settled. -->
      <p class={workMuted} data-work-not-declared-detail>
        {workHarnessLabel(root.key.harness)}
        records no turn declaration for its sessions: whether this one waits on you is unknown — not declared by this
        harness. Last activity
        {#if root.age.lastActivityAt}
          <time datetime={root.age.lastActivityAt} title={formatExactInstant(root.age.lastActivityAt)}
            >{formatRelativeAge(root.age.lastActivityAt, reference)}</time
          >
          ({formatExactInstant(root.age.lastActivityAt)}).
        {:else}
          is undated.
        {/if}
      </p>
    {:else}
      <p class={workMuted}>
        No turn declaration was collected for this root. Last activity
        {#if root.age.lastActivityAt}
          <time datetime={root.age.lastActivityAt} title={formatExactInstant(root.age.lastActivityAt)}
            >{formatRelativeAge(root.age.lastActivityAt, reference)}</time
          >
          ({formatExactInstant(root.age.lastActivityAt)}).
        {:else}
          is undated.
        {/if}
      </p>
    {/if}
  </section>

  {#if root.interpretations.length > 0}
    <section aria-labelledby="work-detail-interpretations" class={workStack}>
      <h3 class={workDetailLabel} id="work-detail-interpretations">Interpretations</h3>
      {#each root.interpretations as entry, index (`${entry.kind}:${index}`)}
        <div class={workInterpretation}>
          <p class={workDetailText}>{entry.text}</p>
          <p class={workMuted}>Uncertainty: {entry.uncertainty}</p>
        </div>
      {/each}
    </section>
  {/if}

  <section aria-labelledby="work-detail-facts" class={workStack}>
    <h3 class={workDetailLabel} id="work-detail-facts">Facts by source</h3>
    {#if factGroups.length === 0}
      <p class={workMuted}>No dated fact was collected for this root.</p>
    {/if}
    {#each factGroups as group (group.source)}
      <div class={workStack}>
        <h4 class={workMuted}>{WORK_FACT_SOURCE_LABELS[group.source]}</h4>
        <ul class={workFactList}>
          {#each group.facts as fact (fact.id)}
            {@const instant = workFactInstant(fact)}
            <li class={workFactItem}>
              <span>
                {workFactSummary(fact, root)}
                · <time datetime={instant} title={formatExactInstant(instant)}>{formatExactInstant(instant)}</time>
              </span>
              <ProvenanceMarker
                facts={[
                  {
                    description: `${WORK_FACT_SOURCE_LABELS[fact.provenance.source]} on ${fact.provenance.machineId}, observed ${formatExactInstant(fact.provenance.observedAt)}, ${fact.provenance.coverage} coverage`,
                    label: 'Provenance',
                    severity: fact.provenance.coverage === 'partial' ? 'warning' : 'info',
                  },
                ]}
              />
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </section>

  <section aria-labelledby="work-detail-children" class={workStack}>
    <h3 class={workDetailLabel} id="work-detail-children">Children and related sessions</h3>
    {#if root.children.count > 0}
      <p class={workDetailText}>
        {root.children.count}
        child {root.children.count === 1 ? 'session' : 'sessions'}
        {#if root.attention === 'not-observable'}
          · linked by their declared parent in {workHarnessLabel(root.key.harness)}; their outcomes are not declared
        {:else}
          · {root.children.blocked} blocked · {root.children.reviewReady} review ready ·
          {root.children.completed}
          completed
        {/if}
      </p>
      {#if root.children.titles.length > 0}
        <ul class={workFactList}>
          {#each root.children.titles as title, index (`${index}:${title}`)}
            <li class={workMuted}>{title}</li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p class={workMuted}>No child session declared under this root.</p>
    {/if}
    {#if campaignKey}
      <details
        ontoggle={(event) => {
          childrenOpen = event.currentTarget.open;
        }}
      >
        <summary class={workLink}>Related served sessions</summary>
        {#if childrenOpen}
          {#if children.error}
            <p class={workMuted} role="alert">Related sessions could not be read at this revision.</p>
            <button class={workButton} onclick={() => children.refetch()} type="button">Retry related sessions</button>
          {:else if children.isPending}
            <p class={workMuted} role="status">Reading related sessions…</p>
          {:else if members.length === 0}
            <p class={workMuted}>No related session at this revision.</p>
          {:else}
            <ul class={workFactList}>
              {#each members as member (member.rowId)}
                <li class={workMuted}>
                  <a class={workLink} href={detailHref(member.rowId)}
                    >{member.sessionLabel || member.name || 'Untitled session'}</a
                  >
                  · {member.origin ? sessionOriginLabel(member.origin) : 'Origin undeclared'}
                </li>
              {/each}
            </ul>
            {#if children.hasNextPage}
              <button
                class={workButton}
                disabled={children.isFetching}
                onclick={() => loadNextCampaignPage(children)}
                type="button"
              >
                Load more related sessions
              </button>
            {/if}
          {/if}
        {/if}
      </details>
    {/if}
  </section>

  <section aria-labelledby="work-detail-links" class={workStack}>
    <h3 class={workDetailLabel} id="work-detail-links">Transcript</h3>
    {#if root.session}
      <a class={workLink} href={detailHref(root.session.rowId)}>Open session detail</a>
    {:else}
      <p class={workMuted}>Transcript not collected yet; there is no session detail to open.</p>
    {/if}
  </section>

  <section aria-labelledby="work-routing-heading" class={workStack}>
    <h3 class={workHeading} id="work-routing-heading">Review assignment simulation</h3>
    {#if sessionRow}
      <p class={workMuted}>
        Simulates a read-only review of “{root.title}” on its collected Session. Nothing is started.
      </p>
      <WorkRouting {mode} {providers} {quotaUnavailable} target={sessionRow} />
    {:else if root.session && lookup.isPending}
      <p class={workMuted} role="status">Resolving the collected Session for this root…</p>
    {:else if root.session}
      <p class={workMuted} role="status">
        The collected Session could not be resolved at this revision; no review target is identified.
      </p>
    {:else}
      <p class={workMuted}>
        No collected transcript identifies a review target for this root. A simulation needs the joined Session.
      </p>
    {/if}
  </section>
</article>
