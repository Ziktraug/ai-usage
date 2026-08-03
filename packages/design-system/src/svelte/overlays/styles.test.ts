import { describe, expect, test } from 'bun:test';
import { drawer } from '../../components/drawer';
import { popoverContent } from '../../components/popover';
import { tooltipContent } from '../../components/tooltip';
import { drawerClass, popoverContentClass, tooltipContentClass } from './styles';

describe('Svelte overlay Panda parity', () => {
  test('reuses the exact generated Drawer class contract', () => {
    expect(drawerClass).toBe(drawer);
  });

  test('reuses the exact generated Popover class contract', () => {
    expect(popoverContentClass).toBe(popoverContent);
  });

  test('reuses the exact generated Tooltip class contract', () => {
    expect(tooltipContentClass).toBe(tooltipContent);
  });
});
