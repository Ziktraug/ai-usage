import { describe, expect, test } from 'bun:test';
import { drawerClass, popoverContentClass, tooltipContentClass } from './styles';

describe('Svelte overlay Panda styles', () => {
  test('generates clean non-empty distinct classes for every overlay surface', () => {
    const classes = [drawerClass, popoverContentClass, tooltipContentClass];

    for (const className of classes) {
      expect(className).not.toBe('');
      expect(className).toBe(className.trim());
    }
    expect(new Set(classes).size).toBe(classes.length);
  });
});
