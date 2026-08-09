import { expect, test } from 'bun:test';
import { timeSliderRange, timeSliderRangeDrag } from './time-slider';

test('the activity brush consumes semantic interaction colors', () => {
  expect(timeSliderRange).toContain('bg_interaction.brush');
  expect(timeSliderRange).toContain('token(colors.focusRing)');
  expect(timeSliderRangeDrag).toContain('hover:bg_interaction.brushHover');
  expect(timeSliderRangeDrag).toContain('[&[data-dragging="true"]]:bg_interaction.brush');
  expect(`${timeSliderRange} ${timeSliderRangeDrag}`).not.toContain('rgba(177,_78,_18');
});
