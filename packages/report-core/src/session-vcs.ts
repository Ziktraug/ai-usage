export const MAX_SESSION_VCS_BRANCHES = 32;
export const MAX_SESSION_VCS_PULL_REQUESTS = 16;
export const MAX_SESSION_VCS_TEXT_LENGTH = 256;
export const MAX_SESSION_VCS_URL_LENGTH = 2048;
export const MAX_SESSION_VCS_COMMIT_LENGTH = 64;
export const MAX_SESSION_VCS_CONTEXT_BYTES = 64 * 1024;

export type SessionVcsProvenance = 'harness-recorded' | 'local-derived';

export interface SessionVcsRepository {
  host: string;
  ownerPath: string;
  provenance: SessionVcsProvenance;
  webUrl: string | null;
}

export interface SessionVcsBranchSpan {
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  name: string;
  provenance: SessionVcsProvenance;
  webUrl: string | null;
}

export interface SessionVcsCommit {
  hash: string;
  observedAt: string | null;
  provenance: SessionVcsProvenance;
  webUrl: string | null;
}

export interface SessionVcsPullRequest {
  number: number | null;
  observedAt: string | null;
  repository: string | null;
  url: string;
}

export interface SessionVcsContext {
  branches: SessionVcsBranchSpan[];
  headCommit: SessionVcsCommit | null;
  partial: boolean;
  pullRequests: SessionVcsPullRequest[];
  repository: SessionVcsRepository | null;
}

export interface SessionVcsBranchObservation {
  name: string;
  observedAt: string | null;
}

const COMMIT_PATTERN = /^[0-9a-fA-F]{1,64}$/;
const SCP_REMOTE_PATTERN = /^(?:([^@\s]+)@)?([^/:\s]+):(.+)$/;
const SAFE_HOST_PATTERN = /^[a-zA-Z0-9.-]+$/;
const EDGE_SLASH_PATTERN = /^\/+|\/+$/g;
const DOT_GIT_SUFFIX_PATTERN = /\.git$/i;
const REPOSITORY_KEYS = new Set(['host', 'ownerPath', 'provenance', 'webUrl']);
const BRANCH_KEYS = new Set(['firstObservedAt', 'lastObservedAt', 'name', 'provenance', 'webUrl']);
const COMMIT_KEYS = new Set(['hash', 'observedAt', 'provenance', 'webUrl']);
const PULL_REQUEST_KEYS = new Set(['number', 'observedAt', 'repository', 'url']);
const CONTEXT_KEYS = new Set(['branches', 'headCommit', 'partial', 'pullRequests', 'repository']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const isBoundedText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_SESSION_VCS_TEXT_LENGTH &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const isNullableTimestamp = (value: unknown): value is string | null => value === null || isTimestamp(value);

const isProvenance = (value: unknown): value is SessionVcsProvenance =>
  value === 'harness-recorded' || value === 'local-derived';

const safeHttpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_VCS_URL_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.hostname === ''
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const encodedPath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');

const repositoryWebUrl = (host: string, ownerPath: string): string | null => {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost !== 'github.com' && normalizedHost !== 'gitlab.com') {
    return null;
  }
  return `https://${normalizedHost}/${encodedPath(ownerPath)}`;
};

