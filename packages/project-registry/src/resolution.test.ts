import { describe, expect, test } from 'bun:test';
import {
  createDeviceId,
  createRepositoryAliasId,
  createRepositoryId,
  createSpaceId,
  instantNow,
  type Repository,
  type RepositoryAlias,
} from '@ai-usage/platform-core/identity';
import { type ObservedCheckout, type RepositoryResolutionCandidate, resolveObservedRepository } from './resolution';

const observedAt = instantNow(() => new Date('2026-08-29T12:00:00.000Z'));

const repositoryCandidate = (
  spaceId: ReturnType<typeof createSpaceId>,
  remote: string,
  options: { readonly providerId?: string; readonly repositoryId?: ReturnType<typeof createRepositoryId> } = {},
): RepositoryResolutionCandidate => {
  const repositoryId = options.repositoryId ?? createRepositoryId();
  const repository: Repository = {
    canonicalHost: remote.split('/')[0] ?? 'github.com',
    canonicalName: remote.split('/').at(-1) ?? 'repo',
    canonicalOwner: remote.split('/').slice(1, -1).join('/') || null,
    id: repositoryId,
    owningSpaceId: spaceId,
    provider: remote.startsWith('github.com/') ? 'github' : 'generic',
    providerRepositoryId: options.providerId ?? null,
    status: 'active',
  };
  const alias: RepositoryAlias = {
    firstObservedAt: observedAt,
    id: createRepositoryAliasId(),
    lastObservedAt: null,
    normalizedRemote: remote,
    owningSpaceId: spaceId,
    repositoryId,
    source: 'local-git',
  };
  return { aliases: [alias], repository };
};

const checkout = (spaceId: ReturnType<typeof createSpaceId>): ObservedCheckout => ({
  deviceId: createDeviceId(),
  localPath: '/opaque/checkout',
  observedRemote: 'git@github.com:OpenAI/Codex.git',
  repositorySubpath: null,
  spaceId,
  verifiedProviderRepository: null,
});

describe('repository resolution', () => {
  test('treats HTTPS and SSH aliases equivalently for known providers', () => {
    const spaceId = createSpaceId();
    const candidate = repositoryCandidate(spaceId, 'github.com/openai/codex');
    expect(resolveObservedRepository(checkout(spaceId), [candidate])).toMatchObject({
      kind: 'resolved',
      matchedBy: 'alias',
      repositoryId: candidate.repository.id,
    });
  });

  test('gives a verified provider ID precedence and reports alias disagreement', () => {
    const spaceId = createSpaceId();
    const providerCandidate = repositoryCandidate(spaceId, 'github.com/renamed/codex', { providerId: 'R_123' });
    const aliasCandidate = repositoryCandidate(spaceId, 'github.com/openai/codex');
    expect(
      resolveObservedRepository(
        { ...checkout(spaceId), verifiedProviderRepository: { provider: 'github', providerRepositoryId: 'R_123' } },
        [providerCandidate, aliasCandidate],
      ),
    ).toEqual({
      aliasDisagreement: true,
      kind: 'resolved',
      matchedBy: 'provider-id',
      normalizedRemote: 'github.com/openai/codex',
      repositoryId: providerCandidate.repository.id,
      spaceId,
    });
  });

  test('returns every ambiguous candidate without choosing one', () => {
    const spaceId = createSpaceId();
    const left = repositoryCandidate(spaceId, 'github.com/openai/codex');
    const right = repositoryCandidate(spaceId, 'github.com/openai/codex');
    const result = resolveObservedRepository(checkout(spaceId), [right, left]);
    expect(result).toEqual({
      candidateRepositoryIds: [left.repository.id, right.repository.id].sort(),
      kind: 'ambiguous',
      matchedBy: 'alias',
      normalizedRemote: 'github.com/openai/codex',
      spaceId,
    });
  });

  test('isolates Spaces and preserves monorepo subpaths on new candidates', () => {
    const personalSpaceId = createSpaceId();
    const organizationSpaceId = createSpaceId();
    const foreign = repositoryCandidate(organizationSpaceId, 'github.com/openai/codex');
    expect(
      resolveObservedRepository({ ...checkout(personalSpaceId), repositorySubpath: 'packages/sdk' }, [foreign]),
    ).toMatchObject({
      kind: 'candidate',
      normalizedRemote: 'github.com/openai/codex',
      repositorySubpath: 'packages/sdk',
      spaceId: personalSpaceId,
    });
  });

  test('keeps self-hosted case and host boundaries distinct', () => {
    const spaceId = createSpaceId();
    const candidate = repositoryCandidate(spaceId, 'forge-a.example/Team/Repo');
    expect(
      resolveObservedRepository({ ...checkout(spaceId), observedRemote: 'git@forge-b.example:Team/Repo.git' }, [
        candidate,
      ]),
    ).toMatchObject({ kind: 'candidate', normalizedRemote: 'forge-b.example/Team/Repo' });
    expect(
      resolveObservedRepository({ ...checkout(spaceId), observedRemote: 'git@forge-a.example:team/repo.git' }, [
        candidate,
      ]),
    ).toMatchObject({ kind: 'candidate', normalizedRemote: 'forge-a.example/team/repo' });
  });

  test('makes no-remote and invalid checkout outcomes explicit', () => {
    const spaceId = createSpaceId();
    expect(resolveObservedRepository({ ...checkout(spaceId), observedRemote: null }, [])).toEqual({
      kind: 'unassigned',
      reason: 'no-remote',
      spaceId,
    });
    expect(resolveObservedRepository({ ...checkout(spaceId), repositorySubpath: '../secret' }, [])).toEqual({
      kind: 'invalid',
      reason: 'checkout-invalid',
    });
  });
});
