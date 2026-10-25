import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  DelegationCheckoutFacts,
  DelegationFact,
  DelegationScopeRequest,
  FrozenDelegationScope,
  ResolvedDelegationCheckout,
} from '@ai-usage/report-core/delegation-contracts';
import { DELEGATION_REVISION_PATTERN } from '@ai-usage/report-core/delegation-vocabulary';
import { isPrintableSkillObservationText } from '@ai-usage/report-core/skill-observation';
import {
  GIT_EMPTY_TREE,
  isCheckoutPathAdmitted,
  normalizeCheckoutPath,
  type ReviewTargetDeclaration,
} from '@ai-usage/report-core/work-attempts';
import { GIT_SMALL_OUTPUT_BYTES, type GitAnswer, GitRunError, gitScopeEnvironment, runGit } from './git-runner';

/**
 * The engine-resolved facts of a delegation request (DESIGN "Decision chain" steps 2 and 3): the
 * checkout as it is on disk, what its git remotes and configuration say, and the scope frozen to
 * object ids. Nothing here is taken from the caller: the path is resolved with `realpath` and
 * `git rev-parse --show-toplevel`, admission is the existing `routing.reviewTargets[]` rule, the
 * remotes and the author email are read from git, and every revision is resolved by git after
 * `--end-of-options`. No file content is read, nothing is fetched, nothing is written.
 */
export interface DelegationCheckoutFailure {
  readonly failure: 'checkout-unavailable';
  readonly message: string;
}

export interface DelegationScopeFailure {
  readonly failure: 'scope-unavailable';
  readonly message: string;
}

/** One `github.accounts[]` entry: the `gh` login the operator declared for a repository owner. */
export interface DelegationGitHubAccount {
  readonly ghUser: string;
  readonly host: 'github.com';
  readonly owner: string;
}

