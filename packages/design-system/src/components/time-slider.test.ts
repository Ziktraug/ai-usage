import { expect, test } from 'bun:test';
import { timeRangeViewControls, timeSliderRange, timeSliderRangeDrag } from './time-slider';

test('the activity brush consumes semantic interaction colors', () => {
  expect(timeSliderRange).toContain('bg_interaction.brush');
  expect(timeSliderRange).toContain('token(colors.focusRing)');
  expect(timeSliderRangeDrag).toContain('hover:bg_interaction.brushHover');
  expect(timeSliderRangeDrag).toContain('[&[data-dragging="true"]]:bg_interaction.brush');
  expect(`${timeSliderRange} ${timeSliderRangeDrag}`).not.toContain('rgba(177,_78,_18');
});

test('advanced activity controls stay inside the available report column', () => {
  expect(timeRangeViewControls).toContain('grid-tc_minmax(0,_1fr)');
  expect(timeRangeViewControls).toContain('md:grid-tc_repeat(2,_minmax(0,_1fr))');
  expect(timeRangeViewControls).not.toContain('max-content');
});
