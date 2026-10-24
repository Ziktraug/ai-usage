import {
  type BoundedProcessOptions,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import { WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import { GITHUB_PULL_REQUEST_DEFAULTS, type PullRequestLink, SUPPORTED_GITHUB_HOST } from './github-pull-requests';
import { httpStatusOf } from './jira-issues';

/** Flags and JSON field names verified against the installed gh 2.102.0 offline manual. */
const SEARCH_FIELDS = 'number,repository,title,url,updatedAt,isDraft';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
export type PullRequestDiscoveryOutcome =
  | 'observed'
  | 'unavailable'
  | 'unauthenticated'
  | 'network'
  | 'not-found'
  | 'timeout'
  | 'invalid';
export interface DiscoveredPullRequestLink extends PullRequestLink {
  readonly discoveryRole: 'author' | 'review-requested';
}
export interface DiscoverPullRequestsOptions {
  readonly account?: { readonly ghUser: string };
  readonly environment?: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly maxOutputBytes?: number;
  /** Each allow-list narrows the operator's own results; neither enumerates an organisation. */
  readonly owners?: readonly string[];
  readonly repositories?: readonly string[];
  readonly run?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface PullRequestDiscoveryBatch {
  readonly accountLabel: string | null;
  readonly links: readonly DiscoveredPullRequestLink[];
  readonly outcome: PullRequestDiscoveryOutcome;
  readonly outcomeMessage: string | null;
  /** True when a search reached its ceiling: more results may exist upstream. */
  readonly truncated: boolean;
}

/** Strict fields, unknown keys ignored. URL identity must agree with the repository and number. */
export const parsePullRequestSearch = (stdout: string): readonly PullRequestLink[] | null => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const links: PullRequestLink[] = [];
  for (const row of value) {
    if (!(isRecord(row) && isRecord(row.repository))) {
      return null;
    }
    const repository = row.repository.nameWithOwner;
    if (
      typeof repository !== 'string' ||
      repository.length > WORK_ATTENTION_BOUNDS.maxShortText ||
      !REPOSITORY.test(repository) ||
      typeof row.number !== 'number' ||
      !Number.isSafeInteger(row.number) ||
      row.number <= 0 ||
      typeof row.title !== 'string' ||
      typeof row.isDraft !== 'boolean' ||
      normalizeIsoTimestamp(row.updatedAt) === null ||
      typeof row.url !== 'string' ||
      row.url !== `https://${SUPPORTED_GITHUB_HOST}/${repository}/pull/${String(row.number)}`
    ) {
      return null;
    }
    links.push({ host: SUPPORTED_GITHUB_HOST, number: row.number, repository });
  }
  return links;
};

type Read =
  | { readonly outcome: 'observed'; readonly stdout: string }
  | { readonly outcome: Exclude<PullRequestDiscoveryOutcome, 'observed'>; readonly outcomeMessage: string };
const read = (run: BoundedProcessRunner, options: BoundedProcessOptions): Effect.Effect<Read> =>
  run(options).pipe(
    Effect.map((result): Read => {
      if (result.exitCode === 0) {
        return { outcome: 'observed', stdout: result.stdout };
      }
      let status: number | null = null;
      try {
        status = httpStatusOf(JSON.parse(result.stdout));
      } catch {
        /* stderr is intentionally never retained. */
      }
      let outcome: Exclude<PullRequestDiscoveryOutcome, 'observed'> = status === 404 ? 'not-found' : 'network';
      if (result.exitCode === 4 || status === 401) {
        outcome = 'unauthenticated';
      }
      return { outcome, outcomeMessage: `gh discovery ${outcome} (exit ${String(result.exitCode)})` };
    }),
    Effect.catchAll((error) =>
      Effect.succeed<Read>({
        outcome: (
          { unavailable: 'unavailable', 'timed-out': 'timeout', failed: 'invalid', 'output-limit': 'invalid' } as const
        )[error.kind],
        outcomeMessage: `gh discovery ${error.kind}`,
      }),
    ),
  );

/** At most two personal searches and 100 results per account, with an optional bounded token read. */
export const discoverPullRequests = (
  options: DiscoverPullRequestsOptions = {},
): Effect.Effect<PullRequestDiscoveryBatch> =>
  Effect.gen(function* () {
    const accountLabel = options.account?.ghUser ?? null;
    const links: DiscoveredPullRequestLink[] = [];
    let truncated = false;
    const batch = (outcome: PullRequestDiscoveryOutcome, outcomeMessage: string | null): PullRequestDiscoveryBatch => ({
      accountLabel,
      links,
      outcome,
      outcomeMessage,
      truncated,
    });
    const owners = options.owners ?? [];
    const repositories = options.repositories ?? [];
    if (owners.some((owner) => !OWNER.test(owner)) || repositories.some((repository) => !REPOSITORY.test(repository))) {
      return batch('invalid', 'GitHub discovery scope is invalid');
    }
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit ?? 50))) : 50;
    const run = options.run ?? runBoundedProcess;
    let env: Readonly<Record<string, string>> = {
      ...options.environment,
      CLICOLOR: '0',
      GH_HOST: SUPPORTED_GITHUB_HOST,
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_PAGER: 'cat',
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
    };
    const base = {
      command: 'gh',
      maximumOutputBytes: options.maxOutputBytes ?? GITHUB_PULL_REQUEST_DEFAULTS.maxOutputBytes,
      timeoutMs: options.timeoutMs ?? GITHUB_PULL_REQUEST_DEFAULTS.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    if (options.account !== undefined) {
      const token = yield* read(run, {
        ...base,
        env,
        args: ['auth', 'token', '--user', options.account.ghUser, '--hostname', SUPPORTED_GITHUB_HOST],
      });
      if (token.outcome !== 'observed') {
        return token.outcome === 'network'
          ? batch('unauthenticated', 'gh has no stored account token')
          : batch(token.outcome, token.outcomeMessage);
      }
      if (token.stdout.trim().length === 0) {
        return batch('unauthenticated', 'gh has no stored account token');
      }
      env = { ...env, GH_TOKEN: token.stdout.trim() };
    }
    const seen = new Set<string>();
    for (const discoveryRole of ['author', 'review-requested'] as const) {
      const result = yield* read(run, {
        ...base,
        env,
        args: [
          'search',
          'prs',
          `--${discoveryRole}=@me`,
          '--state=open',
          '--json',
          SEARCH_FIELDS,
          '--limit',
          String(limit),
          ...owners.flatMap((owner) => ['--owner', owner]),
          ...repositories.flatMap((repository) => ['--repo', repository]),
        ],
      });
      if (result.outcome !== 'observed') {
        return batch(result.outcome, result.outcomeMessage);
      }
      const parsed = parsePullRequestSearch(result.stdout);
      if (parsed === null) {
        return batch('invalid', 'gh returned an unexpected pull request search shape');
      }
      truncated ||= parsed.length >= limit;
      for (const link of parsed.slice(0, limit)) {
        const repo = link.repository.toLowerCase();
        if (
          (owners.length > 0 && !owners.some((owner) => repo.startsWith(`${owner.toLowerCase()}/`))) ||
          (repositories.length > 0 && !repositories.some((repository) => repo === repository.toLowerCase()))
        ) {
          continue;
        }
        const key = `${repo}#${String(link.number)}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push({ ...link, discoveryRole });
        }
      }
    }
    return batch('observed', null);
  });
