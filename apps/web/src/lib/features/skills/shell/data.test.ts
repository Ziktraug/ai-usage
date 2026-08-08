import { describe, expect, test } from 'bun:test';
import type {
  ProjectSkillMarkdownDocument,
  ProjectSkillMarkdownInput,
  SaveSkillMarkdownInput,
  SkillManagementConfig,
  SkillMarkdownDocument,
  SkillTargetInput,
  SkillToggleInput,
} from '@ai-usage/web-contract/skills';
import { createRouterClient } from '@orpc/server';
import { createWebQueryClient } from '../../../query/client';
import { managedSkillMarkdownKey, projectSkillMarkdownKey } from '../../../query/options/skills';
import { createSkillsRouter, type SkillsCapability, type SkillsCapabilityResult } from '../../../server/rpc/skills';
import { deferredSkillsShellRoute, loadSkillsShellRoute, prefetchSkillsShellQueries } from './data';
import {
  syntheticInventories,
  syntheticKnownPaths,
  syntheticManagedDocument,
  syntheticProjectDocument,
  syntheticSnapshot,
} from './synthetic-fixture.test-helper';

const ok = <Value>(data: Value): SkillsCapabilityResult<Value> => ({ data, ok: true });

describe('Svelte Skills SSR data adapter', () => {
  test('prefetches each canonical resource once and reuses fresh cache state', async () => {
    const calls = { inventories: 0, knownPaths: 0, managed: 0, project: 0, snapshot: 0 };
    const snapshot = syntheticSnapshot();
    const capability: SkillsCapability = {
      createTargetDirectory: (_input: SkillTargetInput) => ok(snapshot),
      previewReconcileAll: () => ok({ actions: [], snapshot }),
      readKnownProjectPaths: () => {
        calls.knownPaths += 1;
        return ok([...syntheticKnownPaths]);
      },
      readMarkdown: () => {
        calls.managed += 1;
        return ok(syntheticManagedDocument);
      },
      readProjectInventories: () => {
        calls.inventories += 1;
        return ok([...syntheticInventories]);
      },
      readProjectMarkdown: (_input: ProjectSkillMarkdownInput) => {
        calls.project += 1;
        return ok(syntheticProjectDocument);
      },
      readSnapshot: () => {
        calls.snapshot += 1;
        return ok(snapshot);
      },
      reconcileAll: () => ok({ actions: [], snapshot }),
      reconcileSkill: () => ok({ actions: [], snapshot }),
      refreshSnapshot: () => ok(snapshot),
      saveConfig: (_input: SkillManagementConfig) => ok(snapshot),
      saveMarkdown: (_input: SaveSkillMarkdownInput) => ok({ reason: 'conflict' }),
      toggleSkill: (_input: SkillToggleInput) => ok({ actions: [], snapshot }),
    };
    const queryClient = createWebQueryClient();
    const runtime = {
      queryClient,
      rpc: { skills: createRouterClient(createSkillsRouter(() => capability)) },
    };

    const source = await prefetchSkillsShellQueries(runtime, '/skills/global/alpha-skill');
    await prefetchSkillsShellQueries(runtime, '/skills/global/alpha-skill');
    expect(source).toBe('/synthetic/source');
    expect(calls).toEqual({ inventories: 1, knownPaths: 1, managed: 1, project: 0, snapshot: 1 });
    expect(queryClient.getQueryData<SkillMarkdownDocument>(managedSkillMarkdownKey('alpha-skill'))).toEqual(
      syntheticManagedDocument,
    );

    await prefetchSkillsShellQueries(runtime, '/skills/projects/synthetic-group/project-review');
    expect(calls).toEqual({ inventories: 1, knownPaths: 1, managed: 1, project: 1, snapshot: 1 });
    expect(
      queryClient.getQueryData<ProjectSkillMarkdownDocument>(
        projectSkillMarkdownKey({
          projectPath: '/synthetic/project',
          runtimeDirId: 'agents-project',
          skillName: 'project-review',
        }),
      ),
    ).toEqual(syntheticProjectDocument);
    queryClient.clear();
  });

  test('returns the demo redirect decision before constructing or acquiring a runtime', async () => {
    let requests = 0;
    const result = await loadSkillsShellRoute({
      mode: 'demo',
      options: {
        fetch: () => {
          requests += 1;
          return Promise.reject(new Error('demo acquisition tripwire'));
        },
        url: new URL('http://127.0.0.1:4178/skills/global'),
      },
      pathname: '/skills/global',
    });
    expect(result).toEqual({ decision: 'redirect-report' });
    expect(requests).toBe(0);
  });

  test('returns an empty SPA hydration delta without constructing a route Query runtime', () => {
    expect(deferredSkillsShellRoute()).toEqual({
      decision: 'render',
      queryState: { dehydratedState: { mutations: [], queries: [] } },
      source: 'not configured',
    });
  });
});