export interface DelegationCheckoutOptions {
  /** Source environment for git (allow-listed); defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TRAILING_NEWLINE = /\n$/u;
const WHITESPACE = /\s+/u;
const REMOTE_LINE = /^(\S+)\t(.+) \((?:fetch|push)\)$/u;
const REMOTE_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u;
/** `scheme://[userinfo@]host[:port][/path]`: a DNS or IPv4 host (never bracketed), digits only as a port. */
const REMOTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([A-Za-z0-9._-]+)(?::(\d+))?(\/\S*)?$/u;
/** git's SCP-like rule: no `://`, and a colon before the first slash: `[user@]host:path`. */
const REMOTE_SCP = /^(?:[^/@\s]*@)?([A-Za-z0-9._-]+):(\S*)$/u;
const LEADING_SLASH = /^\//u;
const TRAILING_SLASH = /\/$/u;
const GIT_SUFFIX = /\.git$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
/** Remote lines looked at; the lines beyond are counted as unread and make the fact partial. */
const MAX_REMOTE_LINES = 64;
const MAX_EMAIL_LENGTH = 320;

const observed = <Value>(source: string, value: Value): DelegationFact<Value> => ({
  provenance: 'observed',
  source,
  value,
});
const unknown = <Value>(source: string): DelegationFact<Value> => ({ provenance: 'unknown', source, value: null });
/** A list that holds only what was identified; `source` says how much was not (counts, never a URL). */
const partial = <Value>(source: string, value: Value): DelegationFact<Value> => ({
  provenance: 'partial',
  source,
  value,
});

const checkoutUnavailable = (message: string): DelegationCheckoutFailure => ({
  failure: 'checkout-unavailable',
  message,
});
const scopeUnavailable = (message: string): DelegationScopeFailure => ({ failure: 'scope-unavailable', message });

/** A git call whose failure is an answer, not an exception: `null` when the runner could not complete it. */
const tryGit = async (
  checkoutPath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  maximumOutputBytes: number = GIT_SMALL_OUTPUT_BYTES,
): Promise<GitAnswer | GitRunError> => {
  try {
    return await runGit(checkoutPath, args, environment, maximumOutputBytes);
  } catch (error) {
    if (error instanceof GitRunError) {
      return error;
    }
    throw error;
  }
};

const canonicalDirectory = async (candidate: string): Promise<string | null> => {
  try {
    const resolved = await realpath(candidate);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
};

/**
 * The checkout the request names, as it is on disk: realpath, then the repository's top level,
 * then its realpath. `admittedBy` is the first `routing.reviewTargets[]` checkout that admits the
 * canonical path (equal or below it), or `null`; the caller decides what a non-admission means.
 */
export const resolveDelegationCheckout = async (
  requestedPath: string,
  reviewTargets: readonly ReviewTargetDeclaration[],
  options: DelegationCheckoutOptions = {},
): Promise<ResolvedDelegationCheckout | DelegationCheckoutFailure> => {
  if (!path.isAbsolute(requestedPath)) {
    return checkoutUnavailable('the checkout path must be absolute');
  }
  const requested = await canonicalDirectory(requestedPath);
  if (requested === null) {
    return checkoutUnavailable('the checkout path is not a directory on this machine or cannot be resolved');
  }
  const environment = gitScopeEnvironment(options.env ?? process.env);
  const topLevel = await tryGit(requested, ['rev-parse', '--show-toplevel'], environment, 16 * 1024);
  if (topLevel instanceof GitRunError) {
    return checkoutUnavailable(`git rev-parse --show-toplevel ${topLevel.kind}; the checkout cannot be resolved`);
  }
  if (topLevel.exitCode !== 0) {
    return checkoutUnavailable('the checkout path is not inside a git work tree');
  }
  const canonical = await canonicalDirectory(topLevel.stdout.replace(TRAILING_NEWLINE, ''));
  const normalized = canonical === null ? null : normalizeCheckoutPath(canonical);
  if (canonical === null || normalized === null) {
    return checkoutUnavailable('the repository top level cannot be resolved to a canonical directory');
  }
  const admittedBy = reviewTargets.find((target) => isCheckoutPathAdmitted(normalized, [target]))?.checkoutPath ?? null;
  const basename = path.basename(normalized);
  return { admittedBy, path: normalized, projectLabel: basename.length === 0 ? normalized : basename };
};

export interface GitHubRemote {
  readonly owner: string;
  readonly repository: string;
}

/**
 * What one remote URL says about the repository. `identified`: a GitHub host with exactly
 * `owner/repo`. `not-github`: a DNS name that is not GitHub over http(s) or git://, a `file://`
 * URL or a local path — a known absence. `unidentified`: everything the engine cannot settle
 * without a resolver it does not have: an ssh host that is not GitHub (ssh config may alias any
 * host to GitHub, as the usual multi-account `git@github-work:` does), a GitHub host with another
 * path, a malformed port, an unknown scheme, or a URL that does not parse.
 */
export type RemoteUrlClassification =
  | { readonly kind: 'identified'; readonly owner: string; readonly repository: string }
  | { readonly kind: 'not-github' }
  | { readonly kind: 'unidentified' };

type RemoteFamily = 'git' | 'http' | 'ssh';

const SCHEME_FAMILIES: ReadonlyMap<string, RemoteFamily> = new Map<string, RemoteFamily>([
  ['git', 'git'],
  ['git+ssh', 'ssh'],
  ['http', 'http'],
  ['https', 'http'],
  ['ssh', 'ssh'],
  ['ssh+git', 'ssh'],
]);

/** Exact host names, compared case-insensitively; `ssh.github.com` is GitHub's documented SSH-over-443 host. */
const GITHUB_HOSTS: Readonly<Record<RemoteFamily, readonly string[]>> = {
  git: ['github.com'],
  http: ['github.com', 'www.github.com'],
  ssh: ['github.com', 'ssh.github.com'],
};

const NOT_GITHUB: RemoteUrlClassification = { kind: 'not-github' };
const UNIDENTIFIED: RemoteUrlClassification = { kind: 'unidentified' };

/** Exactly `owner/repo`, with an optional leading slash, trailing slash and `.git`; else `null`. */
const githubPath = (rawPath: string): GitHubRemote | null => {
  const trimmed = rawPath.replace(LEADING_SLASH, '').replace(TRAILING_SLASH, '').replace(GIT_SUFFIX, '');
  const segments = trimmed.split('/');
  const [owner, repository] = segments;
  if (segments.length !== 2 || owner === undefined || repository === undefined) {
    return null;
  }
  return GITHUB_OWNER.test(owner) && GITHUB_REPOSITORY.test(repository) ? { owner, repository } : null;
};

const classifyHostAndPath = (family: RemoteFamily, host: string, remotePath: string): RemoteUrlClassification => {
  if (!GITHUB_HOSTS[family].includes(host.toLowerCase())) {
    return family === 'ssh' ? UNIDENTIFIED : NOT_GITHUB;
  }
  const remote = githubPath(remotePath);
  return remote === null ? UNIDENTIFIED : { kind: 'identified', ...remote };
};

const isValidPort = (port: string | undefined): boolean => {
  if (port === undefined) {
    return true;
  }
  const number = Number.parseInt(port, 10);
  return number >= 1 && number <= 65_535;
};

export const classifyRemoteUrl = (url: string): RemoteUrlClassification => {
  const scheme = REMOTE_SCHEME.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === 'file') {
      return NOT_GITHUB;
    }
    const family = SCHEME_FAMILIES.get(scheme);
    const match = REMOTE_URL.exec(url);
    const host = match?.[1];
    if (family === undefined || match === null || host === undefined || !isValidPort(match[2])) {
      return UNIDENTIFIED;
    }
    return classifyHostAndPath(family, host, match[3] ?? '');
  }
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  if (colon >= 0 && (slash === -1 || colon < slash)) {
    // git reads this as `[user@]host:path` over ssh; a host the regex rejects stays unidentified.
    const scp = REMOTE_SCP.exec(url);
    const scpHost = scp?.[1];
    return scp === null || scpHost === undefined ? UNIDENTIFIED : classifyHostAndPath('ssh', scpHost, scp[2] ?? '');
  }
  return url.length === 0 ? UNIDENTIFIED : NOT_GITHUB;
};

