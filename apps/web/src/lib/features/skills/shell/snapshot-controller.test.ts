import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { QueryObserver } from '@tanstack/svelte-query';
import { parseSkillSnapshotResult } from '../../../../skills-client-contracts';
import { createWebQueryClient } from '../../../query/client';
import { skillsSnapshotKey } from '../../../query/options/skills';
import { webQueryPolicies } from '../../../query/policies';
import { createSkillsSnapshotController } from './snapshot-controller';
import { syntheticSnapshot } from './synthetic-fixture.test-helper';

const normalizedSnapshot = (snapshot = syntheticSnapshot()): SkillManagementSnapshot => {
  const parsed = parseSkillSnapshotResult({ data: snapshot, ok: true });
  if (!parsed.ok) {
    throw new Error('Synthetic Skills snapshot fixture must satisfy the domain contract');
  }
  return parsed.data;
};

describe('Svelte Skills snapshot controller adapter', () => {
  test('keeps dirty buffers outside Query and defers only destructive replacement', async () => {
    const commits: SkillManagementSnapshot[] = [];
    let discarded = 0;
    let focused = 0;
    const initial = normalizedSnapshot();
    const withoutSelectedSkill = normalizedSnapshot(syntheticSnapshot([]));
    const controller = createSkillsSnapshotController({
      initial,
      onCommit: (snapshot) => commits.push(snapshot),
    });
    controller.registerDraft({
      dirty: true,
      discard: () => {
        discarded += 1;
      },
      focus: () => {
        focused += 1;
      },
      skillName: 'alpha-skill',
    });

    expect(controller.apply(initial)).toBe('applied');
    expect(controller.apply(withoutSelectedSkill)).toBe('deferred');
    expect(controller.current()).toBe(initial);
    expect(controller.pending()).toBe(withoutSelectedSkill);
    controller.retainCurrent();
    expect(controller.pending()).toBeUndefined();
    controller.focusDraft();
    expect(focused).toBe(1);

    expect(controller.apply(withoutSelectedSkill)).toBe('deferred');
    expect(await controller.discardPending()).toBe(true);
    expect(discarded).toBe(1);
    expect(controller.current()).toBe(withoutSelectedSkill);
    expect(commits).toEqual([initial, withoutSelectedSkill]);
  });

  test('coordinates dirty retain, focus, and discard across real Query snapshot updates', async () => {
    const initial = normalizedSnapshot();
    const queryClient = createWebQueryClient();
    const queryKey = skillsSnapshotKey();
    queryClient.setQueryData(queryKey, initial);
    let accepted = initial;
    let focused = 0;
    let discarded = 0;
    const guard = {
      dirty: true,
      discard: () => {
        discarded += 1;
      },
      focus: () => {
        focused += 1;
      },
      skillName: 'alpha-skill',
    };
    const controller = createSkillsSnapshotController({
      initial,
      onCommit: (snapshot) => {
        accepted = snapshot;
      },
    });
    controller.registerDraft(guard);
    const observer = new QueryObserver(queryClient, {
      ...webQueryPolicies.finiteSwr,
      enabled: false,
      queryFn: () => Promise.resolve(initial),
      queryKey,
    });
    const unsubscribe = observer.subscribe(({ data }) => {
      if (data) {
        controller.apply(data);
      }
    });

    const firstRemoval = normalizedSnapshot(syntheticSnapshot([]));
    queryClient.setQueryData(queryKey, firstRemoval);
    await Promise.resolve();
    expect(controller.pending()).toEqual(firstRemoval);
    expect(accepted).toBe(initial);

    controller.retainCurrent();
    controller.focusDraft();
    expect(controller.pending()).toBeUndefined();
    expect(focused).toBe(1);
    expect(accepted).toBe(initial);

    const secondSnapshot = syntheticSnapshot([]);
    const secondRemoval = normalizedSnapshot({
      ...secondSnapshot,
      config: { ...secondSnapshot.config, sourceRepoPath: '/synthetic/refreshed-source' },
    });
    queryClient.setQueryData(queryKey, secondRemoval);
    await Promise.resolve();
    expect(controller.pending()).toEqual(secondRemoval);
    expect(await controller.discardPending()).toBe(true);
    expect(discarded).toBe(1);
    expect(accepted).toEqual(secondRemoval);

    controller.unregisterDraft(guard);
    unsubscribe();
    queryClient.clear();
  });
});