const normalizeOwnerPath = (value: string): string | null => {
  const withoutSlashes = value.replace(EDGE_SLASH_PATTERN, '').replace(DOT_GIT_SUFFIX_PATTERN, '');
  let decoded: string;
  try {
    decoded = withoutSlashes
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }
  const segments = decoded.split('/');
  if (
    !isBoundedText(decoded) ||
    segments.length < 2 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return decoded;
};

export const normalizeSessionVcsRepository = (
  remote: string,
  provenance: SessionVcsProvenance,
): SessionVcsRepository | null => {
  if (typeof remote !== 'string' || remote.length === 0 || remote.length > MAX_SESSION_VCS_URL_LENGTH) {
    return null;
  }
  if (remote.includes('://') && !remote.startsWith('https://')) {
    return null;
  }
  let host: string;
  let ownerPathValue: string;
  if (remote.startsWith('https://')) {
    const normalized = safeHttpsUrl(remote);
    if (!normalized) {
      return null;
    }
    const parsed = new URL(normalized);
    host = parsed.hostname.toLowerCase();
    ownerPathValue = parsed.pathname;
  } else {
    const match = SCP_REMOTE_PATTERN.exec(remote);
    if (!match || (match[1] !== undefined && match[1] !== 'git')) {
      return null;
    }
    host = match[2]!.toLowerCase();
    ownerPathValue = match[3]!;
    if (ownerPathValue.includes('?') || ownerPathValue.includes('#')) {
      return null;
    }
  }
  const ownerPath = normalizeOwnerPath(ownerPathValue);
  if (!(isBoundedText(host) && SAFE_HOST_PATTERN.test(host) && ownerPath)) {
    return null;
  }
  return { host, ownerPath, provenance, webUrl: repositoryWebUrl(host, ownerPath) };
};

export const sessionVcsBranchUrl = (repository: SessionVcsRepository, branch: string): string | null => {
  if (!(repository.webUrl && isBoundedText(branch))) {
    return null;
  }
  const marker = repository.host.toLowerCase() === 'gitlab.com' ? '/-/tree/' : '/tree/';
  return safeHttpsUrl(`${repository.webUrl}${marker}${encodedPath(branch)}`);
};

export const sessionVcsCommitUrl = (repository: SessionVcsRepository, hash: string): string | null => {
  if (!(repository.webUrl && COMMIT_PATTERN.test(hash))) {
    return null;
  }
  const marker = repository.host.toLowerCase() === 'gitlab.com' ? '/-/commit/' : '/commit/';
  return safeHttpsUrl(`${repository.webUrl}${marker}${hash.toLowerCase()}`);
};

export const compactSessionVcsBranchObservations = (
  observations: readonly SessionVcsBranchObservation[],
  provenance: SessionVcsProvenance,
  repository: SessionVcsRepository | null,
): { partial: boolean; spans: SessionVcsBranchSpan[] } => {
  const spans: SessionVcsBranchSpan[] = [];
  let partial = false;
  for (const observation of observations) {
    if (!(isBoundedText(observation.name) && isNullableTimestamp(observation.observedAt))) {
      partial = true;
      continue;
    }
    const previous = spans.at(-1);
    if (previous?.name === observation.name) {
      previous.lastObservedAt = observation.observedAt;
      continue;
    }
    if (spans.length >= MAX_SESSION_VCS_BRANCHES) {
      partial = true;
      continue;
    }
    spans.push({
      firstObservedAt: observation.observedAt,
      lastObservedAt: observation.observedAt,
      name: observation.name,
      provenance,
      webUrl: repository ? sessionVcsBranchUrl(repository, observation.name) : null,
    });
  }
  return { partial, spans };
};

const isPullRequest = (value: unknown): value is SessionVcsPullRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, PULL_REQUEST_KEYS) &&
  (value.number === null || (Number.isSafeInteger(value.number) && Number(value.number) > 0)) &&
  isNullableTimestamp(value.observedAt) &&
  (value.repository === null || isBoundedText(value.repository)) &&
  safeHttpsUrl(value.url) !== null;

export const normalizeSessionVcsPullRequests = (
  candidates: readonly unknown[],
): { partial: boolean; pullRequests: SessionVcsPullRequest[] } => {
  const byUrl = new Map<string, SessionVcsPullRequest>();
  let partial = false;
  for (const candidate of candidates) {
    if (!isPullRequest(candidate)) {
      partial = true;
      continue;
    }
    const url = safeHttpsUrl(candidate.url)!;
    if (!byUrl.has(url)) {
      byUrl.set(url, { ...candidate, url });
    }
  }
  const pullRequests = [...byUrl.values()].sort(
    (left, right) => (left.observedAt ?? '').localeCompare(right.observedAt ?? '') || left.url.localeCompare(right.url),
  );
  if (pullRequests.length > MAX_SESSION_VCS_PULL_REQUESTS) {
    partial = true;
    pullRequests.length = MAX_SESSION_VCS_PULL_REQUESTS;
  }
  return { partial, pullRequests };
};

const parseRepository = (value: unknown): SessionVcsRepository => {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, REPOSITORY_KEYS) &&
      isBoundedText(value.host) &&
      SAFE_HOST_PATTERN.test(value.host) &&
      isBoundedText(value.ownerPath) &&
      isProvenance(value.provenance)
    ) ||
    (value.webUrl !== null && safeHttpsUrl(value.webUrl) === null)
  ) {
    throw new Error('Session VCS repository is invalid');
  }
  return value as unknown as SessionVcsRepository;
};

