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
const GITHUB_HTTPS = /^https?:\/\/(?:[^/@\s]+@)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu;
const GITHUB_SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
/** Remote lines looked at; a checkout with more remotes is read on its first ones only. */
const MAX_REMOTE_LINES = 64;
const MAX_EMAIL_LENGTH = 320;

const observed = <Value>(source: string, value: Value): DelegationFact<Value> => ({
  provenance: 'observed',
  source,
  value,
});
const unknown = <Value>(source: string): DelegationFact<Value> => ({ provenance: 'unknown', source, value: null });

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

interface GitHubRemote {
  readonly owner: string;
  readonly repository: string;
}

const githubRemote = (url: string): GitHubRemote | null => {
  const match = GITHUB_HTTPS.exec(url) ?? GITHUB_SSH.exec(url);
  const owner = match?.[1];
  const repository = match?.[2];
  if (owner === undefined || repository === undefined) {
    return null;
  }
  return GITHUB_OWNER.test(owner) && GITHUB_REPOSITORY.test(repository) ? { owner, repository } : null;
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

export const parseGitHubRemotes = (remoteList: string): readonly GitHubRemote[] => {
  const remotes: GitHubRemote[] = [];
  for (const line of remoteList.split('\n').slice(0, MAX_REMOTE_LINES)) {
    const url = REMOTE_LINE.exec(line)?.[2];
    const remote = url === undefined ? null : githubRemote(url.trim());
    if (remote !== null) {
      remotes.push(remote);
    }
  }
  return remotes;
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
 * What the checkout itself says: its github.com remotes (owners and `owner/name`), the `gh` login
 * the operator declared for the single owner, and the effective `user.email` of the checkout.
 * Every fact carries where it came from; a fact git could not answer is `unknown`, never guessed.
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
    const remotes = parseGitHubRemotes(remotesAnswer.stdout);
    githubOwners = observed('git remote -v', distinctIgnoringCase(remotes.map((remote) => remote.owner)));
    repositories = observed(
      'git remote -v',
      distinctIgnoringCase(remotes.map((remote) => `${remote.owner}/${remote.repository}`)),
    );
  } else {
    githubOwners = unknown(`git remote -v (exit ${remotesAnswer.exitCode})`);
    repositories = unknown(`git remote -v (exit ${remotesAnswer.exitCode})`);
  }
  let githubAccount: DelegationFact<string>;
  const owners = githubOwners.value;
  if (owners === null) {
    githubAccount = unknown('github.accounts (remotes unknown)');
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