/**
 * Distinct values, compared case-insensitively (GitHub owners and repositories are), the first
 * spelling `git remote -v` lists kept, sorted so the fact reads the same whatever the remote names.
 */
const distinctIgnoringCase = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(value);
    }
  }
  return kept.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase(), 'en'));
};

/** Every line of `git remote -v` (fetch and push; a remote may push elsewhere), classified and counted. */
export interface RemoteListing {
  readonly identified: readonly GitHubRemote[];
  /** URLs known not to be GitHub (another DNS name over http(s)/git://, `file://`, a local path). */
  readonly notGitHub: number;
  /** Lines looked at (at most `MAX_REMOTE_LINES`). */
  readonly read: number;
  /** Lines read that could not be identified, including lines that are not `name<TAB>url (fetch|push)`. */
  readonly unidentified: number;
  /** Lines beyond the read limit, not looked at. */
  readonly unread: number;
}

export const parseGitHubRemotes = (remoteList: string): RemoteListing => {
  const text = remoteList.replace(TRAILING_NEWLINE, '');
  const lines = text.length === 0 ? [] : text.split('\n');
  const read = lines.slice(0, MAX_REMOTE_LINES);
  const identified: GitHubRemote[] = [];
  let notGitHub = 0;
  let unidentified = 0;
  for (const line of read) {
    const url = REMOTE_LINE.exec(line)?.[2];
    const classification = url === undefined ? UNIDENTIFIED : classifyRemoteUrl(url.trim());
    if (classification.kind === 'identified') {
      identified.push({ owner: classification.owner, repository: classification.repository });
    } else if (classification.kind === 'not-github') {
      notGitHub += 1;
    } else {
      unidentified += 1;
    }
  }
  return { identified, notGitHub, read: read.length, unidentified, unread: lines.length - read.length };
};

/** `null` when every listed URL was identified or known not to be GitHub; else the counts, never a URL. */
const remoteListingSource = (listing: RemoteListing): string | null => {
  const parts: string[] = [];
  if (listing.unidentified > 0) {
    parts.push(`${listing.unidentified} of ${listing.read} remote URLs not identified`);
  }
  if (listing.unread > 0) {
    parts.push(`${listing.unread} remote URLs not read`);
  }
  return parts.length === 0 ? null : `git remote -v (${parts.join(', ')})`;
};

