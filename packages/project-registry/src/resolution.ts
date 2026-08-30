import type {
  DeviceId,
  Repository,
  RepositoryAlias,
  RepositoryId,
  ScmProvider,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  normalizeSessionVcsRepository,
  sessionVcsRepositoryAliasKey,
  sessionVcsRepositoryProvider,
} from '@ai-usage/report-core/session-vcs';

const maximumLocalPathLength = 4096;
const maximumRepositorySubpathLength = 1024;

export const normalizeRepositoryAlias = (remote: string): string | null => {
  const normalized = normalizeSessionVcsRepository(remote, 'local-derived');
  return normalized ? sessionVcsRepositoryAliasKey(normalized) : null;
};

export interface VerifiedProviderRepository {
  readonly provider: ScmProvider;
  readonly providerRepositoryId: string;
}

export interface ObservedCheckout {
  readonly deviceId: DeviceId;
  readonly localPath: string;
  readonly observedRemote: string | null;
  readonly repositorySubpath: string | null;
  readonly spaceId: SpaceId;
  readonly verifiedProviderRepository: VerifiedProviderRepository | null;
}

export interface RepositoryResolutionCandidate {
  readonly aliases: readonly RepositoryAlias[];
  readonly repository: Repository;
}

export type RepositoryResolution =
  | { readonly kind: 'invalid'; readonly reason: 'checkout-invalid' | 'remote-invalid' }
  | { readonly kind: 'unassigned'; readonly reason: 'no-remote'; readonly spaceId: SpaceId }
  | {
      readonly aliasDisagreement: boolean;
      readonly kind: 'resolved';
      readonly matchedBy: 'alias' | 'provider-id';
      readonly normalizedRemote: string;
      readonly repositoryId: RepositoryId;
      readonly spaceId: SpaceId;
    }
  | {
      readonly candidateRepositoryIds: readonly RepositoryId[];
      readonly kind: 'ambiguous';
      readonly matchedBy: 'alias' | 'provider-id';
      readonly normalizedRemote: string;
      readonly spaceId: SpaceId;
    }
  | {
      readonly canonicalHost: string;
      readonly canonicalName: string;
      readonly canonicalOwner: string | null;
      readonly kind: 'candidate';
      readonly normalizedRemote: string;
      readonly provider: ScmProvider;
      readonly repositorySubpath: string | null;
      readonly spaceId: SpaceId;
    };

const validLocalPath = (value: string): boolean =>
  value.length > 0 && value.length <= maximumLocalPathLength && !value.includes('\0');

const validRepositorySubpath = (value: string | null): boolean => {
  if (value === null) {
    return true;
  }
  if (
    value.length === 0 ||
    value.length > maximumRepositorySubpathLength ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

const uniqueRepositoryIds = (candidates: readonly RepositoryResolutionCandidate[]): readonly RepositoryId[] =>
  [...new Set(candidates.map(({ repository }) => repository.id))].sort((left, right) => left.localeCompare(right));

const candidateForId = (
  candidates: readonly RepositoryResolutionCandidate[],
  repositoryId: RepositoryId,
): RepositoryResolutionCandidate | undefined => candidates.find(({ repository }) => repository.id === repositoryId);

const aliasDisagrees = (candidate: RepositoryResolutionCandidate, normalizedRemote: string): boolean =>
  !candidate.aliases.some(
    (alias) =>
      alias.owningSpaceId === candidate.repository.owningSpaceId && alias.normalizedRemote === normalizedRemote,
  );

export const resolveObservedRepository = (
  checkout: ObservedCheckout,
  candidates: readonly RepositoryResolutionCandidate[],
): RepositoryResolution => {
  if (!(validLocalPath(checkout.localPath) && validRepositorySubpath(checkout.repositorySubpath))) {
    return { kind: 'invalid', reason: 'checkout-invalid' };
  }
  if (checkout.observedRemote === null || checkout.observedRemote.trim().length === 0) {
    return { kind: 'unassigned', reason: 'no-remote', spaceId: checkout.spaceId };
  }
  const normalized = normalizeSessionVcsRepository(checkout.observedRemote, 'local-derived');
  if (!normalized) {
    return { kind: 'invalid', reason: 'remote-invalid' };
  }
  const normalizedRemote = normalizeRepositoryAlias(checkout.observedRemote);
  if (!normalizedRemote) {
    return { kind: 'invalid', reason: 'remote-invalid' };
  }
  const spaceCandidates = candidates.filter(({ repository }) => repository.owningSpaceId === checkout.spaceId);
  const verified = checkout.verifiedProviderRepository;
  if (verified) {
    const providerMatches = spaceCandidates.filter(
      ({ repository }) =>
        repository.provider === verified.provider && repository.providerRepositoryId === verified.providerRepositoryId,
    );
    const providerRepositoryIds = uniqueRepositoryIds(providerMatches);
    if (providerRepositoryIds.length > 1) {
      return {
        candidateRepositoryIds: providerRepositoryIds,
        kind: 'ambiguous',
        matchedBy: 'provider-id',
        normalizedRemote,
        spaceId: checkout.spaceId,
      };
    }
    const repositoryId = providerRepositoryIds[0];
    if (repositoryId) {
      const candidate = candidateForId(providerMatches, repositoryId);
      return {
        aliasDisagreement: candidate ? aliasDisagrees(candidate, normalizedRemote) : true,
        kind: 'resolved',
        matchedBy: 'provider-id',
        normalizedRemote,
        repositoryId,
        spaceId: checkout.spaceId,
      };
    }
  }

  const aliasMatches = spaceCandidates.filter(({ aliases, repository }) =>
    aliases.some(
      (alias) =>
        alias.owningSpaceId === checkout.spaceId &&
        alias.repositoryId === repository.id &&
        alias.normalizedRemote === normalizedRemote,
    ),
  );
  const aliasRepositoryIds = uniqueRepositoryIds(aliasMatches);
  if (aliasRepositoryIds.length > 1) {
    return {
      candidateRepositoryIds: aliasRepositoryIds,
      kind: 'ambiguous',
      matchedBy: 'alias',
      normalizedRemote,
      spaceId: checkout.spaceId,
    };
  }
  const repositoryId = aliasRepositoryIds[0];
  if (repositoryId) {
    return {
      aliasDisagreement: false,
      kind: 'resolved',
      matchedBy: 'alias',
      normalizedRemote,
      repositoryId,
      spaceId: checkout.spaceId,
    };
  }

  const ownerSegments = normalized.ownerPath.split('/');
  const canonicalName = ownerSegments.at(-1);
  if (!canonicalName) {
    return { kind: 'invalid', reason: 'remote-invalid' };
  }
  return {
    canonicalHost: normalized.host,
    canonicalName,
    canonicalOwner: ownerSegments.length > 1 ? ownerSegments.slice(0, -1).join('/') : null,
    kind: 'candidate',
    normalizedRemote,
    provider: sessionVcsRepositoryProvider(normalized),
    repositorySubpath: checkout.repositorySubpath,
    spaceId: checkout.spaceId,
  };
};
