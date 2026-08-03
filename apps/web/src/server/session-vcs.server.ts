import fs from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { SessionDetailAnchorResult } from '@ai-usage/report-core/session-detail';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import {
  MAX_SESSION_VCS_PULL_REQUESTS,
  parseSessionVcsResolveRequest,
  parseSessionVcsResolveResponse,
  type SessionVcsPullRequest,
  type SessionVcsRepository,
  type SessionVcsResolveRequest,
  type SessionVcsResolveResponse,
} from '@ai-usage/report-core/session-vcs';
import {
  BoundedStdoutProcessError,
  type BoundedStdoutProcessOptions,
  runBoundedStdoutProcess,
} from './bounded-stdout-process.server';
import { authorizeLocalSessionAnchor } from './local-session-authority.server';
import { runRevisionQueryForServer } from './revision-query-runner.server';
import { resolveUsageReadModelForServer } from './usage-read-model-resolver.server';

const GH_TIMEOUT_MS = 5000;
const GH_MAXIMUM_OUTPUT_BYTES = 256 * 1024;
const GH_EXECUTABLE = 'gh';
const TRAILING_SLASH = /\/$/;

interface ResolverInput {
  branch: string;
  repository: SessionVcsRepository;
}

export interface SessionVcsProviderResolver {
  resolve(input: ResolverInput, options?: { readonly signal?: AbortSignal }): Promise<SessionVcsResolveResponse>;
}

export interface SessionVcsServerDependencies {
  readMachine(): Promise<{ id: string }>;
  resolveAnchor(request: SessionVcsResolveRequest): Promise<SessionQueryServerResult<SessionDetailAnchorResult>>;
  resolver: SessionVcsProviderResolver;
}

interface GhResolverDependencies {
  findExecutable(command: string): Promise<string | null>;
  run(options: BoundedStdoutProcessOptions): Promise<{ stdout: string }>;
}

const findExecutable = async (command: string): Promise<string | null> => {
  const searchPath = process.env.PATH;
  if (!searchPath) {
    return null;
  }
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    try {
      await access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded PATH entries without invoking a shell.
    }
  }
  return null;
};

const defaultGhDependencies: GhResolverDependencies = {
  findExecutable,
  run: runBoundedStdoutProcess,
};

const unavailable = (reason: Extract<SessionVcsResolveResponse, { status: 'unavailable' }>['reason']) =>
  ({ reason, status: 'unavailable' }) as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const providerPullRequests = (stdout: string, repository: SessionVcsRepository): SessionVcsPullRequest[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SESSION_VCS_PULL_REQUESTS) {
    return null;
  }
  const repositoryPath = repository.webUrl ? new URL(repository.webUrl).pathname.replace(TRAILING_SLASH, '') : null;
  if (!repositoryPath) {
    return null;
  }
  const pullRequests: SessionVcsPullRequest[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      return null;
    }
    if (
      Object.keys(item).some((key) => key !== 'number' && key !== 'url') ||
      !Number.isSafeInteger(item.number) ||
      Number(item.number) <= 0 ||
      typeof item.url !== 'string'
    ) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `${repositoryPath}/pull/${String(item.number)}`
    ) {
      return null;
    }
    pullRequests.push({
      number: Number(item.number),
      observedAt: null,
      repository: repository.ownerPath,
      url: url.toString(),
    });
  }
  pullRequests.sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
  return pullRequests;
};

const processFailureReason = (error: unknown): 'resolver-unavailable' | 'timed-out' => {
  if (
    (error instanceof BoundedStdoutProcessError && error.kind === 'timed-out') ||
    (error && typeof error === 'object' && 'kind' in error && error.kind === 'timed-out')
  ) {
    return 'timed-out';
  }
  return 'resolver-unavailable';
};

export const createGhSessionVcsProviderResolver = (
  dependencies: GhResolverDependencies = defaultGhDependencies,
): SessionVcsProviderResolver => ({
  resolve: async ({ branch, repository }, options = {}) => {
    options.signal?.throwIfAborted();
    if (!(repository.host === 'github.com' && repository.webUrl)) {
      return unavailable('repository-unsupported');
    }
    let executable: string | null;
    try {
      executable = await dependencies.findExecutable(GH_EXECUTABLE);
    } catch {
      options.signal?.throwIfAborted();
      executable = null;
    }
    options.signal?.throwIfAborted();
    if (!executable) {
      return unavailable('resolver-unavailable');
    }
    let stdout: string;
    try {
      const result = await dependencies.run({
        args: [
          'pr',
          'list',
          '--repo',
          repository.ownerPath,
          '--head',
          branch,
          '--state',
          'all',
          '--limit',
          String(MAX_SESSION_VCS_PULL_REQUESTS),
          '--json',
          'number,url',
        ],
        command: executable,
        maximumOutputBytes: GH_MAXIMUM_OUTPUT_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: GH_TIMEOUT_MS,
      });
      stdout = result.stdout;
      options.signal?.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      return unavailable(processFailureReason(error));
    }
    const pullRequests = providerPullRequests(stdout, repository);
    if (!pullRequests) {
      return unavailable('resolver-unavailable');
    }
    if (pullRequests.length === 0) {
      return unavailable('not-found');
    }
    return parseSessionVcsResolveResponse({
      pullRequests,
      repositoryUrl: repository.webUrl,
      status: 'available',
    });
  },
});

const defaultDependencies = (signal?: AbortSignal): SessionVcsServerDependencies => ({
  readMachine: async () =>
    await (await resolveUsageReadModelForServer()).readLocalMachine(signal === undefined ? {} : { signal }),
  resolveAnchor: (request) =>
    runRevisionQueryForServer('session-detail-anchor', request, undefined, signal === undefined ? {} : { signal }),
  resolver: createGhSessionVcsProviderResolver(),
});

export const resolveSessionVcsForServer = async (
  input: SessionVcsResolveRequest,
  dependencies?: SessionVcsServerDependencies,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SessionVcsResolveResponse> => {
  options.signal?.throwIfAborted();
  const activeDependencies = dependencies ?? defaultDependencies(options.signal);
  const request = parseSessionVcsResolveRequest(input);
  const anchorResult = await activeDependencies.resolveAnchor(request);
  options.signal?.throwIfAborted();
  if (!anchorResult.ok) {
    return unavailable('provenance-unavailable');
  }
  const { anchor } = anchorResult.data;
  if (!anchor) {
    return unavailable('provenance-unavailable');
  }
  const authorization = await authorizeLocalSessionAnchor(anchor, activeDependencies.readMachine);
  options.signal?.throwIfAborted();
  if (authorization.status === 'unauthorized') {
    return unavailable(authorization.reason === 'provenance-unavailable' ? 'provenance-unavailable' : 'not-local');
  }
  const repository = anchor.vcs?.repository;
  const branch = anchor.vcs?.branches.at(-1)?.name;
  if (!(repository && branch)) {
    return unavailable('provenance-unavailable');
  }
  if (repository.host !== 'github.com' || !repository.webUrl) {
    return unavailable('repository-unsupported');
  }
  const response = await activeDependencies.resolver.resolve(
    { branch, repository },
    options.signal === undefined ? {} : { signal: options.signal },
  );
  options.signal?.throwIfAborted();
  return parseSessionVcsResolveResponse(response);
};
