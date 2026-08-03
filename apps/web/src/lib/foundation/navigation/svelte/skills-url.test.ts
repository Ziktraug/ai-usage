import { describe, expect, test } from 'bun:test';
import type { KnownProjectScope } from '../../../../skills-page-model';
import { skillDestinationFromUrl, skillHref, skillNavigationIntent, skillsFallbackIntent } from './skills-url';

const projects: readonly KnownProjectScope[] = [
  { label: 'Grouped', path: '/work/grouped', routeKey: 'group:stable' },
  { label: 'First', path: '/first/project' },
  { label: 'Second', path: '/second/project' },
  { label: 'Unique', path: '/work/unique' },
];

describe('Skills URL parity', () => {
  test('[url:skills.global-scope] [url:skills.matrix] preserves distinct destinations and fallback replacement', () => {
    expect(skillHref({ type: 'global-scope' })).toBe('/skills/global');
    expect(skillDestinationFromUrl('http://local/skills/global')).toEqual({ type: 'global-scope' });
    expect(skillHref({ type: 'matrix' })).toBe('/skills/matrix');
    expect(skillDestinationFromUrl('http://local/skills/matrix')).toEqual({ type: 'matrix' });
    expect(skillsFallbackIntent('http://local/skills')).toMatchObject({ replace: true, resetScroll: false });
  });

  test('[url:skills.global-skill] encodes and decodes one opaque segment on direct load and reload', () => {
    const destination = { skillName: 'review/code', type: 'global-skill' } as const;
    const href = skillHref(destination);
    expect(href).toBe('/skills/global/review%2Fcode');
    expect(skillDestinationFromUrl(new URL(href, 'http://local'))).toEqual(destination);
    expect(skillDestinationFromUrl(new URL(href, 'http://local'))).toEqual(destination);
  });

  test('[url:skills.project-scope] keeps unique basenames, opaque keys and full collision paths', () => {
    expect(skillHref({ projectPath: '/work/unique', type: 'project-scope' }, projects)).toBe('/skills/projects/unique');
    expect(skillHref({ projectPath: '/work/grouped', type: 'project-scope' }, projects)).toBe(
      '/skills/projects/group%3Astable',
    );
    const collisionHref = skillHref({ projectPath: '/first/project', type: 'project-scope' }, projects);
    expect(collisionHref).toBe('/skills/projects/%2Ffirst%2Fproject');
    expect(skillDestinationFromUrl(new URL(collisionHref, 'http://local'), projects)).toEqual({
      projectPath: '/first/project',
      type: 'project-scope',
    });
  });

  test('[url:skills.project-skill] round trips project and skill segments without resetting scroll', () => {
    const destination = { projectPath: '/work/grouped', skillName: 'build/review', type: 'project-skill' } as const;
    const intent = skillNavigationIntent('http://local/skills/global', destination, projects);
    expect(intent.resetScroll).toBe(false);
    expect(new URL(intent.url).pathname).toBe('/skills/projects/group%3Astable/build%2Freview');
    expect(skillDestinationFromUrl(intent.url, projects)).toEqual(destination);
  });
});