const authorEmailFact = (answer: GitAnswer | GitRunError): DelegationFact<string> => {
  if (answer instanceof GitRunError) {
    return unknown(`git config --get user.email (${answer.kind})`);
  }
  if (answer.exitCode !== 0) {
    return unknown('git config --get user.email (unset)');
  }
  const email = answer.stdout.trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !isPrintableSkillObservationText(email)) {
    return unknown('git config --get user.email (unreadable value)');
  }
  return observed('git config --get user.email', email);
};

/**
 * What the checkout itself says: its GitHub remotes (owners and `owner/name`), the `gh` login the
 * operator declared for the single owner, and the effective `user.email` of the checkout. Every
 * fact carries where it came from; a fact git could not answer is `unknown`, never guessed. The
 * remote lists are `observed` only when every listed URL was identified or is known not to be
 * GitHub (an empty list is then a real absence); when a URL could not be identified or the listing
 * was not read to its end they are `partial`, which rules treat as open, not as absent.
 */
export const readDelegationCheckoutFacts = async (
  checkoutPath: string,
  githubAccounts: readonly DelegationGitHubAccount[],
  options: DelegationCheckoutOptions = {},
): Promise<DelegationCheckoutFacts> => {
  const environment = gitScopeEnvironment(options.env ?? process.env);
  const [remotesAnswer, emailAnswer] = await Promise.all([
    tryGit(checkoutPath, ['remote', '-v'], environment),
    tryGit(checkoutPath, ['config', '--get', 'user.email'], environment, 16 * 1024),
  ]);
  let githubOwners: DelegationFact<readonly string[]>;
  let repositories: DelegationFact<readonly string[]>;
  if (remotesAnswer instanceof GitRunError) {
    githubOwners = unknown(`git remote -v (${remotesAnswer.kind})`);
    repositories = unknown(`git remote -v (${remotesAnswer.kind})`);
  } else if (remotesAnswer.exitCode === 0) {
    const listing = parseGitHubRemotes(remotesAnswer.stdout);
    const owners = distinctIgnoringCase(listing.identified.map((remote) => remote.owner));
    const names = distinctIgnoringCase(listing.identified.map((remote) => `${remote.owner}/${remote.repository}`));
    const incomplete = remoteListingSource(listing);
    githubOwners = incomplete === null ? observed('git remote -v', owners) : partial(incomplete, owners);
    repositories = incomplete === null ? observed('git remote -v', names) : partial(incomplete, names);
  } else {
    githubOwners = unknown(`git remote -v (exit ${remotesAnswer.exitCode})`);
    repositories = unknown(`git remote -v (exit ${remotesAnswer.exitCode})`);
  }
  let githubAccount: DelegationFact<string>;
  const owners = githubOwners.value;
  if (owners === null) {
    githubAccount = unknown('github.accounts (remotes unknown)');
  } else if (githubOwners.provenance === 'partial') {
    githubAccount = unknown('github.accounts (remotes not all identified)');
  } else if (owners.length === 0) {
    githubAccount = unknown('github.accounts (no github.com remote)');
  } else if (owners.length > 1) {
    githubAccount = unknown('github.accounts (several owners observed)');
  } else {
    const owner = owners[0] ?? '';
    const account = githubAccounts.find(
      (entry) => entry.host === 'github.com' && entry.owner.toLowerCase() === owner.toLowerCase(),
    );
    githubAccount =
      account === undefined
        ? unknown(`github.accounts (no entry for owner ${owner})`)
        : { provenance: 'declared', source: `github.accounts[owner=${account.owner}]`, value: account.ghUser };
  }
  return { gitAuthorEmail: authorEmailFact(emailAnswer), githubAccount, githubOwners, repositories };
};

/** A revision the caller may name: the request pattern, and never something git would read as an option. */
const isAcceptableRevision = (revision: string): boolean =>
  DELEGATION_REVISION_PATTERN.test(revision) && !revision.startsWith('-');

