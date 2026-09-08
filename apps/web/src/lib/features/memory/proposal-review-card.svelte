<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import {
    type MemoryProposalReviewAction,
    type MemoryProposalReviewSnapshot,
    parseMemoryProposalReviewAction,
  } from '@ai-usage/web-contract/memory';
  import { untrack } from 'svelte';

  type Proposal = MemoryProposalReviewSnapshot['proposals'][number];
  type MemoryScope = Extract<MemoryProposalReviewAction, { kind: 'accept' }>['scope'];

  let {
    onAction,
    proposal,
    spaceId,
  }: {
    onAction: (action: MemoryProposalReviewAction) => Promise<boolean>;
    proposal: Proposal;
    spaceId: string;
  } = $props();

  const card = css({
    display: 'grid',
    gap: '18px',
    p: { base: '16px', md: '20px' },
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
  });
  const summaryBlock = css({ display: 'grid', gap: '6px' });
  const eyebrow = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 750,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  });
  const heading = css({ color: 'ink', fontSize: '18px', fontWeight: 750 });
  const summaryClass = css({ color: 'muted', fontSize: '14px', lineHeight: 1.6 });
  const badges = css({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const badge = css({
    px: '8px',
    py: '3px',
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    bg: 'surfaceMuted',
    color: 'muted',
    fontSize: '11px',
    fontWeight: 700,
  });
  const detailGrid = css({
    display: 'grid',
    gap: '8px',
    gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  });
  const detail = css({ display: 'grid', gap: '3px', minW: 0, p: '10px 12px', borderRadius: 'sm', bg: 'surfaceMuted' });
  const detailLabel = css({ color: 'muted', fontSize: '11px', fontWeight: 700 });
  const detailValue = css({ overflowWrap: 'anywhere', color: 'ink', fontFamily: 'mono', fontSize: '12px' });
  const guidanceList = css({ display: 'grid', gap: '6px', m: 0, pl: '20px', color: 'ink', fontSize: '13px' });
  const sourceList = css({ display: 'grid', gap: '8px', m: 0, p: 0, listStyle: 'none' });
  const source = css({ display: 'grid', gap: '3px', p: '10px 12px', borderRadius: 'sm', bg: 'surfaceMuted' });
  const sourceTop = css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px' });
  const actions = css({ display: 'grid', gap: '12px', pt: '4px', borderTop: '1px solid token(colors.line)' });
  const actionRow = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '8px' });
  const formGrid = css({ display: 'grid', gap: '10px' });
  const field = css({ display: 'grid', flex: '1 1 220px', gap: '4px' });
  const input = css({
    minH: '38px',
    px: '10px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const textarea = css({ minH: '92px', py: '8px', resize: 'vertical' });
  const codeArea = css({ minH: '130px', fontFamily: 'mono', fontSize: '12px' });
  const button = css({
    minH: '38px',
    px: '12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    color: 'ink',
    fontWeight: 700,
    cursor: 'pointer',
    _hover: { bg: 'accentSoft' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _disabled: { cursor: 'not-allowed', opacity: 0.55 },
  });
  const primaryButton = css({
    bg: 'accent',
    borderColor: 'accent',
    color: 'accentContrast',
    _hover: { bg: 'accentStrong' },
  });
  const dangerButton = css({ color: 'danger' });
  const messageClass = css({ color: 'muted', fontSize: '12px' });
  const details = css({ color: 'muted', fontSize: '12px' });
  const pre = css({ overflowX: 'auto', mt: '8px', p: '10px', borderRadius: 'sm', bg: 'surfaceMuted', color: 'ink' });

  const headingId = $derived(`memory-proposal-${proposal.proposalId}`);
  let pending = $state(false);
  let message = $state('');
  let editing = $state(false);
  let scope = $state<MemoryScope>(untrack(() => (proposal.projectId === null ? 'space' : 'project')));
  let title = $state(untrack(() => proposal.title));
  let summaryText = $state(untrack(() => proposal.summary));
  let guidance = $state(untrack(() => proposal.guidance.join('\n')));
  let sensitivity = $state<'normal' | 'sensitive'>(untrack(() => proposal.sensitivity));
  let structuredContent = $state(untrack(() => JSON.stringify(proposal.structuredContent, null, 2)));
  let rejectionReason = $state('');

  const apply = async (action: MemoryProposalReviewAction): Promise<void> => {
    if (pending) {
      return;
    }
    pending = true;
    message = '';
    try {
      if (!(await onAction(action))) {
        message = 'This review could not be applied. Try again.';
      }
    } finally {
      pending = false;
    }
  };

  const accept = async (): Promise<void> => {
    try {
      const action = editing
        ? parseMemoryProposalReviewAction({
            edits: {
              guidance: guidance
                .split('\n')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
              sensitivity,
              structuredContent: JSON.parse(structuredContent) as unknown,
              summary: summaryText.trim(),
              title: title.trim(),
            },
            kind: 'accept',
            proposalId: proposal.proposalId,
            scope,
            spaceId,
          })
        : parseMemoryProposalReviewAction({
            kind: 'accept',
            proposalId: proposal.proposalId,
            scope,
            spaceId,
          });
      await apply(action);
    } catch {
      message = 'Review the edited fields and provide valid JSON before accepting.';
    }
  };

  const reject = async (): Promise<void> => {
    const reason = rejectionReason.trim();
    if (reason.length === 0) {
      message = 'Give a reason so this rejection remains reviewable.';
      return;
    }
    await apply(parseMemoryProposalReviewAction({ kind: 'reject', proposalId: proposal.proposalId, reason, spaceId }));
  };
</script>

<article aria-labelledby={headingId} class={card}>
  <div class={summaryBlock}>
    <p class={eyebrow}>Generated proposal · review required</p>
    <h2 class={heading} id={headingId}>{proposal.title}</h2>
    {#if proposal.summary}
      <p class={summaryClass}>{proposal.summary}</p>
    {/if}
    <div class={badges}>
      <span class={badge}>{proposal.proposedKind}</span>
      <span class={badge}>{proposal.trustCandidate}</span>
      <span class={badge}>{proposal.sensitivity}</span>
      <span class={badge}>proposed by {proposal.proposedByKind}</span>
    </div>
  </div>

  {#if proposal.guidance.length > 0}
    <section aria-label="Proposed guidance">
      <p class={eyebrow}>Proposed guidance</p>
      <ul class={guidanceList}>
        {#each proposal.guidance as entry}
          <li>{entry}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section aria-label="Proposal provenance">
    <p class={eyebrow}>Evidence and provenance</p>
    {#if proposal.observationSources.length === 0}
      <p class={summaryClass}>No observation source is attached.</p>
    {:else}
      <ul class={sourceList}>
        {#each proposal.observationSources as observation (observation.id)}
          <li class={source}>
            <div class={sourceTop}>
              <strong>{observation.sourceKind}</strong>
              <time datetime={observation.observedAt}>{observation.observedAt}</time>
            </div>
            <span class={detailValue}>{observation.sourceLocator ?? 'No source locator'}</span>
            <span class={detailLabel}>{observation.sensitivity} evidence</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <dl class={detailGrid}>
    <div class={detail}>
      <dt class={detailLabel}>Destination Space</dt>
      <dd class={detailValue}>{spaceId}</dd>
    </div>
    <div class={detail}>
      <dt class={detailLabel}>Project</dt>
      <dd class={detailValue}>{proposal.projectId ?? 'No Project assigned'}</dd>
    </div>
  </dl>

  <details class={details}>
    <summary>Structured candidate content</summary>
    <pre class={pre}>{JSON.stringify(proposal.structuredContent, null, 2)}</pre>
  </details>

  <div class={actions}>
    <div class={actionRow}>
      <label class={field}>
        <span class={detailLabel}>Accepted scope</span>
        <select class={input} disabled={pending} bind:value={scope}>
          <option value="space">This Space</option>
          <option value="person">This Person</option>
          <option disabled={proposal.projectId === null} value="project">Assigned Project</option>
        </select>
      </label>
      <button class={`${button} ${primaryButton}`} disabled={pending} onclick={accept} type="button">
        Accept proposal
      </button>
      <button class={button} disabled={pending} onclick={() => { editing = !editing; }} type="button">
        {editing ? 'Keep original' : 'Edit before accepting'}
      </button>
    </div>

    {#if editing}
      <div class={formGrid}>
        <label class={field}>
          <span class={detailLabel}>Title</span>
          <input class={input} disabled={pending} maxlength="512" bind:value={title}>
        </label>
        <label class={field}>
          <span class={detailLabel}>Summary</span>
          <textarea
            class={`${input} ${textarea}`}
            disabled={pending}
            maxlength="16384"
            bind:value={summaryText}
          ></textarea>
        </label>
        <label class={field}>
          <span class={detailLabel}>Guidance, one item per line</span>
          <textarea class={`${input} ${textarea}`} disabled={pending} bind:value={guidance}></textarea>
        </label>
        <label class={field}>
          <span class={detailLabel}>Sensitivity</span>
          <select class={input} disabled={pending} bind:value={sensitivity}>
            <option value="normal">Normal</option>
            <option value="sensitive">Sensitive</option>
          </select>
        </label>
        <label class={field}>
          <span class={detailLabel}>Structured content (JSON)</span>
          <textarea
            class={`${input} ${textarea} ${codeArea}`}
            disabled={pending}
            bind:value={structuredContent}
          ></textarea>
        </label>
      </div>
    {/if}

    <div class={actionRow}>
      <label class={field}>
        <span class={detailLabel}>Rejection reason</span>
        <input class={input} disabled={pending} maxlength="4096" bind:value={rejectionReason}>
      </label>
      <button class={`${button} ${dangerButton}`} disabled={pending} onclick={reject} type="button">
        Reject proposal
      </button>
    </div>
    {#if message}
      <p aria-live="polite" class={messageClass}>{message}</p>
    {/if}
  </div>
</article>
