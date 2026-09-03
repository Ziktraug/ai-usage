import { describe, expect, test } from 'bun:test';
import { createSkillsFallbackNavigationRequest } from './skills-fallback-navigation';

describe('Skills fallback navigation request', () => {
  test('preserves the supplied application history state and frozen fallback intent', () => {
    const state: App.PageState = { aiUsageNavigationKey: 'skills-history-entry' };

    const request = createSkillsFallbackNavigationRequest('http://local/skills/global/missing?utm=kept#section', state);

    expect(request.state).toBe(state);
    expect(request.intent).toMatchObject({ replace: true, resetScroll: false });
    expect(String(request.intent.url)).toBe('http://local/skills?utm=kept#section');
  });
});
