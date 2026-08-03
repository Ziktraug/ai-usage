import { describe, expect, test } from 'bun:test';
import { drawerClass, popoverContentClass, tooltipContentClass } from './styles';

describe('Svelte overlay Panda styles', () => {
  test('generates stable distinct classes for every overlay surface', () => {
    const classes = [drawerClass, popoverContentClass, tooltipContentClass];

    expect(classes.every((className) => className.startsWith('css-'))).toBe(true);
    expect(new Set(classes).size).toBe(classes.length);
  });
});
