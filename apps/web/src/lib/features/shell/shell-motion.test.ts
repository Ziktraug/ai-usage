import { describe, expect, test } from 'bun:test';
import { atmosphereContours } from './header-atmosphere';
import { shouldTransitionNavigation, transitionDirection } from './view-transitions';

const url = (path: string): URL => new URL(path, 'http://localhost');

describe('workspace atmosphere', () => {
  test('geometry is bounded, deterministic and varied by section', () => {
    const sections = ['Usage overview', 'One thread per task.', 'Campaigns', 'Skills', 'Sources', 'Sync', 'Delegation'];
    const geometries = sections.map((section) => atmosphereContours(section));
    for (const [index, section] of sections.entries()) {
      expect(geometries[index]).toEqual(atmosphereContours(section));
      expect(geometries[index]).toHaveLength(36);
    }
    expect(new Set(geometries.map((paths) => paths.join(''))).size).toBe(sections.length);
  });
});

describe('navigation motion policy', () => {
  test('path and report tab changes transition', () => {
    expect(shouldTransitionNavigation(url('/'), url('/work'), false)).toBe(true);
    expect(shouldTransitionNavigation(url('/'), url('/?tab=sessions'), false)).toBe(true);
    expect(shouldTransitionNavigation(url('/sessions/abc?tab=sessions'), url('/sessions/abc?tab=models'), false)).toBe(
      true,
    );
  });
  test('report refinements, hashes and non-report tabs do not transition', () => {
    for (const search of ['?filter=x', '?range=week', '?sort=cost', '?selection=1', '#details', '?tab=overview']) {
      expect(shouldTransitionNavigation(url('/'), url(`/${search}`), false)).toBe(false);
    }
    expect(shouldTransitionNavigation(url('/work'), url('/work?tab=other'), false)).toBe(false);
  });
  test('reduced motion and missing endpoints opt out', () => {
    expect(shouldTransitionNavigation(url('/'), url('/work'), true)).toBe(false);
    expect(shouldTransitionNavigation(null, url('/work'), false)).toBe(false);
    expect(shouldTransitionNavigation(url('/'), null, false)).toBe(false);
  });
  test('Analysis refinements and aliases remain in the same primary destination', () => {
    for (const [from, to] of [
      ['/?tab=models', '/?tab=projects'],
      ['/?tab=providers', '/?tab=harness-providers'],
      ['/?tab=harnesses', '/?tab=harness-providers'],
      ['/?tab=garbage', '/'],
    ] as const) {
      expect(shouldTransitionNavigation(url(from), url(to), false)).toBe(false);
    }
  });
  test('layout-owned report and management panels do not transition the page', () => {
    for (const [from, to] of [
      ['/', '/sessions/x'],
      ['/campaigns/k', '/'],
      ['/skills', '/skills/global/a'],
      ['/skills/global/a', '/skills/projects/p/b'],
      ['/skills', '/skills/matrix'],
    ] as const) {
      expect(shouldTransitionNavigation(url(from), url(to), false)).toBe(false);
    }
  });
  test('direction follows rail ordering or history delta', () => {
    expect(transitionDirection(url('/work'), url('/'))).toBe('forwards');
    expect(transitionDirection(url('/sources'), url('/'))).toBe('backwards');
    expect(transitionDirection(url('/work'), url('/'), -1)).toBe('backwards');
    expect(transitionDirection(url('/sessions/x?tab=sessions'), url('/?tab=models'))).toBe('forwards');
    expect(transitionDirection(url('/unknown'), url('/campaigns'))).toBe('backwards');
    expect(transitionDirection(url('/delegation'), url('/unknown'))).toBe('forwards');
  });
});
