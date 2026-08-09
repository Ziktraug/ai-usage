import { describe, expect, test } from 'bun:test';
import { type KnownProjectScope, selectionKey } from '../../../../skills-page-model';
import { createDirtyNavigationController } from './dirty-navigation';
import { createMemoryNavigationPort } from './navigation';
import {
  skillDestinationFromUrl,
  skillHref,
  skillNavigationIntent,
  skillsFallbackIntent,
  skillTreeSelectionFromUrl,
} from './skills-url';

const projects: readonly KnownProjectScope[] = [
  { label: 'Grouped', path: '/work/grouped', routeKey: 'group:stable' },
  { label: 'First', path: '/first/project' },
  { label: 'Second', path: '/second/project' },
  { label: 'Unique', path: '/work/unique' },
];

describe('Skills URL parity', () => {
  test('[url:skills.global-scope] fallback replaces exact path and preserves unrelated query/hash', () => {
    expect(skillHref({ type: 'global-scope' })).toBe('/skills/global');
    expect(skillDestinationFromUrl('http://local/skills/global')).toEqual({ type: 'global-scope' });
    const fallback = skillsFallbackIntent('http://local/skills?utm=kept#section');
    expect(fallback).toMatchObject({ replace: true, resetScroll: false });
    expect(String(fallback.url)).toBe('http://local/skills/global?utm=kept#section');
    const treeSelection = skillTreeSelectionFromUrl('http://local/skills/matrix');
    expect(treeSelection).toEqual({ type: 'global-scope' });
    expect(treeSelection && selectionKey(treeSelection)).toBe('global');
    const treeIntent = skillNavigationIntent('http://local/skills/matrix', { type: 'global-scope' });
    expect(treeIntent).toMatchObject({ resetScroll: false, url: new URL('http://local/skills/global') });
  });

  test('[url:skills.global-skill] direct/reload round trip one segment and preserve unrelated URL state', () => {
    const destination = { skillName: 'review/code', type: 'global-skill' } as const;
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', destination);
    expect(String(intent.url)).toBe('http://local/skills/global/review%2Fcode?utm=kept#section');
    expect(skillDestinationFromUrl(intent.url)).toEqual(destination);
    expect(skillDestinationFromUrl(new URL(intent.url))).toEqual(destination);
    expect(skillTreeSelectionFromUrl('http://local/skills/global')).toEqual({ type: 'global-scope' });
    let cancelled = false;
    createDirtyNavigationController({
      discardChanges: () => undefined,
      focus: () => undefined,
      isDirty: () => true,
      replay: () => undefined,
    }).handle({
      cancel: () => {
        cancelled = true;
      },
      to: { url: new URL(intent.url) },
      type: 'goto',
      willUnload: false,
    });
    expect(cancelled).toBe(true);
  });

  test('[url:skills.matrix] pushes/preserves scroll and remains cancellable by the dirty blocker', async () => {
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', { type: 'matrix' });
    expect(intent).toMatchObject({ resetScroll: false });
    expect(String(intent.url)).toBe('http://local/skills/matrix?utm=kept#section');
    expect(skillDestinationFromUrl(intent.url)).toEqual({ type: 'matrix' });
    expect(skillTreeSelectionFromUrl(intent.url)).toEqual({ type: 'global-scope' });
    expect(skillDestinationFromUrl('http://local/skills/global')).not.toEqual({ type: 'matrix' });
    const history = createMemoryNavigationPort('http://local/skills/global');
    await history.navigate(intent);
    expect(history.entries()).toHaveLength(2);
    let cancelled = false;
    const blocker = createDirtyNavigationController({
      discardChanges: () => undefined,
      focus: () => undefined,
      isDirty: () => true,
      replay: () => undefined,
    });
    blocker.handle({
      cancel: () => {
        cancelled = true;
      },
      to: { url: new URL(intent.url) },
      type: 'goto',
      willUnload: false,
    });
    expect(cancelled).toBe(true);
    expect(blocker.pending()).toEqual({ kind: 'url', url: new URL(intent.url) });
  });

  test('[url:skills.project-scope] covers default/basename/opaque/collision/rename and direct reload', () => {
    const uniqueHref = skillHref({ projectPath: '/work/unique', type: 'project-scope' }, projects);
    expect(uniqueHref).toBe('/skills/projects/unique');
    expect(skillDestinationFromUrl(new URL(uniqueHref, 'http://local'), projects)).toEqual({
      projectPath: '/work/unique',
      type: 'project-scope',
    });
    expect(skillHref({ projectPath: '/work/grouped', type: 'project-scope' }, projects)).toBe(
      '/skills/projects/group%3Astable',
    );
    const renamedProjects = projects.map((project) =>
      project.path === '/work/grouped' ? { ...project, label: 'Renamed' } : project,
    );
    expect(skillHref({ projectPath: '/work/grouped', type: 'project-scope' }, renamedProjects)).toBe(
      '/skills/projects/group%3Astable',
    );
    const destination = { projectPath: '/first/project', type: 'project-scope' } as const;
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', destination, projects);
    expect(String(intent.url)).toBe('http://local/skills/projects/%2Ffirst%2Fproject?utm=kept#section');
    expect(skillDestinationFromUrl(intent.url, projects)).toEqual({
      projectPath: '/first/project',
      type: 'project-scope',
    });
    expect(skillDestinationFromUrl(new URL(intent.url), projects)).toEqual(destination);
    expect(skillDestinationFromUrl('http://local/skills/global', projects)).toEqual({ type: 'global-scope' });
  });

  test('[url:skills.project-skill] covers default/legacy/reload and dirty keep-discard-cancel', async () => {
    const destination = { projectPath: '/work/grouped', skillName: 'build/review', type: 'project-skill' } as const;
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', destination, projects);
    expect(intent.resetScroll).toBe(false);
    expect(new URL(intent.url).pathname).toBe('/skills/projects/group%3Astable/build%2Freview');
    expect(new URL(intent.url).search).toBe('?utm=kept');
    expect(new URL(intent.url).hash).toBe('#section');
    expect(skillDestinationFromUrl(intent.url, projects)).toEqual(destination);
    expect(skillDestinationFromUrl(new URL(intent.url), projects)).toEqual(destination);
    expect(skillDestinationFromUrl('http://local/skills/projects/unique/build', projects)).toEqual({
      projectPath: '/work/unique',
      skillName: 'build',
      type: 'project-skill',
    });
    expect(skillDestinationFromUrl('http://local/skills/projects/unique', projects)).toEqual({
      projectPath: '/work/unique',
      type: 'project-scope',
    });
    let dirty = true;
    let focused = 0;
    const replayed: unknown[] = [];
    const blocker = createDirtyNavigationController({
      discardChanges: () => {
        dirty = false;
      },
      focus: () => {
        focused += 1;
      },
      isDirty: () => dirty,
      replay: (target) => {
        replayed.push(target);
      },
    });
    const event = {
      cancel: () => undefined,
      to: { url: new URL(intent.url) },
      type: 'goto' as const,
      willUnload: false,
    };
    expect(blocker.handle(event)).toBe(true);
    blocker.keep();
    expect(focused).toBe(1);
    expect(blocker.pending()).toBeUndefined();
    blocker.handle(event);
    expect(await blocker.discard()).toBe(true);
    expect(replayed).toEqual([{ kind: 'url', url: new URL(intent.url) }]);
  });
});
