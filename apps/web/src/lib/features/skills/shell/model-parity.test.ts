import { describe, expect, test } from 'bun:test';
import { createSkillsShellViewModel, knownProjectScopesFromPaths } from './model';
import { skillSelectionHref } from './navigation';
import { syntheticInventories, syntheticKnownPaths, syntheticSnapshot } from './synthetic-fixture.test-helper';

describe('Svelte Skills shell model', () => {
  test('preserves grouped project identity and encoded nested selection links', () => {
    const projects = knownProjectScopesFromPaths(syntheticKnownPaths);
    expect(projects).toEqual([
      {
        label: 'Synthetic group',
        path: 'synthetic-group',
        routeKey: 'synthetic-group',
        sourcePaths: ['/synthetic/project'],
      },
    ]);
    expect(
      skillSelectionHref(
        { projectPath: 'synthetic-group', skillName: 'skill / name', type: 'project-skill' },
        projects,
      ),
    ).toBe('/skills/projects/synthetic-group/skill%20%2F%20name');
  });

  test('derives the nested selection from the URL without a second state owner', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/projects/synthetic-group/project-review',
      snapshot: syntheticSnapshot(),
    });
    expect(view.selection).toEqual({
      projectPath: 'synthetic-group',
      skillName: 'project-review',
      type: 'project-skill',
    });
    expect(view.selectionLabel).toBe('project-review');
    expect(view.selectionDetail.kind).toBe('project-skill');
    expect(view.fallbackHref).toBeUndefined();
  });

  test('requests canonical fallback for stale deep links after settled data', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/global/missing-skill',
      snapshot: syntheticSnapshot(),
    });
    expect(view.fallbackHref).toBe('/skills/global');
    expect(view.selection).toEqual({ skillName: 'alpha-skill', type: 'global-skill' });
  });
});
