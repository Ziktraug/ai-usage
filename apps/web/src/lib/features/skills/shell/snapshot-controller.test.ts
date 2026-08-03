import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { parseSkillSnapshotResult } from '../../../../skills-client-contracts';
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
    expect(focused).toBe(1);

    expect(controller.apply(withoutSelectedSkill)).toBe('deferred');
    expect(await controller.discardPending()).toBe(true);
    expect(discarded).toBe(1);
    expect(controller.current()).toBe(withoutSelectedSkill);
    expect(commits).toEqual([initial, withoutSelectedSkill]);
  });
});
