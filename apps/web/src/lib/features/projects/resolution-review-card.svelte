<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { ProjectResolutionAction, ProjectResolutionReviewSnapshot } from '@ai-usage/web-contract/projects';

  type Review = ProjectResolutionReviewSnapshot['reviews'][number];

  let {
    onAction,
    review,
  }: {
    onAction: (action: ProjectResolutionAction) => Promise<boolean>;
    review: Review;
  } = $props();

  const card = css({
    display: 'grid',
    gap: '16px',
    p: { base: '16px', md: '20px' },
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
  });
  const summary = css({ display: 'grid', gap: '5px' });
  const eyebrow = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 750,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  });
  const heading = css({ color: 'ink', fontSize: '16px', fontWeight: 750 });
  const detailGrid = css({
    display: 'grid',
    gap: '8px',
    gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
  });
  const detail = css({ display: 'grid', gap: '2px', minW: 0, p: '10px 12px', borderRadius: 'sm', bg: 'surfaceMuted' });
  const detailLabel = css({ color: 'muted', fontSize: '11px', fontWeight: 700 });
  const detailValue = css({ overflowWrap: 'anywhere', color: 'ink', fontFamily: 'mono', fontSize: '12px' });
  const actions = css({ display: 'grid', gap: '10px' });
  const candidateList = css({ display: 'grid', gap: '8px', m: 0, p: 0, listStyle: 'none' });
  const candidate = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    p: '10px 12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
  });
  const form = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '8px' });
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
  const messageClass = css({ color: 'muted', fontSize: '12px' });

  const initialDisplayName = (): string => review.normalizedRemote?.split('/').at(-1) ?? 'Local project';
  let displayName = $state(initialDisplayName());
  let pending = $state(false);
  let message = $state('');

  const apply = async (action: ProjectResolutionAction): Promise<void> => {
    if (pending) {
      return;
    }
    pending = true;
    message = '';
    try {
      const applied = await onAction(action);
      if (!applied) {
        message = 'This choice could not be applied. Try again.';
      }
    } finally {
      pending = false;
    }
  };

  const createProject = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const normalizedName = displayName.trim();
    if (normalizedName.length === 0) {
      message = 'Enter a Project name.';
      return;
    }
    await apply({
      checkoutId: review.checkoutId,
      displayName: normalizedName,
      kind: 'create-project',
      spaceId: review.destinationSpaceId,
    });
  };
</script>

<article class={card}>
  <div class={summary}>
    <p class={eyebrow}>{review.status} repository</p>
    <h2 class={heading}>{review.localLabel}</h2>
  </div>

  <dl class={detailGrid}>
    <div class={detail}>
      <dt class={detailLabel}>Source Device</dt>
      <dd class={detailValue}>{review.deviceLabel}</dd>
    </div>
    <div class={detail}>
      <dt class={detailLabel}>Observed remote</dt>
      <dd class={detailValue}>{review.normalizedRemote ?? 'No remote observed'}</dd>
    </div>
    <div class={detail}>
      <dt class={detailLabel}>Destination Space</dt>
      <dd class={detailValue}>{review.destinationSpaceId}</dd>
    </div>
    <div class={detail}>
      <dt class={detailLabel}>Checkout</dt>
      <dd class={detailValue}>{review.localLabel}</dd>
    </div>
  </dl>

  <div class={actions}>
    {#if review.candidateMatches.length > 0}
      <div>
        <p class={eyebrow}>Candidate matches</p>
        <ul class={candidateList}>
          {#each review.candidateMatches as match (match.repositoryId)}
            <li class={candidate}>
              <span class={detailValue}>{match.canonicalLabel}</span>
              <button
                class={`${button} ${primaryButton}`}
                disabled={pending}
                onclick={async () => await apply({
                  checkoutId: review.checkoutId,
                  kind: 'link',
                  projectId: null,
                  repositoryId: match.repositoryId,
                  spaceId: review.destinationSpaceId,
                })}
                type="button"
              >
                Link
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <form class={form} onsubmit={createProject}>
      <label class={field}>
        <span class={detailLabel}>New local Project</span>
        <input class={input} disabled={pending} maxlength="256" bind:value={displayName}>
      </label>
      <button class={button} disabled={pending} type="submit">Create Project</button>
      <button
        class={button}
        disabled={pending}
        onclick={async () => await apply({
          checkoutId: review.checkoutId,
          kind: 'leave-unassigned',
          spaceId: review.destinationSpaceId,
        })}
        type="button"
      >
        Leave unassigned
      </button>
    </form>
    {#if message}
      <p aria-live="polite" class={messageClass}>{message}</p>
    {/if}
  </div>
</article>
