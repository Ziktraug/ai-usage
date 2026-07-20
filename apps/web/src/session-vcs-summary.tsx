import { css } from '@ai-usage/design-system/css';
import { ghostButton } from '@ai-usage/design-system/report';
import {
  parseSessionVcsContext,
  parseSessionVcsResolveResponse,
  type SessionVcsBranchSpan,
  type SessionVcsContext,
  type SessionVcsPullRequest,
  type SessionVcsResolveResponse,
} from '@ai-usage/report-core/session-vcs';
import ExternalLink from 'lucide-solid/icons/external-link';
import { createMemo, For, Show } from 'solid-js';

export interface SessionVcsSummaryProps {
  context: unknown;
  onResolve?: () => void;
  resolution: SessionVcsResolveResponse | null;
  resolving: boolean;
}

const summary = css({
  display: 'grid',
  gap: '10px',
  minW: 0,
  pt: '14px',
  borderTop: '1px solid token(colors.line)',
});
const heading = css({ color: 'ink', fontSize: '13px', fontWeight: 700, lineHeight: 1.3, m: 0 });
const rows = css({ display: 'grid', gap: '7px', minW: 0 });
const row = css({
  display: 'grid',
  gridTemplateColumns: '80px minmax(0, 1fr)',
  gap: '10px',
  alignItems: 'baseline',
  minW: 0,
});
const label = css({ color: 'muted', fontSize: '11px', fontWeight: 650 });
const value = css({ color: 'ink', fontSize: '12px', minW: 0 });
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
const linkText = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
const details = css({ minW: 0, mt: '4px' });
const detailsSummary = css({ color: 'muted', cursor: 'pointer', fontSize: '11px' });
const branchList = css({ display: 'grid', gap: '4px', listStyle: 'none', m: 0, mt: '6px', p: 0, minW: 0 });
const note = css({ color: 'muted', fontSize: '11px', lineHeight: 1.45, m: 0 });
const actions = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });

const parseContext = (context: unknown): SessionVcsContext | null => {
  try {
    return parseSessionVcsContext(context);
  } catch {
    return null;
  }
};

const parseResolution = (resolution: SessionVcsResolveResponse | null): SessionVcsResolveResponse | null => {
  if (!resolution) {
    return null;
  }
  try {
    return parseSessionVcsResolveResponse(resolution);
  } catch {
    return null;
  }
};

const SafeExternalLink = (props: { ariaLabel: string; children: string; title?: string; url: string }) => (
  <a aria-label={props.ariaLabel} class={link} href={props.url} rel="noopener" target="_blank" title={props.title}>
    <span class={linkText}>{props.children}</span>
    <ExternalLink aria-hidden="true" size={13} />
  </a>
);

const BranchValue = (props: { branch: SessionVcsBranchSpan }) => (
  <Show fallback={<span class={truncate}>{props.branch.name}</span>} when={props.branch.webUrl}>
    {(url) => (
      <SafeExternalLink ariaLabel={`Open branch ${props.branch.name} in a new tab`} url={url()}>
        {props.branch.name}
      </SafeExternalLink>
    )}
  </Show>
);

const PullRequestValue = (props: { pullRequest: SessionVcsPullRequest }) => {
  const text = () => (props.pullRequest.number === null ? 'Pull request' : `#${props.pullRequest.number}`);
  return (
    <SafeExternalLink ariaLabel={`Open ${text()} in a new tab`} url={props.pullRequest.url}>
      {text()}
    </SafeExternalLink>
  );
};

const unavailableMessage = (response: Extract<SessionVcsResolveResponse, { status: 'unavailable' }>): string => {
  switch (response.reason) {
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
    case 'resolver-unavailable':
      return 'GitHub lookup is unavailable.';
    default:
      return 'GitHub lookup is unavailable.';
  }
};

