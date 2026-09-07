import { describe, expect, test } from 'bun:test';
import { drawerClose } from '../../components/button';
import {
  drawerBody,
  drawerClass,
  drawerNav,
  drawerPosition,
  drawerTop,
  popoverContentClass,
  tooltipContentClass,
} from './styles';

describe('Svelte overlay Panda styles', () => {
  test('generates clean non-empty distinct classes for every overlay surface', () => {
    const classes = [drawerClass, popoverContentClass, tooltipContentClass];

    for (const className of classes) {
      expect(className).not.toBe('');
      expect(className).toBe(className.trim());
    }
    expect(new Set(classes).size).toBe(classes.length);
  });

  test('keeps the responsive Drawer above navigation with safe mobile geometry and 44px header actions', () => {
    expect(drawerClass).toContain('md:top_0');
    expect(drawerClass).toContain('md:w_480px');
    expect(drawerClass).not.toContain('sm:top_0');
    expect(drawerClass).toContain('z_60');
    expect(drawerClass).toContain('open:anim_sheetIn');
    expect(drawerClass).toContain('closed:anim_none');
    expect(drawerBody).toContain('env(safe-area-inset-bottom)');
    expect(drawerBody).toContain('min-h_0');
    expect(drawerBody).toContain('min-h_44px');
    expect(drawerBody).toContain('min-w_44px');
    expect(drawerTop).toContain('d_grid');
    expect(drawerTop).toContain('grid-tc_auto_minmax(0,_1fr)');
    expect(drawerTop).not.toContain('ov_hidden');
    expect(drawerNav).toContain('min-h_44px');
    expect(drawerPosition).toContain('d_none');
    expect(drawerPosition).toContain('md:d_block');
    expect(drawerPosition).toContain('ov_hidden');
    expect(drawerPosition).toContain('ellipsis');
    expect(drawerClose).toContain('w_44px');
    expect(drawerClose).toContain('h_44px');
    expect(popoverContentClass).toContain('z_70');
    expect(tooltipContentClass).toContain('z_70');
  });
});