const resolveCommit = async (
  checkoutPath: string,
  revision: string,
  environment: Readonly<Record<string, string>>,
): Promise<string | DelegationScopeFailure> => {
  if (!isAcceptableRevision(revision)) {
    return scopeUnavailable('a revision must match the request pattern and must not start with "-"');
  }
  const answer = await tryGit(
    checkoutPath,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`],
    environment,
    4096,
  );
  if (answer instanceof GitRunError) {
    return scopeUnavailable(`git rev-parse ${answer.kind}; ${revision} cannot be resolved`);
  }
  const sha = answer.stdout.trim();
  if (answer.exitCode !== 0 || !OBJECT_ID.test(sha)) {
    return scopeUnavailable(`${revision} does not resolve to a commit in this checkout`);
  }
  return sha;
};

const isFailure = (value: string | DelegationScopeFailure): value is DelegationScopeFailure =>
  typeof value !== 'string';

/**
 * The scope frozen to object ids. A `commit` is compared with its first parent (the empty tree for
 * a root commit); a `range` needs its base to be an ancestor of its head and at least one commit
 * between them. Refs reach git after `--end-of-options` only.
 */
export const freezeDelegationScope = async (
  checkoutPath: string,
  scope: DelegationScopeRequest,
  options: DelegationCheckoutOptions = {},
): Promise<FrozenDelegationScope | DelegationScopeFailure> => {
  const environment = gitScopeEnvironment(options.env ?? process.env);
  if (scope.kind === 'commit') {
    const headSha = await resolveCommit(checkoutPath, scope.commit, environment);
    if (isFailure(headSha)) {
      return headSha;
    }
    const parents = await tryGit(
      checkoutPath,
      ['rev-list', '--parents', '--max-count=1', '--end-of-options', headSha],
      environment,
      16 * 1024,
    );
    if (parents instanceof GitRunError || parents.exitCode !== 0) {
      return scopeUnavailable(`the parents of ${headSha} cannot be read`);
    }
    const [listed, ...parentShas] = parents.stdout.trim().split(WHITESPACE);
    if (listed !== headSha || !parentShas.every((sha) => OBJECT_ID.test(sha) && sha.length === headSha.length)) {
      return scopeUnavailable(`the parents of ${headSha} cannot be read`);
    }
    const firstParent = parentShas[0];
    const emptyTree = headSha.length === 40 ? GIT_EMPTY_TREE.sha1 : GIT_EMPTY_TREE.sha256;
    return {
      base: firstParent === undefined ? 'empty-tree' : 'first-parent',
      baseRef: null,
      baseSha: firstParent ?? emptyTree,
      commitCount: 1,
      headRef: scope.commit,
      headSha,
      kind: 'commit',
    };
  }
  const [baseSha, headSha] = await Promise.all([
    resolveCommit(checkoutPath, scope.base, environment),
    resolveCommit(checkoutPath, scope.head, environment),
  ]);
  if (isFailure(baseSha)) {
    return baseSha;
  }
  if (isFailure(headSha)) {
    return headSha;
  }
  const ancestry = await tryGit(
    checkoutPath,
    ['merge-base', '--is-ancestor', '--end-of-options', baseSha, headSha],
    environment,
    4096,
  );
  if (ancestry instanceof GitRunError) {
    return scopeUnavailable(`git merge-base ${ancestry.kind}; the range cannot be checked`);
  }
  if (ancestry.exitCode !== 0) {
    return scopeUnavailable(`${scope.base} (${baseSha}) is not an ancestor of ${scope.head} (${headSha})`);
  }
  const count = await tryGit(
    checkoutPath,
    ['rev-list', '--count', '--end-of-options', `${baseSha}..${headSha}`],
    environment,
    4096,
  );
  if (count instanceof GitRunError || count.exitCode !== 0) {
    return scopeUnavailable(`the commits of ${baseSha}..${headSha} cannot be counted`);
  }
  const commitCount = Number.parseInt(count.stdout.trim(), 10);
  if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
    return scopeUnavailable(`the commits of ${baseSha}..${headSha} cannot be counted`);
  }
  if (commitCount === 0) {
    return scopeUnavailable(
      `${scope.base} and ${scope.head} resolve to the same commit ${headSha}; the range is empty`,
    );
  }
  return {
    base: 'range-base',
    baseRef: scope.base,
    baseSha,
    commitCount,
    headRef: scope.head,
    headSha,
    kind: 'range',
  };
};
