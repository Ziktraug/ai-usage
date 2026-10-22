<script lang="ts">
  import { isLiveReviewAttemptState } from '@ai-usage/report-core/work-attempts';
  import type { WorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
  import { sessionRoutePathname } from '../sessions/detail/session-route';
  import {
    checkoutOriginLabel,
    DIRTY_TREE_TEXT,
    guaranteeSummary,
    reservationNotice,
    resultHeading,
    reviewAttemptStateLabel,
    scopeSummary,
    shortAttemptId,
  } from './work-attempts-model';
  import { formatExactInstant, formatRelativeAge } from './work-attention-model';
  import { workExcerpt, workFactList, workHeading, workLink, workMuted, workPanel, workStack } from './work-styles';

  let {
    attempts,
    pending,
  }: {
    /** The list envelope; `null` when it could not be read at all. */
    attempts: WorkAttemptsListOutput | null;
    pending: boolean;
  } = $props();
  const reference = $derived(attempts?.ok ? attempts.data.generatedAt : new Date().toISOString());
  const detailHref = (rowId: string) => `${sessionRoutePathname({ kind: 'session', rowId })}?tab=sessions&range=all`;
  const when = (instant: string): string => `${formatRelativeAge(instant, reference)} (${formatExactInstant(instant)})`;
</script>

<section aria-labelledby="work-attempts-heading" class={workStack} data-work-attempts>
  <h4 class={workHeading} id="work-attempts-heading">Review attempts</h4>
  {#if pending}
    <p class={workMuted} role="status">Reading review attempts…</p>
  {:else if attempts === null}
    <p class={workMuted} role="status">Review attempts are unavailable.</p>
  {:else if !attempts.ok}
    <p class={workMuted} role="status">Review attempts unavailable ({attempts.error.tag}: {attempts.error.message}).</p>
  {:else if attempts.data.attempts.length === 0}
    <p class={workMuted}>No review attempt for this session yet.</p>
  {:else}
    <ul class={workFactList}>
      {#each attempts.data.attempts as attempt (attempt.attemptId)}
        {@const live = isLiveReviewAttemptState(attempt.state)}
        {@const notice = reservationNotice(attempt)}
        <li class={workPanel} data-work-attempt={attempt.attemptId} data-work-attempt-state={attempt.state}>
          <p class={workHeading}>
            {reviewAttemptStateLabel(attempt.state)}
            · attempt {shortAttemptId(attempt.attemptId)}
          </p>
          <p class={workMuted}>
            Requested {when(attempt.requestedAt)}{attempt.startedAt ? ` · started ${when(attempt.startedAt)}` : ''}
            {attempt.endedAt
              ? ` · ended ${when(attempt.endedAt)}`
              : ''}{live ? ` · last heartbeat ${formatRelativeAge(attempt.updatedAt, reference)}` : ''}.
          </p>
          {#if attempt.declared}
            <p class={workMuted}>
              Launched with account {attempt.declared.accountScope} · model {attempt.declared.model ?? 'unknown'} ·
              effort {attempt.declared.effort ?? 'unknown'}.
            </p>
          {/if}
          <p class={workMuted}>
            Checkout: {attempt.target.checkoutPath ?? 'unknown'}
            {attempt.target.checkoutOrigin
              ? ` (${checkoutOriginLabel(attempt.target.checkoutOrigin)})`
              : ''}.
          </p>
          <p class={workMuted}>
            Native session: {attempt.nativeSessionId ?? 'not reported yet'}
            {#if attempt.nativeSessionRowId}
              · <a class={workLink} href={detailHref(attempt.nativeSessionRowId)}>Open session detail</a>
            {:else if attempt.nativeSessionId}
              · not collected yet
            {/if}
          </p>
          {#if attempt.state === 'lost'}
            <p class={workMuted}>Contact lost; verify in the harness. The engine never relaunches an attempt.</p>
            {#if notice}
              <p class={workMuted} data-work-attempt-reservation={attempt.reservation.held ? 'held' : 'released'}>
                {notice}
              </p>
            {/if}
          {/if}
          {#if attempt.scope}
            <p class={workMuted} data-work-attempt-scope>{scopeSummary(attempt.scope)}</p>
            {#if attempt.scope.workingTreeDirty}
              <p class={workMuted}>{DIRTY_TREE_TEXT}</p>
            {/if}
          {/if}
          {#if attempt.guarantee}
            <p class={workMuted} data-work-attempt-guarantee>{guaranteeSummary(attempt.guarantee)}</p>
          {/if}
          {#if attempt.resultExcerpt}
            <p class={workMuted}>{resultHeading(attempt)}</p>
            <pre class={workExcerpt} data-work-attempt-excerpt>{attempt.resultExcerpt}</pre>
          {/if}
          {#if attempt.failureReason}
            <p class={workMuted}>Failure: {attempt.failureReason}</p>
          {/if}
          <p class={workMuted}>
            Validations executed:
            {attempt.validations.length === 0
              ? 'none (read-only review)'
              : attempt.validations.join('; ')}.
          </p>
          <p class={workMuted}>
            Acceptance: {attempt.acceptance === 'pending' ? 'pending — not reviewed by you' : attempt.acceptance}.
          </p>
        </li>
      {/each}
    </ul>
    {#if attempts.data.skipped > 0 || attempts.data.truncated}
      <p class={workMuted}>
        Attempts partially read: {attempts.data.skipped} refused on re-validation{attempts.data.truncated
          ? '; older attempts not shown'
          : ''}.
      </p>
    {/if}
  {/if}
</section>