const parseBranch = (value: unknown): SessionVcsBranchSpan => {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, BRANCH_KEYS) &&
      isNullableTimestamp(value.firstObservedAt) &&
      isNullableTimestamp(value.lastObservedAt) &&
      isBoundedText(value.name) &&
      isProvenance(value.provenance)
    ) ||
    (value.webUrl !== null && safeHttpsUrl(value.webUrl) === null) ||
    (value.firstObservedAt !== null &&
      value.lastObservedAt !== null &&
      Date.parse(value.lastObservedAt) < Date.parse(value.firstObservedAt))
  ) {
    throw new Error('Session VCS branch is invalid');
  }
  return value as unknown as SessionVcsBranchSpan;
};

const parseCommit = (value: unknown): SessionVcsCommit => {
  if (
    !(isRecord(value) && hasOnlyKeys(value, COMMIT_KEYS)) ||
    typeof value.hash !== 'string' ||
    !COMMIT_PATTERN.test(value.hash) ||
    value.hash.length > MAX_SESSION_VCS_COMMIT_LENGTH ||
    !isNullableTimestamp(value.observedAt) ||
    !isProvenance(value.provenance) ||
    (value.webUrl !== null && safeHttpsUrl(value.webUrl) === null)
  ) {
    throw new Error('Session VCS commit is invalid');
  }
  return value as unknown as SessionVcsCommit;
};

export const parseSessionVcsContext = (value: unknown): SessionVcsContext => {
  if (!(isRecord(value) && hasOnlyKeys(value, CONTEXT_KEYS))) {
    throw new Error('Session VCS context is invalid');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SESSION_VCS_CONTEXT_BYTES) {
    throw new Error('Session VCS context exceeds its byte budget');
  }
  if (
    !Array.isArray(value.branches) ||
    value.branches.length > MAX_SESSION_VCS_BRANCHES ||
    !Array.isArray(value.pullRequests) ||
    value.pullRequests.length > MAX_SESSION_VCS_PULL_REQUESTS ||
    typeof value.partial !== 'boolean'
  ) {
    throw new Error('Session VCS context exceeds its item budget');
  }
  const branches = value.branches.map(parseBranch);
  const pullRequests = value.pullRequests.map((pullRequest) => {
    if (!isPullRequest(pullRequest)) {
      throw new Error('Session VCS pull request is invalid');
    }
    return pullRequest;
  });
  if (new Set(pullRequests.map(({ url }) => url)).size !== pullRequests.length) {
    throw new Error('Session VCS pull requests must be unique');
  }
  const sortedPullRequests = [...pullRequests].sort(
    (left, right) => (left.observedAt ?? '').localeCompare(right.observedAt ?? '') || left.url.localeCompare(right.url),
  );
  if (pullRequests.some((pullRequest, index) => pullRequest !== sortedPullRequests[index])) {
    throw new Error('Session VCS pull requests must be chronologically ordered');
  }
  const repository = value.repository === null ? null : parseRepository(value.repository);
  if (repository && repository.webUrl !== repositoryWebUrl(repository.host, repository.ownerPath)) {
    throw new Error('Session VCS repository URL does not match its forge');
  }
  for (const branch of branches) {
    if (branch.webUrl !== (repository ? sessionVcsBranchUrl(repository, branch.name) : null)) {
      throw new Error('Session VCS branch URL does not match its repository');
    }
  }
  for (let index = 1; index < branches.length; index += 1) {
    const previous = branches[index - 1]!;
    const current = branches[index]!;
    if (
      previous.firstObservedAt !== null &&
      current.firstObservedAt !== null &&
      current.firstObservedAt.localeCompare(previous.firstObservedAt) < 0
    ) {
      throw new Error('Session VCS branches must be chronologically ordered');
    }
  }
  const headCommit = value.headCommit === null ? null : parseCommit(value.headCommit);
  if (headCommit && headCommit.webUrl !== (repository ? sessionVcsCommitUrl(repository, headCommit.hash) : null)) {
    throw new Error('Session VCS commit URL does not match its repository');
  }
  return {
    branches,
    headCommit,
    partial: value.partial,
    pullRequests,
    repository,
  };
};

export const isSessionVcsContext = (value: unknown): value is SessionVcsContext => {
  try {
    parseSessionVcsContext(value);
    return true;
  } catch {
    return false;
  }
};
