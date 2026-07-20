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

export interface SessionVcsResolveRequest {
  revision: string;
  rowId: string;
}

export type SessionVcsResolveUnavailableReason =
  | 'not-local'
  | 'provenance-unavailable'
  | 'resolver-unavailable'
  | 'repository-unsupported'
  | 'not-found'
  | 'timed-out';

export type SessionVcsResolveResponse =
  | { pullRequests: SessionVcsPullRequest[]; repositoryUrl: string; status: 'available' }
  | { reason: SessionVcsResolveUnavailableReason; status: 'unavailable' };

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
const RESOLVE_RESPONSE_AVAILABLE_KEYS = new Set(['pullRequests', 'repositoryUrl', 'status']);
const RESOLVE_RESPONSE_UNAVAILABLE_KEYS = new Set(['reason', 'status']);
const RESOLVE_REQUEST_KEYS = new Set(['revision', 'rowId']);
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
    const sshUser = match?.[1];
    const matchedHost = match?.[2];
    const matchedOwnerPath = match?.[3];
    if (!(matchedHost && matchedOwnerPath) || (sshUser !== undefined && sshUser !== 'git')) {
      return null;
    }
    host = matchedHost.toLowerCase();
    ownerPathValue = matchedOwnerPath;
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
    const url = safeHttpsUrl(candidate.url);
    if (!url) {
      partial = true;
      continue;
    }
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
  if (!isRecord(value)) {
    throw new Error('Session VCS repository is invalid');
  }
  const { host, ownerPath, provenance, webUrl } = value;
  const normalizedWebUrl = webUrl === null ? null : safeHttpsUrl(webUrl);
  if (
    !(
      hasOnlyKeys(value, REPOSITORY_KEYS) &&
      isBoundedText(host) &&
      SAFE_HOST_PATTERN.test(host) &&
      isBoundedText(ownerPath) &&
      isProvenance(provenance)
    ) ||
    (webUrl !== null && normalizedWebUrl === null)
  ) {
    throw new Error('Session VCS repository is invalid');
  }
  return { host, ownerPath, provenance, webUrl: normalizedWebUrl };
};

const parseBranch = (value: unknown): SessionVcsBranchSpan => {
  if (!isRecord(value)) {
    throw new Error('Session VCS branch is invalid');
  }
  const { firstObservedAt, lastObservedAt, name, provenance, webUrl } = value;
  const normalizedWebUrl = webUrl === null ? null : safeHttpsUrl(webUrl);
  if (
    !(
      hasOnlyKeys(value, BRANCH_KEYS) &&
      isNullableTimestamp(firstObservedAt) &&
      isNullableTimestamp(lastObservedAt) &&
      isBoundedText(name) &&
      isProvenance(provenance)
    ) ||
    (webUrl !== null && normalizedWebUrl === null) ||
    (firstObservedAt !== null && lastObservedAt !== null && Date.parse(lastObservedAt) < Date.parse(firstObservedAt))
  ) {
    throw new Error('Session VCS branch is invalid');
  }
  return { firstObservedAt, lastObservedAt, name, provenance, webUrl: normalizedWebUrl };
};

const parseCommit = (value: unknown): SessionVcsCommit => {
  if (!isRecord(value)) {
    throw new Error('Session VCS commit is invalid');
  }
  const { hash, observedAt, provenance, webUrl } = value;
  const normalizedWebUrl = webUrl === null ? null : safeHttpsUrl(webUrl);
  if (
    !hasOnlyKeys(value, COMMIT_KEYS) ||
    typeof hash !== 'string' ||
    !COMMIT_PATTERN.test(hash) ||
    hash.length > MAX_SESSION_VCS_COMMIT_LENGTH ||
    !isNullableTimestamp(observedAt) ||
    !isProvenance(provenance) ||
    (webUrl !== null && normalizedWebUrl === null)
  ) {
    throw new Error('Session VCS commit is invalid');
  }
  return { hash, observedAt, provenance, webUrl: normalizedWebUrl };
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
    const expectedWebUrl = repository ? sessionVcsBranchUrl(repository, branch.name) : null;
    const safelyOmittedPartialUrl = value.partial && branch.webUrl === null;
    if (branch.webUrl !== expectedWebUrl && !safelyOmittedPartialUrl) {
      throw new Error('Session VCS branch URL does not match its repository');
    }
  }
  for (let index = 1; index < branches.length; index += 1) {
    const previous = branches.at(index - 1);
    const current = branches.at(index);
    if (!(previous && current)) {
      throw new Error('Session VCS branches are invalid');
    }
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

export const parseSessionVcsResolveRequest = (value: unknown): SessionVcsResolveRequest => {
  if (!(isRecord(value) && hasOnlyKeys(value, RESOLVE_REQUEST_KEYS))) {
    throw new Error('Session VCS resolve request is invalid');
  }
  if (
    typeof value.revision !== 'string' ||
    value.revision.length === 0 ||
    value.revision.length > 512 ||
    typeof value.rowId !== 'string' ||
    value.rowId.length === 0 ||
    value.rowId.length > 512
  ) {
    throw new Error('Session VCS resolve request identity is invalid');
  }
  return { revision: value.revision, rowId: value.rowId };
};

const isResolveUnavailableReason = (value: unknown): value is SessionVcsResolveUnavailableReason => {
  switch (value) {
    case 'not-local':
    case 'provenance-unavailable':
    case 'resolver-unavailable':
    case 'repository-unsupported':
    case 'not-found':
    case 'timed-out':
      return true;
    default:
      return false;
  }
};

export const parseSessionVcsResolveResponse = (value: unknown): SessionVcsResolveResponse => {
  if (!isRecord(value)) {
    throw new Error('Session VCS resolve response is invalid');
  }
  if (value.status === 'unavailable') {
    if (!(hasOnlyKeys(value, RESOLVE_RESPONSE_UNAVAILABLE_KEYS) && isResolveUnavailableReason(value.reason))) {
      throw new Error('Session VCS unavailable response is invalid');
    }
    return { reason: value.reason, status: 'unavailable' };
  }
  const repositoryUrl = safeHttpsUrl(value.repositoryUrl);
  if (
    value.status !== 'available' ||
    !hasOnlyKeys(value, RESOLVE_RESPONSE_AVAILABLE_KEYS) ||
    repositoryUrl === null ||
    !Array.isArray(value.pullRequests)
  ) {
    throw new Error('Session VCS available response is invalid');
  }
  const validated = parseSessionVcsContext({
    branches: [],
    headCommit: null,
    partial: false,
    pullRequests: value.pullRequests,
    repository: null,
  });
  return {
    pullRequests: validated.pullRequests,
    repositoryUrl,
    status: 'available',
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
