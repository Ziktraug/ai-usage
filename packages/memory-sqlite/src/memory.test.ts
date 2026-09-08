import { describe, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthorizedResourceScope } from '@ai-usage/authorization/scope-internal';
import { runMemoryRepositoryConformance } from '@ai-usage/memory-service/conformance';
import { openLocalIdentityKernel } from './identity';

describe('SQLite Memory repository', () => {
  test('passes the adapter-independent Memory contract', async () => {
    await runMemoryRepositoryConformance(async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-conformance-'));
      const kernel = await openLocalIdentityKernel({ databasePath: path.join(directory, 'memory.sqlite') });
      const identity = await kernel.getBootstrapIdentity();
      return {
        close: async () => {
          await kernel.close();
          await rm(directory, { force: true, recursive: true });
        },
        createAuthorizationScope: (resourceIds: readonly string[]) =>
          createAuthorizedResourceScope({
            activeSpaceId: identity.space.id,
            permission: 'view_memory',
            resourceIds,
            resourceKind: 'memory',
          }),
        personId: identity.person.id,
        projectId: null,
        repository: kernel.memory,
        spaceId: identity.space.id,
      };
    });
  });
});
