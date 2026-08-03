import { describe, expect, test } from 'bun:test';
import type { KnownProjectScope } from '../../../../skills-page-model';
import { createDirtyNavigationController } from './dirty-navigation';
import { skillDestinationFromUrl, skillHref, skillNavigationIntent, skillsFallbackIntent } from './skills-url';

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
  });

  test('[url:skills.global-skill] direct/reload round trip one segment and preserve unrelated URL state', () => {
    const destination = { skillName: 'review/code', type: 'global-skill' } as const;
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', destination);
    expect(String(intent.url)).toBe('http://local/skills/global/review%2Fcode?utm=kept#section');
    expect(skillDestinationFromUrl(intent.url)).toEqual(destination);
    expect(skillDestinationFromUrl(new URL(intent.url))).toEqual(destination);
  });

  test('[url:skills.matrix] pushes/preserves scroll and remains cancellable by the dirty blocker', () => {
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', { type: 'matrix' });
    expect(intent).toMatchObject({ resetScroll: false });
    expect(String(intent.url)).toBe('http://local/skills/matrix?utm=kept#section');
    expect(skillDestinationFromUrl(intent.url)).toEqual({ type: 'matrix' });
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

  test('[url:skills.project-scope] keeps unique basenames, opaque keys and full collision paths', () => {
    expect(skillHref({ projectPath: '/work/unique', type: 'project-scope' }, projects)).toBe('/skills/projects/unique');
    expect(skillHref({ projectPath: '/work/grouped', type: 'project-scope' }, projects)).toBe(
      '/skills/projects/group%3Astable',
    );
    const destination = { projectPath: '/first/project', type: 'project-scope' } as const;
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', destination, projects);
    expect(String(intent.url)).toBe('http://local/skills/projects/%2Ffirst%2Fproject?utm=kept#section');
    expect(skillDestinationFromUrl(intent.url, projects)).toEqual({
      projectPath: '/first/project',
      type: 'project-scope',
    });
  });

  test('[url:skills.project-skill] round trips project and skill segments without resetting scroll', () => {
    const destination = { projectPath: '/work/grouped', skillName: 'build/review', type: 'project-skill' } as const;
    const intent = skillNavigationIntent('http://local/skills/global?utm=kept#section', destination, projects);
    expect(intent.resetScroll).toBe(false);
    expect(new URL(intent.url).pathname).toBe('/skills/projects/group%3Astable/build%2Freview');
    expect(new URL(intent.url).search).toBe('?utm=kept');
    expect(new URL(intent.url).hash).toBe('#section');
    expect(skillDestinationFromUrl(intent.url, projects)).toEqual(destination);
  });
});
