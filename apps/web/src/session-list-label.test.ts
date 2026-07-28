import { describe, expect, test } from 'bun:test';
import { boundedSessionListLabel, SESSION_LIST_LABEL_MAX_CODE_POINTS } from './session-list-label';

describe('boundedSessionListLabel', () => {
  test('bounds a long astral Unicode label without splitting a code point', () => {
    const label = `${'🧪'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS + 20)} tail`;

    const bounded = boundedSessionListLabel(label);

    expect([...bounded]).toHaveLength(SESSION_LIST_LABEL_MAX_CODE_POINTS);
    expect(bounded).toBe(`${'🧪'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS - 1)}…`);
  });

  test('preserves a Unicode label that already fits', () => {
    const label = 'Réparer la campagne 🧑🏽‍💻';

    expect(boundedSessionListLabel(label)).toBe(label);
  });

  test('keeps a bounded context around a query matched after the prefix', () => {
    const label = `${'🧪'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS + 20)} late needle ${'tail'.repeat(80)}`;

    const bounded = boundedSessionListLabel(label, 'needle');

    expect([...bounded].length).toBeLessThanOrEqual(SESSION_LIST_LABEL_MAX_CODE_POINTS);
    expect(bounded).toContain('needle');
    expect(bounded.startsWith('…')).toBe(true);
    expect(bounded.endsWith('…')).toBe(true);
  });

  test('uses original-string offsets when Unicode case folding expands the prefix', () => {
    const label = `${'İ'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS + 20)} late needle ${'tail'.repeat(100)}`;

    const bounded = boundedSessionListLabel(label, 'needle');

    expect([...bounded].length).toBeLessThanOrEqual(SESSION_LIST_LABEL_MAX_CODE_POINTS);
    expect(bounded).toContain('needle');
  });
});