export const SessionVcsSummary = (props: SessionVcsSummaryProps) => {
  const context = createMemo(() => parseContext(props.context));
  const resolution = createMemo(() => parseResolution(props.resolution));
  const resolved = () => {
    const response = resolution();
    return response?.status === 'available' ? response : null;
  };
  const unavailable = () => {
    const response = resolution();
    return response?.status === 'unavailable' ? response : null;
  };
  const pullRequests = createMemo(() => {
    const recorded = context()?.pullRequests ?? [];
    const ephemeral = resolved()?.pullRequests ?? [];
    const byUrl = new Map(recorded.map((pullRequest) => [pullRequest.url, pullRequest]));
    for (const pullRequest of ephemeral) {
      if (!byUrl.has(pullRequest.url)) {
        byUrl.set(pullRequest.url, pullRequest);
      }
    }
    return [...byUrl.values()];
  });
  const repositoryUrl = () => context()?.repository?.webUrl ?? resolved()?.repositoryUrl ?? null;
  const canResolve = () =>
    Boolean(
      props.onResolve &&
        context()?.repository &&
        context()!.branches.length > 0 &&
        pullRequests().length === 0 &&
        !resolved(),
    );
  const resolveLabel = (): string => {
    if (props.resolving) {
      return 'Resolving GitHub links…';
    }
    return unavailable() ? 'Retry GitHub lookup' : 'Resolve GitHub links';
  };

  return (
    <Show when={context()}>
      {(vcs) => (
        <section aria-label="Session source control" class={summary}>
          <h3 class={heading}>Session source control</h3>
          <div class={rows}>
            <Show when={vcs().repository}>
              {(repository) => (
                <div class={row}>
                  <span class={label}>Repository</span>
                  <div class={value}>
                    <Show fallback={<span class={truncate}>{repository().ownerPath}</span>} when={repositoryUrl()}>
                      {(url) => (
                        <SafeExternalLink
                          ariaLabel={`Open repository ${repository().ownerPath} in a new tab`}
                          url={url()}
                        >
                          {repository().ownerPath}
                        </SafeExternalLink>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <Show when={vcs().branches.length === 1}>
              <div class={row}>
                <span class={label}>Branch</span>
                <div class={value}>
                  <BranchValue branch={vcs().branches[0]!} />
                </div>
              </div>
            </Show>
            <Show when={vcs().branches.length > 1}>
              <div class={row}>
                <span class={label}>Branches</span>
                <div class={value}>
                  <span
                    class={truncate}
                    title={vcs()
                      .branches.map((branch) => branch.name)
                      .join(' → ')}
                  >
                    {vcs().branches[0]!.name} → {vcs().branches.at(-1)!.name}
                  </span>
                  <details class={details}>
                    <summary class={detailsSummary}>{vcs().branches.length} recorded branch spans</summary>
                    <ul class={branchList}>
                      <For each={vcs().branches}>
                        {(branch) => (
                          <li>
                            <BranchValue branch={branch} />
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                </div>
              </div>
            </Show>
            <Show when={vcs().headCommit}>
              {(commit) => (
                <div class={row}>
                  <span class={label}>Commit</span>
                  <div class={value} title={commit().hash}>
                    <Show fallback={<span>{commit().hash.slice(0, 8)}</span>} when={commit().webUrl}>
                      {(url) => (
                        <SafeExternalLink
                          ariaLabel={`Open commit ${commit().hash} in a new tab`}
                          title={commit().hash}
                          url={url()}
                        >
                          {commit().hash.slice(0, 8)}
                        </SafeExternalLink>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <Show when={pullRequests().length > 0}>
              <div class={row}>
                <span class={label}>Pull request{pullRequests().length === 1 ? '' : 's'}</span>
                <div class={actions}>
                  <For each={pullRequests()}>{(pullRequest) => <PullRequestValue pullRequest={pullRequest} />}</For>
                </div>
              </div>
            </Show>
          </div>
          <Show when={vcs().repository?.provenance === 'local-derived'}>
            <p class={note}>Repository derived from the recorded local checkout.</p>
          </Show>
          <Show when={vcs().partial}>
            <p class={note}>Some recorded source-control context could not be represented safely.</p>
          </Show>
          <Show when={props.resolving}>
            <p aria-live="polite" class={note}>
              Resolving GitHub links…
            </p>
          </Show>
          <Show when={unavailable()}>{(response) => <p class={note}>{unavailableMessage(response())}</p>}</Show>
          <Show when={canResolve()}>
            <button
              aria-label={
                props.resolving
                  ? 'Resolving GitHub repository and pull request links'
                  : 'Resolve GitHub repository and pull request links'
              }
              class={ghostButton}
              disabled={props.resolving}
              onClick={() => props.onResolve?.()}
              type="button"
            >
              {resolveLabel()}
            </button>
          </Show>
        </section>
      )}
    </Show>
  );
};
