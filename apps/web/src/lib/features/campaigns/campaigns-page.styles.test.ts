import { describe, expect, test } from 'bun:test';
import { css } from '@ai-usage/design-system/css';
import {
  activeCard,
  activeViewButton,
  campaignList,
  card,
  cardStyle,
  detail,
  empty,
  field,
  input,
  layout,
  mobileBack,
  muted,
  notice,
  title,
  toolbar,
  viewControls,
} from './campaigns-page.styles';

describe('campaigns page styles', () => {
  test('every class export is a non-empty atomic class list', () => {
    const classes = [
      campaignList,
      card,
      detail,
      empty,
      field,
      input,
      layout,
      mobileBack,
      muted,
      notice,
      title,
      toolbar,
      viewControls,
    ];
    for (const value of classes) {
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  test('the raw styles compose with the shared card style as the template uses them', () => {
    expect(card).toBe(css(cardStyle));
    expect(css(cardStyle, activeCard)).not.toBe(card);
    expect(css(activeViewButton).length).toBeGreaterThan(0);
  });
});
