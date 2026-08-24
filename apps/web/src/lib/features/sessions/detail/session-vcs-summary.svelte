<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const summaryClass = css({
    display: 'grid',
    gap: '10px',
    minW: 0,
    pt: '14px',
    borderTop: '1px solid token(colors.line)',
  });
  const heading = css({ color: 'ink', fontSize: '13px', fontWeight: 700, lineHeight: 1.3, m: 0 });
  const rowsClass = css({ display: 'grid', gap: '7px', minW: 0 });
  const rowClass = css({
    display: 'grid',
    gridTemplateColumns: '80px minmax(0, 1fr)',
    gap: '10px',
    alignItems: 'baseline',
    minW: 0,
  });
  const labelClass = css({ color: 'muted', fontSize: '11px', fontWeight: 650 });
  const valueClass = css({ color: 'ink', fontSize: '12px', minW: 0 });
  const truncate = css({ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  const link = css({
    display: 'inline-flex',
    gap: '4px',
    alignItems: 'center',
    maxW: 'full',
    color: 'ink',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const details = css({ minW: 0, mt: '4px' });
  const detailsSummary = css({
    minH: '44px',
    display: 'flex',
    alignItems: 'center',
    color: 'muted',
    cursor: 'pointer',
    fontSize: '11px',
  });
  const branchList = css({ display: 'grid', gap: '4px', listStyle: 'none', m: 0, mt: '6px', p: 0, minW: 0 });
  const note = css({ color: 'muted', fontSize: '11px', lineHeight: 1.45, m: 0 });
  const actions = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
  const SHORT_COMMIT_HASH_LENGTH = 8;
  const ghostButton = css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'muted',
    px: '12px',
    py: '5px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
</script>

<script lang="ts">
  import {
    parseSessionVcsContext,
    parseSessionVcsResolveResponse,
    type SessionVcsBranchSpan,
    type SessionVcsResolveResponse,
  } from '@ai-usage/report-core/session-vcs';
  import ExternalLinkIcon from './external-link-icon.svelte';

  let {
    context: rawContext,
    onResolve,
    resolution: rawResolution,
    resolving,
  }: {
    context: unknown;
    onResolve?: () => void;
    resolution: SessionVcsResolveResponse | null;
    resolving: boolean;
  } = $props();

  const context = $derived.by(() => {
    try {
      return parseSessionVcsContext(rawContext);
    } catch {
      return null;
    }
  });
  const resolution = $derived.by(() => {
    if (!rawResolution) {
      return null;
    }
    try {
      return parseSessionVcsResolveResponse(rawResolution);
    } catch {
      return null;
    }
  });
  const available = $derived(resolution?.status === 'available' ? resolution : null);
  const unavailable = $derived(resolution?.status === 'unavailable' ? resolution : null);
  const pullRequests = $derived.by(() => {
    const byUrl = new Map((context?.pullRequests ?? []).map((pullRequest) => [pullRequest.url, pullRequest]));
    for (const pullRequest of available?.pullRequests ?? []) {
      if (!byUrl.has(pullRequest.url)) {
        byUrl.set(pullRequest.url, pullRequest);
      }
    }
    return [...byUrl.values()];
  });
  const repositoryUrl = $derived(context?.repository?.webUrl ?? available?.repositoryUrl ?? null);
  const canResolve = $derived(
    Boolean(onResolve && context?.repository && context.branches.length > 0 && pullRequests.length === 0 && !available),
  );

  const branchUrl = (branch: SessionVcsBranchSpan): string | null => branch.webUrl ?? null;
  const unavailableMessage = (): string => {
    switch (unavailable?.reason) {
      case 'timed-out':
        return 'GitHub lookup timed out.';
      case 'not-local':
        return 'GitHub lookup requires the source machine.';
      case 'provenance-unavailable':
        return 'Recorded repository provenance is unavailable.';
      case 'repository-unsupported':
        return 'The recorded repository provider is not supported.';
      case 'not-found':
        return 'No matching GitHub pull request was found.';
      default:
        return 'GitHub lookup is unavailable — the gh CLI was not found or returned nothing usable.';
    }
  };
  const resolveLabel = (): string => {
    if (resolving) {
      return 'Looking up pull requests…';
    }
    return unavailable ? 'Retry GitHub lookup' : 'Find pull requests on GitHub';
  };
</script>

{#if context}
  <section aria-label="Session source control" class={summaryClass}>
    <h3 class={heading}>Session source control</h3>
    <div class={rowsClass}>
      {#if context.repository}
        <div class={rowClass}>
          <span class={labelClass}>Repository</span>
          <div class={valueClass}>
            {#if repositoryUrl}
              <a
                aria-label={`Open repository ${context.repository.ownerPath} in a new tab`}
                class={link}
                href={repositoryUrl}
                rel="noopener"
                target="_blank"
              >
                <span class={truncate}>{context.repository.ownerPath}</span><ExternalLinkIcon />
              </a>
            {:else}
              <span class={truncate}>{context.repository.ownerPath}</span>
            {/if}
          </div>
        </div>
      {/if}
      {#if context.branches.length === 1}
        {@const branch = context.branches[0]}
        {#if branch}
          <div class={rowClass}>
            <span class={labelClass}>Branch</span>
            <div class={valueClass}>
              {#if branchUrl(branch)}
                <a
                  aria-label={`Open branch ${branch.name} in a new tab`}
                  class={link}
                  href={branchUrl(branch) ?? undefined}
                  rel="noopener"
                  target="_blank"
                  >{branch.name}<ExternalLinkIcon /></a
                >
              {:else}
                <span class={truncate}>{branch.name}</span>
              {/if}
            </div>
          </div>
        {/if}
      {:else if context.branches.length > 1}
        <div class={rowClass}>
          <span class={labelClass}>Branches</span>
          <div class={valueClass}>
            <span class={truncate} title={context.branches.map((branch) => branch.name).join(' → ')}>
              {context.branches[0]?.name}
              → {context.branches.at(-1)?.name}
            </span>
            <details class={details}>
              <summary class={detailsSummary}>{context.branches.length} recorded branch spans</summary>
              <ul class={branchList}>
                {#each context.branches as branch (`${branch.name}:${branch.firstObservedAt}`)}
                  <li>
                    {#if branchUrl(branch)}
                      <a
                        aria-label={`Open branch ${branch.name} in a new tab`}
                        class={link}
                        href={branchUrl(branch) ?? undefined}
                        rel="noopener"
                        target="_blank"
                        >{branch.name}<ExternalLinkIcon /></a
                      >
                    {:else}
                      {branch.name}
                    {/if}
                  </li>
                {/each}
              </ul>
            </details>
          </div>
        </div>
      {/if}
      {#if context.headCommit}
        <div class={rowClass}>
          <span class={labelClass}>Commit</span>
          <div class={valueClass} title={context.headCommit.hash}>
            {#if context.headCommit.webUrl}
              <a
                aria-label={`Open commit ${context.headCommit.hash} in a new tab`}
                class={link}
                href={context.headCommit.webUrl}
                rel="noopener"
                target="_blank"
                >{context.headCommit.hash.slice(0, SHORT_COMMIT_HASH_LENGTH)}<ExternalLinkIcon /></a
              >
            {:else}
              {context.headCommit.hash.slice(0, SHORT_COMMIT_HASH_LENGTH)}
            {/if}
          </div>
        </div>
      {/if}
      {#if pullRequests.length > 0}
        <div class={rowClass}>
          <span class={labelClass}>Pull request{pullRequests.length === 1 ? '' : 's'}</span>
          <div class={actions}>
            {#each pullRequests as pullRequest (pullRequest.url)}
              {@const text = pullRequest.number === null ? 'Pull request' : `#${pullRequest.number}`}
              <a
                aria-label={`Open ${text} in a new tab`}
                class={link}
                href={pullRequest.url}
                rel="noopener"
                target="_blank"
                >{text}<ExternalLinkIcon /></a
              >
            {/each}
          </div>
        </div>
      {/if}
    </div>
    {#if context.repository?.provenance === 'local-derived'}
      <p class={note}>Repository derived from the recorded local checkout.</p>
    {/if}
    {#if context.partial}
      <p class={note}>Some recorded source-control context could not be represented safely.</p>
    {/if}
    {#if resolving}
      <p aria-live="polite" class={note}>Looking up pull requests…</p>
    {/if}
    {#if unavailable}
      <p class={note}>{unavailableMessage()}</p>
    {/if}
    {#if canResolve}
      <p class={note}>
        Uses the GitHub CLI (gh) signed in on this machine to list pull requests whose head is the recorded branch. Only
        that lookup leaves the machine, and only when you click.
      </p>
      <button
        aria-label={resolving
          ? 'Looking up pull requests for the recorded branch on GitHub'
          : 'Find pull requests for the recorded branch on GitHub'}
        class={ghostButton}
        disabled={resolving}
        onclick={() => onResolve?.()}
        type="button"
      >
        {resolveLabel()}
      </button>
    {/if}
  </section>
{/if}
